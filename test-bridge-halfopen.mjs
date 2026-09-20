#!/usr/bin/env node
/**
 * bridge.mjs 半开检测 集成测试（起真进程 + 真 WebSocket）
 *
 * 锁住的行为：扩展 socket 名义上 still OPEN（不 close、不 result、也不应心跳），
 * 桥必须在心跳窗口内判为半开并强制回收该连接，让在飞请求拿到**明确失败**；
 * 而不是像 2026-09-20 那样让调用方挂到 ask 自己的 300/480 秒超时
 * （实测一条 ask 记到 ms=7212.9s / stage=connect，且日志里没有任何"扩展断开连接"事件）。
 *
 * 运行：node test-bridge-halfopen.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, 'server', 'index.mjs'));
const { WebSocket } = require('ws');

const PORT = 8798;
const TOKEN = 'webagents-test';
const HB = 300;                     // 心跳间隔压到 300ms，整测试 1~2 秒内结束
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, note) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? '  ' + note : ''}`); if (!ok) fail++; };

const child = spawn(process.execPath, [path.join(__dirname, 'server', 'bridge.mjs')], {
  env: { ...process.env, WEBAGENTS_PORT: String(PORT), WEBAGENTS_TOKEN: TOKEN, WEBAGENTS_HB_MS: String(HB),
    WEBAGENTS_HOME: path.join(os.tmpdir(), 'webagents-test-halfopen') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const handshake = (role) => new Promise((res, rej) => {
  const ws = new WebSocket(URL);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role, token: TOKEN, ...(role === 'ext' ? { hb: 1 } : {}) })));
  ws.on('message', () => { res(ws); });
  ws.on('error', rej);
  setTimeout(() => rej(new Error('hello 超时')), 4000);
});

try {
  await sleep(700);
  const ext = await handshake('ext');        // 假扩展：完成握手，之后一概不理
  const cli = await handshake('mcp');
  const got = new Promise((res) => cli.on('message', (raw) => { try { (()=>{const m=JSON.parse(raw.toString());if(m.type==='result')res(m)})(); } catch {} }));
  cli.send(JSON.stringify({ type: 'request', id: 'r1', action: 'ask', site: 'deepseek', prompt: 'x' }));
  // 在心跳窗口内不该有结果（假扩展不应答），所以此刻仍在飞
  await sleep(HB);
  const early = await Promise.race([got.then(() => 'answered'), sleep(HB).then(() => 'pending')]);
  check('心跳窗口前仍在飞（没被误杀）', early === 'pending', `实际=${early}`);
  // 判半开需要：两次无应答的探测 + 8s 重连宽限之外的路径 → 用足够等待覆盖
  const msg = await Promise.race([got, sleep(12000).then(() => null)]);
  check('半开被检出并让在飞请求明确失败', !!msg && msg.id === 'r1' && msg.ok === false, msg ? JSON.stringify(msg).slice(0, 160) : '12s 内无回复（仍在干等）');
  check('失败原因说清是半开/连接中断', !!msg && /半开|重连|中断/.test(String(msg.error || '')), String(msg && msg.error).slice(0, 80));
  check('事件被写进日志（事后取证能看到「半开」）', /半开/.test(stderr), stderr.split('\n').filter((l) => /半开|扩展/.test(l)).slice(-2).join(' ⏎ ').slice(0, 160));
  // 半开后连接被回收：桥应能接受同一扩展重新接入并正常完成请求
  ext.close();
  const ext2 = await handshake('ext');
  // result 是回给**发起方**（cli）的，不是回给扩展的 —— 挂错边会让这条检查永远等不到东西
  const done = new Promise((res) => cli.on('message', (raw) => {
    try { const m = JSON.parse(raw.toString()); if (m.type === 'result' && m.id === 'r2') res(m); } catch {}
  }));
  cli.send(JSON.stringify({ type: 'request', id: 'r2', action: 'ask', site: 'deepseek', prompt: 'y' }));
  await sleep(HB / 2);
  ext2.send(JSON.stringify({ type: 'result', id: 'r2', ok: true, mdLen: 3 }));
  const r2 = await Promise.race([done, sleep(4000).then(() => null)]);
  check('回收后新连接能继续正常工作（自愈）', !!r2 && r2.ok === true, JSON.stringify(r2 || {}).slice(0, 120));
} catch (err) {
  console.log('  FAIL 测试异常：' + err.message);
  fail++;
} finally {
  child.kill();
  process.exit(fail ? 1 : 0);
}
