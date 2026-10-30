/* 字形字典构建（扩展内运行，不依赖本地服务）
 *
 * 输入：样本记录数组 [{block:{pairs:[{c,ch,sig,sigRaw,src}], readable, raw}}]
 * 输出：{ ts, map:{sig:字}, raw:{sigRaw:字}, stats:{...}, conflicts:[...] }
 *
 * 规则：每条字符对按来源加权投票（人工 3 > 对齐 2 > 算法猜测 1），
 *       最高票必须领先次高票 ≥ minLead，否则算冲突、不入字典（宁可缺，不可错）。
 *
 * 同时给 content script（fontdecrypt / fontsampler）和 service worker 用。
 */
(function (root) {
  'use strict';

  const WEIGHTS = { manual: 3, align: 2, sentence: 2, auto: 1, snapshot: 0 };

  function vote(store, key, ch, w) {
    if (!key || !ch) return;
    let m = store.get(key);
    if (!m) { m = new Map(); store.set(key, m); }
    m.set(ch, (m.get(ch) || 0) + w);
  }

  function decide(store, minLead) {
    const map = {};
    const conflicts = [];
    for (const [sig, m] of store) {
      const sorted = Array.from(m.entries()).sort(function (a, b) { return b[1] - a[1]; });
      const top = sorted[0];
      const lead = sorted.length > 1 ? top[1] - sorted[1][1] : top[1];
      if (lead < minLead) { conflicts.push({ sig: sig, all: sorted }); continue; }
      map[sig] = top[0];
    }
    return { map: map, conflicts: conflicts };
  }

  function build(records, opts) {
    opts = opts || {};
    const minLead = opts.minLead || 1;
    const sigVotes = new Map();
    const rawVotes = new Map();
    let pairs = 0;
    let labeled = 0;

    for (const r of records || []) {
      const blk = (r && r.block) || {};
      const list = blk.pairs || [];
      if (!list.length) continue;
      if (blk.readable) labeled++;
      for (const p of list) {
        if (!p || !p.sig || !p.ch) continue;
        const w = WEIGHTS[p.src] === undefined ? 2 : WEIGHTS[p.src];
        if (!w) continue;
        pairs++;
        vote(sigVotes, p.sig, p.ch, w);
        if (p.sigRaw) vote(rawVotes, p.sigRaw, p.ch, w);
      }
    }

    const sigRes = decide(sigVotes, minLead);
    const rawRes = decide(rawVotes, minLead);

    return {
      v: 1,
      ts: Date.now(),
      map: sigRes.map,
      raw: rawRes.map,
      n: Object.keys(sigRes.map).length,
      stats: {
        records: (records || []).length,
        labeled: labeled,
        pairs: pairs,
        glyphs: sigVotes.size,
        conflicts: sigRes.conflicts.length
      },
      conflicts: sigRes.conflicts.slice(0, 30).map(function (c) {
        return { sig: c.sig, all: c.all.map(function (x) { return { ch: x[0], w: x[1] }; }) };
      })
    };
  }

  /* 两张字典合并（服务端来的 + 本地算的）：同 sig 取权重更高的，权重未知时本地优先 */
  function merge(a, b) {
    const out = { map: {}, raw: {}, n: 0 };
    const dictA = (a && a.map) || {};
    const dictB = (b && b.map) || {};
    Object.keys(dictA).forEach(function (k) { out.map[k] = dictA[k]; });
    Object.keys(dictB).forEach(function (k) { out.map[k] = dictB[k]; });
    const rawA = (a && a.raw) || {};
    const rawB = (b && b.raw) || {};
    Object.keys(rawA).forEach(function (k) { out.raw[k] = rawA[k]; });
    Object.keys(rawB).forEach(function (k) { out.raw[k] = rawB[k]; });
    out.n = Object.keys(out.map).length;
    return out;
  }

  const API = { build: build, merge: merge, WEIGHTS: WEIGHTS };
  root.CXGlyphDict = API;
  try {
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
  } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : this);
