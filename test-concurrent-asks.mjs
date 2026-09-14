#!/usr/bin/env node
/**
 * 同站点并发派发 验证（P0-1 的决定性验证）
 *
 * 为什么需要：每个站点只有一个常驻标签页，并发进入会互相覆盖输入框、
 * 抢同一块屏幕做完成判定 —— 表现为"A 的答案里混进 B 的问题"或结果互换。
 * 单元测试无法覆盖这一点，必须打真实站点。
 *
 * 做法：同时下发两个带唯一代号的提问，各自只应拿回自己的代号。
 *
 * 前置：扩展已加载并登录，且已重载到含站点队列的版本。
 * 运行：node test-concurrent-asks.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = process.argv[2] || 'deepseek';
const MARK_A = 'ALPHA-7';
const MARK_B = 'BRAVO-9';

const child = spawn('node', [path.join(__dirname, 'server', 'index.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
let seq = 0;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
function rpc(method, params, timeoutMs = 360000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('RPC 超时')); } }, timeoutMs);
  });
}

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

const t0 = Date.now();
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const mk = (mark) => rpc('tools/call', {
    name: SITE,
    arguments: { prompt: `请只回复这个代号，不要输出任何其他内容：${mark}` },
  });

  console.log(`\n同时下发两个提问（各带唯一代号 ${MARK_A} / ${MARK_B}）…\n`);
  const started = Date.now();
  const [ra, rb] = await Promise.all([mk(MARK_A), mk(MARK_B)]);
  const elapsed = Date.now() - started;

  const textOf = (r) => {
    if (!r || !r.result) return '';
    if (r.result.isError) return `[错误] ${r.result.content[0].text}`;
    return r.result.content[0].text || '';
  };
  const ta = textOf(ra);
  const tb = textOf(rb);

  console.log('--- 第一个请求 ---');
  console.log(ta.slice(0, 300));
  console.log('--- 第二个请求 ---');
  console.log(tb.slice(0, 300));
  console.log('');

  check('两个请求都成功返回', !ta.startsWith('[错误]') && !tb.startsWith('[错误]'),
    `${ta.slice(0, 60)} | ${tb.slice(0, 60)}`);
  check(`第一个请求拿到了自己的代号 ${MARK_A}`, ta.includes(MARK_A));
  check(`第二个请求拿到了自己的代号 ${MARK_B}`, tb.includes(MARK_B));
  check('第一个请求没有串到对方的代号', !ta.includes(MARK_B));
  check('第二个请求没有串到对方的代号', !tb.includes(MARK_A));

  console.log(`\n总耗时 ${(elapsed / 1000).toFixed(1)}s（串行 + 节流会比较长，这是预期行为）`);
} catch (err) {
  console.log(`  FAIL 执行异常：${err.message}`);
  fail++;
} finally {
  child.kill();
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
}
