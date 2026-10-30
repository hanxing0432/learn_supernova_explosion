/* 视频播放层：自动播放、后台不暂停、学完上报 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX || CX.player) return;

  const doc = root.document;
  const qVideo = function () {
    const list = CX.qsa('video').filter(function (v) { return !v.dataset.cxMirror; });
    if (!list.length) return null;
    /* 选面积最大的播放器 */
    let best = list[0], bestArea = 0;
    list.forEach(function (v) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = v; }
    });
    return best;
  };

  const state = {
    autoMode: false,
    startAt: 0,
    pausedWhileHidden: false,
    playSuccess: false,
    doneNotified: false,
    lastSrc: '',
    watchdog: 0,
    playTimer: 0,
    lastPlayClick: 0
  };

  const GRACE_MS = 5000;

  /* 真实可见性：伪造发生在主世界，隔离世界读到的 document.hidden 就是真实值 */
  const isReallyHidden = function () {
    try { return !!doc.hidden; } catch (e) { return false; }
  };

  /* ---------- 任务点状态 ---------- */
  function videoTaskEl() { return CX.qa('.ans-job-video, [class*="ans-job"][aria-label*="视频"]'); }

  /* 一个章节页可能有多个视频任务点（实测 3 个），每个都在自己的 .ans-attach-ct 里 */
  function videoTaskEls() {
    return CX.qsa('.ans-job-video, [class*="ans-job"][aria-label*="视频"]');
  }

  function taskElDone(task) {
    if (!task) return false;
    const aria = task.getAttribute('aria-label') || '';
    const cond = task.querySelector('.task-condition');
    const condHidden = cond ? cond.style.display === 'none' : false;
    /* 多视频页面里，站点把"完成"记在父容器 .ans-attach-ct 的 ans-job-finished 上 */
    const ct = (task.closest && task.closest('.ans-attach-ct')) || task.parentElement;
    const clsDone = ct && /ans-job-finished/.test(String(ct.className || ''));
    return aria.indexOf('已完成') >= 0 || condHidden || !!clsDone;
  }

  function isVideoDone() {
    /* 只认站点自己的完成标记（和你原来那个篡改猴脚本一致）：
     * 任务点 aria-label 标「已完成」、完成条件被内联隐藏、或父容器带 ans-job-finished。
     * 绝不用 v.ended / 播放进度判断——播到 100% 不等于任务点完成。
     *
     * ⚠️ 多视频章节：必须**全部**任务点完成才算完成。
     * 旧实现用 CX.qa 只取第一个，播完第一个就带着没看的视频跳下一节。 */
    const tasks = videoTaskEls();
    if (!tasks.length) return false;
    for (let i = 0; i < tasks.length; i++) {
      if (!taskElDone(tasks[i])) return false;
    }
    return true;
  }

  /* 进度，用于日志与"全做完才能结束"的可观测性 */
  function videoProgress() {
    const tasks = videoTaskEls();
    let done = 0;
    for (let i = 0; i < tasks.length; i++) if (taskElDone(tasks[i])) done++;
    return { total: tasks.length, done: done, all: tasks.length > 0 && done === tasks.length };
  }

  /* 视频 iframe（ananas/modules/video/index.html）里没有任务点元素，
   * 判断不了"本节还有几个视频没看" —— 同源，去父级内容帧数一遍。 */
  function globalProgress() {
    const local = videoProgress();
    if (local.total) return local;
    try {
      const pd = root.parent && root.parent !== root && root.parent.document;
      if (pd) {
        const tasks = pd.querySelectorAll('.ans-job-video, [class*="ans-job"][aria-label*="视频"]');
        if (tasks.length) {
          let done = 0;
          for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            const aria = t.getAttribute('aria-label') || '';
            const cond = t.querySelector('.task-condition');
            const condHidden = cond ? cond.style.display === 'none' : false;
            const ct = (t.closest && t.closest('.ans-attach-ct')) || t.parentElement;
            const clsDone = ct && /ans-job-finished/.test(String(ct.className || ''));
            if (aria.indexOf('已完成') >= 0 || condHidden || clsDone) done++;
          }
          return { total: tasks.length, done: done, all: done === tasks.length };
        }
      }
    } catch (e) {}
    return { total: 0, done: 0, all: false };
  }

  /* ---------- 保活镜像（无音轨视频） ---------- */
  function setupMirror(v) {
    if (!CX.cfg.keepAlive.mirrorIfNoAudio || v.__cxMirror) return;
    try {
      const hasAudio = (v.audioTracks && v.audioTracks.length > 0) ||
        (v.webkitAudioDecodedByteCount || 0) > 0 ||
        (v.mozHasAudio === true);
      if (hasAudio) return;
      if (typeof v.captureStream !== 'function') return;
      if (v.readyState < 2) return;
      v.__cxMirror = true;
      const stream = v.captureStream();
      const mirror = doc.createElement('video');
      mirror.dataset.cxMirror = '1';
      mirror.muted = true;
      mirror.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1;';
      mirror.srcObject = stream;
      mirror.play().catch(function () {});
      (doc.body || doc.documentElement).appendChild(mirror);
      CX.info('已挂接保活镜像（无音轨视频）');
    } catch (e) {}
  }

  function prepare(v) {
    if (v.__cxPrepared) {
      applyVolume(v);
      return;
    }
    v.__cxPrepared = true;
    applyVolume(v);
    setupMirror(v);
    v.addEventListener('pause', function () {
      if (!state.autoMode || v.ended) return;
      if (isReallyHidden()) state.pausedWhileHidden = true;
    });
    v.addEventListener('playing', function () {
      state.playSuccess = true;
      CX.status('视频播放中', { busy: true, phase: 'play' });
      reportVideoState('playing');
    });
    v.addEventListener('pause', function () {
      if (!v.ended) reportVideoState('pause');
    });
    v.addEventListener('ended', function () {
      CX.info('视频播放结束');
      /* 等站点把任务点标记完成（进度上报），最多等 finishGraceMs，避免跳太快丢进度 */
      const waitMs = Number((CX.cfg.player && CX.cfg.player.finishGraceMs) || 1500) + 6000;
      const t0 = Date.now();
      (function pollDone() {
        if (isVideoDone() || Date.now() - t0 > waitMs) {
          onMaybeDone('ended');
          return;
        }
        setTimeout(pollDone, 500);
      })();
    });
    v.addEventListener('error', function () {
      /* 2026-10-28 修复运算符优先级：原来是 '...' + v.error && v.error.code，
       * 字符串恒真 → 实际去取 v.error.code，v.error 为空时直接抛 TypeError。 */
      CX.warn('视频元素报错 code=' + ((v.error && v.error.code) || 0));
    });
  }

  /* 停止自动化（总开关关掉 / 用户点「暂停」时调用）
   * 2026-10-28 修复：以前看门狗和 playTimer 都不看 cfg.enabled，
   * 所以点了「暂停」视频还会被自动续播回来 —— 表现就是"点了暂停也不停"。 */
  function stopAutomation(reason) {
    state.autoMode = false;
    if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = 0; }
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = 0; }
    const v = qVideo();
    if (v && !v.paused && !v.ended) {
      try { v.pause(); } catch (e) {}
      CX.info('已暂停播放（' + reason + '）');
    }
  }

  CX.onConfig(function (cfg) {
    if (cfg && cfg.enabled === false) stopAutomation('总开关关闭');
  });

  function applyVolume(v) {
    const ka = CX.cfg.keepAlive || {};
    if (ka.volumeSilent === false) return;
    if (v.volume !== 0) v.volume = 0;
    if (v.muted) {
      /* 内核在页面隐藏时会暂停“一直静音”的视频，这里尽量保持非静音 + volume 0 */
      v.muted = false;
      v.removeAttribute('muted');
    }
    const rate = Number(ka.rate || 1);
    if (rate > 0 && Math.abs(v.playbackRate - rate) > 0.01) {
      try { v.playbackRate = rate; } catch (e) {}
    }
  }

  function pokeResumeFlag() {
    try { if (root.parent && root.parent !== root) root.parent['resumePlay'] = true; } catch (e) {}
    try { root.top['resumePlay'] = true; } catch (e) {}
  }

  function forcePlay(v) {
    if (!v) return false;
    prepare(v);
    let p;
    try { p = v.play(); } catch (e) { clickPlayerPlay(); return false; }
    if (p && p.then) {
      p.then(function () {
        state.playSuccess = true;
        CX.status('视频播放中', { busy: true, phase: 'play' });
      }).catch(function (err) {
        state.playSuccess = false;
        const name = err && err.name;
        if (name === 'NotAllowedError') {
          /* 无用户手势时只能先静音播，首次交互后恢复非静音 */
          v.muted = true;
          v.setAttribute('muted', 'muted');
          const p2 = v.play();
          if (p2 && p2.then) p2.then(function () { state.playSuccess = true; }).catch(function () { clickPlayerPlay(); });
        } else {
          /* NotSupportedError / AbortError：新版播放器要先点它自己的播放按钮才开始加载 */
          clickPlayerPlay();
        }
      });
    }
    return !v.paused;
  }

  /* 点播放器自带的播放按钮（ananas 新播放器不在 src 就绪前响应 play()） */
  function clickPlayerPlay() {
    const now = Date.now();
    if (now - state.lastPlayClick < 2500) return false;
    const sels = [
      '.vjs-big-play-button', '.ans-vjs-play', '.vjs-play-control', '.prism-player .prism-big-play-btn',
      '.play-btn', '.video-play-btn', '[aria-label*="播放"]', '[title*="播放"]', '.ans-video-play'
    ];
    for (let i = 0; i < sels.length; i++) {
      const el = CX.qa(sels[i]);
      if (el && CX.visible(el)) { state.lastPlayClick = now; CX.click(el); return true; }
    }
    const b = CX.findByText(['播放'], document, { maxLen: 4 });
    if (b) { state.lastPlayClick = now; CX.click(b); return true; }
    return false;
  }

  /* 页面正文按需读取：每 5 秒最多真正读一次，warnDailyLimit / closeNotice 共用。
   * 2026-10-28：原先 scan() 每 2 秒各读一次 body.innerText（页面级布局），
   * 5000 字的题库页每次要一两百毫秒 —— 这也是"时不时卡一下"的来源之一。 */
  let bodyTextAt = 0;
  let bodyTextCache = '';
  function bodyScanText() {
    const now = Date.now();
    if (now - bodyTextAt < 5000) return bodyTextCache;
    bodyTextAt = now;
    try { bodyTextCache = CX.oneLine(CX.pageText(document.body)).slice(0, 2000); } catch (e) { bodyTextCache = ''; }
    return bodyTextCache;
  }

  /* 站点提示层（今日上限 / 各种"知道了"）会盖住播放器和整页，遮罩会吞掉所有点击 —— 必须点掉。
   * 2026-10-28 修复：原来是"一辈子只关一次"，关过一次后再出现的提示就不管了 → 页面被遮罩锁死；
   * 而且候选里带「确定」太危险（可能触发提交），改成只点「知道了 / 我知道了」。 */
  let noticeClosedAt = 0;
  function closeNotice() {
    const now = Date.now();
    if (now - noticeClosedAt < 8000) return;
    const t = bodyScanText();
    if (!/知道了|我知道了|今日.*上限/.test(t)) return;
    const b = CX.clickByTextAnyDoc
      ? CX.clickByTextAnyDoc(['知道了', '我知道了'], { maxLen: 6 })
      : CX.findByText(['知道了', '我知道了'], document, { maxLen: 6 });
    if (b) {
      noticeClosedAt = now;
      CX.info('关闭站点提示层');
    }
  }

  function onFirstGesture() {
    if (!state.autoMode) return;
    const v = qVideo();
    if (!v || !v.muted) return;
    v.muted = false;
    v.removeAttribute('muted');
    v.volume = 0;
    if (v.paused) v.play().catch(function () {});
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) {
    root.addEventListener(t, onFirstGesture, { capture: true, passive: true });
  });

  /* ---------- 播放状态上报：后台据此拦住「下一节」 ---------- */
  function reportVideoState(kind) {
    try {
      chrome.runtime.sendMessage({
        kind: 'video:state',
        state: kind,
        url: location.href,
        ts: Date.now()
      });
    } catch (e) {}
  }

  /* ---------- 学完上报（只报一次） ---------- */
  function onMaybeDone(reason) {
    if (state.doneNotified) return;
    /* 多视频章节：本节还有别的视频没看完就不上报，否则 nav 会立刻跳到下一节
     * （实测一节有 3 个视频任务点，只播完第 1 个就跳走）。 */
    const prog = globalProgress();
    if (prog.total > 1 && !prog.all) {
      CX.debug('本视频结束，但本节任务点仅 ' + prog.done + '/' + prog.total + '，暂不上报完成');
      return;
    }
    state.doneNotified = true;
    state.autoMode = false;
    CX.info('判定视频任务已完成（' + reason + '）' + (prog.total ? '，任务点 ' + prog.done + '/' + prog.total : ''));
    CX.status('本节视频已完成，准备下一节', { busy: false, phase: 'done' });
    try {
      chrome.runtime.sendMessage({ kind: 'video:done', reason: reason, url: location.href, title: doc.title });
    } catch (e) {}
  }

  /* ---------- 启动 ---------- */
  function startAuto(v) {
    if (state.autoMode) return;
    if (isVideoDone()) {
      CX.info('该任务点已完成，跳过播放');
      onMaybeDone('already-done');
      return;
    }
    state.autoMode = true;
    state.startAt = Date.now();
    state.pausedWhileHidden = false;
    state.doneNotified = false;
    CX.status('检测到未完成视频，自动播放', { busy: true, phase: 'play' });
    pokeResumeFlag();
    forcePlay(v);

    if (state.watchdog) clearInterval(state.watchdog);
    state.watchdog = setInterval(function () {
      if (!state.autoMode) { clearInterval(state.watchdog); state.watchdog = 0; return; }
      if (!CX.cfg.enabled) { stopAutomation('总开关关闭'); return; }
      const el = qVideo();
      if (!el) return;
      prepare(el);
      if (el.ended) { onMaybeDone('ended-watch'); return; }
      /* 2026-10-28 接线：这两个开关以前没人读。
       * blockAutoPause=«暂停即续播»、resumeAfterPause=«被暂停后自动续播»，任一关掉就不强拉。 */
      const ka = CX.cfg.keepAlive || {};
      const pl = CX.cfg.player || {};
      if (ka.blockAutoPause === false || pl.resumeAfterPause === false) return;
      if (el.paused && !el.seeking &&
        (isReallyHidden() || state.pausedWhileHidden || Date.now() - state.startAt < GRACE_MS)) {
        state.pausedWhileHidden = false;
        CX.debug('看门狗续播');
        const p = el.play();
        if (p && p.catch) p.catch(function () {});
        pokeResumeFlag();
      }
    }, 1500);

    if (state.playTimer) clearInterval(state.playTimer);
    state.playTimer = setInterval(function () {
      if (state.playSuccess || !state.autoMode) { clearInterval(state.playTimer); state.playTimer = 0; return; }
      if (!CX.cfg.enabled) { stopAutomation('总开关关闭'); return; }
      forcePlay(qVideo());
    }, 1200);
  }

  function scan() {
    if (!CX.cfg.enabled || CX.cfg.player.autoPlay === false) return;
    /* 2026-10-28 回退：这里曾经加过"skip 模式 + 本帧看不到任务点就不自动播放"，
     * 但任务点常在**别的帧**（cards / 视频模块）里，本帧永远看不到 →
     * 有任务点的页也被判成"不用看"，视频直接不播，整节卡死（用户实测）。
     * 是否跳过由 nav 判断（它会跨帧检查），player 只管播。 */
    warnDailyLimit();
    closeNotice();
    const v = qVideo();
    if (!v) return;
    if (state.autoMode && v.isConnected && !v.ended) return;
    if (v.src !== state.lastSrc) {
      state.lastSrc = v.src;
      state.doneNotified = false;
      state.playSuccess = false;
      state.autoMode = false;
    }
    startAuto(v);
  }

  /* 站点今日上限提示：仍然播放，但进度不会记入，必须让用户知道原因 */
  let limitWarned = false;
  function warnDailyLimit() {
    if (limitWarned) return;
    const t = bodyScanText();
    if (/任务点完成数已达上限|观看时长已达上限|今日.*上限/.test(t)) {
      limitWarned = true;
      CX.warn('站点提示：今日视频任务点/观看时长已达上限，视频能播但可能不计入进度');
      CX.status('⚠ 今日学习时长已达平台上限，进度可能不计入', { busy: false, phase: 'limit' });
    }
  }

  /* 视频结束/任务点已完成 → 持续监控，页面换视频时重新接管 */
  const mo = new MutationObserver(function () { setTimeout(scan, 300); });
  function observe() {
    if (!doc.body) return;
    mo.observe(doc.body, { childList: true, subtree: true });
  }

  setInterval(scan, 2000);
  setInterval(function () {
    if (!CX.cfg.enabled) return;
    const v = qVideo();
    if (v && state.autoMode && !v.paused) applyVolume(v);
    if (v && isVideoDone() && !state.doneNotified) onMaybeDone('poll');
    /* 心跳：视频还在播就持续告诉后台「别跳下一节」 */
    if (v && !v.paused && !v.ended && !isVideoDone()) reportVideoState('playing');
  }, 2500);

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { observe(); scan(); });
  else { observe(); scan(); }

  /* 站点自带的暂停恢复通道：父级轮询 resumePlay，置位后自己 play() */
  setInterval(function () {
    if (!CX.cfg.enabled) return;          /* 暂停后不要再给站点发"恢复播放"信号 */
    if (state.autoMode && qVideo() && qVideo().paused) pokeResumeFlag();
  }, 3000);

  CX.player = {
    qVideo: qVideo,
    isVideoDone: isVideoDone,
    videoProgress: videoProgress,
    scan: scan,
    forcePlay: forcePlay,
    getState: function () { return state; }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
