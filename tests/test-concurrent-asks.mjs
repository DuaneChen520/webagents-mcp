#!/usr/bin/env node
/**
 * 同站点并发派发 验证（P0-1 的决定性验证）
 *
 * 为什么需要：每个站点只有一个常驻标签页，并发进入会互相覆盖输入框、
 * 抢同一块屏幕做完成判定 —— 表现为"A 的答案里混进 B 的问题"或结果互换。
 * 单元测试无法覆盖这一点，必须打真实站点。
 *
 * 做法：同时起两个 CLI 进程，各发一个带唯一代号的提问，各自只应拿回自己的代号。
 * （0.7.0 起改由 cli.mjs 驱动 —— 原先是拉起 MCP stdio server 手搓 JSON-RPC，
 *  那层入口已随 MCP 一起移除，这里的语义不变：两个真实进程 + 同一站点 + 并发。）
 *
 * 前置：扩展已加载并登录，且已重载到含站点队列的版本。
 * 运行：node test-concurrent-asks.mjs [deepseek|qwen]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 测试住在 tests/ 下：ROOT = 仓库根（被测代码在 server/ 与 extension/）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'server', 'cli.mjs');
const SITE = process.argv[2] || 'deepseek';
const MARK_A = 'ALPHA-7';
const MARK_B = 'BRAVO-9';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

/** 跑一次真实 ask，返回 CLI 的解析结果（--json 时 stdout 是一段 pretty JSON，失败是一行 FAIL） */
function ask(mark) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      CLI, 'ask', SITE, `请只回复这个代号，不要输出任何其他内容：${mark}`, '--json',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      try { resolve({ code, r: JSON.parse(out) }); }
      catch { resolve({ code, r: { ok: false, error: `退出码 ${code}，stdout 非 JSON：${out.slice(0, 120)}` }, stderr: err }); }
    });
  });
}

console.log(`\n同时下发两个提问（各带唯一代号 ${MARK_A} / ${MARK_B}）…\n`);
const started = Date.now();
const [ra, rb] = await Promise.all([ask(MARK_A), ask(MARK_B)]);
const elapsed = Date.now() - started;

const textOf = ({ code, r, stderr }) => (r.ok
  ? String(r.text || '')
  : `[错误] ${r.error || r.detail || ''}${stderr ? ' ' + stderr.split('\n')[0] : ''}`);
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
console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
