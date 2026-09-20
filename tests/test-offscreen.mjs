#!/usr/bin/env node
/**
 * offscreen.js 行为测试（假 chrome + 假 WebSocket，载入真实文件）
 *
 * 为什么需要：offscreen 文档只在真实浏览器里存在，平时跑不到 —— 而它现在承载着
 * 全部消息收发。这段逻辑一旦错，表现是"扩展在线但永远没有结果"，最难查。
 * 所以用打桩的方式把它的真实行为锁住：握手带令牌、配对回存、请求中继、指令收发、
 * 被拒后不急着重试、断开按退避重连。
 *
 * 运行：node test-offscreen.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 测试住在 tests/ 下：ROOT = 仓库根（被测代码在 server/ 与 extension/）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'extension', 'offscreen.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`); }
}

// ---- 打桩 ----
const swCalls = [];        // SW 收到的消息
let swListener = null;     // offscreen 注册的监听器（模拟 SW 向它发指令）
const timers = [];         // 记录 setTimeout（不真的跑，避免测试挂 60s）
let tokenReply = 'T1';

const fakeChrome = {
  runtime: {
    sendMessage: async (msg) => {
      swCalls.push(msg);
      if (msg.op === 'get-token') return { token: tokenReply };
      return { ok: true };
    },
    onMessage: { addListener: (fn) => { swListener = fn; } },
  },
};

class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.instances.push(this);
  }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  _msg(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
}

const factory = new Function(
  'chrome', 'WebSocket', 'setInterval', 'setTimeout', 'clearTimeout', 'console',
  `${src}\n;return {};`,
);
factory(
  fakeChrome, FakeWS, () => {}, (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, () => {}, console,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastSW = () => swCalls[swCalls.length - 1];
const swCallsOf = (op) => swCalls.filter((c) => c.op === op);

await sleep(30);   // 让 connect() 里的 await 走完

console.log('\n[1] 启动即连：先取令牌，再带着令牌握手');
{
  check('建立了 WebSocket 连接', FakeWS.instances.length, 1);
  check('连到本机桥端口', FakeWS.instances[0].url, 'ws://127.0.0.1:8765');
  check('向 SW 索取了令牌', swCallsOf('get-token').length, 1);
  const ws = FakeWS.instances[0];
  ws._open();
  check('握手声明 ext 角色', ws.sent[0].role, 'ext');
  check('握手带上存储里的令牌', ws.sent[0].token, 'T1');
}

console.log('\n[2] 配对：桥回带令牌时必须存回扩展存储');
{
  const ws = FakeWS.instances[0];
  ws._msg({ type: 'hello-ok', token: 'T2-NEW' });
  await sleep(10);
  check('新令牌已存回', (swCallsOf('save-token')[0] || {}).token, 'T2-NEW');
  check('已上报连接成功', lastSW().connected, true);
}

console.log('\n[3] 请求中继：桥的请求要转给 SW（这一步会唤醒休眠的 SW）');
{
  const ws = FakeWS.instances[0];
  ws._msg({ type: 'request', id: 'r1', action: 'ask', site: 'deepseek' });
  await sleep(10);
  const relay = swCallsOf('bridge-msg')[0];
  check('请求已中继给 SW', relay && relay.msg && relay.msg.id, 'r1');
  check('中继保留原始动作', relay.msg.action, 'ask');
}

console.log('\n[4] SW 指令：发结果回桥');
{
  const ws = FakeWS.instances[0];
  let resp = null;
  const handled = swListener(
    { target: 'offscreen', op: 'send', payload: { type: 'result', id: 'r1', ok: true, text: 'hi' } },
    {}, (r) => { resp = r; },
  );
  check('同步应答（不把 SW 挂住）', handled, false);
  check('应答表示发送成功', resp && resp.ok, true);
  check('结果已写入 WS', ws.sent[ws.sent.length - 1].id, 'r1');
  check('正文随结果回传', ws.sent[ws.sent.length - 1].text, 'hi');
}

console.log('\n[5] SW 指令：查询状态（fleet_status 用）');
{
  let resp = null;
  swListener({ target: 'offscreen', op: 'state' }, {}, (r) => { resp = r; });
  check('报告已连接', resp && resp.connected, true);
  check('报告未处于鉴权失败', resp.authFailed, false);
}

console.log('\n[6] 不属于自己的消息必须忽略（否则会跟 popup/内容脚本互相干扰）');
{
  const before = swCalls.length;
  let called = false;
  const handled = swListener({ type: 'stray-from-somewhere-else' }, {}, () => { called = true; });
  check('不处理、不应答', [handled, called], [false, false]);
  check('没有额外副作用', swCalls.length, before);
}

console.log('\n[7] 握手被拒：明确上报，并改为慢速重试（不刷日志）');
{
  const ws = FakeWS.instances[0];
  const timersBefore = timers.length;
  ws._msg({ type: 'hello-fail', error: '令牌不匹配' });
  await sleep(10);
  check('上报了失败原因', lastSW().error, '令牌不匹配');
  check('上报为未连接', lastSW().connected, false);
  check('安排了一次重试', timers.length > timersBefore, true);
  const t = timers[timers.length - 1];
  check('重试间隔为 60s（慢速，等人工处理）', t.ms, 60000);
}

console.log('\n[8] 断开：按退避重连，不再需要"外部把自己敲醒"');
{
  // 新起一个连接，验证退避序列
  FakeWS.instances.length = 0;
  tokenReply = 'T3';
  let resp = null;
  swListener({ target: 'offscreen', op: 'token', token: 'T3' }, {}, (r) => { resp = r; });
  await sleep(30);
  check('重置令牌后立刻重连', FakeWS.instances.length >= 1, true);
  check('指令被应答', resp && resp.ok, true);
  const ws = FakeWS.instances[FakeWS.instances.length - 1];
  ws._open();
  check('用新令牌握手', ws.sent[0].token, 'T3');
  const timersBefore = timers.length;
  ws.close();
  await sleep(10);
  const t = timers[timers.length - 1];
  check('断开后安排重连', timers.length > timersBefore, true);
  check('首次退避为 1s', t.ms, 1000);
}

console.log('\n[8b] 令牌指令必须幂等 —— 否则连接会被自己掐断');
{
  // 实测踩过的坑：SW 每次启动都会推一次令牌，而 SW 又被看门狗 alarm 每分钟唤醒，
  // 结果 offscreen 每分钟"断开重连"一次（日志里精确 60s 一断一续）。
  // 修法是双保险：SW 不再无脑推 + offscreen 收到相同令牌时不动作。
  FakeWS.instances.length = 0;
  let r = null;
  swListener({ target: 'offscreen', op: 'token', token: 'T3' }, {}, (x) => { r = x; });
  await sleep(30);
  check('令牌未变 → 不新建连接', FakeWS.instances.length, 0);
  check('应答标注 changed=false', r && r.changed, false);
  check('仍然应答成功', r && r.ok, true);

  // 令牌真的变了才重连
  swListener({ target: 'offscreen', op: 'token', token: 'T9' }, {}, () => {});
  await sleep(30);
  check('令牌变化 → 重建连接', FakeWS.instances.length >= 1, true);
  const w2 = FakeWS.instances[FakeWS.instances.length - 1];
  w2._open();
  check('用新令牌握手', w2.sent[0].token, 'T9');
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
