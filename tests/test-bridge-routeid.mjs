#!/usr/bin/env node
/**
 * bridge.mjs 在飞请求 id 唯一性 集成测试（起真进程 + 真 WebSocket）
 *
 * 背景（2026-09-21 实测，连打三次全部复现）：桥按 id 全局索引在飞请求，而调用方的 id
 * 只在各自进程内唯一（每个 CLI 都从 cli-1 开始）。两个 CLI 进程并发时 ——
 *   后注册者顶掉前者的路由 → 前者的结果被投给后者（**答案张冠李戴**），
 *   后者自己的结果回来时已无路可发、被丢弃 → 前者干等到自己的超时。
 * 这就是 09-20 那 53 次"扩展执行超时（300s/480s）"的形态：并发 CLI 是 skill 里
 * 明确推荐的 fanout 用法，所以它是常态而不是边缘情况。
 *
 * 要锁住两件事：
 *   ① 桥不再静默覆盖 —— 后来者立刻拿到"请求 id 冲突"的明确错误；
 *   ② 前一个请求的路由保持不动，扩展的结果仍然回到真正的发起方。
 * （客户端侧的全局唯一 id 在 cli.mjs 里，见 CLIENT_NONCE。）
 *
 * 运行：node test-bridge-routeid.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

// 测试住在 tests/ 下：ROOT = 仓库根（被测代码在 server/ 与 extension/）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'server', 'package.json'));
const { WebSocket } = require('ws');

const PORT = 8794;
const TOKEN = 'webagents-test-routeid';
const URL_ = `ws://127.0.0.1:${PORT}`;
const ID = 'cli-1';                       // 两个调用方各自都会产生的 id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, note) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? '  ' + note : ''}`);
  if (!ok) fail++;
};

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'bridge.mjs')], {
  env: {
    ...process.env, WEBAGENTS_PORT: String(PORT), WEBAGENTS_TOKEN: TOKEN,
    WEBAGENTS_HB_MS: '60000',             // 本测试不关心心跳，拉长到不会被触发
    WEBAGENTS_HOME: path.join(os.tmpdir(), 'webagents-test-routeid'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

function connect(role) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL_);
    const box = { ws, msgs: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role, token: TOKEN })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello-ok') { res(box); return; }
      box.msgs.push(m);
    });
    ws.on('error', rej);
    setTimeout(() => rej(new Error(`${role} 握手超时`)), 4000);
  });
}
const findResult = (box, pred) => box.msgs.find((m) => m.type === 'result' && (!pred || pred(m)));

try {
  await sleep(700);
  const ext = await connect('ext');       // 假扩展：只负责把结果按原 id 回投
  const a = await connect('cli');
  const b = await connect('cli');

  a.ws.send(JSON.stringify({ type: 'request', id: ID, action: 'ask', site: 'deepseek', prompt: 'A 的问题' }));
  await sleep(200);
  b.ws.send(JSON.stringify({ type: 'request', id: ID, action: 'ask', site: 'qwen', prompt: 'B 的问题' }));
  await sleep(400);

  const forwarded = ext.msgs.filter((m) => m.type === 'request');
  check('第一个请求已转发给扩展', forwarded.some((m) => m.prompt === 'A 的问题'), JSON.stringify(forwarded.map((m) => m.prompt)));
  const bConflict = findResult(b, (m) => m.id === ID);
  check('同 id 的第二个请求被明确拒绝（不再静默顶掉前者）',
    !!bConflict && bConflict.ok === false && /冲突/.test(String(bConflict.error)),
    bConflict ? String(bConflict.error).slice(0, 70) : 'b 没拿到任何回应');
  check('被拒的后来者拿到了可执行的解释（提示要唯一 id）',
    !!bConflict && /唯一|升级/.test(String(bConflict.error)), String(bConflict && bConflict.error).slice(0, 90));

  // 扩展按 id 回结果 —— 必须回到 A（真正的发起方），而不是 b，也不是被丢弃
  ext.ws.send(JSON.stringify({ type: 'result', id: ID, ok: true, text: 'A 的答案', mdLen: 4 }));
  await sleep(400);
  const aGot = findResult(a, (m) => m.id === ID);
  check('扩展的结果仍回到真正的发起方 A（路由没被顶掉）',
    !!aGot && aGot.ok === true && aGot.text === 'A 的答案', JSON.stringify(aGot || 'A 什么都没收到'));
  const bExtra = b.msgs.filter((m) => m.type === 'result' && m.id === ID).length;
  check('A 的答案没有被顺带投给 B', bExtra === 1, `B 收到 ${bExtra} 条同 id 结果（预期只有那条冲突报错）`);
  check('冲突事件进了日志（事后取证看得见）', /id 冲突/.test(stderr),
    stderr.split('\n').filter((l) => /冲突/.test(l)).slice(-1)[0] || '无该行');
} catch (err) {
  console.log('  FAIL 测试异常：' + err.message);
  fail++;
} finally {
  child.kill();
  console.log(`\n结果：失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
}
