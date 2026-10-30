/* 超星加密字体解析（font-cxsecret）
 *
 * 为什么要有这一层：像素比对只能"猜"，而且每次加密都要重跑 1.5~4 秒。
 * 字体文件本身带 cmap（码位 → glyphId）和 glyf（字形轮廓点）。把「字形轮廓」规范化成一个
 * 指纹（em 归一化后取哈希），这个指纹**与码位无关、与字体子集重排无关**，于是：
 *   同一个字在不同轮次被塞进不同乱码码位时，指纹完全一样 → 一次标注，永久复用。
 *
 * 实测（2026-10-27）：站点下发的字体是 **Source Han Sans CN Normal（思源黑体）** 的子集，
 * 转成了 TrueType 轮廓（有 glyf/loca，没有 CFF），所以轮廓点可以直接比对。
 *
 * 本文件同时被浏览器（CX.ttf）和 Node 工具（require）使用，保持零依赖、无 DOM 依赖。
 */
(function (root) {
  'use strict';

  /* ---------------- 小工具 ---------------- */
  function hex32(n) {
    var s = (n >>> 0).toString(16);
    return ('00000000' + s).slice(-8);
  }
  /* 64 位风格的两路 FNV-1a：够短、够稳，比 BigInt 快一个量级 */
  function h32(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function hash(str) {
    return hex32(h32(str, 0x811c9dc5)) + hex32(h32(str, 0x7f4a7c15));
  }

  function tag4(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  }

  function fromBase64(b64) {
    var s = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (typeof atob === 'function') {
      var bin = atob(s);
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    /* Node */
    var B = (typeof Buffer !== 'undefined') ? Buffer : (function () { return require('buffer').Buffer; })();
    var buf = B.from(s, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  function toAB(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  /* ---------------- WOFF 解压（可选路径） ---------------- */
  async function inflateRaw(u8) {
    if (!u8 || !u8.length) return u8;
    try {
      if (typeof require === 'function') {
        var zlib = require('zlib');
        return new Uint8Array(zlib.inflateSync(Buffer.from(u8)));
      }
    } catch (e) {}
    if (typeof DecompressionStream === 'function') {
      var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('当前环境无法解压 WOFF（缺少 zlib / DecompressionStream）');
  }

  async function woffToSfnt(dv, bytes) {
    var flavor = dv.getUint32(4);
    var numTables = dv.getUint16(12);
    var dec = [];
    for (var i = 0; i < numTables; i++) {
      var o = 44 + i * 20;
      var tag = tag4(dv, o);
      var off = dv.getUint32(o + 4);
      var compLen = dv.getUint32(o + 8);
      var origLen = dv.getUint32(o + 12);
      var slice = bytes.subarray(off, off + compLen);
      var raw = compLen < origLen ? await inflateRaw(slice) : slice;
      dec.push({ tag: tag, data: raw });
    }
    /* 拼一个合法 sfnt：头 12 字节 + 目录 16*n + 表体 */
    var total = 12 + numTables * 16;
    dec.forEach(function (t) { total += t.data.length + (t.data.length % 4 ? 4 - (t.data.length % 4) : 0); });
    var out = new Uint8Array(total);
    var odv = new DataView(out.buffer);
    odv.setUint32(0, flavor);
    odv.setUint16(4, numTables);
    var p = 12 + numTables * 16;
    dec.forEach(function (t, k) {
      var e = 12 + k * 16;
      for (var c = 0; c < 4; c++) out[e + c] = t.tag.charCodeAt(c);
      odv.setUint32(e + 8, p);
      odv.setUint32(e + 12, t.data.length);
      out.set(t.data, p);
      p += t.data.length + (t.data.length % 4 ? 4 - (t.data.length % 4) : 0);
    });
    /* 目录按 tag 排序（规范要求，部分解析器依赖） */
    return toAB(out);
  }

  /* ---------------- cmap ---------------- */
  function parseCmap(dv, tab, map) {
    var n = dv.getUint16(tab.off + 2);
    var best = null;
    var bestFmt = 0;
    for (var i = 0; i < n; i++) {
      var rec = tab.off + 4 + i * 8;
      var pid = dv.getUint16(rec);
      var eid = dv.getUint16(rec + 2);
      var off = tab.off + dv.getUint32(rec + 4);
      var fmt = dv.getUint16(off);
      var score = 0;
      if (fmt === 12) score = 40;
      else if (fmt === 4) score = 30;
      else if (fmt === 6) score = 20;
      else if (fmt === 0) score = 10;
      if (pid === 3 && (eid === 10 || eid === 1)) score += 5;
      if (pid === 0) score += 3;
      if (score > bestFmt) { bestFmt = score; best = { off: off, fmt: fmt }; }
    }
    if (!best) return map;

    if (best.fmt === 4) {
      var sub = best.off;
      var segX2 = dv.getUint16(sub + 6);
      var seg = segX2 / 2;
      var endO = sub + 14;
      var startO = endO + segX2 + 2;
      var deltaO = startO + segX2;
      var rangeO = deltaO + segX2;
      for (var k = 0; k < seg; k++) {
        var end = dv.getUint16(endO + k * 2);
        var start = dv.getUint16(startO + k * 2);
        if (start > end) continue;
        var delta = dv.getInt16(deltaO + k * 2);
        var ro = dv.getUint16(rangeO + k * 2);
        for (var c = start; c <= end && c !== 0xffff; c++) {
          var gid;
          if (!ro) gid = (c + delta) & 0xffff;
          else {
            var go = rangeO + k * 2 + ro + (c - start) * 2;
            if (go + 1 >= dv.byteLength) continue;
            gid = dv.getUint16(go);
            if (gid) gid = (gid + delta) & 0xffff;
          }
          if (gid) map.set(c, gid);
        }
      }
    } else if (best.fmt === 12) {
      var sub12 = best.off;
      var groups = dv.getUint32(sub12 + 12);
      for (var g = 0; g < groups; g++) {
        var go2 = sub12 + 16 + g * 12;
        var s = dv.getUint32(go2);
        var e2 = dv.getUint32(go2 + 4);
        var sg = dv.getUint32(go2 + 8);
        for (var cp = s; cp <= e2; cp++) map.set(cp, sg + (cp - s));
      }
    } else if (best.fmt === 6) {
      var sub6 = best.off;
      var first = dv.getUint16(sub6 + 6);
      var cnt = dv.getUint16(sub6 + 8);
      for (var j = 0; j < cnt; j++) map.set(first + j, dv.getUint16(sub6 + 10 + j * 2));
    } else if (best.fmt === 0) {
      var sub0 = best.off;
      for (var m = 0; m < 256; m++) {
        var g0 = dv.getUint8(sub0 + 6 + m);
        if (g0) map.set(m, g0);
      }
    }
    return map;
  }

  /* ---------------- name ---------------- */
  function parseName(dv, tab) {
    var out = {};
    if (!tab) return out;
    var count = dv.getUint16(tab.off + 2);
    var strOff = tab.off + dv.getUint16(tab.off + 4);
    for (var i = 0; i < count; i++) {
      var r = tab.off + 6 + i * 12;
      var pid = dv.getUint16(r);
      var eid = dv.getUint16(r + 2);
      var nid = dv.getUint16(r + 6);
      var len = dv.getUint16(r + 8);
      var off = strOff + dv.getUint16(r + 10);
      if (nid > 6) continue;
      var s = '';
      try {
        if (pid === 3 || pid === 0) {
          for (var k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(off + k));
        } else {
          for (var k2 = 0; k2 < len; k2++) s += String.fromCharCode(dv.getUint8(off + k2));
        }
      } catch (e) { continue; }
      s = s.replace(/\u0000/g, '').trim();
      if (!s) continue;
      var key = ({ 1: 'family', 2: 'subfamily', 4: 'full', 6: 'postscript' })[nid] || ('name' + nid);
      if (!out[key]) out[key] = s;
    }
    return out;
  }

  /* ---------------- 核心：打开字体 ---------------- */
  async function sha1Hex(u8) {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const d = await crypto.subtle.digest('SHA-1', u8);
        const a = new Uint8Array(d);
        let s = '';
        for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
        return s;
      }
    } catch (e) {}
    try {
      if (typeof require === 'function') return require('crypto').createHash('sha1').update(u8).digest('hex');
    } catch (e) {}
    return '';
  }

  async function load(source) {
    var bytes;
    if (typeof source === 'string') bytes = fromBase64(source);
    else if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
    else if (source && source.buffer) bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    else throw new Error('无法识别的字体输入');

    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var sig = tag4(dv, 0);
    var ab;
    if (sig === 'wOFF') ab = await woffToSfnt(dv, bytes);
    else if (sig === 'wOF2') throw new Error('WOFF2 暂不支持（站点目前下发的是纯 TTF）');
    else ab = toAB(bytes);

    var font = open(ab);
    font.bytes = bytes.length;
    font.sha1 = await sha1Hex(bytes);
    /* 统一 id：内容哈希，任何工具算出来都一样，避免同一字体存成两份 */
    font.id = 'f_' + (font.sha1 || hash(String(bytes.length) + String(bytes[0])).replace(/[^0-9a-f]/g, '')).slice(0, 12);
    return font;
  }

  function open(ab) {
    var dv = new DataView(ab);
    var tag = tag4(dv, 0);
    var base = 0;
    if (tag === 'ttcf') base = dv.getUint32(12);
    var numTables = dv.getUint16(base + 4);
    var T = {};
    for (var i = 0; i < numTables; i++) {
      var o = base + 12 + i * 16;
      T[tag4(dv, o)] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
    }

    var head = T.head;
    var maxp = T.maxp;
    var upem = head ? dv.getUint16(head.off + 18) : 1000;
    var locFormat = head ? dv.getInt16(head.off + 50) : 0;
    var numGlyphs = maxp ? dv.getUint16(maxp.off + 4) : 0;

    var loca = null;
    if (T.loca && T.glyf && numGlyphs) {
      loca = new Uint32Array(numGlyphs + 1);
      for (var j = 0; j <= numGlyphs; j++) {
        loca[j] = locFormat ? dv.getUint32(T.loca.off + j * 4) : dv.getUint16(T.loca.off + j * 2) * 2;
      }
    }

    var cmap = new Map();
    if (T.cmap) parseCmap(dv, T.cmap, cmap);

    var numHM = 0;
    if (T.hhea) numHM = dv.getUint16(T.hhea.off + 34);
    function advance(gid) {
      if (!T.hmtx || !numHM || gid >= numGlyphs) return 0;
      var idx = gid < numHM ? gid : numHM - 1;
      try { return dv.getUint16(T.hmtx.off + idx * 4); } catch (e) { return 0; }
    }

    var names = parseName(dv, T.name);

    /* ---- 字形轮廓 → 指纹 ---- */
    var sigCache = {};
    var infoCache = {};

    function sigOf(gid, depth) {
      if (gid == null || gid < 0 || gid >= numGlyphs) return '';
      if (sigCache[gid] !== undefined) return sigCache[gid];
      if ((depth || 0) > 6) return 'D';
      sigCache[gid] = ''; /* 占位，防环 */
      var r = readGlyph(gid, depth || 0);
      sigCache[gid] = r.sig;
      infoCache[gid] = r;
      return r.sig;
    }

    function readGlyph(gid, depth) {
      var empty = { gid: gid, sig: '', sigRaw: '', points: 0, contours: 0, w: 0, h: 0, x0: 0, y0: 0, composite: false };
      if (!loca || !T.glyf) return empty;
      var start = loca[gid];
      var end = loca[gid + 1];
      if (start === undefined || end === undefined || end <= start) return empty;

      var off = T.glyf.off + start;
      var nc;
      try { nc = dv.getInt16(off); } catch (e) { return empty; }

      if (nc < 0) {
        /* 复合字形：把组件递归成「内容指纹 + 变换」 */
        var c = off + 10;
        var parts = [];
        var guard = 0;
        while (true) {
          if (++guard > 64) break;
          if (c + 4 > dv.byteLength) break;
          var flags = dv.getUint16(c);
          var cgid = dv.getUint16(c + 2);
          c += 4;
          var a1, a2;
          if (flags & 1) { a1 = dv.getInt16(c); a2 = dv.getInt16(c + 2); c += 4; }
          else { a1 = dv.getInt8(c); a2 = dv.getInt8(c + 1); c += 2; }
          var tr = '';
          if (flags & 8) { tr = '/' + dv.getInt16(c); c += 2; }
          else if (flags & 0x40) { tr = '/' + dv.getInt16(c) + '/' + dv.getInt16(c + 2); c += 4; }
          else if (flags & 0x80) { tr = '/' + dv.getInt16(c) + '/' + dv.getInt16(c + 2) + '/' + dv.getInt16(c + 4) + '/' + dv.getInt16(c + 6); c += 8; }
          var sub = sigOf(cgid, depth + 1);
          parts.push(sub + ':' + a1 + ',' + a2 + tr);
          if (!(flags & 0x20)) break;
        }
        var csig = 'C(' + parts.join(';') + ')';
        return {
          gid: gid, sig: hash(csig), sigRaw: hash(csig), points: parts.length, contours: -1,
          w: 0, h: 0, x0: 0, y0: 0, composite: true
        };
      }

      var p = off + 10;
      var ends = new Int32Array(nc);
      for (var k = 0; k < nc; k++) { ends[k] = dv.getUint16(p); p += 2; }
      var npts = nc ? ends[nc - 1] + 1 : 0;
      if (!npts) return empty;

      var insLen = dv.getUint16(p); p += 2 + insLen;   /* 跳过 hinting：子集化常把它删掉，不能进指纹 */

      var flagsArr = new Uint8Array(npts);
      var i2 = 0;
      while (i2 < npts) {
        var f = dv.getUint8(p++);
        flagsArr[i2++] = f;
        if (f & 8) {
          var rep = dv.getUint8(p++);
          while (rep-- > 0 && i2 < npts) flagsArr[i2++] = f;
        }
      }

      var xs = new Int32Array(npts);
      var x = 0;
      for (var xa = 0; xa < npts; xa++) {
        var fx = flagsArr[xa];
        if (fx & 2) { var dx = dv.getUint8(p++); x += (fx & 16) ? dx : -dx; }
        else if (!(fx & 16)) { x += dv.getInt16(p); p += 2; }
        xs[xa] = x;
      }
      var ys = new Int32Array(npts);
      var y = 0;
      for (var ya = 0; ya < npts; ya++) {
        var fy = flagsArr[ya];
        if (fy & 4) { var dy = dv.getUint8(p++); y += (fy & 32) ? dy : -dy; }
        else if (!(fy & 32)) { y += dv.getInt16(p); p += 2; }
        ys[ya] = y;
      }

      var minX = xs[0], maxX = xs[0], minY = ys[0], maxY = ys[0];
      for (var m2 = 1; m2 < npts; m2++) {
        if (xs[m2] < minX) minX = xs[m2];
        if (xs[m2] > maxX) maxX = xs[m2];
        if (ys[m2] < minY) minY = ys[m2];
        if (ys[m2] > maxY) maxY = ys[m2];
      }

      /* em 归一化：不同 upem 的同一字形也能对上；坐标是整数，1024/em 的量化几乎无损 */
      var scale = 1024 / (upem || 1000);
      var parts2 = [];
      var rawParts = [];
      for (var q = 0; q < npts; q++) {
        var nx = Math.round((xs[q] - minX) * scale);
        var ny = Math.round((ys[q] - minY) * scale);
        var on = (flagsArr[q] & 1) ? 1 : 0;
        parts2.push(nx + ',' + ny + (on ? 'o' : 'i'));
        rawParts.push((xs[q] - minX) + ',' + (ys[q] - minY) + (on ? 'o' : 'i'));
      }
      var head2 = nc + ':' + Array.prototype.join.call(ends, ',') + '|';
      var s1 = 'S' + head2 + parts2.join(' ');
      var s2 = 'R' + head2 + rawParts.join(' ');

      /* 原始点集：给 glyphmatch.js 做展平+光栅化用（与 Python 侧同一套算法） */
      var onArr = new Uint8Array(npts);
      for (var q2 = 0; q2 < npts; q2++) onArr[q2] = (flagsArr[q2] & 1) ? 1 : 0;
      var pts = { xs: xs, ys: ys, on: onArr, ends: ends };

      return {
        gid: gid,
        sig: hash(s1),
        sigRaw: hash(s2),
        points: npts,
        contours: nc,
        w: maxX - minX,
        h: maxY - minY,
        x0: minX,
        y0: minY,
        composite: false,
        pts: pts
      };
    }

    function infoForChar(ch) {
      var cp = ch.codePointAt(0);
      var gid = cmap.get(cp);
      if (gid == null) return { cp: cp, gid: null, sig: '', sigRaw: '', mapped: false };
      var r = (infoCache[gid] !== undefined) ? infoCache[gid] : (sigOf(gid, 0), infoCache[gid]);
      return {
        cp: cp,
        gid: gid,
        sig: (r && r.sig) || '',
        sigRaw: (r && r.sigRaw) || '',
        aw: advance(gid),
        points: (r && r.points) || 0,
        contours: (r && r.contours) || 0,
        w: (r && r.w) || 0,
        h: (r && r.h) || 0,
        composite: !!(r && r.composite),
        mapped: true
      };
    }

    return {
      upem: upem,
      numGlyphs: numGlyphs,
      tables: Object.keys(T),
      names: names,
      cmapSize: cmap.size,
      codepoints: Array.from(cmap.keys()),
      advance: advance,
      infoForChar: infoForChar,
      infoForCode: function (cp) { return infoForChar(String.fromCodePoint(cp)); },
      sigOfChar: function (ch) { var r = infoForChar(ch); return r.mapped ? r.sig : ''; },
      /* 原始点集：{xs, ys, on, ends}，供 content/glyphmatch.js 展平 + 光栅化 */
      pointsOfGid: function (gid) {
        if (gid == null || gid < 0 || gid >= numGlyphs) return null;
        if (infoCache[gid] === undefined) sigOf(gid, 0);
        var r = infoCache[gid];
        return (r && r.pts) ? r.pts : null;
      },
      pointsOfChar: function (ch) {
        var i = infoForChar(ch);
        return i.gid == null ? null : (infoForChar(ch), (function () {
          if (infoCache[i.gid] === undefined) sigOf(i.gid, 0);
          var r = infoCache[i.gid];
          return (r && r.pts) ? r.pts : null;
        })());
      }
    };
  }

  /* ---------------- DOM 辅助（只有浏览器里有） ---------------- */
  var dom = {
    /* 找出页面里所有 @font-face 定义，返回 [{family, src, b64, mime}] */
    fontFaces: function (doc) {
      var out = [];
      var seen = {};
      function push(family, src) {
        if (!src || seen[family + '|' + src.slice(0, 64)]) return;
        seen[family + '|' + src.slice(0, 64)] = 1;
        var m = String(src).match(/url\(["']?(data:([^;,]+)[^,]*,)?([^"')]+)["']?\)/);
        out.push({
          family: String(family || '').replace(/^["']|["']$/g, ''),
          src: String(src || '').slice(0, 200),
          mime: (m && m[2]) || '',
          b64: m && m[2] ? m[3] : null,
          url: m ? m[3] : null,
          isData: !!(m && m[2])
        });
      }
      try {
        Array.prototype.forEach.call(doc.styleSheets || [], function (sh) {
          var rules = null;
          try { rules = sh.cssRules; } catch (e) { return; }
          Array.prototype.forEach.call(rules || [], function (r) {
            if (!r || !r.style) return;
            var fam = r.style.fontFamily || (r.style.getPropertyValue && r.style.getPropertyValue('font-family'));
            if (!fam) return;
            var src = r.style.src || (r.style.getPropertyValue && r.style.getPropertyValue('src'));
            if (!src) return;
            push(fam, src);
          });
        });
      } catch (e) {}
      return out;
    },
    /* @font-face 的 src 可能是多个 url()，取第一个能用的 base64 的字体定义 */
    pickFace: function (doc, familyHint) {
      var faces = dom.fontFaces(doc);
      var hint = String(familyHint || '').replace(/^["']|["']$/g, '').split(',')[0].trim();
      var cands = faces.filter(function (f) { return f.b64; });
      if (hint) {
        var exact = cands.filter(function (f) { return f.family.toLowerCase().indexOf(hint.toLowerCase()) >= 0; });
        if (exact.length) return exact[0];
      }
      return cands[0] || null;
    },
    familyOf: function (el) {
      try {
        var f = getComputedStyle(el).fontFamily || '';
        return f.split(',')[0].replace(/^["']|["']$/g, '').trim();
      } catch (e) { return ''; }
    }
  };

  var API = {
    load: load,
    open: open,
    hash: hash,
    fromBase64: fromBase64,
    dom: dom
  };

  try {
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
  } catch (e) {}

  if (root) {
    var CX = root.CX = root.CX || {};
    CX.ttf = API;
  }
})(typeof globalThis !== 'undefined' ? globalThis : null);
