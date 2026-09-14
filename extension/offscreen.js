/**
 * WebAgents — offscreen document：常驻 WS 连接
 *
 * 为什么把连接放在这里：MV3 Service Worker 空闲 30s 会被回收，回收时它持有的
 * WebSocket 必然断开 —— 于是"扩展在线"这件事变得不确定：正在跑的请求可能忽然
 * 被告知连接中断，而空闲时的重连又会拖慢下一次调用。
 *
 * offscreen document 的生命周期与 SW **独立**（Chrome 官方说明：除 AUDIO_PLAYBACK
 * 外，各 reason 均不设时长上限），所以连接可以一直保持：
 *
 *   桥 → 本文件（WS）→ runtime 消息唤醒 SW → SW 处理 → 回传 → 本文件写回 WS
 *
 * SW 因此可以自由休眠，不需要任何"每 20 秒敲一下"的保活。
 *
 * 本文件只用 chrome.runtime（offscreen 文档唯一可用的扩展 API），
 * DOM 能力（WebSocket、setInterval）则正好是我们需要的。
 */

const WS_URL = 'ws://127.0.0.1:8765';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const AUTH_RETRY_MS = 60000;      // 握手被拒后的重试间隔（慢速，等桥换令牌）
const HEALTH_CHECK_MS = 25000;    // 自查连接存活：断开就重连，不依赖外部唤醒

let ws = null;
let backoff = RECONNECT_MIN_MS;
let token = null;
let connecting = false;
let authFailed = false;
let authError = null;   // 保留桥给出的具体拒绝原因：紧接着的 close 事件不该把它覆盖成泛化文案
let reconnectTimer = null;

/** 与 SW 通信（会唤醒 SW） */
function askSW(payload) {
  return chrome.runtime.sendMessage({ target: 'sw', ...payload }).catch(() => null);
}

function reportState(connected, error) {
  askSW({ op: 'state', connected, error: error || null });
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = authFailed ? AUTH_RETRY_MS : backoff;
  if (!authFailed) backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function send(payload) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(payload)); return true; } catch { return false; }
}

async function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  connecting = true;

  // 令牌每次连接前都向 SW 现取：SW 存储里可能刚被配对流程更新过
  if (token === null) {
    const r = await askSW({ op: 'get-token' });
    token = (r && r.token) || '';
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch {
    connecting = false;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connecting = false;
    backoff = RECONNECT_MIN_MS;
    const hello = { type: 'hello', role: 'ext' };
    if (token) hello.token = token;
    send(hello);
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'hello-ok') {
      authFailed = false;
      authError = null;
      if (msg.token && msg.token !== token) {
        token = msg.token;
        await askSW({ op: 'save-token', token: msg.token });
      }
      reportState(true, null);
      return;
    }

    if (msg.type === 'hello-fail') {
      // 令牌不匹配：停止高频重试（否则会一直打日志），改为慢速等待人工处理
      authFailed = true;
      authError = msg.error || '握手被拒绝';
      reportState(false, authError);
      try { ws.close(); } catch {}
      return;
    }

    if (msg.type === 'request') {
      // 交给 SW 处理；不等待结果，结果会由 SW 通过 op:'send' 回到这里
      await askSW({ op: 'bridge-msg', msg });
    }
  };

  ws.onclose = () => {
    connecting = false;
    reportState(false, authFailed ? (authError || '握手被拒绝') : '连接已断开，正在重连');
    scheduleReconnect();
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ---- 来自 SW 的指令 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.op === 'send') {
    const ok = send(msg.payload);
    // 发不出去通常意味着 offscreen 会话或连接刚重建：让 SW 知道，它会重试
    sendResponse({ ok });
    return false;
  }

  if (msg.op === 'state') {
    sendResponse({
      ok: true,
      connected: !!(ws && ws.readyState === 1),
      authFailed,
    });
    return false;
  }

  if (msg.op === 'token') {
    const next = msg.token || '';
    // 幂等：令牌没变就什么都不做。
    // 反之（旧实现）每次收到指令都断开重连 —— 而 SW 每次启动都会推一次，
    // SW 又被看门狗 alarm 每分钟唤醒，结果连接被自己掐断、每分钟闪断一次。
    if (next === token) { sendResponse({ ok: true, changed: false }); return false; }
    token = next;
    const wasAuthFailed = authFailed;
    authFailed = false;
    authError = null;
    if (ws && ws.readyState === 1 && !wasAuthFailed) {
      // 已有正常连接：用新令牌重新握手（桥换了令牌的场景）
      clearReconnect();
      try { ws.close(); } catch {}
    } else {
      clearReconnect();
      connect();
    }
    sendResponse({ ok: true, changed: true });
    return false;
  }

  return false;
});

// 连接自查：本文件自己有定时器（不受 SW 空闲回收影响），
// 因此"检测到断开就重连"这件事可以由连接的所有者自己负责，不必让 SW 反复唤醒。
setInterval(() => {
  if (!ws || ws.readyState > 1) {
    clearReconnect();
    connect();
  }
}, HEALTH_CHECK_MS);

connect();
