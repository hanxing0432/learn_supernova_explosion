/* CDP 驱动的端到端测试：真 Edge + 真扩展 + 本地仿真页面 + Mock AI
 * 用法: node tools/run-test.mjs [all|ui|hud|antipause|exam|exam-li|video-quiz|nav|quiz-entry|guard|done|review|toc|toc-child|empty|empty-optin|empty-guard|font|retry|giveup|end]
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const BUILD = process.env.RUN_TEST_BUILD ? path.resolve(process.env.RUN_TEST_BUILD) : path.join(ROOT, '_test-build');
const PROFILE = path.join(ROOT, '_test-profile');
const PORT_SERVER = 8799;
const PORT_CDP = 9333;
const BASE = 'http://127.0.0.1:' + PORT_SERVER;

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

const which = process.argv[2] || 'all';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.contexts = [];
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.executionContextCreated') this.contexts.push(msg.params.context);
    });
  }
  opened() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === 1) return resolve();
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws error')));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval error: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
    }
    return r.result ? r.result.value : undefined;
  }
  /* 扩展隔离世界（content script）的 contextId —— 主世界拿不到 CX */
  isoContext() {
    const pick = this.contexts.filter((c) => c.auxData && c.auxData.type === 'isolated').slice(-1)[0];
    return pick ? pick.id : null;
  }
  async evalIso(expression, awaitPromise = true) {
    const contextId = this.isoContext();
    if (!contextId) throw new Error('拿不到扩展隔离世界（Runtime.enable 先调一次）');
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, contextId });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('evalIso error: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
    }
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function httpJson(p, opts) {
  const r = await fetch('http://127.0.0.1:' + PORT_CDP + p, opts);
  return r.json();
}
async function newTarget(targetUrl) {
  return httpJson('/json/new?' + encodeURIComponent(targetUrl), { method: 'PUT' });
}

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  throw new Error('mock server 未启动');
}

function launchEdge() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  return spawn(EDGE, [
    '--user-data-dir=' + PROFILE,
    '--load-extension=' + BUILD,
    '--disable-extensions-except=' + BUILD,
    '--remote-debugging-port=' + PORT_CDP,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900', '--headless=new', 'about:blank'
  ], { stdio: 'ignore' });
}

async function waitCDP() {
  for (let i = 0; i < 100; i++) {
    try { const v = await httpJson('/json/version'); if (v && v.webSocketDebuggerUrl) return v; } catch (e) {}
    await sleep(200);
  }
  throw new Error('Edge CDP 未就绪');
}

async function findExtensionWorker() {
  for (let i = 0; i < 60; i++) {
    const list = await httpJson('/json/list');
    const sw = list.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url));
    if (sw) return sw;
    await sleep(250);
  }
  return null;
}

function baseConfig() {
  return {
    version: 1,
    enabled: true,
    keepAlive: { enabled: true, blockAutoPause: true, volumeSilent: true, mirrorIfNoAudio: true, rate: 1 },
    player: { autoPlay: false, resumeAfterPause: true, finishGraceMs: 1500 },
    videoQuiz: { enabled: true, mode: 'ai-first', autoContinue: true, maxAiRounds: 3, bruteMaxTries: 6, submitWaitMs: 300 },
    nav: { autoNext: true, nextDelayMs: 500, unlockWaitMs: 1000, maxStuckReloads: 2, skipEmptyPage: true, stopAtCourseEnd: true },
    exam: { enabled: true, mode: 'ai-first', passScore: 60, maxRounds: 5, wrongOnlyRetry: true, randomDelayMs: 30, submitConfirm: true, allowRealExam: false },
    ai: {
      provider: 'custom', baseUrl: BASE + '/mock/v1', apiKey: 'test-key', model: 'mock-model',
      temperature: 0.2, maxTokens: 1200, timeoutMs: 20000, jsonMode: true, extraHeaders: '', systemPrompt: ''
    },
    ui: { hud: true, hudPosition: { right: 10, bottom: 10 }, logLevel: 'debug' }
  };
}

async function configure(swWsUrl, patch) {
  const cdp = new CDP(swWsUrl);
  await cdp.opened();
  const cfg = baseConfig();
  if (patch) for (const k of Object.keys(patch)) cfg[k] = Object.assign({}, cfg[k], patch[k]);
  await cdp.eval('chrome.storage.local.set({cxConfig: ' + JSON.stringify(cfg) + '}).then(()=>1)', true);
  const ok = await cdp.eval('chrome.storage.local.get(["cxConfig"]).then(r=>!!r.cxConfig)', true);
  return { cdp, ok };
}

async function dumpLogs(swWsUrl) {
  try {
    const cdp = new CDP(swWsUrl);
    await cdp.opened();
    const logs = await cdp.eval('chrome.storage.session.get(["cxLogs"]).then(r=>JSON.stringify(r.cxLogs||[]))', true);
    cdp.close();
    return JSON.parse(logs || '[]');
  } catch (e) { return []; }
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  OK  ' : '  FAIL') + ' ' + name + (detail ? '  -> ' + detail : ''));
}

/* ---------------- 用例 ---------------- */
async function testUI(extId) {
  console.log('\n[用例] 配置页 / 弹窗页加载无异常');
  for (const page of ['options.html', 'popup.html']) {
    const t = await newTarget('chrome-extension://' + extId + '/' + page);
    const cdp = new CDP(t.webSocketDebuggerUrl);
    await cdp.opened();
    await cdp.send('Runtime.enable');
    const errs = [];
    cdp.ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails.text));
      } catch (e) {}
    });
    await sleep(2500);
    const info = await cdp.eval('JSON.stringify({title: document.title, fields: document.querySelectorAll("[data-path]").length, body: document.body.innerText.length})');
    const parsed = JSON.parse(info || '{}');
    check(page + ' 正常渲染', parsed.body > 50 && parsed.title.length > 0, JSON.stringify(parsed));
    check(page + ' 无 JS 异常', errs.length === 0, errs.join('; ').slice(0, 160));
    if (page === 'options.html') check('设置页字段齐全', parsed.fields >= 25, 'fields=' + parsed.fields);
    cdp.close();
  }
}

async function testAntipause() {
  console.log('\n[用例] 主世界防暂停（伪造可见性 / 拦 mouseout / 丢 videojs_id）');
  const t = await newTarget(BASE + '/nav.html?u=/mycourse/studentstudy&chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  await sleep(1500);
  const raw = await cdp.eval(`(function(){
    var r = { active: !!window.__CX_ANTIPAUSE_ACTIVE__, hidden: document.hidden, visibility: document.visibilityState };
    var fired = false;
    var fn = function(){ fired = true; };
    window.addEventListener('mouseout', fn);
    window.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    r.mouseoutBlocked = !fired;
    window.removeEventListener('mouseout', fn);
    try {
      document.cookie = 'videojs_id=probe123; path=/';
      r.cookieValue = document.cookie;
      r.cookieBlocked = !/(^|;\\\\s*)videojs_id=/.test(document.cookie);
    } catch (e) { r.cookieBlocked = 'err'; }
    return JSON.stringify(r);
  })()`);
  const r = JSON.parse(raw || '{}');
  check('主世界脚本已注入', r.active === true, JSON.stringify({ active: r.active, hidden: r.hidden }));
  check('document.hidden 被伪造', r.hidden === false, 'hidden=' + r.hidden + ' visibility=' + r.visibility);
  check('mouseout 监听被拦掉', r.mouseoutBlocked === true, 'blocked=' + r.mouseoutBlocked);
  check('videojs_id 写入被丢弃', r.cookieBlocked === true, 'cookie=' + String(r.cookieValue || '').slice(0, 30));
  cdp.close();
}

async function testExam(swWsUrl) {
  console.log('\n[用例] 学习检测（input 版）：作答 -> 未通过 -> 错题重问 -> 通过');
  const t = await newTarget(BASE + '/exam.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await sleep(1000);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.passed) break;
  }
  const sel = report.selections || {};
  check('页面被识别并作答', report.submissions >= 1, 'submissions=' + report.submissions);
  check('首轮未通过触发重做', report.redoAttempts >= 1, 'redo=' + report.redoAttempts);
  check('多轮后最终通过', report.passed === true, 'scores=' + JSON.stringify(report.scores));
  check('多选题作答为 A/B/D', JSON.stringify(sel.q1) === JSON.stringify(['A', 'B', 'D']), JSON.stringify(sel.q1));
  check('判断题作答为 A', JSON.stringify(sel.q3) === JSON.stringify(['A']), JSON.stringify(sel.q3));
  /* 2026-10-31 回归：判分后重做只改「没做对」的题，判对的题不该被重掷。
   * 旧代码是整卷重问并把全卷当错，实测会把 2 勾 + 1 半 改剩 3 错。 */
  let onlyLog = null;
  try {
    const logs = await dumpLogs(swWsUrl);
    onlyLog = logs.filter(function (l) { return /本轮只改 \d+ 题/.test(String(l.text || '')); }).pop() || null;
  } catch (e) {}
  check('判分后只重做没做对的题', !!(onlyLog && /本轮只改 3 题/.test(onlyLog.text)), onlyLog ? onlyLog.text : '没有找到「本轮只改 N 题」日志');
  cdp.close();
}

async function testExamLi() {
  console.log('\n[用例] 新版做题页（li 选项、无 input）');
  const t = await newTarget(BASE + '/exam-li.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await sleep(1000);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.passed) break;
  }
  const sel = report.selections || {};
  check('li 结构题目被解析并作答', report.submissions >= 1, 'submissions=' + report.submissions);
  check('单选选到 A', JSON.stringify(sel.q0) === JSON.stringify(['A']), JSON.stringify(sel.q0));
  check('单选选到 C', JSON.stringify(sel.q1) === JSON.stringify(['C']), JSON.stringify(sel.q1));
  check('多选选到 A/B/D', JSON.stringify(sel.q2) === JSON.stringify(['A', 'B', 'D']), JSON.stringify(sel.q2));
  check('最终判分通过', report.passed === true, 'scores=' + JSON.stringify(report.scores));
  cdp.close();
}

async function testVideoQuiz() {
  console.log('\n[用例] 视频弹题：多选 -> 答错重问 -> 答对 -> 继续学习');
  const t = await newTarget(BASE + '/video-quiz.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(800);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.continued) break;
  }
  check('弹题已作答', report.submits >= 1, 'submits=' + report.submits);
  check('首答错误后重问', report.wrongs >= 1, 'wrongs=' + report.wrongs);
  check('最终答对', report.rights >= 1, 'rights=' + report.rights);
  check('点击了继续学习', report.continued === true);
  cdp.close();
}

async function testNav() {
  console.log('\n[用例] 任务点全部完成 -> 通过目录切下一章（不点按钮）');
  const t = await newTarget(BASE + '/nav.html?u=/mycourse/studentstudy&chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await sleep(700);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.clicks > 0) break;
  }
  check('通过目录切到下一章', report && report.tocClicks >= 1, 'tocClicks=' + (report && report.tocClicks) + ' target=' + (report && report.target));
  check('没有点「下一节」按钮', report && report.buttonClicks === 0, 'buttonClicks=' + (report && report.buttonClicks));
  await sleep(3000);
  const again = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}');
  check('没有重复连点', again.clicks <= 2, 'clicks=' + again.clicks);
  cdp.close();
}

async function testQuizEntry(swWsUrl) {
  console.log('\n[用例] 视频任务点已完成 -> 先点任务条里的「学习测验」');
  await configure(swWsUrl, { player: { autoPlay: false }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1 } });
  const t = await newTarget(BASE + '/knowledge/cards-quiz.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    await sleep(500);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.quizClicks > 0) break;
  }
  check('点击了任务条里的学习测验', report && report.quizClicks >= 1, 'quizClicks=' + (report && report.quizClicks));
  check('没有直接跳到下一节', report && report.nextClicks === 0, 'nextClicks=' + (report && report.nextClicks));
  cdp.close();
}

async function testPlayingGuard(swWsUrl) {
  console.log('\n[用例] 任务点未完成 + 视频在播 -> 不跳下一节');
  await configure(swWsUrl, { player: { autoPlay: true }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1 } });
  const t = await newTarget(BASE + '/knowledge/cards.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 14000) {
    await sleep(600);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
  }
  check('未完成的视频播放期间没有点下一节', report && report.clicks === 0, 'clicks=' + (report && report.clicks));
  cdp.close();
}

async function testDoneJumps(swWsUrl) {
  console.log('\n[用例] 任务点已完成 + 视频仍在播 -> 正常跳下一节');
  await configure(swWsUrl, { player: { autoPlay: true }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1 } });
  const t = await newTarget(BASE + '/knowledge/cards-done.html?chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    await sleep(600);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.clicks > 0) break;
  }
  check('任务点标记完成后触发切章', report && report.tocClicks >= 1, 'tocClicks=' + (report && report.tocClicks));
  check('切章时视频还在播', report && report.playingAtClick === true, 'playingAtClick=' + (report && report.playingAtClick));
  check('切章没有点「下一节」按钮', report && report.buttonClicks === 0, 'buttonClicks=' + (report && report.buttonClicks));
  cdp.close();
  await configure(swWsUrl, { player: { autoPlay: false }, nav: { skipEmptyPage: true, nextDelayMs: 500 } });
}

async function testReviewPage(swWsUrl) {
  console.log('\n[用例] 已批阅页（100 分）-> 判定通过 -> 通知导航点下一节');
  await configure(swWsUrl, { player: { autoPlay: false }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1 } });
  const t = await newTarget(BASE + '/knowledge/review.html?chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(600);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.tocClicks > 0) break;
  }
  check('批阅页被判定通过并切章', report && report.tocClicks >= 1, 'tocClicks=' + (report && report.tocClicks));
  check('批阅页切章也没点按钮', report && report.buttonClicks === 0, 'buttonClicks=' + (report && report.buttonClicks));
  cdp.close();
}

async function testTocNav(swWsUrl) {
  console.log('\n[用例] 通过右侧目录切下一章（不用「下一节」按钮）');
  await configure(swWsUrl, { player: { autoPlay: false }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1, useToc: true } });
  const t = await newTarget(BASE + '/knowledge/toc.html?chapterId=1207354213');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(500);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.tocClicks > 0) break;
  }
  check('点击了目录里的下一章', report && report.tocClicks >= 1, 'tocClicks=' + (report && report.tocClicks));
  check('点的是下一章 1.2.2', report && /1\.2\.2/.test(report.tocTarget || ''), 'target=' + (report && report.tocTarget));
  check('没有去点「下一节」', report && report.nextClicks === 0, 'nextClicks=' + (report && report.nextClicks));
  cdp.close();
}

async function testFont() {
  console.log('\n[用例] 字形字典表加载 + 字体管线早退（data/ 在 WAR 放宽后可取）');
  const t = await newTarget(BASE + '/font-quiz.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  await sleep(2500);

  /* ① 字形逆查表：必须真加载出来（回归 2026-10-31 的 P0：SW 消息把 ArrayBuffer JSON 化 → 表永远加载失败）
   * 先把 SW 唤醒并等它应答一次：否则 SW 睡着时 sendMessage 直接抛错，
   * 旧代码也会"碰巧"走到 fetch 兜底，测不出这个 bug。 */
  try {
    await cdp.evalIso(`chrome.runtime.sendMessage({ kind: 'status', text: 'warm-up', busy: false }).catch(function () { return 'warm'; })`);
  } catch (e) {}
  await sleep(500);

  let st = null;
  try {
    st = await cdp.evalIso(`(CX && CX.glyphMatch)
      ? CX.glyphMatch.ensure().then(function () { return CX.glyphMatch.stats(); })
      : { ready: false, err: 'CX.glyphMatch 不存在' }`);
  } catch (e) { st = { ready: false, err: String(e && e.message) }; }
  check('字形逆查表已加载', !!(st && st.ready === true), JSON.stringify(st));
  check('字形表条目数 = 20945', !!(st && st.n === 20945), 'n=' + (st && st.n));
  /* 关键：表必须是"有内容"的。旧代码在 SW 回传被 JSON 化后建出全零表却 ready=true，光看 ready/n 抓不到。 */
  check('字形表内容非全零', !!(st && st.nz > 1000), 'nz=' + (st && st.nz) + ' src=' + (st && st.src));
  check('表来源是 data/（而不是被 JSON 化的 SW 回传）', !!(st && st.src === 'fetch'), 'src=' + (st && st.src));

  /* ② 页面只有密文、没有可用 @font-face：fontdecrypt 应当早退，而不是硬跑一轮打「字典 0 + 逆查 0」 */
  let fd = null;
  try {
    fd = await cdp.evalIso(`CX.fontDecrypt.ensure().then(function () {
      return CX.fontDecrypt.stats();
    }).catch(function (e) { return { err: String(e && e.message) }; })`);
  } catch (e) { fd = { err: String(e && e.message) }; }
  check('字体管线不抛错', !!(fd && !fd.err), JSON.stringify(fd && fd.err));
  check('拿不到字体时标注"字体未加载"', !!(fd && /字体未加载/.test(String(fd.note || ''))), 'note=' + (fd && fd.note));

  /* ③ 没有字体时不该动 DOM、也不该留下任何"已还原"的假象 */
  const pua = await cdp.eval(`(function () {
    var el = document.querySelector('.font-cxsecret');
    var t = el ? String(el.textContent || '') : '';
    return { sample: t.slice(0, 12), stillCipher: t.indexOf('学习通字体加密') >= 0 };
  })()`);
  check('页面文本保持原样（无字体时不误改）', !!(pua && pua.stillCipher === true), JSON.stringify(pua));
  check('没有产生映射条目', !!(fd && fd.mapped === 0), 'mapped=' + (fd && fd.mapped));
  cdp.close();
}

async function testCourseEnd(swWsUrl) {
  console.log('\n[用例] 课程最后一节：没有下一章也没有「下一节」按钮 → 自动停止');
  const { cdp: swCdp } = await configure(swWsUrl, { nav: { tocOnly: true, useToc: true, stopAtCourseEnd: true, endConfirmMs: 1500 } });
  swCdp.close();
  const t = await newTarget(BASE + '/knowledge/cards-end.html?chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let state = null;
  let nudges = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    await sleep(1200);
    try { state = await cdp.evalIso(`({ stopped: !!(CX.nav && CX.nav.state && CX.nav.state.stopped), clicks: CX.nav ? CX.nav.state.clicks : -1 })`); } catch (e) { state = null; }
    if (state && state.stopped) break;
    /* 仿真页不像真站点那样自己触发巡检，这里手动踢两下让"末尾确认"走完 */
    if (nudges < 3) {
      nudges++;
      try { await cdp.evalIso(`CX.nav.clickNext('test')`); } catch (e) {}
    }
  }
  check('到末尾自动停止', !!(state && state.stopped === true), JSON.stringify(state));
  check('没有乱点下一节', !!(state && state.clicks === 0), 'clicks=' + (state && state.clicks));
  cdp.close();
  const back = await configure(swWsUrl, { nav: { endConfirmMs: 12000 } });
  back.cdp.close();
}
async function testGiveUp(swWsUrl) {
  console.log('\n[用例] 轮数用尽 → 按设置放弃本节（交给导航切章）');
  const { cdp: swCdp } = await configure(swWsUrl, { exam: { maxRounds: 1, giveUpToNext: true } });
  swCdp.close();
  const t = await newTarget(BASE + '/exam.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let state = null;
  let gaveUpLog = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(1000);
    try {
      state = await cdp.evalIso(`({ finished: !!(CX.exam && CX.exam.state && CX.exam.state.finished), gaveUp: !!(CX.exam && CX.exam.state && CX.exam.state.gaveUp) })`);
    } catch (e) { state = null; }
    if (state && state.gaveUp) break;
  }
  try {
    const logs = await dumpLogs(swWsUrl);
    gaveUpLog = logs.some(function (l) { return /已放弃本节测验|本节测验已按设置放弃/.test(String(l.text || '')); });
  } catch (e) {}
  check('轮数用尽后进入放弃状态', !!(state && state.gaveUp === true && state.finished === true), JSON.stringify(state));
  check('日志记录了"放弃本节"', gaveUpLog === true);
  cdp.close();
  /* 复原默认轮数，别影响后面的用例 */
  const back = await configure(swWsUrl, { exam: { maxRounds: 3 } });
  back.cdp.close();
}
async function testRetry() {
  console.log('\n[用例] 重做试探：半对只加、判错只减、判断翻转');
  const t = await newTarget(BASE + '/nav.html?u=/mycourse/studentstudy&chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  await sleep(2000);
  const r = await cdp.evalIso(`(function () {
    var f = CX.exam && CX.exam._nextRetryAnswer;
    if (!f) return { err: 'no _nextRetryAnswer' };
    var multi = { type: 'multi', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] };
    var judge = { type: 'judge', options: [{ label: 'A' }, { label: 'B' }] };
    var single4 = { type: 'single', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] };
    var K = CX.exam._keyOf;
    var out = {};
    out.half1 = f(multi, ['A', 'C'], [K(['A', 'C'])], 'half');
    out.half2 = f(multi, ['A', 'C'], [K(['A', 'C']), K(['A', 'B', 'C'])], 'half');
    out.half3 = f(multi, ['A', 'C'], [K(['A', 'C']), K(['A', 'B', 'C']), K(['A', 'C', 'D'])], 'half');
    out.half4 = f(multi, ['A', 'C'], [K(['A', 'C']), K(['A', 'B', 'C']), K(['A', 'C', 'D']), K(['A', 'B', 'C', 'D'])], 'half');
    out.wrong1 = f(multi, ['A', 'B', 'D'], [K(['A', 'B', 'D'])], 'wrong');
    out.judge = f(judge, ['B'], [K(['B'])], 'wrong');
    out.single4 = f(single4, ['B'], [K(['B'])], 'wrong');
    return out;
  })()`);
  check('半对：先只加一个（ABC）', JSON.stringify(r && r.half1) === '["A","B","C"]', JSON.stringify(r && r.half1));
  check('半对：第二次换 ACD', JSON.stringify(r && r.half2) === '["A","C","D"]', JSON.stringify(r && r.half2));
  check('半对：第三次才全选', JSON.stringify(r && r.half3) === '["A","B","C","D"]', JSON.stringify(r && r.half3));
  check('半对：组合用尽 → 交回 AI', JSON.stringify(r && r.half4) === 'null', JSON.stringify(r && r.half4));
  check('判错的多选：交给 AI（不瞎删）', JSON.stringify(r && r.wrong1) === 'null', JSON.stringify(r && r.wrong1));
  check('判断题：直接翻转', JSON.stringify(r && r.judge) === '["A"]', JSON.stringify(r && r.judge));
  check('四选项单选：交给 AI', JSON.stringify(r && r.single4) === 'null', JSON.stringify(r && r.single4));
  cdp.close();
}
async function testEmptyPage(swWsUrl) {
  console.log('\n[用例] 无任务点页面（老脚本语义）→ 静默 2 秒后切下一章');
  await configure(swWsUrl, { player: { autoPlay: false }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1 } });
  const t = await newTarget(BASE + '/knowledge/cards-empty.html?chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(500);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.tocClicks > 0) break;
  }
  check('无任务点页面通过目录切章', report && report.tocClicks >= 1, 'tocClicks=' + (report && report.tocClicks));
  check('切章没有点按钮', report && report.buttonClicks === 0, 'buttonClicks=' + (report && report.buttonClicks));
  cdp.close();
}

async function testEmptyOptIn(swWsUrl) {
  console.log('\n[用例] 打开 advanceWhenNoTask 才允许跳过无任务点页面');
  await configure(swWsUrl, { player: { autoPlay: false }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1, advanceWhenNoTask: true } });
  const t = await newTarget(BASE + '/knowledge/cards-empty.html?chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(500);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.tocClicks > 0) break;
  }
  check('开关打开后通过目录切章', report && report.tocClicks >= 1, 'tocClicks=' + (report && report.tocClicks));
  check('切章没有点按钮', report && report.buttonClicks === 0, 'buttonClicks=' + (report && report.buttonClicks));
  cdp.close();
}

async function testEmptyButPlaying(swWsUrl) {
  console.log('\n[用例] 本帧看着是空页但别的帧在播视频 -> 不能跳');
  await configure(swWsUrl, { player: { autoPlay: true }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1 } });
  const t = await newTarget(BASE + '/knowledge/cards-empty-video.html?chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 14000) {
    await sleep(500);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
  }
  check('视频还在播时不误判成空页', report && report.clicks === 0, 'clicks=' + (report && report.clicks));
  cdp.close();
}

async function testTocChild(swWsUrl) {
  console.log('\n[用例] 目录深度优先：先进小标题（4.2 → 4.2.1）');
  await configure(swWsUrl, { player: { autoPlay: false }, nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1, useToc: true, tocOnly: true } });
  const t = await newTarget(BASE + '/knowledge/toc-child.html?chapterId=1207354213');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(500);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.tocClicks > 0) break;
  }
  check('点了目录里的下一项', report && report.tocClicks >= 1, 'tocClicks=' + (report && report.tocClicks));
  check('优先进入小标题（4.2.1）', report && /4\.2\.1/.test(report.target || ''), 'target=' + (report && report.target));
  check('没有跨到同级下一章', report && !/4\.3/.test(report.target || ''), 'target=' + (report && report.target));
  cdp.close();
}

async function testHud() {
  console.log('\n[用例] 浮窗是否成功挂载（含异常捕获）');
  const t = await newTarget(BASE + '/nav.html?u=/mycourse/studentstudy&chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  const errs = [];
  cdp.ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push((d.exception && d.exception.description || d.text || '').slice(0, 200));
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        const txt = String(m.params.entry.text || '');
        /* 只管脚本错误：favicon 之类的资源 404 也会以 error 级别出现，不算"脚本异常" */
        if (!/Failed to load resource/i.test(txt)) errs.push(txt.slice(0, 200));
      }
    } catch (e) {}
  });
  await sleep(4000);
  const info = JSON.parse(await cdp.eval(`(function(){
    var h = document.getElementById('__cx_hud_host');
    var sr = h && h.shadowRoot;
    var probe = document.getElementById('cx-probe-0');
    return JSON.stringify({
      host: !!h,
      shadow: !!(sr && sr.innerHTML.length > 100),
      btns: sr ? sr.querySelectorAll('button').length : 0,
      probeLen: probe ? (probe.textContent || '').length : -1,
      probeHead: probe ? (probe.textContent || '').slice(0, 120) : ''
    });
  })()`));
  check('浮窗宿主已挂载', info.host === true, JSON.stringify(info));
  check('浮窗内容渲染成功', info.shadow === true && info.btns >= 4, 'btns=' + info.btns);
  check('探针有内容', info.probeLen > 50, 'len=' + info.probeLen + ' ' + info.probeHead);
  if (errs.length) console.log('  页面异常: ' + errs.slice(0, 3).join(' || '));
  check('页面无脚本异常', errs.length === 0, errs.slice(0, 2).join(' || '));
  cdp.close();
}

(async function main() {
  if (!EDGE) throw new Error('未找到 msedge.exe');
  await waitServer();
  console.log('启动 Edge（headless）…');
  let child = launchEdge();
  let sw = null;
  try {
    await waitCDP();
    sw = await findExtensionWorker();
    if (!sw) {
      console.log('headless 下未加载扩展，改用有头模式重试…');
      try { child.kill(); } catch (e) {}
      await sleep(1500);
      fs.rmSync(PROFILE, { recursive: true, force: true });
      child = spawn(EDGE, [
        '--user-data-dir=' + PROFILE,
        '--load-extension=' + BUILD,
        '--disable-extensions-except=' + BUILD,
        '--remote-debugging-port=' + PORT_CDP,
        '--no-first-run', '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--window-position=-2600,-2600', '--window-size=1280,900', 'about:blank'
      ], { stdio: 'ignore' });
      await waitCDP();
      sw = await findExtensionWorker();
    }
    if (!sw) throw new Error('扩展未加载：找不到 service worker');
    console.log('扩展已加载:', sw.url.split('/')[2]);

    const { cdp, ok } = await configure(sw.webSocketDebuggerUrl);
    check('配置写入扩展存储', ok === true);
    cdp.close();

    const id = sw.url.split('/')[2];
    if (which === 'all' || which === 'ui') await testUI(id);
    if (which === 'all' || which === 'hud') await testHud();
    if (which === 'all' || which === 'antipause') await testAntipause();
    if (which === 'all' || which === 'exam') await testExam(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'exam-li') await testExamLi();
    if (which === 'all' || which === 'video-quiz') await testVideoQuiz();
    if (which === 'all' || which === 'nav') await testNav();
    if (which === 'all' || which === 'quiz-entry') await testQuizEntry(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'guard') await testPlayingGuard(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'done') await testDoneJumps(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'review') await testReviewPage(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'toc') await testTocNav(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'toc-child') await testTocChild(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'empty') await testEmptyPage(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'empty-optin') await testEmptyOptIn(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'empty-guard') await testEmptyButPlaying(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'font') await testFont();
    if (which === 'all' || which === 'retry') await testRetry();
    if (which === 'all' || which === 'giveup') await testGiveUp(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'end') await testCourseEnd(sw.webSocketDebuggerUrl);

    const logs = await dumpLogs(sw.webSocketDebuggerUrl);
    console.log('\n--- 扩展日志（最近 20 条）---');
    logs.slice(-20).forEach((l) => console.log(' [' + String(l.level).toUpperCase() + '][' + (l.scope || '') + '] ' + l.text));

    const failed = results.filter((r) => !r.ok);
    console.log('\n===== 结果 =====');
    results.forEach((r) => console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  (' + r.detail + ')' : '')));
    console.log(failed.length ? '\n失败 ' + failed.length + ' 项' : '\n全部通过');
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(300);
    try { execSync('taskkill /F /T /PID ' + child.pid, { stdio: 'ignore' }); } catch (e) {}
  }
})().catch((e) => {
  console.error('测试异常:', e.message);
  process.exitCode = 2;
});
