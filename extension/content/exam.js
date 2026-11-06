/* 学习检测 / 章节测验 / 作业：AI 答题 → 提交 → 判分 → 错题回喂 AI → 重试直至通过 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX || !CX.parser) return;
  if (CX.exam) return;

  const P = CX.parser;
  const st = {
    busy: false,
    redoing: false,
    pageKey: '',
    examId: '',
    round: 0,
    maxRound: 6,
    history: [],       // [{round, answers:{idx:[labels]}, score, passed, wrongIndexes}]
    questions: [],
    started: false,
    finished: false,
    skipped: false,     /* 2026-11-03：按设置跳过学习检测（进页面但没作答） */
    bruteNoted: false,
    lastSubmitAt: 0,
    lastSubmitAddDelta: 0
  };

  /* 2026-10-30：顶层能看到任务条，答题帧经常跨域看不到 —— 由顶层广播「测验任务点已完成」。
   * 收到后 60 秒内按已完成处理。 */
  let remoteDoneAt = 0;
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || !msg.__broadcast || msg.kind !== 'quiz_task_done_bc') return;
      remoteDoneAt = Date.now();
      try { CX.info('收到顶层广播：学习测验任务点已完成'); } catch (e) {}
    });
  } catch (e) {}

  function cfg() { return CX.cfg.exam || {}; }

  /* ================= 跳过学习检测（2026-11-03） =================
   * 用户要的语义是「仍然进测验页，但不作答」：导航照旧点任务条上的测验入口，
   * 进来之后这里不解析题目、不调 AI、不提交、也不点「开始答题」，
   * 只广播一次「跳过」，由导航切下一章。
   * 目的就是尽快离开这一页，所以别在这儿等任何判分/任务点标记。 */
  function skipAnswering() { return CX.examMode() === 'skip'; }
  function mode() { return CX.examMode(); }

  /* 2026-11-04：跳过模式下放宽「这是不是测验页」的判定。
   * 有的课程卷子不用 .questionLi / .TiMu（新版 / 定制皮肤），内置选择器全落空时
   * 以前既不答也不跳。这里只给「跳过」用：看到选项控件或题目文案 + 提交按钮就算。 */
  function looksLikeQuizLoose() {
    try {
      const inputs = CX.qsa('input[type="radio"],input[type="checkbox"]', document).filter(CX.visible);
      if (inputs.length >= 2) return true;
      const t = CX.oneLine(CX.pageText(document.body)).slice(0, 2000);
      if (/章节测验|学习测验|单元测验|课后测验|题量\s*[:：]?\s*\d|答题时间|满分\s*[:：]?\s*\d/.test(t)) {
        if (P.findSubmitButton && P.findSubmitButton()) return true;
      }
    } catch (e) {}
    return false;
  }

  function skipNow() {
    const first = !st.skipped;
    st.skipped = true;
    st.finished = true;
    if (!first) return;
    CX.info('按设置跳过学习检测：进页面但不作答，交给导航切下一章');
    CX.status('跳过学习检测（按设置不作答）', { busy: false, phase: 'exam' });
    try { chrome.runtime.sendMessage({ kind: 'exam:skipped', url: location.href }); } catch (e) {}
  }

  /* ================= 通过判定：只看「学习测验」任务点是否完成 =================
   * 站点不给分数（「本次成绩」只是弹窗文案，已批阅页也只写「未达到及格线，请重做」），
   * 所以唯一可靠的判定是任务条上那一项有没有被标成「已完成」：
   *   · 及格时任务点必然完成；
   *   · 也有没及格但任务点已被站点算完成的情况 —— 这时同样直接走人，不再重交。
   * 一律不看分数、不看及格线。 */
  const QUIZ_TASK_WORDS = ['学习测验', '章节测验', '学习检测', '单元测验', '课后测验'];

  function docsAll() {
    const out = [document];
    try {
      (CX.walkAccessibleParents() || []).forEach(function (w) {
        try { if (w.document && out.indexOf(w.document) < 0) out.push(w.document); } catch (e) {}
      });
    } catch (e) {}
    return out;
  }

  function isQuizTaskText(t) {
    const s = String(t || '');
    for (let i = 0; i < QUIZ_TASK_WORDS.length; i++) if (s.indexOf(QUIZ_TASK_WORDS[i]) >= 0) return true;
    return false;
  }

  /* 单个任务条项 / 任务点容器是否已标记完成。
   * 2026-10-30 修正（用户反馈「明明有完成标记却判未完成」）：
   * 真实页面里标记往往**不在带文字的那个元素上**，而是：
   *   ① 任务条项自己的 aria / class；
   *   ② 里层任务点图标  <span class="ans-job-icon" aria-label="任务点已完成">；
   *   ③ 外层容器        <div class="ans-attach-ct ans-job-finished">。
   * 以前只查 ①，于是 ②③ 的页永远判未完成。现在三处都认，仍以「未完成」优先否掉。 */
  function taskDoneMark(el) {
    if (!el) return false;
    const aria = el.getAttribute('aria-label') || '';
    if (aria.indexOf('未完成') >= 0) return false;
    if (aria.indexOf('已完成') >= 0) return true;
    const cls = String(el.className || '');
    if (/ans-job-finished|job-finished/.test(cls)) return true;
    /* ② 里层任务点图标的 aria */
    try {
      const ic = el.querySelector && el.querySelector('[aria-label*="已完成"]');
      if (ic) {
        const a2 = ic.getAttribute('aria-label') || '';
        if (a2.indexOf('未完成') < 0) return true;
      }
    } catch (e) {}
    try {
      const fin = el.querySelector && el.querySelector('.ans-job-finished');
      if (fin) return true;
    } catch (e) {}
    /* ③ 外层容器带 ans-job-finished */
    try {
      const box = el.closest && el.closest('.ans-attach-ct');
      if (box && /ans-job-finished/.test(String(box.className || ''))) return true;
    } catch (e) {}
    return false;
  }

  function quizTaskElements() {
    const out = [];
    docsAll().forEach(function (d) {
      let items = [];
      /* 2026-10-30：把 .ans-attach-ct 也纳入 —— 任务点区域的「章节测验」标题通常挂在这里，
       * 完成标记在它内部的 .ans-job-icon 上（见 taskDoneMark）。 */
      try { items = CX.qsa('.prev_white, .prev_list li, .prevItem, [class*="ans-job"], .ans-attach-ct', d); } catch (e) { return; }
      items.forEach(function (el) {
        /* 用 textContent 而不是 innerText：innerText 会强制同步布局，这个函数在
         * 答题/批阅期间每秒被调用多次，弹窗一出现页面 DOM 变化就会明显卡顿。 */
        if (!isQuizTaskText(CX.oneLine(String(el.textContent || '').slice(0, 200)))) return;
        if (out.indexOf(el) < 0) out.push(el);
      });
    });
    return out;
  }

  /* 学习测验（任务点）完成了吗 —— 带 500ms 缓存。
   * 这个判定在 run() / handleReviewPage() / hasReviewSigns() 里都会被调用，
   * 提交后更是每秒问一次；没有缓存会反复扫 DOM，弹窗出现时最容易卡。 */
  let taskDoneCache = { at: 0, val: false };
  let taskDumpAt = 0;      /* 诊断日志节流：最多 5 秒一条，别把日志刷爆 */
  function quizTaskDone() {
    const now = Date.now();
    if (now - taskDoneCache.at < 500) return taskDoneCache.val;
    const v = computeQuizTaskDone();
    taskDoneCache = { at: now, val: v };
    return v;
  }

  function computeQuizTaskDone() {
    /* ⓪ 顶层广播的「测验任务点已完成」——跨域答题帧看不到任务条时的唯一证据来源 */
    if (remoteDoneAt && Date.now() - remoteDoneAt < 60000) {
      CX.debug('任务点判定=完成（顶层广播）');
      return true;
    }
    /* 判定顺序按"证据强度"排，只要命中一条就完成。
     * 注意：**「未达到及格线」不能当否定证据** —— 用户明确说过"有些情况没及格但任务点也算完成"，
     * 那种情况本来就该直接跳走。 */

    /* ① 任务条项自己的标记：aria="已完成" / class 带 ans-job-finished。
     * 注意：这里**不再**用"所有 .ans-attach-ct 容器都带 ans-job-finished"那种全局判断 ——
     * 2026-10-28 实测被坑：上一个测验残留的容器带 finished，而当前测验的容器还没生成，
     * 于是"全部已完成"成立 → 把没做的测验判成已完成、直接跳章。
     * 也不再用 .task-condition 是否隐藏（那个元素经常天生就是隐藏的）。 */
    const els = quizTaskElements();
    if (els.length && els.some(taskDoneMark)) {
      CX.debug('任务点判定=完成（任务条项标记已完成）');
      return true;
    }

    /* ② 站点自己写的状态文案：「任务点已完成」（绿色）。
     * 未完成时站点显示的是橙色「任务点」，不含"已完成"，不会误判。
     * 必须用 findByText（内部走 XPath + CX.visible 检查）逐个验证**可见性**，
     * 不能把整页文本拼起来做正则 —— 2026-10-28 实测：<script> 里的字符串、
     * 以及本插件 probe 写在隐藏 div 里的诊断 JSON 都含"任务点已完成"，会被误读。 */
    for (let di = 0; di < docsAll().length; di++) {
      try {
        const hit = CX.findByText(['任务点已完成', '任务点全部完成'], docsAll()[di], { maxLen: 30 });
        if (hit) {
          CX.debug('任务点判定=完成（可见文案：任务点已完成）');
          return true;
        }
      } catch (e) {}
    }

    /* ③ 记住：**每题的对勾/叉和「查看作答记录」不能当作"任务点完成"的证据** ——
     * 它们只代表"这份卷子被批阅过"，没及格时同样会有（用户截图：我的答案 B ✓ + 未达到及格线）。
     * 所以到这一步就明确判未完成。 */
    /* 诊断（2026-10-30）：光说"没有证据"定位不了问题，这里把实际看到的候选元素打出来：
     *   候选 0 个  → 任务条不在本帧可访问的文档里（跨域 iframe 只能看父链）
     *   候选有但 done=false → 标记挂在意料之外的元素上，看 dump 里的 class/aria 就能对上 */
    try {
      if (Date.now() - taskDumpAt > 5000) {
        taskDumpAt = Date.now();
        const dump = els.slice(0, 6).map(function (el) {
          const ic = el.querySelector && el.querySelector('[aria-label]');
          return {
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 40),
            aria: String(el.getAttribute('aria-label') || '').slice(0, 20),
            icAria: ic ? String(ic.getAttribute('aria-label') || '').slice(0, 20) : '',
            done: taskDoneMark(el),
            txt: CX.oneLine(String(el.textContent || '')).slice(0, 16)
          };
        });
        CX.debug('任务点判定=未完成；本帧=' + String(location.href).split('?')[0] +
          ' 可访问文档=' + docsAll().length + ' 候选=' + els.length + ' ' + JSON.stringify(dump));
      }
    } catch (e) {}
    CX.debug('任务点判定=未完成（没有"任务点已完成"的证据）');
    return false;
  }

  async function waitQuizTaskDone(timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 15000)) {
      /* 暂停（总开关关掉）时立刻退出 */
      if (!CX.cfg.enabled) return false;
      if (quizTaskDone()) return true;
      /* 2026-10-28：站点已经给出结果（出现「未达到及格线，请重做」/已批阅标记）时
       * 不用再傻等——实测白等满 20 秒才去点弹窗，用户感受就是"好慢"。
       * 现在一有结果就返回，由外层立刻去点「确定」重做。 */
      if (hasReviewSigns()) return false;
      await CX.sleep(800);
    }
    return quizTaskDone();
  }

  function isReviewPage() {
    if (/YiPiYue|selectWorkQuestion|work\/view/i.test(location.href)) return true;
    /* 2026-10-28：必须真的存在**可见**题目容器，才可能是"已批阅"页。
     * 否则视频页里预载（display:none）的测验模板 + 残留文案会让它误判成批阅页，
     * 进而广播"测验通过"，把整章视频直接跳过 —— 这是"所有视频都直接跳"的根因之一。 */
    const boxes = CX.qsa('.questionLi, .TiMu, .Py-mian1, .questionWrap, .question-item').filter(CX.visible).length;
    if (!boxes) return false;
    const t = CX.oneLine(CX.pageText(document.body)).slice(0, 800);
    /* 关键：同一页里显示「本次成绩…」不算批阅页——
     * 只要还有提交按钮，就说明这是还在作答的卷子，要走重做重答流程 */
    if (!/本次成绩|我的答案|正确答案|已批阅/.test(t)) return false;
    return !P.findSubmitButton();
  }

  /* 交卷后站点会导航到「查看已批阅作业」新文档，旧帧随之销毁，
   * 所以通过信号要在批阅页这一侧补发，否则导航不会继续。 */
  let reviewNotified = '';
  function handleReviewPage() {
    if (!isReviewPage()) return false;
    /* 2026-10-28：判定改成「任务点是否完成」，不再拿分数/及格线说话 */
    let done = quizTaskDone();
    /* 2026-10-30：实测该站点在这个页面上**根本不给任务条任何完成标记**
     * （dump：任务条项 aria/里层图标/class 全空，只有 active/prev_white）。
     * 只看任务点会永远判未完成 → 每 1.5 秒刷一次未完成 → 顶层等 12 秒后误切章。
     * 折中：已批阅页（URL 命中 YiPiYue/selectWorkQuestion，且有成绩/我的答案，
     * 且没有「未达到及格线/请重做」）按已完成处理。 */
    if (!done) {
      try {
        const t = CX.oneLine(CX.pageText(document.body)).slice(0, 1200);
        const hasResult = /本次成绩|我的答案|正确答案|已批阅|查看作答记录/.test(t);
        const failed = /未达到及格线|请重做|不及格/.test(t);
        if (hasResult && !failed) {
          done = true;
          CX.info('已批阅页没有任务点标记，但存在成绩/答案且没有「未达到及格线」→ 按已完成处理');
        }
      } catch (e) {}
    }
    if (done) {
      st.finished = true;
      if (reviewNotified !== location.href) {
        reviewNotified = location.href;
        CX.info('已批阅页：学习测验任务点已完成 → 判定通过，通知导航继续');
        try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (e) {}
        try { chrome.storage.local.remove([ATTEMPT_KEY]); } catch (e) {}
        CX.status('✅ 学习测验任务点已完成', { busy: false, phase: 'exam' });
        try { chrome.runtime.sendMessage({ kind: 'exam:passed', url: location.href }); } catch (e) {}
      }
      return true;
    }
    /* 任务点还没完成：有重做按钮就点重做 */
    const redo = P.findRetryButton();
    if (redo && reviewNotified !== location.href) {
      reviewNotified = location.href;
      CX.info('批阅页：任务点仍未完成，点击重做');
      CX.click(redo);
    }
    return true;
  }

  /* 同一份卷子的稳定标识：及格线弹窗关掉后会回到同一个卷子，
   * 这时绝不能重置轮次和错题历史——那次回退正是「把错题喂回 AI」的那一轮。 */
  function examId() {
    const m = location.search.match(/(?:workId|workAnswerId|jobid|examId|oldWorkId)=([^&]+)/i);
    if (m) return m[1];
    return location.href.split('?')[0];
  }

  /* 弹窗按文字分类，避免把「未通过」这种正文误当成弹窗 */
  function visibleDialogText() {
    const docs = [document];
    try {
      (CX.walkAccessibleParents() || []).forEach(function (w) {
        try { if (w.document && docs.indexOf(w.document) < 0) docs.push(w.document); } catch (e) {}
      });
    } catch (e) {}
    let text = '';
    docs.forEach(function (d) {
      CX.qsa('.layui-layer, .dialog, .modal, .ant-modal, .swal2-popup, [class*="dialog"], [class*="Dialog"], [class*="popup"], [class*="confirm"], [class*="mask"]', d)
        .filter(CX.visible)
        .forEach(function (el) { text += ' ' + CX.oneLine(el.innerText || ''); });
    });
    return text.slice(0, 800);
  }

  function dialogKind() {
    const t = visibleDialogText();
    if (!t) return '';
    if (/未达到及格线|请重做|不及格|成绩不合格|请重新作答/.test(t)) return 'fail';
    if (/确认提交|确定提交|是否提交|提交试卷/.test(t)) return 'confirm';
    if (/任务点未完成|是否去完成/.test(t)) return 'unfinished';
    if (/笔记未保存|是否保存/.test(t)) return 'note';
    if (/上限|知道了/.test(t)) return 'notice';
    return '';
  }

  /* 状态持久化：点「重做」后站点会整个重载答题文档，
   * 内存里的轮次/错题历史会丢失，所以落到 sessionStorage（同标签页同帧可跨刷新） */
  const ATTEMPT_KEY = 'cxExamAttempt';
  const ATTEMPT_TTL = 45 * 60 * 1000;

  function saveAttempt() {
    const payload = {
      examId: examId(),
      round: st.round,
      history: st.history || [],
      at: Date.now()
    };
    try { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(payload)); } catch (e) {}
    /* 双保险：sessionStorage 在「换 frame 重开」时也可能丢，再存一份到扩展存储 */
    try { chrome.storage.local.set({ [ATTEMPT_KEY]: payload }); } catch (e) {}
  }

  /* 同步读回上一轮（sessionStorage）。2026-10-28 补上：以前 loadAttemptAsync() 第一行就
   * 调用这个不存在的函数，一进来就 ReferenceError；restoreAttempt() 又被无参调用，
   * 于是存下来的轮次/错题历史从来没被用上 —— 点一次「重做」就等于从头开始。 */
  function loadAttempt() {
    try {
      const raw = sessionStorage.getItem(ATTEMPT_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || o.examId !== examId()) return null;
      if (!o.at || Date.now() - o.at > ATTEMPT_TTL) return null;
      return o;
    } catch (e) { return null; }
  }

  async function loadAttemptAsync() {
    const local = loadAttempt();
    if (local) return local;
    try {
      const res = await chrome.storage.local.get([ATTEMPT_KEY]);
      const o = res && res[ATTEMPT_KEY];
      if (!o || o.examId !== examId()) return null;
      if (!o.at || Date.now() - o.at > ATTEMPT_TTL) return null;
      try { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(o)); } catch (e) {}
      return o;
    } catch (e) { return null; }
  }

  function restoreAttempt(o) {
    if (!o || !o.round) return false;
    st.round = o.round;
    /* 2026-10-28：历史里的错题标记要校验。
     * 实测踩过：某一轮判分时图标还没渲染出来（或显示的是上一份卷子），
     * 存下了 ["第1、4、5 题"] 这种脏数据，恢复后继续拿它去联网检索 → 一顿瞎搜。
     * 规则：错题数不可能 ≥ 题数，超过一半就当不可靠、整个丢掉（宁可当"没错题"）。 */
    st.history = (Array.isArray(o.history) ? o.history : []).map(function (h) {
      if (!h) return h;
      const w = Array.isArray(h.wrongIndexes) ? h.wrongIndexes : [];
      const total = h.answers ? Object.keys(h.answers).length : 0;
      /* 2026-10-31：阈值只对 >=5 题的卷子生效。3 题的章节测验错 2 题是常态，
       * 以前会因此把整轮标记清零 → 下一轮又"没有错题标记"。 */
      if (total >= 5 && w.length && w.length >= Math.max(2, Math.ceil(total * 0.6))) {
        CX.warn('历史错题标记不可靠（' + w.length + '/' + total + ' 题），本轮不使用它');
        return { round: h.round, answers: h.answers, score: h.score, passed: h.passed, wrongIndexes: [], halfIndexes: [] };
      }
      return h;
    });
    st.examId = o.examId;
    CX.info('从上次中断处继续：已是第 ' + st.round + ' 轮，保留 ' + st.history.length + ' 条作答历史');
    return true;
  }

  /* AI 连续几轮没过 → 带着「错题 + 上次所选答案 + 联网检索到的资料」再问一次。
   * 不再用枚举法（会重复、也没依据）。 */
  async function searchForQuestion(q) {
    try {
      const query = (q.stem || '').replace(/\s+/g, ' ').slice(0, 80);
      if (!query) return '';
      const res = await new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage({ kind: 'webSearch', query: query }, function (r) {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(r || null);
          });
        } catch (e) { resolve(null); }
      });
      if (!res || !res.ok || !res.snippets || !res.snippets.length) {
        CX.debug('联网搜索无结果：' + query.slice(0, 30));
        return '';
      }
      return res.snippets.slice(0, 3).join('\n').slice(0, 900);
    } catch (e) { return ''; }
  }

  async function answerWithSearch(qs, wrongIdx) {
    const limit = Number(cfg().maxSearchQuestions || 3);
    const searchResults = [];
    /* 2026-10-28：没有可靠的错题标记时**不要瞎检索**。
     * 旧代码会退化成"拿前 3 题去搜"，用户实测：只错 1 题却去搜第 1/4/5 题，纯浪费 token。 */
    const targets = (wrongIdx && wrongIdx.length ? wrongIdx : []).slice(0, limit);
    if (!targets.length) {
      CX.info('没有可靠的错题标记 → 跳过联网检索，直接带反馈重答');
      return await answerAll(qs, null);
    }
    for (let n = 0; n < targets.length; n++) {
      const i = targets[n];
      const q = qs[i];
      if (!q) continue;
      CX.status('联网检索第 ' + (i + 1) + ' 题…', { busy: true, phase: 'exam' });
      const snippets = await searchForQuestion(q);
      if (snippets) {
        searchResults.push({ index: i, stem: q.stem, snippets: snippets });
        CX.info('已检索到第 ' + (i + 1) + ' 题的参考资料');
      }
      await CX.sleep(300);
    }
    const last = (st.history || [])[st.history.length - 1];
    const wrongQuestions = [];
    qs.forEach(function (q, i) {
      const isWrong = wrongIdx && wrongIdx.length ? wrongIdx.indexOf(i) >= 0 : true;
      if (!isWrong) return;
      const isHalf = !!(last && last.halfIndexes && last.halfIndexes.indexOf(i) >= 0);
      wrongQuestions.push({
        index: i,
        stem: q.stem,
        type: q.type,
        options: q.options.map(function (o) { return { label: o.label, text: o.text }; }),
        previouslyChosen: (last && last.answers && last.answers[i]) || [],
        partial: isHalf || undefined,
        hint: isHalf ? '这题上次是「部分正确」：所选的选项都是对的，只是有漏选。请在已选基础上补充，不要改掉已选的。' : undefined
      });
    });
    return await answerAll(qs, {
      note: '上次作答未通过。下面是判错的题目、你上次选择的（错误）答案，以及从网上检索到的资料。' +
        '请结合资料重新判断，必须给出与上次不同的答案，并说明依据。' +
        '注意：标注 partial 的题是「部分正确」——已选的都对、只是漏选，应当补充而不是替换。',
      wrongQuestions: wrongQuestions,
      searchResults: searchResults
    });
  }

  function pageKey() {
    /* 同一页面上的测验只处理一次；重做/刷新后 URL 或题目内容变化才重新开始 */
    const qs = P.collect(P.SEL.examBox, { generic: false });
    const sig = qs.map(function (q) { return q.mark.length; }).join(',') + '|' + qs.length;
    return location.href.split('#')[0] + '|' + sig;
  }

  function isExamContext() {
    if (cfg().enabled === false || !CX.cfg.enabled) return false;
    if (!P.looksLikeExamPage()) return false;
    /* 正式考试页默认不自动作答（避免影响真实成绩），可在设置里打开 */
    if (cfg().allowRealExam !== true && /exam-ans|exam\/test|examtopic|\/exam\//i.test(location.href)) {
      if (!st.examSkipLogged) {
        st.examSkipLogged = true;
        CX.info('检测到正式考试页面，默认不自动作答（可在设置中开启「正式考试自动作答」）');
      }
      return false;
    }
    /* 单题弹层（视频弹题）交给 videoQuiz；弹层里多题则按整卷处理 */
    const popup = P.findVideoQuizBox && P.findVideoQuizBox();
    if (popup && P.popupQuestionGroups(popup) < 2) return false;
    return true;
  }

  /* ---------------- AI ---------------- */
  function packQuestions(qs, from, to) {
    return qs.slice(from, to).map(function (q, i) {
      return {
        index: from + i,
        type: q.type,
        typeText: q.typeText,
        stem: q.stem,
        options: q.options.map(function (o) { return { label: o.label, text: o.text }; })
      };
    });
  }

  async function askChunk(qs, from, to, feedback) {
    const payload = {
      task: 'exam',
      questions: packQuestions(qs, from, to),
      feedback: feedback || null
    };
    const res = await CX.chat(payload);
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'AI 无响应' };
    let answers = res.answer && (res.answer.answers || res.answer);
    if (!Array.isArray(answers)) return { ok: false, error: 'AI 返回格式不正确' };
    const map = {};
    answers.forEach(function (a) {
      if (!a) return;
      const idx = typeof a.index === 'number' ? a.index : null;
      if (idx === null) return;
      const q = qs[idx];
      const isText = !!(q && (q.type === 'fill' || q.type === 'text'));
      let choices = a.choices !== undefined ? a.choices : (a.answer !== undefined ? a.answer : a.value);

      if (isText) {
        /* 2026-10-28 修复：以前这里一律 filter(/^[A-Z]$/)，填空/简答的中文答案被整条丢掉，
         * 最后兜底又往空格里写了个 "A"（等于必错）。文本类答案要原样保留。 */
        let v;
        if (Array.isArray(choices)) v = choices.map(function (s) { return String(s).trim(); }).filter(Boolean);
        else v = String(choices == null ? '' : choices).split(/[|｜;；\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
        if (v.length) map[idx] = v;
        return;
      }

      if (typeof choices === 'string') {
        const m = choices.toUpperCase().match(/[A-Z]/g);
        choices = m ? m : [choices];
      }
      map[idx] = (Array.isArray(choices) ? choices : [choices])
        .map(function (c) { return String(c).toUpperCase().trim(); })
        .filter(function (c) { return /^[A-Z]$/.test(c); });
    });
    return { ok: true, map: map };
  }

  /* 只有选择题型适合用「字母答案」缓存（填空/主观题缓存的是文本，别拿字母去填空） */
  function cacheable(q) {
    return q.type === 'single' || q.type === 'multi' || q.type === 'judge' || q.type === 'unknown';
  }

  function normalizeCached(hit) {
    const raw = (hit && hit.answer !== undefined) ? hit.answer : hit;
    if (raw == null) return null;
    let arr = Array.isArray(raw) ? raw : [raw];
    arr = arr.map(function (c) { return String(c).toUpperCase().trim(); }).filter(function (c) { return /^[A-Z]$/.test(c); });
    return arr.length ? arr : null;
  }

  async function answerAll(qs, feedback) {
    const batch = 8;
    const all = {};

    /* ① 先查答案缓存：同一题干+选项以前答对过就直接用。
     * 2026-10-28 修复：rememberAnswer 一直在往 cxAnswerBank 写，但从来没人读
     * （CX.askAnswer 全项目零调用），所以"答案缓存"以前是纯摆设。 */
    let cacheHit = 0;
    for (let i = 0; i < qs.length; i++) {
      if (!cacheable(qs[i])) continue;
      let hit = null;
      try { hit = await CX.askAnswer('q:' + qs[i].mark); } catch (e) { hit = null; }
      const arr = normalizeCached(hit);
      if (arr) { all[i] = arr; cacheHit++; }
    }
    if (cacheHit) CX.info('答案缓存命中 ' + cacheHit + '/' + qs.length + ' 题（省 ' + cacheHit + ' 次 AI 调用）');

    /* ② 暴力枚举模式（exam.mode='brute'）：不调用 AI，直接给每题换一个「还没试过」的答案。
     *   2026-10-28：这个选项以前只在设置页露脸 —— bruteAnswers() 定义了却零调用，
     *   于是「选了没效果」。每轮提交前 run() 会把本轮答案推进 st.history，
     *   nextUnusedCombo() 因此能在下一轮自然换到下一个候选（缓存命中过的题不动）。 */
    if (mode() === 'brute') {
      const b = bruteAnswers(qs);
      let filled = 0;
      Object.keys(b).forEach(function (k) {
        if (!all[k] || !all[k].length) { all[k] = b[k]; filled++; }
      });
      CX.info('暴力枚举模式：本轮给 ' + filled + ' 题换「没试过」的答案（不调用 AI）');
      return all;
    }

    /* ③ 剩下的按「连续区间」分批问 AI（askChunk 只吃连续 from/to） */
    let i = 0;
    while (i < qs.length) {
      if (!CX.cfg.enabled) break;            /* 暂停：不再继续问 AI */
      while (i < qs.length && all[i]) i++;
      if (i >= qs.length) break;
      let end = i;
      while (end < qs.length && !all[end] && (end - i) < batch) end++;
      CX.status('AI 正在作答：第 ' + (i + 1) + '-' + end + ' / ' + qs.length + ' 题', { busy: true, phase: 'exam' });
      let res = await askChunk(qs, i, end, feedback);
      if (!res.ok) {
        /* 重试一次 */
        await CX.sleep(1500);
        res = await askChunk(qs, i, end, feedback);
      }
      if (!res.ok) {
        CX.error('AI 作答失败：' + res.error);
        /* 整批猜 A / 全选前两项，保证能交卷 */
        for (let k = i; k < end; k++) {
          const q = qs[k];
          all[k] = q.type === 'multi' ? [q.options[0] ? q.options[0].label : 'A', q.options[1] ? q.options[1].label : 'B'] : [q.options[0] ? q.options[0].label : 'A'];
        }
      } else {
        Object.keys(res.map).forEach(function (k) { all[k] = res.map[k]; });
        for (let k = i; k < end; k++) {
          if (!all[k] || !all[k].length) all[k] = [q0(qs[k])];
        }
      }
      i = end;
    }
    return all;
  }

  function q0(q) { return q.options[0] ? q.options[0].label : 'A'; }

  /* ---------- 错题反馈 / 枚举 ---------- */
  const LETTERS = 'ABCDEFGH';

  function optCount(q) { return Math.min(q.options.length || 4, LETTERS.length); }

  function keyOf(arr) {
    return (arr || []).map(function (c) { return String(c).toUpperCase(); }).sort().join('');
  }

  /* 某题所有可能答案（单选=单字母；多选=各种组合，单元素优先） */
  function allCombos(q) {
    const n = optCount(q);
    if (q.type !== 'multi') {
      return LETTERS.slice(0, n).split('').map(function (c) { return [c]; });
    }
    const out = [];
    for (let mask = 1; mask < (1 << n); mask++) {
      const set = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) set.push(LETTERS[i]);
      out.push(set);
    }
    out.sort(function (a, b) {
      if (a.length !== b.length) return a.length - b.length;
      return a.join('') < b.join('') ? -1 : 1;
    });
    return out;
  }

  function usedFor(qIdx) {
    const used = {};
    (st.history || []).forEach(function (h) {
      const a = h && h.answers && h.answers[qIdx];
      if (a && a.length) used[keyOf(a)] = 1;
    });
    return used;
  }

  /* 从 arr 里取 k 个的全部组合 */
  function combosOf(arr, k) {
    const out = [];
    (function walk(start, cur) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); walk(i + 1, cur); cur.pop(); }
    })(0, []);
    return out;
  }

  /* 确定性试探：给定题目、上一轮答案、已提交过的组合，推下一个该试的答案。
   * mode='half'  → 半对，已选的都对，只加不减：先从"加 1 个"开始，再"加 2 个"…
   * mode='wrong' → 判错，组合里有不对的：先从"删 1 个"开始，逐级缩小
   * 判断题 / 两选项单选 → 直接换另一个；多选项单选 → 交给 AI（猜的成本太高）
   * 返回 null 表示没有候选了（交给 AI） */
  function nextRetryAnswer(q, prev, tried, mode) {
    const labels = ((q && q.options) || []).map(function (o) { return o.label; });
    if (!labels.length) return null;
    const base = (prev || []).filter(function (l) { return labels.indexOf(l) >= 0; }).slice().sort();
    const triedSet = Object.create(null);
    (tried || []).forEach(function (k) { triedSet[k] = 1; });
    function pick(list) {
      for (let i = 0; i < list.length; i++) {
        const c = list[i].slice().sort();
        if (!c.length) continue;
        if (!triedSet[keyOf(c)]) return c;
      }
      return null;
    }
    /* 2026-10-31：题型判定不可全信（站点多选的 type 偶尔被解析成 single/unknown）。
     * 只要"上一轮提交过 2 个以上选项"，就按多选处理 —— 这一条把真机上"确定性试探 0"修掉。 */
    const multi = q.type === 'multi' || (Array.isArray(base) && base.length > 1);
    if (!multi) {
      if (labels.length > 2) return null;
      const others = labels.filter(function (l) { return base.indexOf(l) < 0; });
      return pick(others.map(function (l) { return [l]; }));
    }
    if (mode === 'half') {
      const extra = labels.filter(function (l) { return base.indexOf(l) < 0; });
      for (let k = 1; k <= extra.length; k++) {
        const got = pick(combosOf(extra, k).map(function (c) { return base.concat(c); }));
        if (got) return got;
      }
      return null;
    }
    /* 判错的多选：只知道"这个组合不对"，删哪个/加哪个都是猜（真机实测乱删只会更差），
     * 交给 AI 判断，别在这浪费轮次。 */
    return null;
  }

  function nextUnusedCombo(q, qIdx) {
    const used = usedFor(qIdx);
    const all = allCombos(q);
    for (let i = 0; i < all.length; i++) {
      if (!used[keyOf(all[i])]) return all[i];
    }
    return null;
  }

  /* 拿到 AI 答案后：只对「上一轮被判错」的题强制换答案。
   * 不能对所有题都换——答对的题 AI 会给同样答案，换掉反而错了。 */
  function avoidRepeat(qs, answers) {
    const last = (st.history || [])[st.history.length - 1];
    if (!last) return answers;
    const wrongIdx = (last.wrongIndexes && last.wrongIndexes.length) ? last.wrongIndexes : null;
    if (!wrongIdx) {
      CX.debug('上一轮没有判分标记（pending 或没记录），不做强制换答案');
      return answers;
    }
    /* 2026-10-28：**部分正确（多选漏选）的题不要换答案**。
     * 那种题"选的都对、只是漏了"，正确做法是在已选基础上补充，
     * 机械换一个反而会把对的选项丢掉（用户明确说明的语义）。 */
    const halfIdx = (last.halfIndexes && last.halfIndexes.length) ? last.halfIndexes : [];
    const out = {};
    Object.keys(answers).forEach(function (k) {
      const i = Number(k);
      const q = qs[i];
      const cur = answers[k] || [];
      const prev = last.answers && last.answers[i];
      const isWrong = wrongIdx.indexOf(i) >= 0;
      const isHalf = halfIdx.indexOf(i) >= 0;
      if (q && isWrong && !isHalf && prev && prev.length && keyOf(cur) === keyOf(prev)) {
        const alt = nextUnusedCombo(q, i);
        if (alt) {
          CX.info('第 ' + (i + 1) + ' 题与上轮错答相同（' + keyOf(cur) + '），换为 ' + keyOf(alt));
          out[k] = alt;
          return;
        }
      }
      out[k] = cur;
    });
    return out;
  }

  /* 枚举模式：每题都取一个没试过的答案。
   * 2026-11-06：候选为空时不再静默回退第一个选项 —— 那会让 12 轮全交同一份卷子，
   * 日志却写着"换了一个没试过的答案"。现在区分「组合试完了（从头轮）」和
   * 「选项根本没解析出来（只能盲填）」，后者会 warn 出来。 */
  function bruteAnswers(qs) {
    const out = {};
    const noCand = [];
    qs.forEach(function (q, i) {
      const c = nextUnusedCombo(q, i);
      if (c && c.length) { out[i] = c; return; }
      const all = allCombos(q);
      if (all && all.length) { out[i] = all[0]; return; }
      out[i] = [q0(q)];
      noCand.push(i + 1);
    });
    if (noCand.length) {
      CX.warn('暴力枚举：第 ' + noCand.join('、') + ' 题拿不到候选组合（选项没解析出来），只能盲填第一个选项');
    }
    return out;
  }

  /* ---------------- 填答 ---------------- */
  async function fillAnswers(qs, answers) {
    const delay = cfg().randomDelayMs || 300;
    for (let i = 0; i < qs.length; i++) {
      /* 暂停：立刻停手，不再往下填题（原来会填完整张卷子再交） */
      if (!CX.cfg.enabled) { CX.info('已暂停，停止填题'); return false; }
      const q = qs[i];
      const choices = answers[i] || [];
      if (!choices.length) continue;
      if (q.type === 'fill' || q.type === 'text') {
        P.applyBlanks(q, choices.join(' '));
      } else {
        P.applyChoices(q, choices);
      }
      if (delay > 0) await CX.sleep(CX.jitter(delay, 0.6));
    }
  }

  /* ---------------- 提交 ---------------- */
  /* 找「确认提交?」弹窗里的确认按钮。
   * 不依赖弹窗 class：从可见的「提交/确定/确认」按钮往上找 3 层，
   * 只要祖先文字里出现「确认提交?」就认定它是确认按钮；「取消」永不点。 */
  function findSubmitConfirmButton(loose, excludeEl) {
    const docs = [document];
    try {
      (CX.walkAccessibleParents() || []).forEach(function (w) {
        try { if (w.document && docs.indexOf(w.document) < 0) docs.push(w.document); } catch (e) {}
      });
    } catch (e) {}
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const btns = CX.qsa('button, a, div, span, input[type="button"], input[type="submit"]', d).filter(function (el) {
        if (!CX.visible(el)) return false;
        /* 页面上那个「提交」按钮本身不算确认按钮 */
        if (excludeEl && (el === excludeEl || excludeEl.contains(el) || el.contains(excludeEl))) return false;
        const s = CX.oneLine(el.innerText || '') || String(el.value || '');
        return /^(提交|确定|确认|OK)$/.test(s);
      });
      for (let k = 0; k < btns.length; k++) {
        const el = btns[k];
        let scope = el.parentElement, hops = 0, hit = false;
        while (scope && hops < 4) {
          const t = CX.oneLine(scope.innerText || '');
          /* 弹窗容器文字很短；正文/整页文字很长，不能当弹窗 */
          if (t.length <= 220 && /确认提交|确定提交|是否提交|提交试卷|确认交卷/.test(t)) { hit = true; break; }
          if (/未达到及格线|请重做|不及格|已批阅|我的答案/.test(t)) break;
          scope = scope.parentElement; hops++;
        }
        if (hit) return el;
      }
      if (!loose) {
        const boxes = CX.qsa('.layui-layer, .dialog, .modal, .ant-modal, .swal2-popup, [class*="dialog"], [class*="popup"], [class*="confirm"], [class*="layer"]', d)
          .filter(CX.visible);
        for (let k = 0; k < boxes.length; k++) {
          const t = CX.oneLine(boxes[k].innerText || '');
          if (!/确认提交|确定提交|是否提交|提交试卷|确认交卷/.test(t)) continue;
          const direct = CX.firstOf(P.SEL.confirmBtn, boxes[k]);
          if (direct && CX.visible(direct)) return direct;
        }
      }
    }
    return null;
  }

  /* 站点对同一份作业有提交次数上限（表单里的 addTimes / limitWorkSubmitTimes），
   * 超限后 btnBlueSubmit 会转入 showWorkVerify() 弹验证码。快到上限就刹车，
   * 不要把账号推进验证态。 */
  function submitQuotaLeft() {
    try {
      const a = document.querySelector('#addTimes');
      const l = document.querySelector('#limitWorkSubmitTimes');
      const add = parseInt((a && a.value) || '0', 10) || 0;
      const lim = parseInt((l && l.value) || '100', 10) || 100;
      return { add: add, limit: lim, left: lim - add };
    } catch (e) { return null; }
  }

  /* 提交后页面是否已经真的进入「批阅过」的状态 —— 用来判断"这次提交到底成没成"。
   * 2026-10-28：去掉 /回答正确|回答错误/（题干里「下列回答正确的有」会命中 → 误判已提交），
   * 并把「任务点已完成」也算作明确信号。 */
  function hasReviewSigns() {
    try {
      /* 2026-10-28：跨全部可访问文档判断。站点常把「未达到及格线」提示 / 批阅标记
       * 放在父文档或另一个 iframe 里，只看本帧会误判"提交没成功" → 白补交一次。
       * （日志实证：14:57 那次 addTimes 没涨但页面其实已经出现提示，结果补交 + 刷新。） */
      const docs = docsAll();
      for (let i = 0; i < docs.length; i++) {
        try {
          if (docs[i].querySelector('.marking_dui, .marking_cuo, .CorrectOrNot')) return true;
        } catch (e) {}
      }
      if (quizTaskDone()) return true;
      for (let i = 0; i < docs.length; i++) {
        /* pageText 而不是 textContent：站点内联脚本里有 I18N 语言包（"未达到及格线，请重做"
         * 就写在里面），用 textContent 会永远命中 → 误判"已经提交成功"。 */
        const b = docs[i].body;
        const t = CX.oneLine(CX.pageText ? CX.pageText(b) : (b ? b.textContent : ''));
        if (/未达到及格线|请重做|已批阅|我的答案|本次成绩/.test(t)) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  async function submit() {
    st.lastSubmitAddDelta = 0;
    const quota = submitQuotaLeft();
    const addBefore = quota ? quota.add : null;
    if (quota && quota.left <= 1) {
      st.finished = true;
      CX.warn('提交配额仅剩 ' + quota.left + ' 次（' + quota.add + '/' + quota.limit + '），已停止自动提交，避免触发验证码');
      CX.status('⚠ 提交次数将用尽，已停止自动提交', { busy: false, phase: 'exam' });
      return false;
    }
    const btn = P.findSubmitButton();
    /* 站点「提交」是 <a href="javascript:void(0);" onclick="btnBlueSubmit();">。
     * 页面 CSP 没有 'unsafe-inline'，内联 onclick 和 javascript: URL 都被拒绝，
     * 合成点击永远无效（实测：点了页面毫无反应，多轮全部卡在这里）。
     * 因此改由 MAIN world 直接调用站点自己的函数链。 */
    const probe = CX.mainCall('findSubmit');
    const mainReady = !!(probe && probe.ok && probe.hasFn);

    if (!btn && !mainReady) { CX.warn('未找到提交按钮'); return false; }

    CX.info('提交试卷' + (mainReady ? '（主世界调用 btnBlueSubmit）' : ''));
    if (mainReady) {
      const r = CX.mainCall('submitClick');
      if (!r || !r.ok) CX.warn('主世界调用提交失败：' + ((r && r.err) || 'unknown'));
    } else {
      CX.click(btn);
    }
    await CX.sleep(1000);

    if (mainReady) {
      /* btnBlueSubmit 之后站点弹 workPop「确认提交？」。
       * 优先点它里面的「提交」——那是 JS 绑定（不是内联 onclick），合成点击大概率有效，
       * 而且点完弹窗会自己消失，流程和真人一致。
       * 只有点不动时才强调它的回调 submitCheckTimes()（等价于点确认，但弹窗不会自动关）。 */
      await CX.sleep(400);
      /* 判断「确认弹窗还在不在」不能用 findSubmitConfirmButton(true)：
       * loose 模式只查 P.SEL.confirmBtn（.layui-layer-btn0 / .popok 那一类），
       * 而 workPop 的按钮是 A.jb_btn，class 根本不在列表里 → 永远找不到 → 误判"弹窗已关"
       * → 跳过兜底 submitForce（实测日志点了确认，但提交请求一条都没发）。
       * 直接看弹窗容器 #confirmSubWin 是否可见，跨文档找。 */
      function confirmWinVisible() {
        const docs = [];
        try {
          (CX.walkAccessibleParents() || []).forEach(function (w) {
            try { if (w.document) docs.push(w.document); } catch (e) {}
          });
        } catch (e) {}
        if (docs.indexOf(document) < 0) docs.unshift(document);
        for (let i = 0; i < docs.length; i++) {
          let el = null;
          try { el = docs[i].querySelector('#confirmSubWin'); } catch (e) {}
          if (el && CX.visible(el)) return true;
        }
        return false;
      }

      const confirmBtn = findSubmitConfirmButton(true);
      let clickedOk = false;
      if (confirmBtn && CX.visible(confirmBtn)) {
        CX.click(confirmBtn);
        clickedOk = true;
        CX.info('已点击确认提交弹窗里的「' + (CX.oneLine(confirmBtn.innerText || '') || '提交') + '」');
        await CX.sleep(750);
      }
      if (!clickedOk || confirmWinVisible()) {
        const r2 = CX.mainCall('submitForce');
        if (r2 && r2.ok) {
          CX.info('已触发站点确认回调 submitCheckTimes（兜底，幂等）');
          await CX.sleep(600);
          if (confirmWinVisible()) {
            CX.warn('确认弹窗仍留在页面上；提交是否成功以是否跳转批阅页为准');
          }
        } else {
          CX.warn('触发确认回调失败：' + ((r2 && r2.err) || 'unknown'));
        }
      }
      /* 无论上面走没走通，最后再无条件补一次：合成点击在 workPop 上不可靠
       *（你手动点一下就交上了，程序点了却没反应），而 submitCheckTimes → confirmSubmitWork
       * 有 submitLock 保护，重复调用最多被忽略一次，不会重复交卷。 */
      const rForce = CX.mainCall('submitForce');
      if (rForce && rForce.ok) CX.debug('已补一次 submitCheckTimes（无条件兜底）');
      await CX.sleep(400);
    } else if (cfg().submitConfirm !== false) {
      /* 点完「提交」后要等弹窗出现，再点它里面的「提交」，确认弹窗消失后才继续 */
      let clicked = false;
      for (let t = 0; t < 18; t++) {
        await CX.sleep(300);
        const ok = findSubmitConfirmButton(t < 3, btn);
        if (!ok) {
          if (clicked) break;      /* 已经点过且弹窗没了 → 完成 */
          continue;                /* 还没等到弹窗，继续等（最多 ~5.4 秒） */
        }
        CX.click(ok);
        clicked = true;
        CX.info('已点击确认提交弹窗里的「' + (CX.oneLine(ok.innerText || '') || '提交') + '」');
        await CX.sleep(600);
        if (!findSubmitConfirmButton(true)) break;
      }
      if (!clicked) {
        /* 诊断：把当前可见的候选按钮和弹窗文字打出来，便于定位选择器问题 */
        try {
          const cands = CX.qsa('button, a, div, span', document).filter(function (el) {
            if (!CX.visible(el)) return false;
            const s = CX.oneLine(el.innerText || '');
            return s && s.length <= 8;
          }).slice(0, 10).map(function (el) { return el.tagName + ':' + CX.oneLine(el.innerText || ''); });
          CX.debug('确认弹窗诊断: ' + JSON.stringify(cands));
        } catch (e) {}
        CX.warn('没有等到「确认提交?」弹窗（可能站点直接就提交了）');
      }
    }
    st.lastSubmitAt = Date.now();
    /* 用 addTimes 的增量确认「这次提交站点到底收没收到」：涨了 = 真收了；
     * 没涨 = 请求大概没发出去。后面的补交判断就看这个数，避免白烧配额。 */
    const after = submitQuotaLeft();
    if (addBefore !== null && after && after.add > addBefore) {
      st.lastSubmitAddDelta = after.add - addBefore;
      CX.info('站点已记一次提交（addTimes ' + addBefore + ' → ' + after.add + '）');
    }
    return true;
  }

  /* ---------------- 结果判定 ---------------- */
  /* 把「我的答案：XX」按题序取出来；判断题的 对/错 映射回 A/B */
  function mineAnswersFrom(raw) {
    const out = [];
    const re = /我的答案[：:]\s*([^\n]{0,24})/g;
    let m;
    while ((m = re.exec(String(raw || '')))) {
      const s = String(m[1] || '').replace(/\s+/g, '');
      let labels;
      if (s.indexOf('对') >= 0) labels = 'A';
      else if (s.indexOf('错') >= 0) labels = 'B';
      else labels = (s.match(/[A-Za-z]/g) || []).join('').toUpperCase().split('').sort().join('');
      out.push(labels);
    }
    return out;
  }

  /* 判分页面是不是已经更新成"本轮刚交的答案"。
   * 2026-10-31：站点提交后是原地重绘，旧勾叉会先留在 DOM 里，parseResult 会先读到上一轮的结果
   * （日志实证：判分原文里的「我的答案」总是上一轮交的）—— 拿这种标记去改答案，就是判断题来回翻的根因。 */
  function resultMatchesAnswer(result, answers, qs) {
    if (!result || !answers) return false;
    const mine = mineAnswersFrom(result.raw);
    if (!mine.length) return true;   /* 页面没有「我的答案」文本（仿真页 / 老版式）→ 无法核对，按原样接受 */
    if (mine.length < qs.length) return false;
    for (let i = 0; i < qs.length; i++) {
      const want = ((answers[i] || []).map(function (c) { return String(c).toUpperCase(); })).sort().join('');
      if (!want) continue;
      if ((mine[i] || '') !== want) return false;
    }
    return true;
  }

  /* 当前章节 id（顶层同源，从 URL 里取）与"本节是否已被放弃" */
  function topChapterId() {
    let s = '';
    try { s += ' ' + top.location.search; } catch (e) {}
    try { s += ' ' + location.search; } catch (e) {}
    const m = s.match(/(?:chapterId|knowledgeid|knowledgeId)=(\d+)/i);
    return m ? m[1] : '';
  }

  function givenUpHere() {
    try {
      const cid = topChapterId();
      const mark = String(root.top.__cxExamGiveUpChapter || '');
      return !!(cid && mark && cid === mark);
    } catch (e) { return false; }
  }
  async function waitResult(timeout, qs, answers) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < (timeout || 30000)) {
      if (!CX.cfg.enabled) break;
      const r = P.parseResult(undefined, qs);
      last = r;
      const hasMarks = r.passed !== null || r.wrongBoxes.length || r.rightBoxes.length || (r.halfBoxes && r.halfBoxes.length);
      if (hasMarks && resultMatchesAnswer(r, answers, qs)) return r;
      await CX.sleep(400);
    }
    if (!last) last = P.parseResult(undefined, qs);
    last.stale = true;
    return last;
  }

  /* 2026-10-28 删除 judgePass()：通过判定一律走 quizTaskDone()（看任务点），
   * 不再用分数/及格线决定去留。 */

  /* 「未达到及格线，请重做」弹窗：形如
   *   提示 / 未达到及格线，请重做 / [取消] [确定]
   *
   * 2026-10-28 重写（这是"弹窗一出就卡死、重做点不动"的直接原因）：
   *   旧实现在整篇文档里扫 'button,a,div,span,li' 再逐个 visible()（强制布局），
   *   几万个节点 → 一次几秒到十几秒；而且弹窗容器的 class 一旦不在名单里就永远找不到按钮，
   *   于是 redo() 返回 false、流程继续"进入第 3 轮"，每一轮都点在弹窗遮罩上 —— 表现就是死循环。
   *   新做法：XPath 先锁定「含提示文字的那个元素」→ 向上取小容器 → 只在容器内找按钮。 */
  /* 从**顶层**向下遍历所有同源帧的文档。
   * 2026-10-28：原来只用 docsAll()（本帧 + 父链），exam 跑在 work 帧里、弹窗挂在顶层，
   * 只要父链有一层取不到 document 就永远看不到弹窗（日志：「没有及格线弹窗」但弹窗明明在）。
   * 从 top 往下走，兄弟帧也能覆盖到。 */
  function allDocsDeep() {
    const out = [];
    const seen = [];
    function walk(w) {
      let d = null;
      try { d = w.document; } catch (e) { return; }
      if (!d || seen.indexOf(d) >= 0) return;
      seen.push(d);
      out.push(d);
      let n = 0;
      try { n = w.frames.length; } catch (e) { n = 0; }
      for (let i = 0; i < n && i < 40; i++) {
        try { walk(w.frames[i]); } catch (e) {}
      }
    }
    try { walk(root.top || root); } catch (e) {}
    if (!out.length) { try { out.push(document); } catch (e) {} }
    return out;
  }

  function failDialogScope() {
    /* 2026-10-28 修复（第三次，这次有 DOM 证据）：
     *   doc5(work 帧) 里也有"未达到及格线"——那是标题栏状态 `.testTit_status`，没有按钮；
     *   真弹窗在 doc0(顶层)：`.popDiv.wid440.Marking`（[确定][取消]）。
     * 现在：① 从顶层向下遍历所有帧；② 某个文本节点找不到"含按钮的层"就继续找下一个，绝不提前返回；
     *      ③ 文字 >300 字的层直接放弃（整张试卷 `.RightCon` 有 6287 字、里面也有一堆确定/取消）。 */
    const docs = allDocsDeep();
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      let nodes = [];
      try { nodes = CX.xpathByText ? CX.xpathByText(d, '未达到及格线') : []; } catch (e) { nodes = []; }
      if (!nodes.length) {
        try { nodes = CX.xpathByText ? CX.xpathByText(d, '请重做') : []; } catch (e) { nodes = []; }
      }
      for (let k = 0; k < nodes.length; k++) {
        let el = nodes[k];
        for (let up = 0; up < 12 && el; up++) {
          if (el.nodeType === 1 && CX.visible(el)) {
            const tag = String(el.tagName || '').toUpperCase();
            if (tag === 'BODY' || tag === 'HTML') break;          /* 到页面根就停，别扫整页 */
            if ((el.textContent || '').length > 300) break;       /* 弹窗文案很短，长了就是整页/整卷 */
            const btns = dialogButtonsIn(el);
            if (btns.length >= 2) {
              CX.debug('弹窗定位成功：doc#' + i + ' ' + tag + '.' + String(el.className || '').slice(0, 24) + ' 按钮 ' + btns.length + ' 个');
              return { doc: d, scope: el, btns: btns };
            }
          }
          el = el.parentElement;
        }
      }
    }
    CX.debug('弹窗定位失败：遍历 ' + docs.length + ' 个文档都没找到含按钮的提示层');
    return null;
  }

  function dialogButtonsIn(scope) {
    return CX.qsa('button, a, input[type="button"], [class*="btn"], [class*="Btn"]', scope)
      .filter(function (el) {
        if (!CX.visible(el)) return false;
        const t = CX.oneLine(el.textContent || '');
        return t.length > 0 && t.length <= 6 &&
          /^(取消|确定|确认|重做|重新答题|再做一次|关闭|知道了|是|否)$/.test(t);
      });
  }

  /* 弹窗是否还在（≥2 个按钮 = 真的是那个确认弹窗，不是正文里的字） */
  function failDialogPresent() {
    const found = failDialogScope();
    if (!found) return false;
    return dialogButtonsIn(found.scope).length >= 2;
  }

  function findFailDialogButton() {
    const found = failDialogScope();
    if (!found) return null;
    const btns = dialogButtonsIn(found.scope);
    if (!btns.length) return null;
    /* 优先「确定」，其次「重做」；「取消」永不点 */
    const okBtn = btns.find(function (el) { return /^(确定|确认|重做|重新答题|再做一次)$/.test(CX.oneLine(el.textContent || '')); });
    return okBtn || null;
  }

  async function redo() {
    /* 优先处理「未达到及格线，请重做」弹窗。
     * 2026-10-28：弹窗往往比"我的答案/判分结果"晚 1~2 秒才弹出来，
     * 上来就查一次很容易落空 → 误判"没有弹窗"→ 直接进下一轮（点在遮罩上）。
     * 这里给最多 3 秒轮询。 */
    let dlg = findFailDialogButton();
    for (let i = 0; i < 6 && !dlg; i++) {
      await CX.sleep(500);
      if (!CX.cfg.enabled) return false;
      dlg = findFailDialogButton();
    }
    if (dlg) {
      CX.click(dlg);
      CX.info('点击「未达到及格线」弹窗里的重做');
      await CX.sleep(1800);
      const ok = P.findConfirmButtonAnyDoc ? P.findConfirmButtonAnyDoc() : P.findConfirmButton();
      if (ok) { CX.click(ok); await CX.sleep(800); }
      return true;
    }
    const btn = P.findRetryButton();
    if (btn) {
      CX.click(btn);
      CX.info('点击「重做」');
      await CX.sleep(1800);
      const ok = P.findConfirmButtonAnyDoc ? P.findConfirmButtonAnyDoc() : P.findConfirmButton();
      if (ok) { CX.click(ok); await CX.sleep(800); }
      return true;
    }
    return false;
  }

  /* ---------------- 主流程 ---------------- */
  async function run() {
    /* 2026-10-31：非学习页不启动答题（防止个人空间/消息页误判、误提交） */
    try {
      if (CX.isStudyContext && !CX.isStudyContext()) { st.finished = true; return; }
    } catch (e) {}
    if (st.busy || st.finished) return;
    /* 2026-10-28：点「重做」期间禁止重入。以前只靠 st.busy，而失败分支会提前把 st.busy
     * 放开去 await redo()（1.8s+），1.5 秒的轮询就会再开一轮 → 双份作答 / 双份提交。 */
    if (st.redoing) return;
    if (!isExamContext()) return;
    /* 2026-11-03：设置里开了「跳过学习检测」→ 一题都不答，直接广播跳过 */
    if (skipAnswering()) { skipNow(); return; }

    const key = examId();
    if (st.examId !== key) {
      st.examId = key;
      st.pageKey = '';
      st.round = 0;
      st.history = [];
      /* 换卷子：先看有没有上次没做完的进度。
       * 2026-10-28 修复：以前 restoreAttempt() 被无参调用（恒返回 false），而它要调的
       * loadAttempt() 根本不存在 —— 存下来的「第几轮 + 错题历史」从来没被恢复过。 */
      restoreAttempt(loadAttempt() || await loadAttemptAsync());
    }

    /* 任务点已经是「已完成」（上次已过 / 或没及格但站点算完成）→ 不再答题，直接放行导航 */
    if (quizTaskDone()) {
      st.finished = true;
      CX.info('学习测验任务点已是「已完成」，跳过作答直接继续');
      CX.status('✅ 学习测验任务点已完成', { busy: false, phase: 'exam' });
      try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (e) {}
      try { chrome.storage.local.remove([ATTEMPT_KEY]); } catch (e) {}
      try { chrome.runtime.sendMessage({ kind: 'exam:passed', url: location.href }); } catch (e) {}
      return;
    }
    /* 本节已按设置放弃（轮数用尽）→ 不再作答，交给导航切下一章 */
    if (givenUpHere()) {
      st.finished = true;
      if (!st.gaveUp) {
        st.gaveUp = true;
        CX.info('本节测验已按设置放弃，不再作答');
      }
      return;
    }

    if (st.pageKey !== pageKey()) {
      /* 同一份卷子重新打开（例如关掉及格线弹窗回到答题页）：保留轮次和错题历史 */
      st.pageKey = pageKey();
      CX.debug('同一份卷子重新进入，保留错题历史（第 ' + (st.round + 1) + ' 轮起）');
    }
    /* 轮数上限：暴力枚举每轮只试一个候选（单选 4 选项就要 4 轮），
     * 用 maxRounds 原值等于永远试不完；这里给它翻倍（默认 3 → 6 轮）。 */
    const bruteMode = mode() === 'brute';

    /* 2026-11-06：错题集合连续 3 轮一字不差 = 换答案根本没生效，再跑也是白烧配额。
     * 真机案例：12 轮错题恒为「1、2」，每轮都填 A —— 这条能提前 9 轮停手。 */
    if (st.history.length >= 3) {
      const s3 = st.history.slice(-3).map(function (h) {
        return Array.isArray(h.wrongIndexes) ? h.wrongIndexes.join(',') : null;
      });
      if (s3[0] && s3[0] === s3[1] && s3[1] === s3[2]) {
        st.finished = true;
        CX.warn('连续 3 轮错题完全相同（第 ' + s3[0] + ' 题）→ 换答案没生效，停止重试');
        CX.status('⚠ 连续 3 轮错题不变，已停手', { busy: false, phase: 'exam' });
        return;
      }
    }
    /* 枚举模式跟 AI 无关：不配 API Key 也能跑。这里明确打一次日志，
     * 免得看到"没配 Key"的提示就以为坏了（或配了 Key 却以为它在用 AI）。 */
    if (bruteMode && !st.bruteNoted) {
      st.bruteNoted = true;
      CX.info('暴力枚举模式：本页不调用 AI（配没配 API Key 都一样），每轮换一个「没试过」的答案');
    }
    const roundCap = bruteMode
      ? Math.max(Number(cfg().maxRounds || 3) * 2, 4)
      : Number(cfg().maxRounds || 10);
    if (st.round >= roundCap) {
      CX.warn('已达到最大作答轮数（' + roundCap + '），停止');
      st.finished = true;
      /* 2026-10-31：默认放弃本节 → 交给导航切下一章，别死卡在这一节（设置里可关） */
      if (cfg().giveUpToNext !== false) {
        st.gaveUp = true;
        const cid = topChapterId();
        try { if (cid) root.top.__cxExamGiveUpChapter = cid; } catch (e) {}
        CX.info('已放弃本节测验（' + roundCap + ' 轮未通过）→ 让导航切下一章' + (cid ? '，chapterId=' + cid : ''));
        CX.status('⚠ 本节测验未通过，按设置跳过', { busy: false, phase: 'exam' });
        /* 2026-10-31：把"放弃的章节"落盘，刷新后导航才知道不用再等这一章的测验入口 */
        try {
          chrome.storage.local.get(['cxGiveUpChapters'], function (r) {
            const m = (r && r.cxGiveUpChapters) || {};
            if (cid) m[cid] = Date.now();
            const now = Date.now();
            Object.keys(m).forEach(function (k) { if (now - m[k] > 86400000) delete m[k]; });
            chrome.storage.local.set({ cxGiveUpChapters: m });
          });
        } catch (e) {}
        try { chrome.runtime.sendMessage({ kind: 'exam:giveup', url: location.href, chapter: cid }); } catch (e) {}
      } else {
        CX.status('测验未通过（已达最大轮数），请人工检查', { busy: false, phase: 'exam' });
      }
      return;
    }

    st.busy = true;
    try {
      /* 没配 Key 时不要瞎猜着交卷，直接停手等用户配置。
       * 2026-11-06：AI 总开关关掉时以前会静默降级成 brute（设置页显示 AI 优先、实际跑枚举），
       * 现在直接停手 —— 提示只在设置页给（「AI 关了却选 AI 优先」会标黄），运行时不刷日志。 */
      if (mode() === 'ai-first') {
        const ai = CX.cfg.ai || {};
        if (ai.enabled === false) {
          st.finished = true;
          return;
        }
        const hasKey = !!ai.apiKey || /127\.0\.0\.1|localhost/.test(ai.baseUrl || '');
        if (!hasKey) {
          st.finished = true;
          CX.warn('未配置 AI Key，已跳过自动作答（请点扩展图标填写 API Key）');
          CX.status('⚠ 未配置 AI Key，未自动作答', { busy: false, phase: 'exam' });
          return;
        }
      }
      /* 题目文字可能被超星字体加密（.font-cxsecret），解析前先把映射建好 */
      if (CX.fontDecrypt && CX.fontDecrypt.ensure) {
        try { await CX.fontDecrypt.ensure(); } catch (e) {}
      }
      const qs = P.collect(P.SEL.examBox, {});
      if (!qs.length) {
        CX.warn('未解析到题目');
        CX.warn('结构探针: ' + JSON.stringify(P.diag()));
        return;
      }
      st.questions = qs;
      st.round++;
      CX.info('检测到题目 ' + qs.length + ' 道，第 ' + st.round + ' 轮作答');
      CX.status('学习检测：AI 作答中（第 ' + st.round + ' 轮）', { busy: true, phase: 'exam' });

      /* ===== 重做策略（2026-10-31 第二版）=====
       * 真机实测暴露的问题：半对题让 AI「补充选项」会被补成"全选"（AC → ABCD 直接判错）；
       * 判错的题又被 avoidRepeat 换成另一个组合。6 轮就在 AC / ABCD / A / ABCD 之间乱跳。
       * 现在改成：① 只动「判错 + 半对」的题；② 多选按组合空间**确定性**试探
       *          （半对只加不减，从加 1 个开始；判错从删 1 个开始）；③ 判断/单选(2 选项)直接换另一个；
       *          ④ 试探不出来才问 AI。
       * 标记语义：wrongIndexes 是数组 = 判过分（[] = 没有错题）；null/undefined = 这一轮没判分。 */
      const prevEntry = st.history[st.history.length - 1];
      const prevAnswers = (prevEntry && prevEntry.answers) || null;
      const judged = !!(prevEntry && Array.isArray(prevEntry.wrongIndexes));
      const prevWrongIdx = judged ? prevEntry.wrongIndexes.slice() : [];
      const prevHalfIdx = (prevEntry && Array.isArray(prevEntry.halfIndexes)) ? prevEntry.halfIndexes.slice() : [];
      const retryIdx = [];
      prevWrongIdx.concat(prevHalfIdx).forEach(function (i) {
        if (i >= 0 && i < qs.length && retryIdx.indexOf(i) < 0) retryIdx.push(i);
      });
      const canReuse = !!(prevAnswers && judged);
      const partial = !!(canReuse && retryIdx.length && cfg().wrongOnlyRetry !== false);

      const aiRounds = Number(cfg().maxAiRounds || 3);
      let answers = {};
      /* 2026-11-06：brute 模式必须自己走一遍（见下面的 brute 专用块）。
       * 以前这里是 `!partial`，而 partial=true（上一轮判过错题）时：
       *   ② 确定性试探被 `!bruteMode` 挡掉、③ 要求 !partial、④ 要求 needAsk —— 三处全跳过，
       *   结果 answers 是空的，fillAnswers 一题都不填，每轮提交的都是页面上残留的上一轮答案。
       * 真机日志：12 轮全是「我的答案：A」，错题恒定 1、2。 */
      let needAsk = bruteMode ? true : !partial;

      /* ① 上一轮判过分、但没有要改的题（全对却没过）→ 原样重交，别让 AI 再掷一次 */
      if (canReuse && !retryIdx.length && !bruteMode) {
        needAsk = false;
        Object.keys(prevAnswers).forEach(function (k) {
          if (prevAnswers[k] && prevAnswers[k].length) answers[k] = prevAnswers[k].slice();
        });
        CX.info('上一轮判分里没有要改的题（全对但任务点未完成）→ 沿用原答案重交');
      }

      /* ② 确定性试探：按"已经提交过的组合"推下一个候选；推不出来才留给 AI */
      const askIdx = [];
      if (partial && !bruteMode) {
        let det = 0;
        const dbg = [];
        retryIdx.forEach(function (i) {
          const tried = [];
          st.history.forEach(function (h) {
            if (h && h.answers && h.answers[i] && h.answers[i].length) tried.push(keyOf(h.answers[i].slice().sort()));
          });
          /* 历史里出现过"半对"的答案 = 已选的都对，只是漏选 → 以它为基准继续往里加，
           * 即使当前这轮被判成"错"也照样用它（否则 ABC 判错后又会被打回 AI 乱猜）。 */
          let halfBase = null;
          for (let k = st.history.length - 1; k >= 0; k--) {
            const h = st.history[k];
            if (h && Array.isArray(h.halfIndexes) && h.halfIndexes.indexOf(i) >= 0 &&
                h.answers && h.answers[i] && h.answers[i].length) {
              halfBase = h.answers[i].slice();
              break;
            }
          }
          const isHalfNow = prevHalfIdx.indexOf(i) >= 0;
          const base = isHalfNow ? ((prevAnswers && prevAnswers[i]) || []) : (halfBase || (prevAnswers && prevAnswers[i]) || []);
          const mode = (isHalfNow || halfBase) ? 'half' : 'wrong';
          const cand = nextRetryAnswer(qs[i], base, tried, mode);
          dbg.push('#' + (i + 1) + ':' + (qs[i].type || '?') + '/' + base.join('') + (cand ? '→' + cand.join('') : '→AI'));
          if (cand && cand.length) { answers[i] = cand; det++; }
          else askIdx.push(i);
        });
        qs.forEach(function (_q, i) {
          if (answers[i] === undefined && prevAnswers && prevAnswers[i] && prevAnswers[i].length) {
            answers[i] = prevAnswers[i].slice();
          }
        });
        CX.info('本轮只改 ' + retryIdx.length + ' 题（判错 ' + prevWrongIdx.length + ' / 半对 ' + prevHalfIdx.length +
          '；确定性试探 ' + det + '，问 AI ' + askIdx.length + '）' + (dbg.length ? ' [' + dbg.join(' ') + ']' : ''));
        needAsk = askIdx.length > 0;
      }

      /* ②' 暴力枚举：**只换判错的题，答对的沿用**（用户要的语义：错了就换、对了不动）。
       * 以前 bruteAnswers 对全部题取新组合，修好 needAsk 后会把已经答对的判断题也换掉；
       * 这里显式区分，避免"修好一个 bug 又造一个新的"。 */
      if (bruteMode) {
        const retrySet = {};
        retryIdx.forEach(function (i) { retrySet[i] = 1; });
        const b = bruteAnswers(qs);
        let kept = 0, changed = 0;
        qs.forEach(function (q, i) {
          const prev = prevAnswers && prevAnswers[i];
          const keepPrev = !retrySet[i] && st.round > 1 && prev && prev.length;
          if (keepPrev) { answers[i] = prev.slice(); kept++; return; }
          if (b[i] && b[i].length) { answers[i] = b[i]; changed++; }
        });
        needAsk = false;
        CX.info('暴力枚举：本轮换 ' + changed + ' 题，沿用 ' + kept + ' 题' +
          (st.round > 1 && !retryIdx.length ? '（上一轮没有判错题，全部沿用）' : ''));
      }

      /* ③ 联网检索：只在"整卷重问"时才用（试探能推进就不浪费检索） */
      if (needAsk && !bruteMode && !partial && st.round > aiRounds && cfg().useWebSearch !== false && prevWrongIdx.length) {
        CX.info('AI 连续 ' + aiRounds + ' 轮未通过，改为「联网检索后重答」（第 ' + st.round + ' 轮）');
        CX.status('联网检索错题资料并重答（第 ' + st.round + ' 轮）', { busy: true, phase: 'exam' });
        const searched = await answerWithSearch(qs, prevWrongIdx);
        if (searched && Object.keys(searched).length) {
          needAsk = false;
          answers = avoidRepeat(qs, searched);
        } else {
          CX.warn('联网重答没有拿到答案，退回带错题反馈的普通重答');
        }
      }

      /* ④ 需要问 AI 的题：首次作答 / 试探用尽 / 暴力枚举 */
      if (needAsk) {
        const toAsk = (partial && !bruteMode) ? askIdx : qs.map(function (_q, i) { return i; });
        const toAskQs = toAsk.map(function (i) { return qs[i]; });
        let feedback = null;
        if (prevEntry && cfg().wrongOnlyRetry !== false && toAsk.length) {
          const wrongList = [];
          toAsk.forEach(function (realIdx, k) {
            const isHalf = prevHalfIdx.indexOf(realIdx) >= 0;
            const isWrongQ = prevWrongIdx.indexOf(realIdx) >= 0;
            const q = qs[realIdx];
            const entry = {
              index: k,
              stem: q.stem,
              type: q.type,
              options: q.options.map(function (o) { return { label: o.label, text: o.text }; }),
              previouslyChosen: (prevAnswers && prevAnswers[realIdx]) || []
            };
            if (isHalf) {
              entry.partial = true;
              entry.hint = '这题上次是「部分正确」：已选的都对，只是有漏选。只补充【一个】最可能缺的选项，不要全选，也不要改掉已选的。';
            } else if (isWrongQ) {
              entry.hint = '这题上次被判错：请重新判断，避开已选的错误选项。';
            } else {
              entry.hint = '这题还没判定过：请独立判断。';
            }
            wrongList.push(entry);
          });
          feedback = {
            note: '只有下面列出的题目需要作答；没列出的题请保持原来的答案，不要改动。',
            wrongQuestions: wrongList
          };
        }
        const got = await answerAll(toAskQs, feedback);
        Object.keys(got).forEach(function (k) {
          const realIdx = toAsk[Number(k)];
          if (realIdx !== undefined && got[k] && got[k].length) answers[realIdx] = got[k];
        });
        /* 兜底：AI 没给答案的题沿用上一轮，再不行猜第一个选项，保证能交卷 */
        qs.forEach(function (q, i) {
          if (!answers[i] || !answers[i].length) {
            if (prevAnswers && prevAnswers[i] && prevAnswers[i].length) answers[i] = prevAnswers[i].slice();
            else answers[i] = [q.options[0] ? q.options[0].label : 'A'];
          }
        });
        if (!bruteMode) answers = avoidRepeat(qs, answers);
      }
      await fillAnswers(qs, answers);
      if (!CX.cfg.enabled) { CX.info('已暂停，本轮不再提交'); return; }
      /* 提交前先把本轮作答落盘：万一提交卡住 / 页面刷新，恢复时至少知道"上次选了什么"，
       * 判分后会用真实结果覆盖这一条。（日志实证：14:57 那次刷新后只能恢复 0 条历史） */
      /* 2026-10-31：占位记录用 wrongIndexes=null + pending 表示"这一轮还没判分"。
       * 以前写死 []，一旦提交中途被打断（刷新 / 重载扩展），恢复后就被当成"上一轮一题没错"，
       * 下一轮既不改答案也不检索 —— 这就是"上一轮没有拿到错题标记"反复出现的根源。 */
      st.history.push({ round: st.round, answers: answers, score: null, passed: false, wrongIndexes: null, halfIndexes: [], pending: true });
      saveAttempt();
      await submit();

      /* ---- 提交后确认站点是否真的批阅了 ----
       * 用户实测：有时点了提交之后完全没有后续（页面不动、没有"未达到及格线"、没有勾叉）。
       * 站点侧 confirmSubmitWork 的 submitLock 卡住、或请求被吞，都会这样。
       * 策略：无批阅迹象 → 重试提交（最多 2 次）→ 仍无 → 保存当轮记忆 + 刷新页面。 */
      /* 2026-10-31 事件驱动：不再盲等 20 秒。
       * 两个可靠信号：`#addTimes` 涨了 = 站点真收到；勾叉/成绩出现 = 批阅已渲染。
       * 每 400ms 探一次，通常 1~2 秒就能往下走（原来固定 20 秒封顶，日志里"停在 submitCheckTimes 后面"就是这段）。 */
      async function waitReviewed(timeoutMs) {
        const t0 = Date.now();
        let base = 0;
        try { base = (submitQuotaLeft() || {}).add || 0; } catch (e) {}
        while (Date.now() - t0 < timeoutMs) {
          await CX.sleep(400);
          if (hasReviewSigns()) return true;
          let now = base;
          try { now = (submitQuotaLeft() || {}).add || base; } catch (e) {}
          if (now > base) { st.lastSubmitAddDelta = now - base; return true; }
        }
        return false;
      }

      let reviewed = await waitReviewed(12000);

      /* ---- 提交后先确认站点到底收没收到（2026-10-28 重写） ----
       * 用户实测：点了提交后有时完全没有后续。现在的策略：
       *   ① addTimes 涨了 = 站点真收到，只是批阅标记还没渲染 → 只等，绝不重交（重交就是白烧一次配额）；
       *   ② addTimes 没涨、也没有批阅迹象 = 请求根本没发出去 → 补交 1 次（以前是 2 次且不确认）；
       *   ③ 仍然没有 → 保存当轮记忆 + 刷新页面。 */
      let stuckTries = 0;
      while (!reviewed) {
        if (st.lastSubmitAddDelta > 0) {
          CX.info('提交已被站点接受（addTimes +' + st.lastSubmitAddDelta + '），只等批阅标记，不重复提交');
          break;
        }
        if (stuckTries >= 1) break;
        stuckTries++;
        CX.warn('既没有批阅迹象、addTimes 也没增加 → 这次提交没发出去，补交一次');
        CX.status('提交无响应，补交一次', { busy: true, phase: 'exam' });
        await CX.sleep(1200);
        try { CX.mainCall('resetSubmitLock'); } catch (e) {}
        await submit();
        reviewed = await waitReviewed(8000);
      }

      if (!reviewed) {
        saveAttempt();   /* 保住当轮：轮次 + 每轮答案/错题，刷新后 restoreAttempt 会接上 */
        CX.warn('提交连续 ' + stuckTries + ' 次无响应，已保存本轮记忆，刷新页面重试');
        CX.status('提交卡住，正在刷新页面…', { busy: true, phase: 'exam' });
        await CX.sleep(800);
        try { location.reload(); } catch (e) {}
        return;
      }

      /* 判分原文只写日志（站点不给分数，这里只用来定位哪几题要回喂给 AI） */
      const result = await waitResult(10000, qs, answers);
      CX.debug('判分原文(仅日志): ' + String((result && result.raw) || '').slice(0, 200).replace(/\s+/g, ' '));
      const wrongIdx = [];
      const halfIdx = [];      /* 部分正确（多选漏选） */
      function idxOfBox(b) {
        const box = b.closest('.questionLi, .TiMu, .Py-mian1, .questionWrap, .question-item');
        return qs.findIndex(function (q) { return q.box === box || q.box.contains(b) || box && box.contains(q.box); });
      }
      result && result.wrongBoxes && result.wrongBoxes.forEach(function (b) {
        const idx = idxOfBox(b);
        if (idx >= 0 && wrongIdx.indexOf(idx) < 0) wrongIdx.push(idx);
      });
      result && result.halfBoxes && result.halfBoxes.forEach(function (b) {
        const idx = idxOfBox(b);
        if (idx >= 0 && halfIdx.indexOf(idx) < 0) halfIdx.push(idx);
      });
      /* 判分页没更新到本轮（读到的还是上一轮的勾叉）→ 本轮标记一律作废，避免拿旧标记乱改答案 */
      let staleMarks = false;
      if (result && result.stale) {
        staleMarks = true;
        wrongIdx.length = 0;
        halfIdx.length = 0;
        CX.warn('判分页没更新到本轮作答（读到的是上一轮），本轮标记作废');
      }
      if (halfIdx.length) {
        CX.info('部分正确（选了但漏选）的题：' + halfIdx.map(function (i) { return i + 1; }).join('、'));
      }
      /* 关键日志：把"这次认定哪几题错"写出来。以前完全看不到，
       * 于是"只错 1 题却去检索 3 题"这种问题只能靠猜。 */
      CX.info('本轮判分：错题 ' + (wrongIdx.length ? wrongIdx.map(function (i) { return i + 1; }).join('、') : '无') +
        '（红叉图标 ' + ((result && result.wrongBoxes && result.wrongBoxes.length) || 0) +
        ' 个，绿勾 ' + ((result && result.rightBoxes && result.rightBoxes.length) || 0) +
        ' 个，半对 ' + halfIdx.length + ' 个，共 ' + qs.length + ' 题）');

      /* ★ 通过判定：只看「学习测验」任务点是否完成（最多再等 20 秒让站点把标记写上去）。
       *   及格时任务点必然完成；也有没及格但站点算完成的情况 —— 同样直接走人。不看分数。 */
      const done = await waitQuizTaskDone(20000);
      /* 覆盖提交前那条占位记录（含真实判分/错题索引） */
      st.history[st.history.length - 1] = { round: st.round, answers: answers, score: result && result.score, passed: done, wrongIndexes: staleMarks ? null : wrongIdx, halfIndexes: staleMarks ? [] : halfIdx };
      saveAttempt();
      CX.info('第 ' + st.round + ' 轮：' + (done ? '学习测验任务点已完成 → 通过' : '任务点仍未完成 → 需要重做'));

      if (done) {
        st.finished = true;
        /* 整卷答案入库：同一题干下次直接命中（以前 rememberAnswer 只写、askAnswer 从不被调用） */
        qs.forEach(function (q, i) {
          if (cacheable(q) && answers[i] && answers[i].length) CX.rememberAnswer('q:' + q.mark, answers[i]);
        });
        try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (e) {}
        try { chrome.storage.local.remove([ATTEMPT_KEY]); } catch (e) {}
        CX.status('✅ 学习测验任务点已完成，继续下一节', { busy: false, phase: 'exam' });
        const cont = P.findContinueButton();
        if (cont) { await CX.sleep(800); CX.click(cont); }
        try { chrome.runtime.sendMessage({ kind: 'exam:passed', url: location.href }); } catch (e) {}
        return;
      }

      /* 任务点还没完成 → 先处理「未达到及格线，请重做」弹窗，再回到答题页继续下一轮。
       * st.redoing 期间禁止 run() 重入（以前 st.busy 在这里被提前放开，会双开一轮）。 */
      st.busy = false;
      st.redoing = true;
      let ok = false;
      try { ok = await redo(); } finally { st.redoing = false; }
      if (!ok) {
        /* 2026-10-28：弹窗还在但点不到「确定」时，绝对不能"直接进入下一轮" ——
         * 那样每一轮都会点在遮罩上，表现就是反复空转 + 主线程被拖死。 */
        if (failDialogPresent()) {
          st.finished = true;
          CX.warn('「未达到及格线，请重做」弹窗还在，但找不到它的「确定」按钮；已停手，避免把下一轮点在遮罩上');
          CX.status('⚠ 请手动点弹窗的「确定」重做，然后刷新页面', { busy: false, phase: 'exam' });
          return;
        }
        if (P.findSubmitButton()) {
          CX.info('没有及格线弹窗，页面仍是答题页，直接进入第 ' + (st.round + 1) + ' 轮');
          st.busy = true;
          return;
        }
        CX.info('页面无重做按钮，刷新重试');
        await CX.sleep(1200);
        saveAttempt();
        location.reload();
        return;
      }
      CX.info('已处理及格线弹窗，进入第 ' + (st.round + 1) + ' 轮');
      st.busy = true;
    } catch (e) {
      CX.error('测验处理异常：' + e.message);
    } finally {
      st.busy = false;
    }
  }

  /* 轮询：题目出现且稳定后开始 */
  let stableTicks = 0;
  let startClicked = false;
  setInterval(function () {
    /* 2026-10-30：作答期间持续给顶层打「忙碌」时间戳，nav 读到就不会抢着点测验入口
     * （它每点一次都会让站点重载答题 iframe，作答直接丢）。 */
    try { if (st.busy || st.redoing) root.top.__cxExamBusyAt = Date.now(); } catch (e) {}
    if (!CX.cfg.enabled) return;
    /* 2026-11-04：跳过判断必须放在最前面，且不看 exam.enabled / st.finished。
     * 以前它在 `if (st.finished) return;` 之后 —— 只要之前因为「没配 Key」把本页置成 finished，
     * 跳过就永远走不到；另外用户完全可能关掉「AI 学习检测」只想「进页面就走」，那也不该被挡住。 */
    if (skipAnswering()) {
      if (P.looksLikeExamPage() || looksLikeQuizLoose()) skipNow();
      return;
    }
    if (cfg().enabled === false) return;
    if (st.finished) return;
    /* 已批阅页：只判定 + 通知导航，不再答题 */
    if (handleReviewPage()) { stableTicks = 0; return; }
    if (!P.looksLikeExamPage()) {
      /* 有些测验先要「开始答题」 */
      if (!startClicked) {
        const sb = P.findStartButton();
        if (sb && /测验|作业|考试|答题|检测/.test(document.title || '')) {
          startClicked = true;
          CX.info('点击「开始答题」');
          CX.click(sb);
        }
      }
      stableTicks = 0;
      return;
    }
    if (st.busy) return;
    stableTicks++;
    if (stableTicks < 3) return;
    run();
  }, 1500);

  CX.exam = { run: run, state: st, isExamContext: isExamContext, _nextRetryAnswer: nextRetryAnswer, _keyOf: keyOf };

  /* 用户点「启动」（总开关 false → true）时清掉"已结束"标记，否则 st.finished 一旦置位，
   * 轮询会永远 return，表现就是"点了启动没反应"。 */
  let lastEnabledForReset = !!(CX.cfg && CX.cfg.enabled);
  let lastModeForReset = CX.examMode ? CX.examMode() : 'ai-first';
  CX.onConfig(function (cfgNow) {
    /* 2026-11-04：作答方式变化时清掉本页的结束标记（跳过 ↔ 答题、AI ↔ 暴力 都要能即时切换），
     * 否则 st.finished/skipped 一直挡着，本页永远不会重新评估。 */
    const modeNow = CX.examMode ? CX.examMode(cfgNow) : 'ai-first';
    if (modeNow !== lastModeForReset) {
      lastModeForReset = modeNow;
      st.finished = false;
      st.skipped = false;
      st.busy = false;
      st.redoing = false;
      CX.info('作答方式已切到「' + (modeNow === 'skip' ? '跳过（进页面不作答）' : modeNow === 'brute' ? '暴力枚举' : 'AI 优先') + '」：重新评估本页');
    }
    const on = !!(cfgNow && cfgNow.enabled);
    if (on && !lastEnabledForReset && st.finished) {
      st.finished = false;
      st.busy = false;
      st.redoing = false;
      CX.info('已重新启用：清除「已完成」标记，重新评估当前卷子');
    }
    lastEnabledForReset = on;
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
