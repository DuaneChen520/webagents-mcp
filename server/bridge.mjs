#!/usr/bin/env node
/**
 * WEBAGENTS-bridge — 单例 WS 桥接（唯一持有 8765 端口的进程）
 *
 * 角色路由：
 *   - ext  ：WEBAGENTS Edge 扩展（唯一的扩展连接，新连接顶掉旧的）
 *   - mcp  ：一个或多个 MCP server 实例（Trae 会话、测试客户端可共存）
 *
 * 消息流：mcp 发 request{id,...} → 转发给 ext；ext 回 result{id,...} → 按 id 路由回发起的 mcp。
 *
 * 安全（v0.4.0 起，此前完全裸奔）：
 *   1. 令牌不再硬编码。优先 env WEBAGENTS_TOKEN，其次用户目录下的 bridge.json（随机生成）。
 *   2. Origin 校验：任何携带 Origin 且不是 chrome-extension:// 的连接一律拒绝 ——
 *      这条专门拦"用浏览器打开一个网页来驱动你本机的桥"。子网的 WebSocket 请求必然带 Origin，
 *      而本地进程（我们的 server）不带，因此两者可被干净区分。
 *   3. 扩展配对（TOFU）：扩展首次连接可以不带令牌，但必须来自 chrome-extension://，
 *      桥会把令牌发给它并记住来源；此后只认令牌，且只允许同一扩展来源重新配对
 *      （覆盖"扩展存储被清空"的自愈场景）。
 *
 * 诚实说明残留风险：令牌文件与恶意进程同属一个用户，能被读走。这一层挡的是
 * "偶然连上的本机程序"和"网页"，不是"已经以你身份运行的恶意代码"。
 */
import { WebSocketServer } from 'ws';
import {
  resolveToken, loadBridgeState, markPaired, canPair, appendRun, rotateRuns,
} from './store.mjs';

const PORT = Number(process.env.WEBAGENTS_PORT || 8765);

rotateRuns();

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken({ create: true });

let ext = null;               // 扩展连接
const clients = new Set();    // mcp 客户端连接
const routes = new Map();     // request id -> { client, at }

/**
 * 扩展掉线后的两段式处理（2026-09-15 加）。
 *
 * 为什么不能一断就判死：连接可能只是**瞬时抖动**（offscreen 文档重连、网络栈抖动），
 * 而扩展侧的 Service Worker 仍在正常处理任务 —— 结果会从新连接回来。
 * 实测踩过：一次 1 秒的抖动把所有在飞请求判死，导致"任何超过 60 秒的问答都会被自己杀死"。
 *
 * 因此：先给 GRACE_MS 重连宽限；若已重连，再给一段收敛窗口等结果；
 * 仍无结果才判定丢失（30s，远早于旧的 6 分钟超时）。
 */
const EXT_GRACE_MS = 8000;      // 掉线后等待重连的时间
const EXT_RESUME_MS = 30000;    // 重连后仍未收到结果 → 判定任务已丢失
let extTimer = null;

const clearExtTimer = () => { if (extTimer) { clearTimeout(extTimer); extTimer = null; } };

function onExtGone() {
  clearExtTimer();
  const lostAt = Date.now();
  extTimer = setTimeout(() => {
    extTimer = null;
    if (ext && ext.readyState === 1) {
      // 已重连：给还在跑的任务一个收敛窗口，结果可能正从新连接回来
      extTimer = setTimeout(() => {
        extTimer = null;
        // 只失败"掉线之前"发出的请求 —— 新请求不该被旧故障连坐
        failRoutes('扩展重连后仍未返回结果（任务可能已随 Service Worker 一起丢失）', lostAt);
      }, EXT_RESUME_MS - EXT_GRACE_MS);
      return;
    }
    failRoutes('扩展连接中断（浏览器已关闭 / 扩展被卸载 / Service Worker 被回收后未恢复）', lostAt);
  }, EXT_GRACE_MS);
}

const log = (msg) => {
  console.error(`[WEBAGENTS-bridge] ${msg}`);
  appendRun({ kind: 'bridge', event: msg });
};

/**
 * 让在飞请求失败。默认全部；传 beforeTs 时只失败该时刻之前发出的请求
 * （用于"重连后仍未返回结果"的场景 —— 新发的请求不该被旧故障连坐）。
 */
function failRoutes(reason, beforeTs) {
  if (!routes.size) return;
  let n = 0;
  for (const [id, rec] of routes) {
    if (!rec || (beforeTs && rec.at > beforeTs)) continue;
    if (rec.client && rec.client.readyState === 1) {
      rec.client.send(JSON.stringify({ type: 'result', id, ok: false, error: reason }));
      n++;
    }
    routes.delete(id);
  }
  if (n) log(`已让 ${n} 个在飞请求失败：${reason}`);
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

// 绑定成功才宣告，绑定失败要能说清楚。
// 旧写法在构造后立刻打 "listening"，于是端口被占用时也会先报"已监听"再静默崩溃 ——
// 现场表现是"日志说在跑，实际没人监听"，最难查的那类。
wss.on('listening', () => {
  log(`listening on ws://127.0.0.1:${PORT}（令牌来源=${TOKEN_SOURCE}）`);
  if (TOKEN_SOURCE === 'generated') log('已生成新的桥接令牌并写入 bridge.json（扩展首次连接会自动配对）');
  if (TOKEN_SOURCE === 'file') {
    const st = loadBridgeState();
    log(`使用已存在的令牌（配对时间=${(st && st.pairedAt) || '未配对'}）`);
  }
});

wss.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用 —— 本机应只有一个桥（检查是否有残留进程，或另开一个 MCP 会话在跑）`);
  } else {
    log(`WebSocket 服务出错：${(err && err.message) || err}`);
  }
  process.exit(1);
});

wss.on('connection', (ws, req) => {
  let role = null;
  const origin = String((req.headers && req.headers.origin) || '');

  // ---- ① Origin 校验（连接建立时即判定，不等 hello）----
  // 网页发起的 WebSocket 握手必然带 Origin；本地进程默认不带。
  if (origin && !origin.startsWith('chrome-extension://')) {
    log(`拒绝连接：来源不被允许（Origin=${origin}）`);
    try { ws.send(JSON.stringify({ type: 'hello-fail', error: '来源不被允许' })); } catch {}
    return ws.close();
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello') {
      const wanted = msg.role === 'mcp' ? 'mcp' : 'ext';

      if (msg.token === TOKEN) {
        // 正常路径
      } else if (wanted === 'ext' && canPair(origin)) {
        // 配对（TOFU）：把令牌交给它，此后只认令牌。
        // 首次配对必然发生一次（扩展还没有令牌）；扩展存储被清空后也会走到这里。
        markPaired(origin);
        log(`扩展配对成功（来源=${origin || '未上报 Origin'}${msg.token ? '，原令牌已失效' : ''}），令牌已下发`);
        role = 'ext';
        attachExt(ws);
        ws.send(JSON.stringify({ type: 'hello-ok', role, token: TOKEN }));
        return;
      } else {
        log(`拒绝连接：令牌不匹配（role=${wanted}${origin ? `, Origin=${origin}` : '，未上报 Origin'}）`);
        try { ws.send(JSON.stringify({ type: 'hello-fail', error: '令牌不匹配' })); } catch {}
        return ws.close();
      }

      role = wanted;
      if (role === 'ext') attachExt(ws);
      else clients.add(ws);
      ws.send(JSON.stringify({ type: 'hello-ok', role }));
      return;
    }

    if (!role) return;

    if (role === 'mcp' && msg.type === 'request') {
      if (!ext || ext.readyState !== 1) {
        return ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'WEBAGENTS 扩展未连接（请在 Edge 中确认扩展已启用且浏览器已打开）' }));
      }
      routes.set(msg.id, { client: ws, at: Date.now() });
      ext.send(JSON.stringify(msg));
      return;
    }

    if (role === 'ext' && msg.type === 'result') {
      const rec = routes.get(msg.id);
      if (rec && rec.client && rec.client.readyState === 1) rec.client.send(JSON.stringify(msg));
      routes.delete(msg.id);
      return;
    }
    // ping 等其它消息直接忽略
  });

  ws.on('close', () => {
    if (role === 'ext' && ext === ws) {
      ext = null;
      log('扩展断开连接');
      // 不立刻判死在飞请求：先给重连宽限，抖动场景下结果会从新连接回来（见 onExtGone）
      onExtGone();
    }
    clients.delete(ws);
    for (const [id, rec] of routes) if (rec && rec.client === ws) routes.delete(id);
  });

  ws.on('error', () => {});
});

function attachExt(ws) {
  if (ext && ext !== ws) {
    // 旧扩展连接被顶替。这里同样走宽限：很可能只是 offscreen 文档重连，
    // 而 SW 仍在处理任务、结果会从新连接回来。
    // 若确实是换了扩展实例，宽限期结束后仍收不到结果即判丢失。
    try { ext.close(); } catch {}
    onExtGone();
  }
  ext = ws;
  log('扩展已接入');
}
