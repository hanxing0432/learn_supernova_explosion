// 字体样本收样服务（零依赖，仅 127.0.0.1）
//
// 作用：扩展把「加密块原文 + 你提供的真文字 + 字体文件 + 字形指纹 + 截图」POST 过来，
//       这里落盘成结构化样本，供 tools/aggregate-samples.mjs 汇总成字形字典。
//
// 启动：node tools/sample-server.mjs        （或双击 启动收样服务.cmd）
// 面板：http://127.0.0.1:8788/
//
// 落盘结构（全部在 _samples/ 下）：
//   fonts/<fontId>.ttf              字体原件（按内容哈希命名，天然去重）
//   records/<fontId>/b<块号>.json   每个加密块一条，重复保存即覆盖（幂等）
//   shots/<fontId>-b<块号>.png      该块的截图（真文字的像素来源）
//   log.jsonl                       追加式流水，便于回溯
//   glyphdict.json                  aggregate-samples.mjs 生成的字典
//   report.md                       汇总报告

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '_samples');
const PORT = Number(process.env.PORT || 8788);
const HOST = '127.0.0.1';

const DIRS = ['fonts', 'records', 'shots'];
DIRS.forEach((d) => fs.mkdirSync(path.join(OUT, d), { recursive: true }));

/* ---------------- 工具 ---------------- */
const logPath = path.join(OUT, 'log.jsonl');
function appendLog(obj) {
  try { fs.appendFileSync(logPath, JSON.stringify(obj) + '\n'); } catch (e) {}
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'x';
}

/* ---------------- 收样 ---------------- */
function saveFont(font) {
  if (!font || !font.b64) return null;
  const id = safeId(font.id || ('f_' + Date.now().toString(36)));
  const file = path.join(OUT, 'fonts', id + '.ttf');
  if (!fs.existsSync(file)) {
    const buf = Buffer.from(String(font.b64).replace(/^data:[^,]*,/, ''), 'base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  }
  return id;
}

/* 图片按内容哈希命名：同一张图反复粘不会重复写，也不会被后来的「采集」冲掉 */
function saveShots(fontId, tag, list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (dataUrl) {
    if (!dataUrl) return;
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (e) { return; }
    const h = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
    const name = `${fontId}-${tag}-${h}.png`;
    const file = path.join(OUT, 'shots', name);
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
      out.push('shots/' + name);
    } catch (e) {}
  });
  return out;
}

function saveRecord(payload) {
  const font = payload.font || {};
  const fontId = saveFont(font);
  if (!fontId) throw new Error('缺少字体数据');

  const dir = path.join(OUT, 'records', safeId(fontId));
  fs.mkdirSync(dir, { recursive: true });

  /* 章节级附图：按内容哈希命名，多次粘图逐张追加，不会互相覆盖 */
  const page = payload.page || {};
  const pageList = Array.isArray(page.shots) ? page.shots : (page.shot ? [page.shot] : []);
  const pageShots = [];
  pageList.forEach(function (dataUrl) {
    const one = saveShots(fontId, 'page', [dataUrl]);
    if (one.length && pageShots.indexOf(one[0]) < 0) pageShots.push(one[0]);
  });
  if (!pageShots.length) {
    try {
      fs.readdirSync(path.join(OUT, 'shots'))
        .filter(function (f) { return f.indexOf(fontId + '-page-') === 0; })
        .sort()
        .forEach(function (f) { pageShots.push('shots/' + f); });
    } catch (e) {}
  }

  const saved = [];
  const blocks = payload.blocks || (payload.block ? [payload.block] : []);
  for (const b of blocks) {
    const idx = Number.isFinite(b.index) ? b.index : 0;
    const shotList = Array.isArray(b.shots) ? b.shots : (b.shot ? [b.shot] : []);
    const file = path.join(dir, 'b' + idx + '.json');

    /* 合并旧记录：重新「采集」只带乱码，不能把上次配的图和对照文字冲掉 */
    let old = null;
    try { if (fs.existsSync(file)) old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    const oldShots = (old && old.block)
      ? (Array.isArray(old.block.shots) ? old.block.shots.slice(0) : (old.block.shot ? [old.block.shot] : []))
      : [];
    const newShots = saveShots(fontId, 'b' + idx, shotList);
    let shots = oldShots.slice(0);
    newShots.forEach(function (s) { if (shots.indexOf(s) < 0) shots.push(s); });

    const readable = (b.readable || '').trim() ? b.readable : ((old && old.block && old.block.readable) || '');
    const pairs = (Array.isArray(b.pairs) && b.pairs.length) ? b.pairs : ((old && old.block && old.block.pairs) || []);
    const status = pairs.length ? 'labeled' : 'raw';

    const rec = {
      v: 1,
      ts: payload.ts || Date.now(),
      fontId: fontId,
      font: {
        id: fontId,
        family: font.family || '',
        sig48: font.sig48 || '',
        bytes: font.bytes || 0,
        upem: font.upem || 0,
        numGlyphs: font.numGlyphs || 0,
        names: font.names || {},
        cipher: font.cipher || []
      },
      page: {
        href: page.href || '',
        title: page.title || '',
        frame: page.frame || '',
        shot: pageShots[0] || null,
        shots: pageShots,
        shotMeta: page.shotMeta || null
      },
      block: {
        index: idx,
        kind: b.kind || (old && old.block && old.block.kind) || '',
        raw: b.raw || (old && old.block && old.block.raw) || '',
        readable: readable,
        status: status,
        pairs: pairs,
        note: b.note || '',
        shot: shots[0] || null,
        shots: shots
      },
      user: payload.user || ''
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 1));
    saved.push({ file: path.relative(ROOT, file), pairs: rec.block.pairs.length, status: rec.block.status });
    appendLog({ t: new Date().toISOString(), kind: 'record', fontId: fontId, block: idx, pairs: rec.block.pairs.length, status: rec.block.status, shots: shots.length });
  }
  return { fontId, saved, pageShots };
}

/* ---------------- 统计 ---------------- */
function listRecords() {
  const base = path.join(OUT, 'records');
  const out = [];
  if (!fs.existsSync(base)) return out;
  for (const fdir of fs.readdirSync(base)) {
    const p = path.join(base, fdir);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(p, f), 'utf8')));
      } catch (e) {}
    }
  }
  return out;
}

function stats() {
  const recs = listRecords();
  const byFont = {};
  const sigs = new Map();
  let labeled = 0, raw = 0, pairCount = 0;
  for (const r of recs) {
    const f = (byFont[r.fontId] = byFont[r.fontId] || {
      fontId: r.fontId, family: r.font?.family || '', blocks: 0, labeled: 0, cipher: (r.font?.cipher || []).length,
      pages: new Set()
    });
    f.blocks++;
    f.pages.add(r.page?.href || '');
    if (r.block.readable) f.labeled++;
    if (r.block.readable) labeled++; else raw++;
    for (const p of r.block.pairs || []) {
      pairCount++;
      if (!p.sig) continue;
      const cur = sigs.get(p.sig) || { sig: p.sig, votes: {}, n: 0, fonts: new Set() };
      cur.n++;
      cur.votes[p.ch] = (cur.votes[p.ch] || 0) + (p.src === 'manual' ? 3 : 1);
      cur.fonts.add(r.fontId);
      sigs.set(p.sig, cur);
    }
  }
  const conflicts = [];
  const dict = {};
  for (const [sig, v] of sigs) {
    const sorted = Object.entries(v.votes).sort((a, b) => b[1] - a[1]);
    dict[sig] = sorted[0][0];
    if (sorted.length > 1) conflicts.push({ sig, top: sorted[0], all: sorted });
  }
  return {
    samples: recs.length,
    labeled,
    raw,
    pairs: pairCount,
    glyphs: sigs.size,
    conflicts: conflicts.length,
    fonts: Object.values(byFont).map((f) => ({ ...f, pages: f.pages.size })),
    conflictList: conflicts.slice(0, 40)
  };
}

/* ---------------- 页面 ---------------- */
function dashboard() {
  const s = stats();
  const fontRows = s.fonts.map((f) => `<tr><td>${f.fontId}</td><td>${escapeHtml(f.family)}</td>
    <td>${f.blocks}</td><td>${f.labeled}</td><td>${f.cipher}</td><td><a href="/font/${f.fontId}">查看</a></td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>字体样本库</title>
<style>
 body{font:13px/1.6 -apple-system,"Segoe UI",微软雅黑,sans-serif;background:#12151a;color:#d7dde5;margin:0;padding:24px}
 h1{font-size:17px;margin:0 0 4px} .sub{color:#7b8698;margin-bottom:18px}
 .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
 .card{background:#1a1f27;border:1px solid #262e3a;border-radius:10px;padding:12px 16px;min-width:96px}
 .card b{display:block;font-size:22px;color:#7fd1ae} .card span{color:#7b8698}
 table{border-collapse:collapse;width:100%;margin-top:8px}
 th,td{border-bottom:1px solid #232a34;padding:6px 8px;text-align:left;font-size:12px}
 th{color:#7b8698;font-weight:500}
 a{color:#7fb8ff;text-decoration:none} a:hover{text-decoration:underline}
 .bar{display:flex;gap:8px;margin:14px 0}
 button{background:#243040;color:#cfe0f5;border:1px solid #33465c;border-radius:7px;padding:6px 12px;cursor:pointer;font:inherit}
 button:hover{background:#2c3c50}
 code{background:#1a1f27;padding:1px 5px;border-radius:4px;color:#e2c08d}
 .warn{color:#e2b04d}
</style>
<h1>字体样本库</h1>
<div class="sub">目录 <code>${escapeHtml(OUT)}</code> · 每保存一次块就落一条记录</div>
<div class="cards">
  <div class="card"><b>${s.samples}</b><span>记录</span></div>
  <div class="card"><b>${s.pairs}</b><span>已对齐字符对</span></div>
  <div class="card"><b>${s.glyphs}</b><span>不同字形</span></div>
  <div class="card"><b>${s.labeled}</b><span>已标注块</span></div>
  <div class="card"><b>${s.raw}</b><span>待标注块</span></div>
  <div class="card"><b class="${s.conflicts ? 'warn' : ''}">${s.conflicts}</b><span>指纹冲突</span></div>
</div>
<div class="bar">
  <button onclick="fetch('/aggregate',{method:'POST'}).then(r=>r.json()).then(j=>{document.getElementById('agg').textContent=j.summary||j.error})">重新汇总字典</button>
  <button onclick="fetch('/open',{method:'POST'})">打开样本目录</button>
  <a href="/glyphdict" target="_blank"><button>查看 glyphdict.json</button></a>
  <a href="/report" target="_blank"><button>查看 report.md</button></a>
</div>
<pre id="agg" style="color:#7fd1ae;white-space:pre-wrap;margin:0 0 14px"></pre>
<table><tr><th>字体</th><th>family</th><th>块</th><th>已标注</th><th>码位数</th><th>字体文件</th></tr>${fontRows}</table>
`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  const p = url.pathname;

  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }

  try {
    if (p === '/' && req.method === 'GET') {
      const html = dashboard();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (p === '/ping') { json(res, 200, { ok: true, root: OUT, port: PORT }); return; }

    if (p === '/stats') { json(res, 200, { ok: true, ...stats() }); return; }

    if (p === '/ingest' && req.method === 'POST') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const r = saveRecord(payload);
      json(res, 200, { ok: true, ...r });
      return;
    }

    if (p === '/glyphdict') {
      const f = path.join(OUT, 'glyphdict.json');
      if (!fs.existsSync(f)) { json(res, 200, { v: 1, map: {}, raw: {}, ts: 0, empty: true }); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(f));
      return;
    }

    if (p === '/report') {
      const f = path.join(OUT, 'report.md');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.existsSync(f) ? fs.readFileSync(f) : '（还没有报告，先跑一次汇总）');
      return;
    }

    if (p === '/aggregate' && req.method === 'POST') {
      const out = await runAggregate();
      json(res, 200, { ok: true, summary: out });
      return;
    }

    if (p === '/open' && req.method === 'POST') {
      spawn('explorer.exe', [OUT], { detached: true, stdio: 'ignore' }).unref();
      json(res, 200, { ok: true });
      return;
    }

    if (p.startsWith('/shot/') || p.startsWith('/fonts/') || p.startsWith('/font/')) {
      const rel = p.startsWith('/fonts/') ? 'fonts/' + path.basename(p)
        : p.startsWith('/font/') ? 'fonts/' + path.basename(p) + '.ttf'
          : 'shots/' + path.basename(p);
      const file = path.join(OUT, rel);
      if (!fs.existsSync(file)) { json(res, 404, { ok: false, error: 'not found' }); return; }
      const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (p === '/records') {
      const recs = listRecords().map((r) => ({
        fontId: r.fontId, block: r.block.index, status: r.block.status,
        raw: r.block.raw.slice(0, 60), readable: (r.block.readable || '').slice(0, 60),
        pairs: (r.block.pairs || []).length, url: (r.page || {}).href || ''
      }));
      json(res, 200, { ok: true, records: recs });
      return;
    }

    json(res, 404, { ok: false, error: 'no route ' + p });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

function runAggregate() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'aggregate-samples.mjs')], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve(out.trim().split('\n').slice(-6).join('\n') || ('exit ' + code)));
  });
}

server.listen(PORT, HOST, () => {
  console.log('收样服务已启动： http://' + HOST + ':' + PORT + '/');
  console.log('样本目录： ' + OUT);
});
