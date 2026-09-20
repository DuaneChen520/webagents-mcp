#!/usr/bin/env node
/**
 * bridge.mjs 掉线处理 集成测试（起真进程 + 真 WebSocket）
 *
 * 要锁住的是**两段式**语义（2026-09-15 定稿）：
 *   · 瞬时抖动（断开后很快重连）→ 在飞请求必须活着，结果要能从新连接送达
 *   · 真的没了（宽限期内没回来）→ 明确失败，不能干等到 6 分钟
 *
 * 为什么必须两段：一断就判死会误杀"扩展仍在正常处理、只是连接抖了一下"的任务；
 * 反之一直不判死又会让调用方无限沉默。实测踩过前者 ——
 * 1 秒抖动把在飞请求全部判死，表现为"任何超过 60 秒的问答都会被自己杀死"。
 *
 * 运行：node test-bridge-failfast.mjs
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

const PORT = 8799;              // 独立端口，避免干扰正在使用的 8765
const TOKEN = 'webagents-test';
const URL = `ws://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`); }
}

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'bridge.mjs')], {
  env: {
    ...process.env,
    WEBAGENTS_PORT: String(PORT),
    WEBAGENTS_TOKEN: TOKEN,
    // 隔离状态目录：测试不应写入真实的令牌/运行记录
    WEBAGENTS_HOME: path.join(os.tmpdir(), 'webagents-test-failfast'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', () => {});   // 丢弃 bridge 日志，保持输出干净

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建连接并完成 hello 握手 */
function connect(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timer = setTimeout(() => reject(new Error('hello 超时')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role, token: TOKEN })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'hello-ok') { clearTimeout(timer); resolve(ws); }
      if (m.type === 'hello-fail') { clearTimeout(timer); reject(new Error(m.error)); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 等待某类消息（可带前缀过滤），超时返回 null */
function waitFor(ws, pred, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); resolve(null); }, timeoutMs);
    function onMsg(raw) {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (pred(m)) { clearTimeout(timer); ws.off('message', onMsg); resolve(m); }
    }
    ws.on('message', onMsg);
  });
}

console.log('\n[1] 启动 bridge 并握手');
await sleep(600);
let cli = null;
let ext = null;
try {
  cli = await connect('cli');
  check('cli 角色握手成功', !!cli, true);
  ext = await connect('ext');
  check('ext 角色握手成功', !!ext, true);
} catch (e) {
  console.log(`  FAIL 握手失败：${e.message}`);
  fail++;
}

console.log('\n[2] 正常转发（回归：别把正常路径改坏）');
{
  const seen = waitFor(ext, (m) => m.type === 'request' && m.id === 'req-A');
  cli.send(JSON.stringify({ type: 'request', id: 'req-A', action: 'ping' }));
  const got = await seen;
  check('扩展侧收到转发请求', got && got.id, 'req-A');
  // 扩展回包 → cli 应收到
  const back = waitFor(cli, (m) => m.type === 'result' && m.id === 'req-A');
  ext.send(JSON.stringify({ type: 'result', id: 'req-A', ok: true, data: { connected: true } }));
  const r = await back;
  check('结果按 id 路由回 cli', r && r.ok, true);
}

console.log('\n[3] 瞬时抖动：断开后重连，在飞请求必须活着（不能被自己人杀掉）');
{
  // 背景：offscreen 文档重连、网络栈抖动都会造成秒级断开，而扩展侧 SW 仍在正常处理任务。
  // 旧实现一断就把在飞请求全部判死 —— 实测代价是"任何超过 60 秒的问答都会被自己杀死"。
  const seen = waitFor(ext, (m) => m.type === 'request' && m.id === 'req-B');
  cli.send(JSON.stringify({ type: 'request', id: 'req-B', action: 'ask' }));
  await seen;

  const early = waitFor(cli, (m) => m.type === 'result' && m.id === 'req-B', 12000);
  ext.close();                        // 抖动
  await sleep(1000);
  const ext2 = await connect('ext');  // 1 秒后回来
  const got = await Promise.race([early, sleep(3000).then(() => 'still-pending')]);
  check('重连后 3 秒内没有被判失败', got === 'still-pending', true);

  // 结果从新连接回来 —— 必须能送达（这正是抖动场景下真实发生的事）
  const delivered = waitFor(cli, (m) => m.type === 'result' && m.id === 'req-B', 5000);
  ext2.send(JSON.stringify({ type: 'result', id: 'req-B', ok: true, text: 'late-but-alive' }));
  const d = await delivered;
  check('结果可从新连接送达（旧实现这里会丢）', (d && d.text) || null, 'late-but-alive');
  ext2.close();
}

console.log('\n[3b] 扩展真的没了：宽限期后必须明确失败，不能干等到 6 分钟');
{
  ext = await connect('ext');
  const seen = waitFor(ext, (m) => m.type === 'request' && m.id === 'req-B2');
  cli.send(JSON.stringify({ type: 'request', id: 'req-B2', action: 'ask' }));
  await seen;
  const t0 = Date.now();
  const pending = waitFor(cli, (m) => m.type === 'result' && m.id === 'req-B2', 25000);
  ext.close();                        // 断开且不再回来
  const r = await pending;
  const ms = Date.now() - t0;
  check('在飞请求最终收到失败结果', !!(r && r.ok === false), true);
  check('错误信息说明是连接中断', /中断/.test((r && r.error) || ''), true);
  check(`宽限期后才判失败（实测 ${ms}ms，应 ≥7500 且远小于 6 分钟）`, ms >= 7500 && ms < 25000, true);
}

console.log('\n[4] 扩展不在线时的新请求 → 立即失败，不排队');
{
  const t0 = Date.now();
  cli.send(JSON.stringify({ type: 'request', id: 'req-C', action: 'ask' }));
  const r = await waitFor(cli, (m) => m.type === 'result' && m.id === 'req-C');
  const ms = Date.now() - t0;
  check('立即返回失败', !!(r && r.ok === false), true);
  check('错误信息提示扩展未连接', /未连接/.test((r && r.error) || ''), true);
  check(`在 1 秒内返回（实测 ${ms}ms）`, ms < 1000, true);
}

console.log('\n[5] 扩展重连后恢复可用（别改成一断就废）');
{
  const ext2 = await connect('ext');
  const seen = waitFor(ext2, (m) => m.type === 'request' && m.id === 'req-D');
  cli.send(JSON.stringify({ type: 'request', id: 'req-D', action: 'ping' }));
  check('重连后请求可正常转发', !!(await seen), true);
  const back = waitFor(cli, (m) => m.type === 'result' && m.id === 'req-D');
  ext2.send(JSON.stringify({ type: 'result', id: 'req-D', ok: true }));
  check('结果正常回传', !!((await back) || {}).ok, true);
  ext2.close();
}

try { cli && cli.close(); } catch { /* 忽略 */ }
child.kill();

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
