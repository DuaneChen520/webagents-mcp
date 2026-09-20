#!/usr/bin/env node
/**
 * bridge.mjs TOFU 首次配对 + 心跳 集成测试（起真进程 + 真 WebSocket）
 *
 * 要锁住的行为（2026-09-21 补）：半开检测必须对**每一条**自报 hb 的连接生效，
 * 包括走 TOFU 配对（首次安装 / 扩展存储被清空）的那条。
 * 旧实现只在 attachExt 里按 hello.hb 启用心跳，而配对分支调 attachExt 时没把 hello 传下去，
 * 结果"最需要保护的起点"恰好没有保护 —— 且现有两条心跳测试都用 env 预置令牌，
 * 走的是另一条分支，所以从来没测到。
 *
 * 运行：node test-bridge-tofu-hb.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 测试住在 tests/ 下：ROOT = 仓库根（被测代码在 server/ 与 extension/）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'server', 'package.json'));
const { WebSocket } = require('ws');

const PORT = 8796;
const HB = 300;                                   // 心跳间隔压到 300ms
const URL_ = `ws://127.0.0.1:${PORT}`;
const HOME = path.join(os.tmpdir(), 'webagents-test-tofu-hb');
const ORIGIN = 'chrome-extension://test-extension-id';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, note) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? '  ' + note : ''}`);
  if (!ok) fail++;
};

fs.rmSync(HOME, { recursive: true, force: true });

// 故意不给 WEBAGENTS_TOKEN：让桥自己生成令牌文件，扩展才能走 TOFU 配对分支
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'bridge.mjs')], {
  env: { ...process.env, WEBAGENTS_PORT: String(PORT), WEBAGENTS_HB_MS: String(HB), WEBAGENTS_HOME: HOME },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

// 一个"会应答心跳、但不回业务结果"的假扩展
function fakeExt() {
  const ws = new WebSocket(URL_, { headers: { Origin: ORIGIN } });
  const box = { hbs: [], token: null, closed: false, acksOn: true };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'ext', hb: 1 })));   // 没有令牌 → TOFU
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'hello-ok') { box.token = m.token || null; return; }
    if (m.type === 'hb') {
      box.hbs.push(m.t);
      if (box.acksOn) ws.send(JSON.stringify({ type: 'hb-ack', t: m.t }));
    }
  });
  ws.on('close', () => { box.closed = true; });
  return box;
}

try {
  await sleep(800);
  const ext = fakeExt();
  await sleep(1200);

  check('TOFU 配对发生（扩展拿到令牌）', !!ext.token, `token=${String(ext.token).slice(0, 8)}…`);
  check('配对成功后桥照样发心跳（半开检测已装上）', ext.hbs.length > 0, `收到 hb ${ext.hbs.length} 次`);
  check('接入日志写明心跳已启用', /扩展已接入（心跳已启用）/.test(stderr),
    stderr.split('\n').filter((l) => /扩展已接入/.test(l)).slice(-1)[0] || '无该行');

  // 持续应答心跳一段时间：不该被误判半开
  const n0 = ext.hbs.length;
  await sleep(HB * 6);
  check('持续应答期间连接未被回收', !ext.closed && ext.hbs.length > n0,
    `hb ${n0} → ${ext.hbs.length}，closed=${ext.closed}`);

  // 停止应答 → 必须判半开并回收
  ext.acksOn = false;
  await sleep(HB * 6 + 500);
  check('不应答后被判定半开并回收连接', ext.closed, `closed=${ext.closed}`);
  check('半开事件写进日志（事后取证看得见）', /扩展半开：/.test(stderr),
    stderr.split('\n').filter((l) => /半开/.test(l)).slice(-1)[0] || '无该行');
} catch (err) {
  console.log('  FAIL 测试异常：' + err.message);
  fail++;
} finally {
  child.kill();
  console.log(`\n结果：失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
}
