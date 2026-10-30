/* 隐藏探针：把当前帧的自动化状态写进一个不可见节点，
 * 方便排查「为什么没自动跑」，也方便远程/日志取证。 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX) return;
  if (root.__CX_PROBE__) return;
  root.__CX_PROBE__ = true;

  const doc = root.document;
  let el = null;

  function ensure() {
    if (el && el.isConnected) return el;
    if (!doc.body) return null;
    el = doc.createElement('div');
    el.id = 'cx-probe-' + CX.frameDepth;
    el.setAttribute('data-cx-probe', '1');
    el.style.cssText = 'display:none!important;position:absolute;left:-9999px;width:0;height:0;';
    doc.body.appendChild(el);
    return el;
  }

  function snapshot(full) {
    /* 2026-10-28 性能修复：这个快照每 1.5 秒跑一次，原来每次都做全量诊断 ——
     *   · document.documentElement.innerHTML.slice(0, 400000)（序列化 40 万字符 DOM）
     *   · CX.qsa('a,li,div,span,button,em,i,p') 然后逐个 CX.oneLine(innerText)（强制同步布局）
     *   · 每个候选再做 CX.qsa('*', el)（O(n²)）
     * 站点弹窗一出现 DOM 变大，这一次就能把主线程占住几十秒 → 整页点不动、连刷新都不响应。
     * 现在只有「点浮窗诊断按钮」或日志级别=debug 时才跑重型部分，平时只更新轻量状态。 */
    const deep = full !== false;
    const out = {
      frame: CX.frameDepth,
      top: CX.isTop,
      href: location.href.slice(0, 160),
      enabled: !!CX.cfg.enabled,
      video: null,
      quiz: null,
      exam: null,
      nav: null,
      status: null
    };
    try {
      const v = CX.player && CX.player.qVideo && CX.player.qVideo();
      if (v) {
        out.video = {
          paused: v.paused,
          ended: v.ended,
          t: Math.round(v.currentTime || 0),
          d: Math.round(v.duration || 0),
          vol: v.volume,
          muted: v.muted,
          rate: v.playbackRate,
          ready: v.readyState,
          err: v.error ? v.error.code : 0
        };
        out.videoDone = !!(CX.player.isVideoDone && CX.player.isVideoDone());
      }
      if (CX.videoQuiz) out.quiz = { busy: CX.videoQuiz.state.busy, rounds: CX.videoQuiz.state.rounds, tried: CX.videoQuiz.state.tried.slice(-3), mark: (CX.videoQuiz.state.mark || '').slice(0, 60) };
      if (CX.exam) out.exam = { busy: CX.exam.state.busy, round: CX.exam.state.round, finished: CX.exam.state.finished, pageKey: (CX.exam.state.pageKey || '').slice(-40) };
      if (CX.nav) out.nav = { clicks: CX.nav.state.clicks, busy: CX.nav.state.busy, stuck: CX.nav.state.stuck, stopped: CX.nav.state.stopped, hasNext: !!(CX.nav.findNextButton && CX.nav.findNextButton()) };
      /* 任务点状态（排查「为什么跳/为什么不跳」的关键证据） */
      out.tasks = CX.qsa('[aria-label*="任务点"]').slice(0, 10).map(function (el) {
        return String(el.getAttribute('aria-label') || '').slice(0, 50);
      });
      out.jobs = CX.qsa('[class*="ans-job"]').slice(0, 10).map(function (el) {
        return String(el.className).slice(0, 40) + ' | ' + String(el.getAttribute('aria-label') || '').slice(0, 30);
      });
      out.unfinished = !!(CX.nav && CX.nav.hasUnfinishedTask && CX.nav.hasUnfinishedTask());
      out.allDone = !!(CX.nav && CX.nav.allTasksDone && CX.nav.allTasksDone());
      out.dialogApi = !!(CX.nav && CX.nav.dismissBlockingDialogs);
      out.dialogText = /笔记未保存|是否保存笔记|还有章节笔记/.test(CX.oneLine(doc.body ? doc.body.textContent : '').slice(0, 3000));
      out.logs = (CX.logRing || []).slice(-8).map(function (l) { return l.t + ' ' + l.l + ' ' + l.m; });
      try { out.agg = (CX.nav && CX.nav.state && CX.nav.state.agg) ? CX.nav.state.agg : null; } catch (e) {}

      /* ---- 以下为重型诊断：只在你点浮窗「诊断」或日志级别=debug 时才算 ---- */
      if (deep) {

      try {
        const words = ['学习视频', '学习测验', '学习检测', '章节测验', '测验', '任务点', '作业'];
        const cands = [];
        CX.qsa('a,li,div,span,button,em,i,p').forEach(function (el) {
          if (cands.length >= 12) return;
          const t = CX.oneLine(el.innerText || '');
          if (!t || t.length > 20) return;
          if (!words.some(function (w) { return t.indexOf(w) >= 0; })) return;
          if (!CX.visible(el)) return;
          /* 只保留最内层，避免同一段文字重复 */
          const inner = CX.qsa('*', el).some(function (c) { return CX.oneLine(c.innerText || '') === t; });
          if (inner) return;
          cands.push((el.tagName + '.' + String(el.className || '').slice(0, 28) +
            '|' + t + '|aria=' + String(el.getAttribute('aria-label') || '').slice(0, 18) +
            '|oc=' + String(el.getAttribute('onclick') || '').slice(0, 36)).slice(0, 140));
        });
        out.taskBar = cands;
        out.noteDlg = !!CX.findByText(['不保存'], doc, { maxLen: 4, exact: true });
      } catch (e) { out.taskBarErr = String(e && e.message); }

      /* 题库页结构取证：题目容器 / 输入框 / 字体混淆 / 高频类名 */
      try {
        const boxes = CX.qsa('.questionLi, .TiMu, .Py-mian1, .questionWrap, .question-item, li[id], div[id^="question"]');
        out.qBoxes = boxes.slice(0, 6).map(function (el) {
          return (el.tagName + '.' + String(el.className || '').slice(0, 26) + '#' + (el.id || '') +
            '|' + CX.oneLine(el.innerText || '').slice(0, 46));
        });
        out.inputs = {
          radio: CX.qsa('input[type="radio"]').length,
          checkbox: CX.qsa('input[type="checkbox"]').length,
          text: CX.qsa('input[type="text"]').length,
          textarea: CX.qsa('textarea').length
        };
        const faces = CX.qsa('style').map(function (s) { return s.textContent || ''; })
          .filter(function (t) { return t.indexOf('@font-face') >= 0; });
        out.fontFaces = faces.slice(0, 2).map(function (t) { return t.replace(/\s+/g, ' ').slice(0, 180); });
        out.fontFamily = (function () {
          const el = CX.qa('.Zy_TItle, .questionLi, .TiMu') || doc.body;
          try { return getComputedStyle(el).fontFamily.slice(0, 60); } catch (e) { return ''; }
        })();
        out.bodyHead = CX.oneLine((doc.body && doc.body.innerText) || '').slice(0, 160);
        /* 目录条目取证：每条的知识点 id、编号、class 链、文本，用于定位「当前章节」 */
        try {
          const names = CX.qsa('.posCatalog_name, .posCatalog_level a');
          out.tocCount = names.length;
          out.toc = names.slice(0, 24).map(function (el, i) {
            const oc = el.getAttribute('onclick') || '';
            const nums = (oc.match(/'(\d+)'/g) || []).map(function (s) { return s.replace(/'/g, ''); });
            const row = el.closest('.posCatalog_select') || el.parentElement;
            return i + '|id=' + (nums.length >= 3 ? nums[2] : '') +
              '|' + CX.oneLine(el.innerText || '').slice(0, 22) +
              '|row=' + String((row && row.className) || '').slice(0, 26) +
              '|el=' + String(el.className || '').slice(0, 22);
          });
          out.curIdSeen = (function () {
            const m = (location.search + ' ' + doc.documentElement.innerHTML.slice(0, 400000))
              .match(/(?:chapterId|knowledgeid|stu_knowledgeId)\s*=\s*"?(\d+)/i);
            return m ? m[1] : '';
          })();
        } catch (e) { out.tocErr = String(e && e.message); }
        if (CX.parser && CX.parser.diag) out.diag = CX.parser.diag();
        /* 结果页 ✓ / ✗ 图标的真实标记（className / src / alt），用于校准错题识别 */
        try {
          const q0 = CX.qa('.TiMu, .questionLi, .Py-mian1, .questionWrap');
          if (q0) {
            out.marks = CX.qsa('img, svg, i, span, div, em', q0).filter(CX.visible).slice(0, 14).map(function (el) {
              return (el.tagName + '.' + String(el.className || '').slice(0, 26) +
                '|src=' + String((el.getAttribute && el.getAttribute('src')) || '').split('/').pop().slice(0, 24) +
                '|alt=' + String((el.getAttribute && el.getAttribute('alt')) || '').slice(0, 10) +
                '|' + CX.oneLine(el.innerText || '').slice(0, 14));
            });
          }
        } catch (e) { out.marksErr = String(e && e.message); }
        /* 第一个题目里每个选项的真实 class（判断「选中态」用什么类名） */
        const firstQ = CX.qa('.TiMu, .questionLi, .Py-mian1');
        if (firstQ) {
          out.opts = CX.qsa('li', firstQ).slice(0, 8).map(function (li) {
            const icon = CX.qa('i,em', li);
            return (String(li.className || '').slice(0, 36) || '(no-class)') +
              ' |icon:' + String(icon && icon.className || '').slice(0, 30) +
              ' |' + CX.oneLine(li.innerText || '').slice(0, 18);
          });
        }
      } catch (e) { out.examErr = String(e && e.message); }
      /* 诊断：下一节按钮到底绑了什么、目录项怎么带 chapterId */
      if (CX.isTop) {
        const btn = document.getElementById('prevNextFocusNext');
        out.nextBtn = btn ? String(btn.outerHTML || '').replace(/\s+/g, ' ').slice(0, 260) : 'none';
        const curId = (location.search.match(/chapterId=(\d+)/) || [])[1] || '';
        out.curId = curId;
        out.chapterHits = CX.qsa('[onclick*="hapter"], a[href*="studentstudy"]').slice(0, 6).map(function (el) {
          return (el.tagName + '|' + String(el.getAttribute('onclick') || '').slice(0, 70) + '|' +
            String(el.getAttribute('href') || '').slice(0, 100) + '|' + CX.oneLine(el.innerText).slice(0, 24));
        });
        out.scriptWithId = 0;
        out.scriptSnips = [];
        try {
          Array.prototype.forEach.call(document.scripts, function (s) {
            const t = s.textContent || '';
            const i = curId ? t.indexOf(curId) : -1;
            if (i >= 0) {
              out.scriptWithId++;
              if (out.scriptSnips.length < 2) out.scriptSnips.push(t.slice(Math.max(0, i - 120), i + 200).replace(/\s+/g, ' '));
            }
          });
        } catch (e) {}
        out.bodyTail = CX.oneLine((document.body && document.body.innerText || '')).slice(-120);
      }
      }   /* ---- end if (deep)：重型诊断到此为止 ---- */
      out.status = (CX.lastStatusText || '');
    } catch (e) {
      out.err = String(e && e.message);
    }
    return out;
  }

  function tick(full) {
    const box = ensure();
    if (!box) return;
    try { box.textContent = JSON.stringify(snapshot(full === true)); } catch (e) {}
  }

  function isDebugLevel() {
    try { return !!(CX.cfg && CX.cfg.ui && CX.cfg.ui.logLevel === 'debug'); } catch (e) { return false; }
  }

  function tickSafe(full) {
    try { tick(full); } catch (e) {
      try {
        const el = document.getElementById('cx-probe-' + (function(){ try { return window.top === window ? 0 : 1; } catch (x) { return 1; } })());
        if (el) el.textContent = JSON.stringify({ err: String(e && e.message) });
      } catch (x) {}
    }
  }

  /* 2026-10-28 降载：固定 5 秒一次（debug 级别也只是"带重型诊断"，不再提速 ——
   * 以前 debug 会变成"卡顿开关"）。要一次性全量诊断就点浮窗的「诊断」按钮。 */
  /* 2026-10-31 发布版减面：这个隐藏节点只服务排障，平时不往页面里插 ——
   * 只有「调试模式」打开或日志级别=debug 时才铺，减少站点侧的指纹面。
   * CX.probe.snapshot() 始终可用，浮窗「诊断」不受影响；配置热更新后 5 秒内自动跟随。 */
  function probeDomOn() {
    try {
      const c = CX.cfg || {};
      return !!(c.ui && c.ui.debugMode) || isDebugLevel();
    } catch (e) { return false; }
  }

  (function loop() {
    const deep = isDebugLevel();
    setTimeout(function () {
      if (probeDomOn()) tickSafe(deep);
      loop();
    }, 5000);
  })();
  setTimeout(function () { if (probeDomOn()) tickSafe(false); }, 800);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { if (probeDomOn()) tickSafe(false); });
  CX.probe = { tick: tick, snapshot: snapshot };

})(typeof globalThis !== 'undefined' ? globalThis : this);
