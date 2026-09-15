#!/usr/bin/env node
/**
 * WEBAGENTS-cli — 命令行原语（v0.5.0 新增，skill 封装层的底座）
 *
 * 与 MCP server（index.mjs）共用同一个单例 bridge 与 runs.jsonl，是并列的两个入口：
 *   - MCP：IDE 会话内的结构化工具调用
 *   - CLI：skill/剧本/脚本/人，用后台进程、落盘文件、grep 组合出批量与并行派发
 *
 * 设计原则（PLAN-cli-skill.md 定稿）：
 *   1. stdout 极简：成功默认一行摘要，正文写文件（--out），--json 才给全量 ——
 *      长答案默认不进调用方上下文，需要时按需读文件。
 *   2. 失败契约：失败时 stdout 一行 `FAIL stage=<七段之一> reason=… hint=… runId=…`，
 *      调用方 O(1) 查表定位，不需要事后翻日志。
 *   3. --attach：文件内容由 CLI 从磁盘直读拼进 prompt，**不过调用方上下文**；
 *      单文件上限 60KB（超限明确报错，不静默截断）。
 *   4. --prompt-file / stdin：prompt 本身可能超 Windows argv 32767 字符上限。
 *   5. 桥宿主：先连现有桥；连不上以分离方式拉起（unref），桥随本命令结束后继续存活。
 *
 * 运行：node server/cli.mjs <ask|runs|inspect|status|help> ...
 */
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { appDir, ensureDir, resolveToken, loadBridgeState, appendRun, readRuns, runsFile } from './store.mjs';
import { execSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEBAGENTS_PORT || 8765);
const TIMEOUT_MS = Number(process.env.WEBAGENTS_TIMEOUT || 300000);
const VERSION = '0.6.0';
const WS_URL = `ws://127.0.0.1:${PORT}`;
const ATTACH_MAX_BYTES = 60 * 1024;
const SITES = ['deepseek', 'qwen'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 200) => (typeof s === 'string' ? s.slice(0, n) : s);
const currentToken = () => resolveToken({ create: false }).token || '';

// ===================== 桥客户端（与 index.mjs 同协议；保持独立副本，
// 使 MCP 路径不因 CLI 的演进而被波及） =====================

let ws = null;
let seq = 0;
const pending = new Map();

function tryConnect() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const sock = new WebSocket(WS_URL);
    const timer = setTimeout(() => { sock.terminate(); done(reject, new Error('connect timeout')); }, 2000);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'hello', role: 'mcp', token: currentToken() })));
    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'hello-ok') { clearTimeout(timer); done(resolve, sock); }
      else if (msg.type === 'hello-fail') {
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
  // detached + unref：在不受宿主进程树清理限制的环境（用户自己的终端等）里，桥可在 CLI 退出后继续存活。
  // 本机（WorkBuddy 命令宿主）实测 job object 会连带回收 detached 子进程（2026-09-15 对照实验）——
  // 此时退化为"每条命令自拉桥、用完即逝"模式，扩展重连延迟由 ensureExtensionReady 兜住。
  const child = spawn(process.execPath, [path.join(__dirname, 'bridge.mjs')], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function ensureBridge() {
  try { ws = await tryConnect(); return; } catch { /* 未运行或令牌未就绪 */ }
  spawnBridge();
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try { ws = await tryConnect(); return; } catch (err) { lastErr = err; }
  }
  throw new Error(`无法连接或启动 WEBAGENTS bridge${lastErr ? `（${lastErr.message}）` : ''}`);
}

function request(action, payload = {}, timeoutMs = TIMEOUT_MS) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!ws || ws.readyState !== 1) await ensureBridge();
      const id = `cli-${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`扩展执行超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs + 60_000);
      pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ type: 'request', id, action, ...payload }));
    } catch (err) { reject(err); }
  });
}

/**
 * 等扩展就绪：桥连上 ≠ 扩展已接入（offscreen 的 WS 重连有退避延迟）。
 * 无桥环境下每条 CLI 命令都会经历"自拉桥 → 等扩展重连"，不等待就会一拍报
 * "扩展未连接"（2026-09-15 实测：桥 listening 后 1s 内扩展还没回来）。
 * 只对"扩展未连接"这一种可等待错误重试；其它错误原样返回。
 */
async function ensureExtensionReady({ budgetMs = Number(process.env.WEBAGENTS_EXT_WAIT_MS || 30000) } = {}) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    try {
      last = await request('ping', {}, 10_000);
      if (last.ok || !/扩展未连接/.test(last.error || '')) return last;
    } catch (err) {
      last = { ok: false, error: err.message };
      if (!/扩展未连接|bridge|令牌/i.test(err.message)) return last;
    }
    if (Date.now() >= deadline) return last;
    await sleep(1000);
  }
}

// ===================== 失败定位：七段 stage（PLAN 决议 D8） =====================
// connect → queue → send(ack) → challenge → generate → retrieve → quality
// （另加 input = 参数/输入校验错误，尚未进入执行管线）

const HINTS = {
  input: '检查参数：prompt 非空；--attach 单文件 ≤60KB；站点为 deepseek|qwen',
  connect: '先跑 `status`；不行则重启 IDE 的 MCP 会话（桥由它拉起）或确认 Edge 扩展已启用。如需桥跨命令常驻，可在你自己的终端里运行 node server/bridge.mjs',
  queue: '同站点前序任务未结束（排队上限 4 分钟）；稍候重试',
  send: '发送未生效或页面被人为操作过；用 `inspect <site>` 看现场（不要用 probe，会整页重载毁掉现场）',
  challenge: '站点弹出人工验证；标签页已自动切前台，人手完成后会自动续跑',
  generate: '生成迟迟未开始/未结束；检查是否开启搜索/深度思考（首字会明显变晚）',
  retrieve: '流里有正文但取回为空；通常重试即可；复现则 `runs --why last` 看当次诊断',
  quality: '站点报告了非正常终态；按 streamStatus 语义处理（INCOMPLETE=截断可续问 / CONTENT_FILTER=被过滤 / CONTEXT_LENGTH_EXCEEDED=上下文爆了 / TIMEOUT）',
  'session_gone': '无可续接的会话（标签页没开/在首页/无历史回复）；去掉 --continue 发首问，或把会话页重新打开',
};

export function stageOf(r = {}) {
  if (r.stage) return r.stage;
  const err = r.error || '';
  if (/扩展未连接|bridge|握手|令牌/i.test(err)) return 'connect';
  if (/排队/.test(err)) return 'queue';
  if (r.mdLen === 0 && r.streamId) return 'retrieve';
  if (r.streamStatus && r.streamStatus !== 'FINISHED' && r.streamStatus !== 'WIP') return 'quality';
  return 'generate';
}

export function failLine({ stage, reason, hint, runId }) {
  return `FAIL stage=${stage} reason=${short(reason, 200)} hint=${hint || HINTS[stage] || ''}${runId ? ` runId=${runId}` : ''}`;
}

// ===================== 纯函数（可离线单测） =====================

const BOOL_FLAGS = new Set(['--json', '--errors', '--dedupe', '--help', '--force']);

export function parseArgs(argv = []) {
  const flags = { attach: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (BOOL_FLAGS.has(a)) { flags[a] = true; continue; }
      if (a === '--why') {
        // 双态旗标：`ask ... --why`（无值 = 失败时打全诊断）；`runs --why last`（有值 = 查指定记录）
        const nxt = argv[i + 1];
        if (nxt === undefined || nxt.startsWith('--')) { flags['--why'] = true; continue; }
        flags['--why'] = nxt;
        i++;
        continue;
      }
      const val = argv[++i];
      if (val === undefined) throw usageErr(`缺少 ${a} 的值`);
      if (a === '--attach') flags.attach.push(val);
      else flags[a] = val;
    } else pos.push(a);
  }
  const cmd = pos.shift();
  if (!cmd) throw usageErr('缺少子命令（ask / runs / inspect / status / help）');
  return { cmd, pos, flags };
}

function usageErr(msg) { const e = new Error(msg); e.code = 'usage'; return e; }

/**
 * 组装最终 prompt：prompt-file（或 stdin）+ 附件。
 * 附件由 CLI 直读磁盘拼进 prompt —— 调用方上下文里永远不需要出现文件内容。
 */
export function buildPrompt({ prompt = '', attach = [], promptFile } = {}) {
  let base = prompt;
  if (promptFile) {
    const raw = promptFile === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(promptFile, 'utf8');
    base = raw;
  }
  if (!base || !base.trim()) throw usageErr('prompt 为空（传位置参数，或用 --prompt-file <file>，或 stdin 传 "-"）');
  let text = base;
  attach.forEach((file, i) => {
    let st;
    try { st = fs.statSync(file); } catch { throw usageErr(`附件不存在: ${file}`); }
    if (st.size > ATTACH_MAX_BYTES) {
      throw usageErr(`附件超过 ${Math.round(ATTACH_MAX_BYTES / 1024)}KB 上限: ${file}（${st.size} 字节）—— 请先拆分或摘要`);
    }
    const content = fs.readFileSync(file, 'utf8');
    text += `\n\n===== 附件 ${i + 1}: ${path.basename(file)} =====\n${content}`;
  });
  return text;
}

export function promptHash(p) {
  return crypto.createHash('sha256').update(String(p), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 从回复文本里提取 JSON（协议输出容忍围栏与前置废话）。
 * 先试 ```json 围栏，再试首个 { 到最后一个 }。都解析不了返回 undefined。
 */
export function extractJson(text) {
  if (!text) return undefined;
  const candidates = [];
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const s = String(text).indexOf('{');
  const e = String(text).lastIndexOf('}');
  if (s !== -1 && e > s) candidates.push(String(text).slice(s, e + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* 试下一个候选 */ }
  }
  return undefined;
}

/** 手写轻校验（零依赖）：required 必填 + properties 类型（string|number|boolean|array|object） */
export function validateSchema(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['顶层必须是 JSON 对象'];
  const errs = [];
  for (const k of schema.required || []) {
    if (!(k in obj)) errs.push(`缺少必填字段: ${k}`);
  }
  for (const [k, t] of Object.entries(schema.properties || {})) {
    if (!(k in obj)) continue;
    const v = obj[k];
    const actual = Array.isArray(v) ? 'array' : typeof v;
    const want = Array.isArray(t) ? t : [t];
    if (!want.includes(actual)) errs.push(`字段 ${k} 类型应为 ${want.join('|')}，实际 ${actual}`);
  }
  return errs;
}

export function summarize(r, { ms, outFile }) {
  const bits = [`done ${(ms / 1000).toFixed(1)}s`];
  if (r.textSource) bits.push(`正文=${r.textSource}`);
  if (r.mdLen !== undefined || r.domLen !== undefined) bits.push(`md=${r.mdLen ?? '-'}/${r.domLen ?? '-'}`);
  if (r.streamStatus) bits.push(`status=${r.streamStatus}`);
  if (r.queuedMs >= 500) bits.push(`排队${(r.queuedMs / 1000).toFixed(1)}s`);
  if (r.throttleWaitMs >= 500) bits.push(`节流${(r.throttleWaitMs / 1000).toFixed(1)}s`);
  bits.push(`-> ${outFile}`);
  return bits.join(' ');
}

export function formatRuns(entries) {
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
    if (e.runId) bits.push(`runId=${e.runId}`);
    if (e.error) bits.push(`错误=${short(e.error, 120)}`);
    const head = e.promptHead ? ` "${e.promptHead}"` : '';
    return `${when}  ${e.tool || '?'}${e.site ? `/${e.site}` : ''}${head}  ${bits.join(' | ')}`;
  };
  return entries.map(fmt).join('\n');
}

/** runs --dedupe：按 promptHash 分组，只报出现 >1 次的（调用方自己决定跳不跳过） */
export function dedupeEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!e.promptHash || e.kind !== 'tool') continue;
    if (!groups.has(e.promptHash)) groups.set(e.promptHash, []);
    groups.get(e.promptHash).push(e);
  }
  const out = [];
  for (const [hash, list] of groups) {
    if (list.length < 2) continue;
    const last = list[list.length - 1];
    out.push({ hash, count: list.length, site: last.site, lastTs: last.ts, promptHead: last.promptHead, lastRunId: last.runId });
  }
  return out.sort((a, b) => b.lastTs - a.lastTs);
}

const USAGE = `WEBAGENTS CLI v${VERSION}

  node server/cli.mjs ask <deepseek|qwen> "prompt" [--out <file>] [--attach <file>]...
                    [--prompt-file <file>|-] [--json] [--why]
                    [--continue <runId>|last|here] [--protocol <file>] [--schema <file>]
  node server/cli.mjs runs [--limit n] [--site <s>] [--errors] [--dedupe] [--why <runId>|last]
  node server/cli.mjs inspect <deepseek|qwen>
  node server/cli.mjs status
  node server/cli.mjs doctor
  node server/cli.mjs bridge start ｜ bridge stop [--force]

退出码：0 成功 ｜ 1 执行失败（stdout 有 FAIL 行）｜ 2 用法错误`;

// ===================== 各子命令 =====================

/** --continue 三种寻址（A1）：runId 精确 / last=该站最近成功问答 / here=该站当前标签页。
 *  CLI 只做记录查找；"会话还在不在"的权威校验在扩展侧（ensureContinueTab）。 */
function resolveContinue(flags, site) {
  const c = flags['--continue'];
  if (c === undefined) return false;
  if (c === 'here') return true;
  const entries = readRuns({ limit: 200 });
  let hit;
  if (c === 'last') {
    hit = [...entries].reverse().find((e) => e.kind === 'tool' && e.ok === true && e.site === site
      && (e.tool === 'cli.ask' || e.tool === site));
  } else {
    hit = entries.find((e) => e.runId === c);
    if (hit && hit.site !== site) throw usageErr(`--continue ${c} 属于站点 ${hit.site}，与 ask 的站点 ${site} 不一致`);
  }
  if (!hit) throw usageErr(`--continue ${c}：找不到该站可续接的会话记录（最近没有成功问答）`);
  return true;
}

async function cmdAsk({ pos, flags }) {
  const site = pos[0];
  if (!SITES.includes(site)) throw usageErr(`ask 的站点必须是 ${SITES.join(' | ')}，收到: ${site || '(空)'}`);
  const prompt = pos.slice(1).join(' ');
  const cont = resolveContinue(flags, site);
  const runId = `r${Date.now().toString(36)}`;
  const t0 = Date.now();
  const entry = { kind: 'tool', tool: 'cli.ask', site, runId };
  try {
    // 无桥环境（MCP 关闭）下每条命令都会自拉桥；扩展重连有退避延迟，先等它就绪
    const pre = await ensureExtensionReady();
    if (!pre.ok) throw new Error(pre.error || '扩展未连接');
    let askText = buildPrompt({ prompt, attach: flags.attach, promptFile: flags['--prompt-file'] });
    if (flags['--protocol']) {
      let tpl;
      try { tpl = fs.readFileSync(flags['--protocol'], 'utf8'); } catch (e) { throw usageErr(`--protocol 文件读取失败: ${e.message}`); }
      if (tpl.trim()) askText += `\n\n===== 输出协议（严格遵守）=====\n${tpl}`;
    }
    let schema = null;
    if (flags['--schema']) {
      try { schema = JSON.parse(fs.readFileSync(flags['--schema'], 'utf8')); } catch (e) { throw usageErr(`--schema 文件不是合法 JSON: ${e.message}`); }
    }
    entry.promptHead = short(askText, 60);
    entry.promptHash = promptHash(askText);
    const doAsk = async (t, asContinue) => {
      // 千问生成依赖页面可见性，SW 预算 420s；服务端等待要比它长（与 MCP 侧一致）
      const askTimeout = site === 'qwen' ? 420000 : undefined;
      return request('ask', {
        site, prompt: t, options: null, timeoutMs: askTimeout,
        ...(asContinue ? { continue: true } : {}),
      }, askTimeout ? askTimeout + 60000 : undefined);
    };
    let r = await doAsk(askText, cont);
    // 协议校验失败 → 同会话修复一次（D1/A3）：原 prompt 已在站点上下文里，修复只花一小条消息
    let schemaFail = null;
    let repaired = false;
    if (r.ok && schema) {
      const errs = validateSchema(extractJson(r.text), schema);
      if (errs.length) {
        console.error(`协议校验未通过（${errs.slice(0, 3).join('；')}），同会话修复一次…`);
        const rr = await doAsk('你上面的输出不符合约定的 JSON 协议。只返回符合协议的 JSON 对象本身，不要解释、不要附加文字。', true);
        repaired = true;
        if (rr.ok) {
          const errs2 = validateSchema(extractJson(rr.text), schema);
          if (!errs2.length) r = rr;
          else { r = { ...rr, ok: false }; schemaFail = `协议校验仍未通过: ${errs2.slice(0, 3).join('；')}`; }
        } else { r = rr; }
      }
    }
    Object.assign(entry, {
      ok: !!r.ok, ms: Date.now() - t0,
      queuedMs: r.queuedMs, throttleWaitMs: r.throttleWaitMs,
      textSource: r.textSource, mdVia: r.mdVia, mdLen: r.mdLen, domLen: r.domLen,
      streamStatus: r.streamStatus, streamId: r.streamId,
      challenge: r.challenge ? short(JSON.stringify(r.challenge), 200) : undefined,
      adaptiveSec: r.adaptiveSec, surfaced: r.surfaced || undefined,
      continued: cont || undefined, repaired: repaired || undefined,
    });
    if (!r.ok) {
      entry.stage = schemaFail ? 'quality' : stageOf(r);
      entry.error = short(schemaFail || r.error, 300);
      console.log(failLine({ stage: entry.stage, reason: schemaFail || r.error, runId }));
      if (flags['--why']) printWhy(r, entry);
      process.exitCode = 1;
      return;
    }
    const outDir = path.join(appDir(), 'outputs');
    ensureDir(outDir);
    const outFile = flags['--out'] ? path.resolve(flags['--out']) : path.join(outDir, `${runId}.md`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, r.text ?? '', 'utf8');
    entry.outFile = outFile;
    entry.textLen = (r.text || '').length;
    const exhausted = r.streamStatus === 'CONTEXT_LENGTH_EXCEEDED';
    if (exhausted) entry.sessionExhausted = true;
    if (flags['--json']) {
      console.log(JSON.stringify({
        ok: true, runId, outFile, continued: cont || undefined, repaired: repaired || undefined,
        sessionExhausted: exhausted || undefined,
        data: schema ? extractJson(r.text) : undefined,
        ...r,
      }, null, 2));
    } else {
      const extra = schema ? ' schema=ok' : '';
      console.log(summarize(r, { ms: entry.ms, outFile }) + extra);
      if (exhausted) console.error('警告：站点报告上下文长度已达上限（sessionExhausted），请新开会话（可先让旧会话总结自己）');
      else if (r.warning) console.error(`警告：${r.warning}（streamStatus=${r.streamStatus}）`);
      if (r.truncated || r.timedOut) console.error('警告：以上为部分内容（站点报告未完整结束）');
    }
  } catch (err) {
    if (err && err.code === 'usage') throw err;
    entry.ok = false;
    entry.ms = Date.now() - t0;
    entry.stage = 'connect'; // 走到这里的异常只可能来自桥连接（ensureBridge/request 的连接层）
    entry.error = short(err.message, 300);
    console.log(failLine({ stage: 'connect', reason: err.message, runId }));
    if (flags['--why']) console.error(JSON.stringify({ runId, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    appendRun(entry);
  }
}

function printWhy(r, entry) {
  const { text, ...rest } = r;
  console.error(JSON.stringify({ runId: entry.runId, stage: entry.stage, result: rest, runsFile: runsFile() }, null, 2));
}

async function cmdRuns({ flags }) {
  if (flags['--why']) {
    const id = flags['--why'] === true ? 'last' : flags['--why'];
    const entries = readRuns({ limit: 200 });
    const hit = id === 'last'
      ? [...entries].reverse().find((e) => e.kind === 'tool' && e.ok === false)
      : entries.find((e) => e.runId === id || String(e.ts) === id);
    if (!hit) { console.log(`未找到运行记录: ${id}`); process.exitCode = 1; return; }
    console.log(JSON.stringify(hit, null, 2));
    if (hit.ok === false) console.error(`\n提示：${HINTS[hit.stage] || HINTS.generate}`);
    return;
  }
  if (flags['--dedupe']) {
    const groups = dedupeEntries(readRuns({ limit: 200 }));
    if (!groups.length) { console.log('近期没有重复的 prompt'); return; }
    for (const g of groups) {
      console.log(`${g.hash} ×${g.count}  ${g.site || '?'}  最近 ${new Date(g.lastTs).toLocaleString('zh-CN', { hour12: false })}${g.lastRunId ? ` runId=${g.lastRunId}` : ''}  "${short(g.promptHead, 60)}"`);
    }
    return;
  }
  const entries = readRuns({ limit: flags['--limit'], site: flags['--site'], onlyErrors: flags['--errors'] });
  if (!entries.length) { console.log(`暂无运行记录（${runsFile()}）`); return; }
  console.log(`运行记录（共 ${entries.length} 条，文件 ${runsFile()}）\n${formatRuns(entries)}`);
}

async function cmdInspect({ pos }) {
  const site = pos[0];
  if (!SITES.includes(site)) throw usageErr(`inspect 的站点必须是 ${SITES.join(' | ')}（只读查看，不导航；现场取证唯一入口）`);
  const pre = await ensureExtensionReady({ budgetMs: 15_000 });
  if (!pre.ok) {
    console.log(failLine({ stage: 'connect', reason: pre.error || '扩展未连接' }));
    process.exitCode = 1;
    return;
  }
  const r = await request('inspect', { site }, 60_000);
  if (!r.ok) {
    console.log(failLine({ stage: stageOf(r), reason: r.error }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdStatus() {
  const r = await ensureExtensionReady({ budgetMs: 10_000 });
  if (!r.ok) {
    console.log(failLine({ stage: 'connect', reason: r.error || '扩展异常' }));
    process.exitCode = 1;
    return;
  }
  const q = (r.data && r.data.queues) || {};
  const entries = Object.entries(q);
  const qs = entries.length ? ` ｜ 排队中: ${entries.map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
  const tr = (r.data && r.data.transport) || '未知';
  const err = r.data && r.data.bridgeError ? ` ｜ 桥状态: ${r.data.bridgeError}` : '';
  const own = describeBridge();
  console.log(`扩展已连接（连接承载=${tr}）${qs}${err} ｜ 桥=${own.owner}`);
}

/** bridge start / bridge stop：桥的显式生命周期（用户定稿：任务开始驻留 → 全程共用 → 任务结束收尾）
 *
 * start：已有桥则复用；没有则通过**计划任务**（schtasks → 任务计划程序服务拉起，进程在
 *   AI 命令的 job object 之外）驻留桥 —— 这是沙箱内唯一合法的进程驻留通道
 *   （WMI / explorer 逃逸被安全策略拦截，job 会回收 detached 子进程，均 2026-09-15 实证）。
 *   pid 记入 bridge-keep.json 作为归属凭证。
 * stop：只杀**自己驻留的桥**（按记录）；无记录的外部桥（MCP 会话/用户终端/其它）需 --force。
 */
const BRIDGE_TASK = 'WEBAGENTS-Bridge';
const bridgeKeepFile = () => path.join(appDir(), 'bridge-keep.json');

function readKeep() {
  try { return JSON.parse(fs.readFileSync(bridgeKeepFile(), 'utf8')); } catch { return null; }
}
function writeKeep(rec) {
  ensureDir();
  fs.writeFileSync(bridgeKeepFile(), JSON.stringify(rec, null, 2), 'utf8');
}
function clearKeep() {
  try { fs.unlinkSync(bridgeKeepFile()); } catch { /* 无记录 */ }
}
function findBridgePid() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8' });
      const re = new RegExp('127\\.0\\.0\\.1:' + PORT + '\\s+\\S+\\s+LISTENING\\s+(\\d+)');
      const m = out.match(re);
      return m ? m[1] : null;
    }
    // POSIX：lsof（macOS 自带；Linux 常见）→ ss 兜底
    try {
      const out = execSync(`lsof -t -i TCP:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' });
      const pid = (out.trim().split('\n')[0] || '').trim();
      if (pid) return pid;
    } catch { /* lsof 缺失或无监听 */ }
    try {
      const out = execSync(`ss -lptn 'sport = :${PORT}'`, { encoding: 'utf8' });
      const m = out.match(/pid=(\d+)/);
      if (m) return m[1];
    } catch { /* ss 缺失或无监听 */ }
    return null;
  } catch { return null; }
}

function killPid(pid) {
  if (process.platform === 'win32') {
    return spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' }).status === 0;
  }
  try { process.kill(Number(pid), 'SIGKILL'); return true; } catch { return false; }
}

/** 平台化的桥驻留：Windows 走计划任务（job object 需要服务代拉）；
 *  POSIX 直接 detached spawn（init 收养，天然跨命令存活，无窗口/权限问题）。 */
function spawnDetachedBridge() {
  const child = spawn(process.execPath, [path.join(__dirname, 'bridge.mjs')], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}
/** bridge 归属：驻留（按记录）/ 外部管理（MCP 会话、用户终端等）/ 未运行 */
function describeBridge() {
  const pid = findBridgePid();
  if (!pid) return { running: false, owner: '未运行' };
  const keep = readKeep();
  if (keep && String(keep.pid) === String(pid)) return { running: true, owner: '驻留（计划任务 ' + BRIDGE_TASK + '）', pid };
  return { running: true, owner: '外部管理（MCP 会话 / 用户终端 / 其它）', pid };
}

async function cmdBridge({ pos, flags }) {
  const sub = pos[0];
  if (sub === 'start') {
    // 已有桥 → 直接复用，不重复拉起（桥是单例）；归属照实报告
    const own = describeBridge();
    if (own.running) {
      console.log(`✓ 桥已在运行（${own.owner}${own.pid ? `, pid=${own.pid}` : ''}），直接复用`);
      const pre = await ensureExtensionReady({ budgetMs: 10_000 });
      console.log(pre.ok ? '✓ 扩展已连接' : `⚠ 扩展未连接: ${pre.error}`);
      return;
    }
    // 平台化驻留：
    //   win32 → 计划任务（schtasks → 服务拉起，进程在 AI 命令的 job object 之外）+ vbs 隐藏窗口；
    //   POSIX → detached spawn（init 收养，天然跨命令存活，无窗口/权限问题）。
    const isWin = process.platform === 'win32';
    let pid = null;
    let vbsPath = null;
    ensureDir();
    if (isWin) {
      vbsPath = path.join(appDir(), 'bridge-launch.vbs');
      const line = 'CreateObject("WScript.Shell").Run """' + process.execPath + '"" ""' + path.join(__dirname, 'bridge.mjs') + '""", 0, False';
      fs.writeFileSync(vbsPath, line, 'utf8');
      const mk = spawnSync('schtasks', ['/Create', '/TN', BRIDGE_TASK, '/TR', '"wscript.exe" "' + vbsPath + '"', '/SC', 'ONCE', '/ST', '00:00', '/F'], { encoding: 'utf8' });
      if (mk.status !== 0) {
        console.log(failLine({ stage: 'connect', reason: '计划任务创建失败: ' + ((mk.stderr || mk.stdout || '').trim().slice(0, 120) || '未知原因') }));
        process.exitCode = 1;
        return;
      }
      const run = spawnSync('schtasks', ['/Run', '/TN', BRIDGE_TASK], { encoding: 'utf8' });
      if (run.status !== 0) {
        spawnSync('schtasks', ['/Delete', '/TN', BRIDGE_TASK, '/F'], { encoding: 'utf8' });
        console.log(failLine({ stage: 'connect', reason: '计划任务启动失败: ' + ((run.stderr || run.stdout || '').trim().slice(0, 120) || '未知原因') }));
        process.exitCode = 1;
        return;
      }
      for (let i = 0; i < 20 && !pid; i++) { await sleep(500); pid = findBridgePid(); }
      if (!pid) {
        spawnSync('schtasks', ['/Delete', '/TN', BRIDGE_TASK, '/F'], { encoding: 'utf8' });
        console.log(failLine({ stage: 'connect', reason: '计划任务已启动但桥 10s 内未进入监听（已回滚，检查 node 路径与 WEBAGENTS_HOME）' }));
        process.exitCode = 1;
        return;
      }
    } else {
      spawnDetachedBridge();
      for (let i = 0; i < 20 && !pid; i++) { await sleep(500); pid = findBridgePid(); }
      if (!pid) {
        console.log(failLine({ stage: 'connect', reason: '驻留桥 10s 内未进入监听（检查 node 路径）' }));
        process.exitCode = 1;
        return;
      }
    }
    writeKeep({ pid, task: isWin ? BRIDGE_TASK : null, platform: process.platform, startedAt: new Date().toISOString() });
    const pre = await ensureExtensionReady({ budgetMs: 30_000 });
    if (!pre.ok) {
      console.log(failLine({ stage: 'connect', reason: pre.error || '扩展未连接' }));
      process.exitCode = 1;
      return;
    }
    console.log(isWin
      ? `✓ 桥已驻留（计划任务 ${BRIDGE_TASK}，pid=${pid}，隐藏窗口，跨命令存活直到 bridge stop）`
      : `✓ 桥已驻留（detached pid=${pid}，跨命令存活直到 bridge stop）`);
    console.log('✓ 扩展已连接 —— 任务期间任何 CLI 命令直接复用，无需再拉桥');
    console.log('收尾：任务全部结束后运行 `bridge stop`（杀桥并清理驻留记录' + (isWin ? '与计划任务' : '') + '）');
    return;
  }
  if (sub === 'stop') {
    const keep = readKeep();
    const pid = findBridgePid();
    if (!pid) {
      if (keep) {
        clearKeep();
        if (process.platform === 'win32') spawnSync('schtasks', ['/Delete', '/TN', BRIDGE_TASK, '/F'], { encoding: 'utf8' });
        console.log('✓ 驻留记录已清理（桥进程已不在运行，计划任务已删除）');
      } else {
        console.log('没有在运行的桥（无需收尾）');
      }
      return;
    }
    if (!keep && !flags['--force']) {
      console.log(`当前桥（pid=${pid}）不是本命令驻留的（可能由 MCP 会话 / 你的终端 / 其它程序拉起）。`);
      console.log('如确认要关闭它：`bridge stop --force`；否则无需操作。');
      return;
    }
    if (!killPid(pid)) {
      console.log(failLine({ stage: 'connect', reason: '桥进程结束失败（pid=' + pid + '）' }));
      process.exitCode = 1;
      return;
    }
    if (process.platform === 'win32') spawnSync('schtasks', ['/Delete', '/TN', BRIDGE_TASK, '/F'], { encoding: 'utf8' });
    clearKeep();
    console.log(`✓ 桥已关闭（pid=${pid}），驻留记录与计划任务已清理。需要时任何 CLI 命令会自动重新拉起`);
    return;
  }
  throw usageErr('bridge 子命令：bridge start ｜ bridge stop [--force]');
}
/** doctor：一键体检（PLAN 决议 D5）。核心项（桥/扩展）不过 → 退出码 1，警告项不影响。 */
async function cmdDoctor() {
  const lines = [];
  let coreOk = true;

  // ① 版本口径
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    lines.push(`✓ 版本口径: server=${pkg.version} / 扩展=${manifest.version}（0.5.0 起独立演进）`);
  } catch (e) { lines.push(`⚠ 版本口径读取失败: ${e.message}`); }

  // ② 令牌与配对
  try {
    const tok = resolveToken({ create: false });
    const st = loadBridgeState() || {};
    lines.push(`${tok.token ? '✓' : '✗'} 令牌: 来源=${tok.source}${st.pairedAt ? `，扩展配对于 ${st.pairedAt}` : '，扩展尚未配对（首次连接自动配对）'}`);
    if (!tok.token) coreOk = false;
  } catch (e) { lines.push(`✗ 令牌: ${e.message}`); coreOk = false; }

  // ③ 桥（含归属）
  try {
    await ensureBridge();
    const own = describeBridge();
    lines.push(`✓ 桥: 已连接（归属=${own.owner}${own.pid ? `, pid=${own.pid}` : ''}）`);
  } catch (e) {
    lines.push(`✗ 桥: ${e.message}`);
    console.log(lines.join('\n'));
    console.log('✗ 结论: 不可用（桥层故障）');
    process.exitCode = 1;
    return;
  }

  // ④ 扩展
  try {
    const r = await ensureExtensionReady({ budgetMs: 10_000 });
    if (r.ok) {
      const q = Object.entries((r.data && r.data.queues) || {});
      lines.push(`✓ 扩展: 已连接（承载=${(r.data && r.data.transport) || '?'}${q.length ? `，排队 ${q.map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}）`);
    } else {
      lines.push(`✗ 扩展: ${r.error}`);
      coreOk = false;
    }
  } catch (e) { lines.push(`✗ 扩展: ${e.message}`); coreOk = false; }

  // ⑤ 站点标签页（inspect 不创建不导航，纯只读）
  for (const site of SITES) {
    try {
      const r = await request('inspect', { site }, 15_000);
      lines.push(r.ok ? `✓ ${site}: 会话页 ${((r.data && r.data.url) || '').slice(0, 60)}` : `⚠ ${site}: ${(r.error || '').slice(0, 80)}`);
    } catch (e) { lines.push(`⚠ ${site}: 查看失败 ${e.message}`); }
  }

  // ⑥ 最近失败模式
  try {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const fails = readRuns({ limit: 200, onlyErrors: true }).filter((e) => e.kind === 'tool' && e.ts >= dayAgo);
    if (!fails.length) lines.push('✓ 运行记录: 近 24h 无失败');
    else {
      const byStage = {};
      for (const f of fails) byStage[f.stage || '?'] = (byStage[f.stage || '?'] || 0) + 1;
      lines.push(`⚠ 运行记录: 近 24h 失败 ${fails.length} 次（${Object.entries(byStage).map(([k, v]) => `${k}×${v}`).join(' ')}）—— runs --errors 看详情`);
    }
  } catch { /* 记录不可读不致命 */ }

  console.log(lines.join('\n'));
  console.log(coreOk ? '✓ 结论: 核心链路可用' : '✗ 结论: 核心链路不可用（见上方 ✗ 项）');
  if (!coreOk) process.exitCode = 1;
}

// ===================== 入口 =====================

async function main() {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  if (cmd === 'help' || flags['--help']) { console.log(USAGE); return; }
  try {
    if (cmd === 'ask') return await cmdAsk({ pos, flags });
    if (cmd === 'runs') return await cmdRuns({ flags });
    if (cmd === 'inspect') return await cmdInspect({ pos });
    if (cmd === 'status') return await cmdStatus();
    if (cmd === 'doctor') return await cmdDoctor();
    if (cmd === 'bridge') return await cmdBridge({ pos, flags });
    throw usageErr(`未知子命令: ${cmd}（ask / runs / inspect / status / doctor / bridge / help）`);
  } finally {
    // CLI 是短命进程：不掐断到桥的 WebSocket，事件循环会永远等着（实测挂死）。
    // runs.jsonl 与输出文件都是同步写，无需等待任何 I/O 落盘。
    if (ws) { try { ws.terminate(); } catch {} }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    if (err && err.code === 'usage') {
      console.log(`FAIL stage=input reason=${err.message} hint=${HINTS.input}`);
      console.error(USAGE);
      process.exitCode = 2;
    } else {
      console.log(failLine({ stage: 'connect', reason: (err && err.message) || String(err) }));
      process.exitCode = 1;
    }
  });
}
