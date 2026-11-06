/* CDP 驱动的端到端测试：真 Edge + 真扩展 + 本地仿真页面 + Mock AI
 * 用法: node tools/run-test.mjs [all|ui|hud|antipause|exam|exam-li|video-quiz|nav|quiz-entry|guard|done|review|toc|toc-child|toc-locked|toc-done|toc-yellow0|toc-none|skip-exam|empty|empty-optin|empty-guard|font|retry|giveup|end|scope|shell]
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
    if (page === 'options.html') {
      /* 2026-11-03：初次安装（空存储）时「调试」卡里的开关必须全是关的；其它默认值不动 */
      const d = JSON.parse(await cdp.eval(`JSON.stringify({
        samples: CXConfig.DEFAULTS.samples.enabled,
        autoReload: CXConfig.DEFAULTS.dev.autoReload,
        cmdBridge: CXConfig.DEFAULTS.dev.cmdBridge,
        examMode: CXConfig.DEFAULTS.exam.mode,
        aiOn: CXConfig.DEFAULTS.ai.enabled,
        ver: CXConfig.DEFAULTS.version,
        logLevel: CXConfig.DEFAULTS.ui.logLevel
      })`) || '{}');
      check('调试卡开关默认全关（初次安装）', d.samples === false && d.autoReload === false && d.cmdBridge === false, JSON.stringify(d));
      check('学习检测默认 AI 优先、AI 总开关默认开', d.examMode === 'ai-first' && d.aiOn === true, JSON.stringify({ mode: d.examMode, ai: d.aiOn }));
      check('配置版本 5、日志级别仍 info', d.ver === 5 && d.logLevel === 'info', 'v=' + d.ver + ' lv=' + d.logLevel);
    }
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

  /* ④ 2026-11-03：调试卡开关默认关 —— 空/旧配置下采集器应当是关的
   *（以前 fontsampler 用 `enabled !== false` 判断，缺键时会当成开） */
  let sampler = null;
  try {
    sampler = await cdp.evalIso('(CX.samples && CX.samples.state) ? { enabled: !!CX.samples.state().enabled } : null');
  } catch (e) { sampler = { err: String(e && e.message) }; }
  check('字体样本采集器默认关', !!(sampler && sampler.enabled === false), JSON.stringify(sampler));

  /* 2026-11-03：采集器面板越界自愈（跟常态浮窗一致；这里直接改它的位置状态验证） */
  try {
    await cdp.evalIso('(function () { var s = CX.samples.state(); s.pos = { left: 99999, top: 99999 }; return true; })()');
  } catch (e) {}
  await sleep(3600);
  let posFix = null;
  try { posFix = await cdp.evalIso('(function () { var s = CX.samples.state(); return { pos: s.pos, corner: s.corner }; })()'); } catch (e) { posFix = { err: String(e && e.message) }; }
  check('采集器位置越界后自动复位', !!(posFix && posFix.pos === null), JSON.stringify(posFix));
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
async function testScope() {
  console.log('\n[用例] 非学习页（个人空间）：不挂浮窗、不跑自动化');
  const t = await newTarget(BASE + '/space.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  await sleep(4500);   /* 覆盖 mount 的 0 / 1.2s / 2.6s 三次机会 */
  const r = await cdp.evalIso(`({
    hud: !!document.getElementById('__cx_hud_host'),
    hudCount: document.querySelectorAll('#__cx_hud_host').length,
    pageKind: (CX.pageKind || ''),
    studyContext: CX.isStudyContext ? !!CX.isStudyContext() : null,
    navClicks: (CX.nav && CX.nav.state) ? CX.nav.state.clicks : -1
  })`);
  check('识别为非学习页', !!(r && (r.pageKind === 'space' || r.pageKind === 'other') && r.studyContext === false), JSON.stringify(r));
  check('没有浮窗宿主节点', r && r.hud === false && r.hudCount === 0, 'hud=' + (r && r.hud) + ' count=' + (r && r.hudCount));
  check('导航没有动作', r && r.navClicks === 0, 'clicks=' + (r && r.navClicks));
  cdp.close();
}
async function testShell() {
  console.log('\n[用例] 课程外壳页（只有目录）：不挂浮窗');
  const t = await newTarget(BASE + '/mycourse-shell.html');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  await sleep(4500);
  const r = await cdp.evalIso(`({
    hud: !!document.getElementById('__cx_hud_host'),
    hudCount: document.querySelectorAll('#__cx_hud_host').length,
    pageKind: (CX.pageKind || ''),
    studyContext: CX.isStudyContext ? !!CX.isStudyContext() : null,
    hasDom: CX.hasStudyDom ? !!CX.hasStudyDom() : null
  })`);
  check('外壳页不算学习页', !!(r && r.studyContext === false), JSON.stringify(r));
  check('外壳页没有浮窗', !!(r && r.hud === false && r.hudCount === 0), 'hud=' + (r && r.hud));
  cdp.close();
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

/* 2026-11-03：目录标记智能跳章 —— 仿真页按真机 HTML 造
 * （.icon_Completed / .catalog_points_yi + .orangeNew / .catalog_points_sa，locked 行 name 不带 onclick） */
async function tocPickRun(swWsUrl, o) {
  console.log('\n[用例] ' + o.title);
  await configure(swWsUrl, {
    player: { autoPlay: false },
    nav: {
      skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1,
      useToc: true, tocOnly: true, skipLockedToc: true,
      endConfirmMs: o.endConfirmMs || 12000
    }
  });
  const t = await newTarget(BASE + '/knowledge/' + o.fixture + '?chapterId=' + (o.chapterId || '1207354213'));
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    await sleep(600);
    try { report = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
    if (o.expectStop) {
      let stopped = false;
      try { stopped = await cdp.evalIso('!!(CX.nav && CX.nav.state && CX.nav.state.stopped)'); } catch (e) {}
      if (stopped) break;
    } else if (report && report.tocClicks > 0) break;
  }
  let iso = null;
  try {
    iso = await cdp.evalIso(`(function () {
      var s = CX.nav.state, p = s.tocPlan;
      return {
        stopped: !!s.stopped, stopReason: s.stopReason || '', clicked: s.clicks,
        plan: p ? { target: p.target || null, blockedAll: !!p.blockedAll, skipped: (p.skipped || []).map(function (x) { return x.state; }) } : null
      };
    })()`);
  } catch (e) { iso = { err: String(e && e.message) }; }
  let stopLog = null;
  try {
    const logs = await dumpLogs(swWsUrl);
    stopLog = logs.filter(function (l) { return /后面没有可继续的章节|后面没有可做的章节/.test(String(l.text || '')); }).pop() || null;
  } catch (e) {}
  cdp.close();
  return { report: report || {}, iso: iso || {}, stopLog: stopLog };
}

async function testTocLocked(swWsUrl) {
  const r = await tocPickRun(swWsUrl, { title: '目录：下一项未解锁 → 跳到后面有任务点的一节', fixture: 'toc-locked.html' });
  check('目标是有任务点的 1.2.3', r.report.targetId === '1207354477' && /1\.2\.3/.test(String(r.report.target)), 'target=' + r.report.target + ' id=' + r.report.targetId);
  check('没有点未解锁的 1.2.2', r.report.lockedClicks === 0, 'lockedClicks=' + r.report.lockedClicks);
  check('只点了一次目录', r.report.tocClicks === 1, 'tocClicks=' + r.report.tocClicks);
  check('扫描记账里有未解锁项', !!(r.iso.plan && (r.iso.plan.skipped || []).indexOf('locked') >= 0), JSON.stringify(r.iso.plan));
}

async function testTocDone(swWsUrl) {
  const r = await tocPickRun(swWsUrl, { title: '目录：下一项已完成 → 跳过它去有任务点的一节', fixture: 'toc-skip-done.html' });
  check('跳过已完成的 2.2.2', r.report.targetId === '1207354477' && /2\.2\.3/.test(String(r.report.target)), 'target=' + r.report.target + ' id=' + r.report.targetId);
  check('只点了一次目录', r.report.tocClicks === 1, 'tocClicks=' + r.report.tocClicks);
}

async function testTocYellow0(swWsUrl) {
  const r = await tocPickRun(swWsUrl, { title: '目录：黄圈是 0 也算没完成 → 先点它', fixture: 'toc-yellow0.html' });
  check('先点黄圈 0 的 2.5.2', r.report.targetId === '1207354288' && /2\.5\.2/.test(String(r.report.target)), 'target=' + r.report.target + ' id=' + r.report.targetId);
  check('没有跳到后面的 2.5.3', !/2\.5\.3/.test(String(r.report.target)), 'target=' + r.report.target);
  check('只点了一次目录', r.report.tocClicks === 1, 'tocClicks=' + r.report.tocClicks);
}

async function testTocNone(swWsUrl) {
  const r = await tocPickRun(swWsUrl, { title: '目录后面只剩已完成/未解锁 → 停止', fixture: 'toc-none.html', expectStop: true, endConfirmMs: 1500 });
  check('后面没得跳 → 停止', r.iso.stopped === true, JSON.stringify(r.iso));
  check('停止原因 = no-target', r.iso.stopReason === 'no-target', 'stopReason=' + r.iso.stopReason);
  check('一次目录都没点', (r.report.tocClicks || 0) === 0, 'tocClicks=' + r.report.tocClicks);
  check('没去点「下一节」按钮', (r.report.buttonClicks || 0) === 0, 'buttonClicks=' + r.report.buttonClicks);
  check('日志写明「后面没有可继续的章节」', !!r.stopLog, r.stopLog ? r.stopLog.text : '没有找到相关日志');
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

async function testSkipExam(swWsUrl) {
  console.log('\n[用例] 跳过学习检测：进测验页但不作答 → 导航切下一章');
  await configure(swWsUrl, {
    player: { autoPlay: false },
    exam: { mode: 'skip' },
    nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1 }
  });
  const t = await newTarget(BASE + '/exam-skip.html?chapterId=1207354213');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  let report = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    await sleep(700);
    try { report = JSON.parse(await cdp.eval('document.getElementById("toc-report").textContent') || '{}'); } catch (e) { continue; }
    if (report && report.tocClicks > 0) break;
  }
  let iso = null;
  try {
    iso = await cdp.evalIso('({ skipped: !!(CX.exam && CX.exam.state && CX.exam.state.skipped), finished: !!(CX.exam && CX.exam.state && CX.exam.state.finished) })');
  } catch (e) { iso = { err: String(e && e.message) }; }
  const examReport = JSON.parse(await cdp.eval('document.getElementById("test-report").textContent') || '{}');
  let skipLog = null;
  try {
    const logs = await dumpLogs(swWsUrl);
    skipLog = logs.filter(function (l) { return /跳过学习检测/.test(String(l.text || '')); }).pop() || null;
  } catch (e) {}
  check('没有作答、没有提交', (examReport.submissions || 0) === 0, 'submissions=' + examReport.submissions);
  check('exam 进入「跳过」状态', !!(iso && iso.skipped === true && iso.finished === true), JSON.stringify(iso));
  check('导航切到下一章', !!(report && report.tocClicks >= 1) && /2\.8\.2/.test(String(report.target || '')),
    'target=' + (report && report.target) + ' clicks=' + (report && report.tocClicks));
  check('切章没有点「下一节」按钮', !!(report && report.buttonClicks === 0), 'buttonClicks=' + (report && report.buttonClicks));
  check('日志记录了「跳过学习检测」', !!skipLog, skipLog ? skipLog.text : '没有找到相关日志');
  cdp.close();

  /* 2026-11-04：关掉「学习检测自动处理」→ 导航连测验入口都不点（以前会点开然后卡住）。
   * 用 cards-quiz.html：它记录了 quizClicks，正常情况下插件会点它一次。 */
  await configure(swWsUrl, {
    player: { autoPlay: false },
    exam: { enabled: false, mode: 'ai-first' },
    nav: { skipEmptyPage: true, nextDelayMs: 300, maxStuckReloads: 1 }
  });
  const t2 = await newTarget(BASE + '/knowledge/cards-quiz.html');
  const cdp2 = new CDP(t2.webSocketDebuggerUrl);
  await cdp2.opened();
  await cdp2.send('Runtime.enable');
  let r2 = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 12000) {
    await sleep(600);
    try { r2 = JSON.parse(await cdp2.eval('document.getElementById("test-report").textContent') || '{}'); } catch (e) { continue; }
  }
  check('关掉学习检测后不点测验入口', !!(r2 && r2.quizClicks === 0), 'quizClicks=' + (r2 && r2.quizClicks));
  cdp2.close();
  const back = await configure(swWsUrl, { exam: { mode: 'ai-first', enabled: true }, ai: { enabled: true } });
  back.cdp.close();
}

async function testQText() {
  console.log('\n[用例] 题目原文：明文采集 / 复制格式 / 搜索链接 / 跳转描边');
  const t = await newTarget(BASE + '/exam.html?chapterId=1');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.opened();
  await cdp.send('Runtime.enable');
  await sleep(2500);
  let r = null;
  try {
    r = await cdp.evalIso(`CX.qtext.localCollect().then(function (r) {
      var first = r.items[0] || {};
      return {
        n: r.items.length,
        stem: first.stem || '',
        opt: (first.options && first.options[0] && first.options[0].text) || '',
        text: CX.qtext.copyText(r.items),
        url: CX.qtext.searchUrl('【单选题】我国的根本政治制度是（ ）'),
        clean: CX.qtext.cleanQuery('1【单选题】我国的根本政治制度是（ ）')
      };
    })`);
  } catch (e) { r = { err: String(e && e.message) }; }
  check('采集到多道题', !!(r && r.n >= 3), 'n=' + (r && r.n) + (r && r.err ? ' ' + r.err : ''));
  check('题干/选项是明文', !!(r && /我国的根本政治制度/.test(r.stem) && /人民代表大会制度/.test(r.opt)), (r && r.stem) + ' | ' + (r && r.opt));

  /* 2026-11-06：作答方式**不再**因 AI 总开关关闭而静默降级成 brute
   * （用户要求：选了「AI 优先」就该用 AI；AI 没开要提示/停手，不能偷偷换行为）。
   * 顺带校验 CX.aiModeConflict() 能把"AI 关了却选 AI 优先"这种矛盾报出来。 */
  let modes = null;
  try {
    modes = await cdp.evalIso(`({
      aiOff: CX.examMode({ ai: { enabled: false }, exam: { mode: 'ai-first' } }),
      aiOn: CX.examMode({ ai: { enabled: true }, exam: { mode: 'ai-first' } }),
      skip: CX.examMode({ exam: { mode: 'skip' } }),
      brute: CX.examMode({ exam: { mode: 'brute' } }),
      bad: CX.examMode({ exam: { mode: 'zzz' } }),
      conflictExam: CX.aiModeConflict({ ai: { enabled: false }, exam: { mode: 'ai-first' }, videoQuiz: { mode: 'brute' } }),
      conflictBoth: CX.aiModeConflict({ ai: { enabled: false }, exam: { mode: 'ai-first' }, videoQuiz: { mode: 'ai-first' } }),
      conflictNone: CX.aiModeConflict({ ai: { enabled: true }, exam: { mode: 'ai-first' }, videoQuiz: { mode: 'ai-first' } })
    })`);
  } catch (e) { modes = { err: String(e && e.message) }; }
  check('AI 关掉时「AI 优先」不再静默降级', !!(modes && modes.aiOff === 'ai-first' && modes.aiOn === 'ai-first' && modes.skip === 'skip' && modes.brute === 'brute' && modes.bad === 'ai-first'), JSON.stringify(modes));
  check('「AI 关了却选 AI 优先」会被识别成配置冲突', !!(modes && modes.conflictExam === '学习检测' && modes.conflictBoth === '学习检测与视频弹题' && modes.conflictNone === ''), JSON.stringify(modes));
  check('搜索链接按模板生成（去题号/题型/空括号）', !!(r && /^https:\/\/www\.baidu\.com\/s\?wd=/.test(r.url) && r.clean === '我国的根本政治制度是'), (r && r.url) + ' | clean=' + (r && r.clean));
  check('复制文本带序号与题型', !!(r && /^1【单选题】/.test(r.text) && /A、人民代表大会制度/.test(r.text)), String((r && r.text) || '').split('\n')[0]);

  /* 复制内容可选：只要题干 / 题干 + 选项（2026-11-03） */
  let scope = null;
  try {
    scope = await cdp.evalIso(`CX.qtext.localCollect().then(function (r) {
      var q = r.items[0];
      return { stem: CX.qtext.copyText([q], 'stem'), both: CX.qtext.copyText([q], 'both') };
    })`);
  } catch (e) { scope = { err: String(e && e.message) }; }
  check('「只要题干」不带选项', !!(scope && /我国的根本政治制度/.test(scope.stem) && !/A、/.test(scope.stem)), JSON.stringify(scope && scope.stem));
  check('「题干 + 选项」带选项', !!(scope && /A、人民代表大会制度/.test(scope.both)), String((scope && scope.both) || '').split('\n')[1]);

  /* 跳转：面板 → 后台 → 广播回本帧 → 给目标题目加描边 */
  try { await cdp.evalIso('CX.qtext.focusItem(2)'); } catch (e) {}
  let hit = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    await sleep(300);
    try { hit = await cdp.eval(`!!document.querySelector('[data-cx-qtext-hit]')`); } catch (e) { hit = false; }
    if (hit) break;
  }
  check('跳转让目标题目描边', hit === true, 'hit=' + hit);

  /* 描边必须真的是蓝的（2026-11-03 回归：!important 的 transparent 把动画颜色压掉，框看不见） */
  let look = null;
  try {
    look = await cdp.eval(`(function () {
      var el = document.querySelector('[data-cx-qtext-hit]');
      if (!el) return { err: 'no hit' };
      var s = getComputedStyle(el);
      return { color: s.outlineColor, width: s.outlineWidth, style: s.outlineStyle };
    })()`);
  } catch (e) { look = { err: String(e && e.message) }; }
  check('描边颜色是蓝的（不是透明）', !!(look && /37,\s*99,\s*235/.test(String(look.color)) && parseFloat(look.width) >= 2), JSON.stringify(look));

  /* 2026-11-03 用户报「跳转后蓝框不消失」：描边必须自己退场，连点两题也不能残留 */
  let gone = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 6000) {
    await sleep(300);
    try { gone = (await cdp.eval(`document.querySelectorAll('[data-cx-qtext-hit]').length`)) === 0; } catch (e) { gone = false; }
    if (gone) break;
  }
  check('描边 1.7 秒后自动消失', gone === true, 'gone=' + gone);

  try { await cdp.evalIso('CX.qtext.focusItem(0)'); } catch (e) {}
  await sleep(300);
  try { await cdp.evalIso('CX.qtext.focusItem(3)'); } catch (e) {}
  await sleep(500);
  let marked = -1;
  try { marked = await cdp.eval(`document.querySelectorAll('[data-cx-qtext-hit]').length`); } catch (e) {}
  check('连点跳转只保留一个描边', marked === 1, 'marked=' + marked);
  await sleep(2200);
  let left = -1;
  try { left = await cdp.eval(`document.querySelectorAll('[data-cx-qtext-hit]').length`); } catch (e) {}
  check('连点后描边也自动清掉', left === 0, 'left=' + left);

  /* 2026-11-03：面板越界自愈（跟常态浮窗一致） */
  try { await cdp.evalIso('CX.qtext.open()'); } catch (e) {}
  await sleep(800);
  let moved = null;
  try {
    moved = await cdp.eval(`(function () {
      var h = document.getElementById('__cx_qtext_host');
      var w = h && h.shadowRoot && h.shadowRoot.getElementById('wrap');
      if (!w) return { err: 'no panel' };
      w.style.left = '6000px'; w.style.top = '4000px'; w.style.right = 'auto'; w.style.bottom = 'auto';
      return { left: Math.round(w.getBoundingClientRect().left) };
    })()`);
  } catch (e) { moved = { err: String(e && e.message) }; }
  await sleep(3400);
  let fixed = null;
  try {
    fixed = await cdp.eval(`(function () {
      var h = document.getElementById('__cx_qtext_host');
      var w = h && h.shadowRoot && h.shadowRoot.getElementById('wrap');
      if (!w) return { err: 'no panel' };
      var r = w.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width),
               vw: window.innerWidth, vh: window.innerHeight,
               inside: r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 };
    })()`);
  } catch (e) { fixed = { err: String(e && e.message) }; }
  check('面板越界后自动复位', !!(fixed && fixed.inside === true), JSON.stringify({ moved: moved, fixed: fixed }));
  cdp.close();

  /* 无题目页：模块在，但采不到题目 */
  const t2 = await newTarget(BASE + '/space.html');
  const cdp2 = new CDP(t2.webSocketDebuggerUrl);
  await cdp2.opened();
  await cdp2.send('Runtime.enable');
  await sleep(1500);
  let n2 = -1;
  try { n2 = await cdp2.evalIso('CX.qtext.localCollect().then(function (r) { return r.items.length; })'); } catch (e) {}
  check('无题目页采集为空', n2 === 0, 'items=' + n2);
  cdp2.close();
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
    if (which === 'all' || which === 'toc-locked') await testTocLocked(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'toc-done') await testTocDone(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'toc-yellow0') await testTocYellow0(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'toc-none') await testTocNone(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'skip-exam') await testSkipExam(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'qtext') await testQText();
    if (which === 'all' || which === 'empty') await testEmptyPage(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'empty-optin') await testEmptyOptIn(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'empty-guard') await testEmptyButPlaying(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'font') await testFont();
    if (which === 'all' || which === 'retry') await testRetry();
    if (which === 'all' || which === 'giveup') await testGiveUp(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'end') await testCourseEnd(sw.webSocketDebuggerUrl);
    if (which === 'all' || which === 'scope') await testScope();
    if (which === 'all' || which === 'shell') await testShell();

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
