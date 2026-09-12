#!/usr/bin/env node
/**
 * 测试客户端：以 MCP 客户端身份拉起 server/index.mjs，
 * 依次调用 fleet_status → deepseek 问答，验证全链路。
 * 用法：node test-client.mjs [deepseek|qwen|status] ["问题"]
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
  } else if (action === 'deepseek' || action === 'qwen') {
    const r = await rpc('tools/call', { name: action, arguments: { prompt: question } });
    if (r.result.isError) throw new Error(r.result.content[0].text);
    console.log('--- 回复 ---');
    console.log(r.result.content[0].text);
  } else {
    throw new Error(`未知动作: ${action}`);
  }
} finally {
  child.kill();
}
