/* 视频弹题（播放中弹出的小题）：识别题型、AI/暴力作答、点「继续学习」并恢复播放 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX || !CX.parser) return;
  if (CX.videoQuiz) return;

  const P = CX.parser;
  const st = {
    busy: false,
    mark: '',
    rounds: 0,
    bruteIndex: 0,
    tried: [],
    lastResult: '',
    handledAt: 0,
    attempts: 0,
    /* 跨题面的总尝试数：不随 mark 变化重置，用来兜住"站点反复重新弹题"的死循环 */
    totalAttempts: 0,
    gaveUpAt: 0
  };

  function cfg() { return CX.cfg.videoQuiz || {}; }

  /* 2026-11-04：AI 总开关关掉时，「AI 优先」退回暴力枚举（视频弹题同样受 AI 开关管） */
  function effMode() {
    const m = cfg().mode || 'ai-first';
    if (m === 'off') return 'off';
    if (m === 'brute') return 'brute';
    return (CX.aiOn && !CX.aiOn()) ? 'brute' : 'ai-first';
  }

  function combos(n) {
    const out = [];
    for (let mask = 1; mask < (1 << n); mask++) {
      const set = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) set.push(P.LETTERS[i]);
      out.push(set);
    }
    out.sort(function (a, b) { return a.length - b.length || a.join('').localeCompare(b.join('')); });
    return out.filter(function (s) { return s.length >= 2; }).concat(out.filter(function (s) { return s.length === 1; }));
  }

  /* ---------- 给 AI 的题目描述 ---------- */
  function toAiQuestion(q) {
    return {
      type: q.type,
      typeText: q.typeText,
      title: q.title,
      stem: q.title || q.stem || '',
      options: q.options.map(function (o) { return { label: o.label, text: o.text }; })
    };
  }

  async function askAi(q, feedback) {
    const payload = {
      task: 'video-quiz',
      question: toAiQuestion(q),
      feedback: feedback || null,
      wantMulti: q.type === 'multi'
    };
    const res = await CX.chat(payload);
    if (!res || !res.ok) {
      CX.warn('AI 作答失败：' + (res && res.error));
      return null;
    }
    const ans = res.answer;
    if (!ans) return null;
    let choices = ans.choices || ans.answer || [];
    if (typeof choices === 'string') choices = choices.toUpperCase().replace(/[^A-Z]/g, '').split('');
    choices = (Array.isArray(choices) ? choices : [choices]).map(function (c) { return String(c).toUpperCase(); }).filter(Boolean);
    if (q.type !== 'multi') choices = choices.slice(0, 1);
    return choices.length ? choices : null;
  }

  /* ---------- 结果判定（更快的轮询） ---------- */
  async function waitResult(box, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 4000)) {
      const r = P.videoQuizResult(box);
      if (r) return r;
      await CX.sleep(120);
    }
    return null;
  }

  function restorePlayback() {
    try {
      const v = CX.player && CX.player.qVideo();
      if (!v) return;
      if (v.paused) {
        v.play().catch(function () {});
      }
    } catch (e) {}
  }

  async function clickContinue(q) {
    if (cfg().autoContinue === false) return;
    const scope = (q && q.box) || root.document;
    const btn = P.findContinueButton(scope) || P.findContinueButton(root.document);
    if (btn) {
      CX.click(btn);
      CX.info('已点击「继续学习」');
      await CX.sleep(600);
    }
    /* 有些版本是关闭弹层 */
    const close = CX.qa('.ans-videoquiz-close, .close-videoquiz, .layui-layer-close', scope);
    if (close && CX.visible(close)) { CX.click(close); await CX.sleep(300); }
    restorePlayback();
  }

  async function handle(q) {
    if (st.busy) return;
    if (q.mark !== st.mark) {
      st.mark = q.mark;
      st.rounds = 0;
      st.bruteIndex = 0;
      st.tried = [];
      st.lastResult = '';
      st.attempts = 0;
      /* 新题：先把播放暂停记下来，答完恢复 */
      try { st.savedPlayback = CX.player && CX.player.qVideo() ? { t: CX.player.qVideo().currentTime } : null; } catch (e) {}
    }

    const mode = effMode();
    if (mode === 'off') return;

    st.busy = true;
    try {
      /* 已答对：直接继续 */
      if (q.result === 'right') {
        CX.status('弹题已通过，继续学习', { busy: true, phase: 'quiz' });
        await clickContinue(q);
        return;
      }

      let choices = null;

      if (mode === 'ai-first' && st.rounds < (cfg().maxAiRounds || 3)) {
        CX.status('AI 正在作答弹题（' + q.typeText + '）', { busy: true, phase: 'quiz' });
        const feedback = st.tried.length ? { wrongAttempts: st.tried } : null;
        choices = await askAi(q, feedback);
        if (choices) st.rounds++;
      }

      if (!choices) {
        /* 暴力兜底 */
        if (q.type === 'multi') {
          const all = combos(q.options.length);
          const next = all[st.bruteIndex] || all[0];
          st.bruteIndex++;
          choices = next;
        } else if (q.type === 'judge' || q.options.length === 2) {
          const order = ['A', 'B'];
          choices = [order[(st.bruteIndex++) % 2]];
        } else {
          const n = q.options.length || 4;
          const order = P.LETTERS.slice(0, n).split('');
          choices = [order[(st.bruteIndex++) % n]];
        }
        CX.status('按顺序试答（' + q.typeText + '）', { busy: true, phase: 'quiz' });
      }

      st.tried.push(choices.join(''));
      st.attempts++;
      st.totalAttempts++;

      CX.info('弹题作答：' + q.typeText + ' → ' + choices.join(''));
      P.applyChoices(q, choices);
      await CX.sleep(CX.jitter(cfg().submitWaitMs || 260, 0.35));

      /* 提交 */
      const submit = CX.firstOf(P.SEL.videoQuizSubmit, q.box) || P.findSubmitButton(q.box) || q.submit;
      if (submit) {
        CX.info('弹题提交按钮：' + submit.tagName +
          ' class=' + String(submit.className || '').slice(0, 30) +
          ' onclick=' + String((submit.getAttribute && submit.getAttribute('onclick')) || '(空)').slice(0, 60));
        CX.click(submit);
      } else {
        /* 找不到提交按钮：把候选打出来，便于判断是选择器没覆盖还是按钮在弹层外 */
        try {
          const cand = CX.qsa('a,button,input[type=button],div,span', q.box).filter(function (el) {
            const t = CX.oneLine(el.innerText || el.value || '');
            return t && t.length <= 8 && CX.visible(el);
          }).slice(0, 8).map(function (el) {
            return el.tagName + ':' + CX.oneLine(el.innerText || el.value || '') +
              '@' + String(el.className || '').slice(0, 20);
          });
          CX.info('弹题没有提交按钮，候选：' + JSON.stringify(cand));
        } catch (e) {}
        /* 没有提交按钮：直接点继续学习触发校验 */
        const cont = P.findContinueButton(q.box);
        if (cont) CX.click(cont);
      }

      const result = await waitResult(q.box, 4000);
      st.lastResult = result || 'unknown';
      if (result === 'right') {
        CX.status('弹题答对 ✔', { busy: true, phase: 'quiz' });
        CX.rememberAnswer('vq:' + q.mark, choices);
        await clickContinue(q);
      } else if (result === 'wrong') {
        CX.warn('弹题答错，换一个答案重试');
        CX.status('弹题答错，重试中…', { busy: true, phase: 'quiz' });
        await CX.sleep(cfg().wrongCoolMs || 120);
      } else {
        CX.warn('弹题结果未知，按未通过处理');
        await CX.sleep(cfg().wrongCoolMs || 120);
      }
    } catch (e) {
      CX.error('弹题处理异常：' + e.message);
    } finally {
      st.busy = false;
      st.handledAt = Date.now();
      /* 刹车：单题失败次数用配置里的 bruteMaxTries（原来硬编码 24，配置项形同虚设），
       * 另外加一个"跨题面"的总上限 —— 站点答错后会重新弹题，mark 一变 attempts 就归零，
       * 没有总上限就会无限转（实测 C→D→A→B 每秒一轮停不下来）。 */
      const maxTry = Number(cfg().bruteMaxTries || 10);
      if (st.lastResult !== 'right' && st.attempts < maxTry && st.totalAttempts < 40) {
        setTimeout(function () { if (!st.busy) tick(); }, 60);
      } else if (st.lastResult !== 'right') {
        st.gaveUpAt = Date.now();
        CX.warn('弹题连续尝试 ' + st.totalAttempts + ' 次仍未通过，停止自动枚举（这道题需要人工确认）');
        CX.status('⚠ 弹题自动作答失败，请人工处理', { busy: false, phase: 'quiz' });
      }
    }
  }

  async function tick() {
    if (!CX.cfg.enabled || !cfg().enabled) return;
    if (st.busy) return;
    /* 连续失败太多：冷却 5 分钟，避免一直对着站点刷 */
    if (st.totalAttempts >= 40) {
      if (!st.gaveUpAt) st.gaveUpAt = Date.now();
      if (Date.now() - st.gaveUpAt < 300000) return;
      st.totalAttempts = 0;
      st.gaveUpAt = 0;
    }
    const box = P.findVideoQuizBox();
    if (!box) return;
    /* 弹题里若有加密文字，先把字体映射建好再作答：否则 AI 读到乱码，答案必错 */
    if (CX.fontDecrypt && CX.fontDecrypt.ensure && box.querySelector('.font-cxsecret')) {
      const mapped = CX.fontDecrypt.stats ? CX.fontDecrypt.stats().mapped : 0;
      if (!mapped) {
        try { await CX.fontDecrypt.ensure(); } catch (e) {}
        return;
      }
    }
    /* 弹层里是多道题（学习检测弹层）→ 交给 exam 模块按整卷处理 */
    if (P.popupQuestionGroups(box) >= 2) return;
    const q = P.parseVideoQuiz();
    if (!q) return;
    await handle(q);
  }

  /* 轮询：每次循环都现读 videoQuiz.tickMs（以前 setInterval 在脚本加载时就把间隔写死，
   * 改设置必须刷新页面才生效 —— 2026-10-28 修复） */
  (function loop() {
    let wait = Number(cfg().tickMs || 350);
    if (!isFinite(wait) || wait < 100) wait = 350;
    setTimeout(function () {
      Promise.resolve()
        .then(function () { return tick(); })
        .catch(function () {})
        .then(loop);
    }, wait);
  })();

  CX.videoQuiz = {
    tick: tick,
    state: st,
    answersOf: function () { return st.tried; }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
