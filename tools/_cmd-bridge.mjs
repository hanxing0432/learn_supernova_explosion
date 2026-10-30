/* 本地命令桥：给扩展提供「取命令 / 回结果」的极简 HTTP 服务。
 *
 * 扩展侧（background.js 的 cmdBridgeTick）每 1.2 秒 GET /poll，
 * 拿到命令就在 chaoxing 页面各 frame 里执行，再 POST /result 回传。
 *
 * 用法：
 *   node tools/_cmd-bridge.mjs
 *   curl "http://127.0.0.1:8765/run?cmd=stats"
 *   curl -X POST http://127.0.0.1:8765/run -d '{"cmd":"setdict","arg":"{\"sig\":\"字\"}"}'
 */
import http from 'node:http';

const PORT = Number(process.env.CMD_BRIDGE_PORT || 8765);
let pending = null;
let lastPollLog = 0;
let seq = 0;
const waiters = new Map();

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function dispatch(res, { cmd = 'stats', arg = '', timeout = 20000, tabId }) {
  const id = 'c' + (++seq);
  pending = { id, cmd, arg, tabId: tabId ? Number(tabId) : undefined };
  const timer = setTimeout(() => {
    waiters.delete(id);
    json(res, { ok: false, error: 'timeout waiting for extension', id });
  }, Number(timeout) || 20000);
  waiters.set(id, (payload) => {
    clearTimeout(timer);
    json(res, { ok: true, id, payload });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
    });
    return res.end();
  }

  if (url.pathname === '/ping') return json(res, { ok: true, port: PORT });

  if (url.pathname === '/poll') {
    const out = pending;
    pending = null;
    const t = Date.now();
    if (out) console.log('[poll] 取走命令', out.id);
    else if (!lastPollLog || t - lastPollLog > 30000) {
      lastPollLog = t;
      console.log('[poll] 心跳', new Date().toTimeString().slice(0, 8));
    }
    return json(res, out || {});
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(buf || '{}');
        const w = waiters.get(j.id);
        if (w) { waiters.delete(j.id); w(j.payload); }
        const s = JSON.stringify(j.payload);
        console.log('[result]', j.id, s.length > 400 ? s.slice(0, 400) + '…' : s);
      } catch (e) {
        console.log('[result] parse fail', e.message);
      }
      json(res, { ok: true });
    });
    return;
  }

  if (url.pathname === '/run' && req.method === 'POST') {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch (e) {}
      dispatch(res, body);
    });
    return;
  }

  if (url.pathname === '/run') {
    dispatch(res, {
      cmd: url.searchParams.get('cmd') || 'stats',
      arg: url.searchParams.get('arg') || '',
      timeout: url.searchParams.get('timeout') || 20000,
      tabId: url.searchParams.get('tabId') || undefined,
    });
    return;
  }

  json(res, { ok: false, error: 'unknown path' }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('cmd-bridge listening on http://127.0.0.1:' + PORT);
});
