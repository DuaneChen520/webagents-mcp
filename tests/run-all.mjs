#!/usr/bin/env node
/**
 * 一次性跑完全部离线测试。
 *
 * "离线"的含义：每套测试自己起临时端口、临时 WEBAGENTS_HOME，
 * 不碰你正在用的桥、也不碰 Edge —— 所以随时可以跑，不必先停手头的任务。
 *
 *   node tests/run-all.mjs          跑离线套件
 *   node tests/run-all.mjs --live   额外跑同站点并发验证（会真发两次提问，需要扩展在线并已登录）
 *
 * 任一套件退出码非 0 → 本脚本退出 1（npm test 因此可以直接当 CI 用）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = process.argv.includes('--live');

// 顺序有讲究：纯函数/解析类的先跑（失败最可能是真 bug），起子进程的桥测试在后
const SUITES = [
  'test-stream-parse.mjs',
  'test-stream-probe.mjs',
  'test-dom-md.mjs',
  'test-scheduling.mjs',
  'test-offscreen.mjs',
  'test-cli.mjs',
  'test-bridge-auth.mjs',
  'test-bridge-failfast.mjs',
  'test-bridge-halfopen.mjs',
  'test-bridge-hb-compat.mjs',
  'test-bridge-tofu-hb.mjs',
  'test-bridge-routeid.mjs',
  'test-concurrent-asks.mjs',      // 需要真实站点，只在 --live 下跑
];

function run(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve({ code: code == null ? 'signal' : code, ms: Date.now() - t0, out }));
  });
}

const todo = LIVE ? SUITES : SUITES.slice(0, -1);
let bad = 0;
let assertions = 0;

for (const file of todo) {
  const r = await run(file);
  // 各套件的通过标记不统一（ok / ✓），计数只为给报表一个体量感
  const n = (r.out.match(/^\s{2}(ok|✓)\s/gm) || []).length;
  assertions += n;
  const mark = r.code === 0 ? '✓' : '✗';
  console.log(`${mark} ${file.replace(/\.mjs$/, '').padEnd(26)}${n ? `${String(n).padStart(3)} 项  ` : '      '}${(r.ms / 1000).toFixed(1)}s${r.code ? `  退出码 ${r.code}` : ''}`);
  if (r.code !== 0) {
    bad++;
    const lines = r.out.split('\n').filter((l) => /FAIL|Error|error:/.test(l)).slice(0, 8);
    console.log(lines.map((l) => `      ${l.trim()}`).join('\n') || `      ${r.out.slice(-400)}`);
  }
}

console.log(`\n套件 ${todo.length - bad}/${todo.length} 通过，断言 ${assertions} 项`);
if (!LIVE) console.log('未跑：test-concurrent-asks（真发提问）→ node tests/run-all.mjs --live');
process.exit(bad ? 1 : 0);
