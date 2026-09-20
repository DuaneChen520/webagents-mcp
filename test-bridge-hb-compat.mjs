#!/usr/bin/env node
/**
 * bridge.mjs 心跳能力协商 集成测试（起真进程 + 真 WebSocket）
 *
 * 要锁住的是**部署顺序安全性**：桥先升级、扩展还没升级（0.4.2 不会应答 hb）是常态。
 * 若桥无条件开心跳，旧扩展会被每隔 ~45 秒误判为「半开」并强制重连 —— 那是我们自己造出来的假故障，
 * 比原来的真故障更难查。所以：没在 hello 里声明 hb 的连接，一律不做半开判定。
 *
 * 运行：node test-bridge-hb-compat.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, 'server', 'index.mjs'));
const { WebSocket } = require('ws');

const PORT = 8797;
const TOKEN = 'webagents-test';
const HB = 300;                       // 心跳间隔压到 300ms，等 3 轮绰绰有余
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, note) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? '  ' + note : ''}`); if (!ok) fail++; };

const child = spawn(process.execPath, [path.join(__dirname, 'server', 'bridge.mjs')], {
  env: {
    ...process.env, WEBAGENTS_PORT: String(PORT), WEBAGENTS_TOKEN: TOKEN, WEBAGENTS_HB_MS: String(HB),
    WEBAGENTS_HOME: path.join(os.tmpdir(), 'webagents-test-hbcompat'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

/** 旧版扩展：hello 里**不带** hb 字段 */
const legacyExt = () => new Promise((res, rej) => {
  const ws = new WebSocket(URL);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'ext', token: TOKEN })));
  const t = setTimeout(() => rej(new Error('hello 超时')), 4000);
  ws.on('message', (raw) => {
    try { const m = JSON.parse(raw.toString()); if (m.type === 'hello-ok') { clearTimeout(t); res(ws); } } catch {}
  });
  ws.on('error', rej);
});

try {
  await sleep(700);
  const ext = await legacyExt();
  const cli = await new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'mcp', token: TOKEN })));
    ws.on('message', () => res(ws));
    ws.on('error', rej);
    setTimeout(() => rej(new Error('hello 超时')), 4000);
  });

  const seen = [];
  ext.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  const result = new Promise((res) => cli.on('message', (raw) => {
    try { const m = JSON.parse(raw.toString()); if (m.type === 'result') res(m); } catch {}
  }));

  cli.send(JSON.stringify({ type: 'request', id: 'r1', action: 'ask', site: 'deepseek', prompt: 'x' }));
  await sleep(HB * 6);                 // 远超"两次无应答"的判半开窗口

  check('请求仍被正常转发（旧扩展没被半开逻辑打断）', seen.some((m) => m.type === 'request' && m.id === 'r1'), JSON.stringify(seen.map((m) => m.type)));
  check('没有触发半开判定（提示文案里出现该词不算）', !/扩展半开：/.test(stderr), stderr.split('\n').filter((l) => /半开|心跳|扩展已接入/.test(l)).slice(-2).join(' ⏎ ').slice(0, 150));
  check('连接未被强制回收（socket 仍 OPEN）', ext.readyState === 1, 'readyState=' + ext.readyState);

  ext.send(JSON.stringify({ type: 'result', id: 'r1', ok: true, mdLen: 5 }));
  const r = await Promise.race([result, sleep(3000).then(() => null)]);
  check('旧扩展的问答照常回传', !!r && r.ok === true, JSON.stringify(r || {}).slice(0, 120));
} catch (err) {
  console.log('  FAIL 测试异常：' + err.message);
  fail++;
} finally {
  child.kill();
  process.exit(fail ? 1 : 0);
}
