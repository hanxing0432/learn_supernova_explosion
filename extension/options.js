'use strict';

/* 设置页 —— 只负责「怎么显示」，不碰任何运行逻辑。
 * 硬约束：所有 path 与 shared/config.js 里的键一一对应，一个字符都不改；
 * 这里只调整分组、顺序、文案、折叠与搜索。 */

const CFG = window.CXConfig;
let cfg = CFG.normalize(null);

const $ = function (id) { return document.getElementById(id); };

function getPath(obj, path) {
  return path.split('.').reduce(function (o, k) { return o && o[k] !== undefined ? o[k] : undefined; }, obj);
}
function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = val;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

/* ---------------- 字段定义 ---------------- */

/* 模型候选：离线可选的常用值；真正的完整列表点字段旁的「拉取」从接口 /models 取。
 * 这里只是 UI 候选，不是白名单 —— 输入框仍可手填任意模型名。 */
const MODEL_PRESETS = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
  kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  zhipu: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
  ollama: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b', 'deepseek-r1:8b'],
  custom: []
};
let modelCache = [];              /* 「拉取」拿回来的模型，只在本次页面会话里有效 */

/* 总开关 + 它真正管的四项（挂在下面做子项） */
const MASTER_FIELD = {
  path: 'enabled', label: '自动学习总开关', type: 'bool',
  desc: '下面这四项的总闸。关掉后它们各自的值不变，但都不执行。',
  help: '只管「自动播放 / 弹题作答 / 学习检测 / 自动跳章」。防暂停、字体采集、AI 接口不受它控制。'
};

const GOVERNED_FIELDS = [
  { path: 'player.autoPlay', label: '自动播放', type: 'bool', desc: '进入有未完成视频的页自动开播（音量 0）。' },
  { path: 'nav.autoNext', label: '自动下一节', type: 'bool', desc: '任务点完成后翻页，优先走右侧目录。' },
  { path: 'videoQuiz.enabled', label: '弹题自动答', type: 'bool', desc: '视频中途弹出的题目自动作答。' },
  { path: 'exam.enabled', label: '学习检测自动处理', type: 'bool', desc: '测验 / 作业页按「作答方式」处理；关掉则连入口都不点，直接切下一章。' }
];

/* 不受总开关控制的：单独一段，避免又被误当成总开关管的东西 */
const INDEP_FIELDS = [
  {
    path: 'keepAlive.enabled', label: '防暂停（后台继续播）', type: 'bool',
    desc: '伪造页面可见状态、拦鼠标移出暂停、丢弃多开互斥 cookie。改完需刷新学习页才生效。',
    help: '总开关关了它也照常生效。改完要刷新学习页才生效：页面在加载时就把「鼠标移出 / 切走窗口暂停」这类监听注册好了，开关只能拦住之后的注册，救不回已经被拦掉的那部分。'
  }
];

/* 主题分区：默认收起，点标题展开（展开状态记在本页 localStorage，不进配置） */
const SECTIONS = [
  {
    key: 'play', title: '播放与防暂停',
    tip: '想让它切到别的窗口也照常跑：Edge → 设置 → 系统和性能 → 关掉「使用睡眠标签页节省资源」（Chrome：chrome://settings/performance）。这一层是浏览器策略，插件无权修改，只能手动关一次。',
    fields: [
      { path: 'keepAlive.blockAutoPause', label: '暂停即续播', type: 'bool', desc: '页面隐藏 / 被遮挡 / 被站点暂停时自动恢复播放。' },
      { path: 'keepAlive.volumeSilent', label: '静音播放（音量 0）', type: 'bool', desc: '用 volume=0 代替 muted，浏览器后台才不会被内核暂停。', help: '关掉后按站点默认带声音，切到后台大概率被暂停。' },
      { path: 'keepAlive.mirrorIfNoAudio', label: '无音轨视频保活', type: 'bool', desc: '对没有音轨的视频挂 captureStream 镜像，避免后台暂停。' },
      { path: 'keepAlive.rate', label: '播放倍速', type: 'number', step: '0.05', min: 0.5, max: 4, unit: '倍', danger: true, desc: '默认 1。站点通常锁 1 倍速，调高有被判异常的风险。' },
      { path: 'player.resumeAfterPause', label: '被暂停后自动续播', type: 'bool', desc: '和「暂停即续播」互为开关，两者都开才会强拉播放。' },
      { path: 'player.finishGraceMs', label: '结束判定延迟', type: 'number', min: 0, max: 20000, step: 100, unit: 'ms', desc: '视频结束后等站点标记任务点。', help: '实际等待 = 该值 + 6000ms；调小容易「跳太快丢进度」。' }
    ]
  },
  {
    key: 'nav', title: '章节跳转',
    fields: [
      { path: 'nav.nextDelayMs', label: '跳转前等待', type: 'number', min: 0, max: 20000, step: 100, unit: 'ms', desc: '让页面把学习记录上报完再跳，太短容易漏记。' },
      { path: 'nav.unlockWaitMs', label: '闯关解锁等待', type: 'number', min: 0, max: 60000, step: 500, unit: 'ms', desc: '提示「需完成前一任务点」时等多久再试。' },
      { path: 'nav.maxStuckReloads', label: '卡住自动刷新次数', type: 'number', min: 0, max: 10, unit: '次', desc: '连续判定「点了没变化」到这么多次就刷新页面。' },
      { path: 'nav.skipEmptyPage', label: '任务点全完成的页自动跳过', type: 'bool', desc: '只认 aria-label 明确写「已完成」才跳；关掉则停下等人。' },
      { path: 'nav.advanceWhenNoTask', label: '空页面也自动跳过', type: 'bool', desc: '无任务点 / 无视频 / 无题目的页直接下一节。', help: '关掉会停在空章节等人。' },
      { path: 'nav.useToc', label: '优先走右侧目录切章', type: 'bool', desc: '目录比「下一节」按钮稳（按钮常被弹窗卡住）。' },
      { path: 'nav.tocOnly', label: '只走目录', type: 'bool', desc: '完全不点「下一节」按钮，目录里找不到就等下一轮。', help: '这一项开着时，上面的「优先走右侧目录」没有实际作用。' },
      {
        path: 'nav.skipLockedToc', label: '下一节未解锁时往后找', type: 'bool',
        desc: '目录里下一项未解锁（或已完成）时，继续往后找第一项可做的章节；后面只剩已完成 / 未解锁的章节就停止。',
        help: '标记来自目录行尾：绿勾＝任务点已完成（跳过）、黄色数字＝有任务点未完成（就是它，圈里是 0 也照样进）、灰旗＝未解锁（跳过）；没有图标的行按可做处理。'
      },
      {
        path: 'nav.videoOnlyMode', label: '只有视频、没有任务点的页', type: 'select',
        options: [['watch', '看完再继续（默认）'], ['skip', '直接跳过，不看']],
        desc: '这类页面站点不记进度；「跳过」只省看视频的时间，不会跳过测验。'
      },
      { path: 'nav.stopAtCourseEnd', label: '课程末尾自动停止', type: 'bool', desc: '到最后一节就停，不去点不存在的「下一节」。' }
    ]
  },
  {
    key: 'quiz', title: '视频弹题',
    fields: [
      {
        path: 'videoQuiz.mode', label: '作答方式', type: 'select',
        options: [['ai-first', 'AI 优先'], ['brute', '暴力枚举（不调用 AI）'], ['off', '不处理']]
      },
      { path: 'videoQuiz.autoContinue', label: '答对后点「继续学习」', type: 'bool', desc: '并自动恢复视频播放。' },
      { path: 'videoQuiz.maxAiRounds', label: 'AI 最多重问次数', type: 'number', min: 1, max: 10, unit: '次' },
      { path: 'videoQuiz.bruteMaxTries', label: '暴力最多尝试次数', type: 'number', min: 1, max: 60, unit: '次' },
      { path: 'videoQuiz.submitWaitMs', label: '选择后等待提交', type: 'number', min: 0, max: 3000, step: 50, unit: 'ms' },
      { path: 'videoQuiz.tickMs', label: '弹题轮询间隔', type: 'number', min: 100, max: 3000, step: 50, unit: 'ms', desc: '越小枚举越快、越费 CPU；改完立即生效。' },
      { path: 'videoQuiz.wrongCoolMs', label: '答错冷却', type: 'number', min: 0, max: 3000, step: 50, unit: 'ms' }
    ]
  },
  {
    key: 'exam', title: '学习检测（章节测验 / 作业）',
    fields: [
      {
        path: 'exam.mode', label: '作答方式', type: 'select',
        options: [
          ['ai-first', 'AI 优先'],
          ['brute', '暴力枚举（不调 AI）'],
          ['skip', '跳过：进页面但不作答']
        ],
        help: '「跳过」会点开任务条上的「学习测验」入口，进去就交给导航切下一章 —— 不占用提交次数。'
      },
      { path: 'exam.maxRounds', label: '最多提交轮数', type: 'number', min: 1, max: 6, unit: '轮', danger: true, desc: '每次「任务点仍未完成」才重做。', help: '别调大：实测连打 4 轮会把学习页主线程打死。暴力枚举模式下这一项会自动×2。' },
      { path: 'exam.maxAiRounds', label: 'AI 最多常规轮数', type: 'number', min: 1, max: 10, unit: '轮', desc: '超过这么多轮才升级为「联网检索后重答」。' },
      { path: 'exam.useWebSearch', label: '未通过后联网检索', type: 'bool', desc: '关掉则只带错题反馈重问。' },
      { path: 'exam.maxSearchQuestions', label: '联网检索最多几题', type: 'number', min: 1, max: 10, unit: '题' },
      { path: 'exam.wrongOnlyRetry', label: '错题回喂 AI', type: 'bool', desc: '关掉则每轮整卷重答，不带上次的错误提示。' },
      { path: 'exam.randomDelayMs', label: '每题操作间隔', type: 'number', min: 0, max: 3000, step: 50, unit: 'ms' },
      { path: 'exam.submitConfirm', label: '自动确认提交弹窗', type: 'bool' },
      { path: 'exam.giveUpToNext', label: '轮数用尽就跳下一章', type: 'bool', desc: '跑满「最多提交轮数」仍没过时，放弃本节测验并让导航切下一章，不再卡死在这一节。关掉则停在原地提示人工处理。' },
      { path: 'exam.allowRealExam', label: '正式考试也自动作答', type: 'bool', danger: true, desc: '默认关闭：只处理学习检测 / 章节测验 / 作业，不碰正式考试。' }
    ]
  },
  {
    key: 'ai', title: 'AI 接口',
    tip: 'AI 不只服务「学习检测」：视频弹题、错题重答、联网检索都走这里配的接口。',
    fields: [
      {
        path: 'ai.enabled', label: '启用 AI 作答', type: 'bool',
        desc: '关掉后不再调用任何 AI 接口：视频弹题与学习检测的「AI 优先」自动按暴力枚举跑，Key 仍然保留。',
        help: '适合不想联网 / 不想花 token 的场景；要恢复 AI 作答打开即可，不用重填 Key。'
      },
      {
        path: 'ai.provider', label: '服务商预设', type: 'select',
        options: Object.keys(CFG.PROVIDERS).map(function (k) { return [k, CFG.PROVIDERS[k].label]; }),
        desc: '选中即自动填 Base URL / 模型 / JSON 模式。'
      },
      { path: 'ai.baseUrl', label: 'Base URL', type: 'text', desc: 'OpenAI 兼容接口，如 https://api.deepseek.com/v1' },
      { path: 'ai.apiKey', label: 'API Key', type: 'password', desc: '只存本机浏览器；127.0.0.1 / localhost 可留空。' },
      {
        path: 'ai.model', label: '模型名', type: 'combo', pull: true,
        models: function () { return MODEL_PRESETS[(cfg.ai || {}).provider] || []; },
        desc: '下拉选模型；「拉取」按当前接口 /models 取完整列表；列表里没有就选「自定义…」手填。'
      },
      { path: 'ai.temperature', label: 'temperature', type: 'number', step: '0.05', min: 0, max: 2 },
      { path: 'ai.maxTokens', label: 'max_tokens', type: 'number', min: 128, max: 32000, step: 128 },
      { path: 'ai.timeoutMs', label: '超时', type: 'number', min: 5000, max: 600000, step: 1000, unit: 'ms' },
      { path: 'ai.jsonMode', label: '使用 JSON 模式', type: 'bool', desc: '接口不支持 response_format 时必须关。' },
      { path: 'ai.extraHeaders', label: '额外请求头', type: 'textarea', desc: '每行一个，格式 key: value。部分中转 / 自建服务需要。' },
      { path: 'ai.systemPrompt', label: '自定义系统提示词', type: 'textarea', desc: '留空用内置提示词；填写则完全覆盖。' }
    ]
  },
  {
    key: 'qtext', title: '题目原文',
    tip: '题目字体被站点加密（.font-cxsecret）时，浮窗里这个按钮能把题干和选项还原成明文：一键复制、按题号跳转、直接搜索。没还原的字显示成 □，面板底部会写还剩几个。',
    fields: [
      {
        path: 'ui.questionCopy', label: '浮窗「题目原文」按钮', type: 'bool',
        desc: '点它弹出面板：当前题目（含字体加密的）还原成明文，可一键复制、按题号跳转、直接搜索。',
        help: '面板里的「跳转」会把页面滚到那道题并描边 1.5 秒；「搜索」按下面的模板新开一个标签页。题目在子帧里也能收（跨帧拼成一份、连续编号）。'
      },
      {
        path: 'ui.copyScope', label: '复制内容', type: 'select',
        options: [['both', '题干 + 选项（默认）'], ['stem', '只要题干']],
        desc: '面板里「复制 / 一键复制 / 搜索时顺带复制」都按这一项；搜索框里的关键词始终只用题干，不受它影响。',
        help: '粘去搜索用「只要题干」更干净；要拿去问 AI 就留「题干 + 选项」。'
      },
      {
        path: 'ui.searchUrl', label: '搜索题目模板', type: 'text',
        desc: '必须含 %s（题干会 URL 编码后填进去）。默认百度；Bing：https://www.bing.com/search?q=%s ；Google：https://www.google.com/search?q=%s',
        help: '可以换成校内平台或自己常用的搜题站，只要带 %s 就行。模板不合格时自动退回百度。'
      },
      { path: 'ui.searchCopy', label: '搜索时同时复制题干', type: 'bool', desc: '打开搜索页的同时把题干写进剪贴板，方便粘到搜题站 / 群里。' }
    ]
  },
  {
    key: 'ui', title: '界面',
    fields: [
      { path: 'ui.hud', label: '页面悬浮状态卡', type: 'bool', desc: '页面右下角的状态卡：阶段、日志、暂停、诊断。', help: '已知：关掉后要刷新页面它才消失。' }
    ]
  }
];

/* 调试：一般使用不会碰，排查 / 开发时才用 */
const DEBUG_SWITCH = {
  path: 'ui.debugMode', label: '调试模式', type: 'bool',
  desc: '打开后才出现下面的日志、字体样本采集器、开发项。',
  help: '默认关。关着时这些项不会生成，页面上翻不到。'
};

const DEBUG_FIELDS = [
  {
    path: 'ui.logLevel', label: '日志级别', type: 'select',
    options: [['debug', 'debug（带结构探针，最啰嗦）'], ['info', 'info（默认）'], ['warn', 'warn'], ['error', 'error']]
  },
  { path: 'samples.enabled', label: '字体样本采集器', type: 'bool', desc: '进未提交的测验页自动抓加密字体、算字形指纹并入库。', help: '给字体破解 / 加字典用；交卷后页面是明文，采不到。' },
  { path: 'dev.autoReload', label: '改代码后自动重载扩展', type: 'bool', danger: true, desc: '每 8 秒扫一遍源码，变了就重载扩展 —— 会打断正在跑的答题 / 提交。' },
  { path: 'dev.cmdBridge', label: '本地命令桥', type: 'bool', danger: true, desc: '每 1.2 秒向下面的地址取一次命令（配合 tools/_cmd-bridge.mjs）。相当于本机后门。' },
  {
    path: 'dev.cmdBridgeUrl', label: '命令桥地址', type: 'text', placeholder: '留空就不轮询',
    desc: '留空＝完全不轮询（默认就是空）。只填你自己的调试服务地址，别填别人的。',
    help: '只接受 http/https。开关打开但地址空着时不会联网，日志里会提示一次。示例地址见使用说明，这里不预填。'
  }
];

/* ---------------- 渲染 ---------------- */

function fieldHTML(f, uid) {
  const id = 'f_' + uid;
  const val = getPath(cfg, f.path);
  let ctl = '';
  if (f.type === 'bool') {
    ctl = '<label class="sw"><input type="checkbox" id="' + id + '"' + (val ? ' checked' : '') +
      ' data-path="' + esc(f.path) + '" data-type="bool"><span></span></label>';
  } else if (f.type === 'select') {
    ctl = '<select id="' + id + '" data-path="' + esc(f.path) + '" data-type="string">' +
      (f.options || []).map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>';
  } else if (f.type === 'textarea') {
    ctl = '<textarea id="' + id + '" data-path="' + esc(f.path) + '" data-type="string">' + esc(val || '') + '</textarea>';
  } else if (f.type === 'combo') {
    /* 下拉选模型 + 「自定义…」手填 + 「拉取」按接口 /models 取全量 */
    const cur = val === undefined ? '' : String(val);
    const preset = (typeof f.models === 'function') ? f.models() : (f.options || []);
    const pool = Array.from(new Set([].concat(preset, modelCache).filter(Boolean)));
    const isCustom = pool.indexOf(cur) < 0;
    ctl = '<select class="combo-sel" data-combo="' + esc(f.path) + '">' +
      pool.map(function (o) {
        return '<option value="' + esc(o) + '"' + (!isCustom && o === cur ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') +
      '<option value="__custom__"' + (isCustom ? ' selected' : '') + '>自定义…</option>' +
      '</select>' +
      '<input class="combo-inp" type="text" id="' + id + '" value="' + esc(cur) + '"' +
      (isCustom ? '' : ' hidden') +
      ' data-path="' + esc(f.path) + '" data-type="string" data-combo-inp="1"' +
      ' placeholder="手动填模型名" autocomplete="off" spellcheck="false">' +
      (f.pull ? '<button type="button" class="ghost sm" data-act="pull-models" title="按当前 Base URL 调 /models 取模型列表">拉取</button>' : '');
  } else {
    const attrs = [
      'type="' + esc(f.type) + '"',
      'id="' + id + '"',
      'value="' + esc(val === undefined ? '' : val) + '"',
      'data-path="' + esc(f.path) + '"',
      'data-type="' + (f.type === 'number' ? 'number' : 'string') + '"',
      'step="' + esc(f.step || 'any') + '"',
      /* 关掉浏览器自动填充/历史建议：否则输入框下面会浮出一层灰灰的旧地址 */
      'autocomplete="' + (f.type === 'password' ? 'new-password' : 'off') + '"',
      'name="cx-' + esc(f.path.replace(/\./g, '-')) + '"',
      'spellcheck="false"'
    ];
    if (f.min != null) attrs.push('min="' + esc(f.min) + '"');
    if (f.max != null) attrs.push('max="' + esc(f.max) + '"');
    if (f.placeholder) attrs.push('placeholder="' + esc(f.placeholder) + '"');
    ctl = '<input ' + attrs.join(' ') + '>';
  }
  /* 2026-11-06：AI 关着却选了「AI 优先」—— 提示就贴在这个下拉框正下方，
   * 挂在页面顶部没人看得见（用户原话）。改「作答方式」或 AI 总开关时会重绘。 */
  let warn = '';
  if ((f.path === 'exam.mode' || f.path === 'videoQuiz.mode') && String(val) === 'ai-first' &&
      cfg.ai && cfg.ai.enabled === false) {
    warn = '<div class="desc" style="color:#fbbf24;margin-top:6px">' +
      '⚠ AI 总开关是关的，这一项现在不会作答。去「AI 接口」打开「启用 AI 作答」，或把这里改成「暴力枚举」。</div>';
  }
  const hay = [f.label, f.desc || '', f.help || '', f.path, f.unit || ''].join(' ').toLowerCase();
  const cls = 'field' + (f.danger ? ' danger' : '') + (f.type === 'textarea' ? ' col' : '');
  return '<div class="' + cls + '" data-f="' + esc(hay) + '">' +
    '<div class="lab"><label for="' + id + '">' + esc(f.label) +
    (f.badge ? '<span class="pill">' + esc(f.badge) + '</span>' : '') +
    (f.unit ? '<span class="unit">' + esc(f.unit) + '</span>' : '') +
    (f.help ? '<span class="qh" title="' + esc(f.help) + '">?</span>' : '') +
    '</label>' + (f.desc ? '<div class="desc">' + esc(f.desc) + '</div>' : '') + '</div>' +
    '<div class="ctl">' + ctl + warn + '</div></div>';
}

const OPEN_KEY = 'cxOptOpen';
let restoring = false;

function loadOpen() {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch (e) { return new Set(); }
}
function saveOpen(set) {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(Array.from(set))); } catch (e) {}
}

function aiUnconfigured() {
  const ai = cfg.ai || {};
  return !ai.apiKey && !/127\.0\.0\.1|localhost/.test(String(ai.baseUrl || ''));
}

/* 「常用」里哪个开关管着这张卡 —— 卡片标题旁就标它现在开还是关；
 * 总开关（enabled）关着时这些卡实际都不执行，直接标「总开关关」。 */
const GATE = {
  play: { path: 'player.autoPlay', label: '自动播放' },
  nav: { path: 'nav.autoNext', label: '自动下一节' },
  quiz: { path: 'videoQuiz.enabled', label: '弹题自动答' },
  exam: { path: 'exam.enabled', label: '学习检测' },
  ui: { path: 'ui.hud', label: '页面浮窗' },
  /* 2026-11-03：题目原文/搜索不吃「自动学习总开关」，单独标开关状态 */
  qtext: { path: 'ui.questionCopy', label: '题目原文' }
};

function pill(on, text) {
  return '<span class="state ' + (on ? 'on' : 'off') + '">' + (text || (on ? '开' : '关')) + '</span>';
}

/* 标题旁的「常用开关状态」胶囊 */
function gateHTML(key) {
  const g = GATE[key];
  if (!g) {
    if (key === 'ai') {
      if (cfg.ai && cfg.ai.enabled === false) return '<span class="state off">AI 已关</span>';
      if (aiUnconfigured()) return '<span class="state bad">未配置</span>';
    }
    return '';
  }
  const masterOn = getPath(cfg, 'enabled') !== false;
  const on = getPath(cfg, g.path) !== false;
  /* 「界面」和「题目原文」不归总开关管，别跟着标「总开关关」 */
  if (!masterOn && key !== 'ui' && key !== 'qtext') {
    return '<span class="state blocked" title="自动学习总开关关着，这一项现在不执行">总开关关</span>';
  }
  return pill(on, esc(g.label) + (on ? ' 开' : ' 关'));
}

/* 标题右边那行「非开关」的取值摘要 */
function sectionNote(key) {
  const ka = cfg.keepAlive || {};
  const nv = cfg.nav || {};
  const vq = cfg.videoQuiz || {};
  const ex = cfg.exam || {};
  const modeName = function (m) {
    return m === 'brute' ? '暴力枚举' : m === 'skip' ? '跳过作答' : m === 'off' ? '不处理' : 'AI 优先';
  };
  if (key === 'play') return '倍速 ' + esc(String(Number(ka.rate) || 1)) + '×';
  if (key === 'nav') {
    return (nv.tocOnly === false ? '目录优先' : '只走目录') +
      (nv.skipLockedToc === false ? '' : ' · 未解锁往后找') +
      ' · 空页' + (nv.advanceWhenNoTask === false ? '停' : '跳过');
  }
  if (key === 'quiz') {
    return '作答 ' + esc(modeName(vq.mode)) +
      (cfg.ai && cfg.ai.enabled === false && vq.enabled !== false && (vq.mode || 'ai-first') === 'ai-first'
        ? ' · ⚠ AI 未开启' : '');
  }
  if (key === 'exam') {
    return (ex.enabled === false ? '不处理测验页' : '作答 ' + esc(modeName(ex.mode))) +
      ' · 最多 ' + esc(String(Number(ex.maxRounds) || 3)) + ' 轮' +
      (ex.allowRealExam === true ? ' · 正式考试也答' : '') +
      (cfg.ai && cfg.ai.enabled === false && ex.enabled !== false && (ex.mode || 'ai-first') === 'ai-first'
        ? ' · ⚠ AI 未开启' : '');
  }
  if (key === 'ai') {
    if (cfg.ai && cfg.ai.enabled === false) return '已关闭（改用暴力枚举）';
    if (aiUnconfigured()) return '答题会失败';
    const p = CFG.PROVIDERS[(cfg.ai || {}).provider] || {};
    return esc(p.label || '自定义') + ' · ' + esc((cfg.ai || {}).model || '未填模型');
  }
  if (key === 'qtext') {
    const on = getPath(cfg, 'ui.questionCopy') !== false;
    let host = '百度';
    try {
      const u = new URL(String(getPath(cfg, 'ui.searchUrl') || ''));
      host = /baidu\.com$/i.test(u.hostname) ? '百度'
        : /bing\.com$/i.test(u.hostname) ? 'Bing'
          : /google\.com$/i.test(u.hostname) ? 'Google'
            : u.hostname;
    } catch (e) { host = '模板无效'; }
    return '浮窗按钮 ' + (on ? '开' : '关') + ' · 搜索 ' + esc(host);
  }
  return '';
}

function render() {
  /* 常用卡：总开关 + 它管的四项（缩进成子项） + 不受它控制的一项 */
  $('quick').innerHTML =
    '<div class="masterBlock">' + fieldHTML(MASTER_FIELD, 'm') + '</div>' +
    '<div class="sublist" id="sublist">' +
    GOVERNED_FIELDS.map(function (f, i) { return fieldHTML(f, 'g' + i); }).join('') +
    '</div>' +
    INDEP_FIELDS.map(function (f, i) {
      /* 这一项不吃总开关，直接在标题后挂个标签，不再单起一段「不受总开关控制」 */
      return fieldHTML(Object.assign({}, f, { badge: '不受总开关控制' }), 'i' + i);
    }).join('') +
    '<div class="tip">切到别的窗口仍会暂停？Edge → 设置 → 系统和性能 → 关掉「使用睡眠标签页节省资源」' +
    '（Chrome：chrome://settings/performance）。这是浏览器策略，插件改不了，只能手动关一次。</div>';

  $('sections').innerHTML = SECTIONS.map(function (sec, si) {
    return '<details class="card" data-open-id="' + sec.key + '" data-key="' + sec.key + '">' +
      '<summary><span class="st">' + esc(sec.title) + '</span>' +
      '<span class="gate">' + gateHTML(sec.key) + '</span>' +
      '<span class="tag">' + sec.fields.length + ' 项</span>' +
      '<span class="subline">' + sectionNote(sec.key) + '</span></summary>' +
      '<div class="cardbody">' +
      sec.fields.map(function (f, i) { return fieldHTML(f, 's' + si + '_' + i); }).join('') +
      '</div>' + (sec.tip ? '<div class="tip">' + esc(sec.tip) + '</div>' : '') + '</details>';
  }).join('');

  renderDebug();
  restoreOpenState();
  applyFilter(currentQ);
  syncAiCard();
  syncUI();
}

/* 主开关关着时把子项压暗（只是视觉，值不动）；顺便刷新各卡标题旁的常用开关状态 */
function syncUI() {
  const sub = $('sublist');
  if (sub) sub.classList.toggle('dim', getPath(cfg, 'enabled') === false);
  SECTIONS.forEach(function (sec) {
    const card = sectionEl(sec.key);
    if (!card || !card.querySelector) return;
    const gate = card.querySelector('.gate');
    if (gate) gate.innerHTML = gateHTML(sec.key);
    const note = card.querySelector('.subline');
    if (note) note.innerHTML = sectionNote(sec.key);
  });
}

function renderDebug() {
  const dbg = !!getPath(cfg, 'ui.debugMode');
  $('debugSwitch').innerHTML = fieldHTML(DEBUG_SWITCH, 'dbgswitch');
  $('debugExtra').hidden = !dbg;
  $('debugFields').innerHTML = dbg
    ? DEBUG_FIELDS.map(function (f, i) { return fieldHTML(f, 'd' + i); }).join('')
    : '';
  if (dbg) loadLogs();
}

function sectionEl(key) {
  return document.querySelector('details[data-key="' + key + '"]');
}

function restoreOpenState() {
  const open = loadOpen();
  restoring = true;
  Array.prototype.forEach.call(document.querySelectorAll('details[data-open-id]'), function (d) {
    const id = d.getAttribute('data-open-id');
    if (id === 'debug') d.open = open.has('debug') || !!getPath(cfg, 'ui.debugMode');
    else d.open = open.has(id);
  });
  restoring = false;
}

function syncAiCard() {
  const ai = sectionEl('ai');
  if (!ai) return;
  const bad = aiUnconfigured();
  ai.classList.toggle('warncard', bad);
  const tag = ai.querySelector('.tag');
  if (tag && bad) tag.textContent = '未配置';
  if (bad && !currentQ) ai.open = true;
}

/* 搜索：只做显示过滤，不移除节点，值不会丢 */
let currentQ = '';
function applyFilter(q) {
  currentQ = String(q || '');
  const needle = currentQ.trim().toLowerCase();
  const rows = Array.prototype.slice.call(document.querySelectorAll('.field[data-f]'));

  rows.forEach(function (row) {
    if (!needle) { row.hidden = false; return; }
    row.hidden = (row.getAttribute('data-f') || '').indexOf(needle) < 0;
  });

  Array.prototype.forEach.call(document.querySelectorAll('#quickCard, #sections > details, #debugCard'), function (card) {
    const all = card.querySelectorAll('.field[data-f]');
    let vis = 0;
    for (let i = 0; i < all.length; i++) if (!all[i].hidden) vis++;
    card.hidden = !!needle && vis === 0;
    if (needle) card.open = true;
  });

  let any = false;
  rows.forEach(function (row) {
    if (row.hidden) return;
    if (row.closest('details[hidden]')) return;
    any = true;
  });
  $('emptyHint').hidden = !needle || any;
  /* 搜索时把「数据与备份」这类跟搜索无关的卡也收起来，页面只留命中项 */
  const dataCard = $('dataCard');
  if (dataCard) dataCard.hidden = !!needle;
  if (!needle) restoreOpenState();
}

/* ---------------- 事件 ---------------- */

document.addEventListener('change', function (e) {
  const el = e.target;
  if (!el || !el.getAttribute) return;

  /* 模型下拉：选了具体模型就直接写；选「自定义…」只把输入框亮出来 */
  const comboPath = el.getAttribute('data-combo');
  if (comboPath) {
    const row = el.closest ? el.closest('.ctl') : null;
    const inp = row && row.querySelector ? row.querySelector('.combo-inp') : null;
    const v = el.value;
    if (v === '__custom__') {
      if (inp) { inp.hidden = false; try { inp.focus(); } catch (err) {} }
      return;
    }
    if (inp) { inp.hidden = true; inp.value = v; }
    setPath(cfg, comboPath, v);
    autoSave([comboPath, v]);
    syncUI();
    return;
  }

  const path = el.getAttribute('data-path');
  if (!path) return;
  const type = el.getAttribute('data-type');
  let v;
  if (type === 'bool') v = el.checked;
  else if (type === 'number') v = el.value === '' ? 0 : Number(el.value);
  else v = el.value;

  setPath(cfg, path, v);

  /* 手填模型名之后把下拉回正：命中预设就切到预设（并收起输入框），否则停在「自定义…」 */
  if (el.getAttribute('data-combo-inp') && el.closest) {
    const row = el.closest('.ctl');
    const sel = row && row.querySelector ? row.querySelector('.combo-sel') : null;
    if (sel) {
      let hit = false;
      Array.prototype.forEach.call(sel.options, function (o) {
        if (!hit && o.value === v && o.value !== '__custom__') hit = true;
      });
      sel.value = hit ? v : '__custom__';
      if (hit) el.hidden = true;
    }
  }

  if (path === 'ai.provider') { applyProvider(v); return; }

  /* 命令桥：地址空就不轮询，格式错也不轮询 —— 这两种都要当场说清楚，不能只写「已保存」 */
  if (path === 'dev.cmdBridgeUrl' || path === 'dev.cmdBridge') {
    autoSave([path, v], true);
    syncUI();
    const url = String((cfg.dev || {}).cmdBridgeUrl || '').trim();
    if (path === 'dev.cmdBridgeUrl' && url && !/^https?:\/\//i.test(url)) {
      setHint('命令桥地址必须以 http:// 或 https:// 开头，否则后台不会轮询', true);
    } else if (path === 'dev.cmdBridge' && v === true && !url) {
      setHint('命令桥已打开，但地址还空着 —— 填一个地址才会真正轮询（示例地址见使用说明）', true);
      try {
        const inp = document.querySelector('[data-path="dev.cmdBridgeUrl"]');
        if (inp) inp.focus();
      } catch (e) {}
    } else {
      /* 不在这里回显地址本身：设置页没必要再把你的地址抄一遍 */
      setHint(url ? '命令桥地址已保存（开关打开时才轮询）' : '命令桥：地址为空，不轮询', !url);
    }
    return;
  }

  autoSave([path, v]);
  syncUI();
  if (path === 'ui.debugMode') { render(); return; }
  /* 改了「作答方式」或 AI 总开关 → 立刻重绘，让下拉框下面那句「AI 关着不会作答」跟着出现/消失 */
  if (path === 'ai.enabled' || path === 'exam.mode' || path === 'videoQuiz.mode') { render(); return; }
});

/* 分区展开状态记忆（searching 时不记） */
document.addEventListener('toggle', function (e) {
  const d = e.target;
  if (!d || d.tagName !== 'DETAILS' || !d.getAttribute) return;
  const id = d.getAttribute('data-open-id');
  if (!id || restoring || currentQ) return;
  const set = loadOpen();
  if (d.open) set.add(id); else set.delete(id);
  saveOpen(set);
}, true);

function applyProvider(key) {
  const p = CFG.PROVIDERS[key];
  if (!p) return;
  if (p.baseUrl) setPath(cfg, 'ai.baseUrl', p.baseUrl);
  if (p.model) setPath(cfg, 'ai.model', p.model);
  setPath(cfg, 'ai.jsonMode', !!p.jsonMode);
  modelCache = [];                 /* 换服务商了，上一家拉回来的模型清掉 */
  render();
  autoSave([['ai.baseUrl', cfg.ai.baseUrl], ['ai.model', cfg.ai.model], ['ai.jsonMode', cfg.ai.jsonMode]], true);
}

/* 「拉取」：直接问当前接口 GET {baseUrl}/models。用的是扩展页自己的 host 权限，
 * 不经过 background，也不新增消息通道。失败就提示手填。 */
function pullModels(btn) {
  const ai = cfg.ai || {};
  const base = String(ai.baseUrl || '').replace(/\/+$/, '');
  if (!base) { setHint('先填 Base URL 再拉取', true); return; }
  if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
  setHint('正在向 ' + base + '/models 请求模型列表…');
  const headers = {};
  if (ai.apiKey) headers.Authorization = 'Bearer ' + ai.apiKey;
  fetch(base + '/models', { headers: headers })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (j) {
      const arr = (j && (j.data || j.models)) || [];
      const list = arr.map(function (m) { return typeof m === 'string' ? m : (m.id || m.name || m.model); })
        .filter(Boolean);
      if (!list.length) throw new Error('返回里没有模型字段');
      modelCache = list;
      render();
      setHint('已获取 ' + list.length + ' 个模型，点模型名输入框可下拉选择');
    })
    .catch(function (e) {
      setHint('拉取失败：' + ((e && e.message) || e) + '（接口可能不提供 /models，直接手填模型名即可）', true);
    })
    .finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '拉取'; }
    });
}

function setHint(text, isErr) {
  const el = $('saveHint');
  el.textContent = text;
  el.className = 'hint' + (isErr ? ' err' : '');
}

document.addEventListener('click', function (e) {
  const t = e.target;
  const btn = t && t.closest ? t.closest('[data-act="pull-models"]') : null;
  if (!btn) return;
  e.preventDefault();
  pullModels(btn);
});

/* ---------------- 保存 ----------------
 * 2026-10-30：改成「读最新 → 只改本次动的那几个字段 → 写回」。
 * 原来是把内存里的整份 cfg 写回去；这期间别处（浮窗 / 弹窗 / 另一个设置页）改过配置，
 * 就会被这份旧快照覆盖 —— 典型症状：总开关在别处关掉，回设置页随便改一项，
 * 它又自己变回「开」，日志里一堆「已重新启用」。 */
let saveChain = Promise.resolve();
let lastWritten = '';     /* 自己刚写的那份，用于在 onChanged 里跳过自我触发的重绘 */
function savePatch(mutator) {
  saveChain = saveChain.then(function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(['cxConfig'], function (res) {
        const cur = CFG.normalize(res && res.cxConfig);
        try { mutator(cur); } catch (e) {}
        const next = CFG.normalize(cur);
        lastWritten = JSON.stringify(next);
        chrome.storage.local.set({ cxConfig: next }, function () { resolve(); });
      });
    });
  }).catch(function () {});
  return saveChain;
}

let saveTimer = 0;
let pendingOps = [];
/* ops 可以是 [path, value]，也可以是 [[path,value], …] */
function autoSave(ops, silent) {
  if (ops) {
    (Array.isArray(ops[0]) ? ops : [ops]).forEach(function (op) { pendingOps.push(op); });
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    const list = pendingOps;
    pendingOps = [];
    savePatch(function (cur) {
      list.forEach(function (op) { setPath(cur, op[0], op[1]); });
    }).then(function () {
      if (silent) return;
      $('saveHint').textContent = '已保存 ' + new Date().toTimeString().slice(0, 8);
      setTimeout(function () {
        if ($('saveHint').textContent.indexOf('已保存') === 0) $('saveHint').textContent = '';
      }, 2200);
    });
  }, 300);
}

/* 搜索框 */
$('q').addEventListener('input', function (e) { applyFilter(e.target.value); });
$('q').addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { e.target.value = ''; applyFilter(''); }
});

/* 顶部按钮 */
$('btn-save').addEventListener('click', function () {
  /* 「保存」= 把本页显示的全部写下去：先读最新的那一份，再覆盖本页拥有的键，
   * 这样别处新增/修改的键不会被这份页面快照冲掉。 */
  const snapshot = CFG.normalize(cfg);
  savePatch(function (cur) {
    Object.keys(snapshot).forEach(function (k) { cur[k] = snapshot[k]; });
  }).then(function () {
    $('saveHint').textContent = '设置已保存，页面自动生效（无需刷新）';
    setTimeout(function () { $('saveHint').textContent = ''; }, 3000);
  });
});

$('btn-test').addEventListener('click', function () {
  /* 只写 AI 这几个字段，别把整份配置带回去 */
  const ai = CFG.normalize(cfg).ai;
  savePatch(function (cur) {
    cur.ai = CFG.merge(cur.ai || {}, {
      baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, jsonMode: ai.jsonMode
    });
  }).then(function () {
    $('saveHint').textContent = '正在测试 AI 连接…';
    chrome.runtime.sendMessage({ kind: 'ai', action: 'chat', payload: { task: 'ping' } }, function (res) {
      if (chrome.runtime.lastError) { $('saveHint').textContent = '连接失败：' + chrome.runtime.lastError.message; return; }
      if (res && res.ok) $('saveHint').textContent = '连接正常，模型 ' + (res.model || ai.model) + '，耗时 ' + (res.ms || 0) + 'ms';
      else $('saveHint').textContent = '连接失败：' + ((res && res.error) || '未知错误');
    });
  });
});

/* 数据与备份 */
$('btn-default').addEventListener('click', function () {
  if (!confirm('恢复默认会把所有设置（包括 API Key）重置，确定？')) return;
  cfg = CFG.normalize(null);
  chrome.storage.local.set({ cxConfig: cfg }, function () { render(); $('saveHint').textContent = '已恢复默认设置'; });
});

$('btn-export').addEventListener('click', function () {
  cfg = CFG.normalize(cfg);
  /* 2026-10-31：导出前把 API Key 脱敏。以前原样导出，贴到 issue / 群里就直接漏 Key。
   * 导入时见到 "***" 会保留本机原来的 Key（见导入处理）。 */
  const dump = CFG.clone(cfg);
  if (dump.ai && dump.ai.apiKey) dump.ai.apiKey = '***';
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'chaoxing-assistant-config.json';
  a.click();
});

$('btn-import').addEventListener('click', function () { $('file-import').click(); });
$('file-import').addEventListener('change', function (e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = function () {
    try {
      const obj = JSON.parse(r.result);
      /* 导出的配置里 Key 是 "***"：保留本机原来的 Key，不要被占位符覆盖 */
      if (obj && obj.ai && obj.ai.apiKey === '***') {
        const keep = (cfg && cfg.ai && cfg.ai.apiKey) || '';
        obj.ai.apiKey = keep;
      }
      cfg = CFG.normalize(obj);
      chrome.storage.local.set({ cxConfig: cfg }, function () { render(); $('saveHint').textContent = '已导入配置'; });
    } catch (err) { $('saveHint').textContent = '导入失败：JSON 解析错误'; }
  };
  r.readAsText(f);
});

$('btn-clearbank').addEventListener('click', function () {
  if (!confirm('清空「同题干答对后缓存」的答案？不影响配置和字体样本。')) return;
  chrome.storage.local.remove(['cxAnswerBank'], function () { $('saveHint').textContent = '已清空答案缓存'; });
});

/* 日志（在「调试」里） */
$('btn-refresh-log').addEventListener('click', loadLogs);
$('btn-clear-log').addEventListener('click', function () {
  chrome.storage.session.set({ cxLogs: [] });
  $('logs').textContent = '暂无日志';
});

function loadLogs() {
  chrome.storage.session.get(['cxLogs'], function (res) {
    const logs = res.cxLogs || [];
    $('logs').textContent = logs.slice(-200).map(function (l) {
      const t = new Date(l.ts || Date.now()).toTimeString().slice(0, 8);
      return '[' + t + '] ' + String(l.level || 'info').toUpperCase() + ' ' + (l.scope || '') + ' ' + (l.text || '');
    }).join('\n') || '暂无日志';
  });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'session' && changes.cxLogs) loadLogs();
  if (area === 'local' && changes.cxConfig) {
    const next = CFG.normalize(changes.cxConfig.newValue);
    /* 自己刚写的那一份不用重绘（避免每改一项就整页重建、滚动条乱跳） */
    if (JSON.stringify(next) === lastWritten) { cfg = next; return; }
    cfg = next;
    if (isEditing()) { staleUI = true; return; }   /* 正在输入：别抢焦点，失焦后再刷新 */
    render();
  }
});

/* 外部改配置（浮窗 / 弹窗 / 另一个设置页）时同步本页，避免拿着旧快照覆盖回去 */
let staleUI = false;
function isEditing() {
  try {
    const a = document.activeElement;
    if (!a || !/^(INPUT|SELECT|TEXTAREA)$/.test(String(a.tagName || ''))) return false;
    return !!(a.closest && a.closest('#quick, #sections'));
  } catch (e) { return false; }
}
document.addEventListener('focusout', function () {
  if (!staleUI) return;
  staleUI = false;
  setTimeout(function () { if (!isEditing()) render(); }, 0);
}, true);

/* ---------------- 初始化 ---------------- */
chrome.storage.local.get(['cxConfig'], function (res) {
  cfg = CFG.normalize(res.cxConfig);
  render();
  loadLogs();
});
