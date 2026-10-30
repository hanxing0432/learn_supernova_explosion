/* 防暂停前置（主世界 / MAIN world）
 *
 * 关键：普通 content script 跑在隔离世界，改 document.hidden、拦 addEventListener
 * 只影响隔离世界自己的原型，页面自己的 JS 完全看不到——所以必须在主世界注入。
 * 老油猴脚本是 @grant none（主世界）跑的，这就是它在浏览器扩展里失效的原因。
 */
(function (root) {
  'use strict';
  if (root.__CX_ANTIPAUSE_MAIN__) return;
  root.__CX_ANTIPAUSE_MAIN__ = true;

  const doc = root.document;

  /* 能否关闭：隔离世界会通过 DOM 属性回写 ui 开关，默认开启 */
  function enabled() {
    try {
      const v = doc.documentElement && doc.documentElement.getAttribute('data-cx-keepalive');
      return v !== 'off';
    } catch (e) { return true; }
  }

  /* 真实可见性（在覆盖之前先拿到原始值） */
  const realHidden = (function () {
    try {
      const d = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      if (d && d.get) return function () { return d.get.call(doc); };
    } catch (e) {}
    return function () { return false; };
  })();

  /* 1) 伪造可见状态：让页面的 visibilitychange/hidden 判断认为一直可见 */
  try {
    Object.defineProperty(doc, 'hidden', { get: function () { return enabled() ? false : realHidden(); }, configurable: true });
    Object.defineProperty(doc, 'visibilityState', { get: function () { return enabled() ? 'visible' : (realHidden() ? 'hidden' : 'visible'); }, configurable: true });
    Object.defineProperty(doc, 'webkitHidden', { get: function () { return enabled() ? false : realHidden(); }, configurable: true });
    Object.defineProperty(doc, 'webkitVisibilityState', { get: function () { return enabled() ? 'visible' : (realHidden() ? 'hidden' : 'visible'); }, configurable: true });
  } catch (e) {}

  /* 2) 拦掉超星在 window/document 上注册的 mouseout（鼠标移出窗口就暂停） */
  try {
    const origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (enabled() && type === 'mouseout' && (this === root || this === doc)) return;
      return origAdd.call(this, type, listener, options);
    };
  } catch (e) {}

  /* 3) 多开互斥：丢弃 studyControl 写 videojs_id cookie 的行为 */
  try {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (desc && desc.get && desc.set) {
      try {
        desc.set.call(doc, 'videojs_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/');
        desc.set.call(doc, 'videojs_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT');
      } catch (e) {}
      Object.defineProperty(Document.prototype, 'cookie', {
        configurable: true,
        get: function () { return desc.get.call(this); },
        set: function (value) {
          if (enabled() && typeof value === 'string' && /(?:^|;)\s*videojs_id=/.test(value)) return;
          return desc.set.call(this, value);
        }
      });
    }
  } catch (e) {}

  /* 给主世界留个探针（页面控制台可见，便于确认是否生效） */
  try { root.__CX_ANTIPAUSE_ACTIVE__ = true; } catch (e) {}

  /* 4) 主世界调用桥
   * 站点的「提交」是 <a href="javascript:void(0);" onclick="btnBlueSubmit();">。
   * 页面响应头下发的 CSP 没有 'unsafe-inline'，内联 onclick 与 javascript: URL 都被
   * 浏览器拒绝，隔离世界派发的合成点击因此永远无效（实测：点了页面毫无反应）。
   * 这条通道让隔离世界把「必须由页面自己执行」的动作交给主世界代劳。
   * 事件同步派发，返回值挂在 ev.__cxOut 上。 */
  try {
    root.addEventListener('cx-main-call', function (ev) {
      var d = (ev && ev.detail) || {};
      var out = { ok: false, err: '' };
      try {
        /* 逐层钻进最内层的 work iframe（答题页通常嵌 3 层） */
        var doc = root.document;
        var guard = 0;
        while (guard++ < 5) {
          var f = doc.querySelector('iframe,frame');
          if (!f) break;
          var nd = null;
          try { nd = f.contentDocument; } catch (e) { break; }
          if (!nd) break;
          doc = nd;
        }
        var w = doc.defaultView || root;
        if (d.kind === 'submitClick') {
          if (typeof w.btnBlueSubmit === 'function') { w.btnBlueSubmit(); out.ok = true; }
          else out.err = 'no btnBlueSubmit';
        } else if (d.kind === 'submitForce') {
          if (typeof w.submitCheckTimes === 'function') { w.submitCheckTimes(); out.ok = true; }
          else out.err = 'no submitCheckTimes';
        } else if (d.kind === 'switchQuiz') {
          /* 直接改 cards iframe 的 num 参数切到「学习测验」tab。
           * 2026-10-28 实测：站点自己的 changeDisplayContent 会把 iframe.src 拼成
           *   ...&v=2025-0424-1038-4&...&crossId=undefined
           * 而页面实际在用 v=...-3 → 加载失败，表现就是"点了没反应、进不去测验"。
           * 这里保留 src 的全部原参数，只改 num（视频=0，测验=1），并把 crossId=undefined 去掉。 */
          try {
            var fq = root.document.getElementById('iframe');
            if (!fq) {
              out.err = 'no-#iframe';
            } else {
              var qsrc = fq.getAttribute('src') || '';
              if (!/knowledge\/cards/.test(qsrc)) {
                out.err = 'iframe-not-cards';
                out.href = qsrc.slice(0, 60);
              } else {
                var want = String(d.num == null ? 1 : d.num);
                var nextSrc = qsrc.replace(/([?&]num=)\d+/, '$1' + want).replace(/&crossId=undefined/g, '');
                if (nextSrc !== qsrc) fq.src = nextSrc;
                /* tab 高亮同步（否则看起来像没切换） */
                try {
                  var lis = root.document.querySelectorAll('.prev_ul li, .prev_list li');
                  var wi = Number(want);
                  for (var li2 = 0; li2 < lis.length; li2++) {
                    lis[li2].className = String(lis[li2].className || '').replace(/\bactive\b/g, '').trim();
                    if (li2 === wi) lis[li2].className = (lis[li2].className + ' active').trim();
                  }
                } catch (e5) {}
                try { if (typeof setChapterNumData === 'function') setChapterNumData(Number(want) + 1); } catch (e6) {}
                try { if (root.PCount && root.PCount.setIndex) root.PCount.setIndex(Number(want) + 1); } catch (e7) {}
                out.ok = true;
                out.src = nextSrc.slice(-90);
              }
            }
          } catch (e) { out.err = String((e && e.message) || e); }
        } else if (d.kind === 'call') {
          /* 通用：调用页面里的全局函数（目录切换 getTeacherAjax 这类内联 onclick 专用）。
           * 顶层函数只在 top window 上，子 frame 里找不到就回退到 top（同源才可访问）。 */
          var fname = d.fn;
          var host = root;
          try {
            if (typeof host[fname] !== 'function' && root.top && root.top !== root &&
                typeof root.top[fname] === 'function') {
              host = root.top;
            }
          } catch (e) {}
          if (fname && typeof host[fname] === 'function') {
            out.value = host[fname].apply(host, d.args || []);
            out.ok = true;
          } else {
            out.err = 'no-fn:' + fname;
          }
        } else if (d.kind === 'resetSubmitLock') {
          /* 站点的 confirmSubmitWork 有 submitLock 防重复提交；提交卡住时锁往往没释放，
           * 之后所有提交都被静默丢弃（不发请求、不报错）。重试前先把它清掉。 */
          try {
            if (typeof w.submitLock !== 'undefined') { w.submitLock = 0; out.ok = true; }
            else out.err = 'no submitLock';
          } catch (e) { out.err = String((e && e.message) || e); }
        } else if (d.kind === 'findSubmit') {
          out.hasBtn = !!(doc.querySelector('.btnSubmit, .completeBtn, #submitBtn'));
          out.hasFn = typeof w.btnBlueSubmit === 'function';
          out.hasSct = typeof w.submitCheckTimes === 'function';
          out.href = String(doc.location.href || '').slice(0, 100);
          out.ok = true;
        } else {
          out.err = 'unknown-kind';
        }
      } catch (e) { out.err = String((e && e.message) || e); }
      /* 返回值不能挂在事件对象上：隔离世界和主世界是两套 JS 对象空间，
       * 主世界写的 ev.__cxOut，隔离世界的包装对象读不到（实测 evOwnProp=undefined）。
       * DOM 是两边共享的，所以结果写进 documentElement 的属性，由隔离世界同步读回。 */
      try {
        var outDoc = root.document;
        if (outDoc && outDoc.documentElement) {
          outDoc.documentElement.setAttribute('data-cx-out', JSON.stringify(out));
        }
      } catch (e) {}
    });
  } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : this);
