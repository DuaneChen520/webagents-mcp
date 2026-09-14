#!/usr/bin/env node
/**
 * 流探针集成测试（脱离浏览器，用假 XHR 驱动）
 *
 * 为什么需要：探针跑在页面主世界，与隔离世界的接线（postMessage 协议、
 * since 过滤、世界自报）是整条链路上最容易出错、又最难在浏览器里复现的部分。
 * 这里用伪造的 window + XMLHttpRequest 把探针真跑一遍，锁死行为。
 *
 * 运行：node test-stream-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(__dirname, p), 'utf8');

// ---- 伪造 XMLHttpRequest ----
class FakeXHR {
  constructor() {
    this._listeners = {};
    this.readyState = 0;
    this.responseText = '';
    this._ct = '';
  }
  open(method, url) { this.readyState = 1; this._url = url; }
  send() { this.readyState = 2; }
  getResponseHeader(name) {
    return String(name).toLowerCase() === 'content-type' ? (this._ct || null) : null;
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  _emit(type) { (this._listeners[type] || []).forEach((fn) => fn.call(this, {})); }
  // ——— 以下为测试驱动接口 ———
  push(chunk) { this.responseText += chunk; this.readyState = 3; this._emit('progress'); }
  done() { this.readyState = 4; this._emit('readystatechange'); }
}

// ---- 伪造 fetch（千问走这条：fetch + body.getReader）----
class FakeReader {
  constructor(resp) { this._resp = resp; this._i = 0; this.cancelled = false; }
  read() {
    if (this.cancelled || this._i >= this._resp._chunks.length) {
      return Promise.resolve({ done: true, value: undefined });
    }
    const text = this._resp._chunks[this._i++];
    return Promise.resolve({ done: false, value: new TextEncoder().encode(text) });
  }
  cancel() { this.cancelled = true; return Promise.resolve(); }
}
class FakeResponse {
  constructor(ct, chunks) { this._ct = ct; this._chunks = chunks; }
  get headers() {
    return { get: (k) => (String(k).toLowerCase() === 'content-type' ? this._ct : null) };
  }
  get body() { return { getReader: () => new FakeReader(this) }; }
  clone() { return new FakeResponse(this._ct, this._chunks); }
}

// ---- 伪造 WebSocket（千问的作答流疑似走 WS；探针需要能 hook 它）----
class FakeWS {
  constructor(url, protocols) {
    this.url = url;
    this._listeners = {};
    FakeWS.instances.push(this);
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  send() {}
  close() {}
  _emit(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev)); }
}
FakeWS.instances = [];

// ---- 伪造 window ----
const captured = [];
const msgListeners = [];
const fetchQueue = [];
const win = {
  XMLHttpRequest: FakeXHR,
  WebSocket: FakeWS,
  fetch: (input) => Promise.resolve(fetchQueue.length ? fetchQueue.shift() : new FakeResponse('application/json', ['{}'])),
  __WEBAGENTS_STREAM_PROBE__: undefined,
  addEventListener(type, fn) { if (type === 'message') msgListeners.push(fn); },
  postMessage(msg) { captured.push(msg); msgListeners.forEach((fn) => fn({ data: msg, source: win })); },
};

// 执行解析模块与探针（模拟主世界：chrome 不存在 → 应自报 main）
new Function('window', read('extension/content/stream-parse.js'))(win);
new Function('window', 'chrome', read('extension/content/stream-probe.js'))(win, undefined);

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`); }
}
const find = (type) => captured.filter((m) => m.type === type);
const last = (type) => find(type).slice(-1)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n[1] 探针装载');
check('解析模块已挂载', typeof win.__WEBAGENTS_STREAM_PRAY__ === 'undefined' && typeof win.__WEBAGENTS_STREAM_PARSE__ === 'object', true);
check('XHR 已被 patch（send 被替换）', FakeXHR.prototype.send.toString().includes('__waRec'), true);

console.log('\n[2] 非流式请求不应被跟踪');
{
  const x = new win.XMLHttpRequest();
  x._ct = 'application/json';
  x.open('POST', '/api/session'); x.send();
  x.push('{"ok":true}'); x.done();
}
check('普通 XHR 不产生 stream-start', find('stream-start').length, 0);

console.log('\n[3] 流式请求：增量消费 + 关闭即结束');
{
  const x = new win.XMLHttpRequest();
  x._ct = 'text/event-stream';
  x.open('POST', '/api/v0/chat/completion'); x.send();
  x.push('data: {"p":"response/fragments","o":"APPEND","v":[{"id":"f1","type":"RESPONSE","content":"# 结论"}]}\n');
  x.push('data: {"p":"response/quasi_status","o":"SET","v":"WIP"}\n');
  x.push('data: {"p":"response/fragments/0/content","o":"APPEND","v":"\\n\\n```js\\nconst a=1\\n```"}\n');
  x.push('data: {"p":"response/quasi_status","o":"SET","v":"FINISHED"}\n');
  x.done();
}
check('产生 stream-start', find('stream-start').length, 1);
check('产生 stream-tick', find('stream-tick').length >= 3, true);
check('产生 stream-end', find('stream-end').length, 1);
check('结束原因为 xhr-done', last('stream-end').reason, 'xhr-done');
check('终态识别为 FINISHED', last('stream-end').status, 'FINISHED');
check('还原出的 markdown 长度 > 0', last('stream-end').markdownLength > 0, true);

console.log('\n[4] stream-query：世界自报 + 状态 + since 过滤');
{
  win.postMessage({ source: 'webagents-probe', type: 'stream-query', id: 'q1', since: 0 });
}
check('自报 world=main', last('stream-detail').world, 'main');
check('probeAlive=true', last('stream-detail').probeAlive, true);
check('回报状态 FINISHED', last('stream-detail').data.status, 'FINISHED');
{
  const future = Date.now() + 3600_000;
  win.postMessage({ source: 'webagents-probe', type: 'stream-query', id: 'q2', since: future });
}
check('since 在未来 → 不返回旧流（关键：防止把上一轮当本轮）', last('stream-detail').data, null);

console.log('\n[4b] 回归：一次查询只回一次（曾因回复复用 source 导致无限自问自答）');
{
  const before = find('stream-detail').length;
  win.postMessage({ source: 'webagents-probe', type: 'stream-query', id: 'qloop', since: 0 });
  check('一次 stream-query 只产生 1 条回复', find('stream-detail').length - before, 1);
  check('回复来源与查询来源不同（否则监听器会把回复当新查询）',
    last('stream-detail').source, 'webagents-probe-reply');
}
{
  // 注意：查询与回复同名 stream-text，故按"来源为 reply"计数才是纯回复数
  const replies = () => captured.filter((m) => m.type === 'stream-text' && m.source === 'webagents-probe-reply').length;
  const before = replies();
  win.postMessage({ source: 'webagents-probe', type: 'stream-text', id: 'tloop', since: 0 });
  check('一次 stream-text 只产生 1 条回复', replies() - before, 1);
  check('文本回复同样使用独立来源', last('stream-text').source, 'webagents-probe-reply');
}

console.log('\n[5] stream-text：取原始 markdown 正文');
{
  win.postMessage({ source: 'webagents-probe', type: 'stream-text', id: 't1', since: 0 });
}
check('返回还原出的 markdown',
  last('stream-text').text, '# 结论\n\n```js\nconst a=1\n```');

console.log('\n[6] 截断场景：终态 INCOMPLETE 必须被识别');
{
  const x = new win.XMLHttpRequest();
  x._ct = 'text/event-stream';
  x.open('POST', '/api/v0/chat/completion'); x.send();
  x.push('data: {"p":"response/fragments","o":"APPEND","v":[{"id":"f2","type":"RESPONSE","content":"只写了一半"}]}\n');
  x.push('data: {"p":"response/quasi_status","o":"SET","v":"INCOMPLETE"}\n');
  x.done();
}
check('新流的终态为 INCOMPLETE', last('stream-end').status, 'INCOMPLETE');
{
  win.postMessage({ source: 'webagents-probe', type: 'stream-text', id: 't2', since: 0 });
}
check('文本仍有内容（可交给上层 + 标注截断）', last('stream-text').text, '只写了一半');

console.log('\n[7] 只有新流才算数（since = 第二次请求之前）');
{
  const before = Date.now() - 10;   // 严格早于上一流
  win.postMessage({ source: 'webagents-probe', type: 'stream-query', id: 'q3', since: before });
}
check('取到的是最新一条流', last('stream-detail').data.status, 'INCOMPLETE');

console.log('\n[8] 真实形态回归：只有无路径帧 {v:...}（2026-09-15 实抓就是这个样子）');
{
  // 镜像线上抓到的样本：命名事件 + 无路径整体合并 + 最后一条路径-操作终态。
  // 放在最后，避免影响前面各节对"最新一条流"的断言。
  const x = new win.XMLHttpRequest();
  x._ct = 'text/event-stream; charset=utf-8';
  x.open('POST', '/api/v0/chat/completion'); x.send();
  x.push('event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n\n');
  x.push('event: update_session\ndata: {"updated_at":1789403978.47}\n\n');
  x.push('data: {"v":{"response":{"message_id":2,"parent_id":1,"role":"ASSISTANT","thinking_enabled":false,"status":"WIP"}}}\n\n');
  x.push('data: {"v":{"response":{"fragments":[{"id":"f1","type":"THINK","content":"思考中"}]}}}\n\n');
  x.push('data: {"v":{"response":{"fragments":[{"id":"f2","type":"RESPONSE","content":"成功"}]}}}\n\n');
  x.push('data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n');
  x.done();
}
check('无路径帧也被算作有效写入（opCount>0）', last('stream-end').opCount > 0, true);
check('终态识别为 FINISHED', last('stream-end').status, 'FINISHED');
check('正文由无路径帧还原成功（长度 2）', last('stream-end').markdownLength, 2);
{
  win.postMessage({ source: 'webagents-probe', type: 'stream-text', id: 't0', since: 0 });
}
check('还原出的正文正确（思考片段被排除）', last('stream-text').text, '成功');

console.log('\n[9] 真实形态回归 v2：结构帧 + 字符串逐片追加（第三次实抓就是这个样子）');
{
  // 镜像线上样本：① 结构合并帧 ② 正文按 {v:"<片段>"} 逐片下发 ③ 末尾路径-操作终态。
  // 只处理前两种会得到空正文（markdownLength≈0），这是实际踩过的坑。
  const x = new win.XMLHttpRequest();
  x._ct = 'text/event-stream; charset=utf-8';
  x.open('POST', '/api/v0/chat/completion'); x.send();
  x.push('event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n\n');
  x.push('data: {"v":{"response":{"message_id":2,"role":"ASSISTANT","status":"WIP"}}}\n\n');
  x.push('data: {"v":{"response":{"fragments":[{"id":"f1","type":"THINK","content":""}]}}}\n\n');
  x.push('data: {"v":"思考中"}\n\n');
  x.push('data: {"v":{"response":{"fragments":[{"id":"f2","type":"RESPONSE","content":""}]}}}\n\n');
  x.push('data: {"v":"闭包"}\n\n');
  x.push('data: {"v":"是"}\n\n');
  x.push('data: {"v":"函数"}\n\n');
  x.push('data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n');
  x.done();
}
check('终态识别为 FINISHED', last('stream-end').status, 'FINISHED');
check('正文由字符串片段还原成功（长度 5）', last('stream-end').markdownLength, 5);
// 新机制：正文随 stream-end 事件一并带出，上层本地缓存即可，省掉跨世界往返
check('stream-end 事件自带正文', last('stream-end').text, '闭包是函数');
{
  win.postMessage({ source: 'webagents-probe', type: 'stream-text', id: 't9', since: 0 });
}
check('正文完整且排除了思考片段', last('stream-text').text, '闭包是函数');

console.log('\n[10] fetch 流：Content-Type 不是 event-stream 也要认（千问实测如此）');
{
  // 依据（千问线上产物 doSend）：accept 里列了 text/plain 与通配，且读 body 前
  // 不校验 content-type。只看 header 会整条漏掉，因此必须用"内容侧判据"兜住。
  const resp = new FakeResponse('text/plain', [
    'event:message\ndata:{"content":{"cards":[{"mimeType":"text/markdown","content":"你"}]}}\n\n',
    'event:message\ndata:{"content":{"cards":[{"mimeType":"text/markdown","content":"你好"}]}}\n\n',
    'event:complete\ndata:{}\n\n',
  ]);
  fetchQueue.push(resp);
  win.fetch('/api/chat/stream', {});
  await sleep(60);
}
check('非 event-stream 的流式响应被识别', find('stream-start').length >= 1, true);
check('终态由事件名 complete 判定为 FINISHED', last('stream-end').status, 'FINISHED');
check('卡片形态的正文被还原（累积式下发不重复）', last('stream-end').text, '你好');
check('正文随 stream-end 带出（上层可本地缓存）', last('stream-end').text.length, 2);
{
  win.postMessage({ source: 'webagents-probe', type: 'stream-query', id: 'q10', since: 0 });
}
check('事件词表被记录（排障时判断站点协议的直接依据）',
  last('stream-detail').data.events.includes('complete'), true);
check('opCount > 0（该流确实像问答流，不是遥测）',
  last('stream-detail').data.opCount > 0, true);

console.log('\n[11] fetch 非流式响应不应被跟踪（否则会把每条 API 都当回复）');
{
  const before = find('stream-start').length;
  fetchQueue.push(new FakeResponse('application/json', ['{"ok":true,"items":[1,2,3]}']));
  win.fetch('/api/user/profile', {});
  await sleep(60);
  check('普通 JSON 响应不产生新的流记录', find('stream-start').length, before);
}

console.log('\n[12] WebSocket：文本帧进 ingest，二进制帧只计数');
{
  // 依据（2026-09-15 千问取证）：/api/v2/chat 那条流是风控预审（messages:[]、sse_end:1），
  // 作答数据走了未 hook 的通道 —— 最可能是 WebSocket。hook 后必须能：
  // ① 建流记录（contentType=websocket）；② 文本帧进解析；③ 二进制帧只计数不丢信息。
  FakeWS.instances.length = 0;
  const ws = new win.WebSocket('wss://chat2.qianwen.com/ws');
  check('WebSocket 已被包装', FakeWS.instances.length, 1);
  check('建流记录且 URL 正确', last('stream-start').url, 'wss://chat2.qianwen.com/ws');

  // 文本帧：负载是 JSON 字符串 + 卡片形态（与千问一致）
  ws._emit('message', { data: 'event:answer\ndata:"{\\"cards\\":[{\\"mimeType\\":\\"text/markdown\\",\\"content\\":\\"答案\\"}]}"\n\n' });
  ws._emit('message', { data: { size: 128 } });   // 二进制帧（Blob/ArrayBuffer 形态）
  ws._emit('close', {});

  check('WS 关闭产生 stream-end', !!last('stream-end'), true);
  check('文本帧正文被还原（卡片形态）', last('stream-end').text, '答案');
  {
    win.postMessage({ source: 'webagents-probe', type: 'stream-text', id: 'tws', since: 0 });
  }
  check('正文可取回', last('stream-text').text, '答案');
  {
    win.postMessage({ source: 'webagents-probe', type: 'stream-query', id: 'qws', since: 0 });
  }
  const det = last('stream-detail');
  check('事件名已记录', det.data.events.includes('answer'), true);
  check('帧形态统计可用', det.data.frames.object, 1);
  // streams 摘要在回复顶层（一次问答多条流的决定性证据）
  check('streams 摘要随回复带出', Array.isArray(det.streams) && det.streams.length >= 1, true);
  check('二进制帧被计数', det.streams.filter((x) => x.wsBinary > 0).length, 1);
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
