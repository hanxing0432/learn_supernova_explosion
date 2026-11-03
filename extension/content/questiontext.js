/* 题目原文（2026-11-03）
 *
 * 干什么：把当前页的题目（题干 + 选项）还原成可复制的纯文本，并支持
 *   ① 一键复制整份（可粘去搜索 / 问 AI）
 *   ② 点题号跳到页面上那道题（跨帧：谁有题谁自己滚）
 *   ③ 按题干直接开搜索（模板可配，默认百度）
 *
 * 为什么需要它：站点用 @font-face 把题目文字换成密文（.font-cxsecret），
 * 页面上看着是乱码、复制出来也是乱码。解密链路本来就有（fontdecrypt + glyphmatch），
 * 这个模块只负责「收集明文 → 聚合 → 展示 → 复制 / 跳转 / 搜索」，不重复造解密。
 *
 * 跨帧：浮窗只在顶层挂，而题目常在 work 子帧里。顶层点按钮 → 后台广播 collect →
 * 每个 frame 自己采集后用同一个 reqId 回一条 part → 顶层按 frameId 顺序拼成一份、连续编号。
 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX || CX.qtext) return;

  const DEFAULT_SEARCH = 'https://www.baidu.com/s?wd=%s';
  const PUA = /[\uE000-\uF8FF]/;                  /* 私用区 = 还没被还原的密文字 */
  const PUA_ALL = /[\uE000-\uF8FF]/g;
  const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题', unknown: '' };

  const st = {
    key: 'q' + Math.random().toString(36).slice(2, 9),   /* 本帧标识，跳转时用它认领 */
    reqId: '',
    parts: [],            /* [{ key, order, items, unresolved }] */
    timer: 0,
    host: null,
    shadow: null,
    opened: false,
    localItems: [],       /* 本帧最近一次采集结果（跳转用，带 DOM 引用） */
    localUnresolved: 0
  };

  function uiCfg() { return (CX.cfg && CX.cfg.ui) || {}; }
  function enabled() { return uiCfg().questionCopy !== false; }

  /* ---------------- 文本处理 ---------------- */
  function fix(s) {
    try { return CX.fontDecrypt && CX.fontDecrypt.fix ? CX.fontDecrypt.fix(String(s == null ? '' : s)) : String(s == null ? '' : s); }
    catch (e) { return String(s == null ? '' : s); }
  }
  /* 还原 → 压缩空白；没还原的私用区字符换成 □ 并计数（不静默吞掉） */
  function plain(s, acc) {
    let out = CX.oneLine(fix(s));
    if (PUA.test(out)) {
      out = out.replace(PUA_ALL, function () { if (acc) acc.n++; return '□'; });
    }
    return out;
  }
  async function ensureFont() {
    if (!(CX.fontDecrypt && CX.fontDecrypt.ensure)) return;
    try {
      await Promise.race([CX.fontDecrypt.ensure(), new Promise(function (r) { setTimeout(r, 2500); })]);
    } catch (e) {}
  }

  /* 站点题干常自带「1【单选题】」「2.」前缀；面板会自己编号 + 标题型，所以这里去掉。
   * 只在「明显是题号」时去（数字后面跟【题型】或带 . / 、），不会把「1949年…」削掉。 */
  function stripHead(s) {
    let t = String(s || '').trim();
    const tagged = t.replace(/^\d{1,3}\s*[.、]?\s*(【[^】]{0,8}】)\s*/, '');
    if (tagged !== t) return tagged;
    return t.replace(/^\d{1,3}\s*[.、]\s*/, '');
  }
  function headTag(s) {
    const m = /^\s*\d{0,3}\s*【([^】]{1,8})】/.exec(String(s || ''));
    return m ? m[1] : '';
  }

  /* ---------------- 采集（每个 frame 各自跑） ---------------- */
  async function localCollect() {
    await ensureFont();
    const acc = { n: 0 };
    const items = [];
    let qs = [];
    try {
      if (CX.parser && CX.parser.collect) qs = CX.parser.collect(CX.parser.SEL.examBox, {}) || [];
    } catch (e) {}
    if (!qs.length) {
      try {
        const q = CX.parser && CX.parser.parseVideoQuiz ? CX.parser.parseVideoQuiz() : null;
        if (q && (q.stem || (q.options && q.options.length))) qs = [q];
      } catch (e) {}
    }
    qs.forEach(function (q, i) {
      const box = q.box || null;
      const rawStem = plain(q.stem || '', acc);
      const stem = stripHead(rawStem) || rawStem;
      if (!stem && !(q.options || []).length) return;
      const opts = (q.options || []).map(function (o) {
        return { label: String(o.label || ''), text: plain(o.text || '', acc) };
      });
      const type = q.type || 'unknown';
      items.push({
        idx: items.length, type: type,
        typeLabel: TYPE_LABEL[type] || headTag(rawStem) || '',
        stem: stem, options: opts, blanks: (q.blanks || []).length, box: box
      });
    });
    /* 兜底：解析不出结构时，把本帧所有密文块按行列出来（至少保证能复制） */
    if (!items.length) {
      const lines = [];
      CX.qsa('.font-cxsecret').forEach(function (el) {
        const t = plain(el.textContent || '', acc);
        if (t) lines.push(t);
      });
      if (lines.length) items.push({ idx: 0, type: 'unknown', typeLabel: '', stem: lines.join('\n'), options: [], blanks: 0, box: null });
    }
    st.localItems = items;
    st.localUnresolved = acc.n;
    return { key: st.key, order: 0, items: items, unresolved: acc.n };
  }

  /* ---------------- 复制 / 搜索文本 ---------------- */
  /* 复制范围：设置里选「只要题干」时，选项不参与复制（搜索关键词本来也只用题干） */
  function copyScope() { return uiCfg().copyScope === 'stem' ? 'stem' : 'both'; }

  function copyText(items, scope) {
    const sc = scope || copyScope();
    return (items || []).map(function (it, i) {
      let s = (i + 1) + (it.typeLabel ? '【' + it.typeLabel + '】' : '') + it.stem;
      if (sc !== 'stem') {
        (it.options || []).forEach(function (o) {
          s += '\n' + (o.label ? o.label + '、' : '') + o.text;
        });
        if (!(it.options || []).length && it.blanks) s += '\n（填空 ' + it.blanks + ' 空）';
      }
      return s;
    }).join('\n\n');
  }
  function cleanQuery(s) {
    return String(s || '')
      .replace(/^\s*\d+\s*[.、]?\s*/, '')
      .replace(/【[^】]{0,8}】/g, '')
      .replace(/[（(]\s*[)）]\s*$/, '')
      .replace(/□/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);
  }
  function searchUrl(stem) {
    let tpl = String(uiCfg().searchUrl || DEFAULT_SEARCH).trim();
    if (tpl.indexOf('%s') < 0) tpl = DEFAULT_SEARCH;
    return tpl.replace('%s', encodeURIComponent(cleanQuery(stem)));
  }

  /* ---------------- 跨帧消息 ---------------- */
  function send(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) {}
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || !msg.__broadcast) return;
      if (msg.kind === 'qtext_collect_bc' && msg.reqId) {
        localCollect().then(function (part) {
          if (!part.items.length) return;
          send({ kind: 'qtext', action: 'part', reqId: msg.reqId, part: part });
        }).catch(function () {});
        return;
      }
      if (msg.kind === 'qtext_focus_bc' && msg.key === st.key) focusLocal(msg.idx);
      if (msg.kind === 'qtext_clear_bc') clearHit();
    });
  } catch (e) {}

  /* 跳到本帧第 idx 题：滚到中间 + 1.6 秒描边
   * 2026-11-03 修正：以前只用一个定时器 + 只清自己那个元素的属性，
   * 连点两题时前一次的定时器被 clearTimeout 掉，前一个框就永远留在页面上。
   * 现在：① 每次跳转先清掉页面上所有 `data-cx-qtext-hit`；② 描边本身用 CSS 动画，
   * 动画结束自动变透明 —— 就算定时器被节流/页面被冻住，也不会一直挂着蓝框。 */
  /* 注意：颜色不能写 `!important` —— 作者 important 声明会压过 CSS 动画的关键帧
   * （上一版就是 `outline-color: transparent !important`，动画在跑但颜色永远透明，等于没有框）。
   * 所以线宽/线型用 important 压站点样式，颜色交给 animation 从蓝渐变到透明。 */
  const HIT_CSS = '[data-cx-qtext-hit]{outline-width:2px !important;outline-style:solid !important;outline-color:#2563eb;' +
    'outline-offset:3px !important;border-radius:6px;animation:cxq-hit 1.6s ease-out 1 both}' +
    '@keyframes cxq-hit{0%,80%{outline-color:#2563eb}100%{outline-color:transparent}}';
  let hitTimer = 0;
  function clearHit() {
    clearTimeout(hitTimer);
    hitTimer = 0;
    try {
      const all = document.querySelectorAll('[data-cx-qtext-hit]');
      for (let i = 0; i < all.length; i++) all[i].removeAttribute('data-cx-qtext-hit');
    } catch (e) {}
  }
  function ensureHitStyle() {
    let styleEl = document.getElementById('__cx_qtext_style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = '__cx_qtext_style';
      (document.head || document.documentElement).appendChild(styleEl);
    }
    if (styleEl.textContent !== HIT_CSS) styleEl.textContent = HIT_CSS;
  }
  function focusLocal(idx) {
    const it = st.localItems[Number(idx)];
    if (!it || !it.box) { CX.debug('题目原文：本帧没有第 ' + (Number(idx) + 1) + ' 题的容器'); return; }
    clearHit();
    try { it.box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { it.box.scrollIntoView(); } catch (e2) {} }
    try {
      ensureHitStyle();
      /* 先摘再挂 + 强制回流：同一元素连续跳两次也能重新播一遍动画 */
      it.box.removeAttribute('data-cx-qtext-hit');
      void it.box.offsetWidth;
      it.box.setAttribute('data-cx-qtext-hit', '1');
      hitTimer = setTimeout(clearHit, 1700);
    } catch (e) {}
  }

  /* ---------------- 面板（只在顶层建） ---------------- */
  const CSS = `
  :host { all: initial; }
  .wrap {
    position: fixed; z-index: 2147483000; width: 360px; max-width: 92vw;
    right: 16px; bottom: 96px; display: flex; flex-direction: column;
    font: 12px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #e8eef7; background: rgba(17,24,39,.96);
    border: 1px solid rgba(96,165,250,.35); border-radius: 12px;
    box-shadow: 0 14px 34px rgba(0,0,0,.5); overflow: hidden;
  }
  .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: move; user-select: none;
    background: linear-gradient(90deg, rgba(37,99,235,.55), rgba(14,165,233,.35)); }
  .hd .t { flex: 1; font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hd button { all: unset; cursor: pointer; padding: 2px 7px; border-radius: 6px; background: rgba(255,255,255,.12); font-size: 11px; }
  .hd button:hover { background: rgba(255,255,255,.26); }
  .idx { display: flex; gap: 4px; padding: 6px 8px; overflow-x: auto; border-bottom: 1px dashed rgba(148,163,184,.25); background: rgba(8,16,31,.5); }
  .idx button { all: unset; cursor: pointer; flex: none; min-width: 20px; height: 20px; line-height: 20px; text-align: center;
    padding: 0 5px; border-radius: 10px; font-size: 11px; color: #cfe1ff; background: rgba(59,130,246,.2); border: 1px solid rgba(96,165,250,.3); }
  .idx button:hover { background: rgba(59,130,246,.45); }
  .body { padding: 8px 10px; overflow: auto; max-height: min(70vh, 520px); }
  .q { padding: 6px 0; border-bottom: 1px dashed rgba(148,163,184,.18); }
  .q:last-child { border-bottom: 0; }
  .qh { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
  .qh .no { color: #93c5fd; font-weight: 600; }
  .qh .tag { color: #fbbf24; font-size: 11px; }
  .qh .sp { flex: 1; }
  .qh button { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; font-size: 10.5px;
    color: #cfe1ff; background: rgba(59,130,246,.18); border: 1px solid rgba(96,165,250,.3); }
  .qh button:hover { background: rgba(59,130,246,.4); }
  .stem { color: #e2e8f0; white-space: pre-wrap; word-break: break-word; }
  .opt { color: #b9c7da; padding-left: 2px; white-space: pre-wrap; word-break: break-word; }
  .ft { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-top: 1px dashed rgba(148,163,184,.25); background: rgba(8,16,31,.55); }
  .ft .note { flex: 1; color: #fbbf24; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ft button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 7px; font-size: 11px;
    color: #dbeafe; background: rgba(59,130,246,.22); border: 1px solid rgba(96,165,250,.35); }
  .ft button:hover { background: rgba(59,130,246,.42); }
  .ft button.primary { background: linear-gradient(180deg, rgba(37,99,235,.85), rgba(29,78,216,.85)); border-color: rgba(147,197,253,.5); font-weight: 600; }
  .empty { color: #93a4bd; text-align: center; padding: 18px 6px; }
  `;

  function build() {
    if (st.host) return;
    const host = document.createElement('div');
    host.id = '__cx_qtext_host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="wrap" id="wrap">
        <div class="hd" id="hd">
          <span class="t" id="title">题目原文</span>
          <button data-act="refetch" title="重新抓取">重抓</button>
          <button data-act="close" title="关闭">×</button>
        </div>
        <div class="idx" id="idx"></div>
        <div class="body" id="body"><div class="empty">收集中…</div></div>
        <div class="ft">
          <span class="note" id="note"></span>
          <button class="primary" data-act="copy">一键复制</button>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    shadow.getElementById('hd').addEventListener('pointerdown', startDrag);
    shadow.addEventListener('click', onClick);
    st.host = host;
    st.shadow = shadow;
    restorePos();
  }

  let drag = null;
  function startDrag(e) {
    if (e.target.tagName === 'BUTTON') return;
    const wrap = st.shadow.getElementById('wrap');
    const r = wrap.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    wrap.style.left = r.left + 'px';
    wrap.style.top = r.top + 'px';
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
    root.addEventListener('pointermove', onDrag);
    root.addEventListener('pointerup', endDrag, { once: true });
    e.preventDefault();
  }
  function onDrag(e) {
    if (!drag) return;
    const wrap = st.shadow.getElementById('wrap');
    const w = wrap.offsetWidth || 360, h = wrap.offsetHeight || 300;
    wrap.style.left = Math.max(0, Math.min(root.innerWidth - w, e.clientX - drag.dx)) + 'px';
    wrap.style.top = Math.max(0, Math.min(root.innerHeight - h, e.clientY - drag.dy)) + 'px';
  }
  function endDrag() {
    drag = null;
    root.removeEventListener('pointermove', onDrag);
    const wrap = st.shadow.getElementById('wrap');
    const w = wrap.offsetWidth || 360, h = wrap.offsetHeight || 300;
    const left = parseFloat(wrap.style.left) || 0;
    const top = parseFloat(wrap.style.top) || 0;
    const pos = { right: Math.max(0, Math.min(root.innerWidth - w, root.innerWidth - left - w)), bottom: Math.max(0, Math.min(root.innerHeight - h, root.innerHeight - top - h)) };
    try { chrome.storage.local.set({ cxQTextPos: pos }); } catch (e) {}
  }
  function restorePos() {
    try {
      chrome.storage.local.get(['cxQTextPos'], function (r) {
        const p = r && r.cxQTextPos;
        const wrap = st.shadow && st.shadow.getElementById('wrap');
        if (!p || !wrap) return;
        if (typeof p.right === 'number') { wrap.style.right = p.right + 'px'; wrap.style.left = 'auto'; }
        if (typeof p.bottom === 'number') { wrap.style.bottom = p.bottom + 'px'; wrap.style.top = 'auto'; }
        setTimeout(clampPanel, 60);
      });
    } catch (e) {}
  }

  /* 2026-11-03：跟常态浮窗一样自愈 —— 面板越界（窗口变小 / 记住的坐标来自小窗口）就回默认右下角，
   * 并把记住的坐标一起改回来，下次打开不会再飘出去。 */
  function resetPos() {
    const wrap = st.shadow && st.shadow.getElementById('wrap');
    if (!wrap) return;
    wrap.style.left = 'auto';
    wrap.style.top = 'auto';
    wrap.style.right = '16px';
    wrap.style.bottom = '96px';
    try { chrome.storage.local.set({ cxQTextPos: { right: 16, bottom: 96 } }); } catch (e) {}
  }
  function clampPanel() {
    if (!st.shadow || !st.host || st.host.style.display === 'none') return;
    const wrap = st.shadow.getElementById('wrap');
    if (!wrap) return;
    const vw = root.innerWidth || 800;
    const vh = root.innerHeight || 600;
    const r = wrap.getBoundingClientRect();
    const bad = !r.width || !r.height || r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1;
    if (bad) {
      CX.debug('题目原文面板越界（' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' / 视口 ' + vw + 'x' + vh + '），已复位到右下角');
      resetPos();
    }
  }
  let posTimer = 0;
  try {
    root.addEventListener('resize', function () {
      clearTimeout(posTimer);
      posTimer = setTimeout(function () { if (st.opened) clampPanel(); }, 300);
    });
    setInterval(function () { if (st.opened) clampPanel(); }, 2500);
  } catch (e) {}

  /* ---------------- 渲染 ---------------- */
  function flatItems() {
    const out = [];
    st.parts.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).forEach(function (p) {
      (p.items || []).forEach(function (it) { out.push({ key: p.key, idx: it.idx, it: it }); });
    });
    return out;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function render(final) {
    if (!st.shadow) return;
    const flat = flatItems();
    const title = st.shadow.getElementById('title');
    const idxBox = st.shadow.getElementById('idx');
    const body = st.shadow.getElementById('body');
    const note = st.shadow.getElementById('note');
    title.textContent = '题目原文' + (flat.length ? ' · 共 ' + flat.length + ' 题' : '');
    if (!flat.length) {
      idxBox.innerHTML = '';
      body.innerHTML = '<div class="empty">' + (final ? '本页没有检测到题目<br>（题目可能在未响应的跨域 frame 里）' : '收集中…') + '</div>';
      note.textContent = '';
      return;
    }
    idxBox.innerHTML = flat.map(function (x, i) {
      return '<button data-act="focus" data-k="' + esc(x.key) + '" data-i="' + x.idx + '" title="跳到第 ' + (i + 1) + ' 题">' + (i + 1) + '</button>';
    }).join('');
    body.innerHTML = flat.map(function (x, i) {
      const it = x.it;
      const opts = (it.options || []).map(function (o) {
        return '<div class="opt">' + esc((o.label ? o.label + '、' : '') + o.text) + '</div>';
      }).join('');
      const blanks = (!(it.options || []).length && it.blanks) ? '<div class="opt">（填空 ' + it.blanks + ' 空）</div>' : '';
      return '<div class="q" data-i="' + i + '">' +
        '<div class="qh"><span class="no">' + (i + 1) + '</span>' +
        (it.typeLabel ? '<span class="tag">【' + esc(it.typeLabel) + '】</span>' : '') +
        '<span class="sp"></span>' +
        '<button data-act="focus" data-k="' + esc(x.key) + '" data-i="' + x.idx + '">跳转</button>' +
        '<button data-act="search" data-k="' + esc(x.key) + '" data-i="' + x.idx + '">搜索</button>' +
        '<button data-act="copyone" data-k="' + esc(x.key) + '" data-i="' + x.idx + '" title="复制本题（按设置里的「复制内容」）">复制</button></div>' +
        '<div class="stem">' + esc(it.stem) + '</div>' + opts + blanks + '</div>';
    }).join('');
    const unresolved = st.parts.reduce(function (n, p) { return n + (p.unresolved || 0); }, 0);
    note.textContent = (final ? '' : '收集中… ') + (unresolved ? '⚠ 还有 ' + unresolved + ' 个字没还原' : '');
  }

  function findItem(key, idx) {
    const p = st.parts.filter(function (x) { return x.key === key; })[0];
    if (!p) return null;
    return p.items.filter(function (it) { return String(it.idx) === String(idx); })[0] || null;
  }

  function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'close') { close(); return; }
    if (act === 'refetch') { refetch(); return; }
    if (act === 'copy') { doCopy(); return; }
    if (act === 'copyone') {
      const one = findItem(btn.getAttribute('data-k'), btn.getAttribute('data-i'));
      if (!one) { setNote('这题已经被页面刷新掉了'); return; }
      copyToClipboard(copyText([one]), '已复制本题');
      return;
    }
    if (act === 'focus' || act === 'search') {
      const it = findItem(btn.getAttribute('data-k'), btn.getAttribute('data-i'));
      if (act === 'search') { doSearch(it); return; }
      send({ kind: 'qtext', action: 'focus', key: btn.getAttribute('data-k'), idx: Number(btn.getAttribute('data-i')) });
      /* 面板自己也滚到那一块 */
      try {
        const blocks = st.shadow.querySelectorAll('.q');
        const want = Array.prototype.indexOf.call(blocks, btn.closest('.q'));
        const target = want >= 0 ? blocks[want] : null;
        const body = st.shadow.getElementById('body');
        const flat = flatItems();
        const i = flat.findIndex(function (x) { return x.key === btn.getAttribute('data-k') && String(x.idx) === String(btn.getAttribute('data-i')); });
        if (!target && i >= 0 && body) {
          const el = body.querySelector('.q[data-i="' + i + '"]');
          if (el) el.scrollIntoView({ block: 'nearest' });
        }
      } catch (err) {}
    }
  }

  function doCopy() {
    copyToClipboard(copyText(flatItems().map(function (x) { return x.it; })), '');
  }
  function copyToClipboard(text, okLabel) {
    if (!text) { setNote('没有可复制的内容'); return; }
    const done = function () { setNote(okLabel || ('已复制 ' + text.replace(/\s/g, '').length + ' 字')); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
        return;
      }
    } catch (e) {}
    fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      ok ? done() : setNote('复制失败，请在面板里手动选中');
    } catch (e) { setNote('复制失败，请在面板里手动选中'); }
  }
  let noteTimer = 0;
  function setNote(t) {
    if (!st.shadow) return;
    const note = st.shadow.getElementById('note');
    if (!note) return;
    note.textContent = t;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { try { render(true); } catch (e) {} }, 2200);
  }

  function doSearch(it) {
    if (!it) return;
    const url = searchUrl(it.stem);
    send({ kind: 'openUrl', url: url });
    if (uiCfg().searchCopy === true) copyToClipboard(copyText([it]), '已复制本题');
    setNote('已打开搜索');
  }

  function refetch(attempt, silent) {
    if (!st.shadow) return;
    clearHit();
    send({ kind: 'qtext', action: 'clear' });
    const reqId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    st.reqId = reqId;
    st.parts = [];
    render();
    /* 先放本帧的结果：即使后台消息不通（扩展刚重载等）也有东西可复制 */
    localCollect().then(function (part) {
      if (st.reqId !== reqId) return;
      if (part.items.length) mergePart({ key: part.key, order: 0, items: part.items, unresolved: part.unresolved });
    }).catch(function () {});
    send({ kind: 'qtext', action: 'collect', reqId: reqId });
    clearTimeout(st.timer);
    st.timer = setTimeout(function () {
      if (st.reqId !== reqId) return;
      render(true);
      /* 2026-11-03：换章后子帧的内容脚本要等 DOM 就绪才回话，第一次常常是空的 ——
       * 空结果时自动再抓两次（总共约 4.5 秒），省得面板一直显示「没有检测到题目」。 */
      if (!flatItems().length && (attempt || 0) < 2) {
        setTimeout(function () {
          if (st.opened && st.reqId === reqId) refetch((attempt || 0) + 1, true);
        }, 1500);
      }
    }, 1400);
  }

  function mergePart(part) {
    if (!part || !part.key) return;
    st.parts = st.parts.filter(function (p) { return p.key !== part.key; });
    st.parts.push(part);
    render();
  }

  function open() {
    if (!enabled()) { CX.warn('设置里关掉了「浮窗题目原文按钮」，面板不打开'); return; }
    if (!CX.isTop) return;
    build();
    st.host.style.display = '';
    st.opened = true;
    refetch();
  }
  function close() {
    if (st.host) st.host.style.display = 'none';
    st.opened = false;
    clearHit();
    send({ kind: 'qtext', action: 'clear' });
  }
  function toggle() { st.opened ? close() : open(); }

  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || !msg.__broadcast) return;
      if (msg.kind === 'qtext_part_bc' && msg.reqId && msg.reqId === st.reqId && msg.part) {
        mergePart({ key: msg.part.key, order: Number(msg.frameId || 0), items: msg.part.items || [], unresolved: msg.part.unresolved || 0 });
      }
    });
  } catch (e) {}

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && st.opened && st.host && st.host.style.display !== 'none') close();
  }, true);

  /* ---------------- 换章自动刷新（顶层） ----------------
   * 站点切章是 ajax 换 iframe，顶层 URL 的 chapterId 会跟着变；面板开着就重抓一次。
   * URL 没变但 nav 已经算出新 chapterKey 的情况也兜住。 */
  function chapSig() {
    let s = '';
    try {
      const m = String(location.href).match(/[?&](?:chapterId|knowledgeid|knowledgeId)=(\d+)/i);
      if (m) s = m[1];
    } catch (e) {}
    if (!s) {
      try { if (CX.nav && CX.nav.state) s = String(CX.nav.state.chapterKey || ''); } catch (e) {}
    }
    return s;
  }
  if (CX.isTop) {
    let lastSig = chapSig();
    setInterval(function () {
      if (!st.opened) { lastSig = chapSig(); return; }
      const s = chapSig();
      if (!s || s === lastSig) return;
      lastSig = s;
      CX.debug('题目原文：检测到换章（' + s + '），重新抓取');
      refetch(0, true);
    }, 1200);
  }

  CX.qtext = {
    open: open,
    close: close,
    toggle: toggle,
    localCollect: localCollect,
    copyText: copyText,
    cleanQuery: cleanQuery,
    searchUrl: searchUrl,
    focusItem: function (idx) { send({ kind: 'qtext', action: 'focus', key: st.key, idx: Number(idx) }); },
    state: st
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
