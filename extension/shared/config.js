/* 共享默认配置（content script / background / popup / options 都会加载） */
(function (root) {
  'use strict';

  const PROVIDERS = {
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      jsonMode: true
    },
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      jsonMode: true
    },
    qwen: {
      label: '通义千问（DashScope 兼容模式）',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      jsonMode: true
    },
    kimi: {
      label: 'Kimi（Moonshot）',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
      jsonMode: false
    },
    zhipu: {
      label: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash',
      jsonMode: false
    },
    ollama: {
      label: '本地 Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      jsonMode: false
    },
    custom: {
      label: '自定义（OpenAI 兼容）',
      baseUrl: '',
      model: '',
      jsonMode: false
    }
  };

  const DEFAULTS = {
    version: 5,
    /* 总开关：关掉后所有自动化停止（防暂停仍生效可选） */
    enabled: true,
    /* 防暂停 / 后台播放 */
    keepAlive: {
      enabled: true,          // 伪造 visible + 拦 mouseout + 丢 videojs_id cookie
      blockAutoPause: true,   // 视频暂停即续播看门狗
      volumeSilent: true,     // 用 volume=0 代替 muted（内核隐藏不暂停的关键）
      mirrorIfNoAudio: true,  // 无音轨视频挂 captureStream 保活镜像
      rate: 1                 // 播放倍速（学习通一般锁 1，改了可能判异常）
    },
    /* 视频播放 */
    player: {
      autoPlay: true,         // 进入未完成任务自动播放
      resumeAfterPause: true, // 被站点暂停后自动续播
      finishGraceMs: 1500,    // ended 后等多久再判定学完
    },
    /* 视频内弹题 */
    videoQuiz: {
      enabled: true,
      mode: 'ai-first',       // ai-first | brute | off
      autoContinue: true,     // 答对后自动点「继续学习」并恢复播放
      maxAiRounds: 3,         // AI 答错重问次数
      bruteMaxTries: 10,      // 暴力模式最多尝试次数
      submitWaitMs: 260,      // 选择后等多久再点提交
      wrongCoolMs: 120,       // 答错后的冷却
      tickMs: 350             // 弹题轮询间隔（越小枚举越快）
    },
    /* 开发自愈 / 调试通道：默认全关。
     * 这两项以前是常开的：每 8 秒扫一遍源码、变了就 chrome.runtime.reload()，
     * 外加每 1.2 秒轮询本机 8765 —— 重载会把正在跑的答题/提交直接打断。 */
    dev: {
      autoReload: false,      // 改完代码自动重载扩展（开发时手动开）
      cmdBridge: false,       // 本地命令桥轮询总开关（默认关）
      /* 命令桥地址。默认空 = 完全不轮询；要本机调试自己填，例如 http://127.0.0.1:8765
       * 2026-10-30：以前写死在 background.js 里，发布包会带上这个端口，改成可配置。 */
      cmdBridgeUrl: ''
    },
    /* 章节跳转 */
    nav: {
      autoNext: true,         // 学完自动下一节
      nextDelayMs: 2500,      // 点下一节前等待
      unlockWaitMs: 8000,     // 遇到闯关解锁等待时间
      maxStuckReloads: 3,     // 卡住自动刷新次数
      skipEmptyPage: true,
      advanceWhenNoTask: true,   // 无任务点的空页面也自动跳过（2026-10-28 接线；关掉会停在空页等人）
      useToc: true,           // 优先点右侧目录里的下一章（比「下一节」按钮稳）
      tocOnly: true,          // 只走目录切章，不点「下一节」按钮
      /* 2026-11-03：目录标记智能跳章。
       * 真机目录的三种标记：绿勾=任务点已完成、黄色数字=有任务点未完成（数字是 0 也算没完成）、
       * 灰旗=未解锁（这类行连 onclick 都没有）。打开后：下一项没完成但锁着时，继续往后找
       * 「第一项既没绿勾也没灰旗」的章节；后面只剩绿勾/灰旗 → 停止，不再原地重试。 */
      skipLockedToc: true,
      /* 没有任务点、只有视频的页面怎么处理：
       *   'watch' = 看完再继续（默认，保持原行为）
       *   'skip'  = 这页站点不记任务点，视频不用看，直接跳到下一节 */
      videoOnlyMode: 'watch',
      stopAtCourseEnd: true,
      endConfirmMs: 12000,    // 没有下一章 / 没有「下一节」按钮持续这么久 → 判定课程结束（默认 12 秒）
    },
    /* 学习检测 / 章节测验 / 作业 */
    exam: {
      /* 2026-11-04：这一项只管「要不要碰测验页」：
       *   false = 完全不处理（导航连任务条上的测验入口都不点，任务点做完直接切下一章）
       *   true  = 按下面的 mode 处理 */
      enabled: true,
      /* 作答方式：
       *   'ai-first' = 先问 AI，失败退回枚举
       *   'brute'    = 不调 AI，按组合枚举
       *   'skip'     = 进测验页但不作答，进去就交给导航切下一章（用户要的「进去一下」）
       * 另外：AI 总开关（ai.enabled）关掉时，'ai-first' 会按 'brute' 跑。 */
      mode: 'ai-first',
      passScore: 60,          // 仅历史兼容：2026-10-28 起通过判定改为「看学习测验任务点是否完成」，不再用分数
      maxRounds: 3,           // 最多提交轮数（实测连打 4 轮就会把学习页主线程打死）
      maxAiRounds: 2,         // AI 连续这么多轮没过就联网检索重答
      maxSearchQuestions: 3,  // 联网检索最多查几道错题
      useWebSearch: true,     // 未通过后允许联网检索
      wrongOnlyRetry: true,   // 只重做错题
      randomDelayMs: 300,     // 每题选择间隔，避免机械感
      submitConfirm: true,    // 自动点确认弹窗
      allowRealExam: false,   // 正式考试页（exam-ans）是否也自动作答
      /* 2026-10-31：轮数用尽仍没过 → 放弃本节，交给导航切下一章（不再死卡在这一节） */
      giveUpToNext: true
    },
    /* AI 接口 */
    ai: {
      /* 2026-11-04：AI 总开关。AI 不只服务学习检测，视频弹题也用它 ——
       * 关掉后两边都退回暴力枚举（仍会作答，只是不联网、不花 token）。 */
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 1600,
      timeoutMs: 90000,
      jsonMode: true,
      extraHeaders: '',       // 每行 key: value
      systemPrompt: ''
    },
    /* 字体加密样本采集器：样本与字形字典存在扩展本地，不需要本地服务。
     * 2026-11-03：默认值从 true 改成 false —— 用户在设置页「调试」卡里看到的开关，
     * 初次安装（空存储）必须全是关的。要采集就手动打开（设置页或采集面板的 ⏻ 按钮）。 */
    samples: {
      enabled: false
    },
    /* 界面 */
    ui: {
      hud: true,              // 页面悬浮状态卡
      /* 2026-11-03：浮窗里的「题目原文」按钮 —— 把题目还原成明文，可复制 / 跳转 / 搜索 */
      questionCopy: true,
      /* 搜索题目用的 URL 模板，必须含 %s（题干会 URL 编码后填进去） */
      searchUrl: 'https://www.baidu.com/s?wd=%s',
      searchCopy: false,      // 点「搜索」时顺手把题干写进剪贴板（往搜题站里粘时开）
      /* 复制内容：'both' = 题干 + 选项；'stem' = 只要题干（粘去搜索时更干净） */
      copyScope: 'both',
      hudPosition: { right: 16, bottom: 96 },
      logLevel: 'info'        // debug | info | warn | error
    }
  };

  function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  /* 深合并：用户配置覆盖默认值，缺字段自动补默认 */
  function merge(base, patch) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!isPlainObject(patch)) return out;
    Object.keys(patch).forEach(function (k) {
      const pv = patch[k];
      if (isPlainObject(pv) && isPlainObject(out[k])) out[k] = merge(out[k], pv);
      else if (pv !== undefined) out[k] = pv;
    });
    return out;
  }

  const api = {
    PROVIDERS: PROVIDERS,
    DEFAULTS: DEFAULTS,
    merge: merge,
    clone: function (v) { return JSON.parse(JSON.stringify(v)); },
    normalize: function (saved) {
      const out = merge(DEFAULTS, saved || {});
      /* v1 → v2 迁移：把「还停在旧默认值」的轮次降下来。
       * 实测连打 4 轮提交就会把学习页主线程打死（站点混淆脚本 _0x12c153 无限递归），
       * 而且提交次数越多越容易撞上站点的配额与验证码。
       * 只改旧默认值（10 / 3），用户自己调过的数字不动。 */
      if (!out.version || out.version < 2) {
        if (out.exam && out.exam.maxRounds === 10) out.exam.maxRounds = 3;
        if (out.exam && out.exam.maxAiRounds === 3) out.exam.maxAiRounds = 2;
        out.version = 2;
      }
      /* v2 → v3（2026-10-28）：开发探针改成开关且默认关。
       * 老配置里很可能存着 autoReload:true（当时是默认值），这里强制关一次；
       * 以后想开可以在设置页「开发 / 调试」里重新打开。
       * 同时把 nav.advanceWhenNoTask 改回 true —— 这个开关以前没有任何代码读，
       * 老配置里的 false 就是旧默认值，不是用户的选择；接线后 false 会卡在空章节。 */
      if (!out.version || out.version < 3) {
        if (!out.dev || typeof out.dev !== 'object') out.dev = {};
        out.dev.autoReload = false;
        out.dev.cmdBridge = false;
        if (!out.nav || typeof out.nav !== 'object') out.nav = {};
        if (out.nav.advanceWhenNoTask === false) out.nav.advanceWhenNoTask = true;
        out.version = 3;
      }
      /* v3 → v4（2026-11-03）：调试卡里的开关一律默认关。
       * 采集器以前默认 true，老配置里那个 true 就是旧默认值、不是用户的选择，
       * 这里强制关一次（跟 v2→v3 处理 dev.* 的做法一致）；想采集再手动开。
       * 新增 exam.skipAnswering（跳过学习检测：进页面但不作答），默认 false，老配置补上即可。 */
      if (!out.version || out.version < 4) {
        if (!out.samples || typeof out.samples !== 'object') out.samples = {};
        out.samples.enabled = false;
        out.version = 4;
      }
      /* v4 → v5（2026-11-04）：
       *   · 「跳过学习检测」从独立开关（exam.skipAnswering）并进 exam.mode，取值 'skip'；
       *   · 新增 AI 总开关 ai.enabled（同时管视频弹题与学习检测）；
       *   · exam.mode 统一收敛到 ai-first / brute / skip（以前注释里写的 'off' 从没实现过）。 */
      if (!out.version || out.version < 5) {
        if (!out.exam || typeof out.exam !== 'object') out.exam = {};
        if (out.exam.skipAnswering === true) out.exam.mode = 'skip';
        delete out.exam.skipAnswering;
        if (!out.ai || typeof out.ai !== 'object') out.ai = {};
        if (out.ai.enabled === undefined) out.ai.enabled = true;
        out.version = 5;
      }
      /* 收敛作答方式：认不出的值一律回 ai-first */
      if (!out.exam || typeof out.exam !== 'object') out.exam = {};
      if (['ai-first', 'brute', 'skip'].indexOf(out.exam.mode) < 0) out.exam.mode = 'ai-first';
      return out;
    }
  };

  root.CXConfig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
