#!/usr/bin/env node
/**
 * WEBAGENTS-bridge — 单例 WS 桥接（唯一持有 8765 端口的进程）
 *
 * 角色路由：
 *   - ext  ：WEBAGENTS Edge 扩展（唯一的扩展连接，新连接顶掉旧的）
 *   - cli  ：一个或多个命令行调用方（cli.mjs 的每条命令、测试客户端可共存）
 *
 * 消息流：cli 发 request{id,...} → 转发给 ext；ext 回 result{id,...} → 按 id 路由回发起的 cli。
 *
 * 请求 id 的责任在调用方：**必须全局唯一**（不能只在各自进程内唯一）。
 * 桥按 id 索引在飞请求，两个进程都用 "cli-1" 会让后注册者顶掉前者 ——
 * 前者的结果被投给后者（答案张冠李戴，比失败更难查），前者干等到自己的超时。
 * 09-21 实测：两个客户端同时发 id=cli-1，三次全部复现"B 要 qwen 却拿到 deepseek、A 一无所获"。
 * 桥侧加了冲突守卫（见 routes），但那只是把静默错误变成明确报错，不能替代唯一 id。
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
const clients = new Set();    // 调用方（cli.mjs）连接
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

/**
 * 半开检测：应用层心跳（2026-09-20 加，2026-09-21 扩到两侧）。
 *
 * 为什么必须有：掉线处理全部挂在 socket 的 `close` 事件上，而**机器休眠 / 浏览器被冻结时
 * 不会有 close**——TCP 没有 FIN，服务端侧 `readyState` 依旧是 1，于是消息发得出去、没人回，
 * 在飞请求既不失败也不返回，客户端只能等到自己的超时。
 * 实测现场（runs.jsonl）：一次 ask 记录 ms=7212.9s、stage=connect、queuedMs=0，
 * 且**失败前后日志里根本没有"扩展断开连接"事件**——"没记录到断开"当时被我读成"没断"。
 * 心跳的作用就是把这种状态变成"可检测 + 有事件"：连续 HB_MISS 次无应答即判半开，
 * 直接 terminate 掉这条僵尸连接（触发 onExtGone 让在飞请求快速失败、并让扩展侧自查重连），
 * 同时把事件写进 runs.jsonl，事后取证才看得见。
 *
 * 为什么两侧都要（09-21）：线有两段（调用方↔桥、桥↔扩展），休眠时是两段一起僵。
 * 只保后半段的话，桥判出半开、把失败通知发给前半段那条同样已经废了的线，
 * 照样是"发进空气"（见 failRoutes 的投递判定）。
 *
 * 兼容性：只有在 hello 里自报 `hb:1` 的连接才参与半开判定 —— 部署时「桥先升、扩展后升」
 * 是常态，无条件发心跳会让旧扩展每隔 ~45s 被误判半开并强制重连，那是我们自己造的假故障。
 */
const HB_MS = Number(process.env.WEBAGENTS_HB_MS || 15000);   // 心跳间隔（测试可压到秒级）
const HB_MISS = 2;            // 容忍次数：≈30s 内发现半开（远早于 ask 的 300/480s 超时）

/** 握手时给这条连接装活性跟踪：没自报会应答的一律不装（旧端） */
function armHeartbeat(ws) {
  if (!ws.helloHb) return;
  ws.hbAckAt = Date.now();
  ws.hbArmed = true;
}

/** 这条连接是否还在听（未参与心跳的旧连接无从判断，按"可用"处理，与加心跳之前一致） */
const isLive = (ws) => !!ws && (!ws.hbArmed || Date.now() - ws.hbAckAt < HB_MS * HB_MISS);

setInterval(() => {
  for (const ws of [ext, ...clients]) {
    if (!ws || !ws.hbArmed || ws.readyState !== 1) continue;
    if (isLive(ws)) {
      try { ws.send(JSON.stringify({ type: 'hb', t: Date.now() })); } catch {}
      continue;
    }
    const who = ws === ext ? '扩展' : '调用方';
    log(`${who}半开：心跳连续 ${HB_MISS} 次无应答（连接名义上仍在），已强制回收该连接`);
    try { ws.terminate(); } catch { try { ws.close(); } catch {} }   // terminate 不等握手，专治僵尸
  }
}, HB_MS);

const log = (msg) => {
  console.error(`[WEBAGENTS-bridge] ${msg}`);
  appendRun({ kind: 'bridge', event: msg });
};

/**
 * 让在飞请求失败。默认全部；传 beforeTs 时只失败该时刻之前发出的请求
 * （用于"重连后仍未返回结果"的场景 —— 新发的请求不该被旧故障连坐）。
 *
 * 投递前先判这条线是否还活着（09-21）：`readyState===1` 只代表"名义上通着"，
 * 半开时 send 会进发送缓冲、既不报错也不回调，而旧实现一 send 就当送达并删掉记录 ——
 * 结果调用方仍在等，日志却写着"已让 N 个请求失败"。宁可如实说"通知送不出去"。
 */
function failRoutes(reason, beforeTs) {
  if (!routes.size) return;
  let delivered = 0;
  let undeliverable = 0;
  for (const [id, rec] of routes) {
    if (!rec || (beforeTs && rec.at > beforeTs)) continue;
    if (rec.client && rec.client.readyState === 1 && isLive(rec.client)) {
      rec.client.send(JSON.stringify({ type: 'result', id, ok: false, error: reason }));
      delivered++;
    } else {
      undeliverable++;
    }
    routes.delete(id);
  }
  if (delivered) log(`已让 ${delivered} 个在飞请求失败：${reason}`);
  if (undeliverable) {
    log(`${undeliverable} 个在飞请求的失败通知送不出去（该连接半开或已关闭），调用方会等到自己的超时：${reason}`);
  }
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
    log(`端口 ${PORT} 已被占用 —— 本机应只有一个桥（检查是否有残留进程，或另有一条 CLI 命令/驻留桥在跑）`);
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
      const wanted = msg.role === 'ext' ? 'ext' : 'cli';
      ws.helloHb = !!msg.hb;        // 对端是否自报"会应答心跳"（装不装半开检测的依据）

      if (msg.token === TOKEN) {
        // 正常路径
      } else if (wanted === 'ext' && canPair(origin)) {
        // 配对（TOFU）：把令牌交给它，此后只认令牌。
        // 首次配对必然发生一次（扩展还没有令牌）；扩展存储被清空后也会走到这里。
        markPaired(origin);
        log(`扩展配对成功（来源=${origin || '未上报 Origin'}${msg.token ? '，原令牌已失效' : ''}），令牌已下发`);
        role = 'ext';
        armHeartbeat(ws);          // 必须在 attachExt 之前：那里的日志要读 hbArmed
        attachExt(ws);
        ws.send(JSON.stringify({ type: 'hello-ok', role, token: TOKEN }));
        return;
      } else {
        log(`拒绝连接：令牌不匹配（role=${wanted}${origin ? `, Origin=${origin}` : '，未上报 Origin'}）`);
        try { ws.send(JSON.stringify({ type: 'hello-fail', error: '令牌不匹配' })); } catch {}
        return ws.close();
      }

      role = wanted;
      // 心跳在**两条握手路径上都要装**：09-21 前的实现只在 attachExt 里按 hello.hb 启用，
      // 而 TOFU 配对那条路没传 hello —— 于是"首次安装"和"扩展存储被清空后自愈"这两条
      // 恰好最需要保护的路径永远没有半开检测。
      armHeartbeat(ws);
      if (role === 'ext') attachExt(ws);
      else clients.add(ws);
      ws.send(JSON.stringify({ type: 'hello-ok', role }));
      return;
    }

    if (!role) return;

    if (msg.type === 'hb-ack') {
      if (ws.hbArmed) ws.hbAckAt = Date.now();
      return;
    }

    if (role === 'cli' && msg.type === 'request') {
      if (!ext || ext.readyState !== 1) {
        return ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'WEBAGENTS 扩展未连接（请在 Edge 中确认扩展已启用且浏览器已打开）' }));
      }
      // id 冲突守卫：静默覆盖会把前一个调用方的结果投给后一个（张冠李戴），
      // 而前者只能干等到超时。这里如实拒绝后来者，让它换个唯一 id 重来。
      if (routes.has(msg.id)) {
        const from = routes.get(msg.id);
        log(`请求 id 冲突：${msg.id} 已在飞（来自另一条连接），已拒绝后来者 —— 调用方的请求 id 必须全局唯一`);
        return ws.send(JSON.stringify({
          type: 'result', id: msg.id, ok: false,
          error: `请求 id 冲突（${msg.id} 正被另一个调用方使用）：桥按 id 路由结果，重复会串到别人手里。请升级调用方（0.7.0 起 id 带进程唯一前缀）`,
          from,
        }));
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
    // 其它消息直接忽略
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
  log(`扩展已接入${ws.hbArmed ? '（心跳已启用）' : '（该扩展未声明心跳能力，半开检测不可用——请升级扩展）'}`);
}
