#!/usr/bin/env node
/**
 * cli.mjs 测试：纯函数单测 + 假桥集成测试（子进程跑真 CLI，断言 stdout 契约与退出码）
 *
 * 要锁住的是 PLAN-cli-skill.md 定稿的三条契约：
 *   1. 失败一行定位：`FAIL stage=<段> reason=… hint=… runId=…` + 退出码 1（用法错误 2）
 *   2. stdout 极简：成功默认一行摘要，正文落盘；--json 才全量
 *   3. --attach 超限必须报错（不静默截断）、--prompt-file 走文件不过 argv
 *
 * 运行：node test-cli.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试住在 tests/ 下：ROOT = 仓库根（被测代码在 server/ 与 extension/）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'server', 'package.json'));
const { WebSocketServer } = require('ws');

const cliPath = path.join(ROOT, 'server', 'cli.mjs');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`); }
};

// ---------- [1] parseArgs ----------
console.log('[1] parseArgs');
const cli = await import(pathToFileURL(cliPath).href);   // 与 cliPath 同一个来源，避免两处路径各说各话
{
  const a = cli.parseArgs(['ask', 'deepseek', '你好', '--out', 'x.md', '--attach', 'a.js', '--attach', 'b.js', '--json']);
  ok(a.cmd === 'ask' && a.pos[0] === 'deepseek' && a.pos[1] === '你好', '位置参数与命令');
  ok(a.flags['--out'] === 'x.md' && a.flags['--json'] === true, '旗标与布尔旗标');
  ok(a.flags.attach.length === 2 && a.flags.attach[1] === 'b.js', '--attach 可重复');
  let threw = false;
  try { cli.parseArgs(['ask', 'deepseek', '--out']); } catch (e) { threw = e.code === 'usage'; }
  ok(threw, '缺旗标值 → usage 错误');
  const b = cli.parseArgs(['ask', 'deepseek', 'q', '--why']);
  ok(b.flags['--why'] === true, '--why 无值 → 布尔（ask 场景）');
  const c = cli.parseArgs(['runs', '--why', 'last']);
  ok(c.flags['--why'] === 'last' && c.cmd === 'runs', '--why 有值 → 吃值（runs 场景）');
}

// ---------- [2] buildPrompt ----------
console.log('[2] buildPrompt（--attach / --prompt-file / 60KB 上限）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cli-'));
  const f = path.join(dir, 'code.js');
  fs.writeFileSync(f, 'const answer = 42;\n');
  const p = cli.buildPrompt({ prompt: '审查这个文件', attach: [f] });
  ok(p.startsWith('审查这个文件'), 'prompt 在前');
  ok(p.includes(`===== 附件 1: code.js =====`) && p.includes('const answer = 42;'), '附件内容被拼入');

  const big = path.join(dir, 'big.js');
  fs.writeFileSync(big, 'x'.repeat(61 * 1024));
  let threw = false;
  try { cli.buildPrompt({ prompt: 'p', attach: [big] }); } catch (e) { threw = e.code === 'usage' && /60KB/.test(e.message); }
  ok(threw, '超 60KB 明确报错（不静默截断）');

  const pf = path.join(dir, 'prompt.txt');
  fs.writeFileSync(pf, '来自文件的提问');
  ok(cli.buildPrompt({ promptFile: pf }) === '来自文件的提问', '--prompt-file 作为 prompt 主体');
  let threw2 = false;
  try { cli.buildPrompt({ prompt: '   ' }); } catch (e) { threw2 = e.code === 'usage'; }
  ok(threw2, '空 prompt → usage 错误');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- [3] stageOf / failLine ----------
console.log('[3] 失败定位（stage 分段与 FAIL 行契约）');
{
  ok(cli.stageOf({ stage: 'queue' }) === 'queue', '扩展上报的 stage 优先透传');
  ok(cli.stageOf({ mdLen: 0, streamId: 's1' }) === 'retrieve', 'mdLen=0 且 streamId 有值 → retrieve');
  ok(cli.stageOf({ streamStatus: 'INCOMPLETE' }) === 'quality', '非正常终态 → quality');
  ok(cli.stageOf({ error: 'WEBAGENTS 扩展未连接' }) === 'connect', '连接类报错 → connect');
  ok(cli.stageOf({}) === 'generate', '默认 → generate');
  const line = cli.failLine({ stage: 'retrieve', reason: 'stream_empty', runId: 'rabc' });
  ok(/^FAIL stage=retrieve reason=stream_empty hint=.+ runId=rabc$/.test(line), `FAIL 行格式（${line}）`);
}

// ---------- [4] dedupeEntries ----------
console.log('[4] runs --dedupe（promptHash 分组，决策留给调用方）');
{
  const t = Date.now();
  const groups = cli.dedupeEntries([
    { kind: 'tool', promptHash: 'aaaa', promptHead: '问题A', site: 'deepseek', ts: t, runId: 'r1' },
    { kind: 'bridge', event: 'x', ts: t + 1 },
    { kind: 'tool', promptHash: 'aaaa', promptHead: '问题A', site: 'deepseek', ts: t + 2, runId: 'r2' },
    { kind: 'tool', promptHash: 'bbbb', promptHead: '问题B', site: 'qwen', ts: t + 3, runId: 'r3' },
  ]);
  ok(groups.length === 1 && groups[0].hash === 'aaaa' && groups[0].count === 2 && groups[0].lastRunId === 'r2', '只报 count>1 的组，取最近一条');
}

// ---------- [5] extractJson / validateSchema ----------
console.log('[5] 协议输出解析与轻校验（零依赖）');
{
  ok(cli.extractJson('前置说明 ```json\n{"a":1}\n``` 后记')?.a === 1, '围栏 JSON');
  ok(cli.extractJson('结果如下：{"a":{"b":2}} 请查收')?.a.b === 2, '裸 JSON（前后有废话）');
  ok(cli.extractJson('完全没有结构化内容') === undefined, '解析失败 → undefined');
  ok(cli.validateSchema({ verdict: 'fail', issues: [] }, { required: ['verdict'], properties: { verdict: 'string', issues: 'array' } }).length === 0, '合法对象通过');
  ok(cli.validateSchema({ issues: [] }, { required: ['verdict'] }).length === 1, '缺必填字段被捕获');
  ok(cli.validateSchema({ verdict: 1 }, { properties: { verdict: 'string' } }).length === 1, '类型不符被捕获');
}

// ---------- [6] 集成：假桥 + 真 CLI 子进程 ----------
console.log('[6] 集成：假桥 + 真 CLI 子进程');

const FAKE_PORT = 8798;
const FAKE_TOKEN = 'cli-test-token';
const wss = new WebSocketServer({ host: '127.0.0.1', port: FAKE_PORT });
await new Promise((res) => wss.on('listening', res));

/** mode: status-ok | ask-ok | ask-fail | schema-repair | schema-bad | ask-exhausted | ext-late */
let mode = 'status-ok';
let lastAsk = null;
let askCount = 0;
let pingCount = 0;
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'hello') {
      if (msg.role === 'cli' && msg.token === FAKE_TOKEN) ws.send(JSON.stringify({ type: 'hello-ok', role: 'cli' }));
      else ws.send(JSON.stringify({ type: 'hello-fail', error: '令牌不匹配' }));
      return;
    }
    if (msg.type === 'request') {
      if (msg.action === 'ping') {
        pingCount++;
        if (mode === 'ext-late' && pingCount <= 2) {
          // 模拟桥刚拉起、扩展还没重连完（可等待错误）
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'WEBAGENTS 扩展未连接（请在 Edge 中确认扩展已启用且浏览器已打开）' }));
        } else {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data: { queues: { deepseek: 1 }, transport: 'offscreen' } }));
        }
      } else if (msg.action === 'inspect') {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: `${msg.site} 标签页未打开（inspect 不会自动创建）` }));
      } else if (msg.action === 'ask') {
        lastAsk = msg;
        askCount++;
        if (mode === 'ask-fail') {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: '扩展执行超时（模拟）', mdLen: 0, streamId: 's9' }));
        } else if (mode === 'schema-repair') {
          const bad = askCount === 1;
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, text: bad ? '抱歉，我理解不了协议。' : '```json\n{"verdict":"fail","issues":[]}\n```', textSource: 'stream', mdLen: 10, domLen: 0, streamStatus: 'FINISHED' }));
        } else if (mode === 'schema-bad') {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, text: '我还是不会输出 JSON。', textSource: 'stream', mdLen: 12, domLen: 0, streamStatus: 'FINISHED' }));
        } else if (mode === 'ask-exhausted') {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, text: '部分内容', textSource: 'stream', mdLen: 4, domLen: 0, streamStatus: 'CONTEXT_LENGTH_EXCEEDED' }));
        } else {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, text: '模拟答案正文', textSource: 'stream', mdLen: 6, domLen: 0, streamStatus: 'FINISHED', queuedMs: 800 }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: `假桥不认识 action=${msg.action}` }));
      }
    }
  });
});

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-home-'));

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        WEBAGENTS_PORT: String(FAKE_PORT),
        WEBAGENTS_TOKEN: FAKE_TOKEN,
        WEBAGENTS_HOME: tmpHome,
        ...env,
      },
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: errOut.trim() }));
  });
}

{
  const { code, out } = await runCli(['status']);
  ok(code === 0 && out.includes('扩展已连接') && out.includes('offscreen') && out.includes('deepseek=1'), 'status：成功摘要一行');
}
{
  const outPath = path.join(tmpHome, 'answer.md');
  const { code, out } = await runCli(['ask', 'deepseek', '测试问题', '--out', outPath]);
  ok(code === 0 && /^done \d+\.\d+s /.test(out), `ask 成功：stdout 一行摘要（${out.split('\n')[0]}）`);
  ok(out.includes('-> ') && fs.readFileSync(outPath, 'utf8') === '模拟答案正文', '正文落盘且 stdout 不含正文');
  ok(out.includes('status=FINISHED') && out.includes('排队0.8s'), '摘要带 status 与排队提示');
  const runsRaw = fs.readFileSync(path.join(tmpHome, 'runs.jsonl'), 'utf8').trim().split('\n');
  const entry = JSON.parse(runsRaw[runsRaw.length - 1]);
  ok(entry.tool === 'cli.ask' && entry.ok === true && entry.runId && entry.promptHash, 'runs.jsonl 记录 runId/promptHash');
  ok(entry.promptHash === cli.promptHash('测试问题'), 'promptHash 与纯函数一致');
}
{
  const { code, out } = await runCli(['ask', 'qwen', '测试问题二', '--json']);
  ok(code === 0 && JSON.parse(out).text === '模拟答案正文' && JSON.parse(out).runId, 'ask --json：全量 JSON 含 runId');
  ok(lastAsk && lastAsk.site === 'qwen' && typeof lastAsk.timeoutMs === 'number', 'qwen 请求带 420s 预算');
}
{
  mode = 'ask-fail';
  const { code, out } = await runCli(['ask', 'deepseek', '会失败的问题']);
  ok(code === 1, 'ask 失败 → 退出码 1');
  ok(/^FAIL stage=retrieve reason=.* hint=.+ runId=r/.test(out), `失败一行定位（${out.split('\n')[0]}）`);
  mode = 'status-ok';
}
{
  const big = path.join(tmpHome, 'big.js');
  fs.writeFileSync(big, 'x'.repeat(61 * 1024));
  const { code, out } = await runCli(['ask', 'deepseek', 'p', '--attach', big]);
  ok(code === 2 && /^FAIL stage=input /.test(out), 'attach 超限 → usage 退出码 2 + FAIL stage=input');
}
{
  const pf = path.join(tmpHome, 'p.txt');
  fs.writeFileSync(pf, '文件里的提问');
  await runCli(['ask', 'deepseek', '--prompt-file', pf]);
  ok(lastAsk && lastAsk.prompt === '文件里的提问', '--prompt-file 内容到达桥（不过 argv 拼接）');
}
{
  const { code, out } = await runCli(['runs', '--why', 'last']);
  ok(code === 0 && JSON.parse(out).ok === false && JSON.parse(out).stage === 'retrieve', 'runs --why last：取最近失败记录全量诊断');
}
{
  await runCli(['ask', 'deepseek', '测试问题']);   // 第二次相同 prompt → 造一条重复
  const { code, out } = await runCli(['runs', '--dedupe']);
  ok(code === 0 && out.includes('×2'), `runs --dedupe 报重复组（${out.split('\n')[0]}）`);
}
{
  const { code, out } = await runCli(['nosuch']);
  ok(code === 2 && /^FAIL stage=input /.test(out), '未知子命令 → 退出码 2');
}

// ---------- [7] 批次二：--continue / 协议校验 / doctor ----------
console.log('[7] continue / 协议校验 / doctor');
{
  const { code, out } = await runCli(['ask', 'deepseek', '追问一下', '--continue', 'last']);
  ok(code === 0 && lastAsk && lastAsk.continue === true, '--continue last：请求带 continue 标记');
  ok(out.includes('-> '), 'continue 成功仍走一行摘要');
}
{
  const { code } = await runCli(['ask', 'deepseek', '接着问', '--continue', 'here']);
  ok(code === 0 && lastAsk.continue === true, '--continue here：同样带 continue 标记');
}
{
  const { code, out } = await runCli(['ask', 'deepseek', 'x', '--continue', 'rNoSuch']);
  ok(code === 2 && /^FAIL stage=input /.test(out), '--continue 未知 runId → usage 错误');
}
{
  fs.appendFileSync(path.join(tmpHome, 'runs.jsonl'), JSON.stringify({ kind: 'tool', tool: 'cli.ask', site: 'qwen', runId: 'rQwenX', ok: true, ts: Date.now() }) + '\n');
  const { code, out } = await runCli(['ask', 'deepseek', 'x', '--continue', 'rQwenX']);
  ok(code === 2 && /不一致/.test(out), '--continue runId 跨站 → usage 错误');
}
{
  mode = 'ask-exhausted';
  const { code, err } = await runCli(['ask', 'deepseek', '长任务', '--continue', 'here']);
  ok(code === 0 && err.includes('sessionExhausted'), 'CONTEXT_LENGTH_EXCEEDED → 成功但透出 sessionExhausted 警告');
  mode = 'status-ok';
}
{
  mode = 'schema-repair'; askCount = 0;
  const schemaFile = path.join(tmpHome, 'schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify({ required: ['verdict'], properties: { verdict: 'string', issues: 'array' } }));
  const { code, err } = await runCli(['ask', 'deepseek', '结构化任务', '--schema', schemaFile]);
  ok(code === 0 && err.includes('协议校验未通过'), `首次违规 → 同会话修复成功（${err.split('\n')[0]}）`);
  ok(lastAsk && lastAsk.continue === true && lastAsk.prompt.includes('只返回符合协议的 JSON 对象本身'), '修复追问走 continue 且带固定修复指令');
  mode = 'status-ok';
}
{
  mode = 'schema-bad';
  const { code, out } = await runCli(['ask', 'deepseek', '结构化任务', '--schema', path.join(tmpHome, 'schema.json')]);
  ok(code === 1 && /^FAIL stage=quality reason=协议校验仍未通过/.test(out), `两次违规 → FAIL stage=quality（${out.split('\n')[0]}）`);
  mode = 'status-ok';
}
{
  const { code, out } = await runCli(['doctor']);
  ok(code === 0 && out.includes('核心链路可用'), 'doctor：核心链路可用');
  ok(out.includes('⚠ deepseek') || out.includes('⚠ qwen'), 'doctor：站点标签页未打开为警告级');
}
{
  mode = 'ext-late'; pingCount = 0;
  const t0 = Date.now();
  const { code, out } = await runCli(['status']);
  const waited = Date.now() - t0 >= 1500; // 两次失败各等 1s，至少应重试过
  ok(code === 0 && out.includes('扩展已连接') && waited, `扩展延迟重连 → status 等待后成功（耗时 ${Date.now() - t0}ms）`);
  mode = 'status-ok';
}
{
  const { code, out } = await runCli(['bridge', 'start']);
  ok(code === 0 && out.includes('桥已在运行'), 'bridge start：桥已在运行 → 复用不重复拉起');
}
{
  const { code, out } = await runCli(['bridge', 'stop'], { WEBAGENTS_PORT: '8797' });
  ok(code === 0 && out.includes('没有在运行的桥'), 'bridge stop：无桥时优雅收尾');
}
{
  fs.writeFileSync(path.join(tmpHome, 'bridge-keep.json'), JSON.stringify({ pid: 999999999, task: 'WEBAGENTS-Bridge' }));
  const { code, out } = await runCli(['bridge', 'stop'], { WEBAGENTS_PORT: '8797' });
  ok(code === 0 && out.includes('驻留记录已清理'), 'bridge stop：有驻留记录但桥已死 → 清理记录');
}
{
  const { code, out } = await runCli(['bridge', 'stop']);
  ok(code === 0 && out.includes('不是本命令驻留的'), 'bridge stop：外部桥（fake 桥无记录）→ 提示 --force 不误杀');
}

console.log('[8] buildOptions：按调用指定开关（0.7.0 补，此前只有已删除的 MCP 入口能做）');
{
  const bo = cli.buildOptions;
  ok(JSON.stringify(bo('deepseek', { '--think': 'off', '--search': 'on' })) === JSON.stringify({ deepThink: false, search: true }),
    'deepseek --think off --search on → {deepThink:false,search:true}');
  ok(bo('deepseek', {}) === null, '不给开关 → null（不干预页面状态）');
  ok(bo('qwen', { '--mode': 'think' }).mode === 'think', 'qwen --mode think');
  const bad = (fn) => { try { fn(); return false; } catch (e) { return e.code === 'usage'; } };
  ok(bad(() => bo('deepseek', { '--think': 'maybe' })), '取值非法 → 用法错误（退出码 2）');
  ok(bad(() => bo('qwen', { '--mode': 'yolo' })), 'qwen 非法模式 → 用法错误');
  ok(bad(() => bo('qwen', { '--think': 'on' })), 'qwen 用 --think → 用法错误（串站了）');
  ok(bad(() => bo('deepseek', { '--mode': 'fast' })), 'deepseek 用 --mode → 用法错误');
}

wss.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
