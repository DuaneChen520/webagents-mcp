#!/usr/bin/env node
/**
 * 测试客户端：以 MCP 客户端身份拉起 server/index.mjs，
 * 依次调用 fleet_status → 站点问答 / DOM 探测，验证全链路。
 *
 * 用法：
 *   node test-client.mjs status
 *   node test-client.mjs deepseek ["问题"]
 *   node test-client.mjs qwen ["问题"]
 *   node test-client.mjs probe [deepseek|qwen]     # 输出探测 JSON（含流探针诊断；会重载页面）
 *   node test-client.mjs inspect [deepseek|qwen]   # 只读查看当前页面（不导航），用于抓验证现场
 *   node test-client.mjs runs [条数] [--errors] [站点]  # 读运行记录（排障首选，不必重跑）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const action = process.argv[2] || 'status';
const question = process.argv[3] || '请只回复两个字：成功';

const child = spawn('node', [path.join(__dirname, 'server', 'index.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
let seq = 0;

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('RPC 超时')); } }, 360000);
  });
}

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  if (action === 'status') {
    const r = await rpc('tools/call', { name: 'fleet_status', arguments: {} });
    console.log('fleet_status:', r.result.content[0].text);
  } else if (action === 'probe') {
    // 第三个参数用作站点名
    const site = process.argv[3] || 'deepseek';
    const r = await rpc('tools/call', { name: 'probe', arguments: { site } });
    if (r.result.isError) throw new Error(r.result.content[0].text);
    console.log(r.result.content[0].text);
  } else if (action === 'deepseek' || action === 'qwen') {
    const r = await rpc('tools/call', { name: action, arguments: { prompt: question } });
    if (r.result.isError) throw new Error(r.result.content[0].text);
    console.log('--- 回复 ---');
    console.log(r.result.content[0].text);
  } else if (action === 'inspect') {
    // 只读查看，不导航不重载 —— 用于抓风控验证现场与流诊断（probe 会重载页面）
    const site = process.argv[3] || 'deepseek';
    const r = await rpc('tools/call', { name: 'inspect', arguments: { site } });
    if (r.result.isError) throw new Error(r.result.content[0].text);
    console.log(r.result.content[0].text);
  } else if (action === 'runs') {
    // 排障首选：不必重跑问答，直接从历史记录里看趋势与差异
    const limit = Number(process.argv[3]) || 15;
    const onlyErrors = process.argv.includes('--errors');
    const site = process.argv[4] && !String(process.argv[4]).startsWith('--') ? process.argv[4] : undefined;
    const r = await rpc('tools/call', { name: 'recent_runs', arguments: { limit, onlyErrors, site } });
    console.log(r.result.content[0].text);
  } else {
    throw new Error(`未知动作: ${action}`);
  }
  process.exit(0);   // MCP 子进程不一定自行退出，显式结束避免挂住调用方
} finally {
  child.kill();
}
