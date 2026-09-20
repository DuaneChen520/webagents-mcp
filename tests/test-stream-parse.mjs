#!/usr/bin/env node
/**
 * stream-parse.js 单元测试（脱离浏览器）
 *
 * 为什么需要：流增量解析是 v8 完成判定的地基，错了会静默返回半截答案——
 * 这种错误在浏览器里很难复现，必须在 Node 里用构造数据锁死行为。
 *
 * 运行：node test-stream-parse.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 测试住在 tests/ 下：ROOT = 仓库根（被测代码在 server/ 与 extension/）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension', 'content', 'stream-parse.js');

// 在伪造的 window 上执行模块（模块同时兼容 window 与 CommonJS 两种暴露方式）
const win = {};
new Function('window', readFileSync(SRC, 'utf8'))(win);
const P = win.__WEBAGENTS_STREAM_PARSE__;
if (!P || typeof P.applyOp !== 'function') {
  console.error('无法加载解析模块，检查 extension/content/stream-parse.js');
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`); }
}

console.log('\n[1] parseChunk —— SSE 帧拆行与容错');
check('剥离 data: 前缀',
  P.parseChunk('data: {"a":1}'), [{ a: 1 }]);
check('剥离 event: 前缀，并把事件名带给上层（终态判定要用）',
  P.parseChunk('event: message\ndata: {"a":1}'), [{ __event: 'message', a: 1 }]);
check('裸 JSON 行也能解析',
  P.parseChunk('{"a":1}'), [{ a: 1 }]);
check('[DONE] 不再被静默丢弃，转为终态标记',
  P.parseChunk('data: [DONE]'), [{ __event: 'done' }]);
check('数组载荷展开',
  P.parseChunk('data: [{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
check('坏行不影响好行',
  P.parseChunk('not json\n{"a":1}\n{broken'), [{ a: 1 }]);
check('空输入安全', P.parseChunk(''), []);

console.log('\n[2] applyOp —— 路径-操作增量语义');
{
  const r = {};
  P.applyOp(r, { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '你好' }] });
  check('APPEND 到不存在的数组路径会建数组',
    Array.isArray(r.response.fragments) && r.response.fragments.length, 1);
  P.applyOp(r, { p: 'response/fragments/0/content', o: 'APPEND', v: '，世界' });
  check('APPEND 字符串为拼接',
    r.response.fragments[0].content, '你好，世界');
  P.applyOp(r, { p: 'response/fragments/0/content', o: 'SET', v: '替换' });
  check('SET 覆盖', r.response.fragments[0].content, '替换');
}
{
  const r = {};
  P.applyOp(r, { p: 'response/status', o: 'SET', v: 'FINISHED' });
  check('SET 标量', r.response.status, 'FINISHED');
}
{
  const r = {};
  P.applyOp(r, { o: 'BATCH', v: [
    { p: 'response/a', o: 'SET', v: 1 },
    { p: 'response/b', o: 'SET', v: 2 },
  ] });
  check('BATCH 批量应用', [r.response.a, r.response.b], [1, 2]);
}
{
  const r = {};
  P.applyOp(r, { p: '', o: 'SET', v: 1 });
  P.applyOp(r, null);
  P.applyOp(r, { o: 'SET', v: 1 });
  check('空路径/非法 op 安全跳过', Object.keys(r).length, 0);
}

console.log('\n[2b] mergeDeep —— 无路径整体合并（实测确认：正文只走这条）');
{
  const r = {};
  P.mergeDeep(r, { response: { message_id: 2, role: 'ASSISTANT' } });
  P.mergeDeep(r, { response: { status: 'WIP' } });
  check('嵌套对象逐层合并，不丢已有字段',
    [r.response.message_id, r.response.role, r.response.status], [2, 'ASSISTANT', 'WIP']);
}
{
  const r = { response: { fragments: [{ id: 'f1', type: 'RESPONSE', content: '原来的' }] } };
  P.mergeDeep(r, { response: { fragments: [{ id: 'f1', type: 'RESPONSE', content: '替换后' }] } });
  check('同 id 片段被覆盖', P.extractMarkdown(r), '替换后');
}
{
  const r = { response: { fragments: [{ id: 'f1', content: '第一段' }] } };
  P.mergeDeep(r, { response: { fragments: [{ id: 'f2', content: '第二段' }] } });
  check('只下发新片段时按 id 追加（不丢前面的）',
    r.response.fragments.map((x) => x.content), ['第一段', '第二段']);
}
{
  const r = { response: { fragments: [{ id: 'f1', content: 'a' }] } };
  P.mergeDeep(r, { response: { fragments: [{ content: 'no-id' }] } });
  check('混合 id 情况：内容被更新而不是新增（长度仍为 1）',
    [r.response.fragments.length, r.response.fragments.map((x) => x.content)], [1, ['no-id']]);
}
{
  const r = {};
  P.mergeDeep(r, { a: 1 });
  P.mergeDeep(r, null);
  P.mergeDeep(r, 5);
  check('非对象输入安全', r.a, 1);
}

console.log('\n[2c] appendDelta —— 第三种信封：正文逐片追加（实抓样本就是这个形态）');
{
  const r = {};
  P.mergeDeep(r, { response: { fragments: [{ id: 'f1', type: 'RESPONSE', content: '' }] } });
  for (const ch of ['闭', '包', '是']) P.appendDelta(r, ch);
  check('逐片追加到最后一个片段', P.extractMarkdown(r), '闭包是');
}
{
  // 真实语义：思考阶段追加到 THINK 片段，作答阶段自动转到新的 RESPONSE 片段
  const r = {};
  P.mergeDeep(r, { response: { fragments: [{ id: 'f1', type: 'THINK', content: '' }] } });
  P.appendDelta(r, '先思考');
  check('思考阶段追加到 THINK 片段', r.response.fragments[0].content, '先思考');
  P.mergeDeep(r, { response: { fragments: [{ id: 'f2', type: 'RESPONSE', content: '' }] } });
  P.appendDelta(r, '再作答');
  check('作答阶段自动落到新片段', r.response.fragments[1].content, '再作答');
  check('extractMarkdown 只取 RESPONSE（思考被排除）', P.extractMarkdown(r), '再作答');
}
{
  const r = {};
  P.appendDelta(r, '结构帧未到');
  check('结构帧未到时兜底建片段，不丢字', P.extractMarkdown(r), '结构帧未到');
}
check('空字符串/空 root 安全', [P.appendDelta({}, ''), P.appendDelta(null, 'x')], [false, false]);
{
  const r = {};
  P.mergeDeep(r, { response: { fragments: [{ id: 'f1', type: 'RESPONSE', content: '原有' }] } });
  const ok = P.mergeFragments(r, [{ id: 'f2', type: 'RESPONSE', content: '整数组下发' }]);
  check('[防御] 无路径整数组按片段归并', [ok, P.extractMarkdown(r)], [true, '原有整数组下发']);
  check('[防御] 非片段形态的数组不误判',
    P.mergeFragments({}, [{ a: 1 }]), false);
  check('[防御] 空数组合法忽略', P.mergeFragments({}, []), false);
}

console.log('\n[2d] 负数下标 -1 = 最后一个元素（2026-09-15 实抓确认站点会这么写路径）');
{
  const r = {};
  P.applyOp(r, { p: 'response/fragments/-1/content', o: 'APPEND', v: '：' });
  check('fragments 被建成数组而不是对象', Array.isArray(r.response.fragments), true);
  check('内容落到唯一元素上', r.response.fragments[0].content, '：');
}
{
  const r = {};
  P.mergeDeep(r, { response: { fragments: [
    { id: 'f1', type: 'THINK', content: '思' },
    { id: 'f2', type: 'RESPONSE', content: '答' },
  ] } });
  P.applyOp(r, { p: 'response/fragments/-1/content', o: 'APPEND', v: '案' });
  check('-1 追加到最后一个片段', r.response.fragments[1].content, '答案');
  check('思考片段未被污染，且 extractMarkdown 只取 RESPONSE',
    [r.response.fragments[0].content, P.extractMarkdown(r)], ['思', '答案']);
}
{
  const r = {};
  P.applyOp(r, { p: 'response/fragments/0/content', o: 'SET', v: '首' });
  P.applyOp(r, { p: 'response/fragments/1/content', o: 'SET', v: '次' });
  check('正数下标按需扩容', r.response.fragments.map((f) => f.content), ['首', '次']);
}
{
  const r = {};
  P.applyOp(r, { p: 'response/fragments/-1/content', o: 'APPEND', v: '无类型的正文' });
  P.appendDelta(r, '，继续');
  check('缺 type 的片段也能被识别并继续追加', P.extractMarkdown(r), '无类型的正文，继续');
}
{
  const r = { response: { fragments: [{ content: '已有' }] } };
  P.mergeDeep(r, { response: { fragments: [{ content: '新', extra: 1 }] } });
  check('无 id 数组按位置合并（不冲掉已到达的正文）',
    [P.extractMarkdown(r), r.response.fragments[0].extra], ['新', 1]);
}

console.log('\n[3] noteStatus —— 终态不被迟到的 WIP 回退');
check('WIP → FINISHED',
  P.noteStatus('WIP', 'FINISHED'), 'FINISHED');
check('FINISHED 后迟到的 WIP 不回退',
  P.noteStatus('FINISHED', 'WIP'), 'FINISHED');
check('TIMEOUT 后迟到的 WIP 不回退',
  P.noteStatus('TIMEOUT', 'WIP'), 'TIMEOUT');
check('空值不覆盖',
  P.noteStatus('FINISHED', ''), 'FINISHED');
check('INCOMPLETE 是终态，不被 WIP 覆盖',
  P.noteStatus('INCOMPLETE', 'WIP'), 'INCOMPLETE');

console.log('\n[4] harvestStatus —— 状态字段采集');
{
  let s = null;
  const note = (v) => { s = P.noteStatus(s, v); };
  P.harvestStatus({ p: 'response/quasi_status', o: 'SET', v: 'WIP' }, note);
  check('路径命中 quasi_status', s, 'WIP');
  P.harvestStatus({ p: 'response/quasi_status', o: 'SET', v: 'FINISHED' }, note);
  check('路径命中并推进到 FINISHED', s, 'FINISHED');
}
{
  let s = null;
  const note = (v) => { s = P.noteStatus(s, v); };
  P.harvestStatus({ response: { status: 'INCOMPLETE' } }, note);
  check('浅层下钻 response.status', s, 'INCOMPLETE');
}
{
  let s = null;
  const note = (v) => { s = P.noteStatus(s, v); };
  P.harvestStatus({ finish_reason: 'stop' }, note);
  check('键名 finish_reason', s, 'stop');
}
{
  let s = null;
  P.harvestStatus({ content: 'FINISHED 是一种状态' }, (v) => { s = v; });
  check('正文里出现终态字样不应被当作状态', s, null);
}

console.log('\n[5] extractMarkdown —— 只取 RESPONSE 片段');
check('拼接 RESPONSE 片段',
  P.extractMarkdown({ response: { fragments: [
    { type: 'THINK', content: '思考内容' },
    { type: 'RESPONSE', content: '## 标题\n' },
    { type: 'RESPONSE', content: '```js\ncode\n```' },
  ] } }), '## 标题\n```js\ncode\n```');
check('结构缺失返回空串', P.extractMarkdown({}), '');
check('fragments 非数组返回空串', P.extractMarkdown({ response: { fragments: 'x' } }), '');

console.log('\n[5b] extractMarkdown —— 不依赖路径名（路径是运行时拼接的）');
check('数组改名到 data/segments 仍能取到',
  P.extractMarkdown({ data: { segments: [
    { type: 'THINK', content: '略' },
    { type: 'RESPONSE', content: '正文A' },
  ] } }), '正文A');
check('深层嵌套仍能取到',
  P.extractMarkdown({ a: { b: { c: { fragments: [
    { type: 'RESPONSE', content: '深层' },
  ] } } } }), '深层');
check('键名不含 fragment 时按结构兜底',
  P.extractMarkdown({ payload: { parts: [
    { type: 'RESPONSE', content: '结构兜底' },
  ] } }), '结构兜底');
check('没有任何 RESPONSE 时退而取全部（宁多勿空）',
  P.extractMarkdown({ response: { fragments: [
    { type: 'ANSWER', content: '无标准类型' },
  ] } }), '无标准类型');
check('优先选键名含 fragment 的数组',
  P.extractMarkdown({
    foo: [{ type: 'RESPONSE', content: '错误来源' }],
    response: { fragments: [{ type: 'RESPONSE', content: '正确来源' }] },
  }), '正确来源');

console.log('\n[6] 端到端 —— 一段真实形态的流');
{
  // 模拟 DeepSeek 的路径-操作增量：分片下发 + WIP 反复出现 + 最终终态
  const frames = [
    'data: {"p":"response/fragments","o":"APPEND","v":[{"id":"f1","type":"RESPONSE","content":"# 结论"}]}',
    'data: {"p":"response/quasi_status","o":"SET","v":"WIP"}',
    'data: {"p":"response/fragments/0/content","o":"APPEND","v":"\\n\\n第一段。"}',
    'data: {"p":"response/quasi_status","o":"SET","v":"WIP"}',
    'data: {"p":"response/fragments/0/content","o":"APPEND","v":"\\n\\n```js\\nconst a=1\\n```"}',
    'data: {"p":"response/quasi_status","o":"SET","v":"FINISHED"}',
  ];
  const root = {};
  let status = null;
  const note = (v) => { status = P.noteStatus(status, v); };
  for (const f of frames) {
    for (const one of P.parseChunk(f)) {
      P.harvestStatus(one, note);
      if (typeof one.p === 'string') P.applyOp(root, one);
    }
  }
  check('终态为 FINISHED', status, 'FINISHED');
  check('markdown 完整还原（含代码块）',
    P.extractMarkdown(root), '# 结论\n\n第一段。\n\n```js\nconst a=1\n```');
}
{
  // 被截断场景：终态是 INCOMPLETE —— 这正是旧实现会静默当成功的情况
  const root = {};
  let status = null;
  const note = (v) => { status = P.noteStatus(status, v); };
  const frames = [
    'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"只写了一半"}]}',
    'data: {"p":"response/quasi_status","o":"SET","v":"WIP"}',
    'data: {"p":"response/quasi_status","o":"SET","v":"INCOMPLETE"}',
  ];
  for (const f of frames) {
    for (const one of P.parseChunk(f)) {
      P.harvestStatus(one, note);
      if (typeof one.p === 'string') P.applyOp(root, one);
    }
  }
  check('终态为 INCOMPLETE（可被判为截断）', status, 'INCOMPLETE');
  check('文本仍有内容', P.extractMarkdown(root), '只写了一半');
  check('INCOMPLETE 属于终态集合', P.TERMINAL.has('INCOMPLETE'), true);
  check('WIP 属于进行中集合', P.RUNNING.has('WIP'), true);
}

console.log('\n[7] 命名事件与 [DONE] —— 千问的终态在事件名上，不能丢');
{
  // 依据（千问线上产物 doSend/processChunk）：帧格式为 `event:<名>\ndata:<json>`，
  // 且 `complete` 会触发 stateMachine.transition("complete")。
  const frames = P.parseChunk('event:message\ndata:{"content":"你"}\n\n');
  check('命名事件的 data 被解析出来', frames.length, 1);
  check('携带事件名', frames[0].__event, 'message');
  check('负载保留', frames[0].content, '你');

  const anon = P.parseChunk('data:{"v":"x"}\n\n');
  check('匿名帧不附加 __event（避免污染还原结构）', anon[0].__event, undefined);
  check('匿名帧负载不变', anon[0].v, 'x');

  const done = P.parseChunk('data: [DONE]\n\n');
  check('[DONE] 产出终态标记', done[0].__event, 'done');
}

console.log('\n[7b] statusFromEvent —— 事件名参与终态判定（与"流关闭"互为佐证）');
{
  check('complete → FINISHED', P.statusFromEvent('complete', null), 'FINISHED');
  check('finish → FINISHED', P.statusFromEvent('finish', null), 'FINISHED');
  check('done（[DONE]）→ FINISHED', P.statusFromEvent('done', null), 'FINISHED');
  check('audit（内容审核）→ CONTENT_FILTER', P.statusFromEvent('audit', null), 'CONTENT_FILTER');
  check('security → CONTENT_FILTER', P.statusFromEvent('security', null), 'CONTENT_FILTER');
  check('error → INCOMPLETE（结束了但非正常）', P.statusFromEvent('error', null), 'INCOMPLETE');
  check('message 不是终态（误判会提前收口）', P.statusFromEvent('message', null), null);
  check('answer 不是终态', P.statusFromEvent('answer', null), null);
  check('ping 不是终态', P.statusFromEvent('ping', null), null);
  check('终态不被迟到的 WIP 回退', P.statusFromEvent('start', 'FINISHED'), 'FINISHED');
}

console.log('\n[7c] appendDelta —— 累积式与增量式都要对（站点可能整段重发）');
{
  const inc = { response: { fragments: [{ type: 'RESPONSE', content: '闭' }] } };
  P.appendDelta(inc, '包');
  check('增量式：直接追加', inc.response.fragments[0].content, '闭包');

  const cum = { response: { fragments: [{ type: 'RESPONSE', content: '闭包' }] } };
  P.appendDelta(cum, '闭包是函数');
  check('累积式：识别为重发并替换（否则会重复一遍）', cum.response.fragments[0].content, '闭包是函数');

  const empty = { response: { fragments: [{ type: 'RESPONSE', content: '' }] } };
  P.appendDelta(empty, '首段');
  check('首段正常写入', empty.response.fragments[0].content, '首段');
}

console.log('\n[8] 卡片形态（mimeType）—— 千问的正文模型是 text/markdown 卡片');
{
  // 依据（千问线上产物 appendContentToken）：content.cards[] 元素形如
  // { mimeType: "text/markdown", content: "..." }，token 累加写入。
  // 数组元素用 mimeType 而非 type —— 只认 type 会取不到正文。
  const root = {
    answer: {
      content: {
        cards: [
          { mimeType: 'text/markdown', content: '## 标题\n正文' },
          { mimeType: 'application/json', content: '{"ignored":true}' },
        ],
      },
    },
  };
  check('认出 mimeType 形态的片段数组', Array.isArray(P.findFragmentArray(root)), true);
  check('只取文本卡片（markdown），排除 application/json',
    P.extractMarkdown(root), '## 标题\n正文');

  const withThink = {
    content: { cards: [
      { mimeType: 'text/plain', content: '思考中' },
      { mimeType: 'text/markdown', content: '正式回答' },
    ] },
  };
  check('多个文本卡片按顺序拼接', P.extractMarkdown(withThink), '思考中正式回答');

  const emptyCards = { content: { cards: [{ mimeType: 'image/png', content: 'binary' }] } };
  check('全为非文本卡片时退而取全部（不空手而归）', P.extractMarkdown(emptyCards), 'binary');
}

console.log('\n[9] JSON 字符串负载（千问实测形态）—— 不能整条丢弃');
{
  // 依据：千问的 SSE 负载是被 JSON 编码过的字符串（样本里全是 \" 转义引号）。
  // 旧实现只接受以 { 或 [ 开头的负载，于是整条帧被跳过 ——
  // 表现为 opCount 极小、正文为空（markdownLength=0）。
  const stats = { frames: {} };
  const out = P.parseChunk('event:message\ndata:"{\\"content\\":\\"你好\\"}"\n\n', stats);
  check('被编码的 JSON 字符串会被再解一层', out.length, 1);
  check('解出的结构可用', out[0].content, '你好');
  check('保留事件名', out[0].__event, 'message');
  check('统计标记为 jsonStringObject', stats.frames.jsonStringObject, 1);

  // 解开后仍得到对象（如风控遥测）：按结构合并，不进正文
  const s2 = { frames: {} };
  const out2 = P.parseChunk('data:"{\\"query_risk_shield\\":\\"正常\\"}"\n\n', s2);
  check('解出对象则按结构处理', out2[0].query_risk_shield, '正常');
  check('不计入裸文本样本', out2[0].__rawText, undefined);

  // 解开后是裸字符串：只登记样本（可能是遥测文本），不并入正文
  const s2b = { frames: {} };
  const out2b = P.parseChunk('data:"hello"\n\n', s2b);
  check('裸字符串负载登记为 __rawText', out2b[0] && out2b[0].__rawText, 'hello');
  check('并标记为 jsonStringPlain', s2b.frames.jsonStringPlain, 1);

  const s4 = { frames: {} };
  P.parseChunk('这不是 JSON 行\n\n', s4);
  check('非 JSON 行被统计（便于判断站点是否换了形态）', s4.frames.nonJson, 1);
}

console.log('\n[10] 统计器：一次实跑就能判断站点用了哪种负载形态');
{
  const s = { frames: {} };
  P.parseChunk('data: {"a":1}\n\ndata: [DONE]\n\ndata: {broken\n\n', s);
  check('结构帧计数', s.frames.object, 1);
  check('结束标记计数', s.frames.done, 1);
  check('坏帧计数', s.frames.badJson, 1);
  check('不传统计器也不报错', P.parseChunk('data: {"a":1}').length, 1);
}

console.log('\n[10] 缺 `o` 的路径操作帧＝追加，不是覆盖（2026-09-21 实抓"丢头"五连的元凶）');
{
  // 现场帧（逐字照抄实抓）：站点先用一帧把 RESPONSE 片段连同答案首字符内联下发，
  // 紧接着再来一帧**只带 {p,v}、不带 o** 的 content 写入：
  //   at63 {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"K",…}]}
  //   at64 {"p":"response/fragments/-1/content","v":"IL"}
  // 旧实现 `if (APPEND) … else write(v)` 把"没有 o"落到 else 当 SET，于是内联的首字符被抹掉。
  // 五次真跑分别丢 X / MK / BRA / HEAD / G / K —— N 恒等于创建帧内联 content 的长度。
  const root = {};
  P.mergeDeep(root, { response: { status: 'WIP', fragments: [{ id: 2, type: 'THINK', content: '我们需要' }] } });
  P.applyOp(root, { p: 'response/fragments/-1/content', o: 'APPEND', v: '回答' });
  P.appendDelta(root, '用户');
  P.applyOp(root, { p: 'response/fragments', o: 'APPEND',
    v: [{ id: 3, type: 'RESPONSE', content: 'K', references: [], stage_id: 1 }] });
  P.applyOp(root, { p: 'response/fragments/-1/content', v: 'IL' });
  ['O', '-', '5', '5', '5'].forEach((c) => P.appendDelta(root, c));
  check('缺 o 帧保住内联首字符（旧实现返回 ILO-555）', P.extractMarkdown(root), 'KILO-555');
  check('思考片段不受影响', P.findFragmentArray(root).find((f) => f.type === 'THINK').content, '我们需要回答用户');

  // 缺 o 但整段重发（累积式）时仍按替换处理，不能把正文重复一遍
  const acc = { fragments: [{ id: 1, type: 'RESPONSE', content: 'AB' }] };
  P.applyOp(acc, { p: 'fragments/-1/content', v: 'ABCD' });
  check('缺 o + 累积式重发 → 替换而非重复', P.extractMarkdown(acc), 'ABCD');

  // 显式 SET 依然忠实覆盖：放宽"缺 o"不等于否定 SET
  const set = { fragments: [{ id: 1, type: 'RESPONSE', content: 'OLD' }] };
  P.applyOp(set, { p: 'fragments/-1/content', o: 'SET', v: 'NEW' });
  check('显式 SET 仍覆盖', P.extractMarkdown(set), 'NEW');

  // 结构帧的空 content 不许冲掉已到达的正文（同一类"被结构帧抹掉"的漏修分支）
  const wipe = { response: { fragments: [{ id: 3, type: 'RESPONSE', content: 'PAYLOAD' }] } };
  P.mergeDeep(wipe, { response: { fragments: [{ id: 3, type: 'RESPONSE', content: '' }] } });
  check('空 content 结构帧不冲掉正文', P.extractMarkdown(wipe), 'PAYLOAD');
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
