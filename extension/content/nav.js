/* 章节导航：视频学完 / 测验通过后自动点「下一节」，处理空页面与闯关锁 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX) return;
  if (CX.nav) return;

  const st = {
    clicks: 0,
    lastClickAt: 0,
    stuck: 0,
    reloads: 0,
    sig: '',
    pendingAt: 0,
    busy: false,
    stopped: false,
    emptySince: 0,
    loadedAt: Date.now(),
    pendingAdvanceAt: 0,
    claimRetries: 0,
    lastTaskSign: Date.now(),
    typeSince: 0,
    noNextSince: 0,     /* 找不到下一章 / 下一节按钮的起始时间（用来判定课程末尾） */
    pageType: '',
    quizTaskClicked: '',
    quizClickedAt: 0,   /* 测验入口最近一次点击时间（8 秒冷却，替代 location.href 去重） */
    quizClickKey: '',   /* 2026-10-30：已经点过测验入口的章节 key，同章不再点第二次 */
    quizKeyAt: 0,
    lastAdvanceWhy: '',
    noTocAt: 0,
    tocOpenedAt: 0,
    stoppedAt: 0,
    lastEntryAt: 0,
    chapterKey: '',     /* 2026-10-30：当前章节标识，用来做「切章落地期」 */
    chapterAt: 0,
    quizDoneAnnounced: '',  /* 已经广播过「测验任务点完成」的章节 */
    /* 2026-11-04：跳过学习检测时，已经排过「4 秒后切章」的章节 key */
    skipFallbackKey: '',
    /* 2026-11-03：目录智能跳章 */
    failedToc: {},          /* 点了没切成的目录项（章节 id → 时间），下次跳过它 */
    noTargetSince: 0,       /* 「后面只剩已完成/未解锁」的起始时间 */
    noTargetNoted: false,
    stopReason: '',          /* 'no-target' = 后面没得跳了才停的 */
    tocPlan: null,           /* 最近一次目录扫描结果（调试/测试用） */
    lastTocLogKey: '',
    lastTocDbgAt: 0
  };

  function navCfg() { return CX.cfg.nav || {}; }

  /* 2026-11-04：作答方式为「跳过（进页面不作答）」时，导航不再为「任务条上还有未完成的测验入口」
   * 白等，也不在测验页上卡住。取值统一走 CX.examMode()（ai-first / brute / skip）。 */
  function examSkipOn() {
    try { return !!(CX.examMode && CX.examMode() === 'skip'); } catch (e) { return false; }
  }
  /* 「自动处理学习检测」关掉时，导航连任务条上的测验入口都不点，任务点做完直接切下一章 */
  function examEnabled() {
    try { return !(CX.cfg && CX.cfg.exam && CX.cfg.exam.enabled === false); } catch (e) { return true; }
  }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  /* ---------- 寻找「下一节」按钮 ---------- */
  const NEXT_IDS = ['prevNextFocusNext', 'nextSection', 'nextChapter', 'btnNext', 'nextBtn'];

  function findNextButton() {
    /* 当前文档 */
    for (let i = 0; i < NEXT_IDS.length; i++) {
      const el = document.getElementById(NEXT_IDS[i]);
      if (el) return el;
    }
    let el = CX.findByText(['下一节', '下一章', '下一个', '下一讲', '下一课'], document, { maxLen: 10 });
    if (el) return el;

    /* 同源父文档 */
    const parents = CX.walkAccessibleParents().slice(1);
    for (let p = 0; p < parents.length; p++) {
      let d;
      try { d = parents[p].document; } catch (e) { continue; }
      if (!d) continue;
      for (let i = 0; i < NEXT_IDS.length; i++) {
        const e2 = d.getElementById(NEXT_IDS[i]);
        if (e2) return e2;
      }
      const e3 = CX.findByText(['下一节', '下一章', '下一个', '下一讲'], d, { maxLen: 10 });
      if (e3) return e3;
    }
    return null;
  }

  function isLocked() {
    const t = CX.oneLine(document.body ? document.body.innerText : '').slice(0, 3000);
    return /需完成之前|闯关任务点|尚未解锁|解锁后/.test(t);
  }

  function hasUnfinishedTask() {
    /* 老脚本验证过的判定：任务点元素用 aria-label 标注「未完成 / 已完成」 */
    const tasks = CX.qsa('[aria-label*="任务点"]');
    for (let i = 0; i < tasks.length; i++) {
      const a = tasks[i].getAttribute('aria-label') || '';
      if (a.indexOf('未完成') >= 0) return true;
    }
    /* 兼容：任务点容器里有可见的「完成条件」说明，说明还没做完 */
    const blocks = CX.qsa('[class*="ans-job"]').filter(CX.visible);
    for (let i = 0; i < blocks.length; i++) {
      if (/ans-job-video/.test(blocks[i].className)) continue;
      const cond = blocks[i].querySelector('.task-condition');
      if (cond && CX.visible(cond)) return true;
    }
    return false;
  }

  /* 本帧任务点是否全部完成：必须有正向证据（存在带 aria-label 的任务点且都标为已完成） */
  function allTasksDone() {
    const tasks = CX.qsa('[aria-label*="任务点"]');
    if (!tasks.length) return false;
    if (hasUnfinishedTask()) return false;
    if (CX.qsa('[class*="ans-job"]').filter(CX.visible).length === 0) return false;
    return tasks.some(function (t) { return /已完成/.test(t.getAttribute('aria-label') || ''); });
  }

  function hasQuizOpen() {
    return !!(CX.parser && CX.parser.findVideoQuizBox && CX.parser.findVideoQuizBox());
  }

  function hasVideo() {
    return !!(CX.player && CX.player.qVideo && CX.player.qVideo());
  }

  /* 本帧是否还有「未完成的其他类型任务点」（文档/PPT/作业…），
   * 靠 .task-condition 是否可见判断，避免把没看完的文档任务跳过去 */
  function hasPendingTaskBlock() {
    const blocks = CX.qsa('[class*="ans-job"]').filter(CX.visible);
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      if (/ans-job-video/.test(el.className)) continue; // 视频由 player 判定
      const cond = el.querySelector('.task-condition');
      if (cond && CX.visible(cond)) return true;
      const aria = el.getAttribute('aria-label') || '';
      if (aria.indexOf('未完成') >= 0) return true;
    }
    return false;
  }

  function isStudyPage() {
    return /studentstudy|knowledge\/cards|mycourse|mooc2-ans/i.test(location.href);
  }

  /* 只有「真正承载学习内容」的帧才做空页面判定，
   * 否则顶层 studentstudy 外壳（里面全是 iframe、自己看不到视频）会把每一节都直接跳过去 */
  function isContentFrame() {
    if (/knowledge\/cards/i.test(location.href)) return true;
    return isStudyPage() && CX.qsa('iframe').length === 0;
  }

  function videoDone() {
    return !!(CX.player && CX.player.isVideoDone && CX.player.isVideoDone());
  }

  /* 页面签名：用于判断点击后是否真的切换了章节 */
  function signature() {
    let s = location.href;
    s += '|' + (document.body ? CX.oneLine(document.body.innerText).length : 0);
    const v = CX.player && CX.player.qVideo && CX.player.qVideo();
    if (v && v.src) s += '|' + v.src.slice(-60);
    const t = CX.qa('.ans-job-video, [aria-label*="任务点"]');
    if (t) s += '|' + (t.getAttribute('aria-label') || '');
    CX.qsa('iframe').forEach(function (f) { s += '|' + (f.src || '').slice(-40); });
    return s;
  }

  /* 是否已经到课程最后一节。
   * 2026-10-31：真实页面到最后一节时**通常什么都不写** —— 没有「下一节」按钮、目录里也没有下一项。
   * 原来只靠文案「课程已学完/已经是最后一节」判定，永远不成立，所以"课程末尾自动停止"看起来完全没生效。 */
  function atCourseEnd() {
    const btn = findNextButton();
    if (btn) return false;
    const t = CX.oneLine(document.body ? document.body.innerText : '').slice(0, 4000);
    return /课程已学完|已经是最后一节|没有下一节|没有更多章节|全部完成|本课程已结束/.test(t);
  }

  /* 到末尾的统一判定：页面自己说了 → 立刻停；否则"没有下一章、也没有下一节按钮"持续 N 秒 → 也按末尾处理。
   * N 默认 12 秒（约 3 个巡检周期），可用配置 nav.endConfirmMs 调整。 */
  function maybeStopAtCourseEnd(where, minMs) {
    if (navCfg().stopAtCourseEnd === false) { st.noNextSince = 0; return false; }
    if (atCourseEnd()) {
      st.stopped = true;
      st.stoppedAt = 0;
      CX.info('课程已到末尾（页面声明）→ 自动停止（' + where + '）');
      CX.status('🎉 已到课程最后一节', { busy: false, phase: 'nav' });
      return true;
    }
    const grace = Math.max(Number(minMs || 0), Number(navCfg().endConfirmMs || 12000));
    if (!st.noNextSince) {
      st.noNextSince = Date.now();
      CX.info('没有下一章、也没有「下一节」按钮 → 等 ' + Math.round(grace / 1000) + ' 秒确认是否到课程末尾');
      return false;
    }
    if (Date.now() - st.noNextSince < grace) {
      CX.debug('仍在确认课程末尾（' + Math.round((Date.now() - st.noNextSince) / 1000) + 's / ' + Math.round(grace / 1000) + 's）');
      return false;
    }
    st.stopped = true;
    st.stoppedAt = 0;
    CX.info('连续 ' + Math.round(grace / 1000) + ' 秒找不到下一章 → 判定课程结束，自动停止（' + where + '）');
    CX.status('🎉 课程已到末尾，自动停止', { busy: false, phase: 'nav' });
    return true;
  }

  /* ---------- 主世界防暂停自检（只在顶层帧跑一次，结果写进日志） ---------- */
  setTimeout(function () {
    if (!CX.isTop) return;
    send({ kind: 'main:op', op: 'probeMain' }).then(function (r) {
      if (r && r.ok && r.result) {
        CX.info('主世界防暂停: ' + (r.result.anti ? '已生效' : '未生效') +
          '（页面 hidden=' + r.result.hidden + ', ' + r.result.visibility + '）');
      } else if (r && !r.ok) {
        CX.warn('主世界自检失败: ' + r.error);
      }
    });
  }, 3000);

  /* ---------- 任务条里的「学习测验」入口 ----------
   * 真实结构（从页面探针抓到的）：
   *   <div class="prev_white"><span class="spanText">1学习视频</span></div>
   *   <div class="prev_white"><span class="spanText">2学习测验</span></div>
   * 没有 aria-label、没有 onclick，事件是委托在容器上的。 */
  const QUIZ_WORDS = ['学习测验', '章节测验', '学习检测', '单元测验', '课后测验'];

  function isQuizTaskText(t) {
    return QUIZ_WORDS.some(function (w) { return String(t || '').indexOf(w) >= 0; });
  }

  /* 在**单个文档**里找任务条上的「学习测验」项（优先未完成） */
  function scanQuizEntryIn(d) {
    /* 学习通的真实结构（2026-10-28 从页面实测抓到的）：
     *   <div class="prev_white"><span class="spanText">2学习测验</span></div>   ← 只有外壳，没有 onclick
     *   <ul class="prev_list"><li onclick="changeDisplayContent(2,2,'1207354470','266214610','157743790')">2学习测验</li>
     * 能点的只有 li（带 onclick）。点 .prev_white 或里面的 span 一律没有反应 ——
     * 之前"人工能点、脚本点不动"就是这个原因，不是 isTrusted。 */
    const all = CX.qsa('.prev_list li, .prev_white, .prevItem, .ans-job-icon, [class*="ans-job-work"]', d);
    const clickable = all.filter(function (el) { return !!(el.getAttribute && el.getAttribute('onclick')); });
    const pool = clickable.length ? clickable : all;
    for (let k = 0; k < pool.length; k++) {
      const el = pool[k];
      if (!CX.visible(el)) continue;
      const t = CX.oneLine(String(el.textContent || '')).slice(0, 40);
      if (!isQuizTaskText(t)) continue;
      if (entryLooksDone(el)) continue;      /* 已完成的入口不再点 */
      return el;                              /* 返回带 onclick 的 li 本身 */
    }
    const byText = CX.findByText(QUIZ_WORDS, d, { maxLen: 16 });
    if (byText) {
      const box = byText.closest('.prev_white, .prev_list li, [class*="ans-job"]');
      if (box && !entryLooksDone(box)) return box;
    }
    return null;
  }

  /* 找「学习测验」入口：所有帧都允许跨（同源）文档找 —— 任务条一般在顶层，内容帧必须看得见。
   * 真正要防的是"两个帧同时点"，用 quizClickGuard() 做跨帧去重，不是把谁的眼睛蒙上。
   * （2026-10-28：上一版限制 `!CX.isTop 直接 return null`，导致内容帧看不到"2学习检测"，
   *   把它当成"只有视频没任务点"的页直接切走了。） */
  function findQuizTaskEntry() {
    /* 2026-11-04：「自动处理学习检测」关掉 → 完全不碰测验入口（以前会点开然后卡住） */
    if (!examEnabled()) return null;
    const own = scanQuizEntryIn(document);
    if (own) return own;
    const docs = CX.walkAccessibleParents().map(function (w) {
      try { return w.document; } catch (e) { return null; }
    }).filter(Boolean);
    for (let i = 0; i < docs.length; i++) {
      if (docs[i] === document) continue;
      const r = scanQuizEntryIn(docs[i]);
      if (r) return r;
    }
    return null;
  }

  /* 跨帧去重：同一个测验入口 15 秒内只允许被点一次（同源，写顶层变量即可共享） */
  function quizClickGuard() {
    const now = Date.now();
    try {
      const last = root.top.__cxQuizClickAt || 0;
      if (now - last < 15000) return false;
      root.top.__cxQuizClickAt = now;
      return true;
    } catch (e) { return true; }
  }

  /* 点任务条上的「学习测验」入口。2026-10-28 三次返工后的最终版：
   *   ① 真实合成点击（旧版就这么做、有效；站点是事件委托）
   *   ② 无条件"直接切内容帧"（switchQuiz，幂等 + 去掉 crossId=undefined）
   *      —— 不依赖 onclick，因为有的页面任务条只有 .prev_white（没有 onclick）
   *   ③ 2 秒后检查有没有 work 帧，没有就再点一次（并打 warn，不再静默）
   * 千万不要再调站点的 changeDisplayContent：它拼的 URL 带 crossId=undefined，iframe 加载失败。 */
  /* 2026-11-04：跳过学习检测的兜底 —— 进了测验入口 4 秒后自己切章。
   * 有的课程卷子 DOM 认不出来（exam 那边既不答疑也不广播），以前就干等在测验页上。
   * 每章只排一次；exam 先广播的话 clickNext 会被 claim / busy / 冷却去重，不会跳两节。 */
  function scheduleSkipFallback() {
    if (!examSkipOn()) return;
    const key = quizChapterKey();
    if (!key || st.skipFallbackKey === key) return;
    st.skipFallbackKey = key;
    setTimeout(function () {
      if (st.skipFallbackKey !== key || st.stopped || st.busy) return;
      CX.info('跳过学习检测：进页面 4 秒了，直接切下一章');
      clickNext('skip-fallback');
    }, 4000);
  }

  function clickEntry(el) {
    if (!el) return false;

    /* onclick 可能在内层元素或祖先上（入口本身可能只是文字 span） */
    let oc = '';
    try { oc = String((el.getAttribute && el.getAttribute('onclick')) || ''); } catch (e) {}
    if (!oc) {
      try {
        const p = el.closest && el.closest('[onclick]');
        if (p) oc = String(p.getAttribute('onclick') || '');
      } catch (e) {}
    }
    if (!oc) {
      try {
        const inner = el.querySelector('[onclick]');
        if (inner) oc = String(inner.getAttribute('onclick') || '');
      } catch (e) {}
    }

    /* ① 真实点击（最接近人工）：先点自己，再点外层容器 */
    try { CX.click(el); } catch (e) {}
    const outer = (el.closest && el.closest('.prev_white, .prev_list li, .prevItem')) || el.parentElement;
    if (outer && outer !== el) {
      setTimeout(function () { try { CX.click(outer); } catch (e) {} }, 180);
    }

    /* ② 无条件确保内容帧切到测验 tab：不依赖 onclick ——
     * 有些页面任务条只有 .prev_white（没 onclick），点它不会有任何反应。
     * switchQuiz 是幂等的：已经是 num=1 就不动，并顺手去掉 crossId=undefined。 */
    let frameNum = 1;
    try {
      const oc2 = String((el.getAttribute && el.getAttribute('onclick')) || '');
      const m2 = oc2.match(/\(\s*(\d+)/);
      if (m2) frameNum = Math.max(0, parseInt(m2[1], 10) - 1);
    } catch (e) {}
    try {
      const r2 = CX.mainCall('switchQuiz', { num: frameNum });
      if (r2 && r2.ok) CX.info('内容帧已切到测验（num=' + frameNum + '）');
      else CX.warn('直接切内容帧失败：' + ((r2 && r2.err) || 'unknown'));
    } catch (e) {}

    /* ③ 2 秒后验证：页面里还没有 work 帧（测验没加载出来）就再点一次。
     * 不能用 looksLikeExamPage 判断 —— 测验在子帧里，顶层看不到题目。 */
    setTimeout(function () {
      try {
        const hasWork = anyDoc().some(function (d) {
          try { return !!d.querySelector('iframe[src*="/work/"], iframe[src*="doHomeWorkNew"]'); } catch (e) { return false; }
        });
        if (hasWork) return;
        CX.warn('点了「' + entryLabel(el) + '」但测验页没出来，再点一次');
        CX.click(el);
      } catch (e) {}
    }, 2000);

    scheduleSkipFallback();
    return true;
  }

  /* 入口的显示名（内层 span 的文本可能只有数字，这里回溯到任务条项取全文） */
  function entryLabel(el) {
    try {
      const box = (el.closest && el.closest('.prev_white, .prev_list li, .prevItem')) || el;
      return CX.oneLine(box.innerText || box.textContent || '').slice(0, 20) || '学习测验';
    } catch (e) { return '学习测验'; }
  }

  /* 测验入口的点击冷却（8 秒）。用时间戳而不是 location.href：
   * 切 tab 会让 URL 变（hash/参数），用 href 去重会失效 → 每秒重复点。 */
  function quizEntryCooldown() {
    const now = Date.now();
    if (st.quizClickedAt && now - st.quizClickedAt < 8000) return true;
    st.quizClickedAt = now;
    return false;
  }

  /* ---------- 同一章节只点一次测验入口（2026-10-30） ----------
   * 病根：任务条项经常拿不到「已完成」标记（标记在里层图标/外层容器上，见 entryLooksDone），
   * findQuizTaskEntry() 于是永远返回它 → 8 秒冷却一到就再点一次 →
   * 站点 changDisplayContent 重载答题 iframe → 正在答的卷子被打断、永远交不上去。
   * 现在按 chapterId 记账：同一章点过一次就不再点（120 秒后才允许重试一次）。 */
  function quizChapterKey() {
    try {
      const m = String(location.href).match(/[?&]chapterId=(\d+)/i);
      if (m) return m[1];
      return String(location.href).split('?')[0] || String(location.href);
    } catch (e) { return ''; }
  }
  function quizClickedThisChapter() {
    const k = quizChapterKey();
    if (!k || st.quizClickKey !== k) return false;
    return Date.now() - (st.quizKeyAt || 0) < 120000;
  }
  function markQuizClicked() {
    st.quizClickKey = quizChapterKey();
    st.quizKeyAt = Date.now();
  }

  /* 答题帧正在作答时不要抢着点入口（会把 iframe 重载，作答直接丢）。
   * exam.js 在 busy 期间不停刷新 window.top.__cxExamBusyAt。
   * 2026-10-30：窗口从 30 秒收到 15 秒 —— exam 每 1.5 秒刷新一次，15 秒足够；
   * 太长会把「刚切完章的新页面」也挡住（实测第二个测验白等 26 秒）。 */
  function examBusyRecently() {
    try {
      const t = root.top.__cxExamBusyAt || 0;
      return Date.now() - t < 15000;
    } catch (e) { return false; }
  }

  /* ---------- 顶层当权威：任务条上的测验项是否都已完成（2026-10-30） ----------
   * 答题帧常在不同主机（mooc1 ↔ mooc-ans），跨域读不到任务条，exam 自己永远判未完成。
   * 顶层这里能看到任务条，判定后广播给所有帧，让答题帧按"已完成"处理。 */
  function quizTaskDoneVisibleHere() {
    let items = [];
    try { items = CX.qsa('.prev_white, .prev_list li, .prevItem, .ans-attach-ct', document); } catch (e) { return false; }
    items = items.filter(function (el) {
      return isQuizTaskText(CX.oneLine(String(el.textContent || '')).slice(0, 200));
    });
    if (!items.length) return false;
    return items.every(entryLooksDone);
  }

  function announceQuizTaskDone() {
    if (st.quizDoneAnnounced === quizChapterKey()) return;
    if (!quizTaskDoneVisibleHere()) return;
    st.quizDoneAnnounced = quizChapterKey();
    try {
      chrome.runtime.sendMessage({ kind: 'quiz:taskDone', url: location.href, ts: Date.now() });
      CX.info('顶层判定：学习测验任务点已完成 → 广播给答题帧');
    } catch (e) {}
  }

  /* ---------- 只识别、不代点的拦路弹窗 ----------
   * 按你的要求不再替站点做「保存/不保存」的决定；但弹窗盖着页面时任何点击都无效，
   * 所以这里只做识别 + 提示，避免出现「点了没反应还不知道为什么」。 */
  function noteDialogInAnyDoc() {
    const docs = CX.walkAccessibleParents().map(function (w) {
      try { return w.document; } catch (e) { return null; }
    }).filter(Boolean);
    for (let i = 0; i < docs.length; i++) {
      const no = CX.findByText(['不保存'], docs[i], { maxLen: 4, exact: true });
      const yes = CX.findByText(['保存'], docs[i], { maxLen: 4, exact: true });
      if (no && yes) return true;
    }
    return false;
  }
  let lastNoteWarnAt = 0;
  function warnNoteDialogBlocking() {
    const now = Date.now();
    if (now - lastNoteWarnAt < 20000) return;
    lastNoteWarnAt = now;
    CX.warn('站点弹出「笔记未保存」弹窗，挡住了点击；请手动点「不保存」（本扩展不代替你处理该弹窗）');
    CX.status('⚠ 请手动关闭「笔记未保存」弹窗', { busy: false, phase: 'nav' });
  }

  /* 静默关掉「笔记未保存」弹窗：
   * 只在两个按钮都可见时才动手（避免对隐藏模板狂点 + 刷日志），1.5 秒去重，日志用 debug。 */
  let lastNoteCloseAt = 0;
  /* 多视频章节的进度去抖（只在完成数变化时打一条日志） */
  let lastProgDone = -1;
  function closeNoteDialogQuiet() {
    const now = Date.now();
    if (now - lastNoteCloseAt < 1500) return false;

    /* 站点的「不保存」是 <a href="javascript:" onclick="scroll2Job()">，页面响应头下发的
     * CSP 没有 'unsafe-inline'，内联 handler 与 javascript: URL 都会被拒绝 ——
     * 合成点击只会换来一条 CSP 违规日志，弹窗纹丝不动（实测 800ms 后按钮和遮罩都还在）。
     * 遮罩会吞掉页面上的所有点击，所以这里直接摘掉遮罩，不再跟站点的按钮较劲。 */
    const docs = [];
    try {
      (CX.walkAccessibleParents() || []).forEach(function (w) {
        try { if (w.document) docs.push(w.document); } catch (e) {}
      });
    } catch (e) {}
    if (docs.indexOf(document) < 0) docs.unshift(document);

    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      let mask = null;
      try { mask = d.querySelector('.maskDiv.jobFinishTip'); } catch (e) {}
      if (!mask) continue;
      try {
        mask.remove();
        if (d.body) d.body.style.overflow = '';
        lastNoteCloseAt = now;
        CX.debug('已摘除「笔记未保存」遮罩（站点按钮在 CSP 下点不动）');
        return true;
      } catch (e) {}
    }

    /* 兜底：老页面结构没有 jobFinishTip 遮罩时，仍按原逻辑点「不保存」 */
    const no = CX.findByText(['不保存'], document, { maxLen: 4, exact: true });
    if (!no) return false;
    const yes = CX.findByText(['保存'], document, { maxLen: 4, exact: true });
    if (!yes) return false;
    lastNoteCloseAt = now;
    CX.click(no);
    CX.debug('关闭「笔记未保存」弹窗（不保存）');
    return true;
  }

  /* ---------- 目录切换（优先用右侧目录点下一章） ----------
   * 目录项结构：<span class="posCatalog_name" onclick="getTeacherAjax('course','clazz','<knowledgeid>','cpi'...)">
   * 「下一节」按钮走 PCount.next，容易被站点的笔记/离开弹窗卡死，所以优先走目录。 */
  function tocChapterId(el) {
    const oc = (el && el.getAttribute && el.getAttribute('onclick')) || '';
    /* getTeacherAjax('courseId','clazzId','knowledgeId','cpi',...) → 第 3 个参数是章节 id */
    const nums = (oc.match(/'(\d+)'/g) || []).map(function (s) { return s.replace(/'/g, ''); });
    return nums.length >= 3 ? nums[2] : '';
  }

  /* 当前章节 id：内容帧 URL 里是 knowledgeid，顶层是 chapterId，页面脚本里是 stu_knowledgeId */
  function currentChapterId() {
    let s = '';
    try { s += ' ' + location.search; } catch (e) {}
    try { s += ' ' + root.top.location.search; } catch (e) {}
    try { s += ' ' + top.location.search; } catch (e) {}
    let m = s.match(/(?:chapterId|knowledgeid|knowledgeId)=(\d+)/i);
    if (m) return m[1];
    try {
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const mm = html.match(/stu_knowledgeId\s*=\s*"?(\d+)/);
      if (mm) return mm[1];
    } catch (e) {}
    return '';
  }

  /* 2026-10-31：答题侧"放弃本节"的章节列表（storage 持久化，刷新后仍然有效） */
  let giveUpChapters = {};
  try {
    chrome.storage.local.get(['cxGiveUpChapters'], function (r) {
      giveUpChapters = (r && r.cxGiveUpChapters) || {};
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === 'local' && ch.cxGiveUpChapters) giveUpChapters = ch.cxGiveUpChapters.newValue || {};
    });
  } catch (e) {}
  /* 2026-10-31：答题侧跑满轮数后会把 top.__cxExamGiveUpChapter 标成本章 id，
   * 表示「这节的测验不做了」—— 导航据此跳过测验入口、直接切下一章。 */
  function examGaveUpHere() {
    try {
      const cid = currentChapterId();
      if (!cid) return false;
      if (giveUpChapters[cid]) return true;
      const mark = String(root.top.__cxExamGiveUpChapter || '');
      return !!(mark && cid === mark);
    } catch (e) { return false; }
  }
  /* ---------- 目录条目状态（2026-11-03 真机取证） ----------
   * 真机目录行（mooc2 / studentstudy）：
   *   已完成   <span class="icon_Completed prevTips"><span class="prevHoverTips">已完成</span></span>
   *   没完成   <input type="hidden" class="jobUnfinishCount" value="N">
   *            <span class="catalog_points_yi prevTips"><span class="orangeNew">N</span></span>
   *   未解锁   <span class="catalog_points_sa prevTips">…需完成之前闯关任务点…</span>（name 没有 onclick）
   * 口径（用户定）：黄色一律算「没完成」，圈里是 0 也照样点进去；
   * 没有任何图标的行同样算可点候选（老版 .posCatalog_level a、目录还没渲染完）。
   * 进去之后是空页 / 有视频 / 任务点已完成，交给 evaluatePage() 那套判断，这里不做特判。 */
  const TOC_DONE_SEL = '.icon_Completed';
  const TOC_TODO_SEL = '.catalog_points_yi';
  const TOC_LOCK_SEL = '.catalog_points_sa';
  const TOC_LOCK_RE = /需完成之前|闯关任务点|未解锁|解锁后|未开放/;
  const TOC_DONE_RE = /已完成|已学完/;
  const TOC_TODO_RE = /待完成|未完成|进行中/;

  function tocRowOf(el) {
    try { return (el.closest && el.closest('.posCatalog_select, .posCatalog_level, li')) || el.parentElement || el; } catch (e) { return el; }
  }
  /* 行 id 是 cur<knowledgeId>：未解锁项没有 onclick，id 只能从这里读 */
  function tocRowChapterId(row) {
    try {
      const m = String((row && row.id) || '').match(/^cur(\d{3,})/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  /* 除章节名以外的提示文字 + 标记图标背景图（class 认不出时的兜底证据） */
  function tocMarkerHint(row, nameEl) {
    let hint = '';
    try {
      const kids = row.children;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k === nameEl || (k.classList && k.classList.contains('posCatalog_name'))) continue;
        hint += ' ' + String(k.textContent || '') + ' ' + String((k.getAttribute && k.getAttribute('title')) || '');
      }
      const marks = row.querySelectorAll(TOC_DONE_SEL + ',' + TOC_TODO_SEL + ',' + TOC_LOCK_SEL);
      for (let j = 0; j < marks.length; j++) {
        try {
          const bgi = String(getComputedStyle(marks[j]).backgroundImage || '');
          if (bgi) hint += ' ' + bgi;
        } catch (e) {}
      }
    } catch (e) {}
    return CX.oneLine(hint).slice(0, 300);
  }
  function tocRowState(nameEl) {
    const row = tocRowOf(nameEl);
    if (!row) return 'unknown';
    try {
      if (row.querySelector(TOC_LOCK_SEL)) return 'locked';
      if (row.querySelector(TOC_DONE_SEL)) return 'done';
      if (row.querySelector(TOC_TODO_SEL)) return 'todo';   /* 黄色：不看数字，0 也算没完成 */
      const unf = row.querySelector('.jobUnfinishCount');
      if (unf && String(unf.value || '') !== '0') return 'todo';
    } catch (e) {}
    /* 兜底：站点换了 class 就看提示文字 / 图标背景图；再认不出就是 unknown（照点，等于旧行为） */
    const hint = tocMarkerHint(row, nameEl);
    if (TOC_LOCK_RE.test(hint)) return 'locked';
    if (/chapter_wancheng/i.test(hint)) return 'done';
    if (TOC_DONE_RE.test(hint)) return 'done';
    if (TOC_TODO_RE.test(hint) || /chapter_icons/.test(hint)) return 'todo';
    return 'unknown';
  }
  function tocKeyOf(el) {
    try {
      const id = tocChapterId(el) || tocRowChapterId(tocRowOf(el));
      if (id) return id;
      const row = tocRowOf(el);
      return CX.oneLine((row && row.innerText) || '').replace(/^\d+(?:\.\d+)*\s*/, '').slice(0, 30);
    } catch (e) { return ''; }
  }

  /* 定位「当前章节」在目录里的下标：章节 id → 页面文本 → 选中态（沿用原来的三段启发式） */
  function locateTocIndex(items, d, curId) {
    let idx = -1;
    if (curId) {
      const hits = [];
      items.forEach(function (it, i) { if (it.id === curId) hits.push(i); });
      /* 多个同名命中时，优先「行上带状态类」的那条（当前章节通常有额外 class） */
      if (hits.length) {
        idx = hits.find(function (i) {
          const row = items[i].el.closest('.posCatalog_select');
          return row && /posCatalog_(click|active|cur|current)/i.test(String(row.className || ''));
        });
        if (idx === undefined || idx < 0) idx = hits[0];
      }
    }
    if (idx < 0) {
      /* 2026-10-28 修复：原来这一步用的是 document.title（顶层标题是"学生学习页面"），
       * 永远匹配不上章节名 → 目录定位失败 → 整章切不走（用户实测"可以往下走但不动"）。
       * 改成用**页面可见文本**匹配目录条目标题。 */
      let pageText = '';
      try { pageText = CX.oneLine(CX.pageText(d.body)).slice(0, 800); } catch (e) { pageText = ''; }
      if (pageText) {
        idx = items.findIndex(function (it) {
          const name = it.text.replace(/^\d+(?:\.\d+)*\s*/, '').trim();
          return name.length >= 3 && pageText.indexOf(name) >= 0;
        });
      }
    }
    if (idx < 0) {
      /* 再兜底：目录里被标成"当前"的那一条（选中态 class 或 follow 标记） */
      idx = items.findIndex(function (it) {
        const row = (it.el.closest && it.el.closest('.posCatalog_select, li, a')) || it.el.parentElement;
        const cls = String((it.el.className || '') + ' ' + ((row && row.className) || ''));
        return /posCatalog_(click|active|cur|current)|\bcur\b|\bactive\b|\bselected\b/i.test(cls);
      });
    }
    return idx;
  }

  /* 目录计划：
   *   { el, target:{text,id,state,key}, skipped:[{text,state}], hasAfter, blockedAll }
   * 从当前项往后，跳过「已完成 / 未解锁 / 上次点了没切成」，第一个黄色或没有标记的就是目标。
   * 注意：站点只在「已访问过」的条目上带知识点 id，未访问的 onclick 里 id 是空的，
   * 所以绝对不能要求目标必须有 id，否则会跳过整段直接窜到很后面（曾跳到 2.1.1）。 */
  function scanToc() {
    const curId = currentChapterId();
    const skipLocked = navCfg().skipLockedToc !== false;
    const docs = CX.walkAccessibleParents().map(function (w) {
      try { return w.document; } catch (e) { return null; }
    }).filter(Boolean);

    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      /* 目录面板收起时条目是不可见的，所以不能按可见性过滤 */
      const names = CX.qsa('.posCatalog_name, .posCatalog_level a', d);
      if (names.length < 2) continue;

      const items = names.map(function (el) {
        const t = CX.oneLine(el.innerText || '');
        const nm = t.match(/^(\d+(?:\.\d+)*)/);
        return { el: el, text: t, num: nm ? nm[1] : '', id: tocChapterId(el) || tocRowChapterId(tocRowOf(el)) };
      });

      const idx = locateTocIndex(items, d, curId);
      if (idx < 0) continue;

      const after = items.slice(idx + 1);
      if (!after.length) {
        return { el: null, hasAfter: false, blockedAll: false, skipped: [], items: items.length, idx: idx };
      }
      /* 开关关掉 → 完全回到旧行为：直接取下一项 */
      if (!skipLocked) {
        return { el: after[0].el, target: { text: after[0].text, id: after[0].id, state: 'first', key: tocKeyOf(after[0].el) }, skipped: [], hasAfter: true, blockedAll: false, items: items.length, idx: idx };
      }

      const skipped = [];
      for (let k = 0; k < after.length; k++) {
        const it = after[k];
        const key = it.id || it.text.replace(/^\d+(?:\.\d+)*\s*/, '');
        if (st.failedToc[key]) { skipped.push({ text: it.text, state: 'failed' }); continue; }
        const state = tocRowState(it.el);
        if (state === 'done' || state === 'locked') { skipped.push({ text: it.text, state: state }); continue; }
        return { el: it.el, target: { text: it.text, id: it.id, state: state, key: key }, skipped: skipped, hasAfter: true, blockedAll: false, items: items.length, idx: idx };
      }
      return { el: null, hasAfter: true, blockedAll: true, skipped: skipped, items: items.length, idx: idx };
    }
    return null;
  }

  /* 扫描结果缓存 900ms：evaluatePage 每秒跑一次，真机目录 240+ 行，别每次都重算 */
  let tocPlanAt = 0;
  let tocPlanKey = '';
  let tocPlanVal = null;
  function tocPlan(force) {
    const now = Date.now();
    const key = currentChapterId() + '|' + Object.keys(st.failedToc || {}).join(',');
    if (!force && tocPlanVal && now - tocPlanAt < 900 && tocPlanKey === key) return tocPlanVal;
    const plan = scanToc();
    tocPlanAt = now;
    tocPlanKey = key;
    tocPlanVal = plan;
    st.tocPlan = plan;
    return plan;
  }
  function resetTocPlan() {
    tocPlanAt = 0; tocPlanKey = ''; tocPlanVal = null;
  }

  /* 目标变了才打一条：跳过了多少项、多少是锁 / 完成 / 上次没切成 */
  function noteTocPlan(plan) {
    if (!plan || !plan.target) return;
    const key = plan.target.key || plan.target.text || '';
    if (key && st.lastTocLogKey === key) return;
    st.lastTocLogKey = key;
    if (!plan.skipped || !plan.skipped.length) {
      CX.debug('目录目标：' + String(plan.target.text || '').slice(0, 24));
      return;
    }
    const n = { locked: 0, done: 0, failed: 0 };
    plan.skipped.forEach(function (s) { if (n[s.state] !== undefined) n[s.state]++; });
    const msg = '目录：跳过 ' + plan.skipped.length + ' 项（未解锁 ' + n.locked + ' / 已完成 ' + n.done +
      (n.failed ? ' / 上次没切成 ' + n.failed : '') + '）→ ' + String(plan.target.text || '').slice(0, 24);
    CX.info(msg);
    /* 真机调参用：把前几项的判定原文放进 debug，30 秒最多一条 */
    const now = Date.now();
    if (!st.lastTocDbgAt || now - st.lastTocDbgAt > 30000) {
      st.lastTocDbgAt = now;
      CX.debug('目录判定明细：' + JSON.stringify(plan.skipped.slice(0, 10).map(function (s) {
        return String(s.text || '').slice(0, 14) + ':' + s.state;
      })) + ' → ' + String(plan.target.text || '').slice(0, 14) + ':' + plan.target.state);
    }
  }

  /* 后面只剩「已完成 / 未解锁」→ 确认一段时间后停手（不触发 90 秒自动恢复） */
  function maybeStopNoTocTarget(where) {
    const plan = st.tocPlan;
    if (!plan || !plan.blockedAll) return false;
    if (navCfg().stopAtCourseEnd === false) {
      if (!st.noTargetNoted) {
        st.noTargetNoted = true;
        CX.warn('目录后面只剩已完成 / 未解锁的章节，但「课程末尾自动停止」关着 → 原地等待（' + where + '）');
      }
      return false;
    }
    const grace = Math.max(2000, Math.min(Number(navCfg().endConfirmMs || 12000), 15000));
    if (!st.noTargetSince) {
      st.noTargetSince = Date.now();
      CX.info('目录后面只剩「已完成」/「未解锁」的章节 → 等 ' + Math.round(grace / 1000) + ' 秒确认是否停止');
      return false;
    }
    if (Date.now() - st.noTargetSince < grace) return false;
    st.stopped = true;
    st.stoppedAt = 0;                 /* 刻意不自动恢复：用户要的是「没有就停」 */
    st.stopReason = 'no-target';
    CX.warn('后面没有可继续的章节（已完成或未解锁）→ 停止自动切章（' + where + '）');
    CX.status('🎉 后面没有可做的章节了，已停止', { busy: false, phase: 'nav' });
    return true;
  }

  /* 点了没切成 → 记下来，下次换后面的候选 */
  function markTocFailed(el) {
    const k = tocKeyOf(el);
    if (!k) return;
    st.failedToc[k] = Date.now();
    resetTocPlan();
    CX.info('这个目录项点不动（章节 id 没变），下次换后面的候选：' + String(k).slice(0, 24));
  }

  /* 目录面板默认收起时先点一下「目录」标签展开 */
  function openTocPanel() {
    if (st.tocOpenedAt && Date.now() - st.tocOpenedAt < 15000) return false;
    st.tocOpenedAt = Date.now();
    const tab = CX.qa('#tit1') ||
      CX.findByText(['目录'], document, { maxLen: 4, exact: true }) ||
      CX.qa('li[onclick*="changePan"], .prev_tab li');
    if (tab) {
      CX.info('目录面板未展开，先点开「目录」');
      CX.click(tab);
      return true;
    }
    return false;
  }

  function findNextTocEntry() {
    let plan = tocPlan();
    if (plan && plan.el) {
      st.noTargetSince = 0;
      st.noTargetNoted = false;
      noteTocPlan(plan);
      return plan.el;
    }
    if (openTocPanel()) {
      /* 面板通常同步展开，直接再扫一次 */
      resetTocPlan();
      plan = tocPlan(true);
      if (plan && plan.el) {
        st.noTargetSince = 0;
        st.noTargetNoted = false;
        noteTocPlan(plan);
        return plan.el;
      }
    }
    return null;
  }

  /* 2026-10-31：非学习页（个人空间/消息/登录页）不跑任何导航逻辑 */
  function offStudyPage() {
    try { return !!(CX.isStudyContext && !CX.isStudyContext()); } catch (e) { return false; }
  }
  async function clickNext(reason) {
    if (offStudyPage()) { CX.debug('非学习页（' + CX.pageKind + '），跳过跳转'); return; }
    /* 冷却自愈：等够 90 秒就无条件恢复。
     * 2026-10-28 修复：原来还要求 reason 命中 video-done/exam-passed/tasks-done，
     * 但 evaluatePage 被 st.stopped 挡住后根本不会再产生这些信号 —— 导致一旦停下就永久不动。 */
    if (st.stopped) {
      if (st.stoppedAt && Date.now() - st.stoppedAt > 90000) {
        st.stopped = false;
        st.stuck = 0;
        st.claimRetries = 0;
        CX.info('跳转冷却结束（90 秒），恢复自动切章');
      } else {
        return;
      }
    }
    if (st.busy) return;
    if (navCfg().autoNext === false) return;
    if (!CX.cfg.enabled) return;

    /* 每次新的触发都重置重试次数，避免「点了三次之后永久放弃」 */
    if (Date.now() - st.lastEntryAt > 4000) st.claimRetries = 0;
    st.lastEntryAt = Date.now();


    if (noteDialogInAnyDoc()) {
      /* 弹窗遮罩会吞掉所有点击：先静默关掉，关不掉才提示 */
      if (closeNoteDialogQuiet()) {
        await CX.sleep(400);
      } else {
        warnNoteDialogBlocking();
        return;
      }
    }

    const btn = findNextButton();
    /* 别的 frame 报来的「视频完成」必须复查：多视频章节里单个视频结束也会发 video-done，
     * 不复查就会带着没看的视频跳下一节（实测一节 3 个视频，播完 1 个就跳）。 */
    let taskDone = videoDone();
    if (!taskDone && /video-done|tasks-done/.test(String(reason || ''))) {
      const prog = (CX.player && CX.player.videoProgress) ? CX.player.videoProgress() : null;
      taskDone = !prog || prog.total === 0 || prog.all;
    }
    if (!taskDone) {
      /* 多视频章节：把进度显式说出来，否则只能看到"不跳转"却不知道为什么 */
      const pr = (CX.player && CX.player.videoProgress) ? CX.player.videoProgress() : null;
      if (pr && pr.total > 1 && pr.done !== lastProgDone) {
        lastProgDone = pr.done;
        CX.info('本节视频任务点 ' + pr.done + '/' + pr.total + ' 已完成，全部完成后才跳转');
        CX.status('本节视频 ' + pr.done + '/' + pr.total + '，继续播放中', { busy: true, phase: 'play' });
      }
    }
    if (!taskDone && /quiz-done/.test(String(reason || ''))) taskDone = true;

    /* 本节测验已放弃 → 不点入口，直接走下面的切章逻辑 */
    if (taskDone && examGaveUpHere() && !st.quizGaveUpNoted) {
      st.quizGaveUpNoted = true;
      CX.info('本节测验已放弃 → 直接切下一章');
    }

    /* 任务点完成后优先去「学习测验」（不再直接点下一节）。
     * 2026-11-06：`reason !== 'exam-giveup'` 是硬闸 —— examGaveUpHere() 依赖
     * currentChapterId()，顶层读不到章节 id 时会假阴性，那样就会又点进测验入口，
     * 形成「12 轮 → 放弃 → 又进去 → 又 12 轮」的闭环，比原来更糟。 */
    if (taskDone && reason !== 'exam-giveup' && !examGaveUpHere() && !quizEntryCooldown()) {
      const quizEntry = findQuizTaskEntry();
      if (quizEntry) {
        const claim = await send({ kind: 'nav', action: 'claim', reason: 'quiz-entry', done: true });
        if (claim && claim.ok) {
          st.quizTaskClicked = location.href;
          /* 同上：这里原来还有 quizClickGuard()，与 8 秒冷却冲突 → 已去掉 */
          const label = entryLabel(quizEntry);
          CX.info('任务点已完成，先去「' + label + '」');
          CX.status('进入学习测验…', { busy: true, phase: 'exam' });
          clickEntry(quizEntry);
          await CX.sleep(1500);
          return;
        }
        CX.debug('测验入口点击权被占用，稍后再试');
        return;
      }
      logQuizEntryDebug();
    }

    /* 2026-10-28 修复：目录模式（tocOnly，默认开）不依赖「下一节」按钮，
     * 以前这里先判 btn 不存在就 return，导致「目录里有下一章、页面上却没有
     * #prevNextFocusNext」的章节永远不翻页。现在只有明确关掉目录模式时才要求 btn。 */
    if (!btn && navCfg().tocOnly === false) {
      maybeStopAtCourseEnd('no-btn');
      return;
    }

    st.busy = true;
    try {
      /* 1) 优先走目录：点右侧目录里的下一章（站点的「下一节」容易被弹窗卡住） */
      const toc = findNextTocEntry();
      const curIdBefore = currentChapterId();
      if (toc || btn) st.noNextSince = 0;   /* 又找到下一章了 → 末尾确认计时作废 */
      /* 2026-11-03：目录后面只剩「已完成 / 未解锁」→ 确认后停止，别再拿「下一节」按钮硬试 */
      if (!toc && maybeStopNoTocTarget('click-next')) return;
      if (toc && navCfg().useToc !== false) {
        const claim = await send({ kind: 'nav', action: 'claim', reason: 'toc', done: videoDone() });
        if (claim && claim.ok) {
          const label = CX.oneLine(toc.innerText).slice(0, 26);
          CX.info('通过目录切换到下一章：' + label);
          CX.status('切换到下一章…（' + label + '）', { busy: true, phase: 'nav' });
          st.sig = signature();
          /* 目录项是 <span class="posCatalog_name" onclick="getTeacherAjax('课','班','章节id')">，
           * 内联 onclick 在站点 CSP（无 'unsafe-inline'）下一律失效，CX.click 只会换来
           * 一条 CSP 违规日志、章节 id 不变。所以解析出函数名和参数，交给主世界直接调。 */
          const oc = String(toc.getAttribute('onclick') || '');
          const mo = oc.match(/^\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
          let switched = false;
          if (mo) {
            const fn = mo[1];
            const args = mo[2].split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); });
            const mr = CX.mainCall('call', { fn: fn, args: args });
            if (mr && mr.ok) {
              switched = true;
              CX.debug('目录切换走主世界调用：' + fn + '(' + args.join(',') + ')');
            } else {
              CX.warn('目录切换的主世界调用失败：' + ((mr && mr.err) || 'unknown'));
            }
          }
          if (!switched) CX.click(toc);
          st.lastClickAt = Date.now();
          await CX.sleep(2600);
          /* 用「章节 id 是否真的变了」判定成功，而不是靠页面文本 */
          const nowId = currentChapterId();
          if (signature() !== st.sig && nowId && nowId !== curIdBefore) {
            st.stuck = 0;
            st.clicks++;
            CX.status('已通过目录切换到下一章', { busy: true, phase: 'nav' });
            return;
          }
          /* 目录切换失败也要计数：日志实证 14:57 那会儿每 2~4 秒重试一次、连续 10 多次，
           * 每次都在滚页面 + 调站点函数，既吵又费主线程。 */
          st.stuck++;
          markTocFailed(toc);
          CX.warn('点目录后章节 id 没变（站点没接受这次切换，连续 ' + st.stuck + ' 次）');
          if (st.stuck >= 3) {
            st.stopped = true;
            st.stoppedAt = Date.now();
            CX.status('⚠ 章节切换被站点拒绝（可能该章未开放），90 秒后重试', { busy: false, phase: 'nav' });
          }
        } else {
          CX.debug('目录切换的点击权被占用，稍后重试');
          if (claim && claim.waited !== undefined && st.claimRetries < 3) {
            st.claimRetries++;
            const delay = Math.max(600, 2600 - claim.waited);
            setTimeout(function () { if (!st.busy && !st.stopped) clickNext(reason); }, delay);
          }
          return;
        }
      }

      /* 只走目录：找不到目录项就等下一轮，不再去点「下一节」按钮 */
      if (navCfg().tocOnly !== false) {
        /* 2026-11-03：后面只剩已完成/未解锁时，交给 no-target 确认，别混进末尾计时 */
        if (!btn && st.tocPlan && st.tocPlan.blockedAll) return;
        /* 目录里没有下一项：连"下一节"按钮也没有时，按末尾流程确认（12 秒宽限，避免目录还没渲染就误判） */
        if (!btn && maybeStopAtCourseEnd('toc-only')) return;
        CX.debug('目录里没找到下一章，等待下一轮（tocOnly=true）');
        return;
      }

      const wait = Number(navCfg().nextDelayMs || 2500);
      CX.status('准备进入下一节（' + reason + '）', { busy: true, phase: 'nav' });
      await CX.sleep(wait);

      /* 先把站点提示层（任务点未完成 / 今日上限）处理掉，再点跳转 */
      if (isLocked()) {
        CX.warn('下一节处于闯关锁，等待解锁');
        CX.status('等待闯关解锁…', { busy: true, phase: 'nav' });
        await CX.sleep(Number(navCfg().unlockWaitMs || 8000));
      }

      /* 视频任务点已完成时，先去点任务条里的「学习测验」（已在函数开头处理） */

      /* 向后台申请点击权，避免多个 frame 同时点导致跳两节；
       * 任务点未完成且有视频在播时后台会拒绝；任务点已完成则放行 */
      const done = videoDone();
      const claim = await send({ kind: 'nav', action: 'claim', reason: reason, done: done });
      if (!claim || !claim.ok) {
        if (claim && claim.reason === 'video-playing') {
          CX.info('视频仍在播放且任务点未完成，已取消本次跳转');
          return;
        }
        /* 被别的帧占了点击权：稍后自动补一次（最多 3 次） */
        if (claim && claim.waited !== undefined && st.claimRetries < 3) {
          st.claimRetries++;
          const delay = Math.max(700, 2600 - claim.waited);
          CX.debug('点击权被占用，' + delay + 'ms 后重试（第 ' + st.claimRetries + ' 次）');
          setTimeout(function () { if (!st.busy && !st.stopped) clickNext(reason); }, delay);
          return;
        }
        CX.debug('本次点击权被其它 frame 占用');
        return;
      }
      st.claimRetries = 0;

      st.sig = signature();
      CX.info('点击「下一节」 → ' + (btn.innerText || btn.id || ''));
      CX.click(btn);
      st.clicks++;
      st.lastClickAt = Date.now();

      /* 检查是否切换成功 */
      await CX.sleep(3500);
      const after = signature();
      if (after === st.sig) {
        st.stuck++;
        CX.warn('点击后页面未变化（stuck=' + st.stuck + '）');
        /* 连续卡住说明是站点侧拒绝（例如当日时长已达上限 / 笔记流程卡死），
         * 再点也只会反复弹窗，直接停下并提示，避免刷屏 */
        if (st.stuck >= 3) {
          st.stopped = true;
          st.stoppedAt = Date.now();
          CX.warn('站点多次拒绝跳转，暂停自动跳节（90 秒后会再试）');
          CX.status('⚠ 站点拒绝跳转（可能今日时长已达上限），90 秒后重试', { busy: false, phase: 'nav' });
          return;
        }
        if (st.stuck >= (navCfg().maxStuckReloads || 3) && st.reloads < 5) {
          const rc = await send({ kind: 'nav', action: 'claim', reason: 'reload' });
          if (rc && rc.ok) {
            st.reloads++;
            CX.info('页面卡住，刷新重试');
            location.reload();
          }
        }
      } else {
        st.stuck = 0;
        CX.status('已切换到下一节', { busy: true, phase: 'nav' });
      }
    } finally {
      st.busy = false;
    }
  }

  /* ---------- 每 3 秒上报本帧「有没有任务点/视频/题目」 ----------
   * 2026-10-28 移除：后台没有任何地方请求 nav/state，这套按帧 3 秒一次的上报
   * 只写不读（纯开销），而且每帧都在跑。evaluatePage() 自己已经用 anyDoc()
   * 遍历了全部子帧，不依赖这条通道。 */

  /* ---------- 事件来源 ---------- */
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || !msg.__broadcast) return;
      if (msg.kind === 'video_done_bc') {
        /* 交给状态机复核：只有任务点标记完成（A 类）或视频播完（B 类）才跳 */
        CX.info('收到「视频完成」信号，按页面类型复核');
        setTimeout(function () { try { evaluatePage(); } catch (e) {} }, 800);
      } else if (msg.kind === 'exam_passed_bc') {
        /* 只有顶层负责跳章（其它帧收到信号只记一条 debug） */
        if (!CX.isTop) { CX.debug('收到「测验通过」信号（本帧不负责跳转）'); return; }
        CX.info('收到「测验通过」信号，准备跳转');
        setTimeout(function () { clickNext('exam-passed'); }, 1500);
      } else if (msg.kind === 'exam_skipped_bc') {
        /* 2026-11-03：设置里开了「跳过学习检测」→ 进测验页后立刻离开 */
        if (!CX.isTop) { CX.debug('收到「跳过学习检测」信号（本帧不负责跳转）'); return; }
        CX.info('收到「跳过学习检测」信号，准备切下一章');
        setTimeout(function () { clickNext('exam-skipped'); }, 1500);
      } else if (msg.kind === 'exam_giveup_bc') {
        /* 2026-11-06：答满轮数放弃本节 —— 纯测验章节没有"视频播完/测验通过"这类
         * 切章触发，必须由这条信号把 clickNext 叫起来，否则整页停死。
         * 重试 3 次是因为 st.busy / st.stopped 可能在信号到达时正好为真（那会静默 return），
         * 而消息只发一次；每次重试前确认章节没变，避免连点跳过头。 */
        if (!CX.isTop) { CX.debug('收到「测验放弃」信号（本帧不负责跳转）'); return; }
        let tries = 0;
        const startCid = currentChapterId();
        const tick = function () {
          if (!CX.cfg.enabled || navCfg().autoNext === false) return;
          if (startCid && currentChapterId() && currentChapterId() !== startCid) {
            CX.info('章节已切换（' + startCid + ' → ' + currentChapterId() + '），放弃信号不再重试');
            return;
          }
          if (examGaveUpHere() && st.stopped) {
            st.stopped = false;
            st.stoppedAt = 0;
            CX.info('本章测验已放弃，清掉跳转冷却，直接切下一章');
          }
          clickNext('exam-giveup');
          if (++tries < 3) setTimeout(tick, 6000);
        };
        CX.info('收到「本节测验已放弃」信号，准备切下一章');
        setTimeout(tick, 1500);
      }
    });
  } catch (e) {}

  /* ---------- 站点自己的「任务点未完成」提示 ---------- */
  let modalHandledAt = 0;
  function handleUnfinishedModal() {
    if (!CX.cfg.enabled) return;
    if (Date.now() - modalHandledAt < 8000) return;
    const t = CX.oneLine(document.body ? document.body.innerText : '').slice(0, 500);
    if (!/当前章节还有任务点未完成|是否去完成|还有任务点未完成/.test(t)) return;
    const go = CX.findByText(['去学习'], document, { maxLen: 8 });
    if (!go) return;
    modalHandledAt = Date.now();
    CX.info('检测到「任务点未完成」提示，点击「去学习」');
    CX.click(go);
  }
  setInterval(function () { if (!offStudyPage()) handleUnfinishedModal(); }, 2000);

  /* ---------- 今日额度已满：视频任务点永远无法完成 ----------
   * 站点会常驻提示「今日视频任务点完成数已达上限…无法完成任务点」，
   * 这种情况下继续等只会卡死，直接判为不可完成并跳过本节。 */
  function quotaExhausted() {
    const docs = CX.walkAccessibleParents().map(function (w) {
      try { return w.document; } catch (e) { return null; }
    }).filter(Boolean);
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const t = CX.oneLine(d.body ? d.body.innerText : '').slice(0, 1500);
      if (/今日视频任务点完成数已达上限|今日视频观看时长已达上限|无法完成任务点/.test(t)) return true;
    }
    return false;
  }

  /* ================= 页面类型状态机（按你定的规矩） =================
   * A 有任务点 + 有视频：等任务点标记完成 → 有测验先做测验 → 再切章
   * B 无任务点 + 有视频：等视频播完 → 切章
   * C 都没有：空页面 → 直接切章
   * D 有任务点 + 无视频（文档/作业类）：等任务点全部完成 → 切章
   */
  function anyDoc() {
    const out = [document];
    CX.walkAccessibleParents().forEach(function (w) {
      try { if (w.document && out.indexOf(w.document) < 0) out.push(w.document); } catch (e) {}
    });
    const walk = function (win) {
      let list = [];
      try { list = Array.prototype.slice.call(win.frames); } catch (e) {}
      list.forEach(function (f) {
        let d = null;
        try { d = f.document; } catch (e) { return; }
        if (d && out.indexOf(d) < 0) { out.push(d); walk(f); }
      });
    };
    try { walk(self); } catch (e) {}
    return out;
  }

  function hasTaskAnywhere() {
    return anyDoc().some(function (d) {
      return !!d.querySelector('.ans-job-video, [class*="ans-job-icon"], [aria-label*="任务点"]');
    });
  }

  function hasVideoAnywhere() {
    return anyDoc().some(function (d) {
      if (d.querySelector('video')) return true;
      return !!d.querySelector('.ans-job-video');
    });
  }

  function videoEndedAnywhere() {
    return anyDoc().some(function (d) {
      const v = d.querySelector('video');
      return !!(v && v.ended);
    });
  }

  function anyUnfinishedAnywhere() {
    return anyDoc().some(function (d) {
      const list = d.querySelectorAll('[aria-label*="任务点"]');
      for (let i = 0; i < list.length; i++) {
        if ((list[i].getAttribute('aria-label') || '').indexOf('未完成') >= 0) return true;
      }
      return false;
    });
  }

  /* 任务条上的测验入口词表 */
  const QUIZ_ENTRY_WORDS = ['学习测验', '章节测验', '学习检测', '单元测验', '课后测验'];

  /* 任务条项是否已标记完成：aria 标注 / class 带 finished-done-complete / 容器内有 ✓ 图标。
   * 只有明确"已完成"的证据才算，判不出来就当未完成（宁可多点一次测验，也不能卡住不跳章）。
   * 2026-10-30：标记常常不在带文字的这层，而在里层任务点图标或外层 .ans-attach-ct 上，
   * 这里一并认（用户实测「明明有完成标记却当未完成」）。 */
  function entryLooksDone(el) {
    if (!el) return false;
    const aria = el.getAttribute('aria-label') || '';
    if (aria.indexOf('已完成') >= 0) return true;
    if (aria.indexOf('未完成') >= 0) return false;
    const box = (el.closest && el.closest('.prev_white, .prev_list li, .prevItem, [class*="ans-job"]')) || el;
    /* 只认明确的完成态 class（不写裸 complete，也不看里面的图标 ——
     * 任务条项里的图标不代表已完成，2026-10-28 实测会误判）。 */
    const cls = String((el.className || '') + ' ' + (box.className || ''));
    if (/job-finished|prev_white_ok|is-done|isDone|\bfinished\b|\bcompleted\b/i.test(cls)) return true;
    /* 里层任务点图标的 aria：<span class="ans-job-icon" aria-label="任务点已完成"> */
    try {
      const ic = el.querySelector && el.querySelector('[aria-label*="已完成"]');
      if (ic) {
        const a2 = ic.getAttribute('aria-label') || '';
        if (a2.indexOf('未完成') < 0) return true;
      }
    } catch (e) {}
    /* 外层任务点容器已完成 */
    try {
      const ct = el.closest && el.closest('.ans-attach-ct');
      if (ct && /ans-job-finished/.test(String(ct.className || ''))) return true;
    } catch (e) {}
    return false;
  }

  /* 当前是不是「已批阅 / 已完成」的测验视图。
   * 只认每题的对错图标和「查看作答记录」—— 2026-10-28 去掉「本次成绩」：
   * 上一份卷子的成绩会残留在同一页里，用它判断会把"还没做的新测验"也当成已完成。 */
  function alreadyReviewedView() {
    /* 先确认当前确实是题目页（可见题目容器）。视频页里预载的测验模板不算。 */
    if (!(CX.parser && CX.parser.looksLikeExamPage && CX.parser.looksLikeExamPage())) return false;
    const docs = anyDoc();
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      try { if (d.querySelector('.marking_dui, .marking_cuo, .CorrectOrNot')) return true; } catch (e) {}
      try {
        if (CX.findByText(['查看作答记录'], d, { maxLen: 10 })) return true;
      } catch (e) {}
    }
    return false;
  }

  /* 找不到测验入口时把任务条实际内容打出来（debug 级别），便于下次直接看出是哪一项 */
  function logQuizEntryDebug() {    try {
      const nowD = Date.now();
      if (nowD - (st.lastQuizDbgAt || 0) < 10000) return;   /* 原来每秒一条太吵，10 秒一条够定位 */
      st.lastQuizDbgAt = nowD;
      const out = [];
      anyDoc().forEach(function (d) {
        CX.qsa('.prev_white, .prev_list li, .prevItem', d).forEach(function (el) {
          const t = CX.oneLine(String(el.textContent || '')).slice(0, 14);
          if (!t) return;
          const aria = el.getAttribute('aria-label') || '';
          out.push(t + (entryLooksDone(el) ? '(判为已完成)' : '') + (aria ? '[aria=' + aria.slice(0, 10) + ']' : ''));
        });
      });
      CX.debug('没找到未完成的测验入口；任务条项：' + JSON.stringify(out.slice(0, 10)));
    } catch (e) {}
  }

  /* 任务条上还有「未完成的学习测验」吗（跨全部文档、含子帧）。
   * 2026-10-28 第二轮：判据换成 entryLooksDone（aria / 完成态 class / ✓ 图标），
   * 不再是"没有 aria 就当未完成"——上一版就是因为这个把已完成的页当成未完成、永不跳章。 */
  let pendingQuizSince = 0;
  function pendingQuizAnywhere() {
    /* 2026-11-04：不处理测验 / 跳过模式 → 不存在「在等它打开」这回事 */
    if (!examEnabled() || examSkipOn()) return false;
    return anyDoc().some(function (d) {
      let items = [];
      try { items = d.querySelectorAll('.prev_white, .prev_list li, .prevItem'); } catch (e) { return false; }
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const t = CX.oneLine(String(el.textContent || '')).slice(0, 40);
        if (!isQuizTaskText(t)) continue;
        if (entryLooksDone(el)) continue;
        return true;
      }
      return false;
    });
  }

  /* 站点自己写的完成文案（「任务点已完成」）—— 任务点元素藏在跨域 iframe 里时，
   * 这是顶层唯一能看到的证据。3 秒缓存，避免每秒读 body。 */
  let tpTextAt = 0;
  let tpTextVal = false;
  function taskPointTextDone() {
    const now = Date.now();
    if (now - tpTextAt < 3000) return tpTextVal;
    tpTextAt = now;
    let t = '';
    try { t = CX.oneLine(CX.pageText(document.body)).slice(0, 1500); } catch (e) { t = ''; }
    tpTextVal = !/任务点未完成|还有任务点/.test(t) && /任务点已完成|任务点全部完成/.test(t);
    return tpTextVal;
  }

  /* 任意帧里是否存在任务点元素（区分"看不见元素"和"元素明确说没完成"） */
  function hasTaskElsAnywhere() {
    return anyDoc().some(function (d) {
      try { return !!d.querySelector('.ans-job-video, .ans-attach-ct'); } catch (e) { return false; }
    });
  }

  /* 跳章前的闸门：还有没做完的测验入口就先别跳。
   * 为什么要放在"切章前"而不是只靠"找到入口就点"：点击之后还有页面加载的时间，
   * 而同一个帧的 st.quizTaskClicked 已经把这个 href 记住了 → 下一轮就不会再点、直接切章。
   * 实测就是"点了学习测验，同一秒又把章节切走了"。最多等 30 秒，防止入口本身点不动时卡死。 */
  function holdForPendingQuiz(where) {
    /* 本节测验已经放弃 / 按设置跳过 → 那个入口永远是"未完成"，别再白等 12 秒（这就是 03:46:27 那条日志的来历） */
    if (examGaveUpHere() || examSkipOn()) { pendingQuizSince = 0; return false; }
    if (!pendingQuizAnywhere()) { pendingQuizSince = 0; return false; }
    if (!pendingQuizSince) {
      pendingQuizSince = Date.now();
      CX.info('任务条上还有未完成的测验入口，先不切章（等它打开）');
      return true;
    }
    if (Date.now() - pendingQuizSince < 12000) return true;
    CX.warn('等测验入口超过 12 秒仍未打开，继续切章（' + where + '）');
    pendingQuizSince = 0;
    return false;
  }

  /* 任务点是否已完成：只看站点标记（aria 已完成 / .task-condition 被隐藏 / 父容器 ans-job-finished） */
  function taskDoneAnywhere() {
    if (anyUnfinishedAnywhere()) return false;
    const docs = anyDoc();
    let sawTask = false;
    /* 2026-10-28 修正：原来是 `some()` —— 只要**某一个**文档里的任务点全完成就返回 true，
     * 哪怕别的帧里还有没看完的视频。视频页有多个 iframe 时这会把整章当"已完成"直接跳走。
     * 现在要求**所有文档的所有任务点**都完成（every），并且至少见到过一个任务点。 */
    const allDone = docs.every(function (d) {
      const vs = d.querySelectorAll('.ans-job-video');
      if (vs.length) {
        sawTask = true;
        for (let i = 0; i < vs.length; i++) {
          if (!videoTaskDone(vs[i])) return false;
        }
        return true;
      }
      const cts = d.querySelectorAll('.ans-attach-ct');
      for (let i = 0; i < cts.length; i++) {
        const cls = String(cts[i].className || '');
        if (!/ans-job/.test(cls)) continue;
        sawTask = true;
        if (!/ans-job-finished/.test(cls)) return false;
      }
      return true;
    });
    return sawTask && allDone;
  }

  /* 单个视频任务点是否完成：只认 aria 标注和容器 ans-job-finished。
   * 不再用 `.task-condition` 是否 display:none 判断 —— 那个元素经常天生就是隐藏的，
   * 会把没看完的视频判成已完成（"所有视频都直接跳"的另一个来源）。 */
  function videoTaskDone(el) {
    const a = el.getAttribute('aria-label') || '';
    if (a.indexOf('已完成') >= 0) return true;
    if (a.indexOf('未完成') >= 0) return false;
    const ct = (el.closest && el.closest('.ans-attach-ct')) || el.parentElement;
    return !!(ct && /ans-job-finished/.test(String(ct.className || '')));
  }

  function detectPageType() {
    const hasTask = hasTaskAnywhere();
    const hasVideo = hasVideoAnywhere();
    if (hasTask && hasVideo) return 'task+video';
    if (!hasTask && hasVideo) return 'video-only';
    if (!hasTask && !hasVideo) return 'empty';
    return 'task-only';
  }

  /* ---------- 文档 / 图片任务：无视频、无题目、可滚动 → 缓慢上下滚动 ----------
   * 站点靠"看过了"来点亮这类任务点（父容器加 ans-job-finished），没有播放器可等。
   * 用户实测：手动上下滑一会儿就会出现完成标记。这里按同样节奏自动滑。
   * 注意文档阅读器常在跨域 iframe（pan-yz.chaoxing.com）里，读不到父级，
   * 所以每个 frame 自己判断"我可滚 + 无视频 + 无题目"就自己滑，不依赖父级状态。 */
  let docScanTimer = null;
  let docScanRound = 0;
  let docScrollCount = 0;          /* 本轮已滚动次数（每 5 次插一次长停顿）。2026-10-28 修复：此前漏了这行声明，
                                    * 严格模式下 docScanLoop 会抛 ReferenceError，导致文档/图片任务点永远不滚。 */
  let docScanPausedUntil = 0;

  function docScanEligible() {
    try {
      if (document.querySelector('video')) return false;
      if (CX.parser && CX.parser.looksLikeExamPage && CX.parser.looksLikeExamPage()) return false;
      if (CX.parser && CX.parser.findVideoQuizBox && CX.parser.findVideoQuizBox()) return false;

      /* 关键：只让真正的文档容器滚。
       * 顶层壳（studentstudy）只是容器，题目/视频都在它的 iframe 里，
       * 它自己永远满足"无视频 + 无题目 + 可滚动"—— 让它在测验页滚，
       * 不但没用，还会把正在答题的页面滚得乱跳。 */
      const href = String(location.href || '');
      const isDocReader = /pan-yz\.chaoxing\.com|\/screen\/v2\/|\/screen\//i.test(href);
      const isCards = /\/knowledge\/cards/i.test(href);
      const iframeCount = document.querySelectorAll('iframe').length;
      /* 文档阅读器本身，或"内容帧且内容没有被塞进子 iframe" */
      if (!isDocReader && !(isCards && iframeCount === 0)) return false;

      const de = document.documentElement;
      if (!de) return false;
      const sh = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
      const ch = de.clientHeight || root.innerHeight || 0;
      return sh > ch * 1.6 && sh > 1200;
    } catch (e) { return false; }
  }

  function docScrollOnce() {
    const de = document.documentElement;
    const ch = de.clientHeight || root.innerHeight || 600;
    const max = de.scrollHeight - ch;
    const cur = root.scrollY || de.scrollTop || 0;
    /* 每次只滚 1/5 ~ 1/3 屏：滚太快像"跳页"，不像在读 */
    const ratio = 0.2 + Math.random() * 0.13;
    const step = Math.max(90, Math.round(ch * ratio));
    if (cur + step >= max - 6) {
      docScanRound++;
      CX.debug('文档任务：滚到底（第 ' + docScanRound + ' 轮）');
      try { root.scrollTo({ top: max, behavior: 'smooth' }); } catch (e) { try { root.scrollTo(0, max); } catch (e2) {} }
      return 'bottom';
    }
    try { root.scrollTo({ top: cur + step, behavior: 'smooth' }); } catch (e) { root.scrollTo(0, cur + step); }
    return 'continue';
  }

  function stopDocScan() {
    if (docScanTimer) { clearTimeout(docScanTimer); docScanTimer = null; }
  }

  /* 递归 setTimeout 而不是 setInterval：每次间隔都能随机，节奏才像人在看。
   * 节奏：普通一屏 1/5~1/3，间隔 1.5~3.2s；每 5 次插一次 3.8~7.3s 的长停顿；
   * 滚到底先停 1.6~3.8s，再平滑回顶。 */
  function docScanLoop() {
    docScanTimer = null;
    try {
      if (!CX.cfg.enabled || !docScanEligible()) return;
      const t = docScrollOnce();
      let delay;
      if (t === 'bottom') {
        docScanRound++;
        if (docScanRound >= 3) {
          docScanRound = 0;
          docScrollCount = 0;
          docScanPausedUntil = Date.now() + 30000;
          CX.info('文档任务：已上下滚动 3 轮，暂停 30 秒后再试（若任务点已完成会自动切章）');
          return;
        }
        delay = 1600 + Math.random() * 2200;          // 到底后停留
        const backAt = Math.round(delay * 0.6);
        setTimeout(function () {
          try { root.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { try { root.scrollTo(0, 0); } catch (e2) {} }
        }, backAt);
        delay += 1400;                                 // 回顶后再等一会儿才开始往下
      } else {
        docScrollCount++;
        const longPause = docScrollCount > 0 && docScrollCount % 5 === 0;
        delay = longPause ? (3800 + Math.random() * 3500) : (1500 + Math.random() * 1700);
        if (longPause) CX.debug('文档任务：停顿一下再看（第 ' + docScrollCount + ' 次滚动）');
      }
      docScanTimer = setTimeout(docScanLoop, Math.round(delay));
    } catch (e) {
      docScanTimer = setTimeout(docScanLoop, 2000);
    }
  }

  function startDocScan() {
    if (docScanTimer) return;
    if (Date.now() < docScanPausedUntil) return;
    if (!docScanEligible()) return;
    CX.info('检测到文档/图片任务（无视频、无题目），开始缓慢上下滚动查看');
    docScrollCount = 0;
    docScanRound = 0;
    docScanTimer = setTimeout(docScanLoop, 800 + Math.random() * 900);
  }

  /* 统一跳转入口：只点目录，且同一时刻只允许一个帧发起 */
  let lastJumpAt = 0;
  function triggerJump(reason) {
    const now = Date.now();
    if (now - lastJumpAt < 2000) return;
    if (st.busy) return;      /* stopped 交给下面 clickNext 里"90 秒自动恢复"处理 */
    try {
      if (root.top.__cxJumpAt && now - root.top.__cxJumpAt < 3000) return;
      root.top.__cxJumpAt = now;
    } catch (e) {}
    const toc = findNextTocEntry();
    if (!toc) {
      /* 2026-11-03：后面只剩已完成 / 未解锁 → 确认后停止（优先于「课程末尾」判定，
       * 否则会先打一条「课程已到末尾」，语义不对） */
      if (maybeStopNoTocTarget('trigger-jump')) return;
      /* 正在 no-target 确认期：别再去跑末尾计时，否则日志会冒出「没有下一节按钮」的假话 */
      if (st.tocPlan && st.tocPlan.blockedAll) return;
      /* 2026-10-31：真机到末尾走的就是这条路（triggerJump 找不到目录项）。
       * 先问一次"是不是课程已经结束"，别只会每 10 秒刷一条 warn。 */
      if (maybeStopAtCourseEnd('trigger-jump', 15000)) return;
      /* 找不到目录项 = 跳不了章。这条以前是 debug，被别的高频日志淹掉了，
       * 结果只看到"可以往下走"却永远不跳。改成 10 秒最多一条 warn。 */
      const now2 = Date.now();
      if (!st.noTocAt || now2 - st.noTocAt > 10000) {
        st.noTocAt = now2;
        CX.warn('（' + reason + '）右侧目录里没找到下一项，无法切章：检查目录是否展开、下一节是否已解锁');
      }
      return;
    }
    st.noNextSince = 0;   /* 又找到目录项了 → 末尾计时作废 */
    st.noTargetSince = 0;
    st.noTargetNoted = false;
    lastJumpAt = now;
    CX.info('（' + reason + '）点目录切章：' + CX.oneLine(toc.innerText).slice(0, 24));
    clickNext(reason);
  }

  /* 每 1 秒按页面类型评估一次 */
  function evaluatePage() {
    /* 注意：这里不能把 st.stopped 写进这个提前返回 —— 否则下面"90 秒自动恢复"永远执行不到，
     * 一旦停下来就永久不动（用户实测："点启动了它不动"）。 */
    if (!CX.cfg.enabled || navCfg().autoNext === false || st.busy) return;

    /* 2026-10-28 架构修正：**跳章只由顶层帧决策**。
     * 实测日志：顶层 + cards + 若干 about:blank 子帧各自 evaluatePage、各自点目录、各自抢点击权
     * （满屏「点击权被占用」），有的帧刚说"先别切"另一个帧已经切走，
     * 甚至因为各帧算出的"当前章节"不同而跳回上一章（2.1.3 → 2.1.2）。
     * 顶层用 anyDoc() 能遍历全部同源子帧，信息最全，所以只留它一个决策者。 */
    let isTopPage = false;
    try { isTopPage = (root === root.top); } catch (e) { isTopPage = CX.isTop; }
    if (!isTopPage) return;
    if (/^about:blank/i.test(location.href) || !location.href || location.href === 'about:blank') return;

    /* 冷却到点就无条件恢复，否则一旦 stopped 就再也没有"新信号"能唤醒它 */
    if (st.stopped) {
      if (st.stoppedAt && Date.now() - st.stoppedAt > 90000) {
        st.stopped = false;
        st.stuck = 0;
        CX.info('跳转冷却结束（90 秒），恢复自动切章');
      } else {
        return;
      }
    }
    if (st.busy) return;
    if (Date.now() - st.loadedAt < 1500) return;

    /* 2026-10-30：切章后的「落地期」。新章节的帧还没渲染完、旧帧还没销毁时，
     * taskDoneAnywhere() / taskPointTextDone() 很容易拿到上一章的完成证据，
     * 结果跳过视频直接去点测验。这里按 chapterId 检测换章并清掉文本缓存，
     * 4 秒内不做任何推进判断。 */
    const chapKeyNow = quizChapterKey();
    if (st.chapterKey !== chapKeyNow) {
      st.chapterKey = chapKeyNow;
      st.chapterAt = Date.now();
      tpTextAt = 0;
      tpTextVal = false;
      st.lastAdvanceWhy = '';
      /* 2026-11-03：换章后上一章的「点不动」记录、以及「后面没得跳」的计时都作废 */
      st.failedToc = {};
      st.noTargetSince = 0;
      st.noTargetNoted = false;
      st.stopReason = '';
      st.lastTocLogKey = '';
      st.skipFallbackKey = '';
      resetTocPlan();
      /* 换章了：上一章答题帧留下的「忙碌」标记必须清掉，否则新章节要被它挡住十几秒
       * （实测第二个测验白等 26 秒才去点入口）。 */
      try { root.top.__cxExamBusyAt = 0; } catch (e) {}
    }
    if (Date.now() - (st.chapterAt || 0) < 4000) return;

    /* 顶层能看见任务条：判到「测验任务点已完成」就广播，别让跨域答题帧自己瞎猜 */
    announceQuizTaskDone();

    /* 2026-10-30：答题帧正在作答时，既不抢点入口，也不因为「任务条上还有未完成入口」
     * 等 12 秒后切章 —— 那会在人家答题/提交时把章节切走。 */
    if (examBusyRecently()) return;

    if (hasQuizOpen()) return;
    /* 2026-11-03：跳过学习检测时，如果测验就在本帧（同一文档，而不是子 iframe），
     * exam 的广播可能早于本帧监听就绪 → 停留 6 秒后自己发起切章，别卡在测验页上。 */
    if (CX.parser && CX.parser.looksLikeExamPage && CX.parser.looksLikeExamPage()) {
      if (examSkipOn()) {
        const dwell = Date.now() - (st.chapterAt || st.loadedAt || 0);
        if (dwell > 6000) triggerJump('skip-exam');
      }
      return;
    }

    const type = detectPageType();
    st.pageType = type;

    if (type === 'empty') {
      /* 2026-10-30：有些章节**本身就是一节「学习测验」**（没有视频、也没有任务点元素），
       * 会被 detectPageType() 判成 empty。旧代码这里直接 triggerJump，结果整章测验被跳过
       * （真机日志：2.3.1.4 之后一路「空页面，准备切章」）。
       * 先看任务条上有没有测验入口；有就先进测验，没有才跳章。 */
      const qeEmpty = alreadyReviewedView() ? null : findQuizTaskEntry();
      if (qeEmpty && !quizClickedThisChapter() && !examBusyRecently() && !quizEntryCooldown()) {
        st.quizTaskClicked = location.href;
        markQuizClicked();
        CX.info('空页面，但任务条上有「' + entryLabel(qeEmpty) + '」→ 先进测验');
        clickEntry(qeEmpty);
        return;
      }
      if (qeEmpty && holdForPendingQuiz('empty-page')) return;
      /* 2026-10-28 接线：advanceWhenNoTask（默认开）关掉时，空页面停下来等人，
       * 不再无脑往下跳（以前这个开关根本没有代码读）。 */
      if (navCfg().advanceWhenNoTask === false) {
        if (!st.typeSince) { st.typeSince = Date.now(); CX.info('页面类型：空页面（advanceWhenNoTask=false，不自动跳）'); }
        return;
      }
      if (!st.typeSince) { st.typeSince = Date.now(); CX.info('页面类型：空页面，准备切章'); return; }
      if (Date.now() - st.typeSince < 1500) return;
      triggerJump('empty-page');
      return;
    }

    if (type === 'video-only') {
      /* 走到这里 = **任何可访问文档里都没有任务点元素**（.ans-job-video / .ans-attach-ct），
       * 也就是站点真的没给这一节记任务点。
       * 注意：「1 学习视频 / 2 学习测验」是章节内容**标签页**，不是任务点状态，
       * 2026-10-28 曾把它当成"有任务点"的证据，导致这种页永远在等（用户实测卡住）。 */
      const skipWatch = navCfg().videoOnlyMode === 'skip';

      let canAdvance = false;
      let why = '';
      if (skipWatch) {
        canAdvance = true;
        why = '本节没有任务点，按设置跳过观看';
      } else if (videoEndedAnywhere()) {
        canAdvance = true;
        why = '视频已播完';
      }

      if (!canAdvance) {
        if (!st.typeSince) {
          st.typeSince = Date.now();
          CX.info('本节没有任务点，等视频播完（可在设置里改成「直接跳过」）');
        }
        return;
      }
      st.typeSince = 0;
      /* 只在"可以走"的理由变化时打一次，否则每秒一条会把有用的日志全冲掉 */
      if (st.lastAdvanceWhy !== why) { st.lastAdvanceWhy = why; CX.info('可以往下走：' + why); }

      /* 往下走之前先看任务条有没有「学习测验」（skip 只跳过看视频，不跳过测验）。 */
      const quizEntryVO = findQuizTaskEntry();
      if (quizEntryVO && !quizClickedThisChapter() && !examBusyRecently() && !quizEntryCooldown()) {
        st.quizTaskClicked = location.href;
        markQuizClicked();
        CX.info('先去「' + (entryLabel(quizEntryVO)) + '」（' + why + '）');
        CX.status('进入学习测验…', { busy: true, phase: 'exam' });
        /* 2026-10-28：这里原来还有一道 quizClickGuard()（15 秒跨帧锁），而上面是 8 秒冷却，
         * 两个锁不一致 → 日志打了、点击被拦，看着像"点了没反应"。现在 evaluatePage 只有顶层
         * 跑，本来就不需要跨帧锁，直接点。 */
        clickEntry(quizEntryVO);
        return;
      }
      if (!quizEntryVO) logQuizEntryDebug();
      if (holdForPendingQuiz('video-only')) return;
      triggerJump(skipWatch ? 'video-only-skip' : 'video-ended');
      return;
    }

    /* task+video / task-only */
    st.typeSince = 0;
    if (!taskDoneAnywhere() && !taskPointTextDone()) {
      /* 文档/图片任务：没有播放器可等，靠滚动触发完成 */
      if (type === 'task-only') startDocScan();
      return;
    }
    /* 任务点都完成了，停掉滚动 */
    stopDocScan();
    /* 已经在「已批阅/已完成」的测验视图里时，不要再点测验入口（否则又重载一次测验，
     * 作答次数越刷越多 —— 用户截图里已经"第 19 次作答"）。 */
    const quizEntry = alreadyReviewedView() ? null : findQuizTaskEntry();
    if (quizEntry && !quizClickedThisChapter() && !examBusyRecently() && !quizEntryCooldown()) {
      st.quizTaskClicked = location.href;
      markQuizClicked();
      CX.info('任务点已完成，先去「' + (entryLabel(quizEntry)) + '」');
      /* 2026-10-28：这里原来还有 quizClickGuard()（15 秒跨帧锁），
       * 但进入条件已经是 8 秒冷却 → 两个锁冲突，日志打了、点击被拦。evaluatePage 只有顶层跑，
       * 不需要跨帧锁，直接点。 */
      clickEntry(quizEntry);
      return;
    }
    if (!quizEntry) logQuizEntryDebug();
    if (holdForPendingQuiz('task-done')) return;
    /* 2026-10-28 接线：skipEmptyPage（默认开）关掉时，任务点完成的页也只是停下，
   * 不自动跳章（以前这个开关只在设置页露脸，没有任何代码读）。 */
    if (navCfg().skipEmptyPage === false) {
      CX.debug('任务点已完成，但 skipEmptyPage=false，不自动跳章');
      return;
    }
    /* 注：这里曾经加过一道「任务条上还有未完成的测验就让路」的拦截，
     * 但它只能靠 aria-label 判断是否完成 —— 站点很多任务条项根本没有 aria，
     * 于是「已完成」的页也被判成"未完成"，导致永远不跳章（用户实测截图：任务点✅已完成、
     * 章节测验✅已完成、本次成绩 100 分，却一直停在这一页）。已删除。
     * 是否先去测验，交给上面的 findQuizTaskEntry() 判断（它会看 aria/class/✓ 图标）。 */
    triggerJump('task-done');
  }

  setInterval(function () { try { if (!offStudyPage()) evaluatePage(); } catch (e) { CX.debug('评估异常：' + e.message); } }, 1000);

  CX.nav = {
    clickNext: clickNext,
    findNextButton: findNextButton,
    hasUnfinishedTask: hasUnfinishedTask,
    allTasksDone: allTasksDone,
    state: st,
    /* 2026-11-03：目录扫描结果的纯数据摘要（测试 / 诊断用，不暴露 DOM） */
    tocScan: function () {
      let p = null;
      try { p = tocPlan(); } catch (e) { return null; }
      if (!p) return null;
      return {
        target: p.target || null,
        skipped: p.skipped || [],
        blockedAll: !!p.blockedAll,
        hasAfter: !!p.hasAfter,
        count: p.items || 0,
        idx: p.idx == null ? -1 : p.idx
      };
    },
    resetTocPlan: resetTocPlan
  };

  /* 用户点「启动」（总开关 false → true）时清掉暂停状态，否则 stopped/stuck 会一直挡住跳转 */
  let lastEnabled = !!(CX.cfg && CX.cfg.enabled);
  CX.onConfig(function (cfg) {
    const on = !!(cfg && cfg.enabled);
    if (on && !lastEnabled) {
      st.stopped = false;
      st.stoppedAt = 0;
      st.stopReason = '';
      st.stuck = 0;
      st.busy = false;
      st.claimRetries = 0;
      st.typeSince = 0;
      st.quizTaskClicked = '';
      st.failedToc = {};
      st.noTargetSince = 0;
      st.noTargetNoted = false;
      st.lastTocLogKey = '';
      resetTocPlan();
      CX.debug('已重新启用：清除暂停状态，恢复自动切章');
    }
    lastEnabled = on;
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
// dev-heartbeat 20261025194535
