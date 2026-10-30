/* 内容脚本公共层：配置、日志、DOM 工具、与后台通信 */
(function (root) {
  'use strict';

  if (root.__CX_COMMON__) return;
  root.__CX_COMMON__ = true;

  const CX = root.CX = root.CX || {};
  const CFG = root.CXConfig;

  /* ---------------- 运行环境 ---------------- */
  CX.isTop = (function () {
    try { return root.top === root; } catch (e) { return false; }
  })();

  /* 找到最外层可访问的同源父窗口（学习通多层 iframe，跳转逻辑只在能操作顶层的那一层执行） */
  CX.walkAccessibleParents = function () {
    const list = [root];
    let w = root;
    while (true) {
      try {
        if (w.parent && w.parent !== w && w.parent.document) {
          w = w.parent;
          list.push(w);
        } else break;
      } catch (e) { break; }
    }
    return list;
  };

  CX.frameDepth = (function () {
    let d = 0;
    let w = root;
    while (true) {
      try {
        if (w.parent && w.parent !== w) { w = w.parent; d++; } else break;
      } catch (e) { d++; break; }
    }
    return d;
  })();

  /* ---------------- 配置 ---------------- */
  CX.cfg = CFG.normalize(null);
  const cfgListeners = [];

  CX.onConfig = function (cb) {
    cfgListeners.push(cb);
    return function () {
      const i = cfgListeners.indexOf(cb);
      if (i >= 0) cfgListeners.splice(i, 1);
    };
  };

  CX.reloadConfig = function () {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(['cxConfig'], function (res) {
          CX.cfg = CFG.normalize(res && res.cxConfig);
          cfgListeners.forEach(function (cb) { try { cb(CX.cfg); } catch (e) {} });
          resolve(CX.cfg);
        });
      } catch (e) { resolve(CX.cfg); }
    });
  };

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.cxConfig) {
        CX.cfg = CFG.normalize(changes.cxConfig.newValue);
        cfgListeners.forEach(function (cb) { try { cb(CX.cfg); } catch (e) {} });
      }
    });
  } catch (e) {}

  CX.reloadConfig();

  /* ---------------- 防暂停总开关 → 主世界 ----------------
   * MAIN world 的 antipause-main.js 靠 documentElement 上的 data-cx-keepalive
   * 决定要不要生效，但**这个属性以前全项目没有任何写入点** —— 结果是防暂停
   * 永远开着、设置里关不掉。这里在配置加载/变化时把它写下去。
   * （antipause 每次判断都会重新读属性，所以"新注册的监听"会立刻按新开关来；
   * 但**已经注册过的监听救不回来** —— 开启期间被拦掉的 mouseout/visibility 监听
   * 已经不存在了，所以用户实测“关掉防暂停要刷新页面才生效”，这是符合预期的。） */
  function applyKeepAliveFlag(cfg) {
    try {
      const c = cfg || CX.cfg;
      const on = !(c && c.keepAlive && c.keepAlive.enabled === false);
      const de = root.document && root.document.documentElement;
      if (de) de.setAttribute('data-cx-keepalive', on ? 'on' : 'off');
    } catch (e) {}
  }
  applyKeepAliveFlag(CX.cfg);
  CX.onConfig(applyKeepAliveFlag);

  /* ---------------- 日志 ---------------- */
  const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const tag = '[CX]';
  CX.logRing = [];
  const scope = (function () {
    if (CX.isTop) return 'top';
    try {
      const href = root.location.href;
      if (/work|exam|quiz/i.test(href)) return 'exam';
      if (/knowledge\/cards|studentstudy|mycourse/i.test(href)) return 'player';
      return 'frame';
    } catch (e) { return 'frame'; }
  })();

  function log(level, msg, data) {
    const lv = LOG_LEVELS[level] || 20;
    const cfgLv = LOG_LEVELS[(CX.cfg.ui && CX.cfg.ui.logLevel) || 'info'] || 20;
    try {
      CX.logRing.push({ l: level, t: new Date().toTimeString().slice(0, 8), m: String(msg).slice(0, 120) });
      if (CX.logRing.length > 20) CX.logRing.shift();
    } catch (e) {}
    if (lv >= cfgLv) {
      const args = [tag + '[' + scope + '] ' + msg];
      if (data !== undefined) args.push(data);
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log).apply(console, args);
    }
    try {
      chrome.runtime.sendMessage({
        kind: 'log',
        level: level,
        text: msg,
        data: data === undefined ? null : safeJson(data),
        scope: scope,
        url: root.location.href,
        ts: Date.now()
      });
    } catch (e) {}
  }
  CX.log = log;
  CX.debug = function (m, d) { log('debug', m, d); };
  CX.info = function (m, d) { log('info', m, d); };
  CX.warn = function (m, d) { log('warn', m, d); };
  CX.error = function (m, d) { log('error', m, d); };

  function safeJson(v) {
    try {
      const s = JSON.stringify(v);
      return s && s.length > 4000 ? s.slice(0, 4000) + '…' : s;
    } catch (e) { return String(v); }
  }

  /* ---------------- 状态广播（给 HUD / popup） ---------------- */
  let lastStatusSent = 0;
  let lastStatusText = '';
  CX.lastStatusText = '';
  CX.status = function (text, opts) {
    opts = opts || {};
    const now = Date.now();
    if (text === lastStatusText && now - lastStatusSent < 1500 && !opts.force) return;
    lastStatusSent = now;
    lastStatusText = text;
    CX.lastStatusText = text;
    try {
      chrome.runtime.sendMessage({
        kind: 'status',
        scope: scope,
        text: text,
        busy: !!opts.busy,
        phase: opts.phase || '',
        ts: now
      });
    } catch (e) {}
  };

  /* ---------------- 基础工具 ---------------- */
  CX.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  CX.waitFor = function (fn, opt) {
    opt = opt || {};
    const timeout = opt.timeout || 15000;
    const interval = opt.interval || 300;
    const start = Date.now();
    return new Promise(function (resolve) {
      (function tick() {
        let v;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return resolve(opt.resolveFalsy ? v : null);
        setTimeout(tick, interval);
      })();
    });
  };

  CX.norm = function (s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/[ ]{2,}/g, ' ')
      .trim();
  };

  CX.oneLine = function (s) { return CX.norm(s).replace(/\n+/g, ' '); };

  CX.text = function (el) { return el ? CX.norm(el.innerText || el.textContent || '') : ''; };

  /* 页面可见正文（**排除 <script>/<style> 里的源码**）。
   * 2026-10-28 新增：textContent 虽然快，但会把内联脚本一起读进来 —— 实测判分原文里混进了
   * `I18N_WORK = { ... "tasktips1": "未达到及格线，请重做" ... }`，导致所有"有没有出现 xx 文案"
   * 的判断全部失真（语言包里什么都有）。innerText 天然排除 script/style，代价是强制一次布局；
   * 这里只在页面级用少量几次，可以接受。 */
  CX.pageText = function (el) {
    if (!el) return '';
    try {
      const t = el.innerText;
      if (typeof t === 'string') return t;
    } catch (e) {}
    /* 只在取 innerText 抛错时才回退 —— 不能因为"innerText 为空"就回退：
     * 隐藏 iframe 的 body.innerText 本来就是空，回退 textContent 会把
     * <script> 里的源码和隐藏节点（包括本插件 probe 写的诊断 JSON）一起读进来。
     * 2026-10-28 实测：探针节点里的日志文本"任务点已完成"被当成页面状态，导致误判。 */
    return String(el.textContent || '');
  };

  CX.visible = function (el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  };

  /* 真实鼠标点击：先派发完整事件序列，再调用 click() */
  CX.click = function (el) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 12);
      const y = rect.top + Math.min(rect.height / 2, 8);
      const opts = { bubbles: true, cancelable: true, view: root, clientX: x, clientY: y };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
        const E = t.indexOf('pointer') === 0 && root.PointerEvent ? root.PointerEvent : root.MouseEvent;
        el.dispatchEvent(new E(t, opts));
      });
      el.click();
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (e2) { return false; }
    }
  };

  CX.qa = function (selector, ctx) {
    try { return (ctx || root.document).querySelector(selector); } catch (e) { return null; }
  };

  CX.qsa = function (selector, ctx) {
    try { return Array.prototype.slice.call((ctx || root.document).querySelectorAll(selector)); } catch (e) { return []; }
  };

  /* 在多个选择器中找到第一个存在的元素 */
  CX.firstOf = function (selectors, ctx) {
    for (let i = 0; i < selectors.length; i++) {
      const el = CX.qa(selectors[i], ctx);
      if (el) return el;
    }
    return null;
  };

  CX.allOf = function (selectors, ctx) {
    let out = [];
    selectors.forEach(function (s) {
      out = out.concat(CX.qsa(s, ctx));
    });
    return out.filter(function (el, i, arr) { return arr.indexOf(el) === i; });
  };

  /* 找到文字匹配的可点击元素（按钮/链接/div）
   * 2026-10-28 性能重写：以前是全文档 qsa('a,button,div,span,li,p,td') 再逐个
   * visible()+innerText —— 复杂页面几万个节点，单次调用要几秒（"点一下卡一下"的根源）。
   * 现在先用 XPath 只取「直接持有这段文字的节点」（数量极少），验证后再下沉。
   * XPath 不可用/没命中时仍退回原来的全量扫描。 */
  CX.xpathByText = function (doc, text) {
    const out = [];
    try {
      if (!doc || !doc.evaluate) return out;
      const lit = String(text == null ? '' : text).replace(/"/g, '');
      if (!lit) return out;
      const q = './/*[text()[contains(.,"' + lit + '")]]';
      const r = doc.evaluate(q, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < r.snapshotLength && i < 200; i++) {
        const el = r.snapshotItem(i);
        if (!el) continue;
        /* 跳过 <script>/<style>/<noscript> 里的源码文本（站点语言包里什么文案都有） */
        try {
          const p = el.parentElement;
          if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(String(p.tagName || '').toUpperCase())) continue;
        } catch (e) {}
        out.push(el);
      }
    } catch (e) {}
    return out;
  };

  CX.findByText = function (texts, ctx, opt) {
    opt = opt || {};
    const list = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
    const scopeEl = (ctx && ctx.nodeType === 1) ? ctx : null;
    const doc = (scopeEl && scopeEl.ownerDocument) || (ctx && ctx.document) || root.document;
    const maxLen = opt.maxLen || 30;

    function match(el, want) {
      const t = CX.oneLine(el.textContent || '');
      if (!t || t.length > maxLen) return false;
      return opt.exact ? t === want : t.indexOf(want) >= 0;
    }

    let hit = null;
    /* ① 快路径：XPath 按文字定位 */
    try {
      for (let j = 0; j < list.length && !hit; j++) {
        const cands = CX.xpathByText(doc, list[j]);
        for (let i = 0; i < cands.length; i++) {
          const el = cands[i];
          if (scopeEl && !scopeEl.contains(el)) continue;
          if (opt.visible !== false && !CX.visible(el)) continue;
          if (match(el, list[j])) { hit = el; break; }
        }
      }
    } catch (e) { hit = null; }

    /* ② 兜底：原来的全量扫描（只在快路径没命中时跑） */
    if (!hit) {
      const pool = CX.qsa(opt.selector || 'a,button,div,span,li,p,td', ctx);
      for (let i = 0; i < pool.length; i++) {
        const el = pool[i];
        if (opt.visible !== false && !CX.visible(el)) continue;
        for (let j = 0; j < list.length; j++) {
          if (match(el, list[j])) { hit = el; break; }
        }
        if (hit) break;
      }
    }
    if (!hit) return null;

    /* 下沉：找文字相同的更深层元素 */
    let cur = hit;
    for (let depth = 0; depth < 6; depth++) {
      const same = CX.qsa('*', cur).find(function (c) {
        return CX.oneLine(c.textContent || '') === CX.oneLine(cur.textContent || '') &&
          (opt.visible === false || CX.visible(c));
      });
      if (!same) break;
      cur = same;
    }
    return cur;
  };

  /* 跨（同源）文档按文字点按钮：站点的提示层经常挂在父文档，而内容脚本在 iframe 里 */
  CX.clickByTextAnyDoc = function (texts, opt) {
    opt = opt || {};
    let wins = [];
    try { wins = CX.walkAccessibleParents() || []; } catch (e) { wins = []; }
    if (wins.indexOf(root) < 0) wins.unshift(root);
    for (let i = 0; i < wins.length; i++) {
      let d = null;
      try { d = wins[i].document; } catch (e) { continue; }
      if (!d) continue;
      const el = CX.findByText(texts, d, opt);
      if (el && CX.visible(el)) { CX.click(el); return el; }
    }
    return null;
  };

  /* 一切弹层/提示层是否挡住了页面（有可见的"知道了/确定"且文案命中） */
  CX.tipDialogText = function () {
    let wins = [];
    try { wins = CX.walkAccessibleParents() || []; } catch (e) { wins = []; }
    if (wins.indexOf(root) < 0) wins.unshift(root);
    let out = '';
    for (let i = 0; i < wins.length; i++) {
      let d = null;
      try { d = wins[i].document; } catch (e) { continue; }
      if (!d || !d.body) continue;
      out += ' ' + CX.oneLine(CX.pageText(d.body)).slice(0, 1500);
    }
    return out.slice(0, 4000);
  };

  CX.uid = function (p) { return (p || 'cx') + Math.random().toString(36).slice(2, 8); };

  /* ---------------- 与后台 AI 通信 ---------------- */
  CX.chat = function (payload) {
    return new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(function () {
        if (!done) { done = true; resolve({ ok: false, error: '后台响应超时' }); }
      }, (CX.cfg.ai.timeoutMs || 90000) + 15000);
      try {
        chrome.runtime.sendMessage({ kind: 'ai', action: 'chat', payload: payload }, function (res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: '无响应' });
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: String(e) }); }
      }
    });
  };

  /* 让后台把答案写进长期题库（同题干下次直接用） */
  CX.rememberAnswer = function (key, answer) {
    try {
      chrome.runtime.sendMessage({ kind: 'ai', action: 'remember', payload: { key: key, answer: answer } });
    } catch (e) {}
  };

  CX.askAnswer = function (key) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ kind: 'ai', action: 'recall', payload: { key: key } }, function (res) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res && res.answer ? res.answer : null);
        });
      } catch (e) { resolve(null); }
    });
  };

  /* ---------------- 主世界调用桥 ----------------
   * 隔离世界拿不到页面上下文的 JS 函数；而站点关键按钮（提交/确认）多是内联 onclick，
   * 页面 CSP 没有 'unsafe-inline' 时合成点击一律无效。所有「必须由页面自己执行」的
   * 动作都通过这条通道交给 content/antipause-main.js（MAIN world）代劳。 */
  CX.mainCall = function (kind, extra) {
    try {
      const de = root.document && root.document.documentElement;
      /* 先清掉上一次的结果，避免读到旧值冒充本次成功 */
      if (de) { try { de.removeAttribute('data-cx-out'); } catch (e) {} }

      const detail = { kind: kind };
      if (extra && typeof extra === 'object') {
        for (const k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) detail[k] = extra[k];
        }
      }
      root.dispatchEvent(new CustomEvent('cx-main-call', { detail: detail }));

      /* 结果从 DOM 属性读回（事件对象的自定义属性跨世界不可见） */
      let out = null;
      try {
        const raw = de && de.getAttribute('data-cx-out');
        if (raw) out = JSON.parse(raw);
      } catch (e) {}
      return out || { ok: false, err: 'no-handler' };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e) };
    }
  };

  /* ---------------- 主线程卡死检测 ----------------
   * 学习网站的混淆脚本（_0x12c153）会无限递归把主线程占死，实测连 1+1 都执行不了，
   * 表现为：点了没反应、日志停在某一轮、桥接快照超时。
   * 这里用 setInterval 的实际抖动反推"被饿"了多久 —— 卡死期间定时器不会执行，
   * 恢复后第一次触发时 delta 会远大于 5 秒。只做检测和提示，不试图救页面。
   *
   * 2026-10-30 修正（用户实测：切到别的标签页、窗口还被别的程序整个盖住，
   * 视频明明在播却报「页面已卡死 20s」）：
   *   浏览器对不可见/被遮挡的页面会主动给定时器降频（隐藏久了约 1 分钟一跳），
   *   那是省电，不是卡死。所以只在「页面可见 + 窗口有焦点」时才计时：
   *     · visibilityState !== 'visible' → 切标签页 / 最小化
   *     · document.hasFocus() === false → 窗口被别的程序挡住 / 失焦
   *   这两种情况用户本来也看不到提示，测了没意义。切回来时重置计时，
   *   不把"离开的时长"当成一次卡顿。阈值同时放宽到 15 秒。 */
  CX.watchdog = (function () {
    let last = Date.now();
    let stuckMs = 0;
    let reported = false;
    function reset() {
      last = Date.now();
      reported = false;
    }
    function awake() {
      try {
        if (document.visibilityState !== 'visible') return false;
        if (document.hidden) return false;
        if (document.hasFocus && !document.hasFocus()) return false;
      } catch (e) {}
      return true;
    }
    try { document.addEventListener('visibilitychange', reset); } catch (e) {}
    try { root.addEventListener('focus', reset); } catch (e) {}
    try { root.addEventListener('blur', reset); } catch (e) {}
    try {
      setInterval(function () {
        const now = Date.now();
        const delta = now - last;
        last = now;
        /* 页面不可见 / 窗口没焦点：定时器被降频是浏览器的省电策略，不能当卡死 */
        if (!awake()) return;
        if (delta > 15000) {
          stuckMs = delta;
          if (!reported) {
            reported = true;
            const sec = Math.round(delta / 1000);
            /* 只由顶层报告：一次卡死时所有 frame 的定时器一起被饿，各自都报会刷屏
             * （实测同一次卡死刷出 10s / 29s / 58s / 59s 好几条）。 */
            if (CX.isTop) {
              try { CX.error('检测到页面主线程卡死约 ' + sec + ' 秒（站点混淆脚本），建议刷新页面'); } catch (e) {}
              try { if (CX.hud && CX.hud.setStatus) CX.hud.setStatus('⚠ 页面已卡死 ' + sec + 's，请刷新', false); } catch (e) {}
            } else {
              try { CX.debug('本 frame 主线程被占约 ' + sec + 's'); } catch (e) {}
            }
          }
        } else if (delta < 7000) {
          reported = false;
        }
      }, 5000);
    } catch (e) {}
    return { getStuckMs: function () { return stuckMs; } };
  })();

  /* ---------------- 小工具：随机延迟 ---------------- */
  CX.jitter = function (base, spread) {
    const s = spread === undefined ? 0.4 : spread;
    return Math.max(0, Math.round(base * (1 - s / 2 + Math.random() * s)));
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
// dev-stamp 13a
