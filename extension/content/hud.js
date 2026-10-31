/* 页面悬浮状态卡（只在最外层页面渲染） */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX || !CX.isTop) return;
  if (root.__CX_HUD__) return;
  root.__CX_HUD__ = true;

  const LOG_MAX = 8;
  let host = null;
  let shadow = null;
  let logLines = [];
  let state = { text: '待启动', busy: false, phase: '' };
  let collapsed = false;
  let logsHidden = false;

  const CSS = `
  :host { all: initial; }
  .wrap {
    position: fixed; z-index: 2147483000; width: 268px;
    font: 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #e8eef7; background: rgba(17,24,39,.94);
    border: 1px solid rgba(96,165,250,.35); border-radius: 12px;
    box-shadow: 0 12px 30px rgba(0,0,0,.45); overflow: hidden;
    backdrop-filter: blur(6px);
  }
  .hd {
    display:flex; align-items:center; gap:6px; padding: 8px 10px;
    background: linear-gradient(90deg, rgba(37,99,235,.55), rgba(14,165,233,.35));
    cursor: move; user-select: none;
  }
  .dot { width:7px; height:7px; border-radius:50%; background:#f59e0b; box-shadow:0 0 6px #f59e0b; flex:none; }
  .dot.on { background:#22c55e; box-shadow:0 0 6px #22c55e; }
  .dot.busy { background:#3b82f6; box-shadow:0 0 8px #3b82f6; animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity:.35 } }
  .title { font-weight:600; font-size:12px; flex:1; white-space:nowrap; }
  .hd button {
    all: unset; cursor:pointer; padding:2px 6px; border-radius:6px;
    background: rgba(255,255,255,.12); color:#e8eef7; font-size:11px;
  }
  .hd button:hover { background: rgba(255,255,255,.24); }
  .body { padding: 8px 10px 10px; }
  .status { display:flex; gap:6px; align-items:flex-start; margin-bottom:6px; }
  .status .txt { flex:1; word-break: break-all; color:#dbeafe; }
  .row { display:flex; gap:6px; margin-bottom:6px; flex-wrap: wrap; }
  .row button {
    all: unset; cursor:pointer; padding: 4px 9px; border-radius: 7px;
    background: rgba(59,130,246,.22); border:1px solid rgba(96,165,250,.35);
    color:#dbeafe; font-size:11px;
  }
  .row button:hover { background: rgba(59,130,246,.4); }
  .row button.danger { background: rgba(239,68,68,.22); border-color: rgba(248,113,113,.4); }
  .logbar { display:flex; align-items:center; gap:6px; border-top: 1px dashed rgba(148,163,184,.28);
    padding-top:5px; margin-top:2px; color:#94a3b8; font-size:10.5px; }
  .logbar .sp { flex:1; }
  .logbar button { all:unset; cursor:pointer; padding:1px 7px; border-radius:5px; font-size:10.5px;
    color:#cfe1ff; background: rgba(59,130,246,.18); border:1px solid rgba(96,165,250,.3); }
  .logbar button:hover { background: rgba(59,130,246,.34); }
  .logs { padding-top:6px; max-height: 132px; overflow:auto; }
  .logs.hide { display:none; }
  .diag { display:none; margin: 0 0 6px; padding: 6px; max-height: 190px; overflow:auto; font-size: 10px;
    line-height: 1.45; color:#a5f3fc; background: rgba(8,16,31,.9); border:1px solid rgba(34,211,238,.3); border-radius: 6px;
    white-space: pre-wrap; word-break: break-all; }
  .logs div { color:#94a3b8; font-size:11px; line-height:1.45; word-break: break-all; }
  .logs div.warn { color:#fbbf24; }
  .logs div.error { color:#f87171; }
  .logs div.info { color:#93c5fd; }
  .foot { color:#64748b; font-size:10px; margin-top:4px; }
  .collapsed .body { display:none; }
  `;

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__cx_hud_host';
    shadow = host.attachShadow({ mode: 'open' });
    const raw = (CX.cfg.ui && CX.cfg.ui.hudPosition) || {};
    /* 校正历史保存的越界坐标（老版本把 bottom 存大了，面板会跑到屏幕外） */
    const clamp = function (v, max, dflt) {
      const n = Number(v);
      if (!isFinite(n) || n < 0 || n > max) return dflt;
      return n;
    };
    const pos = {
      right: clamp(raw.right, Math.max(0, root.innerWidth - 120), 16),
      bottom: clamp(raw.bottom, Math.max(0, root.innerHeight - 80), 96)
    };
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap" id="wrap" style="right:${pos.right}px;bottom:${pos.bottom}px">
        <div class="hd" id="hd">
          <span class="dot" id="dot"></span>
          <span class="title">学习通全自动助手</span>
          <button data-act="toggle" id="btnToggle">暂停</button>
          <button data-act="collapse" id="btnCollapse">－</button>
          <button data-act="closeHud" id="btnClose" title="关闭浮窗（等同设置里关掉「页面浮窗」）">×</button>
        </div>
        <div class="body">
          <div class="status"><span class="txt" id="statusText">待启动</span></div>
          <div class="row">
            <button data-act="options">高级设置</button>
            <button data-act="diag">诊断</button>
            <button data-act="reloadExt">重载扩展</button>
            <button data-act="reload">重载配置</button>
            <button data-act="clear" class="danger">清日志</button>
          </div>
          <pre class="diag" id="diag" style="display:none"></pre>
          <div class="logbar">
            <span id="logTitle">日志</span>
            <span class="sp"></span>
            <button data-act="toggleLogs" id="btnLogs" title="收起/展开日志">收起</button>
          </div>
          <div class="logs" id="logs"></div>
          <div class="foot" id="foot"></div>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    shadow.getElementById('hd').addEventListener('pointerdown', startDrag);
    shadow.addEventListener('click', onClick);
    render();
  }

  let dragState = null;
  function startDrag(e) {
    if (e.target.tagName === 'BUTTON') return;
    const wrap = shadow.getElementById('wrap');
    const r = wrap.getBoundingClientRect();
    dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    wrap.style.left = r.left + 'px';
    wrap.style.top = r.top + 'px';
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
    root.addEventListener('pointermove', onDrag);
    root.addEventListener('pointerup', endDrag, { once: true });
    e.preventDefault();
  }
  function onDrag(e) {
    if (!dragState) return;
    const wrap = shadow.getElementById('wrap');
    const w = wrap.offsetWidth || 300;
    const h = wrap.offsetHeight || 200;
    /* 夹在可视区域内：整块面板都要能看见 */
    wrap.style.left = Math.max(0, Math.min(root.innerWidth - w, e.clientX - dragState.dx)) + 'px';
    wrap.style.top = Math.max(0, Math.min(root.innerHeight - h, e.clientY - dragState.dy)) + 'px';
  }
  function endDrag() {
    dragState = null;
    root.removeEventListener('pointermove', onDrag);
    const wrap = shadow.getElementById('wrap');
    const w = wrap.offsetWidth || 300;
    const h = wrap.offsetHeight || 200;
    const left = parseFloat(wrap.style.left) || 0;
    const top = parseFloat(wrap.style.top) || 0;
    /* 用真实高度换算 bottom（原来写死 40，面板一高就被推到屏幕外） */
    const pos = {
      right: Math.max(0, Math.min(root.innerWidth - w, root.innerWidth - left - w)),
      bottom: Math.max(0, Math.min(root.innerHeight - h, root.innerHeight - top - h))
    };
    try {
      chrome.storage.local.get(['cxConfig'], function (res) {
        const cfg = root.CXConfig.normalize(res && res.cxConfig);
        cfg.ui.hudPosition = pos;
        const patch = {}; patch.cxConfig = cfg;
        chrome.storage.local.set(patch);
      });
    } catch (e) {}
  }

  function onClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    /* 扩展被重载后，旧页面里的内容脚本会变成孤儿：所有按钮点了没反应。
     * 这里统一拦一下，直接引导/执行刷新，避免「点不动」的困惑。 */
    if (!ctxAlive()) { orphanReload(); return; }
    if (act === 'collapse') {
      collapsed = !collapsed;
      shadow.getElementById('wrap').classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? '＋' : '－';
    } else if (act === 'toggle') {
      const next = !CX.cfg.enabled;
      applyEnabled(next);
    } else if (act === 'options') {
      try { chrome.runtime.sendMessage({ kind: 'openOptions' }); } catch (err) {}
    } else if (act === 'diag') {
      showDiag();
    } else if (act === 'reloadExt') {
      try {
        chrome.runtime.sendMessage({ kind: 'devReload' }, function () {});
        CX.info('正在重载扩展，页面稍后自动刷新…');
      } catch (e) {}
      setTimeout(function () { try { location.reload(); } catch (e) {} }, 900);
    } else if (act === 'reload') {
      CX.reloadConfig();
      addLog({ level: 'info', text: '配置已重载' });
    } else if (act === 'clear') {
      logLines = [];
      render();
    } else if (act === 'toggleLogs') {
      logsHidden = !logsHidden;
      applyLogsVisibility();
    } else if (act === 'closeHud') {
      closeHud();
    }
  }

  /* 关闭浮窗 = 把 ui.hud 写成 false（和设置页那个开关完全等价），并立刻移除节点 */
  function closeHud() {
    try {
      chrome.storage.local.get(['cxConfig'], function (res) {
        const cfg = root.CXConfig.normalize(res && res.cxConfig);
        cfg.ui.hud = false;
        chrome.storage.local.set({ cxConfig: cfg });
      });
    } catch (e) {}
    try { if (host) { host.remove(); host = null; shadow = null; } } catch (e) {}
  }

  /* 日志区折叠：只是把列表收起来，条数仍然显示在标题上 */
  function applyLogsVisibility() {
    const box = shadow && shadow.getElementById('logs');
    if (box) box.classList.toggle('hide', logsHidden);
    const btn = shadow && shadow.getElementById('btnLogs');
    if (btn) btn.textContent = logsHidden ? '展开' : '收起';
    const title = shadow && shadow.getElementById('logTitle');
    if (title) {
      const n = Math.min(LOG_MAX, logLines.length);
      title.textContent = logsHidden ? ('日志（' + n + ' 条已收起）') : '日志';
    }
  }

  function applyEnabled(v) {
    try {
      chrome.storage.local.get(['cxConfig'], function (res) {
        const cfg = root.CXConfig.normalize(res && res.cxConfig);
        cfg.enabled = v;
        chrome.storage.local.set({ cxConfig: cfg });
      });
    } catch (e) {}
  }

  function addLog(entry) {
    logLines.push(entry);
    if (logLines.length > 200) logLines = logLines.slice(-200);
    render();
  }

  /* 内容脚本是否还活着（扩展重载后会失效） */
  function ctxAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  let orphanTried = false;
  function orphanReload() {
    CX.warn('扩展已重载，本页脚本已失效，正在刷新页面…');
    if (orphanTried) return;
    orphanTried = true;
    try { location.reload(); } catch (e) {}
  }

  function showDiag() {
    const box = shadow.getElementById('diag');
    if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    let data = {};
    try {
      data = (CX.probe && CX.probe.snapshot) ? CX.probe.snapshot() : { err: '探针未加载' };
    } catch (e) { data = { err: String(e && e.message) }; }
    box.textContent = JSON.stringify(data, null, 1);
    box.style.display = 'block';
    try { if (navigator.clipboard) navigator.clipboard.writeText(box.textContent); } catch (e) {}
  }

  function render() {
    if (!shadow) return;
    const dot = shadow.getElementById('dot');
    dot.className = 'dot' + (CX.cfg.enabled ? ' on' : '') + (state.busy ? ' busy' : '');
    /* 2026-10-28：原来按钮写的是"动作"（暂停/启动），很容易看反 ——
     * 显示"启动"其实代表当前已停止。改成直接显示**当前状态**并上色。 */
    const btnToggle = shadow.getElementById('btnToggle');
    btnToggle.textContent = CX.cfg.enabled ? '运行中' : '已暂停';
    btnToggle.title = CX.cfg.enabled ? '点击暂停全部自动化' : '点击启动自动化';
    btnToggle.style.background = CX.cfg.enabled ? 'rgba(34,197,94,.30)' : 'rgba(239,68,68,.40)';
    btnToggle.style.border = '1px solid ' + (CX.cfg.enabled ? 'rgba(74,222,128,.5)' : 'rgba(248,113,113,.5)');
    shadow.getElementById('statusText').textContent = state.text;
    const box = shadow.getElementById('logs');
    const tail = logLines.slice(-LOG_MAX).reverse();
    box.innerHTML = tail.map(function (l) {
      const cls = l.level === 'warn' ? 'warn' : l.level === 'error' ? 'error' : l.level === 'info' ? 'info' : '';
      const t = new Date(l.ts || Date.now()).toTimeString().slice(0, 8);
      return `<div class="${cls}">${t} ${escapeHtml(l.text)}</div>`;
    }).join('') || '<div>暂无日志</div>';
    shadow.getElementById('foot').textContent = 'v' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '1.0.0') + ' · ' + (CX.cfg.ai.model || '未配置模型');
    applyLogsVisibility();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* 状态文字：普通状态常驻；「⚠ …」这类瞬时告警只占 8 秒，
   * 之后自动回到最近一条正常状态 —— 否则一次偶发卡顿的提示会一直挂在那里，
   * 看起来像"插件一直在报错"，即使视频其实还在正常播。 */
  let normalText = '待启动';
  let warnTimer = 0;
  function setStatusText(t, busy) {
    const text = String(t || '');
    const isWarn = text.charAt(0) === '⚠';
    if (!isWarn && text) normalText = text;
    state.text = text || normalText;
    state.busy = !!busy;
    clearTimeout(warnTimer);
    if (isWarn) {
      warnTimer = setTimeout(function () {
        state.text = normalText || '运行中';
        state.busy = false;
        render();
      }, 8000);
    }
    render();
  }

  /* 消息：后台广播的状态与日志 */
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || !msg.__broadcast) return;
      if (msg.kind === 'status_bc') {
        setStatusText(msg.text, msg.busy);
      } else if (msg.kind === 'log_bc') {
        addLog(msg.entry || {});
      }
    });
  } catch (e) {}

  CX.onConfig(function () { render(); });

  /* 2026-10-31：只在学习 / 作业页挂浮窗（个人空间、消息、登录页不挂）。
   * 路径不认识时用 DOM 特征兜底 —— 最多等 3 次（0.5s/1s/1.5s），等任务条或 iframe 渲染出来。 */
  let hudTries = 0;
  function mount() {
    if (!CX.cfg.ui || CX.cfg.ui.hud === false) {
      if (host) { host.remove(); host = null; shadow = null; }
      return;
    }
    if (CX.isStudyContext && !CX.isStudyContext()) {
      if (hudTries < 3) {
        hudTries++;
        setTimeout(mount, 500 * hudTries);
      } else if (host) {
        host.remove(); host = null; shadow = null;
      }
      return;
    }
    build();
  }

  CX.hud = { mount: mount, setStatus: function (t, b) { setStatusText(t, b); }, addLog: addLog };

  /* 自愈：宿主被站点清掉、或脚本异常导致没建起来时，定期重建；
   * 同时保证面板始终在可视区域内（窗口尺寸变化后重新夹紧） */
  setInterval(function () {
    try {
      if (!CX.cfg || !CX.cfg.ui || CX.cfg.ui.hud === false) {
        /* 配置里关掉浮窗时（设置页开关或浮窗自己的「×」），把节点也清掉 */
        if (host) { try { host.remove(); } catch (e) {} host = null; shadow = null; }
        return;
      }
      if (CX.isStudyContext && !CX.isStudyContext()) {
        if (host) { try { host.remove(); } catch (e) {} host = null; shadow = null; }
        return;
      }
      if (!host || !host.isConnected) {
        host = null; shadow = null;
        build();
        return;
      }
      const wrap = shadow && shadow.getElementById('wrap');
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const out = r.top < 0 || r.left < 0 || r.bottom > root.innerHeight + 2 || r.right > root.innerWidth + 2;
      if (out) {
        wrap.style.left = 'auto'; wrap.style.top = 'auto';
        wrap.style.right = '16px'; wrap.style.bottom = '96px';
        CX.debug('浮窗越界，已复位到右下角');
      }
    } catch (e) {}
  }, 3000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
  setTimeout(mount, 1200);
  setTimeout(mount, 2600);

})(typeof globalThis !== 'undefined' ? globalThis : this);
