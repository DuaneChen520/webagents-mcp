/**
 * WebAgents — background service worker
 *
 * 职责：
 * 1. 与本地 WS 桥接（ws://127.0.0.1:8765）之间收发消息 —— **连接本身由 offscreen 文档持有**，
 *    见 offscreen.js；SW 只在需要收发时被唤醒（v0.4.0 起）
 * 2. 接收 request{action, site, prompt...}，路由到对应站点的 content script 适配器
 * 3. 管理每站一个专属（pinned）标签页：不存在则创建；每次 ask 先归位站点首页（独立全新会话）再派发
 *
 * 注意：内容脚本负责页面内的等待与抓取；SW 只做路由。
 */

const WS_URL = 'ws://127.0.0.1:8765';
const OFFSCREEN_PATH = 'offscreen.html';
const TOKEN_KEY = 'bridgeToken';   // 桥接令牌存在 chrome.storage.local（首次连接由桥配对下发）

const SITES = {
  deepseek: {
    url: 'https://chat.deepseek.com/',
    matches: ['https://chat.deepseek.com/*'],
  },
  qwen: {
    url: 'https://www.qianwen.com/',
    matches: ['https://www.qianwen.com/*', 'https://qianwen.com/*', 'https://chat.qianwen.com/*'],
    legacyMatches: ['https://www.tongyi.com/*', 'https://tongyi.aliyun.com/*', 'https://chat.aliyun.com/*'],
    firstSignalMs: 30000, // 千问出字慢，首反馈窗口放宽到 30s（防真实慢回复被误判无信号）
    // 千问的流程是"先发风控预审（无内容、很快结束）→ 再出作答"。
    // 2026-09-15 实测踩过：预审流一结束就进入 20s 等待，而作答迟迟不来 → 误判 stream_empty；
    // 但答案**确实会来**（用户在页面上看到了回复）。所以这里给长窗口。
    contentlessWaitMs: 120000,
    // 生成/渲染依赖页面可见性（rAF 在后台标签页被暂停）：实测后台 120s 零输出，
    // 切前台后立刻出答案；无人值守（用户切走）时按"每分钟苏醒一次"的节奏爬行推进，
    // 实测一轮约 5 分钟才完成。SW 侧整体预算给 7 分钟，服务端/桥的超时与之对齐。
    surfaceOnAsk: true,
    askTimeoutMs: 420000,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 站点自报终态 → 人类可读说明（v8）
 * 来源：DeepSeek 线上产物的 MessageStatus 枚举，终态定义 `status !== 'WIP'`
 * （取证见 research-completion-signal.md）。null = 正常答完，不额外提示。
 * 除 FINISHED 外的终态都意味着"服务端已结束，但内容可能被截断/拦截"，
 * 必须显式透出，否则上层会把半截答案当完整答案用。
 */
const TERMINAL_STATUS_TEXT = {
  FINISHED: null,
  INCOMPLETE: '服务端标记回复不完整',
  CONTENT_FILTER: '回复被安全策略拦截',
  CONTEXT_LENGTH_EXCEEDED: '超出上下文长度上限',
  TIMEOUT: '服务端侧超时',
};

/** 流已关闭后，最多再等多久让 DOM 追平最后一帧（毫秒） */
const STREAM_SETTLE_MS = 2500;

/**
 * 收到"没有内容的已结束流"后，最多再等多久等真正的作答流（毫秒）。
 * 背景：一次问答可能产生多条流（搜索/预处理阶段 + 正式作答阶段）。
 * 2026-09-15 实测踩过：在空流结束时收口，真正的作答流才刚开始 → stream_empty。
 * 加这个上限是为了不在异常情况下拖到 170s。
 */
const CONTENTLESS_WAIT_MS = 20000;

/**
 * 站点级串行队列。
 *
 * 为什么必须串行：每个站点只有一个常驻 pinned 标签页。并发进入会互相覆盖输入框内容、
 * 抢同一块屏幕做完成判定、互相把页面导航回首页 —— 结果是谁都拿到错的东西。
 *
 * 为什么要有排队上限：串行不能让用户"莫名卡住"。前序任务若卡死（最多约 4 分钟），
 * 后面的任务会一直等下去，此时应当明确报错而不是无限沉默。
 */
const QUEUE_WAIT_MS = 240000;

/** 默认调用节流间隔（秒）：同一站点两次提问之间的最小间隔，用于降低账号风控概率 */
const DEFAULT_THROTTLE_SEC = 3;

/**
 * 首反馈窗口（ms）：注入+发送已确认时使用。
 *
 * 为什么与站点默认值分开：首反馈窗口的作用是捕捉"发送根本没生效"。
 * 但 ack 成功本身已包含双重验证（注入读回比对 + 发送等价信号），发送失败在 ack 阶段就报了，
 * 再在 12s 内催"没有生命信号"只会误伤准备阶段长的正常请求 ——
 * 例如开启智能搜索时，站点要先搜网页再出字，首字可能落在 12s 之后。
 * 因此：ack 已确认 → 用宽松窗口（只当"模型很慢"处理）；ack 丢失 → 用站点严格窗口（真无法判断）。
 */
const ACKED_FIRST_SIGNAL_MS = 25000;

/** 首反馈预算：ack 已确认（注入+发送都验过）则放宽，ack 丢失才用站点严格窗口 */
function firstSignalBudget(acked, siteMs) {
  return acked ? Math.max(siteMs, ACKED_FIRST_SIGNAL_MS) : siteMs;
}

/**
 * 风控挑战（滑块验证等）的等待预算。
 *
 * 为什么单独给预算而不占用原有超时：人工验证要花时间，把等待算进 170s 会让
 * "站点在等你划一下"变成"任务超时失败"。检测到挑战时把截止时间往后展这么多。
 */
const CAPTCHA_WAIT_MS = 180000;

/**
 * 自适应降温（方案 C）：检测到风控挑战后，自动拉长该站点的调用间隔。
 *
 * 注意定位：它**只是降低再次触发的概率**，不解决已经弹出的挑战
 * （那是"切前台 + 等人工完成"的职责）。因此拉长幅度温和、且有失效期，
 * 不会让站点永久变慢。
 */
const ADAPTIVE_KEY = 'adaptiveCooldown';
const ADAPTIVE_STEP_SEC = 5;          // 每次触发加 5 秒
const ADAPTIVE_MAX_SEC = 60;          // 上限 60 秒
const ADAPTIVE_TTL_MS = 30 * 60 * 1000;   // 30 分钟无挑战自动恢复
let adaptiveCache = null;

async function loadAdaptive() {
  if (adaptiveCache) return adaptiveCache;
  try {
    const st = await chrome.storage.local.get(ADAPTIVE_KEY);
    adaptiveCache = st[ADAPTIVE_KEY] || {};
  } catch { adaptiveCache = {}; }
  return adaptiveCache;
}

/** 取该站点当前的额外冷却秒数（已过期则自动清除） */
async function getAdaptiveSec(site) {
  const all = await loadAdaptive();
  const rec = all[site];
  if (!rec) return 0;
  if (rec.until && Date.now() > rec.until) {
    delete all[site];
    try { await chrome.storage.local.set({ [ADAPTIVE_KEY]: all }); } catch { /* 忽略 */ }
    return 0;
  }
  return rec.extraSec || 0;
}

/** 命中一次挑战 → 冷却加一档，并刷新失效期 */
async function bumpAdaptive(site) {
  const all = await loadAdaptive();
  const prev = all[site] || { hits: 0 };
  const hits = (prev.hits || 0) + 1;
  const extraSec = Math.min(ADAPTIVE_MAX_SEC, ADAPTIVE_STEP_SEC * hits);
  all[site] = { extraSec, hits, at: Date.now(), until: Date.now() + ADAPTIVE_TTL_MS };
  try { await chrome.storage.local.set({ [ADAPTIVE_KEY]: all }); } catch { /* 忽略 */ }
  return extraSec;
}

/** 把标签页（及其窗口）切到前台，让用户看得见需要人工处理的验证 */
async function surfaceTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId != null) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* 忽略 */ }
    }
    return true;
  } catch (err) {
    console.log(`[webagents] 切换到标签页失败: ${err.message}`);
    return false;
  }
}

const siteQueues = new Map();    // site -> 队尾 Promise
const queueDepth = new Map();    // site -> 该站点在跑+在等的任务数
const lastAskEndAt = new Map();  // site -> 上次 ask 结束时间（节流用）

function queueSnapshot() {
  const out = {};
  for (const [s, n] of queueDepth) if (n > 0) out[s] = n;
  return out;
}

/** 把任务排进站点队列，返回其执行结果；等待超限则抛出（由调用方回传错误）
 *  waitLimitMs 可注入，便于单测用小上限验证超时分支 */
function enqueueSite(site, fn, waitLimitMs = QUEUE_WAIT_MS) {
  const queuedAt = Date.now();
  queueDepth.set(site, (queueDepth.get(site) || 0) + 1);
  const prev = siteQueues.get(site) || Promise.resolve();
  const run = prev.then(() => {}, () => {}).then(() => {
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs > waitLimitMs) {
      throw new Error(`本站点前序任务仍在执行，已排队 ${Math.round(waitedMs / 1000)}s 仍未轮到，已放弃（稍后可重试）`);
    }
    if (waitedMs > 500) console.log(`[webagents] ${site} 排队 ${waitedMs}ms 后开始执行`);
    return fn(waitedMs);
  });
  const settled = run.then(() => {}, () => {});
  siteQueues.set(site, settled);
  settled.then(() => {
    const n = (queueDepth.get(site) || 1) - 1;
    if (n > 0) queueDepth.set(site, n); else queueDepth.delete(site);
  });
  return run;
}

// ---- 与桥的连接：由 offscreen 文档承载 ----
//
// 旧实现把 WebSocket 建在 SW 里，再用 20s 心跳 + 0.5min alarm "敲醒自己"防止被回收。
// v0.4.0 改为连接常驻在 offscreen 文档中（生命周期与 SW 独立，不需保活），SW 只在
// 收发消息时被唤醒。这样做的直接收益：**SW 回收不再中断连接** ——
// 否则"掉线快速失败"会对一次正常的 SW 回收误报成请求失败。
//
// offscreen 不可用的环境（理论上只有 Chrome < 109）退回 SW 内直连，功能不缺席。

let transport = 'offscreen';       // 'offscreen' | 'sw'
let swWs = null;                   // 仅退回模式使用
let swBackoff = 1000;
let cachedToken = null;
let bridgeState = { connected: false, error: '尚未连接', at: 0 };

async function getToken() {
  if (cachedToken !== null) return cachedToken;
  try {
    const st = await chrome.storage.local.get(TOKEN_KEY);
    cachedToken = st[TOKEN_KEY] || '';
  } catch { cachedToken = ''; }
  return cachedToken;
}

async function saveToken(t) {
  cachedToken = t || '';
  try { await chrome.storage.local.set({ [TOKEN_KEY]: cachedToken }); } catch { /* 存储不可用则仅留在内存 */ }
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (transport === 'sw') return false;
  const offscreen = chrome.offscreen;
  if (!offscreen || !offscreen.createDocument) { transport = 'sw'; return false; }
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  try {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (ctxs && ctxs.length) return true;
  } catch { /* getContexts 不可用：直接尝试创建，重复创建会抛错并被吞掉 */ }
  if (creatingOffscreen) { await creatingOffscreen; return true; }
  creatingOffscreen = offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // 该 reason 不设时长上限（只有 AUDIO_PLAYBACK 会 30s 静默关闭）
    reasons: ['WORKERS'],
    justification: '维持与本地 WS 桥的常驻连接（Service Worker 会被 MV3 空闲回收）',
  }).catch(() => {});
  await creatingOffscreen;
  creatingOffscreen = null;
  return true;
}

/** SW 内直连（退回模式）：仅当 offscreen 不可用时使用 */
function connectInSW() {
  swWs = new WebSocket(WS_URL);
  swWs.onopen = async () => {
    swBackoff = 1000;
    const t = await getToken();
    const hello = { type: 'hello', role: 'ext' };
    if (t) hello.token = t;
    swWs.send(JSON.stringify(hello));
  };
  swWs.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello-ok') {
      bridgeState = { connected: true, error: null, at: Date.now() };
      if (msg.token) saveToken(msg.token);
      return;
    }
    if (msg.type === 'hello-fail') {
      bridgeState = { connected: false, error: msg.error || '握手被拒绝', at: Date.now() };
      console.log(`[webagents] 桥握手被拒绝：${msg.error}`);
      return;
    }
    if (msg.type === 'request') {
      handleRequest(msg).catch((err) => sendResult(msg.id, { ok: false, error: err.message }));
    }
  };
  swWs.onclose = () => {
    bridgeState = { connected: false, error: '连接已断开', at: Date.now() };
    setTimeout(connectInSW, swBackoff);
    swBackoff = Math.min(swBackoff * 2, 30000);
  };
  swWs.onerror = () => { try { swWs.close(); } catch {} };
}

/** 把一条消息发往桥。offscreen 不可达时重建一次再试（offscreen 可能刚被回收）。 */
async function postToBridge(payload) {
  if (transport === 'sw') {
    if (swWs && swWs.readyState === 1) {
      try { swWs.send(JSON.stringify(payload)); return true; } catch { /* 落到底部重连 */ }
    }
    connectInSW();
    return false;
  }
  // 新建的 offscreen 文档需要一点时间注册 onMessage：给几次短重试，避免"结果丢失"
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', op: 'send', payload });
      return true;
    } catch {
      if (attempt === 0) await ensureOffscreen();
      await sleep(200 * (attempt + 1));
    }
  }
  console.log('[webagents] 结果未能送达桥（offscreen 不可达）');
  return false;
}

function sendResult(id, payload) {
  return postToBridge({ type: 'result', id, ...payload });
}

// 反向兜底：若 offscreen 始终建不起来，退回 SW 直连，功能不缺席。
//
// 注意**不要在这里推送令牌**：这段代码每次 SW 启动都会执行，而 SW 每分钟都会被
// 看门狗 alarm 唤醒一次 —— 一旦推送令牌就触发 offscreen 侧"断开重连"，
// 结果连接被自己掐断、每分钟闪断一次（实测过：日志里精确 60s 一断一续）。
// 令牌由 offscreen 在需要连接时主动来取（op:'get-token'），这里只确保它存在。
ensureOffscreen().then(async (ok) => {
  if (ok) {
    console.log('[webagents] 连接由 offscreen 文档承载');
    return;
  }
  console.log('[webagents] offscreen 不可用，退回 SW 内直连');
  connectInSW();
});

// 看门狗：offscreen 文档理论上不会自己消失，但万一消失（浏览器回收等），
// 只有 SW 能重建它。一分钟一次，代价可忽略。
chrome.alarms.create('bridge-watchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'bridge-watchdog') return;
  if (transport === 'sw') {
    if (!swWs || swWs.readyState > 1) connectInSW();
    return;
  }
  try {
    const url = chrome.runtime.getURL(OFFSCREEN_PATH);
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (!ctxs || !ctxs.length) {
      console.log('[webagents] offscreen 文档缺失，重建');
      creatingOffscreen = null;
      const ok = await ensureOffscreen();
      // 只有确实重建了才推令牌 —— 否则会把一条好好的连接掐断重连
      if (ok) {
        const t = await getToken();
        try { await chrome.runtime.sendMessage({ target: 'offscreen', op: 'token', token: t }); } catch {}
      }
    }
  } catch { /* 检测失败不处理，等下一轮 */ }
});

// ---- CDP 可信输入（chrome.debugger）：备用通道，当前无调用方 ----
//
// 现状如实说明：**没有 content script 在使用它**。千问的输入走的是
// 「显式选区 + execCommand insertText」（见 content/qwen.js），并未依赖 CDP。
// 保留此函数的理由是：当合成事件路径被站点封掉时，这是唯一还能用的降级手段。
// 正因为它当前无人调用，才更应该改为按需授权 —— 不该为一个没接线的能力常驻
// 显示"正在调试此浏览器"。
const dbgAttached = new Set();
// 保持附加状态准确：外部（如 DevTools 打开）会导致 detach，之后需要重新附加
try {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) dbgAttached.delete(source.tabId);
  });
} catch { /* 无 debugger 权限时部分环境可能不提供该事件 */ }

/**
 * 调试权限已改为**按需申请**（manifest 的 optional_permissions）。
 *
 * 为什么：`debugger` 是权限清单里最重的一项 —— 装上就常驻显示"正在调试此浏览器"，
 * 而它只服务于千问一个站点。改成按需后，不跑千问的用户不该承担这个代价。
 *
 * 代价是它无法在后台静默授予：`chrome.permissions.request()` 属于"需要用户手势"的 API，
 * 只能在设置页由用户点击触发。所以这里必须给出**可操作的**报错，而不是静默失败。
 */
async function hasDebuggerPermission() {
  try {
    if (!chrome.permissions || !chrome.permissions.contains) return true; // 老环境按已授权处理
    return await chrome.permissions.contains({ permissions: ['debugger'] });
  } catch { return false; }
}

async function cdpClick(tabId, x, y) {
  if (!(await hasDebuggerPermission())) {
    throw new Error('缺少「调试」权限：这是备用输入通道，需在扩展设置页点击「授予调试权限」（当前两个站点都不依赖它）');
  }
  const target = { tabId };
  const attachedHere = !dbgAttached.has(tabId);
  if (attachedHere) await chrome.debugger.attach(target, '1.3');
  try {
    const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  } finally {
    // 用完立即断开，尽量缩短「正在调试」状态暴露时间，降低风控弹窗概率
    if (attachedHere) {
      try { await chrome.debugger.detach(target); } catch {}
      dbgAttached.delete(tabId);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ---- offscreen 文档的指令 ----
  if (msg && msg.target === 'sw') {
    switch (msg.op) {
      case 'get-token':
        getToken().then((token) => sendResponse({ token }));
        return true;
      case 'save-token':
        saveToken(msg.token).then(() => sendResponse({ ok: true }));
        return true;
      case 'state':
        bridgeState = { connected: !!msg.connected, error: msg.error || null, at: Date.now() };
        if (!msg.connected && msg.error) console.log(`[webagents] 桥状态：${msg.error}`);
        sendResponse({ ok: true });
        return false;
      case 'bridge-msg':
        // 立刻应答，避免 offscreen 那边一直挂着；处理过程本身是长任务
        handleRequest(msg.msg).catch((err) =>
          sendResult(msg.msg.id, { ok: false, error: err.message }),
        );
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  }

  // content script 请求在页面坐标 (x,y) 处执行一次真实点击
  if (msg && msg.type === 'cdpClick' && sender.tab && sender.tab.id != null) {
    cdpClick(sender.tab.id, msg.x, msg.y)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // 异步 sendResponse
  }
  return false;
});

// ---- 站点标签页管理 ----
async function ensureTab(site) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`未知站点: ${site}`);

  let tabs = await chrome.tabs.query({ url: cfg.matches });
  if (!tabs.length && cfg.legacyMatches) {
    tabs = await chrome.tabs.query({ url: cfg.legacyMatches });
  }
  let tab = tabs[0];
  if (!tab) {
    // 注：部分 Edge 版本 tabs.create 不接受 autoDiscardable，创建后单独用 update 设置
    tab = await chrome.tabs.create({ url: cfg.url, pinned: true, active: false });
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (err) { console.log(`[webagents] ${site} 防休眠设置失败: ${err.message}`); }
  } else {
    // 防止被 Edge 休眠 + 归位首页（每次 ask 独立全新会话）；已在首页则跳过导航避免整页重载
    try {
      const curUrl = String(tab.url || '').split('?')[0].split('#')[0];
      if (tab.discarded) {
        try { await chrome.tabs.reload(tab.id); } catch (err3) { console.log(`[webagents] ${site} 唤醒失败: ${err3.message}`); }
      } else if (curUrl !== cfg.url) {
        await chrome.tabs.update(tab.id, { url: cfg.url, active: false });
      }
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (err2) { console.log(`[webagents] ${site} 防休眠设置失败: ${err2.message}`); }
    } catch (err) {
      console.log(`[webagents] ${site} 标签页归位失败 tabId=${tab.id}: ${err.message}`);
    }
  }

  // 等待页面加载完成且适配器就绪（最多 60s）
  // 策略：注入(第0轮) → 仍不通则强制刷新(第5轮) → 再注入(第15轮) → 再刷新(第29轮)
  let injected = false;
  let reloads = 0;
  let lastErr = '';
  for (let i = 0; i < 60; i++) {
    let r = null;
    try {
      r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    } catch (err) { lastErr = err.message; }
    if (r && r.ready) {
      // 归位校验（2026-09-14 修复竞态）：必须精确在首页——旧对话页 URL 同样以站点域名开头，
      // 旧的 startsWith 判定永远为 true，导致消息发进旧会话后导航才生效、回复丢失。
      let cur = null;
      try { cur = await chrome.tabs.get(tab.id); } catch {}
      const path = String((cur && cur.url) || '').split('?')[0].split('#')[0];
      const onHome = path === cfg.url;
      let st = null;
      try { st = await chrome.tabs.sendMessage(tab.id, { type: 'state' }); } catch {}
      const stale = st && st.ok && st.count > 0;
      if ((!onHome || stale) && reloads < 3) {
        reloads++;
        console.log(`[webagents] ${site} 未归位(onHome=${onHome} url=${path})或残留回复(${stale ? st.count : 0}块)，刷新归位`);
        try { await chrome.tabs.update(tab.id, { url: cfg.url, active: false }); } catch {}
        injected = false;
        await sleep(2000);
        continue;
      }
      if (onHome && !stale) return tab.id;
      if (reloads >= 3) return tab.id; // 兜底：多次归位失败也放行，由 ask 阶段基线守卫兜住
    }

    if (i === 5 || i === 29) {
      console.log(`[webagents] ${site} 第${i}轮仍不通，强制刷新标签页 tabId=${tab.id}`);
      try { await chrome.tabs.reload(tab.id); } catch {}
      injected = false;
      await sleep(3000);
      continue;
    }

    if (!injected && (i === 0 || i === 15)) {
      injected = true;
      console.log(`[webagents] ${site} 第${i}轮程序化补注入 tabId=${tab.id}`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/common.js', `content/${site}.js`],
        });
      } catch (err) {
        lastErr = `补注入失败: ${err.message}`;
      }
    }
    await sleep(1000);
  }
  throw new Error(
    `站点 ${site} 的适配器未就绪 | 找到标签页=${!!tab} tabUrl=${(tab && tab.url) || '无'} | ${lastErr || 'ping 无响应'}`
  );
}

// ---- 请求路由 ----
const SW_VERSION = '9'; // v9: 连接改由 offscreen 文档承载（不再需要保活）+ 令牌配对 + 首反馈两档 + 站点级串行队列 + 调用节流 + 掉线快速失败

/** 请求入口：先过站点级串行队列，再分发 */
async function handleRequest(msg) {
  const { id, action } = msg;
  const stampBase = { sw: SW_VERSION };
  const stamp = (r) => Object.assign({}, stampBase, r);

  if (action === 'ping') {
    // 向连接的实际持有者**现查**状态，而不是读 SW 里的缓存：
    // SW 会被回收，缓存状态在重启后是空的，读缓存会误报"未连接"。
    let connected = false;
    let transportDesc = '';
    if (transport === 'sw') {
      connected = !!(swWs && swWs.readyState === 1);
      transportDesc = 'Service Worker 直连（退回模式）';
    } else {
      transportDesc = 'offscreen 常驻文档';
      try {
        const st = await chrome.runtime.sendMessage({ target: 'offscreen', op: 'state' });
        connected = !!(st && st.connected);
      } catch {
        connected = bridgeState.connected;
        transportDesc += '（查询失败，按最近上报）';
      }
    }
    return sendResult(id, stamp({
      ok: true,
      data: {
        connected,
        queues: queueSnapshot(),
        transport: transportDesc,
        // 只在"确实没连上"时才报桥侧错误：SW 启动时缓存里的"尚未连接"是陈旧值，
        // 现查已连接却还显示它，会让人误以为有问题（实测踩过）。
        bridgeError: connected ? null : (bridgeState.error || null),
      },
    }));
  }

  const site = msg.site;
  if (!SITES[site]) return sendResult(id, stamp({ ok: false, error: `未知站点: ${site}` }));

  try {
    return await enqueueSite(site, (queuedMs) => {
      stampBase.queuedMs = Math.round(queuedMs);
      return handleSiteRequest(msg, id, site, stamp, stampBase);
    });
  } catch (err) {
    // 排队超时等：明确回传，别让调用方干等
    return sendResult(id, stamp({ ok: false, error: err.message }));
  }
}

async function handleSiteRequest(msg, id, site, stamp, stampBase) {
  const { action } = msg;
  try {
    // ---- 只读查看：**绝不导航** ----
    // 与 probe 的关键区别：probe 会先 ensureTab 归位首页 = 整页重载，
    // 而整页重载会摧毁正在展示的风控验证状态、也会清空探针的流记录。
    // 因此"看现场"必须有一个不动页面的入口（风控取证就靠它）。
    if (action === 'inspect') {
      const cfg = SITES[site];
      let tabs = await chrome.tabs.query({ url: cfg.matches });
      if (!tabs.length && cfg.legacyMatches) tabs = await chrome.tabs.query({ url: cfg.legacyMatches });
      const tab = tabs[0];
      if (!tab) {
        return sendResult(id, stamp({ ok: false, error: `${site} 标签页未打开（inspect 不会自动创建，以免打断当前状态）` }));
      }
      let probeData = null;
      let stateData = null;
      // probe 消息偶尔会赶在内容脚本就绪前发出（跳转后水合期），重试一次；
      // state 是取证的核心（挑战/回复区/流），必须拿到，失败也重试。
      for (let attempt = 0; attempt < 2 && (!probeData || !stateData); attempt++) {
        if (attempt) await sleep(500);
        try { probeData = probeData || await chrome.tabs.sendMessage(tab.id, { type: 'probe' }); } catch { /* 忽略 */ }
        try { stateData = stateData || await chrome.tabs.sendMessage(tab.id, { type: 'state' }); } catch { /* 忽略 */ }
      }
      return sendResult(id, stamp({
        ok: true,
        data: {
          tabId: tab.id,
          url: tab.url,
          active: tab.active,
          challenge: (stateData && stateData.challenge) || null,
          stream: (stateData && stateData.stream) || null,
          probeWorld: (stateData && stateData.streamProbe) || null,
          answer: stateData ? {
            count: stateData.count, sel: stateData.sel, blocks: stateData.blocks,
            textLen: (stateData.text || '').length,
            textSource: stateData.textSource || null,
            // 生成中指示器状态：它是"DOM 层完成信号"的依据（在=生成中，消失=应已完成）
            feedback: stateData.feedback || null,
            // 带出文本头：取证时能直接看到答案内容与形态（表格/代码是否在）
            textHead: (stateData.text || '').slice(0, 300),
          } : null,
          probe: probeData || null,
        },
      }));
    }

    const tabId = await ensureTab(site);

    if (action === 'probe') {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'probe' });
      return sendResult(id, stamp(r || { ok: false, error: 'content script 无响应' }));
    }

    if (action === 'ask') {
      // 合并用户默认开关（扩展选项页设置）：面板设置优先级最高，覆盖显式 options；null/未设置 = 不干预页面开关
      let effOptions = msg.options || null;
      let throttleSec = DEFAULT_THROTTLE_SEC;
      try {
        const st = await chrome.storage.local.get('userDefaults');
        const d = st.userDefaults || {};
        if (typeof d.throttleSec === 'number' && d.throttleSec >= 0) throttleSec = d.throttleSec;
        const defaults = {};
        if (d.dsDeepThink === true || d.dsDeepThink === false) defaults.deepThink = d.dsDeepThink;
        if (d.dsSearch === true || d.dsSearch === false) defaults.search = d.dsSearch;
        if (d.qwenMode) defaults.mode = d.qwenMode;
        if (Object.keys(defaults).length) effOptions = Object.assign({}, msg.options || {}, defaults);
      } catch { /* 存储不可用时按无默认处理 */ }

      // ---- 调用节流（防风控）----
      // 设计原则：**不拖慢正常使用**。只在"距上次问答结束不足 N 秒"时才等待；
      // 等待发生在注入之前、且计入本次请求自己的时间预算，不会引发超时。
      // 因本站点已串行，这里的间隔只对"连续调用"生效，正常节奏完全无感。
      // 叠加自适应降温（方案 C）：命中过风控挑战的站点会临时多等几秒。
      const adaptiveSec = await getAdaptiveSec(site);
      const totalThrottleSec = throttleSec + adaptiveSec;
      let throttleWaitMs = 0;
      if (totalThrottleSec > 0) {
        const last = lastAskEndAt.get(site) || 0;
        const need = totalThrottleSec * 1000 - (Date.now() - last);
        if (need > 0) {
          throttleWaitMs = need;
          console.log(`[webagents] ${site} 调用节流：距上次结束 ${Date.now() - last}ms，再等 ${Math.round(need)}ms`
            + (adaptiveSec ? `（含自适应降温 ${adaptiveSec}s）` : ''));
          await sleep(need);
        }
        stampBase.throttleWaitMs = Math.round(throttleWaitMs);
      }
      if (adaptiveSec) stampBase.adaptiveSec = adaptiveSec;
      // 两段式：先触发发送（容忍整页跳转），再由 SW 轮询页面状态直到回复稳定。
      // content 侧已做 inject（读回比对 ≤3s×2 次）/ send（等价信号 ≤5s）分级校验。
      // v8 完成判定优先级：
      //   ① 流信号（主）：主世界探针观测到"服务端关闭响应流"= 协议级硬信号（站点无关）
      //   ② DOM 稳定性（兜底）：探针不可用时维持既有逻辑
      // askSince：本次问答起点。流记录必须"开始于此刻之后"，否则是上一次问答的遗留。
      const askSince = Date.now();

      // ack 兜底 60s：content 最坏合法路径（长文本逐字符注入×2 次 + 选项切换）可能 ~50s，
      // 超时按 ack 丢失处理，绝不无限挂起等 sendMessage。
      const ack = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'ask', prompt: msg.prompt, options: effOptions }).catch(() => null),
        sleep(60000).then(() => null),
      ]);

      // ack 显式失败 = content 校验已确认失败 → 立即把错误传回 server/MCP，绝不静默重试
      if (ack && ack.ok === false) {
        const stage = ack.stage || 'unknown';
        const detail = ack.detail || ack.error || '未知错误';
        return sendResult(id, stamp({ ok: false, stage, detail, error: `[${site}][${stage}] ${detail}` }));
      }

      // 发送已确认成功 → 若站点需要可见性（如千问：后台标签页里生成/渲染疑似被冻结，
      // 实测后台 120s 无任何输出、切前台后立刻出答案），把标签页切到前台再等结果。
      // 这与"风控验证切前台"是同一哲学：把无声的等待变成看得见的等待。
      if (ack && ack.ok !== false && SITES[site].surfaceOnAsk) {
        const surfaced = await surfaceTab(tabId);
        if (surfaced) {
          stampBase.surfaced = true;
          console.log(`[webagents] ${site} 发送成功，标签页已切前台（该站点生成需要页面可见）`);
        }
      }

      // SW 侧超时上限 170s：早于 WS 桥 180s 上限返回，超时带出已生成的部分文本
      // 超时预算：调用方显式指定 > 站点配置（千问 420s，见 SITES.qwen.askTimeoutMs）> 默认 170s
      const timeoutMs = msg.timeoutMs || (SITES[site] && SITES[site].askTimeoutMs) || 170000;
      // 用 let：检测到风控挑战时会把截止时间往后展（等人工完成验证），
      // 否则"站点在等你划一下"会被当成"任务超时"。
      let deadline = Date.now() + timeoutMs;
      let lastText = '';
      let lastCount = 0;
      let stableSince = 0;

      // 生命信号：回复文本出现 / 思考态或加载指示器（v6 隔离后每次 ask 均从干净首页开始，
      // 无旧回复，块数基线守卫已剪——qwen 预创建空回答块导致基线永不增长、完成判定失效的教训）
      const hasSignal = (st) => (st.count > 0 && !!st.text) || !!st.feedback;

      // 站点自带的首反馈窗口（严格值：ack 丢失时用它，因为那时无法确认发送是否发生过）
      const siteFirstSignalMs = (SITES[site] && SITES[site].firstSignalMs) || 12000;
      // ack 已确认 → 放宽（见 ACKED_FIRST_SIGNAL_MS 注释）；ack 丢失 → 站点严格窗口
      const firstSignalMs = firstSignalBudget(!!ack, siteFirstSignalMs);
      // "只收到无内容的已结束流"后的等待上限，按站点配置：
      // DeepSeek 的作答流来得快（20s 够）；千问要先过风控预审、出字慢 —— 20s 会误判失败（实测踩过）
      const contentlessWaitMs = (SITES[site] && SITES[site].contentlessWaitMs) || CONTENTLESS_WAIT_MS;

      /** 取本次问答的流记录：探针须在主世界，且记录开始于 askSince 之后 */
      const readStream = (st) => {
        const probe = st && st.streamProbe;
        if (!probe || !probe.alive || probe.world !== 'main') return null;
        const s = st.stream;
        if (!s || !s.startedAt || s.startedAt < askSince - 1000) return null;
        return s;
      };

      /**
       * 是否"像问答流"：至少做过一次写入或自报过状态。
       * 仅用于生命信号判定（避免把页面里无关的 SSE 遥测当成"站点有反馈"）；
       * 完成判定不套这个过滤 —— 否则尾随空流会被整条忽略，导致等不到收口。
       */
      const looksLikeAsk = (s) => !!s && (s.opCount > 0 || !!s.status);

      if (!ack) {
        // ack 丢失/超时（页面跳转或消息通道中断）：给首反馈窗口，无任何生命信号立即报错
        const ackDeadline = Date.now() + firstSignalMs;
        let st0 = null;
        while (Date.now() < ackDeadline) {
          await sleep(600);
          try { st0 = await chrome.tabs.sendMessage(tabId, { type: 'state', since: askSince }); } catch { continue; }
          if (st0 && (((st0.count > 0 && st0.text) || st0.feedback) || looksLikeAsk(readStream(st0)))) break;
        }
        if (!(st0 && (((st0.count > 0 && st0.text) || st0.feedback) || looksLikeAsk(readStream(st0))))) {
          return sendResult(id, stamp({
            ok: false,
            stage: 'no_site_feedback',
            detail: `ack 丢失且 ${Math.round(firstSignalMs / 1000)}s 内无站点反馈，注入/发送未生效`,
            error: `[${site}][no_site_feedback] ack 丢失且 ${Math.round(firstSignalMs / 1000)}s 内无站点反馈，注入/发送未生效`,
          }));
        }
        lastText = st0.text || '';
        lastCount = st0.count || 0;
      }

      let gotSignal = !ack; // ack 丢失路径已在上方窗口确认过信号
      let noSignalMs = 0;
      let streamEndedSeenAt = 0;   // 首次观测到"流已关闭"的时刻
      let streamStatus = null;
      let activeStreamId = null;     // 当前跟踪的流（一次问答可能有多条）
      let contentlessEndedAt = 0;    // 首次观测到"空内容的已结束流"的时刻
      let completeFalseAt = 0;       // 首次观测到"完成标记=未完成"的时刻（安全阀：超过 90s 视为标记失效）
      let bestStream = null;         // 已见过的"带内容"的流（尾随空流用它回退）
      let challengeSeenAt = 0;       // 首次观测到风控挑战的时刻（present=true）
      let challengeSurfacedAt = 0;   // 已把标签页切到前台的时刻
      let challengeClearedAt = 0;    // 挑战消失的时刻

      /**
       * 流已关闭 → 收尾。
       * 正文优先取探针还原的原始 markdown（保留代码块/表格/公式），
       * 要求长度不比 DOM 文本短太多，防止协议还原不完整时反而丢内容。
       */
      /**
       * 当次诊断（仅在正文没拿到时采集）。
       * 必须当次采集：问答结束后标签页会被导回首页（整页重载），
       * 探针记录随之清空，事后调 probe 已经查不到。
       */
      const collectDiag = async () => {
        try {
          const dg = await chrome.tabs.sendMessage(tabId, { type: 'streamDiag', since: askSince, timeoutMs: 1200 });
          if (!dg || !dg.ok) return null;
          return {
            probeWorld: dg.probeWorld,
            streamUrl: dg.data && dg.data.url,
            streamType: dg.data && dg.data.contentType,
            status: dg.data && dg.data.status,
            opCount: dg.data && dg.data.opCount,
            markdownLength: dg.data && dg.data.markdownLength,
            rootKeys: dg.data && dg.data.rootKeys,
            responseKeys: dg.data && dg.data.responseKeys,
            // 事件词表 / 帧形态统计 / 裸字符串样本：定位站点负载形态的直接证据
            events: dg.data && dg.data.events,
            frames: dg.data && dg.data.frames,
            rawTexts: dg.data && dg.data.rawTexts,
            // 本页全部流的摘要：判断"作答流有没有被抓到"的决定性证据
            streams: dg.streams,
            sampleHead: dg.data && dg.data.sampleHead,
            // 完成标记与生成指示器的当次状态：判断"门控是否生效"的直接证据
            complete: dg.complete,
            feedback: dg.feedback,
            dom: dg.dom,
          };
        } catch { return null; }
      };

      const finalizeFromStream = async (s) => {
        // 正文取回：优先命中内容脚本的本地缓存（探针在流结束时已把正文带出）。
        // 失败重试 3 次并留出间隔 —— 内容脚本可能正好处于页面切换的瞬间。
        let md = '';
        let mdVia = 'none';
        for (let attempt = 0; attempt < 3 && !md && s && s.id; attempt++) {
          if (attempt) await sleep(300);
          try {
            const r = await chrome.tabs.sendMessage(tabId, {
              type: 'streamText', since: askSince, streamId: s.id, timeoutMs: 1500,
            });
            if (r && r.text) { md = r.text; mdVia = r.via || 'probe'; }
            else mdVia = `empty:${(r && r.via) || 'probe'}`;
          } catch { mdVia = 'throw'; }
        }

        let domText = '';
        let opts = null;
        try {
          const re = await chrome.tabs.sendMessage(tabId, { type: 'state', since: askSince });
          if (re && re.ok) { domText = re.text || ''; opts = re.options ?? null; }
        } catch { /* 忽略 */ }

        const useMd = !!md && (!domText || md.length >= domText.length * 0.5);
        const text = useMd ? md : (domText || md || '');

        const status = s.status || streamStatus || null;
        const warn = status ? TERMINAL_STATUS_TEXT[status] : null;

        // 流已关闭但一个字都没拿到：无论状态是什么，都不能报成功——
        // 空答案标成功会让上层把"什么都没有"当成有效结果。
        if (!text) {
          const detail = warn ? `${warn}（且未取到任何文本）` : '响应流已关闭但未取到任何文本';
          const diag = await collectDiag();
          if (diag) console.log(`[webagents] ${site} stream_empty 当次诊断: ${JSON.stringify(diag)}`);
          return sendResult(id, stamp({
            ok: false, stage: 'stream_empty', streamStatus: status,
            detail, error: `[${site}][stream_empty] ${detail}`, diag,
            // 取回失败时的定位信息：mdLen=0 且 streamId 有值 → 取回那一跳丢了
            mdLen: md.length, domLen: domText.length, mdVia, streamId: (s && s.id) || null,
            streamMarkdownLength: (s && s.markdownLength) || 0,
          }));
        }

        const payload = {
          ok: true,
          text,
          timedOut: false,
          options: opts,
          viaStream: true,
          streamStatus: status,
          textSource: useMd ? 'stream' : 'dom',
          // 长度快照：正文异常时不用再猜"是取回失败还是 DOM 更长"
          mdLen: md.length,
          domLen: domText.length,
          mdVia,
          streamId: (s && s.id) || null,
        };
        if (warn) { payload.truncated = true; payload.warning = warn; }

        // 正文退回 DOM（还原未生效）时附带诊断，成功还原时不打扰
        if (!useMd) {
          const diag = await collectDiag();
          if (diag) {
            payload.diag = diag;
            console.log(`[webagents] ${site} 正文退回 DOM，当次诊断: ${JSON.stringify(diag)}`);
          }
        }
        return sendResult(id, stamp(payload));
      };

      while (true) {
        const loopStart = Date.now();
        if (Date.now() > deadline) {
          // 超时分支必须说清"卡在哪"。
          // 旧实现只回 { text, timedOut }，于是"170 秒里到底有没有内容、有没有流、
          // 正文能不能从流里救回来"完全无从判断（2026-09-15 实测踩过：千问超时返回空正文，
          // 记录里 mdLen/domLen/streamStatus 全是 undefined，等于没有任何线索）。
          if (bestStream && bestStream.endedAt) {
            // 有已结束且带内容的流：救回正文，比返回空字符串有用得多
            return await finalizeFromStream(bestStream);
          }
          let domText = '';
          let domOpts = null;
          let streamInfo = null;
          try {
            const re = await chrome.tabs.sendMessage(tabId, { type: 'state', since: askSince });
            if (re && re.ok) {
              domText = re.text || '';
              domOpts = re.options ?? null;
              streamInfo = re.stream || null;
            }
          } catch { /* 忽略 */ }
          const text = lastText || domText;
          const payload = {
            ok: true,
            text,
            timedOut: true,
            options: domOpts,
            streamStatus: (streamInfo && streamInfo.status) || streamStatus || null,
            streamId: (streamInfo && streamInfo.id) || activeStreamId || null,
            mdLen: text.length,
            domLen: domText.length,
            textSource: (lastText || domText) ? 'dom-poll' : 'none',
          };
          if (!text) {
            // 一个字都没有：这不是"成功的空回复"，把现场一并带出去
            payload.truncated = true;
            payload.warning = '等待超时且未取到任何正文';
            const diag = await collectDiag();
            if (diag) {
              payload.diag = diag;
              console.log(`[webagents] ${site} 超时空正文，当次诊断: ${JSON.stringify(diag)}`);
            }
          }
          return sendResult(id, stamp(payload));
        }
        await sleep(600);

        let st = null;
        try {
          st = await chrome.tabs.sendMessage(tabId, { type: 'state', since: askSince });
        } catch {
          continue; // 页面跳转中（content script 重建），不计入首反馈窗口，下一轮再取
        }
        if (!st || !st.ok) continue;

        // ---- 风控挑战（滑块验证等）：方案 A ----
        // 站点标签页是后台标签，挑战弹在用户看不见的地方 —— 不处理就表现为"任务无声卡死"。
        // 处理方式：切到前台让用户能看见 + 延长等待预算 + 记一档自适应降温，验证完自动继续。
        const challenge = st.challenge;
        const challengeNow = !!(challenge && challenge.present);
        if (challengeNow) {
          if (!challengeSeenAt) {
            challengeSeenAt = Date.now();
            // 只切一次前台，避免每轮都抢焦点骚扰用户
            if (!challengeSurfacedAt) {
              challengeSurfacedAt = await surfaceTab(tabId) ? Date.now() : 0;
            }
            const extraSec = await bumpAdaptive(site);
            deadline += CAPTCHA_WAIT_MS;
            stampBase.challenge = {
              detected: true,
              sel: challenge.sel || null,
              surfaced: !!challengeSurfacedAt,
              adaptiveSec: extraSec,
              hint: '站点要求人工验证（疑似滑块），已切到该标签页；完成后会自动继续',
            };
            console.log(`[webagents] ${site} 检测到风控挑战${challenge.sel ? `（${challenge.sel}）` : ''}，`
              + `已切前台=${!!challengeSurfacedAt}，等待预算 +${CAPTCHA_WAIT_MS / 1000}s，自适应降温 +${extraSec}s`);
          }
          // 人手在操作期间不该按"站点无反馈/无内容"判失败，也不该走完成判定
          noSignalMs = 0;
          contentlessEndedAt = Date.now();
          continue;
        }
        if (challengeSeenAt && !challengeClearedAt) {
          challengeClearedAt = Date.now();
          console.log(`[webagents] ${site} 风控挑战已消失（等待 ${Math.round((challengeClearedAt - challengeSeenAt) / 1000)}s），继续完成任务`);
        }

        const s = readStream(st);

        // 换流就重置计时：一次问答可能产生多条流（搜索/预处理阶段 + 正式作答阶段）
        if (s && s.id !== activeStreamId) {
          if (activeStreamId) console.log(`[webagents] ${site} 检测到换流 ${activeStreamId} → ${s.id}`);
          activeStreamId = s.id;
          streamEndedSeenAt = 0;
          contentlessEndedAt = Date.now();
          streamStatus = s.status || null;
        }

        // ---- ① 流信号（主路径）：服务端已关闭响应流 = 答完了 ----
        if (s && s.endedAt) {
          const hasContent = (s.markdownLength || 0) > 0;
          const terminalWarn = s.status ? TERMINAL_STATUS_TEXT[s.status] : null;
          if (hasContent) bestStream = s;

          // 走哪条流收口：当前这条有内容就用它；当前是空流但先前有带内容的已结束流，
          // 说明当前只是尾随流（如收尾/统计事件），回退到那条作答流。
          const target = hasContent ? s : ((terminalWarn || (bestStream && bestStream.endedAt)) ? (bestStream || s) : null);

          if (target) {
            if (!streamEndedSeenAt) {
              streamEndedSeenAt = Date.now();
              streamStatus = target.status || null;
              console.log(`[webagents] ${site} 响应流已关闭 id=${target.id} status=${streamStatus || '未上报'} 正文=${target.markdownLength || 0}字，等待 DOM 追平`);
            }
            // DOM 也稳定（且已给够 400ms 追平时间）或超过收尾上限 → 收口
            const domSettled = st.count > 0 && st.text
              && st.text === lastText && st.count === lastCount
              && Date.now() - streamEndedSeenAt >= 400;
            if (domSettled || Date.now() - streamEndedSeenAt >= STREAM_SETTLE_MS) {
              return await finalizeFromStream(target);
            }
            lastText = st.text || lastText;
            lastCount = st.count || lastCount;
            continue;
          }

          // 空内容的已结束流：继续等作答流，但有上限，不拖到 170s。
          // 注意：页面还在"生成中"（feedback 指示器在 / 完成标记说未完成）就不计时 ——
          // 生成明明在进行，不能按"无内容"判死；两者都消失后才开始倒数。
          // 【重置必须用 Date.now() 而不是 0】0 会让下面的差值变成 epoch（1.7万亿 ms），
          // 条件瞬间成立 → 生成中反而秒判 stream_empty（2026-09-15 实测踩过，ms=11096 就失败了）。
          if (st.feedback || st.complete === false) {
            if (contentlessEndedAt) console.log(`[webagents] ${site} 检测到生成中指示（feedback/完成标记），重置空流等待计时`);
            contentlessEndedAt = Date.now();
          } else if (!contentlessEndedAt) {
            contentlessEndedAt = Date.now();
            console.log(`[webagents] ${site} 收到无内容的已结束流（status=${s.status || '未上报'}）且无生成指示器，等待作答流`);
          }
          if (!st.text && Date.now() - contentlessEndedAt >= contentlessWaitMs) {
            const detail = `连续 ${Math.round(contentlessWaitMs / 1000)}s 只收到无内容的响应流，且回复区无内容`;
            const diag = await collectDiag();
            if (diag) console.log(`[webagents] ${site} stream_empty 当次诊断: ${JSON.stringify(diag)}`);
            return sendResult(id, stamp({
              ok: false, stage: 'stream_empty', streamStatus: s.status || null,
              detail, error: `[${site}][stream_empty] ${detail}`, diag,
            }));
          }
          // 落到下面的 DOM 兜底逻辑继续轮询
        }

        // 首反馈校验（≤firstSignalMs）：发送成功后必须有生命信号（流已开始 / 有文本 / 有思考态），否则立即报错
        if (!gotSignal) {
          if (hasSignal(st) || looksLikeAsk(s)) {
            gotSignal = true;
          } else {
            noSignalMs += Date.now() - loopStart;
            if (noSignalMs >= firstSignalMs) {
              return sendResult(id, stamp({
                ok: false,
                stage: 'no_site_feedback',
                detail: `发送后回复区 ${Math.round(noSignalMs / 1000)}s 内无生命信号（无流式文本/思考态/新增节点）`,
                error: `[${site}][no_site_feedback] 发送后回复区 ${Math.round(firstSignalMs / 1000)}s 内无生命信号（无流式文本/思考态/新增节点）`,
              }));
            }
          }
        }

        // ---- ② DOM 稳定性（兜底：探针不可用时维持既有行为）----
        // 完成标记门控（如千问 qk-markdown-complete）：标记说"还在生成"时，文字再稳定也不算完
        // —— 2026-09-15 实测踩过：联网搜索阶段先出"参考了15篇结果"状态条，文字稳定 400ms 就被
        // 当成终稿返回了，真正的答案在几秒后才出来。标记缺失（null）不影响判定（向后兼容）。
        const stillGenerating = st.complete === false
          && !(completeFalseAt && Date.now() - completeFalseAt > 90000);
        if (st.complete === false) {
          if (!completeFalseAt) {
            completeFalseAt = Date.now();
            console.log(`[webagents] ${site} 完成标记=未完成（仍在生成），暂不进入稳定性判定`);
          }
        } else if (st.complete === true && completeFalseAt) {
          console.log(`[webagents] ${site} 完成标记=已完成（等待 ${Math.round((Date.now() - completeFalseAt) / 1000)}s）`);
          completeFalseAt = 0;
        }
        if (stillGenerating) {
          // 生成中：与风控等待同待遇 —— 不计时、不判失败
          noSignalMs = 0;
          contentlessEndedAt = Date.now();
          lastText = st.text || lastText;
          lastCount = st.count || lastCount;
          if (Date.now() > deadline) {
            return sendResult(id, stamp({ ok: true, text: lastText, timedOut: true }));
          }
          continue;
        }
        const { count, text } = st;
        const now = Date.now();
        // v6 隔离后每次 ask 均从干净首页开始，无旧回复残留，无需基线块数守卫
        if (count > 0 && text && text === lastText && count === lastCount) {
          if (!stableSince) stableSince = now;
          if (now - stableSince >= 400) {
            await sleep(300); // 复确认
            let re = null;
            try { re = await chrome.tabs.sendMessage(tabId, { type: 'state', since: askSince }); } catch {}
            if (re && re.ok && re.text === text) {
              // 兜底路径也把"站点自报终态"带出去，避免半截答案被静默当成功
              const sInfo = (re.streamProbe && re.streamProbe.world === 'main' && re.stream) ? re.stream : null;
              const status = sInfo ? (sInfo.status || null) : null;
              const warn = status ? TERMINAL_STATUS_TEXT[status] : null;
              const payload = {
                ok: true,
                text,
                timedOut: false,
                options: re.options ?? null,
                streamStatus: status,
                // 兜底路径同样标注来源与长度：否则记录里这几个字段是空的，
                // 事后无法判断"这次到底走的哪条路"（2026-09-15 实测踩过）。
                // dom-md = DOM→markdown 序列化（保真），dom = innerText（会失真）
                textSource: re.viaMd ? 'dom-md' : 'dom',
                mdLen: 0,
                domLen: text.length,
                streamId: sInfo ? (sInfo.id || null) : null,
              };
              if (warn) { payload.truncated = true; payload.warning = warn; }
              return sendResult(id, stamp(payload));
            }
            if (re && re.ok) { lastText = re.text; lastCount = re.count; }
            stableSince = 0;
          }
        } else {
          stableSince = 0;
          lastText = text;
          lastCount = count;
        }
      }
    }

    return sendResult(id, stamp({ ok: false, error: `未知 action: ${action}` }));
  } catch (err) {
    sendResult(id, stamp({ ok: false, error: err.message }));
  } finally {
    // 无论成功、失败还是异常都记录结束时间：下一次调用的节流据此计算间隔
    if (action === 'ask') lastAskEndAt.set(site, Date.now());
  }
}
