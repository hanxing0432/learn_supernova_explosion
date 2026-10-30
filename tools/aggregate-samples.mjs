// 汇总样本 → 字形字典（跨轮次、跨页面复用的核心资产）
//
// 用法：node tools/aggregate-samples.mjs [--min 1]
// 产物：
//   _samples/glyphdict.json   { map: { sig: 字 }, raw: { sigRaw: 字 }, meta }
//   _samples/report.md        人看的汇总报告（覆盖度 / 冲突 / 待标注）
//   _samples/pairs.jsonl      逐字符扁平行，便于再分析
//
// 判定规则：
//   - 每个字形指纹收集所有「被标注过的」投票，manual(3) > align(2) > auto(1)
//   - 最高票必须领先次高票 ≥ min 分，否则记为冲突，不进字典（宁可缺，不可错）
//   - sig 与 sigRaw 同时输出：sig 是 em 归一化的，跨 upem 有效；sigRaw 是同 upem 的原值

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '_samples');
const REC = path.join(OUT, 'records');

const minLead = (() => {
  const i = process.argv.indexOf('--min');
  return i > 0 ? Number(process.argv[i + 1]) || 1 : 1;
})();

const WEIGHT = { manual: 3, align: 2, auto: 1, 'sentence': 2, snapshot: 0 };

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

const recs = [];
for (const f of walk(REC)) {
  try { recs.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { console.error('坏记录 ' + f + ': ' + e.message); }
}

const sigVotes = new Map();   // sig -> Map(char -> weight)
const rawVotes = new Map();
const fontInfo = new Map();
const pairsOut = [];
let labeledBlocks = 0;
let rawBlocks = 0;

function vote(store, key, ch, w) {
  if (!key || !ch) return;
  let m = store.get(key);
  if (!m) { m = new Map(); store.set(key, m); }
  m.set(ch, (m.get(ch) || 0) + w);
}

for (const r of recs) {
  const fid = r.fontId;
  const fi = fontInfo.get(fid) || {
    fontId: fid, family: r.font?.family || '', bytes: r.font?.bytes || 0,
    upem: r.font?.upem || 0, glyphs: r.font?.numGlyphs || 0,
    cipher: new Set(r.font?.cipher || []), blocks: 0, labeled: 0, pages: new Set(),
    sigByCp: new Map()
  };
  fi.blocks++;
  fi.pages.add((r.page && r.page.href) || '');
  if (r.block.readable) { fi.labeled++; labeledBlocks++; } else rawBlocks++;
  for (const p of r.block.pairs || []) {
    if (p.c && p.sig && p.ch) fi.sigByCp.set(p.c, p.sig);
  }
  fontInfo.set(fid, fi);

  const src = r.block.pairs && r.block.pairs[0] && r.block.pairs[0].src;
  const w = r.block.readable ? (WEIGHT[src] || 2) : 0;
  for (const p of r.block.pairs || []) {
    if (w) {
      vote(sigVotes, p.sig, p.ch, w);
      vote(rawVotes, p.sigRaw, p.ch, w);
    }
    pairsOut.push({
      fontId: fid, block: r.block.index, cp: p.c ? p.c.codePointAt(0) : null, c: p.c || '',
      ch: p.ch || '', sig: p.sig || '', sigRaw: p.sigRaw || '', src: p.src || '',
      readable: !!r.block.readable, ts: r.ts
    });
  }
}

function decide(store) {
  const out = {};
  const conflicts = [];
  for (const [sig, m] of store) {
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [ch, w] = sorted[0];
    const lead = sorted.length > 1 ? w - sorted[1][1] : w;
    if (lead < minLead) { conflicts.push({ sig, top: sorted[0], all: sorted }); continue; }
    out[sig] = { ch, w, lead, n: sorted.length };
  }
  return { out, conflicts };
}

const sigRes = decide(sigVotes);
const rawRes = decide(rawVotes);

const dict = {
  v: 1,
  ts: Date.now(),
  source: 'cx-fontsampler',
  minLead,
  map: Object.fromEntries(Object.entries(sigRes.out).map(([k, v]) => [k, v.ch])),
  raw: Object.fromEntries(Object.entries(rawRes.out).map(([k, v]) => [k, v.ch])),
  weight: Object.fromEntries(Object.entries(sigRes.out).map(([k, v]) => [k, { w: v.w, lead: v.lead }])),
  fonts: [...fontInfo.keys()]
};
fs.writeFileSync(path.join(OUT, 'glyphdict.json'), JSON.stringify(dict, null, 1));
fs.writeFileSync(path.join(OUT, 'pairs.jsonl'), pairsOut.map((p) => JSON.stringify(p)).join('\n') + '\n');

/* ---- 报告 ---- */
const lines = [];
const pad = (s, n) => String(s).padEnd(n);
lines.push('# 字形字典汇总');
lines.push('');
lines.push(`生成时间：${new Date().toLocaleString('zh-CN')}　记录 ${recs.length} 条（已标注 ${labeledBlocks} / 待标注 ${rawBlocks}）`);
lines.push('');
lines.push(`- 字典条目：**${Object.keys(dict.map).length}** 个字形（sig）`);
lines.push(`- 冲突被丢弃：**${sigRes.conflicts.length}** 个`);
lines.push(`- 字符对总数：**${pairsOut.length}**`);
lines.push('');
lines.push('## 各字体覆盖度');
lines.push('');
lines.push('| 字体 | family | 块 | 已标注 | 码位 | 字典已解 | 缺 |');
lines.push('|---|---|---|---|---|---|---|');
for (const fi of fontInfo.values()) {
  const solved = [...fi.sigByCp.keys()].length;
  lines.push(`| ${fi.fontId} | ${fi.family || '-'} | ${fi.blocks} | ${fi.labeled} | ${fi.cipher.size} | ${solved} | ${Math.max(0, fi.cipher.size - solved)} |`);
}
lines.push('');

if (sigRes.conflicts.length) {
  lines.push('## 冲突（同指纹给出不同字，未收入字典）');
  lines.push('');
  for (const c of sigRes.conflicts.slice(0, 50)) {
    lines.push(`- \`${c.sig}\` → ${c.all.map(([ch, w]) => `${ch}(${w})`).join(' / ')}`);
  }
  lines.push('');
}

/* 待标注：出现过但没进字典的字体码位 */
const unresolved = [];
for (const fi of fontInfo.values()) {
  for (const cp of fi.cipher) {
    if (!fi.sigByCp.has(cp)) unresolved.push({ fid: fi.fontId, cp });
  }
}
if (unresolved.length) {
  lines.push('## 还没标注的码位');
  lines.push('');
  const byFont = new Map();
  for (const u of unresolved) {
    if (!byFont.has(u.fid)) byFont.set(u.fid, []);
    byFont.get(u.fid).push(u.cp);
  }
  for (const [fid, cps] of byFont) {
    lines.push(`- ${fid}: ${cps.slice(0, 80).join(' ')}`);
  }
  lines.push('');
}

lines.push('## 字典全文（sig → 字）');
lines.push('');
const entries = Object.entries(dict.map).sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'zh'));
lines.push(entries.map(([sig, ch]) => `${ch} \`${sig}\``).join('　'));
lines.push('');

fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'));

console.log(`记录 ${recs.length}，已标注块 ${labeledBlocks}，字符对 ${pairsOut.length}`);
console.log(`字典 ${Object.keys(dict.map).length} 条，冲突 ${sigRes.conflicts.length}，未标注码位 ${unresolved.length}`);
console.log('已写入 ' + path.join(OUT, 'glyphdict.json'));
