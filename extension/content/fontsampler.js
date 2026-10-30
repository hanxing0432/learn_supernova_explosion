/* 字体样本采集器（font-cxsecret）—— 按「章节」打包
 *
 * 只做收集。一章一条记录：整章乱码 + 字体原件 + 每字字形指纹 + 你截的图（可多张）+ 真文字。
 *   ① 点「采集本章」→ 抓本章所有加密块的码位原文 + 字体 + 字形指纹
 *   ② 截图你自己截（Win+Shift+S / 整页截图），回到面板 Ctrl+V 挂到本章（可多张、可分批追加）
 *   ③ 把 AI 读图得到的整章文字粘进大框 → 「保存本章」
 * 之后再统一解码：tools/aggregate-samples.mjs 汇总成「字形指纹 → 真字」，fontdecrypt 查表即得。
 *
 * 为什么必须靠截图：复制页面拿到的是码位（乱码），真文字只存在于渲染出的像素里。
 *
 * 落盘：本地收样服务 http://127.0.0.1:8788（tools/sample-server.mjs）
 *       服务没起时退化为 chrome.storage + 下载 JSON，不丢数据。
 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX) return;
  if (root.__CX_FONTSAMPLER__) return;

  /* 面板要钉在**屏幕**右上角：所以只在顶层窗口出界面，同源时由顶层直接读子 frame 的 DOM。
   * （以前跑在答题 iframe 里，position:fixed 是相对 iframe 的，外层页面一滚面板就被带走了。）
   * 跨域 iframe 读不到时才退回本 frame 自建界面。 */
  const CROSS_ORIGIN = (function () {
    try { return !root.top || !root.top.document; } catch (e) { return true; }
  })();
  if (!CX.isTop && !CROSS_ORIGIN) return;

  root.__CX_FONTSAMPLER__ = true;

  const FONT_HINT = 'cxsecret';
  const SEL = '.font-cxsecret';
  const STORE_KEY = 'cxSampleQueue';
  const CHAPTER_INDEX = 96;      /* 章节级记录用固定块号，避免和单题记录混淆 */
  const GLYPH_INDEX = 99;

  const state = {
    ready: false,
    enabled: true,          /* 采集器开关（跟 cxConfig.samples.enabled 同步） */
    watching: false,
    autoDone: false,        /* 本页是否已经自动抓取并保存过 */
    saving: false,
    saveTimer: null,
    font: null,
    fontMeta: null,
    blocks: [],                  /* 仅用于拼整章原文 / 字形 / 定位 */
    glyphCells: [],
    chapter: { readable: '', pairs: [], shots: [], align: null, previewHTML: '' },
    server: { ok: false, samples: 0, glyphs: 0 },
    tab: 'chapter',
    lastMsg: '',
    lastOk: false,
    lastPanelClick: 0,
    corner: 'tr',                   /* 默认屏幕右上角 */
    pos: null,                   /* 拖拽后的坐标；null = 用角落预设 */
    chapterKey: '',              /* 当前章节标识；变了就清空图上/真文字，防止串章 */
    suppressClick: 0,            /* 刚拖完时压掉这一次 click */
    pollTimer: null
  };

  let host = null, shadow = null, pill = null, panel = null, fileInput = null, jsonInput = null, bound = false;

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function isCJK(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
  }
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: '无响应' });
        });
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
    });
  }

  /* ---------------- 扫描 ---------------- */
  /* 同源的子 frame 全部收进来（答题页在第 3 层 iframe 里） */
  function collectDocs() {
    const out = [];
    (function walk(win) {
      let doc = null;
      try { doc = win.document; } catch (e) { return; }
      if (!doc) return;
      out.push(doc);
      let frames = null;
      try { frames = win.frames; } catch (e) { return; }
      if (!frames) return;
      for (let i = 0; i < frames.length; i++) {
        try { walk(frames[i]); } catch (e) {}
      }
    })(root);
    return out;
  }

  function familyOf(el) {
    try {
      const w = el.ownerDocument.defaultView || root;
      return String(w.getComputedStyle(el).fontFamily || '').split(',')[0].replace(/^["']|["']$/g, '').trim();
    } catch (e) { return ''; }
  }

  function scanBlocks() {
    const out = [];
    collectDocs().forEach(function (doc) {
      let els = [];
      try { els = doc.querySelectorAll(SEL); } catch (e) { return; }
      Array.prototype.forEach.call(els, function (el) {
        const raw = String(el.textContent || '');
        if (!raw.trim()) return;
        let container = null;
        try { container = el.closest('.TiMu, .questionLi, .Cy_TItle, li') || el.parentElement; } catch (e) { container = el.parentElement; }
        const ctext = oneLine(container ? container.textContent : '');
        const m = ctext.match(/^\s*(\d{1,2})\s/);
        out.push({
          index: out.length,
          el: el,
          doc: doc,
          raw: raw,
          family: familyOf(el),
          qno: m ? m[1] : '',
          ctext: ctext.slice(0, 60)
        });
      });
    });
    return out;
  }

  async function loadFont() {
    if (!CX.ttf || !CX.ttf.dom) return null;
    const fam = (state.blocks[0] && state.blocks[0].family) || FONT_HINT;
    const docs = state.blocks.length
      ? state.blocks.map(function (b) { return b.doc; }).filter(function (d, i, a) { return a.indexOf(d) === i; })
      : collectDocs();
    let face = null;
    for (const d of docs) {
      try { face = CX.ttf.dom.pickFace(d, fam) || CX.ttf.dom.pickFace(d, FONT_HINT); } catch (e) { face = null; }
      if (face && face.b64) break;
    }
    if (!face || !face.b64) return null;
    try {
      const font = await CX.ttf.load(face.b64);
      state.font = font;
      state.fontMeta = {
        id: font.id,
        family: face.family || fam,
        sig48: String(face.b64 || '').slice(0, 48),
        sha1: font.sha1 || '',
        bytes: font.bytes || Math.round(String(face.b64 || '').length * 3 / 4),
        upem: font.upem,
        numGlyphs: font.numGlyphs,
        names: font.names || {},
        cipher: font.codepoints.map(function (cp) { return String.fromCharCode(cp); }).filter(isCJK),
        b64: face.b64
      };
      ensurePreviewFont(face.b64);
      return font;
    } catch (e) {
      CX.warn('字体解析失败：' + ((e && e.message) || e));
      return null;
    }
  }

  /* 顶层文档里注册一份预览字体：子 frame 的 @font-face 在顶层 canvas 上用不了 */
  let previewInjected = false;
  function ensurePreviewFont(b64) {
    if (previewInjected || !b64) return;
    try {
      const st = document.createElement('style');
      st.textContent = '@font-face{font-family:"fs-preview";src:url("data:application/font-ttf;charset=utf-8;base64,' + b64 + '")}';
      (document.head || document.documentElement).appendChild(st);
      previewInjected = true;
    } catch (e) {}
  }

  function glyphInfo(ch) {
    if (!state.font) return null;
    const i = state.font.infoForChar(ch);
    return i && i.mapped && i.sig ? i : null;
  }
  /* 加密字 = 码位在字体 cmap 里的字；其余字在字体里没有字形，浏览器回退到页面字体，本来就是原文 */
  function cipherCharsOf(raw) {
    const out = [], seen = Object.create(null);
    for (const ch of String(raw || '')) {
      if (seen[ch]) continue;
      seen[ch] = 1;
      if (glyphInfo(ch)) out.push(ch);
    }
    return out;
  }

  function buildGlyphCells() {
    const seen = new Map();
    for (const b of state.blocks) {
      for (const ch of b.raw) {
        if (!isCJK(ch) || seen.has(ch)) continue;
        const info = glyphInfo(ch);
        if (!info) continue;
        seen.set(ch, {
          ch: ch, sig: info.sig, sigRaw: info.sigRaw, gid: info.gid, aw: info.aw,
          points: info.points, count: 0, guess: '', labeled: '', edited: false
        });
      }
    }
    for (const b of state.blocks) for (const ch of b.raw) { if (seen.has(ch)) seen.get(ch).count++; }
    state.glyphCells = Array.from(seen.values());
    return state.glyphCells;
  }

  /* 整章原文：按块顺序拼接（对齐时会忽略空白，所以换行只是人看的） */
  function chapterRaw() {
    return state.blocks.map(function (b) { return String(b.raw || '').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean).join('\n');
  }

  /* ---------------- 对齐 ----------------
   * 用「贪心前向对齐」而不是全局 LCS：加密文本里同一个字在不同位置**长得一样但码位不同**，
   * 全局 LCS 会为了多凑几个匹配而"跳跃"到后面的明文（实测：readable 里的「获利」被匹配到
   * 第二题的明文「获利」，导致第一题后半段整段判成无法对齐）。
   * 贪心只在本地窗口内跳过插入/漏字，顺序永远向前，正好适合"整章按顺序粘进来"的场景。 */
  function alignText(raw, readable, opts) {
    opts = opts || {};
    const A = Array.from(String(raw || '').replace(/[\s\u00a0]+/g, ''));
    const B = Array.from(String(readable || '').replace(/[\s\u00a0]+/g, ''));
    const pairs = [], notes = [], badChars = [];
    const n = A.length, m = B.length;
    const W = 6;                       /* 本地窗口：容忍 6 个字以内的插入/漏字 */

    function addPair(c, ch) {
      const info = glyphInfo(c);
      if (!info || c === ch) return;
      if (!isCJK(ch)) { badChars.push(c + '→' + ch); return; }
      pairs.push({ c: c, ch: ch, sig: info.sig, sigRaw: info.sigRaw, gid: info.gid, aw: info.aw, src: opts.src || 'manual' });
    }

    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { i++; j++; continue; }

      /* A[i] 在 readable 后面 W 个字内出现 → readable 多插了字，跳过 */
      let bSkip = -1;
      for (let k = 1; k <= W && j + k < m; k++) { if (B[j + k] === A[i]) { bSkip = k; break; } }
      /* B[j] 在 raw 后面 W 个字内出现 → raw 多了字（比如漏转写），跳过 */
      let aSkip = -1;
      for (let k = 1; k <= W && i + k < n; k++) { if (A[i + k] === B[j]) { aSkip = k; break; } }

      if (bSkip > 0 && (aSkip < 0 || bSkip <= aSkip)) {
        notes.push('多出「' + B.slice(j, j + bSkip).join('') + '」');
        j += bSkip;
      } else if (aSkip > 0) {
        notes.push('缺「' + A.slice(i, i + aSkip).join('') + '」');
        i += aSkip;
      } else {
        addPair(A[i], B[j]);
        i++; j++;
      }
    }

    const uniq = new Map();
    for (const p of pairs) if (!uniq.has(p.c)) uniq.set(p.c, p);
    const cipherAll = cipherCharsOf(raw);
    const covered = new Set(Array.from(uniq.keys()));
    const missing = cipherAll.filter((c) => !covered.has(c));
    return {
      pairs: Array.from(uniq.values()),
      cipherTotal: cipherAll.length,
      covered: covered.size,
      missing: missing,
      ambiguous: notes,
      badChars: badChars,
      ok: missing.length === 0
    };
  }

  /* ---------------- 本地存储（扩展内，不需要任何 cmd/服务） ---------------- */
  const SAMPLE_KEY = 'cxSamples';
  const FONT_KEY = 'cxFonts';
  const DICT_KEY = 'cxGlyphDict';
  const MAX_SAMPLES = 160;

  function stGet(keys) {
    return new Promise(function (r) { try { chrome.storage.local.get(keys, r); } catch (e) { r({}); } });
  }
  function stSet(obj) {
    return new Promise(function (r) { try { chrome.storage.local.set(obj, r); } catch (e) { r(); } });
  }

  function recordId(fontId, idx) { return (fontId || 'x') + ':' + idx; }

  /* 保存一章：记录 + 字体原件，图片按内容去重后追加 */
  async function saveLocal(payload) {
    const fm = state.fontMeta || {};
    const got = await stGet([SAMPLE_KEY, FONT_KEY]);
    const samples = Array.isArray(got[SAMPLE_KEY]) ? got[SAMPLE_KEY] : [];
    const fonts = got[FONT_KEY] || {};

    if (fm.id && fm.b64 && !fonts[fm.id]) {
      fonts[fm.id] = {
        id: fm.id, family: fm.family, b64: fm.b64, bytes: fm.bytes, upem: fm.upem,
        numGlyphs: fm.numGlyphs, names: fm.names, cipher: fm.cipher, ts: Date.now()
      };
    }

    const blk = payload.blocks[0] || {};
    const id = recordId(fm.id, blk.index);
    const at = samples.findIndex(function (s) { return s.id === id; });
    const old = at >= 0 ? samples[at] : null;

    const oldShots = payload.clearShots ? [] : ((old && old.block && old.block.shots) || []);
    const shots = oldShots.slice(0);
    (blk.shots || []).forEach(function (s) { if (s && shots.indexOf(s) < 0) shots.push(s); });
    const oldPairs = (old && old.block && old.block.pairs) || [];

    const rec = {
      id: id,
      ts: payload.ts || Date.now(),
      fontId: fm.id,
      page: { href: (payload.page || {}).href || '', title: (payload.page || {}).title || '' },
      block: {
        index: blk.index,
        kind: blk.kind || '',
        raw: blk.raw || '',
        readable: (blk.readable || '').trim() ? blk.readable : ((old && old.block && old.block.readable) || ''),
        pairs: (blk.pairs && blk.pairs.length) ? blk.pairs : oldPairs,
        shots: shots,
        status: ((blk.pairs && blk.pairs.length) || oldPairs.length) ? 'labeled' : 'raw'
      }
    };
    if (at >= 0) samples[at] = rec; else samples.push(rec);
    while (samples.length > MAX_SAMPLES) samples.shift();

    await stSet({ [SAMPLE_KEY]: samples, [FONT_KEY]: fonts });
    return { ok: true, id: id, total: samples.length };
  }

  /* 在扩展内重算字形字典（等价于 tools/aggregate-samples.mjs，但不用起服务）
   * 写进 chrome.storage.local.cxGlyphDict 后，fontdecrypt 会自己监听并重建。 */
  async function rebuildDict() {
    if (!root.CXGlyphDict) return null;
    const got = await stGet([SAMPLE_KEY]);
    const samples = Array.isArray(got[SAMPLE_KEY]) ? got[SAMPLE_KEY] : [];
    const d = root.CXGlyphDict.build(samples);
    /* 只增不减：本地已有更多条目时（例如从服务端同步来的全量字典），绝不能被单章样本覆盖掉。
     * 曾经因为这条把 508 条打回 42 条 —— 样本被清空后重算字典就是这样翻车的。 */
    const cur = await stGet([DICT_KEY]);
    const prev = (cur && cur[DICT_KEY]) || null;
    const prevMap = (prev && prev.map) || {};
    const prevRaw = (prev && prev.raw) || {};
    const nPrev = Object.keys(prevMap).length;
    const nNew = Object.keys(d.map || {}).length;
    if (nPrev > nNew && !(d.n > 0 && nNew >= nPrev)) {
      return { ts: prev.ts, map: prevMap, raw: prevRaw, n: nPrev, stats: prev.stats, kept: true };
    }
    /* 已有条目优先：样本里可能还留着旧的人工标签，不能反过来把已核对的字典覆盖回去 */
    const merged = Object.assign({}, d.map || {}, prevMap);
    const mergedRaw = Object.assign({}, d.raw || {}, prevRaw);
    const dict = { ts: d.ts, map: merged, raw: mergedRaw, n: Object.keys(merged).length, stats: d.stats };
    await stSet({ [DICT_KEY]: dict });
    return dict;
  }

  /* 记录来源页：优先用真正出现加密块的那个 frame 的地址 */
  function pageHref() {
    try {
      const b = state.blocks[0];
      if (b && b.doc && b.doc.location) return String(b.doc.location.href);
    } catch (e) {}
    return String(location.href);
  }

  async function persistChapter(opts) {
    opts = opts || {};
    const fm = state.fontMeta || {};
    const payload = {
      ts: Date.now(),
      clearShots: !!opts.clearShots,
      page: {
        href: pageHref(),
        title: document.title,
        shots: state.chapter.shots.slice(0)
      },
      user: 'local',
      font: {
        id: fm.id, family: fm.family, sig48: fm.sig48, bytes: fm.bytes,
        upem: fm.upem, numGlyphs: fm.numGlyphs, names: fm.names, cipher: fm.cipher, b64: fm.b64
      },
      blocks: [{
        index: CHAPTER_INDEX,
        kind: '整章',
        raw: chapterRaw(),
        readable: state.chapter.readable || '',
        status: state.chapter.pairs.length ? 'labeled' : 'raw',
        pairs: state.chapter.pairs,
        shots: state.chapter.shots.slice(0)
      }]
    };

    let local = null;
    try {
      local = await saveLocal(payload);
    } catch (e) {
      setMsg('本地保存失败：' + ((e && e.message) || e), false);
      return { ok: false, error: String((e && e.message) || e) };
    }
    const dict = await rebuildDict();

    /* 顺手归档：如果本地收样服务碰巧开着就多存一份到磁盘，没开就算了，不影响使用 */
    try { send({ kind: 'sample', action: 'ingest', payload: payload, optional: true }); } catch (e) {}

    return {
      ok: true,
      local: local,
      fontId: fm.id,
      dictSize: dict ? dict.n : 0,
      dictStats: dict ? dict.stats : null
    };
  }

  async function refreshStats() {
    const got = await stGet([SAMPLE_KEY, DICT_KEY]);
    const samples = Array.isArray(got[SAMPLE_KEY]) ? got[SAMPLE_KEY] : [];
    const dict = got[DICT_KEY] || {};
    state.server = { ok: true, samples: samples.length, glyphs: dict.n || 0 };
    paintStatus();
  }

  function setMsg(text, ok) {
    state.lastMsg = text;
    state.lastOk = !!ok;
    paintStatus();
  }

  /* ---------------- 图片粘贴 ---------------- */
  function readImageFiles(files, cb) {
    const list = Array.from(files || []).filter(function (f) { return /^image\//.test(f.type); });
    if (!list.length) return;
    let pending = list.length;
    const out = [];
    list.forEach(function (f) {
      const fr = new FileReader();
      fr.onload = function () { out.push(String(fr.result)); if (--pending === 0) cb(out); };
      fr.onerror = function () { if (--pending === 0) cb(out); };
      fr.readAsDataURL(f);
    });
  }

  function attachShots(dataUrls) {
    if (!dataUrls || !dataUrls.length) return 0;
    state.chapter.shots = state.chapter.shots.concat(dataUrls);
    scheduleSave(600);
    return dataUrls.length;
  }

  /* 防抖自动保存：粘上图/改完字就存，不用再点按钮 */
  function scheduleSave(delay) {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      if (!state.fontMeta || state.saving) return;
      state.saving = true;
      persistChapter().then(function (r) {
        state.saving = false;
        refreshStats();
        if (panel && panel.style.display !== 'none') render();
        setMsg(r && r.ok
          ? '已自动保存：' + state.blocks.length + ' 块 · 图 ' + state.chapter.shots.length + ' 张 · 字典 ' + (r.dictSize || 0) + ' 条'
          : '保存失败：' + ((r && r.error) || ''), !!(r && r.ok));
      }).catch(function () { state.saving = false; });
    }, delay || 600);
  }

  /* ---------------- UI ---------------- */
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.pill { position: fixed; z-index: 2147483000; background: #1d2632; color: #cfe0f5;
  border: 1px solid #3a4c62; border-radius: 12px; padding: 6px 10px; font-size: 11px; cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.45); display: flex; align-items: center; gap: 6px; user-select: none;
  line-height: 1.35; max-width: 210px; }
.pill:hover { background: #263245; }
.pill.hot { border-color: #3b7ab5; background: #1c3347; }
.pill.ok { border-color: #2f7d5a; background: #16301f; }
.pill b { color: #7fd1ae; font-weight: 600; }
.pill .h { color: #7b8698; font-size: 10px; }
.panel { position: fixed; z-index: 2147483001; width: 330px; max-height: 46vh;
  background: #141a22; color: #d7dde5; border: 1px solid #2c3644; border-radius: 12px;
  box-shadow: 0 18px 50px rgba(0,0,0,.6); display: flex; flex-direction: column; font-size: 11.5px; outline: none; }
.panel.drop { border-color: #3b7ab5; box-shadow: 0 0 0 2px #2a5480, 0 18px 50px rgba(0,0,0,.6); }
.hd { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid #242d39;
  background: #182029; border-radius: 12px 12px 0 0; }
.hd .t { font-weight: 600; color: #eaf0f7; font-size: 12.5px; }
.sp { flex: 1; }
.ic { cursor: pointer; color: #8b98a9; padding: 0 4px; font-size: 14px; line-height: 1; }
.ic:hover { color: #cfe0f5; }
.tabs { display: flex; gap: 2px; padding: 7px 9px 0; }
.tabs button { flex: 1; background: #1b232e; border: 1px solid #27313d; border-bottom: none; color: #8b98a9;
  padding: 5px 0; border-radius: 7px 7px 0 0; cursor: pointer; font-size: 11.5px; }
.tabs button.on { background: #223041; color: #eaf0f7; border-color: #3a4c62; }
.body { overflow: auto; padding: 9px; flex: 1; }
.msg { font-size: 10.5px; color: #7fd1ae; padding: 0 10px 5px; min-height: 14px; }
.msg.bad { color: #e2b04d; }
.st { font-size: 10px; color: #6d7a8b; padding: 5px 10px; border-top: 1px solid #242d39; display: flex; gap: 7px; }
.st .dot { color: #7fd1ae; } .st .dot.off { color: #8a5b5b; }
.big { width: 100%; background: #2a5f8f; border: 1px solid #3b7ab5; color: #f0f7ff; border-radius: 7px;
  padding: 9px; font-size: 13px; cursor: pointer; margin-bottom: 8px; font-weight: 600; }
.big:hover { background: #336fa4; }
.big.ghost { background: #1e2833; border-color: #33465c; color: #cfe0f5; font-weight: 400; }
.big.sm { padding: 5px; font-size: 11.5px; font-weight: 400; }
textarea { width: 100%; background: #0f151c; color: #e6edf5; border: 1px solid #2b3644;
  border-radius: 6px; padding: 6px 7px; font-size: 11.5px; font-family: inherit; resize: vertical; }
.mini { background: #223041; border: 1px solid #33465c; color: #cfe0f5; border-radius: 5px; padding: 3px 8px;
  font-size: 10.5px; cursor: pointer; white-space: nowrap; }
.mini:hover { background: #2c3c50; }
.mini.warn { border-color: #6b4a2a; color: #e2c08d; }
.row { display: flex; gap: 6px; margin-top: 6px; align-items: center; flex-wrap: wrap; }
.tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: #23303f; color: #9fb0c3; white-space: nowrap; }
.tag.ok { background: #1e3a2f; color: #7fd1ae; }
.tag.bad { background: #3a2a1e; color: #e2b04d; }
.raw { font-family: ui-monospace, Consolas, monospace; color: #cfd6df; background: #111820; border: 1px solid #222b36;
  border-radius: 6px; padding: 6px; word-break: break-all; line-height: 1.6; font-size: 11.5px;
  max-height: 96px; overflow: auto; }
.raw .c { color: #ffb86b; font-weight: 600; }
.shots { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.sh { position: relative; }
.sh img { height: 54px; border-radius: 5px; border: 1px solid #2b3644; display: block; cursor: zoom-in; }
.sh .x { position: absolute; right: -5px; top: -5px; background: #3a2222; color: #e2a0a0; border: 1px solid #633;
  border-radius: 9px; width: 15px; height: 15px; line-height: 13px; text-align: center; font-size: 11px; cursor: pointer; }
.dropzone { border: 1px dashed #33465c; border-radius: 7px; padding: 10px; text-align: center; color: #6d7a8b;
  font-size: 11px; margin-top: 6px; cursor: pointer; line-height: 1.6; }
.dropzone:hover { border-color: #3b7ab5; color: #bcd8f5; background: #16222e; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(62px, 1fr)); gap: 6px; }
.cell { background: #171e26; border: 1px solid #27313d; border-radius: 7px; padding: 4px; text-align: center; }
.cell canvas { display: block; margin: 0 auto; background: #0d1218; border-radius: 4px; }
.cell .cp { color: #ffb86b; font-size: 12px; font-family: ui-monospace, Consolas, monospace; }
.cell input { text-align: center; padding: 2px; font-size: 13px; width: 100%; }
.cell .mt { color: #61707f; font-size: 9px; }
.hint { color: #6d7a8b; font-size: 10.5px; line-height: 1.6; margin: 4px 0 8px; }
.sec { border: 1px solid #27313d; border-radius: 9px; padding: 8px; margin-bottom: 9px; background: #171e26; }
.sec h4 { margin: 0 0 6px; font-size: 11.5px; color: #9fb0c3; font-weight: 600; }
details { margin-top: 8px; } summary { cursor: pointer; color: #8b98a9; font-size: 11px; }
details .blk { border-bottom: 1px solid #222b36; padding: 5px 0; font-size: 11px; }
details .blk .n { color: #7fb8ff; margin-right: 4px; }
details .blk .txt { font-family: ui-monospace, Consolas, monospace; color: #b9c3cf; word-break: break-all; }
.empty { color: #6d7a8b; text-align: center; padding: 22px 0; line-height: 1.7; }
`;

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'cx-fontsampler';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    shadow = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS;
    shadow.appendChild(st);

    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      readImageFiles(fileInput.files, function (urls) {
        const n = attachShots(urls);
        fileInput.value = '';
        render();
        setMsg('已挂 ' + n + ' 张图到本章（共 ' + state.chapter.shots.length + ' 张）', true);
      });
    });
    shadow.appendChild(fileInput);

    /* 导入备份用的文件选择器（samples-*.json）。2026-10-28：导出/导入从插件弹窗挪到面板，
     * 弹窗那两格按用户要求去掉，备份恢复能力留在这里。 */
    jsonInput = document.createElement('input');
    jsonInput.type = 'file';
    jsonInput.accept = '.json,application/json';
    jsonInput.style.display = 'none';
    jsonInput.addEventListener('change', function () {
      const f = jsonInput.files && jsonInput.files[0];
      jsonInput.value = '';
      doImportFile(f);
    });
    shadow.appendChild(jsonInput);

    pill = document.createElement('div');
    pill.className = 'pill';
    pill.title = '单击＝展开面板 · 拖动＝挪位置（缩着时也能 Ctrl+V 粘图）';
    shadow.appendChild(pill);
    paintPill();
    pill.addEventListener('pointerdown', function (e) {
      armPaste();
      startDragFor(pill, e);          /* 胶囊整块可拖 */
    });
    pill.addEventListener('click', function (e) {
      if (Date.now() < (state.suppressClick || 0)) return;   /* 刚拖完不算点击 */
      e.preventDefault();
      openPanel();
    });
    pill.addEventListener('dragover', function (e) { e.preventDefault(); pill.classList.add('hot'); });
    pill.addEventListener('dragleave', function () { pill.classList.remove('hot'); });
    pill.addEventListener('drop', function (e) {
      if (!e.dataTransfer) return;
      e.preventDefault();
      pill.classList.remove('hot');
      readImageFiles(e.dataTransfer.files, function (urls) {
        const n = attachShots(urls);
        paintPill(true);
        setMsg('已挂 ' + n + ' 张图到本章', true);
      });
    });

    panel = document.createElement('div');
    panel.className = 'panel';
    panel.tabIndex = -1;
    panel.style.display = 'none';
    shadow.appendChild(panel);

    if (!bound) {
      bound = true;
      panel.addEventListener('click', onPanelClick, true);
      panel.addEventListener('input', onPanelInput, true);
      panel.addEventListener('pointerdown', function (e) {
        armPaste();
        startDrag(e);
        try { panel.focus({ preventScroll: true }); } catch (err) {}
      }, true);
      root.addEventListener('pointermove', onDragMove, true);
      root.addEventListener('pointerup', endDrag, true);
      panel.addEventListener('paste', onPaste, true);
      panel.addEventListener('dragover', function (e) {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0) {
          e.preventDefault();
          panel.classList.add('drop');
        }
      }, true);
      panel.addEventListener('dragleave', function () { panel.classList.remove('drop'); }, true);
      panel.addEventListener('drop', function (e) {
        if (!e.dataTransfer) return;
        e.preventDefault();
        panel.classList.remove('drop');
        readImageFiles(e.dataTransfer.files, function (urls) {
          const n = attachShots(urls);
          render();
          setMsg('已挂 ' + n + ' 张图到本章', true);
        });
      }, true);
    }

    (document.body || document.documentElement).appendChild(host);

    /* 兜底：刚点过面板或胶囊（8 秒内）时，即使焦点还在页面上，Ctrl+V 也把图收进来 */
    document.addEventListener('paste', function (e) {
      if (!pasteArmed()) return;
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName || '')) return;
      onPaste(e);
    }, true);

  }

  function onPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const items = Array.from(cd.items || []);
    const imgs = items.filter(function (it) { return it.kind === 'file' && /^image\//.test(it.type); });
    if (!imgs.length) return;
    e.preventDefault();
    e.stopPropagation();
    const files = imgs.map(function (it) { return it.getAsFile(); }).filter(Boolean);
    readImageFiles(files, function (urls) {
      const n = attachShots(urls);
      state.lastPanelClick = Date.now();
      if (panel && panel.style.display !== 'none') render();
      paintPill(true);
      setMsg('已粘贴 ' + n + ' 张图（本章共 ' + state.chapter.shots.length + ' 张）', true);
    });
  }

  function openPanel() {
    ensureUI();
    pill.style.display = 'none';
    panel.style.display = 'flex';
    applyPos();
    render();
    refreshStats();
    if (!state.pollTimer) {
      state.pollTimer = setInterval(function () {
        if (panel.style.display !== 'none') refreshStats();
      }, 20000);
    }
    if (!state.ready) init();
  }
  function closePanel() {
    if (panel) panel.style.display = 'none';
    if (pill) { pill.style.display = 'flex'; applyPos(); paintPill(); }
  }

  function statusHTML() {
    const s = state.server;
    return '<span class="dot">●</span>' +
      '<span>本地样本 ' + s.samples + '</span><span>字形 ' + s.glyphs + '</span>' +
      '<span class="sp"></span><span>' + esc(state.fontMeta ? state.fontMeta.id : '') + '</span>';
  }

  function paintPill(flash) {
    if (!pill) return;
    const n = state.blocks.length, k = state.chapter.shots.length;
    pill.innerHTML = '<span>本章 <b>' + n + '</b> 块 · 图 <b>' + k + '</b></span>' +
      '<span class="h">' + (pasteArmed() ? 'Ctrl+V 粘图' : '单击激活 · 双击展开') + '</span>';
    if (flash) {
      pill.classList.add('ok');
      setTimeout(function () { pill.classList.remove('ok'); }, 700);
    }
  }

  function paintStatus() {
    paintPill();
    if (!panel) return;
    const m = panel.querySelector('.msg');
    if (m) { m.textContent = state.lastMsg || ''; m.className = 'msg' + (state.lastOk ? '' : ' bad'); }
    const s = panel.querySelector('.st');
    if (s) s.innerHTML = statusHTML();
  }

  /* 面板/胶囊位置：默认贴右上角，可拖拽；拖过就记住（chrome.storage.cxSamplePos） */
  function sanitizePos() {
    if (!state.pos) return false;
    const w = root.innerWidth || 800;
    const h = root.innerHeight || 600;
    const p = state.pos;
    /* 旧坐标可能来自 iframe（页内坐标），在顶层会跑到屏幕外 → 直接作废 */
    if (p.left < -40 || p.top < -40 || p.left > w - 60 || p.top > h - 40) {
      state.pos = null;
      return false;
    }
    return true;
  }

  function applyPos() {
    sanitizePos();
    const p = state.pos;
    const set = function (el, isPanel) {
      if (!el) return;
      if (p) {
        const maxL = (root.innerWidth || 800) - (isPanel ? 340 : 60);
        const maxT = (root.innerHeight || 600) - 40;
        el.style.left = Math.max(0, Math.min(maxL, p.left)) + 'px';
        el.style.top = Math.max(0, Math.min(maxT, p.top)) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      } else {
        const c = state.corner || 'tr';
        el.style.left = c[1] === 'l' ? '14px' : 'auto';
        el.style.right = c[1] === 'r' ? '14px' : 'auto';
        el.style.top = c[0] === 't' ? '14px' : 'auto';
        el.style.bottom = c[0] === 'b' ? '14px' : 'auto';
      }
    };
    set(panel, true);
    set(pill, false);
  }

  /* 拖拽：面板拖标题栏，胶囊整块都能拖；拖过就记住位置 */
  let dragging = null;
  function startDragFor(el, e) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragging = { el: el, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: 0 };
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  function startDrag(e) {
    if (!panel || panel.style.display === 'none') return;
    if (!e.target.closest || !e.target.closest('.hd')) return;
    if (e.target.closest('.ic')) return;              /* 标题栏按钮不触发拖拽 */
    startDragFor(panel, e);
  }
  function onDragMove(e) {
    if (!dragging) return;
    const el = dragging.el;
    const w = el.offsetWidth || 330;
    const h = el.offsetHeight || 40;
    const left = Math.max(0, Math.min((root.innerWidth || 800) - w, e.clientX - dragging.dx));
    const top = Math.max(0, Math.min((root.innerHeight || 600) - h, e.clientY - dragging.dy));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    dragging.moved = Math.max(dragging.moved, Math.abs(e.clientX - dragging.sx) + Math.abs(e.clientY - dragging.sy));
  }
  function endDrag() {
    if (!dragging) return;
    const d = dragging;
    dragging = null;
    if (d.moved > 6) {
      state.pos = { left: parseInt(d.el.style.left, 10) || 0, top: parseInt(d.el.style.top, 10) || 0 };
      try { stSet({ cxSamplePos: state.pos }); } catch (e) {}
      state.suppressClick = Date.now() + 350;   /* 拖完别把这次点击当成"展开" */
    }
  }

  function armPaste() {
    state.lastPanelClick = Date.now();
  }
  function pasteArmed() {
    return Date.now() - (state.lastPanelClick || 0) < 8000;
  }

  function render() {
    if (!panel) return;
    const tabs = [['chapter', '本章 ' + state.blocks.length], ['glyph', '按字形 ' + state.glyphCells.length]];
    panel.innerHTML =
      '<div class="hd"><span class="t">字体样本采集 · 整章</span><span class="sp"></span>' +
      '<span class="ic" data-act="rescan" title="重新扫描">⟳</span>' +
      '<span class="ic" data-act="corner" title="换到另一个角（别挡住截图）">⤢</span>' +
      '<span class="ic" data-act="export" title="导出全部样本到下载目录">⤓</span>' +
      '<span class="ic" data-act="disable" title="关掉采集器（可在插件图标里再打开）">⏻</span>' +
      '<span class="ic" data-act="close" title="缩成小贴窗（可继续 Ctrl+V 粘图）">—</span></div>' +
      '<div class="tabs">' + tabs.map(function (t) {
        return '<button data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="body">' + (state.tab === 'chapter' ? renderChapter() : renderGlyphs()) + '</div>' +
      '<div class="msg"></div><div class="st"></div>';
    paintStatus();
    if (state.tab === 'glyph') drawGlyphCanvases();
  }

  function shotsHTML() {
    const list = state.chapter.shots;
    if (!list.length) return '';
    return '<div class="shots">' + list.map(function (src, k) {
      return '<div class="sh"><img data-act="zoom" data-k="' + k + '" src="' + src + '">' +
        '<span class="x" data-act="delShot" data-k="' + k + '">×</span></div>';
    }).join('') + '</div>';
  }

  function renderChapter() {
    if (!state.blocks.length) {
      return '<div class="empty">本章没有加密块（.font-cxsecret）。<br>题目还没渲染完就等 1–2 秒点 ⟳。</div>';
    }
    const raw = chapterRaw();
    const cipher = cipherCharsOf(raw);
    const shown = raw.length > 1600 ? raw.slice(0, 1600) : raw;
    const rawHTML = Array.from(shown).map(function (ch) {
      if (ch === '\n') return '<br>';
      return glyphInfo(ch) ? '<span class="c">' + esc(ch) + '</span>' : esc(ch);
    }).join('') + (raw.length > 1600 ? '<span style="color:#6d7a8b"> …（共 ' + raw.length + ' 字，已截断显示）</span>' : '');
    let fixed = '';
    try { fixed = CX.fontDecrypt && CX.fontDecrypt.fix ? CX.fontDecrypt.fix(raw) : ''; } catch (e) {}

    return '<div class="hint" style="margin-top:0">已自动抓取：' + state.blocks.length + ' 块 · ' +
      cipher.length + ' 个加密字 · 图 ' + state.chapter.shots.length + ' 张' +
      (state.autoDone ? ' · <span style="color:#7fd1ae">已存</span>' : '') + '</div>' +

      '<div class="row" style="margin:0 0 8px">' +
      '<button class="big sm" style="flex:1.4;margin:0" data-act="pasteShot">粘贴截图</button>' +
      '<button class="big sm ghost" style="flex:1;margin:0" data-act="copyShot">复制截图</button>' +
      '<button class="big sm ghost" style="flex:1;margin:0" data-act="copyAllRaw">复制乱码</button>' +
      (state.chapter.shots.length ? '<button class="mini" style="margin:0" data-act="clearShots" title="只清本章的图，不动样本">清空图</button>' : '') +
      '</div>' +
      shotsHTML() +

      '<div class="sec"><h4>本章乱码（橙色＝被加密的字）</h4>' +
      '<div class="raw">' + rawHTML + '</div>' +
      (fixed && fixed !== raw ? '<div class="hint" style="color:#7fd1ae;margin:6px 0 0">字典还原：' +
        esc(oneLine(fixed).slice(0, 200)) + '</div>' : '') +
      '</div>' +

      '<div class="sec"><h4>真文字（可选：AI 读图结果粘这里）</h4>' +
      '<textarea data-in="readable" style="min-height:80px" placeholder="整章真文字，粘进来点「保存真文字」">' +
      esc(state.chapter.readable) + '</textarea>' +
      '<div class="row"><button class="mini" data-act="preview">对齐预览</button>' +
      '<span class="sp"></span>' +
      '<button class="mini warn" data-act="saveChapter">保存真文字</button></div>' +
      (state.chapter.previewHTML || '') + '</div>' +

      '<details><summary>逐块查看 / 定位（' + state.blocks.length + ' 块）</summary>' +
      state.blocks.map(function (b) {
        return '<div class="blk"><span class="n">#' + b.index + (b.qno ? ' 第' + esc(b.qno) + '题' : '') + '</span>' +
          '<span class="txt">' + esc(oneLine(b.raw).slice(0, 90)) + '</span>' +
          ' <button class="mini" data-act="locate" data-idx="' + b.index + '">定位</button></div>';
      }).join('') + '</details>' +
      '<div class="row" style="margin-top:9px">' +
      '<button class="mini" data-act="collect">重新抓取</button>' +
      '<button class="mini" data-act="export">导出样本</button>' +
      '<button class="mini" data-act="import">导入样本</button>' +
      '<button class="mini" data-act="clear">清空样本</button></div>';
  }

  function renderGlyphs() {
    if (!state.glyphCells.length) return '<div class="empty">没有需要标注的字形</div>';
    const labeled = state.glyphCells.filter(function (c) { return c.labeled; }).length;
    return '<div class="hint">格子里的字形是用<b>加密字体画出来</b>的，就是你屏幕上看到的那个字。' +
      '打一个汉字即可；预填的是算法猜测（未确认的按低权重入库），<b>只改错的</b>。已确认 ' +
      labeled + '/' + state.glyphCells.length + '。</div>' +
      '<div class="row" style="margin-bottom:7px"><button class="mini" data-act="guessAll">用算法猜测预填</button></div>' +
      '<div class="grid">' + state.glyphCells.map(function (c, i) {
        return '<div class="cell"><canvas data-cv="' + i + '" width="58" height="58"></canvas>' +
          '<div class="cp">' + esc(c.ch) + '</div>' +
          '<input type="text" maxlength="2" data-g="' + i + '" value="' + esc(c.labeled || c.guess || '') + '">' +
          '<div class="mt">' + (c.gid != null ? 'gid ' + c.gid : '?') + ' · ' + c.count + '次</div></div>';
      }).join('') + '</div>' +
      '<button class="big" style="margin-top:9px" data-act="saveGlyphs">保存已填字形</button>';
  }

  function drawGlyphCanvases() {
    const fam = (state.fontMeta && state.fontMeta.family) || FONT_HINT;
    const ff = fam.indexOf(' ') >= 0 ? '"' + fam + '"' : fam;
    state.glyphCells.forEach(function (c, i) {
      const cv = panel.querySelector('canvas[data-cv="' + i + '"]');
      if (!cv) return;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#e6edf5';
      ctx.font = '44px "fs-preview", ' + ff;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(c.ch, cv.width / 2, cv.height / 2 + 2);
    });
  }

  function previewHTML(res) {
    const raw = chapterRaw();
    const parts = Array.from(raw).map(function (ch) {
      if (ch === '\n') return '<br>';
      const p = res.pairs.find(function (x) { return x.c === ch; });
      if (p) return '<span style="color:#7fd1ae">' + esc(p.ch) + '</span>';
      return glyphInfo(ch) ? '<span style="color:#ffb86b">' + esc(ch) + '</span>' : esc(ch);
    }).join('');
    let html = '<div class="raw" style="margin-top:6px">' + parts + '</div>' +
      '<div class="hint" style="margin:6px 0 0">对齐 ' + res.covered + '/' + res.cipherTotal + ' 个加密字' +
      (res.missing.length ? '；缺：' + esc(res.missing.join(' ')) : '') + '</div>';
    if (res.ambiguous.length) {
      /* 2026-10-28 修复：alignText() 里 notes.push 的是字符串（「多出「X」」/「缺「Y」」），
       * 这里原来按 {raw, readable} 对象取字段 → 永远显示 undefined↔undefined。 */
      const lines = res.ambiguous.map(function (a) {
        if (typeof a === 'string') return a;
        return String((a && a.raw) || '') + '↔' + String((a && a.readable) || '');
      });
      html += '<div class="hint" style="color:#e2b04d;margin:2px 0 0">对齐时跳过的片段 ' + lines.length +
        ' 处：' + esc(lines.join(' | ').slice(0, 120)) + '</div>';
    }
    return html;
  }

  /* ---------------- 交互 ---------------- */
  function onPanelInput(e) {
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.in === 'readable') {
      state.chapter.readable = t.value;
    } else if (t.dataset.g != null) {
      const c = state.glyphCells[Number(t.dataset.g)];
      if (!c) return;
      const v = Array.from(t.value.trim());
      c.labeled = v.length ? v[0] : '';
      t.style.borderColor = c.labeled ? '#2f7d5a' : '#2b3644';
      if (c.labeled) {
        const next = panel.querySelector('input[data-g="' + (Number(t.dataset.g) + 1) + '"]');
        if (next) next.focus();
      }
    }
  }

  function onPanelClick(e) {
    const tabBtn = e.target.closest && e.target.closest('button[data-tab]');
    if (tabBtn) {
      e.preventDefault(); e.stopPropagation();
      state.tab = tabBtn.dataset.tab;
      render();
      if (state.tab === 'glyph' && !state.glyphCells.some(function (c) { return c.guess; })) {
        prefillGuesses().then(function (n) {
          if (n) { render(); setMsg('已用算法预填 ' + n + ' 个猜测，改掉错的再保存', true); }
        });
      }
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const act = btn.dataset.act;
    const k = btn.dataset.k != null ? Number(btn.dataset.k) : -1;
    const idx = btn.dataset.idx != null ? Number(btn.dataset.idx) : -1;
    switch (act) {
      case 'close': closePanel(); break;
      case 'corner': {
        const order = ['br', 'bl', 'tr', 'tl'];
        const cur = state.corner || 'br';
        state.corner = order[(order.indexOf(cur) + 1) % order.length];
        state.pos = null;
        stSet({ cxSamplePos: null });
        applyPos();
        setMsg('面板已移到 ' + ({ br: '右下', bl: '左下', tr: '右上', tl: '左上' })[state.corner] + '（也可以直接拖标题栏）', true);
        break;
      }
      case 'rescan': rescan(true); refreshStats(); break;
      case 'openDir': send({ kind: 'sample', action: 'openDir' }).then(function (r) {
        setMsg(r && r.ok ? '已打开样本目录' : '打开失败（收样服务没起？）', !!(r && r.ok));
      }); break;
      case 'collect': doCollect(); break;
      case 'pickFile': fileInput.click(); break;
      case 'export': doExport(); break;
      case 'import': if (jsonInput) jsonInput.click(); break;
      case 'clear': doClear(); break;
      case 'disable': doDisable(); break;
      case 'delShot': state.chapter.shots.splice(k, 1); render(); break;
      case 'zoom': doZoom(k); break;
      case 'copyAllRaw': doCopyAllRaw(); break;
      case 'pasteShot': doPasteShot(); break;
      case 'clearShots': doClearShots(); break;
      case 'copyShot': doCopyShot(); break;
      case 'preview': doPreview(); break;
      case 'saveChapter': doSaveChapter(); break;
      case 'locate': doLocate(idx); break;
      case 'guessAll': doGuessAll(); break;
      case 'saveGlyphs': doSaveGlyphs(); break;
    }
  }

  /* ---------------- 动作 ---------------- */
  async function doCollect() {
    if (!state.blocks.length) { setMsg('本章没有加密块', false); return; }
    setMsg('采集中：解析字体 → 计算字形指纹 → 入库…');
    await loadFont();
    buildGlyphCells();
    /* 采集只落「乱码 + 字体 + 指纹」，图和真文字按当前已有的带上 */
    state.chapter.pairs = state.chapter.readable.trim()
      ? alignText(chapterRaw(), state.chapter.readable).pairs
      : state.chapter.pairs;
    const r = await persistChapter();
    render();
    setMsg(r && r.ok
      ? '已入库：' + state.blocks.length + ' 块 / ' + state.glyphCells.length + ' 个字（' + (r.fontId || '') + '）'
      : '入库失败：' + ((r && r.error) || ''), !!(r && r.ok));
    refreshStats();
  }

  function doPreview() {
    const ta = panel.querySelector('textarea[data-in="readable"]');
    if (ta && ta.value.trim()) state.chapter.readable = ta.value;
    if (!state.chapter.readable.trim()) { setMsg('先把真文字粘进来', false); return; }
    const res = alignText(chapterRaw(), state.chapter.readable);
    state.chapter.align = res;
    state.chapter.pairs = res.pairs;
    state.chapter.previewHTML = previewHTML(res);
    render();
    setMsg('对齐 ' + res.pairs.length + ' 对 / 加密字 ' + res.covered + '/' + res.cipherTotal, res.ok);
  }

  async function doSaveChapter() {
    const ta = panel.querySelector('textarea[data-in="readable"]');
    if (ta && ta.value.trim()) state.chapter.readable = ta.value;
    if (state.chapter.readable.trim()) {
      const res = alignText(chapterRaw(), state.chapter.readable);
      state.chapter.align = res;
      state.chapter.pairs = res.pairs;
      state.chapter.previewHTML = previewHTML(res);
    } else {
      state.chapter.pairs = [];
    }
    const r = await persistChapter();
    render();
    setMsg(r && r.ok
      ? '本章已保存：' + state.chapter.pairs.length + ' 对 · 图 ' + state.chapter.shots.length + ' 张'
      : '保存失败：' + ((r && r.error) || ''), !!(r && r.ok));
    refreshStats();
  }

  async function doCopyAllRaw() {
    try {
      await navigator.clipboard.writeText(chapterRaw());
      setMsg('整章乱码已复制', true);
    } catch (e) { setMsg('复制失败：' + ((e && e.message) || e), false); }
  }

  /* 粘贴截图：优先直接读剪贴板（点一下就行），读不到就提示 Ctrl+V */
  async function doPasteShot() {
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        const blobs = [];
        for (const it of items) {
          const type = (it.types || []).find(function (t) { return /^image\//.test(t); });
          if (type) blobs.push(await it.getType(type));
        }
        if (blobs.length) {
          const urls = [];
          for (const b of blobs) {
            urls.push(await new Promise(function (res) {
              const fr = new FileReader();
              fr.onload = function () { res(String(fr.result)); };
              fr.onerror = function () { res(''); };
              fr.readAsDataURL(b);
            }));
          }
          const n = attachShots(urls.filter(Boolean));
          if (panel && panel.style.display !== 'none') render();
          setMsg('已粘上 ' + n + ' 张图，自动保存中…', true);
          return;
        }
      }
    } catch (e) { /* 没权限就走下面的提示 */ }
    setMsg('剪贴板里没图：先截图，再点这里（或直接按 Ctrl+V）', false);
  }

  /* 清掉本章的图（样本里存的也一起清，防止串章残留） */
  async function doClearShots() {
    if (!state.chapter.shots.length) return;
    if (!confirm('清掉本章的 ' + state.chapter.shots.length + ' 张图？（样本记录里的也一起清）')) return;
    state.chapter.shots = [];
    const r = await persistChapter({ clearShots: true });
    await refreshStats();
    render();
    setMsg(r && r.ok ? '已清空本章图片' : '清空失败：' + ((r && r.error) || ''), !!(r && r.ok));
  }

  /* 复制截图：把本章最后一张图放回剪贴板，直接贴给 AI */
  async function doCopyShot() {
    const list = state.chapter.shots;
    if (!list.length) { setMsg('还没有图：先点「粘贴截图」把截屏弄进来', false); return; }
    try {
      const blob = await (await fetch(list[list.length - 1])).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setMsg('最后一张截图已复制，去 AI 那粘贴', true);
    } catch (e) {
      setMsg('复制失败：' + ((e && e.message) || e) + '（点缩略图放大后可右键另存）', false);
    }
  }

  function doZoom(k) {
    const src = state.chapter.shots[k];
    if (!src) return;
    let ov = shadow.querySelector('.zoom');
    if (ov) ov.remove();
    ov = document.createElement('div');
    ov.className = 'zoom';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:2147483002;display:flex;' +
      'align-items:center;justify-content:center;cursor:zoom-out;padding:16px';
    ov.innerHTML = '<img style="max-width:97%;max-height:97%;border-radius:6px" src="' + src + '">';
    ov.addEventListener('click', function () { ov.remove(); });
    shadow.appendChild(ov);
  }

  function doLocate(i) {
    const b = state.blocks.find(function (x) { return x.index === i; });
    if (!b) return;
    try {
      b.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const old = b.el.style.outline;
      b.el.style.outline = '2px solid #ff9f43';
      setTimeout(function () { b.el.style.outline = old; }, 1500);
      setMsg('已定位 #' + i, true);
    } catch (e) { setMsg('定位失败：' + ((e && e.message) || e), false); }
  }

  async function prefillGuesses() {
    const fd = CX.fontDecrypt;
    let map = {};
    try {
      if (fd && fd.ensure) await fd.ensure();
      if (fd && fd.map) map = fd.map() || {};
    } catch (e) {}
    let hit = 0;
    for (const c of state.glyphCells) {
      const g = map[c.ch];
      if (g && g !== c.ch && !c.labeled) { c.guess = g; hit++; }
    }
    return hit;
  }

  function doGuessAll() {
    prefillGuesses().then(function (n) {
      render();
      setMsg(n ? '已预填 ' + n + ' 个猜测，改掉错的再保存' : '没有可用猜测（算法还没算出来）', !!n);
    });
  }

  async function doSaveGlyphs() {
    const pairs = [];
    let manual = 0, auto = 0;
    for (const c of state.glyphCells) {
      const v = Array.from(String(c.labeled || c.guess || '').trim());
      if (!v.length) continue;
      const ch = v[0];
      if (!ch || ch === c.ch || !isCJK(ch)) continue;
      const src = c.labeled ? 'manual' : 'auto';
      if (src === 'manual') manual++; else auto++;
      pairs.push({ c: c.ch, ch: ch, sig: c.sig, sigRaw: c.sigRaw, gid: c.gid, aw: c.aw, src: src });
    }
    if (!pairs.length) { setMsg('还没有填字形', false); return; }
    const fm = state.fontMeta || {};
    const payload = {
      ts: Date.now(),
      page: { href: String(location.href), title: document.title, frame: '字形标注', shots: [] },
      user: 'local',
      font: {
        id: fm.id, family: fm.family, sig48: fm.sig48, bytes: fm.bytes, upem: fm.upem,
        numGlyphs: fm.numGlyphs, names: fm.names, cipher: fm.cipher, b64: fm.b64
      },
      blocks: [{
        index: GLYPH_INDEX, kind: '字形标注',
        raw: state.glyphCells.map(function (c) { return c.ch; }).join(''),
        readable: state.glyphCells.map(function (c) { return (c.labeled || c.guess || '·'); }).join(''),
        status: 'labeled', pairs: pairs, shots: []
      }]
    };
    /* 2026-10-28（A 方案：本地优先，服务只当归档）：
     * 以前这里唯一出路是 send() 给本地收样服务 —— 服务没起就直接"保存失败"，
     * 手工认的那几十个字全丢在内存里。现在跟 persistChapter() 走同一条路：
     *   ① 先写 chrome.storage.local.cxSamples（saveLocal）
     *   ② rebuildDict() 重算字典 → fontdecrypt 立刻能用
     *   ③ 服务开着就顺手归档一份，没开也不影响保存结果（还是非阻塞）
     * 名字沿用已有的 saveLocal / rebuildDict / stGet / stSet，没有新增全局名。 */
    let local = null;
    try {
      local = await saveLocal(payload);
    } catch (e) {
      setMsg('本地保存失败：' + ((e && e.message) || e), false);
      return;
    }
    const dict = await rebuildDict();
    try { send({ kind: 'sample', action: 'ingest', payload: payload, optional: true }); } catch (e) {}

    if (CX.fontDecrypt && CX.fontDecrypt.reloadDict) {
      try { CX.fontDecrypt.reloadDict(); } catch (e) {}
    }
    render();
    refreshStats();
    setMsg('已保存 ' + pairs.length + ' 个字形（人工 ' + manual + ' / 猜测 ' + auto + '）'
      + '· 字典 ' + ((dict && dict.n) || 0) + ' 条'
      + (local && local.total ? '· 样本 ' + local.total + ' 条' : ''), true);
  }

  async function doExport() {
    setMsg('正在打包导出…');
    const r = await send({ kind: 'sample', action: 'export' });
    if (r && r.ok) setMsg('已导出到下载目录：' + r.file + '（' + Math.round((r.bytes || 0) / 1024) + ' KB）', true);
    else setMsg('导出失败：' + ((r && r.error) || ''), false);
  }

  /* 导入备份：接受本插件或独立采集器导出的 samples-*.json（{samples, fonts, dict}）
   * 合并规则与原来弹窗里的一致：样本按 id 去重（导入覆盖同名）、字体按 hash 合并、
   * 字典只在导入的更大时替换（不会把大字典打回小字典）。 */
  async function doImportFile(file) {
    if (!file) return;
    let data = null;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      setMsg('导入失败：不是合法 JSON', false);
      return;
    }
    if (!data || (!data.samples && !data.dict)) { setMsg('导入失败：文件里没有 samples / dict', false); return; }
    const got = await stGet([SAMPLE_KEY, FONT_KEY, DICT_KEY]);
    const byId = new Map((Array.isArray(got[SAMPLE_KEY]) ? got[SAMPLE_KEY] : []).map(function (s) { return [s.id, s]; }));
    let added = 0;
    (data.samples || []).forEach(function (s) { if (s && s.id) { if (!byId.has(s.id)) added++; byId.set(s.id, s); } });
    const fonts = Object.assign({}, got[FONT_KEY] || {}, data.fonts || {});
    let merged = Array.from(byId.values());
    if (merged.length > MAX_SAMPLES) merged = merged.slice(-MAX_SAMPLES);
    const curN = (got[DICT_KEY] && got[DICT_KEY].n) || 0;
    const inN = (data.dict && data.dict.n) || Object.keys((data.dict && data.dict.map) || {}).length;
    const patch = { [SAMPLE_KEY]: merged, [FONT_KEY]: fonts };
    if (inN > curN) patch[DICT_KEY] = data.dict;
    await stSet(patch);
    let dictN = Math.max(curN, inN);
    try {
      const d = await rebuildDict();          /* 只增不减：导入样本里的字对会并进现有字典 */
      if (d && d.n) dictN = d.n;
    } catch (e) {}
    await refreshStats();
    await rescan(false);
    render();
    setMsg('已导入：样本 ' + merged.length + ' 条（新增 ' + added + '）· 字典 ' + dictN + ' 条', true);
  }

  async function doClear() {
    /* 双确认（2026-10-28 用户要求）：行为不变，只加两道弹窗。
     * 字形字典现在只剩本地这一份，"清空样本"一点就全没了 —— 所以第一次警告 + 确定后再问一次。 */
    const got = await stGet([SAMPLE_KEY, DICT_KEY]);
    const nSamples = Array.isArray(got[SAMPLE_KEY]) ? got[SAMPLE_KEY].length : 0;
    const nDict = Object.keys(((got[DICT_KEY] || {}).map) || {}).length;
    const first = confirm(
      '⚠ 危险操作：清空样本\n\n' +
      '将删除：\n' +
      '· 样本记录 ' + nSamples + ' 条（含所有人工标注）\n' +
      '· 字形字典 ' + nDict + ' 条（整本）\n' +
      '· 本章的真文字 / 图 / 对齐预览\n\n' +
      '这些数据只存在本机，删掉无法恢复。\n' +
      '日常不需要点这个。确定继续？'
    );
    if (!first) return;
    const second = confirm(
      '再确认一次：真的要清空吗？\n\n' +
      '建议先点「导出样本」备份（存到 下载\\学习通字体样本\\）。\n\n' +
      '「确定」= 立即清空（不可恢复）\n' +
      '「取消」= 什么都不做'
    );
    if (!second) { setMsg('已取消清空', true); return; }
    await stSet({ cxSamples: [], cxGlyphDict: { ts: 0, map: {}, raw: {}, n: 0 } });
    state.chapter = { readable: '', pairs: [], shots: [], align: null, previewHTML: '' };
    await refreshStats();
    render();
    setMsg('已清空本地样本（' + nSamples + ' 条样本 / ' + nDict + ' 条字典）', true);
  }

  async function doDisable() {
    await setEnabled(false);
    closePanel();
    ensureUI();
    pill.style.display = 'none';
  }

  /* ---------------- 开关 ---------------- */
  async function setEnabled(on) {
    const got = await stGet(['cxConfig']);
    const cfg = got.cxConfig || {};
    cfg.samples = Object.assign({ enabled: true }, cfg.samples || {}, { enabled: !!on });
    await stSet({ cxConfig: cfg });
    state.enabled = !!on;
    applyEnabled();
    setMsg(on ? '采集器已开启' : '采集器已关闭（插件图标里可再打开）', on);
  }

  function applyEnabled() {
    ensureUI();
    if (!state.enabled) {
      if (pill) pill.style.display = 'none';
      if (panel) panel.style.display = 'none';
      return;
    }
    if (pill) pill.style.display = (panel && panel.style.display !== 'none') ? 'none' : 'flex';
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
    state.ready = true;
    await rescan(false);
    await refreshStats();
    if (state.blocks.length) setMsg('本章 ' + state.blocks.length + ' 个加密块，点「采集本章」', true);
  }

  async function rescan() {
    state.blocks = scanBlocks();
    if (!state.blocks.length) {
      if (pill) pill.style.display = 'none';
      state.font = null; state.fontMeta = null; state.glyphCells = [];
      if (panel && panel.style.display !== 'none') render();
      return;
    }
    await loadFont();
    /* 已批阅/已提交的页面：题目是明文，只是留着 .font-cxsecret 这个 class，没有字体可采 */
    if (!state.fontMeta) {
      if (pill) pill.style.display = 'none';
      state.glyphCells = [];
      setMsg('这个页面没有加密字体（已批阅的题是明文），不需要采集', false);
      if (panel && panel.style.display !== 'none') render();
      return;
    }

    /* 换章/换字体必须清空上一章粘的图和真文字，否则会被存进新章节的记录里 */
    const key = state.fontMeta.id + '|' + state.blocks.length + '|' + chapterRaw().slice(0, 32);
    if (state.chapterKey && state.chapterKey !== key) {
      state.chapter = { readable: '', pairs: [], shots: [], align: null, previewHTML: '' };
    }
    state.chapterKey = key;

    buildGlyphCells();
    ensureUI();
    pill.style.display = 'flex';
    state.ready = true;
    if (panel && panel.style.display !== 'none') render();
    paintStatus();
    /* 进到测验页就自动抓取 + 保存 + 弹窗，不用点任何按钮 */
    if (!state.autoDone && state.enabled) {
      state.autoDone = true;
      setTimeout(function () { autoGrab(); }, 250);
    }
  }

  async function autoGrab() {
    if (!state.fontMeta) return;
    openPanel();
    setMsg('已自动抓取 ' + state.blocks.length + ' 块，正在保存…');
    const r = await persistChapter();
    await refreshStats();
    if (panel && panel.style.display !== 'none') render();
    setMsg(r && r.ok
      ? '已自动保存 · ' + state.blocks.length + ' 块 / ' + state.glyphCells.length + ' 个字 · 字典 ' + (r.dictSize || 0) + ' 条 · 现在截屏后点「粘贴截图」'
      : '自动保存失败：' + ((r && r.error) || ''), !!(r && r.ok));
  }

  /* 章节切换/新字体：靠签名变化驱动，不停地轻量轮询（跨 frame 也能发现） */
  function blockSignature() {
    let n = 0, first = '';
    collectDocs().forEach(function (doc) {
      let els = null;
      try { els = doc.querySelectorAll(SEL); } catch (e) { return; }
      const len = els.length;
      n += len;
      if (!first && len) { try { first = String(els[0].textContent || '').slice(0, 16); } catch (e) {} }
    });
    return n + '|' + first;
  }

  function watchBlocks() {
    if (state.watching) return;
    state.watching = true;
    state.lastSig = '';
    setInterval(function () {
      if (!state.enabled) return;
      let sig = '';
      try { sig = blockSignature(); } catch (e) { return; }
      if (sig.indexOf('0|') === 0) return;
      if (sig === state.lastSig) return;
      state.lastSig = sig;
      state.autoDone = false;        /* 换了章节 / 换了字体 → 允许再自动抓一次 */
      rescan();
    }, 1500);
  }

  /* 开关：读配置决定是否挂 UI；popup 里切换后这里实时跟随 */
  (async function boot() {
    const got = await stGet(['cxConfig', 'cxSamplePos']);
    const s = (got.cxConfig && got.cxConfig.samples) || {};
    state.enabled = s.enabled !== false;
    if (got.cxSamplePos && typeof got.cxSamplePos.left === 'number' && typeof got.cxSamplePos.top === 'number') {
      state.pos = { left: got.cxSamplePos.left, top: got.cxSamplePos.top };
      if (!sanitizePos()) {
        state.pos = null;
        try { stSet({ cxSamplePos: null }); } catch (e) {}
      }
    }
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.cxConfig) return;
        const nv = (changes.cxConfig.newValue || {}).samples || {};
        const on = nv.enabled !== false;
        if (on === state.enabled) return;
        state.enabled = on;
        applyEnabled();
        if (on) watchBlocks();
      });
    } catch (e) {}
    if (state.enabled) watchBlocks();
  })();

  CX.samples = {
    scan: function () { return rescan(); },
    state: function () { return state; },
    open: openPanel,
    close: closePanel,
    align: alignText,
    collect: doCollect,
    save: doSaveChapter,
    chapter: function () {
      return {
        raw: chapterRaw(),
        cipher: cipherCharsOf(chapterRaw()),
        shots: state.chapter.shots.length,
        readable: state.chapter.readable,
        pairs: state.chapter.pairs.length,
        blocks: state.blocks.length
      };
    },
    blocks: function () {
      return state.blocks.map(function (b) {
        return { index: b.index, qno: b.qno, raw: oneLine(b.raw), cipher: cipherCharsOf(b.raw).join('') };
      });
    },
    glyphs: function () {
      return state.glyphCells.map(function (c) {
        return { ch: c.ch, sig: c.sig, gid: c.gid, n: c.count, labeled: c.labeled || '', guess: c.guess || '' };
      });
    },
    /* 给自动化用：整章真文字一次填进来并保存 */
    labelChapter: function (text) {
      state.chapter.readable = String(text || '');
      return doSaveChapter();
    },
    saveGlyphs: doSaveGlyphs
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);


