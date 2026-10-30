'use strict';

const CFG = window.CXConfig;
let cfg = CFG.normalize(null);
let tabId = null;

const $ = function (id) { return document.getElementById(id); };

/* 2026-10-30：保存改成「读最新 → 只合并本次动的字段 → 写回」。
 * 原来写的是弹窗打开那一刻的整份 cfg；如果这期间别处（设置页/浮窗）改过配置，
 * 会被这份旧快照覆盖（典型：总开关关了又被弹窗写回「开」）。 */
let saveChain = Promise.resolve();
function save(patch) {
  cfg = CFG.merge(cfg, patch);                 /* 本地即时反映，界面不卡 */
  saveChain = saveChain.then(function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(['cxConfig'], function (res) {
        const cur = CFG.normalize(res && res.cxConfig);
        chrome.storage.local.set({ cxConfig: CFG.merge(cur, patch) }, function () { resolve(); });
      });
    });
  }).catch(function () {});
}

function paint() {
  $('enabled').checked = !!cfg.enabled;
  $('opt-autoplay').checked = cfg.player.autoPlay !== false;
  $('opt-keepalive').checked = cfg.keepAlive.enabled !== false;
  $('opt-videoquiz').checked = cfg.videoQuiz.enabled !== false;
  $('opt-next').checked = cfg.nav.autoNext !== false;
  $('opt-hud').checked = cfg.ui.hud !== false;
  $('opt-samples').checked = !(cfg.samples && cfg.samples.enabled === false);

  /* 「字体样本」是调试项：高级设置里打开「调试模式」(ui.debugMode) 才出现。
   * 只是不显示这一格，不回退 samples.enabled —— 采集器该怎么跑还怎么跑。 */
  const samplesCell = $('cell-samples');
  if (samplesCell) samplesCell.hidden = !cfg.ui.debugMode;

  /* 状态副行：一眼看出「防暂停开没开、AI 配没配」 */
  const ai = cfg.ai || {};
  const aiOk = !!ai.apiKey || /127\.0\.0\.1|localhost/.test(String(ai.baseUrl || ''));
  const ka = cfg.keepAlive || {};
  const prov = CFG.PROVIDERS[ai.provider] || {};
  const meta = $('meta');
  if (meta) {
    meta.textContent = '防暂停 ' + (ka.enabled === false ? '关' : '开') +
      ' · AI ' + (aiOk ? ('已配置 ' + (prov.label || '自定义')) : '未配置');
  }

  balanceGrid();
}

/* 每个分组里可见格子是奇数个时，让最后一格横跨两列 —— 否则右边缺一块 */
function balanceGrid() {
  try {
    Array.prototype.forEach.call(document.querySelectorAll('.grid'), function (grid) {
      const cells = Array.prototype.filter.call(grid.children, function (el) { return el && !el.hidden; });
      cells.forEach(function (el) { el.style.gridColumn = ''; });
      if (cells.length % 2 === 1) cells[cells.length - 1].style.gridColumn = 'span 2';
    });
  } catch (e) {}
}

/* ---------- 状态与日志 ---------- */
function renderStatus() {
  chrome.storage.session.get(['cxStatus', 'cxLogs'], function (res) {
    const map = res.cxStatus || {};
    const s = (tabId !== null && map[tabId]) || {};
    const dot = $('dot');
    dot.className = 'dot' + (cfg.enabled ? ' on' : '') + (s.busy ? ' busy' : '');
    $('statusText').textContent = s.text || (cfg.enabled ? '已启用，等待页面加载' : '已暂停');
    renderLogs(res.cxLogs || []);
  });
}

function renderLogs(logs) {
  const box = $('logs');
  if (!logs.length) { box.innerHTML = '<div>暂无日志</div>'; return; }
  box.innerHTML = logs.slice(-40).reverse().map(function (l) {
    const cls = l.level === 'warn' ? 'warn' : l.level === 'error' ? 'error' : l.level === 'info' ? 'info' : 'debug';
    const t = new Date(l.ts || Date.now()).toTimeString().slice(0, 8);
    return `<div class="${cls}">${t} [${escapeHtml(l.scope || '')}] ${escapeHtml(l.text || '')}</div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

/* ---------- 「AI 学习检测」按钮 ----------
 * 它是**一次性动作**，不是开关（2026-10-28 用户要求）。开关语义留在
 * 高级设置「学习检测 → 启用 AI 答题」。点一下 = 对当前标签页立刻跑一轮：
 * 走 chrome.scripting 打进各帧的扩展隔离世界（与 content script 同一个世界，
 * 能直接摸到 CX），不新增后台消息通道，background.js 不动。 */
const WHY = {
  'master-off': '总开关关着',
  'exam-off': '设置里关了答题',
  notexam: '当前页没有测验',
  busy: '已经在跑了',
  redoing: '正在重做，稍等',
  nocx: '插件没加载，刷新页面'
};

function kickExam() {
  const btn = $('btn-exam-now');
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null || !/^https?:/i.test(tab.url || '')) { flash(btn, '先打开学习页', 'bad'); return; }
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: function () {
        try {
          if (!window.CX || !CX.exam || typeof CX.exam.run !== 'function') return { ok: false, why: 'nocx' };
          if (!CX.cfg || !CX.cfg.enabled) return { ok: false, why: 'master-off' };
          if (CX.cfg.exam && CX.cfg.exam.enabled === false) return { ok: false, why: 'exam-off' };
          const s = CX.exam.state || {};
          if (s.busy) return { ok: false, why: 'busy' };
          if (s.redoing) return { ok: false, why: 'redoing' };
          if (!CX.exam.isExamContext()) return { ok: false, why: 'notexam' };
          s.finished = false;          /* 之前跑完过，手动踢要能再跑 */
          CX.exam.run();
          return { ok: true };
        } catch (e) { return { ok: false, why: 'err:' + ((e && e.message) || e) }; }
      }
    }, function (res) {
      if (chrome.runtime.lastError) { flash(btn, '注入失败，刷新页面', 'bad'); return; }
      const list = (res || []).map(function (r) { return r && r.result; }).filter(Boolean);
      if (list.some(function (r) { return r.ok; })) { flash(btn, '已交给页面 ✓', 'ok'); return; }
      const fails = list.filter(function (r) { return !r.ok; });
      /* 哪个原因更值得报：先报被开关挡住，再报没在跑，最后才是"这一帧没装插件"
       * （allFrames 会带一堆 about:blank 帧，不能拿它们的 nocx 骗人） */
      let why = '';
      ['master-off', 'exam-off', 'busy', 'redoing', 'notexam', 'nocx'].forEach(function (p) {
        if (!why && fails.some(function (r) { return r.why === p; })) why = p;
      });
      if (!why) why = fails.length ? String(fails[0].why || 'noresult') : 'noresult';
      flash(btn, WHY[why] || (why.indexOf('err:') === 0 ? why.slice(4) : '当前页没有测验'), 'bad');
    });
  });
}

let flashTimer = 0;
function flash(btn, text, kind) {
  if (!btn) return;
  const lbl = (btn.querySelector && btn.querySelector('.lbl')) || btn;
  if (!lbl.dataset.label) lbl.dataset.label = lbl.textContent || 'AI 学习检测';
  lbl.textContent = text;
  if (btn.classList) {
    btn.classList.remove('ok', 'bad');
    if (kind) btn.classList.add(kind);
  }
  clearTimeout(flashTimer);
  flashTimer = setTimeout(function () {
    lbl.textContent = lbl.dataset.label;
    if (btn.classList) btn.classList.remove('ok', 'bad');
  }, 1800);
}

/* ---------- 事件 ---------- */
$('enabled').addEventListener('change', function (e) { save({ enabled: e.target.checked }); renderStatus(); });
$('opt-autoplay').addEventListener('change', function (e) { save({ player: { autoPlay: e.target.checked } }); });
$('opt-keepalive').addEventListener('change', function (e) { save({ keepAlive: { enabled: e.target.checked } }); });
$('opt-videoquiz').addEventListener('change', function (e) { save({ videoQuiz: { enabled: e.target.checked } }); });
$('opt-next').addEventListener('change', function (e) { save({ nav: { autoNext: e.target.checked } }); });
$('opt-hud').addEventListener('change', function (e) { save({ ui: { hud: e.target.checked } }); });
$('opt-samples').addEventListener('change', function (e) {
  save({ samples: { enabled: e.target.checked } });
});
$('btn-exam-now').addEventListener('click', kickExam);

/* 样本的导出 / 导入已经挪到「字体样本」采集浮窗里（面板底部），这里不再放按钮：
 * 2026-10-28 用户要求「导出导入样本那里有的话这里就不用了」。 */

$('btn-clear').addEventListener('click', function () {
  chrome.storage.session.set({ cxLogs: [] });
  renderLogs([]);
});

$('btn-options').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });

/* 恢复：先刷新当前标签页（让内容脚本重新注入），再重载扩展本身。
 * 浮窗丢失、页面里的按钮点不动时，这是唯一可靠的入口。 */
$('btn-recover').addEventListener('click', function () {
  const btn = $('btn-recover');
  btn.disabled = true;
  btn.textContent = '正在恢复…';
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      if (tab && tab.id && /^https?:/i.test(tab.url || '')) {
        try { chrome.tabs.reload(tab.id); } catch (e) {}
      }
      setTimeout(function () {
        try { chrome.runtime.reload(); } catch (e) {}
        try { window.close(); } catch (e) {}
      }, 700);
    });
  } catch (e) {
    try { chrome.runtime.reload(); } catch (e2) {}
  }
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.cxConfig) { cfg = CFG.normalize(changes.cxConfig.newValue); paint(); }
  if (area === 'session' && (changes.cxLogs || changes.cxStatus)) renderStatus();
});

/* ---------- 初始化 ---------- */
chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  if (tabs && tabs[0]) tabId = tabs[0].id;
  chrome.storage.local.get(['cxConfig'], function (res) {
    cfg = CFG.normalize(res.cxConfig);
    paint();
    renderStatus();
  });
});

setInterval(renderStatus, 1500);
