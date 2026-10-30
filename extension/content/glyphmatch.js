/* 字形通用解码（A+B 混合的第二半）
 *
 * 思路：站点字体每次都重画码位，但字形轮廓来自「思源黑体 1.000 Normal」，一个点都没改形状。
 * 所以只要把 base 的全字表（20945 字）预先算成 32×32 图元指纹，站点的新字就能反查出来。
 *
 * 关键：**不用浏览器/FreeType 的光栅器**。展平 + 扫描线填充这套逻辑在
 *   tools/_build-hybrid-table.py（base 侧）与本文件（站点侧）逐行同构，
 *   所以两边的描述子可比，不受抗锯齿实现差异影响。
 *
 * 数据：data/glyphdesc.bin.gz（20945×1024 uint8，gzip 约 2.9MB）+ data/glyphmeta.json
 */
(function (root) {
  'use strict';
  const CX = root.CX;
  if (!CX) return;

  const GRID = 32;
  const SS = 2;          // 超采样倍数
  const MARGIN_GATE = 0.05;
  const MAX_QUERY = 120; // 单次「建表周期」内最多查这么多个未知字形（可用 resetQuota 复位）
  let maxQueryOverride = 0;

  let desc = null;       // Int8Array(n * GRID*GRID)
  let norms = null;      // Float32Array(n)
  let cps = null;        // Int32Array(n)
  let n = 0;
  let loading = null;
  const cache = Object.create(null);   // sig -> 字 / '' (认不出)
  let queries = 0;
  let stat = { hit: 0, skip: 0, ready: false, quotaWarned: false };

  /* ---------------- 载入表 ---------------- */
  async function gunzip(u8) {
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([u8]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error('环境不支持 DecompressionStream');
  }

  function buildTable(rawU8, meta) {
    const dim = GRID * GRID;
    n = meta.n;
    /* 2026-10-31 加固：长度不符就直接报错。以前空/短数组会让 undefined 一路算成 NaN，
     * 写进 Int8Array 变成 0 —— 表全零却 ready=true，逆查会返回错字，比加载失败更坏。 */
    if (!rawU8 || rawU8.length < n * dim) {
      throw new Error('字形表长度不符：' + (rawU8 ? rawU8.length : 0) + ' < ' + (n * dim));
    }
    cps = Int32Array.from(meta.cps);
    desc = new Int8Array(n * dim);
    norms = new Float32Array(n);
    const scale = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < dim; k++) sum += rawU8[i * dim + k];
      const mean = sum / dim;
      let maxAbs = 1;
      for (let k = 0; k < dim; k++) {
        const v = rawU8[i * dim + k] - mean;
        if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
      }
      scale[i] = 127 / maxAbs;
      let sq = 0;
      for (let k = 0; k < dim; k++) {
        const q = Math.round((rawU8[i * dim + k] - mean) * scale[i]);
        desc[i * dim + k] = q;
        sq += q * q;
      }
      norms[i] = Math.sqrt(sq) || 1;
    }
    stat.ready = true;
    /* 2026-10-31：留一个廉价的完整性标记，用来自检"表是不是全零"。
     * 背景：SW 回传的字节曾被 runtime 消息的 JSON 序列化毁成 {}，结果建出一张全零表却 ready=true，
     * 逆查开始返回错字而不是报错 —— 光看 ready/n 是发现不了的。 */
    let nz = 0;
    const probeLen = Math.min(desc.length, 65536);
    for (let i = 0; i < probeLen; i++) if (desc[i]) nz++;
    stat.nz = nz;
  }

  function ensure() {
    if (stat.ready) return Promise.resolve(true);
    if (loading) return loading;
    loading = (async function () {
      try {
        let meta = null, raw = null;
        /* 首选：让 SW 读扩展内资源回传（不依赖 web_accessible_resources）
         * 2026-10-31 修：chrome.runtime 消息是 JSON 序列化，SW 回传的 ArrayBuffer 到这里会变成 {}
         * （实测 {ok:true, gz:{}}）。以前 {}} 是真值 → new Uint8Array({}) 长度 0 → gunzip 抛错 →
         * 直接跳到外层 catch，ready=false，而且再也不会走到下面的 fetch 兜底。
         * 现在必须校验真类型；gunzip 失败也只当"这条通道不可用"，把 raw 留空让 fetch 接手。 */
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          try {
            const r = await chrome.runtime.sendMessage({ kind: 'glyph:table' });
            if (r && r.ok && r.meta && r.gz instanceof ArrayBuffer && r.gz.byteLength > 1000) {
              meta = r.meta;
              try {
                raw = await gunzip(new Uint8Array(r.gz));
                if (raw) stat.src = 'sw';
              } catch (e) { raw = null; meta = null; }
            }
          } catch (e) {}
        }
        if (!raw) {
          const base = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
            ? chrome.runtime.getURL('data/') : 'data/';
          const [gzRes, metaRes] = await Promise.all([
            fetch(base + 'glyphdesc.bin.gz'),
            fetch(base + 'glyphmeta.json')
          ]);
          meta = await metaRes.json();
          raw = await gunzip(new Uint8Array(await gzRes.arrayBuffer()));
          stat.src = 'fetch';
        }
        buildTable(raw, meta);
        try { CX.info('字形逆查表就绪：' + meta.n + ' 字（来源 ' + (stat.src || '?') + '，nz=' + stat.nz + '）'); } catch (e) {}
        return true;
      } catch (e) {
        stat.ready = false;
        try { CX.warn('字形逆查表加载失败：' + ((e && e.message) || e)); } catch (e2) {}
        return false;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  /* ---------------- 展平（与 Python 完全同构） ---------------- */
  function flatten(pts) {
    const { xs, ys, on, ends } = pts;
    const polys = [];
    let start = 0;
    for (let c = 0; c < ends.length; c++) {
      const end = ends[c];
      const idx = [];
      for (let i = start; i <= end; i++) idx.push(i);
      start = end + 1;
      if (idx.length < 2) continue;

      // 找第一个 on-curve 起点
      let s = 0;
      for (let i = 0; i < idx.length; i++) {
        if (on[idx[i]]) { s = i; break; }
      }
      const order = idx.slice(s).concat(idx.slice(0, s));
      // 全 off-curve 的极端情况：直接跳过
      let hasOn = false;
      for (const k of order) if (on[k]) { hasOn = true; break; }
      if (!hasOn) continue;

      const poly = [];
      const P = (k) => [xs[k], ys[k]];
      poly.push(P(order[0]));
      let cur = P(order[0]);
      let i = 1;
      while (i <= order.length) {
        const k = order[i % order.length];
        if (on[k]) {
          poly.push(P(k));
          cur = P(k);
          i++;
        } else {
          const nk = order[(i + 1) % order.length];
          let endPt;
          if (on[nk]) {
            endPt = P(nk);
            i += 2;
          } else {
            endPt = [(xs[k] + xs[nk]) / 2, (ys[k] + ys[nk]) / 2];
            i += 1;
          }
          const nSeg = Math.max(1, Math.ceil(Math.hypot(endPt[0] - cur[0], endPt[1] - cur[1]) / 12.0));
          for (let t = 1; t <= nSeg; t++) {
            const u = t / nSeg, mu = 1 - u;
            poly.push([
              mu * mu * cur[0] + 2 * mu * u * xs[k] + u * u * endPt[0],
              mu * mu * cur[1] + 2 * mu * u * ys[k] + u * u * endPt[1]
            ]);
          }
          cur = endPt;
        }
        if (i > order.length) break;
      }
      if (poly.length > 2) polys.push(poly);
    }
    return polys;
  }

  /* ---------------- 扫描线光栅化（与 Python 完全同构） ---------------- */
  function raster(polys) {
    if (!polys.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) {
      for (const p of poly) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
    }
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 0 && h > 0)) return null;
    const scale = 1 / Math.max(w, h);
    const ox = (1 - w * scale) / 2;
    const oy = (1 - h * scale) / 2;

    const M = GRID * SS;
    const cover = new Uint8Array(M * M);
    const edges = [];
    for (const poly of polys) {
      const m = poly.length;
      for (let i = 0; i < m; i++) {
        let ax = (poly[i][0] - x0) * scale + ox;
        let ay = (poly[i][1] - y0) * scale + oy;
        let bx = (poly[(i + 1) % m][0] - x0) * scale + ox;
        let by = (poly[(i + 1) % m][1] - y0) * scale + oy;
        if (ay === by) continue;
        if (ay > by) { const t = ax; ax = bx; bx = t; const u = ay; ay = by; by = u; }
        edges.push([ax, ay, bx, by]);
      }
    }

    const hits = [];
    for (let row = 0; row < M; row++) {
      const yc = (row + 0.5) / M;
      hits.length = 0;
      for (let e = 0; e < edges.length; e++) {
        const [ax, ay, bx, by] = edges[e];
        if (ay <= yc && yc < by) {
          hits.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
      }
      if (!hits.length) continue;
      hits.sort((p, q) => p - q);
      for (let i = 0; i + 1 < hits.length; i += 2) {
        const ca = Math.max(0, Math.ceil(hits[i] * M - 0.5));
        const cb = Math.min(M - 1, Math.floor(hits[i + 1] * M - 0.5));
        for (let col = ca; col <= cb; col++) cover[row * M + col] = 1;
      }
    }

    const out = new Uint8Array(GRID * GRID);
    const per = SS * SS;
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        let s = 0;
        for (let dy = 0; dy < SS; dy++) {
          for (let dx = 0; dx < SS; dx++) s += cover[(r * SS + dy) * M + (c * SS + dx)];
        }
        out[r * GRID + c] = Math.min(255, Math.round((255 * s) / per));
      }
    }
    return out;
  }

  function descriptor(pts) {
    const polys = flatten(pts);
    return raster(polys);
  }

  /* ---------------- 查表 ---------------- */
  function identify(pts, sig) {
    if (!stat.ready) return null;
    if (sig && cache[sig] !== undefined) return cache[sig] ? { ch: cache[sig], src: 'cache' } : null;
    if (queries >= (maxQueryOverride || MAX_QUERY)) {
      /* 2026-10-28 修复：以前这里静默返回 null 且配额永不清零，页面上的字超过 120 个后
       * 后面全部留乱码、也不留任何痕迹。现在只警告一次，靠 resetQuota() 在换页/重建时复位。 */
      if (!stat.quotaWarned) {
        stat.quotaWarned = true;
        try { CX.warn('字形逆查配额用尽（' + queries + ' 次），本页剩余未知字形留乱码；换页或刷新会自动复位'); } catch (e) {}
      }
      stat.skip++;
      return null;
    }

    const d = descriptor(pts);
    if (!d) return null;

    const dim = GRID * GRID;
    let sum = 0;
    for (let i = 0; i < dim; i++) sum += d[i];
    const mean = sum / dim;
    let maxAbs = 1;
    for (let i = 0; i < dim; i++) {
      const v = d[i] - mean;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    const sc = 127 / maxAbs;
    const q = new Int8Array(dim);
    let sq = 0;
    for (let i = 0; i < dim; i++) {
      const v = Math.round((d[i] - mean) * sc);
      q[i] = v;
      sq += v * v;
    }
    const qn = Math.sqrt(sq) || 1;

    let best = -1, bestScore = -Infinity, second = -Infinity;
    for (let r = 0; r < n; r++) {
      const off = r * dim;
      let dot = 0;
      for (let k = 0; k < dim; k++) dot += desc[off + k] * q[k];
      const s = dot / (norms[r] * qn);
      if (s > bestScore) { second = bestScore; bestScore = s; best = r; }
      else if (s > second) second = s;
    }
    queries++;

    const margin = bestScore - second;
    if (best < 0 || margin < MARGIN_GATE) {
      stat.skip++;
      if (sig) cache[sig] = '';
      return null;
    }
    const ch = String.fromCodePoint(cps[best]);
    stat.hit++;
    if (sig) cache[sig] = ch;
    return { ch: ch, margin: margin, score: bestScore };
  }

  CX.glyphMatch = {
    ensure: ensure,
    descriptor: descriptor,
    identify: identify,
    /* 配额复位：换页 / 字体变了 / 字典重建时调用。以前计数器一辈子不清零，
     * 大字量页面（>120 个未知字形）第 121 个字之后永远是乱码。 */
    resetQuota: function () {
      queries = 0;
      stat.quotaWarned = false;
      return true;
    },
    quota: function () { return { used: queries, max: maxQueryOverride || MAX_QUERY }; },
    /* Node / 测试用：直接注入表 */
    _inject: function (rawU8, meta) { buildTable(rawU8, meta); },
    _setLimit: function (v) { maxQueryOverride = v; },
    stats: function () { return { ready: stat.ready, n: n, hit: stat.hit, skip: stat.skip, queries: queries, src: stat.src || '', nz: stat.nz || 0 }; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

