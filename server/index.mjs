#!/usr/bin/env node
/**
 * WEBAGENTS-server — MCP stdio server（可多实例共存）
 *
 * 不再自己绑定端口：连接（必要时自动拉起）单例 bridge.mjs，
 * 把 MCP 工具调用转发给 bridge → 扩展。多个 Trae 会话/测试客户端可同时使用。
 *
 * 环境变量：
 *   WEBAGENTS_PORT    bridge 端口，默认 8765
 *   WEBAGENTS_TOKEN   握手令牌（优先级最高；不设则用用户目录下的 bridge.json）
 *   WEBAGENTS_TIMEOUT 单次问答超时 ms，默认 300000
 *   WEBAGENTS_HOME    本地状态目录（令牌 + 运行记录），默认 %LOCALAPPDATA%\webagents
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
import { resolveToken, appendRun, readRuns, rotateRuns, runsFile } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEBAGENTS_PORT || 8765);
const TIMEOUT_MS = Number(process.env.WEBAGENTS_TIMEOUT || 300000);
const WS_URL = `ws://127.0.0.1:${PORT}`;
const VERSION = '0.4.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 令牌每次连接时重新解析：服务端可能先于桥启动，那时令牌文件还不存在。
const currentToken = () => resolveToken({ create: false }).token || '';

// ---- 与 bridge 的连接 ----
let ws = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, timer }

function tryConnect() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const sock = new WebSocket(WS_URL);
    const timer = setTimeout(() => { sock.terminate(); done(reject, new Error('connect timeout')); }, 2000);
    sock.on('open', () => {
      sock.send(JSON.stringify({ type: 'hello', role: 'mcp', token: currentToken() }));
    });
    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'hello-ok') {
        clearTimeout(timer);
        done(resolve, sock);
      } else if (msg.type === 'hello-fail') {
        // 令牌不匹配：明确抛出，避免"连上了但永远收不到结果"这种最难查的状态
        clearTimeout(timer);
        try { sock.terminate(); } catch {}
        done(reject, new Error(`握手被拒绝：${msg.error}（令牌来源 ${resolveToken().source}）`));
      } else if (msg.type === 'result' && pending.has(msg.id)) {
        const { resolve: res, timer: t } = pending.get(msg.id);
        clearTimeout(t);
        pending.delete(msg.id);
        res(msg);
      }
    });
    sock.on('close', () => { clearTimeout(timer); done(reject, new Error('bridge 主动断开')); });
    sock.on('error', (err) => { clearTimeout(timer); done(reject, err); });
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
  } catch { /* bridge 未运行或令牌未就绪 */ }

  spawnBridge();
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      ws = await tryConnect();
      console.error('[WEBAGENTS] bridge 已拉起并连接');
      return;
    } catch (err) { lastErr = err; }
  }
  throw new Error(`无法连接或启动 WEBAGENTS bridge${lastErr ? `（${lastErr.message}）` : ''}`);
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
  { name: 'webagents', version: VERSION },
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
      description: '在指定站点的页面里执行 DOM 探测，返回输入框/回答区的候选选择器信息，用于站点改版后修正适配器。注意：会先把标签页导回站点首页（整页重载）',
      inputSchema: {
        type: 'object',
        properties: { site: { type: 'string', enum: ['deepseek', 'qwen'] } },
        required: ['site'],
      },
    },
    {
      name: 'inspect',
      description: '只读查看站点标签页的当前状态，**不会导航/重载页面**。用于查看风控验证（滑块）现场、当前回复区状态与流探针记录 —— probe 会重载页面从而摧毁这些现场',
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
    {
      name: 'recent_runs',
      description: '读取近期的调用运行记录（耗时、排队/节流等待、正文来源与长度、失败阶段、桥事件）。排障时先用它，不必重跑问答。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数，默认 15，上限 200' },
          site: { type: 'string', description: '只看某个站点（deepseek / qwen）' },
          onlyErrors: { type: 'boolean', description: '只看失败的记录' },
        },
      },
    },
  ],
}));

// ---- 运行记录辅助 ----
const short = (s, n = 200) => (typeof s === 'string' ? s.slice(0, n) : s);

function runOutcome(entry, r) {
  Object.assign(entry, {
    ok: !!r.ok,
    queuedMs: r.queuedMs,
    throttleWaitMs: r.throttleWaitMs,
    textSource: r.textSource,
    // mdVia = 正文是怎么取回来的（cache=内容脚本本地缓存 / probe=跨世界查询）。
    // 排查"读到陈旧回复"这类问题时，这两个字段是分水岭：
    // 命中 cache 说明拿到的是**上一次**流留下的文本。
    mdVia: r.mdVia,
    mdLen: r.mdLen,
    domLen: r.domLen,
    streamStatus: r.streamStatus,
    streamId: r.streamId,
    // 风控与降温：排障时能看出"这次是不是被验证拦了、间隔为什么变长"
    challenge: r.challenge ? short(JSON.stringify(r.challenge), 200) : undefined,
    adaptiveSec: r.adaptiveSec,
    stage: r.stage,
    timedOut: r.timedOut || undefined,
    truncated: r.truncated || undefined,
    error: r.ok ? undefined : short(r.error, 300),
    diag: r.diag ? short(JSON.stringify(r.diag), 400) : undefined,
    textLen: typeof r.text === 'string' ? r.text.length : undefined,
    surfaced: r.surfaced || undefined,
  });
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  const t0 = Date.now();
  const entry = {
    kind: 'tool',
    tool: name,
    site: args.site || (name === 'deepseek' || name === 'qwen' ? name : undefined),
    promptHead: args.prompt ? short(args.prompt, 60) : undefined,
  };

  try {
    if (name === 'fleet_status') {
      await ensureBridge();
      const r = await request('ping', {}, 10_000);
      entry.ok = !!r.ok;
      if (!r.ok) { entry.error = short(r.error); return ok(`扩展异常: ${r.error}`); }
      // 把站点队列深度一并报出：多任务同时下发时，能一眼看出"为什么在等"
      const q = (r.data && r.data.queues) || {};
      const entries = Object.entries(q);
      const qs = entries.length ? ` ｜ 排队中: ${entries.map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
      const tr = (r.data && r.data.transport) || '未知';
      const err = r.data && r.data.bridgeError ? ` ｜ 桥状态: ${r.data.bridgeError}` : '';
      return ok(`扩展已连接（连接承载=${tr}）${qs}${err}`);
    }

    if (name === 'recent_runs') {
      const entries = readRuns({
        limit: args.limit, site: args.site, onlyErrors: args.onlyErrors,
      });
      entry.ok = true;
      if (!entries.length) return ok(`暂无运行记录（${runsFile()}）`);
      const fmt = (e) => {
        const when = new Date(e.ts).toLocaleString('zh-CN', { hour12: false });
        if (e.kind === 'bridge') return `${when}  [桥] ${e.event}`;
        const bits = [`${e.ok ? '成功' : '失败'}`];
        if (e.ms !== undefined) bits.push(`${(e.ms / 1000).toFixed(1)}s`);
        if (e.queuedMs >= 500) bits.push(`排队${(e.queuedMs / 1000).toFixed(1)}s`);
        if (e.throttleWaitMs >= 500) bits.push(`节流${(e.throttleWaitMs / 1000).toFixed(1)}s`);
        if (e.textSource) bits.push(`正文=${e.textSource}`);
        if (e.mdLen !== undefined || e.domLen !== undefined) bits.push(`md=${e.mdLen ?? '-'}/dom=${e.domLen ?? '-'}`);
        if (e.streamStatus) bits.push(`status=${e.streamStatus}`);
        if (e.stage) bits.push(`阶段=${e.stage}`);
        if (e.error) bits.push(`错误=${short(e.error, 120)}`);
        const head = e.promptHead ? ` "${e.promptHead}"` : '';
        return `${when}  ${e.tool || '?'}${e.site ? `/${e.site}` : ''}${head}  ${bits.join(' | ')}`;
      };
      return ok(`运行记录（共 ${entries.length} 条，文件 ${runsFile()}）\n\n` + entries.map(fmt).join('\n'));
    }

    if (name === 'probe') {
      const r = await request('probe', { site: args.site }, 60_000);
      Object.assign(entry, { ok: !!r.ok, error: r.ok ? undefined : short(r.error) });
      return r.ok ? ok(JSON.stringify(r.data, null, 2)) : fail(`探测失败: ${r.error}`);
    }

    if (name === 'inspect') {
      const r = await request('inspect', { site: args.site }, 60_000);
      Object.assign(entry, { ok: !!r.ok, error: r.ok ? undefined : short(r.error) });
      return r.ok ? ok(JSON.stringify(r.data, null, 2)) : fail(`查看失败: ${r.error}`);
    }

    if (name === 'deepseek' || name === 'qwen') {
      if (!args.prompt) return fail('prompt 必须是非空字符串');
      // 千问的生成依赖页面可见性，无人值守时按"每分钟苏醒一次"爬行推进（实测约 5 分钟），
      // SW 侧预算 420s（SITES.qwen.askTimeoutMs），服务端等待预算要比它更长。
      const askTimeout = name === 'qwen' ? 420000 : undefined;
      const r = await request('ask', {
        site: name,
        prompt: args.system ? `${args.system}\n\n---\n\n${args.prompt}` : args.prompt,
        options: args.options || null,
        timeoutMs: askTimeout,
      }, askTimeout ? askTimeout + 60000 : undefined);
      runOutcome(entry, r);
      if (!r.ok) {
        // 失败时把当次诊断一并带出：失败原因多半就藏在这里（抓到的流 URL/字段名/DOM 快照）
        const lenInfo = (r.mdLen !== undefined || r.domLen !== undefined)
          ? `\n[长度快照] mdLen=${r.mdLen} domLen=${r.domLen}` : '';
        const extra = r.diag ? `\n[当次诊断] ${JSON.stringify(r.diag)}` : '';
        return fail(`执行失败: ${r.error}${lenInfo}${extra}`);
      }
      // 完成信号与截断信息必须显式透出（v8）：
      // 旧实现靠"文本不再变化"猜结束，被截断时会静默当成功，上层无从察觉。
      const notes = [];
      // 排队/节流等待只在真正发生时提示，且只在超过 0.5s 时才提示 —— 不打扰正常使用
      if (r.queuedMs >= 500) notes.push(`已在本站点排队等待 ${(r.queuedMs / 1000).toFixed(1)}s`);
      if (r.throttleWaitMs >= 500) notes.push(`已按调用节流间隔等待 ${(r.throttleWaitMs / 1000).toFixed(1)}s`);
      if (r.adaptiveSec) notes.push(`自适应降温 +${r.adaptiveSec}s（该站点近期命中过风控验证）`);
      if (r.challenge && r.challenge.detected) {
        notes.push(`⚠ 站点要求人工验证：${r.challenge.hint}${r.challenge.sel ? `（元素 ${r.challenge.sel}）` : ''}`
          + `${r.challenge.surfaced ? '，标签页已切到前台' : ''}`);
      }
      if (r.options) notes.push(`options生效状态: ${JSON.stringify(r.options)}`);
      if (r.warning) notes.push(`警告：${r.warning}（streamStatus=${r.streamStatus}）`);
      else if (r.streamStatus && r.streamStatus !== 'FINISHED') notes.push(`streamStatus=${r.streamStatus}`);
      if (r.viaStream) notes.push(`完成信号=响应流关闭，正文来源=${r.textSource}`);
      // 长度快照：正文异常时一眼看出是"取回失败"（mdLen=0）还是"DOM 更长"（domLen 大）
      if (r.mdLen !== undefined || r.domLen !== undefined) notes.push(`长度 md=${r.mdLen} dom=${r.domLen}`);
      // 正文退回 DOM 时附带诊断，便于定位站点字段名差异（不影响正文本身）
      if (r.diag) notes.push(`正文还原诊断=${JSON.stringify(r.diag)}`);
      const head = notes.length ? `[${notes.join(' | ')}]\n\n` : '';
      return ok(head + (r.timedOut ? `${r.text}\n\n[警告：等待超时，以上为部分内容]` : r.text));
    }

    return fail(`未知工具: ${name}`);
  } catch (err) {
    entry.ok = false;
    entry.error = short(err.message, 300);
    return fail(`webagents 执行失败: ${err.message}`);
  } finally {
    entry.ms = Date.now() - t0;
    appendRun(entry);
  }
});

// ---- 启动 ----
rotateRuns();
await ensureBridge().catch((err) => console.error('[WEBAGENTS] 启动时 bridge 不可用（调用工具时会重试）:', err.message));
const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error(`[WEBAGENTS] MCP stdio server 已启动（v${VERSION}）`);
