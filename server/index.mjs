#!/usr/bin/env node
/**
 * WEBAGENTS-server — MCP stdio server（可多实例共存）
 *
 * 不再自己绑定端口：连接（必要时自动拉起）单例 bridge.mjs，
 * 把 MCP 工具调用转发给 bridge → 扩展。多个 Trae 会话/测试客户端可同时使用。
 *
 * 环境变量：
 *   WEBAGENTS_PORT    bridge 端口，默认 8765
 *   WEBAGENTS_TOKEN   握手令牌，默认 webagents-local
 *   WEBAGENTS_TIMEOUT 单次问答超时 ms，默认 300000
 */
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEBAGENTS_PORT || 8765);
const TOKEN = process.env.WEBAGENTS_TOKEN || 'webagents-local';
const TIMEOUT_MS = Number(process.env.WEBAGENTS_TIMEOUT || 300000);
const WS_URL = `ws://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 与 bridge 的连接 ----
let ws = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, timer }

function tryConnect() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_URL);
    const timer = setTimeout(() => { sock.terminate(); reject(new Error('connect timeout')); }, 2000);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'hello', role: 'mcp', token: TOKEN })));
    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'hello-ok') {
        clearTimeout(timer);
        resolve(sock);
      } else if (msg.type === 'result' && pending.has(msg.id)) {
        const { resolve: res, timer: t } = pending.get(msg.id);
        clearTimeout(t);
        pending.delete(msg.id);
        res(msg);
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    // 结果消息的持续监听
    sock.on('message', () => {});
  });
}

function spawnBridge() {
  const child = spawn(process.execPath, [path.join(__dirname, 'bridge.mjs')], {
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

async function ensureBridge() {
  // 先试连一次；失败则拉起 bridge 再重试（最多 10s）
  try {
    ws = await tryConnect();
    console.error('[WEBAGENTS] 已连接 bridge');
    return;
  } catch { /* bridge 未运行 */ }

  spawnBridge();
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      ws = await tryConnect();
      console.error('[WEBAGENTS] bridge 已拉起并连接');
      return;
    } catch { /* 继续等 */ }
  }
  throw new Error('无法连接或启动 WEBAGENTS bridge');
}

function request(action, payload = {}, timeoutMs = TIMEOUT_MS) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!ws || ws.readyState !== 1) await ensureBridge();
      const id = `req-${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`扩展执行超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs + 60_000);
      pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ type: 'request', id, action, ...payload }));
    } catch (err) {
      reject(err);
    }
  });
}

// ---- MCP server ----
const mcp = new Server(
  { name: 'webagents', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const askTool = (site, label, optionDesc) => ({
  name: site,
  description: `把 prompt 注入${label}网页版并返回回复文本（通过 WebAgents Edge 扩展驱动真实登录会话，每次全新会话）`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要注入的任务 prompt' },
      system: { type: 'string', description: '可选：系统级指令，拼在 prompt 前面' },
      ...(optionDesc ? { options: { type: 'object', description: optionDesc } } : {}),
    },
    required: ['prompt'],
  },
});

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    askTool('deepseek', 'DeepSeek（chat.deepseek.com）', '对话选项开关：{ deepThink?: boolean（深度思考 R1）, search?: boolean（智能搜索） }'),
    askTool('qwen', '通义千问（www.qianwen.com）', '对话模式：{ mode?: "fast" | "think" | "research" }（快速回答/深度思考/深入研究，默认跟随站点上次选择）'),
    {
      name: 'probe',
      description: '在指定站点的页面里执行 DOM 探测，返回输入框/回答区的候选选择器信息，用于站点改版后修正适配器',
      inputSchema: {
        type: 'object',
        properties: { site: { type: 'string', enum: ['deepseek', 'qwen'] } },
        required: ['site'],
      },
    },
    {
      name: 'fleet_status',
      description: '查看 WEBAGENTS 扩展连接状态',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'fleet_status') {
      await ensureBridge();
      const r = await request('ping', {}, 10_000);
      return ok(r.ok ? '扩展已连接' : `扩展异常: ${r.error}`);
    }

    if (name === 'probe') {
      const r = await request('probe', { site: args.site }, 60_000);
      return r.ok ? ok(JSON.stringify(r.data, null, 2)) : fail(`探测失败: ${r.error}`);
    }

    if (name === 'deepseek' || name === 'qwen') {
      if (!args.prompt) return fail('prompt 必须是非空字符串');
      const r = await request('ask', {
        site: name,
        prompt: args.system ? `${args.system}\n\n---\n\n${args.prompt}` : args.prompt,
        options: args.options || null,
      });
      if (!r.ok) return fail(`执行失败: ${r.error}`);
      const head = r.options ? `[options生效状态: ${JSON.stringify(r.options)}]\n\n` : '';
      return ok(head + (r.timedOut ? `${r.text}\n\n[警告：等待超时，以上为部分内容]` : r.text));
    }

    return fail(`未知工具: ${name}`);
  } catch (err) {
    return fail(`webagents 执行失败: ${err.message}`);
  }
});

// ---- 启动 ----
await ensureBridge().catch((err) => console.error('[WEBAGENTS] 启动时 bridge 不可用（调用工具时会重试）:', err.message));
const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error('[WEBAGENTS] MCP stdio server 已启动');
