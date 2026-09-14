#!/usr/bin/env node
/**
 * 站点级串行队列 行为测试（载入真实的 background.js，不是复制实现）
 *
 * 为什么需要：并发串话是"必现级"缺陷，而队列本身又是并发代码 —— 这类逻辑
 * 靠人工读代码看不出来。这里给 chrome/WebSocket 打桩后把真实文件加载进来，
 * 直接测 enqueueSite 的真实行为（顺序、隔离、排队超时、计数）。
 *
 * 运行：node test-scheduling.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, 'extension', 'background.js'), 'utf8');

// ---- 给 background.js 的顶层副作用打桩 ----
class FakeWebSocket {
  constructor() { this.readyState = 0; }
  send() {}
  close() {}
}
const noop = () => {};
const fakeChrome = {
  alarms: { create: noop, onAlarm: { addListener: noop } },
  runtime: { onMessage: { addListener: noop } },
  debugger: { onDetach: { addListener: noop } },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: {}, scripting: {},
};

// 把顶层作用域里的东西取出来（真实实现，零复制）
const factory = new Function(
  'chrome', 'WebSocket', 'setInterval', 'setTimeout', 'console',
  `${src}\n;return { enqueueSite, queueSnapshot, lastAskEndAt, DEFAULT_THROTTLE_SEC, QUEUE_WAIT_MS, TERMINAL_STATUS_TEXT, firstSignalBudget, ACKED_FIRST_SIGNAL_MS };`,
);
const api = factory(fakeChrome, FakeWebSocket, noop, setTimeout, console);
const { enqueueSite, queueSnapshot, lastAskEndAt, DEFAULT_THROTTLE_SEC, QUEUE_WAIT_MS, firstSignalBudget, ACKED_FIRST_SIGNAL_MS } = api;

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n[1] 配置合理性');
check('默认节流为 3 秒（不拖慢正常使用）', DEFAULT_THROTTLE_SEC, 3);
check('排队上限为 4 分钟（够长，不误杀正常排队）', QUEUE_WAIT_MS, 240000);

console.log('\n[2] 串行：同站点任务不重叠、顺序不乱');
{
  const log = [];
  const t1 = enqueueSite('s', async () => { log.push('A-start'); await sleep(60); log.push('A-end'); return 'A'; });
  const t2 = enqueueSite('s', async () => { log.push('B-start'); await sleep(10); log.push('B-end'); return 'B'; });
  const t3 = enqueueSite('s', async () => { log.push('C-start'); return 'C'; });
  const r = await Promise.all([t1, t2, t3]);
  check('执行顺序严格串行', log, ['A-start', 'A-end', 'B-start', 'B-end', 'C-start']);
  check('各自的返回值正确', r, ['A', 'B', 'C']);
}

console.log('\n[3] 不同站点互不阻塞（保留并行的能力）');
{
  const order = [];
  const p1 = enqueueSite('x', async () => { order.push('x-start'); await sleep(50); order.push('x-end'); });
  const p2 = enqueueSite('y', async () => { order.push('y-start'); await sleep(10); order.push('y-end'); });
  await Promise.all([p1, p2]);
  check('两个站点可并行（y 不排在 x 后面）', order, ['x-start', 'y-start', 'y-end', 'x-end']);
}

console.log('\n[4] 前一个任务失败不影响后续（队列不能因异常卡死）');
{
  const t1 = enqueueSite('e', async () => { throw new Error('boom'); });
  const t2 = enqueueSite('e', async () => 'ok');
  let err = null;
  await t1.catch((e) => { err = e.message; });
  check('失败按原样抛出给调用方', err, 'boom');
  check('后续任务照常执行', await t2, 'ok');
}

console.log('\n[5] 排队超时：明确报错，不无限沉默');
{
  const blocker = enqueueSite('q', async () => { await sleep(300); return 'slow'; });
  // 用很小的上限模拟"前序任务卡死"
  const queued = enqueueSite('q', async () => 'should-not-run', 50);
  let msg = null;
  await queued.catch((e) => { msg = e.message; });
  check('超时任务被拒绝', typeof msg === 'string', true);
  check('错误信息说明是排队未轮到', /排队 \d+s 仍未轮到/.test(msg || ''), true);
  check('被拒绝的任务确实没有执行结果', msg !== null, true);
  check('前序任务仍然正常完成', await blocker, 'slow');
}

console.log('\n[6] 队列深度可观测（fleet_status 用）');
{
  const p1 = enqueueSite('d', async () => { await sleep(80); });
  const p2 = enqueueSite('d', async () => { await sleep(10); });
  await sleep(10);
  check('排队中能报告深度 2', queueSnapshot().d, 2);
  await Promise.all([p1, p2]);
  check('跑完后不再出现该站点', queueSnapshot().d, undefined);
}

console.log('\n[7] 节流状态容器（时间来源，供上层计算间隔）');
{
  check('初始没有记录', lastAskEndAt.get('never'), undefined);
  lastAskEndAt.set('s2', 12345);
  check('可记录上次结束时间', lastAskEndAt.get('s2'), 12345);
}

console.log('\n[8] 首反馈预算：只在"发送无法确认"时才严格');
{
  // 目的：ack 已确认（注入读回 + 发送校验都过）时，不该因为站点慢就报
  // 「发送未生效」——开启智能搜索时首字可能落在 12s 之后。ack 丢失才用严格窗口。
  check('ack 丢失 → 用站点严格值（12s）', firstSignalBudget(false, 12000), 12000);
  check('ack 确认 → 放宽到 25s', firstSignalBudget(true, 12000), ACKED_FIRST_SIGNAL_MS);
  check('站点自带值更宽时不反而收紧（千问 30s）', firstSignalBudget(true, 30000), 30000);
  check('站点自带值更宽时 ack 丢失也不收紧', firstSignalBudget(false, 30000), 30000);
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
