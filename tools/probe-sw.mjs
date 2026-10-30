/* 探查扩展 service worker 里可用的 API */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const BUILD = path.join(ROOT, '_test-build');
const PROFILE = path.join(ROOT, '_probe-profile');
const PORT = 9334;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(PROFILE, { recursive: true, force: true });
const child = spawn(EDGE, [
  '--user-data-dir=' + PROFILE,
  '--load-extension=' + BUILD,
  '--disable-extensions-except=' + BUILD,
  '--remote-debugging-port=' + PORT,
  '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'
], { stdio: 'ignore' });

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  opened() { return new Promise((res, rej) => { this.ws.readyState === 1 ? res() : (this.ws.addEventListener('open', res), this.ws.addEventListener('error', rej)); }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}

(async () => {
  let sw = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      console.log('targets:', list.map((t) => t.type + ':' + t.url.slice(0, 90)));
      sw = list.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url));
      if (sw) break;
    } catch (e) {}
    await sleep(250);
  }
  console.log('SW target:', sw && sw.url);
  if (!sw) { child.kill(); process.exit(1); }
  const cdp = new CDP(sw.webSocketDebuggerUrl);
  await cdp.opened();
  for (const expr of [
    'typeof chrome',
    'typeof chrome !== "undefined" ? Object.keys(chrome).length : -1',
    'typeof chrome.runtime',
    'chrome.runtime && chrome.runtime.id',
    'typeof chrome.storage',
    'Object.keys(chrome).filter(k=>/storage|runtime|alarms|tabs/.test(k)).join(",")',
    'JSON.stringify(chrome.runtime.getManifest())'
  ]) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      console.log('»', expr, '=>', r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description) : JSON.stringify(r.result.value));
    } catch (e) { console.log('»', expr, '=> ERR', e.message); }
  }
  child.kill();
  await sleep(300);
  try { execSync('taskkill /F /T /PID ' + child.pid, { stdio: 'ignore' }); } catch (e) {}
})();
