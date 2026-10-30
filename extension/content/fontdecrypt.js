/* 超星字体加密还原（font-cxsecret）
 *
 * 现在的还原顺序（2026-10-27 重写）：
 *   1) **字形字典查表**：解析 TTF 的 glyf 轮廓 → 指纹 → 查「指纹 → 真字」字典。
 *      这是精确解，命中率随采集样本增长，跨轮次永久有效（站点每轮只换码位，不换字形）。
 *   2) 字典没覆盖的字，才退回**跨字体像素近似比对**（原来的 95% 那套）。
 *
 * 关键事实（都实测过）：
 *   - 字体是 Source Han Sans CN Normal 的**子集**，只包含被加密的那些字；
 *     其余字浏览器逐字回退到页面字体，本来就是原文 —— 所以「码位在 cmap 里」就是加密的精确判据。
 *     早先报的 "185/194" 里，一大半"漏掉的字"其实是不需要解密的原文。
 *   - 站点每次提交后重新加密：码位重排、字体重生成，但**同一个字的轮廓一模一样**，
 *     所以字形指纹可以跨轮次复用。
 *
 * 踩过的三个坑（别再走回头路）：
 *  1. canvas 必须透明底（铺白底会让 alpha 全 255，所有字都被判成同一个）；
 *  2. 候选字表用 GB2312 一级（3755），不要扩到全表 6763 —— 渲染量翻倍且覆盖提升有限；
 *  3. 不要"每个加密字符新建一个 canvas"，也不要逐字符算汉明距离 —— 那样会把主线程占死
 *     （实测 56 秒无响应）。候选批量渲染一次 + 单字符 canvas 复用 + 每 25 个字符让出一次。
 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX) return;

  const FONT = 'font-cxsecret';
  const STORE_KEY = 'cxFontMapData';
  const DICT_KEY = 'cxGlyphDict';

  let map = Object.create(null);      // 码位字 → 真字（仅当前字体有效）
  let detail = Object.create(null);   // 码位字 → {ch, src, d, margin}
  let dict = { map: Object.create(null), raw: Object.create(null) };
  let sig = '';
  let building = null;
  let note = '';
  let scratch = null;
  let scratchCtx = null;
  let fontCache = { sig: '', font: null };

  /* ---------------- 字体定位 ---------------- */
  function fontSig() {
    try {
      const sheets = document.styleSheets;
      for (let i = 0; i < sheets.length; i++) {
        let rules = null;
        try { rules = sheets[i].cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (let j = 0; j < rules.length; j++) {
          const r = rules[j];
          if (!r || !r.style) continue;
          if (String(r.style.fontFamily || '').indexOf(FONT) < 0) continue;
          const m = String(r.style.src || '').match(/base64,([A-Za-z0-9+/=]{0,48})/);
          if (m) return m[1];
        }
      }
    } catch (e) {}
    return '';
  }

  async function getFont() {
    if (!CX.ttf) return null;
    const s = fontSig();
    if (fontCache.font && fontCache.sig === s) return fontCache.font;
    let face = null;
    try { face = CX.ttf.dom.pickFace(document, FONT); } catch (e) {}
    if (!face || !face.b64) return null;
    try {
      const f = await CX.ttf.load(face.b64);
      fontCache = { sig: s, font: f };
      return f;
    } catch (e) {
      CX.warn('字体解析失败：' + ((e && e.message) || e));
      return null;
    }
  }

  /* ---------------- 字典 ---------------- */
  function loadDict() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(DICT_KEY, function (res) {
          const d = res && res[DICT_KEY];
          if (d && d.map) {
            dict = { map: d.map, raw: d.raw || Object.create(null), n: d.n || Object.keys(d.map).length };
          }
          resolve(dict);
        });
      } catch (e) { resolve(dict); }
    });
  }

  function dictLookup(info) {
    if (!info || !info.mapped) return '';
    if (info.sig && dict.map[info.sig]) return dict.map[info.sig];
    if (info.sigRaw && dict.raw[info.sigRaw]) return dict.raw[info.sigRaw];
    return '';
  }

  /* 逆查表认出来的字：按指纹写回字典，永久复用（同一指纹永远同一个字） */
  let selfWrite = false;
  function persistLearned(learned) {
    try {
      chrome.storage.local.get(DICT_KEY, function (res) {
        try {
          const d = res && res[DICT_KEY];
          const m = (d && d.map) ? d.map : {};
          let added = 0;
          for (const k in learned) {
            if (!m[k]) { m[k] = learned[k]; added++; }
          }
          if (!added) return;
          for (const k in learned) dict.map[k] = learned[k];
          selfWrite = true;
          const patch = {};
          patch[DICT_KEY] = { ts: Date.now(), map: m, raw: (d && d.raw) || {}, n: Object.keys(m).length };
          chrome.storage.local.set(patch);
        } catch (e) {}
      });
    } catch (e) {}
  }

  /* ---------------- 候选字 / 渲染 ---------------- */





  /* 待解的码位：优先用字体 cmap 判定（精确）；解析不到字体时退回 CJK 区段 */
  function encryptedChars() {
    const font = fontCache.font;
    const seen = Object.create(null);
    const out = [];
    try {
      const els = document.querySelectorAll('.font-cxsecret');
      for (let i = 0; i < els.length; i++) {
        const t = String(els[i].textContent || '');
        for (let k = 0; k < t.length; k++) {
          const ch = t[k];
          if (seen[ch]) continue;
          const c = ch.charCodeAt(0);
          if (c < 0x3400 || c > 0x9fff) continue;
          seen[ch] = 1;
          if (font) {
            const info = font.infoForChar(ch);
            if (!info.mapped || !info.sig) continue;   /* 不在子集里 = 原文，不用解 */
            out.push(ch);
          } else if (c >= 0x4e00 && c <= 0x9fa5) {
            out.push(ch);
          }
        }
      }
    } catch (e) {}
    return out;
  }

  function needed() {
    try { return document.querySelectorAll('.font-cxsecret').length > 0; } catch (e) { return false; }
  }

  /* ---------------- 构建映射 ---------------- */
  async function build() {
    if (building) return building;
    building = (async function () {
      const t0 = Date.now();
      try {
        await loadDict();
        const font = await getFont();
        const encs = encryptedChars();
        if (!encs.length) { note = '没有需要解密的字'; return map; }
        /* 2026-10-31：拿不到字体（隐藏帧 / @font-face 还没就绪）就直接退出。
         * 字典是按字形指纹索引的，没有字体什么都查不中；以前会硬跑一轮并打印
         * 「字典 0 + 逆查 0 / 共 N」，容易让人误判成"字典覆盖不够"。 */
        if (!font) { note = '字体未加载，跳过（待还原 ' + encs.length + ' 字）'; return map; }

        /* ---- 第一轮：字形指纹查字典（精确） ---- */
        let fromDict = 0;
        const rest = [];
        for (let e = 0; e < encs.length; e++) {
          const ch = encs[e];
          const info = font ? font.infoForChar(ch) : null;
          const hit = dictLookup(info);
          if (hit) {
            map[ch] = hit;
            detail[ch] = { ch: hit, src: 'dict', d: 0, margin: 999 };
            fromDict++;
          } else {
            rest.push(ch);
          }
        }

        /* ---- 第二轮：字典没覆盖的字 → 通用字形逆查表（A+B） ---- */
        let fromGlyph = 0;
        const learned = Object.create(null);
        if (rest.length && CX.glyphMatch && CX.glyphMatch.ensure) {
          const ready = await CX.glyphMatch.ensure();
          /* 每次重建都给一次新的查询配额（以前配额是进程级的，永不清零） */
          if (ready && CX.glyphMatch.resetQuota) { try { CX.glyphMatch.resetQuota(); } catch (e) {} }
          if (ready) {
            for (let g = 0; g < rest.length; g++) {
              const ch = rest[g];
              const info = font ? font.infoForChar(ch) : null;
              if (!info || !info.mapped || !info.sig || !info.gid) continue;
              const pts = font.pointsOfGid(info.gid);
              if (!pts) continue;
              let r = null;
              try { r = CX.glyphMatch.identify(pts, info.sig); } catch (e) { r = null; }
              if (!r || !r.ch) continue;
              map[ch] = r.ch;
              detail[ch] = { ch: r.ch, src: 'glyph', d: 0, margin: Math.round((r.margin || 0) * 1000) };
              fromGlyph++;
              if (!dict.map[info.sig]) learned[info.sig] = r.ch;
            }
            if (Object.keys(learned).length) persistLearned(learned);
          }
        }

        const ord = orderCheck(map);
        if (ord.fixed || ord.dropped) {
          try { CX.info('升序校验：' + ord.n + ' 条中纠正 ' + ord.fixed + '，放弃 ' + ord.dropped); } catch (e) {}
        }
        sig = fontSig();
        note = '字典 ' + fromDict + ' + 逆查 ' + fromGlyph + ' + 校验修 ' + ord.fixed + '/弃 ' + ord.dropped + ' / 共 ' + encs.length +
          '（' + (Date.now() - t0) + 'ms）';
        try { CX.info('字体还原：' + note); } catch (e) {}
        try {
          const patch = {};
          patch[STORE_KEY] = { sig: sig, map: map, ts: Date.now() };
          chrome.storage.local.set(patch);
        } catch (e) {}
        return map;
      } catch (e) {
        note = '还原异常：' + ((e && e.message) || e);
        return map;
      } finally {
        building = null;
      }
    })();
    return building;
  }

  function loadCache() {
    return new Promise(function (resolve) {
      try {
        sig = fontSig();
        chrome.storage.local.get(STORE_KEY, function (res) {
          try {
            const d = res && res[STORE_KEY];
            if (d && d.map && d.sig && sig && d.sig === sig) {
              map = d.map;
              note = '命中缓存 ' + Object.keys(map).length + ' 个';
            }
          } catch (e) {}
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  function ensure() {
    if (!needed()) return Promise.resolve(map);
    return getFont().then(function () {
      const cur = fontSig();
      if (Object.keys(map).length) {
        if (cur && sig && cur !== sig) { map = Object.create(null); detail = Object.create(null); sig = cur; }
        else {
          const present = encryptedChars();
          let missing = 0;
          for (let i = 0; i < present.length; i++) if (!map[present[i]]) missing++;
          if (missing === 0) return map;
          try { CX.info('字体映射缺 ' + missing + ' 个，重新补齐'); } catch (e) {}
          return build();
        }
      }
      if (cur) sig = cur;
      return loadCache().then(function () {
        if (Object.keys(map).length) {
          const present = encryptedChars();
          let missing = 0;
          for (let i = 0; i < present.length; i++) if (!map[present[i]]) missing++;
          if (missing === 0) return map;
        }
        return build();
      });
    });
  }

  /* ---------------- 第二道防错：gid 升序校验 ----------------
   * 站点生成器把子集按「真字 Unicode 码位升序」分配 gid（实测 42/42 单调），
   * 所以：把已解出的字按 gid 排序，码位必须单调递增。逆序 = 必有一条是错的。
   * 处理：用逆查表重认；新答案若能落进前后邻居的区间就采纳，否则宁可不给（留乱码）。
   */
  function orderCheck(mapObj) {
    const f = fontCache.font;
    if (!f) return { n: 0, fixed: 0, dropped: 0 };
    /* 校验阶段用的是独立配额（它靠 sig+'#ord' 绕过缓存，会真的再算一遍） */
    if (CX.glyphMatch && CX.glyphMatch.resetQuota) { try { CX.glyphMatch.resetQuota(); } catch (e) {} }
    const rows = [];
    for (const ch in mapObj) {
      const info = f.infoForChar(ch);
      if (!info || !info.mapped || info.gid == null) continue;
      rows.push({ enc: ch, gid: info.gid, ch: mapObj[ch], cp: mapObj[ch].codePointAt(0), sig: info.sig });
    }
    if (rows.length < 3) return { n: rows.length, fixed: 0, dropped: 0 };
    rows.sort(function (a, b) { return a.gid - b.gid; });

    let fixed = 0, dropped = 0;
    for (let i = 0; i < rows.length; i++) {
      const cur = rows[i];
      const prev = rows[i - 1], next = rows[i + 1];
      const badPrev = prev && cur.cp < prev.cp;
      const badNext = next && cur.cp > next.cp;
      if (!badPrev && !badNext) continue;

      let cand = null;
      try {
        const pts = f.pointsOfGid(cur.gid);
        if (pts && CX.glyphMatch) cand = CX.glyphMatch.identify(pts, cur.sig + '#ord');
      } catch (e) { cand = null; }

      if (cand && cand.ch) {
        const cp2 = cand.ch.codePointAt(0);
        const fitsPrev = !prev || cp2 >= prev.cp;
        const fitsNext = !next || cp2 <= next.cp;
        if (fitsPrev && fitsNext && cand.ch !== cur.ch) {
          map[cur.enc] = cand.ch;
          cur.ch = cand.ch;
          cur.cp = cp2;
          fixed++;
          try { CX.info('升序校验纠正：' + cur.enc + ' → ' + cand.ch); } catch (e) {}
          continue;
        }
      }
      delete map[cur.enc];
      dropped++;
      try { CX.warn('升序校验冲突且无法确认，已放弃该字：' + cur.enc); } catch (e) {}
    }
    return { n: rows.length, fixed: fixed, dropped: dropped };
  }

  function fix(text) {
    const s = String(text == null ? '' : text);
    if (!s) return s;
    let out = '';
    let changed = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (map[ch]) { out += map[ch]; changed = true; }
      else out += ch;
    }
    return changed ? out : s;
  }

  CX.fontDecrypt = {
    ensure: ensure,
    fix: fix,
    build: build,
    map: function () { return map; },
    detail: function () { return detail; },
    reloadDict: function () { return loadDict(); },
    pointsOf: function (ch) {
      try { return fontCache.font ? fontCache.font.pointsOfChar(ch) : null; } catch (e) { return null; }
    },
    sigOf: function (ch) {
      try {
        if (!fontCache.font) return '';
        var i = fontCache.font.infoForChar(ch);
        return (i && i.mapped) ? i.sig : '';
      } catch (e) { return ''; }
    },
    invalidate: function () {
      map = Object.create(null);
      detail = Object.create(null);
      sig = '';
      try { chrome.storage.local.remove(STORE_KEY); } catch (e) {}
    },
    stats: function () {
      return {
        mapped: Object.keys(map).length,
        dictEntries: Object.keys(dict.map).length,
        note: note,
        sig: sig.slice(0, 12)
      };
    }
  };

  /* 字典在扩展本地被重建时（采集面板保存样本后），立刻重算并替换现用映射 */
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.cxGlyphDict) return;
      if (selfWrite) { selfWrite = false; return; }
      map = Object.create(null);
      detail = Object.create(null);
      sig = '';
      loadDict().then(function () {
        if (!needed()) return null;
        return build();
      }).catch(function () {});
    });
  } catch (e) {}

  /* 空闲时预建：exam 解析是同步的，等到那一刻再 ensure 就晚了 */
  function autoBuild() {
    try {
      if (!needed() || Object.keys(map).length) return;
      setTimeout(function () {
        try { if (!Object.keys(map).length) build(); } catch (e) {}
      }, 500);
    } catch (e) {}
  }
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoBuild, { once: true });
    } else {
      autoBuild();
    }
  } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : this);







