/* 本地测试服务：托管仿真页面 + Mock OpenAI 兼容接口
 * 用法: node tools/mock-server.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const PORT = Number(process.argv[2] || 8799);
const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const FIX = path.join(ROOT, 'test', 'fixtures');

/* ---------------- 答案表 ---------------- */
const KEY = {
  '我国的根本政治制度': ['A'],
  '下列哪些属于学习通任务点类型': ['A', 'B', 'D'],
  '视频任务点必须观看满多少比例': ['C'],
  '超星学习通属于在线教育平台': ['A'],
  '下列哪些行为会导致视频任务点暂停': ['A', 'C'],
  '学习检测未通过时可以重做': ['A']
};

function pickAnswer(stem) {
  for (const k of Object.keys(KEY)) {
    if (String(stem || '').includes(k)) return KEY[k];
  }
  return ['A'];
}

const counters = new Map();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });
}

/* ---------------- AI 模拟 ---------------- */
function handleChat(payload) {
  const task = payload.task;
  if (task === 'ping') return { content: JSON.stringify({ ok: true }) };

  if (task === 'video-quiz') {
    /* 兼容两种请求形态：question 为对象 或 为题干字符串 */
    const q = (payload.question && typeof payload.question === 'object') ? payload.question : { stem: payload.question };
    const correct = pickAnswer(q.stem || q.title || q.question);
    const options = payload.options || q.options || [];
    const hasFeedback = payload.feedback && payload.feedback.wrongAttempts && payload.feedback.wrongAttempts.length;
    if (!hasFeedback) {
      /* 第一次故意答错，验证重问逻辑 */
      const wrong = options.map((o) => o.label).filter((l) => correct.indexOf(l) < 0);
      return { content: JSON.stringify({ choices: wrong.length ? [wrong[0]] : correct }) };
    }
    return { content: JSON.stringify({ choices: correct }) };
  }

  if (task === 'exam') {
    const qs = payload.questions || [];
    const wrongList = (payload.feedback && payload.feedback.wrongQuestions) || [];
    const wrongStems = new Set(wrongList.map((w) => w.stem));
    const answers = qs.map((q) => {
      const correct = pickAnswer(q.stem);
      const isRetry = wrongStems.has(q.stem);
      let choices = correct;
      if (!isRetry) {
        /* 首轮：让第 1、3、5 题故意错 */
        const idx = q.index;
        if (idx % 2 === 0 && q.options && q.options.length > 1) {
          choices = [q.options.find((o) => correct.indexOf(o.label) < 0).label];
        }
      }
      return { index: q.index, choices: Array.isArray(choices) ? choices : [choices] };
    });
    return { content: JSON.stringify({ answers }) };
  }

  return { content: JSON.stringify({ ok: true }) };
}

/* ---------------- HTTP ---------------- */
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
    });
    return res.end();
  }

  if (u.pathname === '/mock/v1/chat/completions' && req.method === 'POST') {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw); } catch (e) {}
    const userMsg = body.messages && body.messages[1] && body.messages[1].content;
    let payload = {};
    try { payload = JSON.parse(userMsg); } catch (e) {}
    const out = handleChat(payload);
    console.log('[mock-ai]', payload.task, JSON.stringify(payload).slice(0, 220), '->', out.content.slice(0, 120));
    return json(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Date.now(),
      model: body.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: out.content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    });
  }

  if (u.pathname === '/state') {
    return json(res, 200, { counters: Object.fromEntries(counters) });
  }

  if (u.pathname === '/health') {
    return json(res, 200, { ok: true, port: PORT });
  }

  /* 静态页面 */
  let p = u.pathname === '/' ? '/exam.html' : u.pathname;
  const file = path.join(FIX, p.replace(/^\//, ''));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock server http://127.0.0.1:' + PORT);
});
