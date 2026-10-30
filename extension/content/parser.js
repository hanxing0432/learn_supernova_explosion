/* 题目解析层：兼容超星各种题库页面结构，输出统一模型 */
(function (root) {
  'use strict';

  const CX = root.CX;
  if (!CX || CX.parser) return;

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  const SEL = {
    /* 视频弹题（播放器内弹出的小题） */
    videoQuizBox: [
      '.ans-videoquiz', '#videoquiz', '.ans-videoquiz-wrap', '.videoquiz-box',
      '.ans-videoquiz-container', '.tkTopic', '.ans-job-video-quiz'
    ],
    videoQuizTitle: ['.tkTopic_title', '.tkTopic-title', '.topic_title', '.ans-videoquiz-title'],
    videoQuizOption: ['.ans-videoquiz-opt', '.ans-videoquiz-options li', '.videoquiz-opt'],
    videoQuizSubmit: ['#videoquiz-submit', '.ans-videoquiz-btn', '.videoquiz-submit'],
    videoQuizRight: ['#spanHas', '.spanHas'],
    videoQuizWrong: ['#spanNot', '#spanNotBack', '.spanNot'],

    /* 章节测验 / 学习检测 / 作业 */
    examBox: [
      '.questionLi', '.TiMu', '.Py-mian1', '.questionWrap', '.question-item',
      '.subjectLi', '.ans-question', 'div[id^="question"]', 'div[id^="question_"]'
    ],
    examStem: ['.Zy_TItle', '.stem', '.qtContent', '.question-title', '.subject', '.sub-title', '.timu', 'h3', 'h4'],
    examOption: ['.Zy_ulTop li', '.answerList li', '.optionList li', '.stem_answer li', 'ul.Zy_ulTop > li', 'label.option'],

    submitBtn: [
      'a.completeBtn', '.completeBtn', '#answerSheet .completeBtn', 'a#submitBtn',
      'button#submitBtn', '#submitBtn', 'a.btnSubmit', '.answer_sheet .btn',
      '.submitBtn', 'a[onclick*="submit"]', 'input[type="button"][value*="提交"]'
    ],
    confirmBtn: [
      '.layui-layer-btn0', '.conformBtn', '.popok', '#popok', '.layui-layer-dialog .layui-layer-btn0',
      '.dialog-btn-ok', '.btn-ok', '.swal2-confirm'
    ],
    retryBtn: ['a.redo', '.redo', '#redoBtn', 'a[onclick*="redo"]', 'a[onclick*="again"]', '.againBtn'],
    continueBtn: ['.ans-videoquiz-continue', '#videoquiz-continue', '.continueStudy', '.continue-learn']
  };

  /* ---------------- 题型判定 ---------------- */
  function typeFromText(text, inputs) {
    const t = String(text || '');
    if (/【\s*(多选|多项选择|不定项)/.test(t) || /\(\s*多选/.test(t) || /（\s*多选/.test(t) || /多选题/.test(t)) return 'multi';
    if (/【\s*判断/.test(t) || /判断题/.test(t)) return 'judge';
    if (/【\s*填空/.test(t) || /填空题/.test(t)) return 'fill';
    if (/【\s*简答|【\s*论述|【\s*名词解释/.test(t)) return 'text';
    if (/【\s*单选/.test(t) || /单选题/.test(t)) return 'single';
    if (inputs && inputs.length) {
      if (inputs.some(function (i) { return i.type === 'checkbox'; })) return 'multi';
      if (inputs.some(function (i) { return i.type === 'text'; })) return 'fill';
      return 'single';
    }
    return 'unknown';
  }

  function typeLabel(type) {
    return ({ single: '单选', multi: '多选', judge: '判断', fill: '填空', text: '主观', unknown: '未知' })[type] || '未知';
  }

  /* ---------------- 选项文本/字母 ---------------- */
  function labelFromInput(input, index) {
    const v = (input.getAttribute('value') || '').trim();
    if (/^[A-Z]$/i.test(v)) return v.toUpperCase();
    /* 学习通常见 value="A" 或 value="answerA" */
    const m = v.match(/([A-Z])$/i);
    if (v && m && v.length <= 3) return m[1].toUpperCase();
    return LETTERS[index] || String(index + 1);
  }

  function stripLeadingLetter(text) {
    return String(text || '')
      .replace(/^\s*[\(（]?\s*([A-Z])\s*[\)）]?\s*[、.．:：,，)]?\s*/i, '')
      .trim();
  }

  function optionText(el) {
    /* 去掉 input 自身文本，取可见文本 */
    const t = CX.oneLine(el.innerText || el.textContent || '');
    return stripLeadingLetter(t);
  }

  /* ---------------- 解析一个题目块 ---------------- */
  function parseBlock(box, opt) {
    opt = opt || {};
    const inputs = CX.qsa('input[type="radio"],input[type="checkbox"],input[type="text"],textarea', box)
      .filter(function (i) { return !i.disabled && i.type !== 'hidden'; });

    /* 题干 */
    let stemEl = null;
    for (let i = 0; i < SEL.examStem.length && !stemEl; i++) {
      const cand = CX.qa(SEL.examStem[i], box);
      if (cand && CX.oneLine(cand.innerText).length > 1) stemEl = cand;
    }
    let stem = stemEl ? CX.oneLine(stemEl.innerText) : '';
    const titleSpan = CX.qa('.Zy_TItle .clearfix, .Zy_TItle .fl, .fl', box);
    const typeText = CX.oneLine(box.innerText).slice(0, 120);
    let type = typeFromText(typeText, inputs);

    /* 选项 */
    let optEls = [];
    for (let i = 0; i < SEL.examOption.length; i++) {
      const found = CX.qsa(SEL.examOption[i], box);
      if (found.length >= 2) { optEls = found; break; }
    }
    if (!optEls.length && inputs.length) {
      /* 兜底：每个 input 的父级 label/li 作为选项 */
      optEls = inputs.map(function (inp) {
        return inp.closest('label') || inp.closest('li') || inp.parentElement;
      }).filter(Boolean);
    }
    if (!optEls.length) {
      /* 再兜底：新版做题页用 <li>/<span> 当选项，A/B/C/D 开头，靠 class 选中 */
      const leaves = CX.qsa('li,div,span,p,dd', box).filter(function (el) {
        if (!CX.visible(el)) return false;
        const t = CX.oneLine(el.innerText || '');
        return t.length > 1 && t.length < 140 && /^[A-H][\s、.．)）:：]/.test(t);
      });
      optEls = leaves.filter(function (el) {
        return !leaves.some(function (other) { return other !== el && el.contains(other); });
      });
    }
    /* 去重 + 排序 */
    optEls = optEls.filter(function (el, i, arr) { return arr.indexOf(el) === i && el && box.contains(el); });

    const options = optEls.map(function (el, idx) {
      const input = CX.qa('input[type="radio"],input[type="checkbox"]', el) ||
        (el.tagName === 'INPUT' ? el : null);
      const label = input ? labelFromInput(input, idx) : LETTERS[idx];
      let text = optionText(el);
      if (!text) text = CX.oneLine(el.innerText);
      return { label: label, text: text, input: input, el: el };
    }).filter(function (o) { return o.text && o.text.length > 0; });

    if (!stem) {
      /* 没有明确题干元素：从容器文本里去掉选项文本 */
      let raw = CX.oneLine(box.innerText);
      options.forEach(function (o) {
        raw = raw.split(o.text).join(' ');
        raw = raw.split(o.label + '、').join(' ');
        raw = raw.split(o.label + '.').join(' ');
      });
      stem = CX.norm(raw).replace(/\s{2,}/g, ' ').slice(0, 600);
    }

    if (type === 'unknown' && options.length) type = inputs.some(function (i) { return i.type === 'checkbox'; }) ? 'multi' : 'single';

    /* 填空题的空 */
    const blanks = CX.qsa('input[type="text"],textarea', box).filter(function (i) { return !i.disabled; });

    /* 超星字体加密（.font-cxsecret）：DOM 里是错字，靠字形比对还原真实文字。
     * 映射由 content/fontdecrypt.js 建立；没建好时 fix 原样返回，不会更差。 */
    const _fx = (CX.fontDecrypt && CX.fontDecrypt.fix) ? CX.fontDecrypt.fix : function (s) { return s; };
    const qStem = _fx(stem);
    options.forEach(function (o) { o.text = _fx(o.text); });

    const q = {
      id: box.id || (box.getAttribute('data-id') || ''),
      box: box,
      stem: qStem,
      type: type,
      typeText: typeLabel(type),
      titleEl: stemEl,
      options: options,
      blanks: blanks,
      mark: qStem + '|' + options.map(function (o) { return o.text; }).join('|')
    };
    return q;
  }

  /* 统计「像选项」的叶子元素（没有 input 的新版做题页靠这个判定） */
  function countOptionLike(box) {
    const leaves = CX.qsa('li,div,span,p,dd', box).filter(function (el) {
      if (!CX.visible(el)) return false;
      const t = CX.oneLine(el.innerText || '');
      return t.length > 1 && t.length < 140 && /^[A-H][\s、.．)）:：]/.test(t);
    });
    return leaves.filter(function (el) {
      return !leaves.some(function (other) { return other !== el && el.contains(other); });
    }).length;
  }

  /* ---------------- 页面级收集 ---------------- */
  function collect(boxSelectorList, opt) {
    opt = opt || {};
    let boxes = CX.allOf(boxSelectorList, opt.root || root.document);
    /* 过滤嵌套（外层已包含内层时留外层） */
    boxes = boxes.filter(function (b) {
      /* 有 input 的旧结构，或没有 input 但有一组「A/B/C…」选项的新结构 */
      if (CX.qsa('input[type="radio"],input[type="checkbox"]', b).length > 0) return true;
      if (CX.qsa('textarea', b).length > 0) return true;
      return countOptionLike(b) >= 2;
    });
    /* 视频弹题由 videoQuiz 模块接管，这里排除，避免两套逻辑互相抢答 */
    if (opt.excludeVideoQuiz !== false) {
      const popup = findVideoQuizBox();
      if (popup) boxes = boxes.filter(function (b) { return !popup.contains(b); });
    }
    boxes = boxes.filter(function (b, i, arr) {
      for (let k = 0; k < arr.length; k++) {
        if (arr[k] !== b && arr[k].contains(b)) return false;
      }
      return true;
    });
    const qs = boxes.map(function (b) { return parseBlock(b, opt); })
      .filter(function (q) { return q.options.length > 0 || q.blanks.length > 0; });
    /* 通用兜底：没有匹配到标准容器时，按 input name 分组 */
    if (!qs.length && opt.generic !== false) {
      const generic = genericCollect(opt);
      const popup = opt.excludeVideoQuiz !== false ? findVideoQuizBox() : null;
      return popup ? generic.filter(function (q) { return !popup.contains(q.box); }) : generic;
    }
    return qs;
  }

  function genericCollect(opt) {
    opt = opt || {};
    const doc = opt.root || root.document;
    const inputs = CX.qsa('input[type="radio"],input[type="checkbox"]', doc)
      .filter(function (i) { return CX.visible(i) || i.closest('label'); });
    const groups = new Map();
    inputs.forEach(function (i, idx) {
      const name = i.name || ('__idx' + idx);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(i);
    });

    const out = [];
    groups.forEach(function (list, name) {
      if (!list.length) return;
      let common = list[0].parentElement;
      for (let i = 1; i < list.length; i++) {
        while (common && !common.contains(list[i])) common = common.parentElement;
        if (!common) break;
      }
      if (!common) common = list[0].closest('li,div') || list[0].parentElement;
      const q = parseBlock(common, {});
      if (q.options.length >= 2) out.push(q);
    });
    return out;
  }

  /* ---------------- 视频弹题 ---------------- */
  function findVideoQuizBox() {
    for (let i = 0; i < SEL.videoQuizBox.length; i++) {
      const el = CX.qa(SEL.videoQuizBox[i]);
      if (el && CX.visible(el)) return el;
    }
    /* 兜底：出现 .tkTopic_title 也认为弹题出现 */
    const t = CX.firstOf(SEL.videoQuizTitle);
    if (t && CX.visible(t)) return t.closest('div,section') || t.parentElement;
  }

  function parseVideoQuiz() {
    const box = findVideoQuizBox();
    if (!box) return null;
    /* 弹题的题干/选项同样可能被字体加密。这里是一条独立解析路径，不经过 parseBlock，
     * 所以必须单独套一遍还原，否则 AI 拿到的是「弮弭弰弴…」，必然答错。 */
    const _fx = (CX.fontDecrypt && CX.fontDecrypt.fix) ? CX.fontDecrypt.fix : function (s) { return s; };
    const titleEl = CX.firstOf(SEL.videoQuizTitle, box);
    /* 兜底会退化成"整段文字"，而弹层里有「共 N 题，已答对 M 题」这种进度文案。
     * 不剔掉的话，每答对一题 mark 就变一次，videoquiz.js 里的 bruteIndex / attempts
     * 会被反复重置 —— 实测表现为同一个答案（B）连着作答三次、枚举永远走不到正确答案。 */
    let rawTitle = titleEl ? CX.oneLine(titleEl.innerText) : CX.oneLine(box.innerText).slice(0, 200);
    rawTitle = rawTitle.replace(/共\s*\d+\s*题[，,、]?\s*已答对\s*\d+\s*题/g, ' ');
    const titleText = _fx(rawTitle.trim());

    /* 选项：兼容「类名在 li 上」与「类名在 ul 上」两种结构 */
    let opts = [];
    CX.allOf(SEL.videoQuizOption, box).forEach(function (cand) {
      const lis = CX.qsa('li', cand).filter(function (li) { return CX.qa('input', li); });
      if (!CX.qa('input', cand) && lis.length) opts = opts.concat(lis);
      else opts.push(cand);
    });
    opts = opts.filter(function (el, i, arr) { return arr.indexOf(el) === i; });
    if (!opts.length) opts = CX.qsa('li', box).filter(function (li) { return !!CX.qa('input', li); });
    if (!opts.length) return null;

    const inputs = CX.qsa('input[type="radio"],input[type="checkbox"]', box);
    const type = typeFromText(titleText, inputs);

    const options = opts.map(function (el, idx) {
      const input = CX.qa('input[type="radio"],input[type="checkbox"]', el) || (el.tagName === 'INPUT' ? el : null);
      const raw = CX.oneLine(el.innerText || el.textContent);
      const m = raw.match(/^\s*([A-Z])\s*[、.．:：)）]/i);
      const label = m ? m[1].toUpperCase() : labelFromInput(input || { getAttribute: function () { return ''; } }, idx);
      return {
        label: label,
        text: m ? _fx(CX.norm(raw.replace(m[0], ''))) : _fx(stripLeadingLetter(raw)),
        input: input,
        el: el
      };
    }).filter(function (o) { return o.text; });

    const submit = CX.firstOf(SEL.videoQuizSubmit, box) || CX.findByText(['提交', '确定', '回答'], box, { maxLen: 8 });

    return {
      box: box,
      title: titleText,
      type: type,
      typeText: typeLabel(type),
      options: options,
      submit: submit,
      mark: titleText + '|' + options.map(function (o) { return o.label + o.text; }).join('|'),
      result: videoQuizResult(box)
    };
  }

  function videoQuizResult(box) {
    box = box || root.document;

    /* 结果区优先，但要求它真有文字：站点的 #spanHas/#spanNot 容器常年占位，
     * 只判断「可见」会把每次作答都判成 wrong。 */
    const right = CX.firstOf(SEL.videoQuizRight, box);
    if (right && CX.visible(right) && CX.oneLine(right.innerText || '').length) return 'right';
    const wrong = CX.firstOf(SEL.videoQuizWrong, box);
    if (wrong && CX.visible(wrong) && CX.oneLine(wrong.innerText || '').length) return 'wrong';

    /* 兜底只认「回答」开头的明确结论。两条坑都踩过：
     *  - 匹配裸的「正确 / 不正确 / 错误」→ 题干「…表述不正确的:( )」导致永远判错、无限重试；
     *  - 匹配「已答对」→ 弹层进度文案「共 N 题，已答对 0 题」也会命中，导致没提交就判对。
     * 所以先把进度文案整段剔掉，再只认「回答正确 / 回答错误」。 */
    let text = CX.oneLine((box.innerText || '').slice(0, 400));
    text = text.replace(/共\s*\d+\s*题[，,、]?\s*已答对\s*\d+\s*题/g, ' ');
    if (/回答正确|答对了/.test(text)) return 'right';
    if (/回答错误|答错了|回答不正确/.test(text)) return 'wrong';
    return null;
  }

  /* 弹层里到底有几道题（有的「学习检测」是弹层里的多题，应交给 exam 模块） */
  function popupQuestionGroups(box) {
    const b = box || findVideoQuizBox();
    if (!b) return 0;
    const inputs = CX.qsa('input[type="radio"],input[type="checkbox"]', b);
    const names = new Set();
    inputs.forEach(function (i, idx) { names.add(i.name || ('__' + idx)); });
    return names.size;
  }

  /* 找「开始答题 / 开始考试 / 继续答题」按钮 */
  function findStartButton(scope) {
    const s = scope || root.document;
    return CX.findByText(['开始答题', '开始考试', '继续答题', '开始做题', '进入答题'], s, { maxLen: 10 });
  }
  /* 找「继续学习」按钮：弹题答对后出现 */
  function findContinueButton(scope) {
    const s = scope || root.document;
    let btn = CX.firstOf(SEL.continueBtn, s);
    if (btn && CX.visible(btn)) return btn;
    btn = CX.findByText(['继续学习', '继续播放', '继续观看', '继续'], s, { maxLen: 10 });
    return btn || null;
  }

  /* ---------------- 应用答案 ---------------- */
  function optionSelected(o) {
    try {
      if (o.input && o.input.checked) return true;
      const el = o.el;
      const cls = String((el && el.className) || '');
      if (/(^|[\s_-])(cur|active|selected|checked|choosed|choose|on)([\s_-]|$)/i.test(cls)) return true;
      /* 注意：图标的基础类名（如 check_answer）不代表已选中，
       * 只有带 _cur / _active / selected 这类后缀才算 */
      const icon = el && CX.qa('i,em', el);
      if (icon) {
        const icls = String(icon.className || '');
        if (/(^|[\s_-])(cur|active|selected|checked|dui)([\s_-]|$)|_cur|_active|_selected|_checked/i.test(icls)) return true;
      }
      if (el && el.getAttribute && /true|1/.test(String(el.getAttribute('aria-checked') || ''))) return true;
      return false;
    } catch (e) { return false; }
  }

  function pickOption(q, label) {
    const o = q.options.find(function (x) { return String(x.label).toUpperCase() === String(label).toUpperCase(); });
    if (!o) return false;
    const target = o.input || o.el;
    if (!target) return false;
    if (o.input) {
      if (!o.input.checked) CX.click(o.input);
      if (!o.input.checked) CX.click(o.el);   /* 有的站点只监听 label/li */
    } else {
      /* 没有 input：点选项本身（只点一次，避免把勾选又点掉） */
      if (!optionSelected(o)) CX.click(o.el);
      if (!optionSelected(o)) {
        /* 少数结构要点它里面的图标/文字才生效 */
        const inner = CX.qa('i,span,em', o.el);
        if (inner && inner !== o.el) CX.click(inner);
      }
    }
    return true;
  }

  function applyChoices(q, choices) {
    const want = (choices || []).map(function (c) { return String(c).toUpperCase(); });
    if (!want.length) return false;
    if (q.type === 'multi') {
      /* 先清掉多余勾选 */
      q.options.forEach(function (o) {
        const isWant = want.indexOf(String(o.label).toUpperCase()) >= 0;
        if (!isWant && optionSelected(o)) {
          if (o.input) CX.click(o.input);
          else CX.click(o.el);
        }
      });
      want.forEach(function (label) { pickOption(q, label); });
      return true;
    }
    return pickOption(q, want[0]);
  }

  function applyBlanks(q, answerText) {
    if (!q.blanks.length) return false;
    const parts = String(answerText || '').split(/[|｜;；,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    q.blanks.forEach(function (b, i) {
      const val = parts[i] !== undefined ? parts[i] : (parts[0] || '');
      if (!val) return;
      b.focus();
      b.value = val;
      b.dispatchEvent(new Event('input', { bubbles: true }));
      b.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return true;
  }

  /* ---------------- 提交与结果 ---------------- */
  function findSubmitButton(scope) {
    const s = scope || root.document;
    let btn = CX.firstOf(SEL.submitBtn, s);
    if (btn && CX.visible(btn)) return btn;
    btn = CX.findByText(['提交答案', '提交试卷', '提交作业', '交卷', '提交', '确定提交'], s, { maxLen: 10 });
    return btn || null;
  }

  function findConfirmButton(scope) {
    const s = scope || root.document;
    const direct = CX.firstOf(SEL.confirmBtn, s);
    if (direct && CX.visible(direct)) return direct;
    /* 弹窗内找「确定」 */
    const dialogs = CX.qsa('.layui-layer, .dialog, .modal, .ant-modal, .swal2-popup, [class*="dialog"], [class*="Dialog"], [class*="confirm"], [class*="pop"]', s)
      .filter(CX.visible);
    for (let i = 0; i < dialogs.length; i++) {
      /* 学习通的确认弹窗按钮有时就叫「提交」，不只是「确定」 */
      const ok = CX.findByText(['确定', '确认', '提交', '是', 'OK', '继续提交'], dialogs[i], { maxLen: 6 });
      if (ok) return ok;
    }
    return null;
  }

  /* 提交确认弹窗经常挂在顶层页面（不在题库 iframe 里），所以要跨文档找 */
  function findConfirmButtonAnyDoc() {
    let wins = [root];
    try { if (CX.walkAccessibleParents) wins = CX.walkAccessibleParents(); } catch (e) {}
    for (let i = 0; i < wins.length; i++) {
      let d = null;
      try { d = wins[i].document; } catch (e) { continue; }
      if (!d) continue;
      const btn = findConfirmButton(d);
      if (btn) return btn;
    }
    return null;
  }

  /* 解析成绩/判定
   * 关键：题干里可能本身就含「未通过/不合格」等字样（例如“学习检测未通过时可以重做”），
   * 所以必须先把题目文本从页面文本里剔除，只看结果区域。
   */
  const RESULT_SELECTORS = [
    '#result', '.result', '.examResult', '.testResult', '.submitResult', '.ansResult',
    '#score', '.score', '#scoreNum', '.scoreNum', '.markStat', '#answerResult',
    '.mark_item', '.scoreBox', '.result-box', '.exam-result', '.ui-result'
  ];

  function resultText(d, qs) {
    for (let i = 0; i < RESULT_SELECTORS.length; i++) {
      const el = CX.qa(RESULT_SELECTORS[i], d);
      if (!el) continue;
      const t = CX.oneLine(el.innerText);
      if (t && t.length > 1 && t.length < 500) return { text: t, fromContainer: true };
    }
    /* 用 pageText（innerText，排除 <script> 里的源码）。textContent 会把站点的
     * I18N 语言包一起读进来，判分原文里全是 "tasktips1: 未达到及格线…" 这种模板 → 判定全乱。 */
    let body = CX.oneLine(CX.pageText ? CX.pageText(d.body) : (d.body ? d.body.textContent : ''));
    (qs || []).forEach(function (q) {
      if (q.stem) body = body.split(q.stem).join(' ');
      (q.options || []).forEach(function (o) {
        if (o.text && o.text.length > 1) body = body.split(o.text).join(' ');
      });
    });
    return { text: body, fromContainer: false };
  }


  function parseResult(doc, qs) {
    const d = doc || root.document;
    const got = resultText(d, qs);
    const text = got.text.slice(0, 4000);

    let score = null;
    const m1 = text.match(/(?:得分|成绩|分数|总分)[：:\s]*(\d+(?:\.\d+)?)/);
    const m2 = text.match(/(\d+(?:\.\d+)?)\s*分(?!钟|秒)/);
    if (m1) score = parseFloat(m1[1]);
    else if (m2) score = parseFloat(m2[1]);

    let passed = null;
    /* 学习通这个站把「未达到及格线，请重做」直接内联显示在答题页上，不是弹窗 */
    if (/未达到及格线|请重做|未通过|不合格|不及格|未及格/.test(text)) passed = false;
    else if (/已通过|通过考试|恭喜.*通过|合格|已及格/.test(text)) passed = true;

    /* 结果页每题后面是 ✓ / ✗ 图标（img/svg/i 带 dui/cuo/check/cross 之类），
     * 不是靠 .cuo 包住整个题目。这里按「题目容器内的小图标」判定对错。 */
    const QSEL = '.questionLi, .TiMu, .Py-mian1, .questionWrap, .question-item, li[id], div[id^="question"]';
    const WRONG_RE = /(cuo|wrong|error|cross|incorrect|fail|cha|close)/i;
    const RIGHT_RE = /(dui|correct|success|check|right|gou)/i;
    function markIcon(el) {
      const sig = String(el.className || '') + ' ' +
        String(el.getAttribute && (el.getAttribute('src') || '') ) + ' ' +
        String(el.getAttribute && (el.getAttribute('alt') || ''));
      if (!sig.trim()) return '';
      const textLen = (el.textContent || '').length;
      if (textLen > 24) return '';                 /* 大块内容不当图标 */
      /* 2026-10-28：学习通三种批阅标记（都是 ::before 伪元素画的）：
       *   .marking_dui    全对（绿✓）
       *   .marking_cuo    全错（红✗）
       *   .marking_bandui 部分正确（橙 ✓✗：多选题选对了一部分、还有漏选）
       * bandui 里带 "dui" 子串，**必须先判它**，否则会被 RIGHT_RE 吃掉当成全对。 */
      if (/bandui|half/i.test(sig)) return 'half';
      if (WRONG_RE.test(sig)) return 'wrong';
      if (RIGHT_RE.test(sig)) return 'right';
      return '';
    }
    /* 2026-10-28 第三次修：**只认精确类名**。
     * 旧做法是在题目容器里扫 'img,svg,i,em,span,div'，再用关键词正则判 ——
     * 结果布局类的 <div class="right">、<span class="checkbox"> 全被当成"绿勾"，
     * 实测「5 道题」变成「绿勾 18 个、红叉 2 个」，错题定位彻底失真。
     * 学习通真实结构就三个类名（都是 ::before 伪元素画的）：
     *   .marking_dui 对 / .marking_cuo 错 / .marking_bandui 半对 */
    const marks = [];
    const EXACT = [
      ['marking_dui', 'right'], ['marking_cuo', 'wrong'], ['marking_bandui', 'half'],
      ['dui', 'right'], ['cuo', 'wrong'], ['bandui', 'half']
    ];
    EXACT.forEach(function (pair) {
      CX.qsa('.' + pair[0], d).forEach(function (el) {
        if (!CX.visible(el)) return;
        for (let i = 0; i < marks.length; i++) if (marks[i].el === el) return;
        marks.push({ el: el, kind: pair[1] });
      });
    });
    /* 兜底：一个精确类名都没命中时，才退回"题目容器内 + 尺寸很小的 i/em/span" 扫描 */
    if (!marks.length) {
      CX.qsa(QSEL, d).forEach(function (box) {
        CX.qsa('i, em, span', box).forEach(function (el) {
          if (!CX.visible(el)) return;
          const r = el.getBoundingClientRect();
          if (r.width > 44 || r.height > 44) return;
          const kind = markIcon(el);
          if (kind) marks.push({ el: el, kind: kind });
        });
      });
    }
    const wrongBoxes = [];
    const rightBoxes = [];
    const halfBoxes = [];        /* 部分正确（多选漏选）：算"没拿满"，但语义上选的对 */
    marks.forEach(function (m) {
      if (m.kind === 'wrong') wrongBoxes.push(m.el);
      else if (m.kind === 'half') halfBoxes.push(m.el);
      else if (m.kind === 'right') rightBoxes.push(m.el);
    });
    /* 2026-10-28：删掉了「一个图标都没认出来就全页搜 .cuo」的兜底。
     * 实测它会把页面别处的图标当成错题标记，于是"只错 1 题"变成"错 3 题"，
     * 后面还会拿这批脏数据去联网检索。宁可漏判，也不要误判。 */
    return {
      score: score,
      passed: passed,
      raw: text,
      fromContainer: got.fromContainer,
      wrongCount: wrongBoxes.length,
      rightCount: rightBoxes.length,
      halfCount: halfBoxes.length,
      wrongBoxes: wrongBoxes,
      halfBoxes: halfBoxes,
      rightBoxes: rightBoxes
    };
  }

  /* 从判分后的页面提取错题对应的题干（用于回喂 AI） */
  function extractWrongQuestions(result, originalQs) {
    const boxes = (result && result.wrongBoxes) || [];
    const out = [];
    boxes.forEach(function (b) {
      const qBox = b.closest('.questionLi, .TiMu, .Py-mian1, .questionWrap, .question-item, li') || b;
      const q = parseBlock(qBox, {});
      if (q && q.stem) {
        out.push({ stem: q.stem, type: q.type, options: q.options.map(function (o) { return { label: o.label, text: o.text }; }) });
      }
    });
    if (out.length) return out;
    /* 没有标记时：整页重扫，交给上层用「上一轮答案」推理 */
    return originalQs.map(function (q) {
      return { stem: q.stem, type: q.type, options: q.options.map(function (o) { return { label: o.label, text: o.text }; }) };
    });
  }

  function findRetryButton(scope) {
    const s = scope || root.document;
    let btn = CX.firstOf(SEL.retryBtn, s);
    if (btn && CX.visible(btn)) return btn;
    btn = CX.findByText(['重做', '重新做题', '再试一次', '重新答题', '再次答题'], s, { maxLen: 8 });
    return btn || null;
  }

  /* 判断当前页面是不是一个「题目页」 */
  function looksLikeExamPage(doc) {
    const d = doc || root.document;
    /* 2026-10-28：必须**可见**的题目容器才算。学习通会把测验模板预载进同一个 DOM（display:none），
     * 以前只看"有没有 .TiMu"，于是视频页也被当成答题页 → exam 模块判定"已批阅页"→ 直接广播通过
     * → nav 把整章视频跳过去。这是"所有视频都直接跳"的根因。 */
    const boxes = CX.qsa('.questionLi, .TiMu, .Py-mian1, .questionWrap, .question-item', d).filter(CX.visible);
    if (boxes.length) return true;
    const inputs = CX.qsa('input[type="radio"],input[type="checkbox"]', d).filter(CX.visible).length;
    const title = /(章节测验|学习检测|单元测验|课后作业|作业|考试|答题|测验)/.test(d.title || '');
    return inputs >= 4 && (title || !!findSubmitButton(d));
  }

  /* 结构探针：解析不到题目时把页面结构写进日志，便于适配新版本页面 */
  function diag() {
    const d = root.document;
    const containers = ['.questionLi', '.TiMu', '.Py-mian1', '.questionWrap', '.question-item', '.subjectLi']
      .map(function (s) { return s + '=' + CX.qsa(s, d).length; }).join(' ');
    const inputs = CX.qsa('input[type="radio"],input[type="checkbox"]', d).length;
    const submit = findSubmitButton(d);
    const title = d.title || '';
    return {
      url: location.href,
      title: title,
      containers: containers,
      inputs: inputs,
      submit: submit ? (submit.tagName + '#' + (submit.id || '') + '.' + (submit.className || '') + ' "' + CX.oneLine(submit.innerText).slice(0, 20) + '"') : 'none',
      bodyLen: CX.oneLine(d.body ? d.body.innerText : '').length,
      frame: CX.frameDepth
    };
  }

  CX.parser = {
    SEL: SEL,
    LETTERS: LETTERS,
    typeFromText: typeFromText,
    typeLabel: typeLabel,
    parseBlock: parseBlock,
    collect: collect,
    genericCollect: genericCollect,
    findVideoQuizBox: findVideoQuizBox,
    parseVideoQuiz: parseVideoQuiz,
    popupQuestionGroups: popupQuestionGroups,
    findStartButton: findStartButton,
    videoQuizResult: videoQuizResult,
    findContinueButton: findContinueButton,
    pickOption: pickOption,
    applyChoices: applyChoices,
    applyBlanks: applyBlanks,
    findSubmitButton: findSubmitButton,
    findConfirmButton: findConfirmButton,
    findConfirmButtonAnyDoc: findConfirmButtonAnyDoc,
    findRetryButton: findRetryButton,
    parseResult: parseResult,
    extractWrongQuestions: extractWrongQuestions,
    looksLikeExamPage: looksLikeExamPage,
    diag: diag,
    stripLeadingLetter: stripLeadingLetter
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
