#!/usr/bin/env node
/**
 * bridge.mjs 鉴权 集成测试（真进程 + 真 WebSocket）
 *
 * 为什么需要：旧实现把令牌 'webagents-local' 硬编码在桥和扩展里，等于没有鉴权 ——
 * 本机任何进程连上 8765 就能借扩展的登录态发 prompt。改完之后必须锁住：
 *   · 无令牌 / 错令牌一律拒绝
 *   · 带网页 Origin 的连接一律拒绝（拦"用网页驱动本机桥"）
 *   · 扩展首次可配对拿到令牌，但只认已配对的同一个扩展来源
 *   · 令牌跨重启保持（否则每次重启都要重新配对）
 *
 * 运行：node test-bridge-auth.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, 'server', 'index.mjs'));
const { WebSocket } = require('ws');

const PORT = 8798;
const URL_ = `ws://127.0.0.1:${PORT}`;
const HOME = path.join(os.tmpdir(), 'webagents-test-auth');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
const TOKEN_FILE = path.join(HOME, 'bridge.json');

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startBridge() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server', 'bridge.mjs')], {
    env: { ...process.env, WEBAGENTS_PORT: String(PORT), WEBAGENTS_HOME: HOME, WEBAGENTS_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return child;
}

/** 尝试握手，返回 { ok, token, error }（不抛异常，便于断言各类拒绝） */
function hello({ role = 'mcp', token, origin } = {}) {
  return new Promise((resolve) => {
    const opts = origin ? { headers: { Origin: origin } } : {};
    const ws = new WebSocket(URL_, opts);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { ws.terminate(); } catch {} resolve(v); } };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 4000);
    ws.on('open', () => {
      const payload = { type: 'hello', role };
      if (token !== undefined) payload.token = token;
      ws.send(JSON.stringify(payload));
    });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'hello-ok') { clearTimeout(timer); done({ ok: true, token: m.token, role: m.role }); }
      if (m.type === 'hello-fail') { clearTimeout(timer); done({ ok: false, error: m.error }); }
    });
    ws.on('error', () => { clearTimeout(timer); done({ ok: false, error: 'socket-error' }); });
    ws.on('close', () => { clearTimeout(timer); done({ ok: false, error: 'closed' }); });
  });
}

console.log('\n[1] 启动时生成随机令牌（不再有硬编码默认值）');
let child = startBridge();
await sleep(900);
let state = null;
try { state = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
check('令牌文件已生成', !!state, true);
check('令牌不是旧硬编码值', state && state.token !== 'webagents-local', true);
check('令牌有足够长度（≥32 字符）', state && String(state.token).length >= 32, true);
check('初始未配对', state && state.pairedAt, null);
const TOKEN = state ? state.token : '';

console.log('\n[2] 鉴权：错令牌 / 无令牌一律拒绝');
check('无令牌的 mcp 连接被拒', (await hello({ role: 'mcp' })).ok, false);
check('错令牌被拒', (await hello({ role: 'mcp', token: 'webagents-local' })).ok, false);
check('旧硬编码令牌无效（关键：堵住默认值）',
  (await hello({ role: 'mcp', token: 'webagents-local' })).error, '令牌不匹配');
check('正确令牌通过', (await hello({ role: 'mcp', token: TOKEN })).ok, true);

console.log('\n[3] Origin 校验：网页来源一律拒绝');
{
  const r = await hello({ role: 'mcp', token: TOKEN, origin: 'https://evil.example' });
  check('带网页 Origin 的连接被拒（即使令牌正确）', r.ok, false);
}
{
  const r = await hello({ role: 'mcp', token: TOKEN, origin: 'http://localhost:3000' });
  check('localhost 网页来源同样被拒', r.ok, false);
}

console.log('\n[4] 扩展配对（TOFU）：无令牌但来源合法才放行');
{
  const r = await hello({ role: 'ext', origin: 'chrome-extension://aaaabbbbccccdddd' });
  check('扩展首次配对成功', r.ok, true);
  check('配对时下发了令牌', r.token, TOKEN);
  const st = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  check('配对状态已落盘', !!st.pairedAt, true);
  check('记录了配对来源', st.pairedOrigin, 'chrome-extension://aaaabbbbccccdddd');
}
{
  const r = await hello({ role: 'ext' });
  check('无令牌且无 Origin（本机进程冒充）被拒', r.ok, false);
}
{
  const r = await hello({ role: 'ext', origin: 'chrome-extension://differentid999' });
  check('配对后换一个扩展来源被拒', r.ok, false);
}
{
  const r = await hello({ role: 'ext', origin: 'chrome-extension://aaaabbbbccccdddd' });
  check('同一扩展来源可重新配对（覆盖存储被清空的自愈）', r.ok, true);
}
check('已配对的扩展用令牌直连也正常', (await hello({ role: 'ext', token: TOKEN })).ok, true);

console.log('\n[5] 令牌跨重启保持（否则每次重启都要重新配对）');
child.kill();
await sleep(500);
child = startBridge();
await sleep(900);
const st2 = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
check('重启后令牌不变', st2.token, TOKEN);
check('重启后旧扩展令牌仍可用', (await hello({ role: 'ext', token: TOKEN })).ok, true);

child.kill();
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
