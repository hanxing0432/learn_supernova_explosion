/* 后台服务：AI 请求代理、日志/状态广播、跳转仲裁、答案缓存 */
'use strict';

importScripts('shared/config.js', 'shared/glyphdict.js');

const CFG = self.CXConfig;
const LOG_MAX = 400;
const BANK_MAX = 3000;

let logs = [];
let bank = null;              // { key: answer }
const lastClaim = {};         // `${tabId}:${action}` -> ts
const lastStatusByTab = {};   // tabId -> {text,busy,ts}
const tabVideo = {};          // tabId -> {state, ts}  视频正在播放时禁止跳下一节
const tabFrames = {};         // tabId -> { frameKey: {t,hasTask,hasVideo,hasExam} }

/* 汇总同一标签页里所有 frame 的「有没有任务点/视频/题目」，
 * 顶层帧据此判断整页是否真的空，避免把子帧里的任务点当成空页跳过 */
function aggregateFrames(tabId) {
  const m = tabFrames[tabId] || {};
  const now = Date.now();
  let hasTask = false, hasVideo = false, hasExam = false, count = 0;
  Object.keys(m).forEach(function (k) {
    const f = m[k];
    if (now - f.t > 7000) { delete m[k]; return; }
    count++;
    if (f.hasTask) hasTask = true;
    if (f.hasVideo) hasVideo = true;
    if (f.hasExam) hasExam = true;
  });
  return { hasTask: hasTask, hasVideo: hasVideo, hasExam: hasExam, count: count };
}

/* ---------------- 开发自愈：文件变更后自动重载扩展 ----------------
 * 目的：改完代码不用重启浏览器（重启会掐断 DSH 浏览器桥接）。
 * 做法：定时抓取自身脚本内容做指纹比对，变化则 chrome.runtime.reload()；
 * 重启后若发现是刚自愈的，就把学习页刷新一遍，让新内容脚本生效。 */
const DEV_WATCH_FILES = [
  'content/nav.js', 'content/parser.js', 'content/videoquiz.js', 'content/exam.js',
  'content/player.js', 'content/hud.js', 'content/probe.js', 'content/common.js',
  'content/ttf.js', 'content/glyphmatch.js', 'content/fontdecrypt.js', 'content/fontsampler.js',
  'background.js'
];
let devSig = '';

function devSignature() {
  return Promise.all(DEV_WATCH_FILES.map(function (f) {
    return fetch(chrome.runtime.getURL(f) + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (t) { return t.length + ':' + t.slice(-64); })
      .catch(function () { return 'x'; });
  })).then(function (parts) { return parts.join('|'); });
}

async function devWatch() {
  let cfg = null;
  try { cfg = await getConfig(); } catch (e) {}
  /* 只有显式打开才工作（2026-10-28：默认关闭 —— 自动重载会打断正在跑的答题/提交） */
  if (!cfg || !cfg.dev || cfg.dev.autoReload !== true) return;
  let sig = '';
  try { sig = await devSignature(); } catch (e) { return; }
  if (!devSig) { devSig = sig; return; }
  if (sig !== devSig) {
    devSig = sig;
    logs.push({ level: 'info', text: '检测到代码变更，自动重载扩展', scope: 'bg', ts: Date.now() });
    try { await chrome.storage.local.set({ devReloadAt: Date.now() }); } catch (e) {}
    setTimeout(function () { chrome.runtime.reload(); }, 400);
  }
}

/* 开关缓存：两个开发通道都默认关，改设置后 10~15 秒内自动生效 */
let devWatchOn = false;
let cmdBridgeOn = false;

async function refreshDevSwitches() {
  try {
    const cfg = await getConfig();
    devWatchOn = !!(cfg && cfg.dev && cfg.dev.autoReload === true);
    cmdBridgeOn = !!(cfg && cfg.dev && cfg.dev.cmdBridge === true);
  } catch (e) {
    devWatchOn = false;
    cmdBridgeOn = false;
  }
}
refreshDevSwitches();
setInterval(function () { refreshDevSwitches(); }, 12000);

/* 每 8 秒自检一次（仅开关打开时） */
setInterval(function () {
  if (!devWatchOn) return;
  try { devWatch(); } catch (e) {}
}, 8000);

/* SW 启动时：刚自愈过就刷新学习页 */
async function afterDevReload() {
  const { devReloadAt } = await chrome.storage.local.get(['devReloadAt']);
  if (!devReloadAt || Date.now() - devReloadAt > 90000) return;
  await chrome.storage.local.remove(['devReloadAt']);
  try {
    const tabs = await chrome.tabs.query({ url: ['*://mooc1.chaoxing.com/*', '*://mooc2-ans.chaoxing.com/*'] });
    for (const t of tabs) {
      try { await chrome.tabs.reload(t.id); } catch (e) {}
    }
    logs.push({ level: 'info', text: '自愈后刷新学习页 ' + tabs.length + ' 个', scope: 'bg', ts: Date.now() });
  } catch (e) {}
}

/* ---------------- 收样服务通道（字体样本采集） ----------------
 * 内容脚本不能跨域 fetch 到 127.0.0.1，这里代劳；顺带负责截图裁剪和字典同步。
 * 服务端见 tools/sample-server.mjs，落盘到 _samples/。 */
const SAMPLE_BASE_DEFAULT = 'http://127.0.0.1:8788';

async function sampleBase() {
  try {
    const r = await chrome.storage.local.get(['cxSampleBase']);
    return (r && r.cxSampleBase) || SAMPLE_BASE_DEFAULT;
  } catch (e) { return SAMPLE_BASE_DEFAULT; }
}

async function sampleFetch(pathname, opts) {
  const base = await sampleBase();
  const url = base.replace(/\/+$/, '') + pathname;
  opts = opts || {};
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store'
    });
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 200) }; }
    return { ok: res.ok, status: res.status, data: data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

function bytesToB64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

/* 截当前可见区域并按块裁剪（clip 是设备像素） */
async function captureCrop(windowId, clip) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const x = Math.max(0, Math.min(bmp.width - 1, Math.round(clip.x || 0)));
  const y = Math.max(0, Math.min(bmp.height - 1, Math.round(clip.y || 0)));
  const w = Math.max(1, Math.min(Math.round(clip.w || 0) || 1, bmp.width - x));
  const h = Math.max(1, Math.min(Math.round(clip.h || 0) || 1, bmp.height - y));
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d');
  ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h);
  const out = await oc.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await out.arrayBuffer());
  return { b64: bytesToB64(buf), w: w, h: h };
}

/* 把字典同步进 chrome.storage.local，供 fontdecrypt 直接用（不需要重新打包扩展） */
async function syncGlyphDict(force) {
  const r = await sampleFetch('/glyphdict');
  if (!r.ok || !r.data) return { ok: false, error: r.error || ('HTTP ' + r.status) };
  const d = r.data;
  if (!d || !d.map) return { ok: false, error: '字典格式不对' };
  const cur = await chrome.storage.local.get(['cxGlyphDict']);
  const old = cur && cur.cxGlyphDict;
  const nNew = Object.keys(d.map).length;
  const nOld = (old && old.map) ? Object.keys(old.map).length : 0;
  /* 只增不减：本地已经算出更多条目时，别被旧的服务端字典盖掉 */
  if (old && nOld > nNew) return { ok: true, n: nOld, fresh: false, kept: true };
  const fresh = !old || !old.ts || d.ts !== old.ts || nNew !== nOld;
  if (fresh) {
    await chrome.storage.local.set({ cxGlyphDict: { ts: d.ts, map: d.map, raw: d.raw || {}, n: nNew } });
  }
  return { ok: true, n: nNew, fresh: fresh };
}

/* 每 2 分钟从服务端拉一次字典（服务没起就静默跳过）
 * 2026-10-31：只在「调试模式」或「本地命令桥」打开时才自动拉 —— 发布版默认不去敲 127.0.0.1:8788，
 * 否则每次 SW 启动都会在控制台留一条 ERR_CONNECTION_REFUSED。
 * 采样器/命令桥里的显式 syncGlyphDict(true) 不受影响。 */
async function autoSyncGlyphDict() {
  try {
    const cfg = await getConfig();
    if (!(cfg.ui && cfg.ui.debugMode) && !(cfg.dev && cfg.dev.cmdBridge)) return;
  } catch (e) { return; }
  syncGlyphDict(false).catch(function () {});
}
setInterval(function () { autoSyncGlyphDict(); }, 120000);
/* SW 每次启动（含扩展重载/浏览器启动）先拉一次 */
setTimeout(function () { autoSyncGlyphDict(); }, 1500);
async function getConfig() {
  const res = await chrome.storage.local.get(['cxConfig']);
  return CFG.normalize(res.cxConfig);
}

chrome.runtime.onInstalled.addListener(async function () {
  const res = await chrome.storage.local.get(['cxConfig']);
  if (!res.cxConfig) await chrome.storage.local.set({ cxConfig: CFG.normalize(null) });
  chrome.alarms.create('cx-keepalive', { periodInMinutes: 0.5 });
  afterDevReload();
});

chrome.runtime.onStartup.addListener(function () {
  chrome.alarms.create('cx-keepalive', { periodInMinutes: 0.5 });
  afterDevReload();
});

chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === 'cx-keepalive') {
    /* 借闹钟唤醒 SW；开发自检关着时什么都不做 */
    refreshDevSwitches();
    if (devWatchOn) { try { devWatch(); } catch (e) {} }
  }
});

/* ---------------- 广播 ---------------- */
function broadcast(tabId, msg) {
  if (tabId === undefined || tabId === null) return;
  msg.__broadcast = true;
  chrome.tabs.sendMessage(tabId, msg).catch(function () {});
}

/* ---------------- 答案库 ---------------- */
async function loadBank() {
  if (bank) return bank;
  const res = await chrome.storage.local.get(['cxAnswerBank']);
  bank = res.cxAnswerBank || {};
  return bank;
}

async function saveBank() {
  const keys = Object.keys(bank || {});
  if (keys.length > BANK_MAX) {
    const trimmed = {};
    keys.slice(-BANK_MAX).forEach(function (k) { trimmed[k] = bank[k]; });
    bank = trimmed;
  }
  await chrome.storage.local.set({ cxAnswerBank: bank });
}

/* ---------------- 提示词 ---------------- */
const SYS_BASE = [
  '你是一名严谨的高校课程答题助手，负责解答语文通识、安全教育、思政、计算机等各类课程的选择题、多选题、判断题和填空题。',
  '要求：',
  '1. 只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码块。',
  '2. 单选与判断题只能给出一个选项字母；多选题给出多个字母（按字母顺序）。',
  '3. 选项字母使用题目给定的 label（A/B/C/D…），不要编造不存在的字母。',
  '4. 判断题：选项通常是 A=正确 B=错误，也可能是 A=对 B=错，按实际文本选择。',
  '5. 若提供 feedback.wrongQuestions，其中 previouslyChosen 是你上次的错误选择，必须避开它们并重新推理。',
  '6. 若提供 feedback.searchResults，那是从网上检索到的资料，请以它为主要依据作答。',
  '7. 答案是确定的，不要不确定就留空。'
].join('\n');

function buildMessages(task, payload, cfg) {
  const sys = (cfg.ai.systemPrompt && cfg.ai.systemPrompt.trim()) || SYS_BASE;
  let user;
  if (task === 'video-quiz') {
    const q = payload.question || {};
    user = {
      task: 'video-quiz',
      instruction: '这是一道视频中弹出的题，请作答。多选就给出多个字母。输出格式：{"choices":["A"]}',
      type: q.typeText || q.type,
      question: q.stem || q.title,
      options: q.options || [],
      feedback: payload.feedback || null
    };
  } else if (task === 'exam') {
    user = {
      task: 'exam',
      instruction: '批量作答。输出格式：{"answers":[{"index":0,"choices":["A"]},{"index":1,"choices":["B","C"]}]}，index 必须与输入一致，不要遗漏任何一题。',
      questions: payload.questions || [],
      feedback: payload.feedback || null
    };
  } else if (task === 'ping') {
    user = { task: 'ping', instruction: '输出 {"ok":true} 表示你已就绪。' };
  } else {
    user = payload;
  }
  return [
    { role: 'system', content: sys },
    { role: 'user', content: JSON.stringify(user) }
  ];
}

/* ---------------- JSON 抽取 ---------------- */
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sub = t.slice(start, end + 1);
    try { return JSON.parse(sub); } catch (e) {}
    try { return JSON.parse(sub.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')); } catch (e) {}
  }
  return null;
}

/* ---------------- 调用 AI ---------------- */
async function callAI(task, payload) {
  const cfg = await getConfig();
  const ai = cfg.ai;
  if (!ai.apiKey && !/127\.0\.0\.1|localhost/.test(ai.baseUrl || '')) {
    return { ok: false, error: '未配置 API Key，请打开插件「高级设置」填写' };
  }
  if (!ai.baseUrl) return { ok: false, error: '未配置接口地址 Base URL' };

  const url = ai.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (ai.apiKey) headers['Authorization'] = 'Bearer ' + ai.apiKey;
  String(ai.extraHeaders || '').split(/\n+/).forEach(function (line) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });

  const body = {
    model: ai.model,
    messages: buildMessages(task, payload, cfg),
    temperature: Number(ai.temperature || 0.2),
    max_tokens: Number(ai.maxTokens || 1600),
    stream: false
  };
  if (ai.jsonMode && task !== 'ping') body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, Number(ai.timeoutMs || 90000));
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, error: 'HTTP ' + resp.status + ' ' + text.slice(0, 300), ms: Date.now() - t0 };
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, error: '响应不是 JSON：' + text.slice(0, 200) }; }
    const content = data.choices && data.choices[0] && (data.choices[0].message ? data.choices[0].message.content : data.choices[0].text);
    const answer = extractJson(content);
    if (!answer) return { ok: false, error: 'AI 输出无法解析：' + String(content || '').slice(0, 200), raw: content };
    return { ok: true, answer: answer, raw: content, ms: Date.now() - t0, model: data.model };
  } catch (e) {
    clearTimeout(timer);
    const msg = e && e.name === 'AbortError' ? '请求超时' : String(e && e.message || e);
    return { ok: false, error: msg };
  }
}

/* ---------------- 消息路由 ---------------- */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.__broadcast) return;

  const tabId = sender && sender.tab && sender.tab.id;

  if (msg.kind === 'log') {
    const entry = { level: msg.level, text: msg.text, scope: msg.scope, data: msg.data, ts: msg.ts || Date.now() };
    logs.push(entry);
    if (logs.length > LOG_MAX) logs = logs.slice(-LOG_MAX);
    chrome.storage.session.set({ cxLogs: logs.slice(-80) }).catch(function () {});
    broadcast(tabId, { kind: 'log_bc', entry: entry });
    return;
  }

  /* 字形逆查表：content script 取不到扩展内资源（无 web_accessible 时可走这里），
   * 由 SW 读 data/ 再回传，2.9MB 一次性传给页面侧。 */
  if (msg.kind === 'glyph:table') {
    (async function () {
      try {
        const gzRes = await fetch(chrome.runtime.getURL('data/glyphdesc.bin.gz'));
        const metaRes = await fetch(chrome.runtime.getURL('data/glyphmeta.json'));
        const gz = await gzRes.arrayBuffer();
        const meta = await metaRes.json();
        sendResponse({ ok: true, gz: gz, meta: meta });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.kind === 'status') {    lastStatusByTab[tabId] = { text: msg.text, busy: msg.busy, ts: msg.ts };
    chrome.storage.session.set({ cxStatus: lastStatusByTab }).catch(function () {});
    broadcast(tabId, { kind: 'status_bc', text: msg.text, busy: msg.busy, phase: msg.phase });
    return;
  }

  if (msg.kind === 'video:done') {
    tabVideo[tabId] = { state: 'done', ts: Date.now() };
    broadcast(tabId, { kind: 'video_done_bc', url: msg.url });
    return;
  }

  if (msg.kind === 'video:state') {
    tabVideo[tabId] = { state: msg.state, ts: msg.ts || Date.now(), url: msg.url };
    return;
  }

  if (msg.kind === 'exam:passed') {
    broadcast(tabId, { kind: 'exam_passed_bc', url: msg.url });
    return;
  }

  /* 2026-11-03：设置里开了「跳过学习检测」时，答题帧一进测验页就发这条，
   * 导航据此直接切下一章（与「通过」同一条出路，但日志语义分开）。 */
  if (msg.kind === 'exam:skipped') {
    broadcast(tabId, { kind: 'exam_skipped_bc', url: msg.url });
    return;
  }

  /* 2026-11-06：跑满轮数放弃本节试卷时也必须有出路。
   * 以前只发了 exam:giveup，这里没有转发、nav 也没监听 ——
   * 纯测验章节（没有视频、没有"测验通过"信号）就永远没有切章触发，整页停死。 */
  if (msg.kind === 'exam:giveup') {
    broadcast(tabId, { kind: 'exam_giveup_bc', url: msg.url, chapter: msg.chapter });
    return;
  }

  /* 2026-10-30：顶层能看到任务条、答题帧经常看不到（跨域 iframe）。
   * 由顶层判定「学习测验任务点已完成」后广播给同标签页所有帧。 */
  if (msg.kind === 'quiz:taskDone') {
    broadcast(tabId, { kind: 'quiz_task_done_bc', url: msg.url, ts: msg.ts });
    return;
  }

  if (msg.kind === 'main:op') {
    (async function () {
      const tabId = sender && sender.tab && sender.tab.id;
      if (tabId === undefined) { sendResponse({ ok: false, error: 'no tab' }); return; }
      try {
        const r = await chrome.scripting.executeScript({
          target: { tabId: tabId, frameIds: [0] },
          world: 'MAIN',
          func: function () {
            return {
              anti: !!window.__CX_ANTIPAUSE_ACTIVE__,
              hidden: !!document.hidden,
              visibility: String(document.visibilityState || '')
            };
          }
        });
        sendResponse({ ok: true, result: r && r[0] && r[0].result });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.kind === 'devReload') {
    /* 由浮窗按钮触发：重载扩展本身，不重启浏览器（桥接不受影响） */
    try { chrome.storage.local.set({ devReloadAt: Date.now() }); } catch (e) {}
    logs.push({ level: 'info', text: '手动重载扩展', scope: 'bg', ts: Date.now() });
    sendResponse({ ok: true });
    setTimeout(function () { chrome.runtime.reload(); }, 200);
    return true;
  }

  if (msg.kind === 'webSearch') {
    /* 给「答错后重新查资料」用的轻量联网搜索：
     * 抓 Bing 结果页的条目文本，去掉标签后返回前若干条摘要 */
    (async function () {
      const strip = function (h) {
        return String(h || '')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
          .replace(/&#\d+;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      };
      const q = String(msg.query || '').slice(0, 120);
      if (!q) { sendResponse({ ok: false, error: 'empty query' }); return; }
      const urls = [
        'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&ensearch=0',
        'https://cn.bing.com/search?q=' + encodeURIComponent(q)
      ];
      for (let i = 0; i < urls.length; i++) {
        try {
          const r = await fetch(urls[i], {
            cache: 'no-store',
            headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' }
          });
          if (!r.ok) continue;
          const html = await r.text();
          const blocks = [];
          const re = /<li class="b_algo"[\s\S]{0,3000}?<\/li>/g;
          let m;
          while ((m = re.exec(html)) && blocks.length < 5) {
            const t = strip(m[0]);
            if (t && t.length > 30) blocks.push(t.slice(0, 260));
          }
          if (!blocks.length) {
            const t = strip(html);
            if (t.length > 120) blocks.push(t.slice(0, 600));
          }
          if (blocks.length) { sendResponse({ ok: true, query: q, snippets: blocks }); return; }
        } catch (e) { /* 换下一个源 */ }
      }
      sendResponse({ ok: false, error: 'search failed' });
    })();
    return true;
  }

  if (msg.kind === 'nav') {
    if (msg.action === 'frameState') {
      /* 各 frame 每 3 秒上报自己有没有任务点/视频/题目，
       * 顶层帧据此判断「整页是否真的空」，避免把子帧里的任务点误判成空页 */
      const key = String(msg.frameKey || msg.url || Math.random());
      tabFrames[tabId] = tabFrames[tabId] || {};
      tabFrames[tabId][key] = {
        t: Date.now(),
        hasTask: !!msg.hasTask,
        hasVideo: !!msg.hasVideo,
        hasExam: !!msg.hasExam
      };
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'state') {
      const vs = tabVideo[tabId];
      const agg = aggregateFrames(tabId);
      sendResponse({
        ok: true,
        videoPlaying: !!(vs && vs.state === 'playing' && Date.now() - vs.ts < 8000),
        videoState: vs ? vs.state : 'none',
        age: vs ? Date.now() - vs.ts : -1,
        anyTask: agg.hasTask,
        anyVideo: agg.hasVideo,
        anyExam: agg.hasExam,
        frames: agg.count
      });
      return true;
    }
    const action = 'claim';
    const key = tabId + ':' + action;
    const now = Date.now();
    const gap = msg.reason === 'reload' ? 6000 : 2500;
    /* 是否允许跳转只看「任务点是否完成」（msg.done），不看视频放没放完 */
    if (lastClaim[key] && now - lastClaim[key] < gap) {
      sendResponse({ ok: false, waited: now - lastClaim[key] });
      return true;
    }
    lastClaim[key] = now;
    sendResponse({ ok: true });
    return true;
  }

  /* 2026-11-03：题目原文面板 —— 跨帧采集 / 跳转定位 / 打开搜索页 */
  if (msg.kind === 'qtext') {
    if (msg.action === 'collect') {
      broadcast(tabId, { kind: 'qtext_collect_bc', reqId: msg.reqId });
      return;
    }
    if (msg.action === 'part') {
      broadcast(tabId, { kind: 'qtext_part_bc', reqId: msg.reqId, part: msg.part, frameId: (sender && sender.frameId) || 0 });
      return;
    }
    if (msg.action === 'focus') {
      /* 广播给所有帧，只有 key 对得上的那一帧会滚 —— 不用维护 frameId 映射 */
      broadcast(tabId, { kind: 'qtext_focus_bc', key: msg.key, idx: msg.idx });
      return;
    }
    if (msg.action === 'clear') {
      /* 关面板 / 重抓时把各帧的描边都清掉 */
      broadcast(tabId, { kind: 'qtext_clear_bc' });
      return;
    }
    return;
  }

  if (msg.kind === 'openUrl') {
    const u = String((msg && msg.url) || '');
    if (!/^https?:\/\//i.test(u) || u.length > 2048) { sendResponse({ ok: false, error: 'bad url' }); return true; }
    chrome.tabs.create({ url: u }, function (t) { sendResponse({ ok: !!t, id: (t && t.id) || null }); });
    return true;
  }

  if (msg.kind === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (msg.kind === 'ai') {
    (async function () {
      if (msg.action === 'chat') {
        const res = await callAI(msg.payload && msg.payload.task || 'exam', msg.payload || {});
        if (res.ok) {
          const t = msg.payload && msg.payload.task;
          broadcast(tabId, {
            kind: 'log_bc',
            entry: { level: 'debug', text: 'AI 响应 ' + (res.ms || 0) + 'ms（' + t + '）', ts: Date.now() }
          });
        }
        sendResponse(res);
      } else if (msg.action === 'remember') {
        const b = await loadBank();
        b[msg.payload.key] = { answer: msg.payload.answer, ts: Date.now() };
        await saveBank();
        sendResponse({ ok: true });
      } else if (msg.action === 'recall') {
        const b = await loadBank();
        sendResponse({ answer: b[msg.payload.key] || null });
      } else {
        sendResponse({ ok: false, error: '未知 action' });
      }
    })();
    return true;
  }

  if (msg.kind === 'sample') {
    (async function () {
      const action = msg.action;
      try {
        if (action === 'ping') {
          const r = await sampleFetch('/ping');
          sendResponse({ ok: r.ok, ...(r.data || {}) });
          return;
        }
        if (action === 'stats') {
          const r = await sampleFetch('/stats');
          sendResponse(r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || ('HTTP ' + r.status) });
          return;
        }
        if (action === 'ingest') {
          const r = await sampleFetch('/ingest', { method: 'POST', body: msg.payload, timeoutMs: 12000 });
          if (!r.ok) {
            /* 本地服务没开是正常情况（扩展自己会存本地），别在这儿多做无用的往返 */
            sendResponse({ ok: false, error: (r.data && r.data.error) || r.error || ('HTTP ' + r.status) });
            return;
          }
          const dict = await sampleFetch('/aggregate', { method: 'POST', timeoutMs: 30000 });
          await syncGlyphDict(true);
          sendResponse({ ok: true, ...(r.data || {}), aggregated: dict.ok });
          return;
        }
        if (action === 'export') {
          const got = await chrome.storage.local.get(['cxSamples', 'cxFonts', 'cxGlyphDict']);
          const payload = {
            v: 1, ts: Date.now(),
            fonts: got.cxFonts || {},
            samples: got.cxSamples || [],
            dict: got.cxGlyphDict || {}
          };
          const text = JSON.stringify(payload, null, 1);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const name = '学习通字体样本/samples-' + stamp + '.json';
          const id = await chrome.downloads.download({
            url: 'data:application/json;base64,' + bytesToB64(new TextEncoder().encode(text)),
            filename: name,
            saveAs: false,
            conflictAction: 'uniquify'
          });
          sendResponse({ ok: true, id: id, file: name, bytes: text.length });
          return;
        }
        if (action === 'download') {
          const name = String(msg.name || 'sample.json').replace(/[\\:*?"<>|]/g, '_');
          const b64 = bytesToB64(new TextEncoder().encode(String(msg.text || '')));
          const id = await chrome.downloads.download({
            url: 'data:application/json;base64,' + b64,
            filename: name,
            saveAs: false,
            conflictAction: 'uniquify'
          });
          sendResponse({ ok: true, id: id });
          return;
        }
        if (action === 'openDir') {
          const r = await sampleFetch('/open', { method: 'POST' });
          sendResponse({ ok: r.ok, error: r.error });
          return;
        }
        if (action === 'syncDict') {
          const r = await syncGlyphDict(true);
          sendResponse(r);
          return;
        }
        if (action === 'aggregate') {
          const r = await sampleFetch('/aggregate', { method: 'POST', timeoutMs: 30000 });
          sendResponse(r.ok ? { ok: true, summary: (r.data || {}).summary } : { ok: false, error: r.error });
          return;
        }
        sendResponse({ ok: false, error: '未知 sample action: ' + action });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.kind === 'getState') {
    (async function () {
      sendResponse({
        ok: true,
        logs: logs.slice(-80),
        status: lastStatusByTab,
        config: await getConfig()
      });
    })();
    return true;
  }

  if (msg.kind === 'diag') {
    logs.push({ level: 'debug', text: 'DIAG ' + (msg.summary || ''), data: msg.data, ts: Date.now() });
    sendResponse({ ok: true });
    return true;
  }
});

/* 首次点击图标打开 popup 时初始化配置 */
chrome.runtime.onConnect.addListener(function () {});

/* ---------------- 本地命令桥（调试用，服务没起会静默跳过） ----------------
 * 页面侧不 eval：命令是固定名单，避免 CSP / 注入问题。
 *   stats  解码器与逆查表状态
 *   fonts  当前页面字体指纹与字形数
 *   q      题干/选项的解码结果（前 3 题）
 *   raw    .font-cxsecret 元素的原文与解码后文本
 */
/* 命令桥地址改成可配置（2026-10-30）：
 *   dev.cmdBridgeUrl 为空 = 完全不轮询（默认就是空，发布包不带任何本机地址）
 *   只接受 http/https；末尾斜杠自动去掉
 *   旧版这里写死 http://127.0.0.1:8765，等于把本机端口固化进发布版 */
function cmdBridgeBase(cfg) {
  const raw = String((cfg && cfg.dev && cfg.dev.cmdBridgeUrl) || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw.replace(/\/+$/, '');
}

let cmdBridgeBaseUrl = '';        /* 本轮 tick 用的地址，cmdPost 回结果时复用 */
let cmdBridgeNoUrlWarned = false;

async function cmdPost(id, payload) {
  if (!cmdBridgeBaseUrl) return;
  try {
    await fetch(cmdBridgeBaseUrl + '/result', { method: 'POST', body: JSON.stringify({ id: id, payload: payload }) });
  } catch (e) {}
}

async function cmdBridgeTick(base) {
  let _id = null;
  if (!base) return;
  try {
    const r = await fetch(base + '/poll', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.id) return;
    _id = j.id;

    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter(function (t) { return /chaoxing\.com/.test(t.url || ''); });

    /* 只读：把后台日志环回传（2026-10-30 加回，仅 dev.cmdBridge 打开时可用，
     * 不执行任何页面代码，等价于看插件自己的日志窗口） */
    if (j.cmd === 'logs') {
      const n = Math.max(1, Math.min(400, parseInt(j.arg || '120', 10) || 120));
      await cmdPost(j.id, { ok: true, n: n, logs: logs.slice(-n) });
      return;
    }

    /* 2026-10-31：清掉「本次测验的作答记忆」（轮次 + 每轮答案/错题）。
     * 轮数用尽后想重来、或旧版本留下脏历史时用；只删 cxExamAttempt 一个 key。 */
    if (j.cmd === 'resetexam') {
      try {
        const cur = await chrome.storage.local.get(['cxExamAttempt']);
        const had = !!(cur && cur.cxExamAttempt);
        await chrome.storage.local.remove(['cxExamAttempt']);
        await cmdPost(j.id, { ok: true, removed: had });
      } catch (e) {
        await cmdPost(j.id, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }

    if (j.cmd === 'setdict') {
      try {
        const patchMap = JSON.parse(j.arg || '{}');
        const cur = await chrome.storage.local.get(['cxGlyphDict']);
        const d = cur && cur.cxGlyphDict;
        const m = (d && d.map) ? d.map : {};
        let n = 0;
        Object.keys(patchMap).forEach(function (k) {
          if (m[k] !== patchMap[k]) { m[k] = patchMap[k]; n++; }
        });
        await chrome.storage.local.set({ cxGlyphDict: { ts: Date.now(), map: m, raw: (d && d.raw) || {}, n: Object.keys(m).length } });
        await cmdPost(j.id, { ok: true, dictN: Object.keys(m).length, changed: n, sample: Object.keys(patchMap).slice(0, 3) });
      } catch (e) {
        await cmdPost(j.id, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    if (j.cmd === 'getdict') {
      try {
        const cur = await chrome.storage.local.get(['cxGlyphDict']);
        const d = cur && cur.cxGlyphDict;
        const m = (d && d.map) ? d.map : {};
        if (!j.arg) { await cmdPost(j.id, { ok: true, dictN: Object.keys(m).length, all: m }); return; }
        const want = (j.arg || '').split(',').filter(Boolean);
        const out = {};
        want.forEach(function (k) { out[k] = m[k] || null; });
        await cmdPost(j.id, { ok: true, dictN: Object.keys(m).length, picked: out });
      } catch (e) {
        await cmdPost(j.id, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    if (j.cmd === 'coldtest') {
      const res2 = await chrome.scripting.executeScript({
        target: { tabId: (tabs.filter(function (t) { return /doHomeWorkNew|work\//.test(t.url || ''); })[0] || tabs[0]).id, allFrames: false },
        func: function () {
          try {
            var CX = window.CX, fd = CX && CX.fontDecrypt;
            if (!fd) return { ok: false, why: 'no fontdecrypt' };
            var els = document.querySelectorAll('.font-cxsecret');
            var seen = {}, chars = [];
            for (var i = 0; i < els.length && chars.length < 8; i++) {
              var t = String(els[i].textContent || '');
              for (var k = 0; k < t.length && chars.length < 8; k++) {
                var ch = t[k];
                if (seen[ch]) continue;
                seen[ch] = 1;
                var sig = fd.sigOf(ch);
                if (!sig) continue;
                var pts = fd.pointsOf(ch);
                if (!pts) continue;
                chars.push({ ch: ch, sig: sig, pts: pts });
              }
            }
            return fd ? CX.glyphMatch.ensure().then(function (ready) {
              var out = [], m = fd.map();
              for (var i2 = 0; i2 < chars.length; i2++) {
                var c = chars[i2];
                var r = CX.glyphMatch.identify(c.pts, c.sig);
                out.push({ enc: c.ch, dict: m[c.ch] || '', table: r ? r.ch : '(跳过)', margin: r ? Math.round(r.margin * 100) / 100 : 0 });
              }
              return { ok: true, ready: ready, stats: CX.glyphMatch.stats(), rows: out };
            }) : { ok: false, why: 'no glyphMatch' };
          } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        }
      });
      await cmdPost(j.id, { ok: true, r: res2[0].result });
      return;
    }
    if (j.cmd === 'open') {
      try {
        const nt = await chrome.tabs.create({ url: j.arg, active: true });
        await cmdPost(j.id, { ok: true, id: nt.id, url: nt.pendingUrl || nt.url });
      } catch (e) {
        await cmdPost(j.id, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    if (j.cmd === 'tabs') {
      await cmdPost(j.id, {
        ok: true,
        tabs: allTabs.filter(function (t) { return !/^(edge|chrome|devtools):/.test(t.url || ''); }).map(function (t) {
          return { id: t.id, title: (t.title || '').slice(0, 60), url: (t.url || '').slice(0, 160), active: !!t.active };
        })
      });
      return;
    }
    const tab = (j.tabId && tabs.find(function (t) { return t.id === j.tabId; })) || tabs[0];
    if (!tab) { await cmdPost(j.id, { ok: false, error: '没有 chaoxing 标签页' }); return; }

    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: function (cmd, arg) {
        try {
          var CX = window.CX;
          if (!CX) return { ok: false, skip: true, why: 'no CX（本 frame 没跑内容脚本）' };
          if (cmd === 'stats') {
            return {
              ok: true,
              href: location.href.slice(0, 120),
              title: document.title,
              secretCount: document.querySelectorAll('.font-cxsecret').length,
              decrypt: CX.fontDecrypt && CX.fontDecrypt.stats ? CX.fontDecrypt.stats() : null,
              glyph: CX.glyphMatch && CX.glyphMatch.stats ? CX.glyphMatch.stats() : null
            };
          }
          if (cmd === 'q') {
            var fx = (CX.fontDecrypt && CX.fontDecrypt.fix) ? CX.fontDecrypt.fix : function (s) { return s; };
            var out = [];
            var boxes = document.querySelectorAll('.questionLi, .TiMu, .mark_item');
            for (var i = 0; i < boxes.length && out.length < 3; i++) {
              var t = String(boxes[i].innerText || '').replace(/\s+/g, ' ').trim();
              if (!t) continue;
              out.push({ raw: t.slice(0, 120), fixed: fx(t).slice(0, 120) });
            }
            return { ok: true, n: boxes.length, items: out };
          }
          if (cmd === 'raw') {
            var fx2 = (CX.fontDecrypt && CX.fontDecrypt.fix) ? CX.fontDecrypt.fix : function (s) { return s; };
            var els = document.querySelectorAll('.font-cxsecret');
            var arr = [];
            for (var k = 0; k < els.length && arr.length < 5; k++) {
              var s = String(els[k].textContent || '');
              arr.push({ raw: s.slice(0, 60), fixed: fx2(s).slice(0, 60) });
            }
            return { ok: true, n: els.length, items: arr };
          }
          if (cmd === 'fonts') {
            var faces = [];
            try {
              for (var s2 = 0; s2 < document.styleSheets.length; s2++) {
                var rules = null;
                try { rules = document.styleSheets[s2].cssRules; } catch (e) { continue; }
                for (var r2 = 0; r2 < (rules || []).length; r2++) {
                  var ru = rules[r2];
                  if (!ru || !ru.style || String(ru.style.fontFamily || '').indexOf('cxsecret') < 0) continue;
                  var src = String(ru.style.src || '');
                  var m = src.match(/base64,([A-Za-z0-9+/=]{0,40})/);
                  faces.push({ family: ru.style.fontFamily, head: m ? m[1].slice(0, 12) : '(url)' });
                }
              }
            } catch (e3) {}
            return { ok: true, faces: faces };
          }
          return { ok: false, error: '未知命令 ' + cmd };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      args: [j.cmd || 'stats', j.arg || '']
    });
    await cmdPost(j.id, {
      ok: true,
      url: tab.url,
      title: tab.title,
      frames: res.map(function (x) { return { frameId: x.frameId, r: x.result }; })
    });
  } catch (e) {
    if (_id) await cmdPost(_id, { ok: false, error: 'bridge tick failed: ' + String((e && e.message) || e) });
  }
}

/* 本地命令桥轮询：每次现读配置（不依赖内存缓存 —— SW 一被回收，缓存变量就变回 false，
 * 命令桥会静默失效，表现就是 /run 一直超时）。 */
setInterval(function () {
  getConfig().then(function (c) {
    if (!c || !c.dev || c.dev.cmdBridge !== true) { cmdBridgeBaseUrl = ''; return; }
    const base = cmdBridgeBase(c);
    if (!base) {
      cmdBridgeBaseUrl = '';
      /* 开关开着但地址空着：不联网，只提示一次，免得被当成「开了却没反应」 */
      if (!cmdBridgeNoUrlWarned) {
        cmdBridgeNoUrlWarned = true;
        logs.push({ level: 'warn', text: '命令桥已开但没填地址（dev.cmdBridgeUrl 为空），不轮询', scope: 'bg', ts: Date.now() });
        if (logs.length > LOG_MAX) logs = logs.slice(-LOG_MAX);
        try { chrome.storage.session.set({ cxLogs: logs.slice(-80) }).catch(function () {}); } catch (e) {}
      }
      return;
    }
    cmdBridgeNoUrlWarned = false;
    cmdBridgeBaseUrl = base;
    return cmdBridgeTick(base);
  }).catch(function () {});
}, 1200);

/* 保证闹钟一定存在（onInstalled 不一定触发，SW 靠它定期醒来跑上面的轮询） */
try { chrome.alarms.create('cx-keepalive', { periodInMinutes: 0.5 }); } catch (e) {}








