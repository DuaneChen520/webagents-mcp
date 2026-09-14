/**
 * WebAgents 流增量解析（纯函数，无副作用、无页面依赖）
 *
 * 从 stream-probe.js 抽出，目的：能在 Node 里脱离浏览器做单元测试。
 * 语义对齐站点前端：路径-操作增量 { p, o, v }，o ∈ SET | APPEND | BATCH。
 * 站点侧对应实现（DeepSeek 线上产物）：d.set(path, value) / d.append(path, value)
 *
 * 挂到 window.__WEBAGENTS_STREAM_PARSE__ 供探针使用（MAIN world）。
 */
(() => {
  'use strict';

  /**
   * 完成态词表 —— 来自 DeepSeek 线上产物的 MessageStatus 枚举。
   * 站点自己的终态定义是 `isTerminal: status => !!status && status !== 'WIP'`，
   * 即下列全部视为"已结束"。除 FINISHED 外都意味着"结束了但可能被截断/拦截"。
   */
  const TERMINAL = new Set([
    'FINISHED', 'INCOMPLETE', 'CONTENT_FILTER', 'CONTEXT_LENGTH_EXCEEDED', 'TIMEOUT',
    // 通用兜底：其它站点可能用小写或同义词
    'finished', 'done', 'completed', 'complete', 'end', 'ended', 'stop', 'stopped',
  ]);
  const RUNNING = new Set([
    'WIP', 'wip', 'RUNNING', 'running', 'PENDING', 'GENERATING', 'INITIALIZING', 'AWAITING_FIRST_CHANGE',
  ]);
  const STATUS_KEYS = new Set([
    'status', 'quasi_status', 'quasiStatus',
    'finish_reason', 'finishReason', 'stop_reason', 'stopReason',
  ]);

  /**
   * 路径-操作增量应用（对齐站点 set/append/batch 语义）。
   *
   * 下标写法（2026-09-15 实抓确认）：站点用 **`-1` 表示"最后一个元素"**，
   * 例如 `{"p":"response/fragments/-1/content","o":"APPEND","v":"："}`。
   * 因此数组下标必须支持负数，否则 `fragments` 会被误建成对象、后续内容全部走偏。
   */
  function applyOp(root, op) {
    if (!root || !op || typeof op !== 'object') return;
    const { p, o, v } = op;
    if (o === 'BATCH' || o === 'batch') {
      (Array.isArray(v) ? v : []).forEach((child) => applyOp(root, child));
      return;
    }
    if (typeof p !== 'string' || !p) return;
    const segs = p.split('/').filter(Boolean);
    if (!segs.length) return;

    const isIdx = (s) => /^-?\d+$/.test(s);
    const idxOf = (arr, s) => (s === '-1' ? arr.length - 1 : Number(s));

    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const wantArray = isIdx(segs[i + 1]);
      let child;
      if (Array.isArray(node)) {
        const idx = idxOf(node, seg);
        child = idx >= 0 ? node[idx] : undefined;
      } else {
        child = node[seg];
      }
      if (child === null || typeof child !== 'object') {
        child = wantArray ? [] : {};
        if (Array.isArray(node)) {
          const idx = idxOf(node, seg);
          if (idx >= 0) node[idx] = child; else node.push(child);
        } else {
          node[seg] = child;
        }
      }
      node = child;
    }

    const last = segs[segs.length - 1];
    const read = () => {
      if (Array.isArray(node)) {
        const idx = idxOf(node, last);
        return idx >= 0 ? node[idx] : undefined;
      }
      return node[last];
    };
    const write = (val) => {
      if (Array.isArray(node)) {
        const idx = idxOf(node, last);
        if (idx >= 0) node[idx] = val; else node.push(val);
      } else {
        node[last] = val;
      }
    };

    if (o === 'APPEND' || o === 'append') {
      const cur = read();
      if (typeof cur === 'string' && typeof v === 'string') write(cur + v);
      else if (Array.isArray(cur)) write(cur.concat(Array.isArray(v) ? v : [v]));
      else write(v);
    } else {
      write(v);
    }
  }

  /**
   * 无路径帧的深合并。
   *
   * 2026-09-15 实抓发现（决定性）：DeepSeek 的响应流有**两种信封**：
   *   ① 路径-操作：{p:"response/status", o:"SET", v:"FINISHED"}
   *   ② 无路径整体合并：{v:{response:{message_id:2, fragments:[...]}}}
   * 实测一轮问答里仅 2 条 ①，正文全部走 ② 下发。若丢掉 ②，正文必然为空。
   * 这与站点前端 `if(!e.path){ get(e.value,"response.fragments") ... }` 的分支一致。
   *
   * 数组处理：两侧都是"带 id 的对象数组"时按 id 归并（兼容"整数组替换"与
   * "只下发新片段"两种服务端行为），否则整体替换。
   */
  function mergeDeep(target, src) {
    if (!target || typeof target !== 'object' || !src || typeof src !== 'object') return target;
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (Array.isArray(v)) target[k] = mergeArray(target[k], v);
      else if (v && typeof v === 'object') {
        if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
        mergeDeep(target[k], v);
      } else {
        target[k] = v;
      }
    }
    return target;
  }

  /** 带 id 的对象数组 → 按 id 归并；无 id 的对象数组 → 按位置合并（保住已到达的正文）；否则替换 */
  function mergeArray(cur, incoming) {
    const objArr = (arr) => Array.isArray(arr) && arr.length > 0
      && arr.every((x) => x && typeof x === 'object');
    const idArr = (arr) => objArr(arr) && arr.every((x) => x.id !== undefined);
    if (idArr(cur) && idArr(incoming)) {
      const byId = new Map(cur.map((x) => [x.id, x]));
      for (const item of incoming) {
        const prev = byId.get(item.id);
        byId.set(item.id, prev && typeof prev === 'object' ? mergeDeep(Object.assign({}, prev), item) : item);
      }
      return [...byId.values()];
    }
    if (objArr(cur) && objArr(incoming)) {
      // 无 id 时若整体替换，结构帧会把已经到达的正文冲掉，因此按位置合并
      const out = cur.slice();
      for (let i = 0; i < incoming.length; i++) {
        out[i] = out[i] && typeof out[i] === 'object'
          ? mergeDeep(Object.assign({}, out[i]), incoming[i])
          : incoming[i];
      }
      return out;
    }
    return incoming.slice();
  }

  /**
   * 状态推进（纯函数）：终态一旦确立，不被迟到的 WIP 覆盖。
   * 必要性：流里 WIP 会反复下发，若在 FINISHED 之后又来一条 WIP 就回退，
   * 完成判定会重新变成"进行中"，前功尽弃。
   */
  function noteStatus(current, incoming) {
    if (typeof incoming !== 'string' || !incoming) return current;
    if (RUNNING.has(incoming) && current && TERMINAL.has(current)) return current;
    return incoming;
  }

  /**
   * 从任意 JSON 对象里挑出状态类字段。
   * 用有界递归（深度 ≤ 4）而非写死层级：状态可能出现在 response.status、
   * quasi_status、v.response.status 等处，写死层级会在信封变化时漏掉。
   */
  function harvestStatus(obj, note) {
    if (!obj || typeof obj !== 'object' || typeof note !== 'function') return;
    // 路径带 status / finish 的写入（路径-操作信封）
    if (typeof obj.p === 'string' && typeof obj.v === 'string'
      && /status|finish|stop_reason/i.test(obj.p)) {
      note(obj.v);
    }
    const walk = (node, depth) => {
      if (depth > 4 || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const it of node) walk(it, depth + 1); return; }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (STATUS_KEYS.has(k) && typeof v === 'string' && v) note(v);
        else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(obj, 0);
  }

  /**
   * 第三种信封：`{v: "<文本片段>"}` —— 正文按字符串逐片下发。
   *
   * 2026-09-15 实抓确认（一轮真实问答的样本就是这种形态）：
   *   data: {"v":"，"}  data: {"v":"让"}  data: {"v":"函数"}  ...
   *   data: {"v":"```"} data: {"v":"javas"}
   * 语义 = 追加到"当前正在生成的那个片段"的 content 上（思考阶段是 THINK 片段，
   * 作答阶段是 RESPONSE 片段），所以取片段数组的最后一个即可，且保留其 type
   * 以便 extractMarkdown 过滤。
   */
  function appendDelta(root, delta) {
    if (!root || typeof root !== 'object' || typeof delta !== 'string' || !delta) return false;
    const frags = findFragmentArray(root);
    if (Array.isArray(frags) && frags.length) {
      const last = frags[frags.length - 1];
      if (last && typeof last.content === 'string') {
        // 增量式 vs 累积式都要正确处理：
        //   · 增量式（DeepSeek）：新内容与本段已有内容无关，直接追加
        //   · 累积式（部分站点整段重发）：新内容以已有内容开头且更长 → 替换，否则会重复一遍
        // 只凭"未出现过的形态不该猜"，这个判别能同时兼容两种，且不依赖站点声明。
        if (delta.length > last.content.length && delta.startsWith(last.content)) last.content = delta;
        else last.content += delta;
        return true;
      }
    }
    // 结构帧尚未到达：建一个占位片段兜住内容，宁可暂归错类型也不丢字
    if (!root.response || typeof root.response !== 'object') root.response = {};
    if (!Array.isArray(root.response.fragments)) root.response.fragments = [];
    root.response.fragments.push({ type: 'RESPONSE', content: delta });
    return true;
  }

  /**
   * 防御分支：无路径的整数组下发（形如 `{v:[{type,content},...]}`）。
   * 目前实抓未出现，但把它当成"片段数组"归并总好过静默丢弃 ——
   * 已为"没预料到的信封"付出过三次重连的代价，这里一次性兜住。
   */
  function mergeFragments(root, arr) {
    if (!root || typeof root !== 'object' || !Array.isArray(arr) || !arr.length) return false;
    const shaped = arr.every((x) => x && typeof x === 'object'
      && typeof x.type === 'string' && typeof x.content === 'string');
    if (!shaped) return false;
    let frags = findFragmentArray(root);
    if (!Array.isArray(frags)) {
      if (!root.response || typeof root.response !== 'object') root.response = {};
      root.response.fragments = [];
      frags = root.response.fragments;
    }
    const merged = mergeArray(frags, arr);
    frags.length = 0;
    for (const x of merged) frags.push(x);
    return true;
  }

  /**
   * 在还原出的对象树里找"片段数组"。
   * 为什么不写死 `response.fragments`：站点的增量路径是运行时拼接的，
   * 路径名可能随版本变化；这里改为按结构识别（元素同时有 type:string 与 content:string），
   * 并优先选择键名里含 fragment 的那个数组。这样路径改名不会让正文还原失效。
   */
  function findFragmentArray(root) {
    const found = { keyTyped: null, keyContent: null, typed: null, content: null };
    // 类型标识：DeepSeek 用 `type`，千问的卡片用 `mimeType`（如 text/markdown）。
    // 两种都认，否则换一个站点就要改一次选择逻辑。
    const typeOf = (o) => (typeof o.type === 'string' ? o.type
      : (typeof o.mimeType === 'string' ? o.mimeType : null));
    const seen = new Set();
    const walk = (node, keyHint) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        const objs = node.filter((x) => x && typeof x === 'object');
        if (objs.length && objs.length === node.length) {
          const hasContent = objs.every((o) => typeof o.content === 'string');
          const hasType = hasContent && objs.every((o) => typeOf(o) !== null);
          const isKey = /fragment/i.test(keyHint);
          // 片段可能由 `-1` 路径操作建出来而暂时缺 type，因此接受"只有 content"的形态，
          // 但优先级低于带 type 的；键名含 fragment 的最高。
          if (hasType && isKey && !found.keyTyped) found.keyTyped = node;
          if (hasContent && isKey && !found.keyContent) found.keyContent = node;
          if (hasType && !found.typed) found.typed = node;
          if (hasContent && !found.content) found.content = node;
        }
        for (const x of node) walk(x, keyHint);
        return;
      }
      for (const k of Object.keys(node)) walk(node[k], k);
    };
    walk(root, '');
    return found.keyTyped || found.keyContent || found.typed || found.content;
  }

  /**
   * 取原始 markdown：只取正式回答片段，排除思考/工具片段与正文无关的卡片。
   * 若一个回答片段都没有，则退而取"非思考类"；再不行才取全部
   * —— 宁可多取，不要空手而归（但绝不让思考内容混进正文）。
   */
  const NON_ANSWER_TYPE = /^(THINK|THINKING|COT|TOOL|SEARCH|WEB_SEARCH)/;

  /** 片段类型标识：`type` 优先，其次 `mimeType` */
  const kindOf = (f) => {
    if (!f) return '';
    const t = (typeof f.type === 'string' && f.type) || f.mimeType || '';
    return String(t).toUpperCase();
  };

  function extractMarkdown(root, maxLen = 200000) {
    try {
      const frags = findFragmentArray(root);
      if (!Array.isArray(frags) || !frags.length) return '';

      // ① 明确是回答：DeepSeek 的 RESPONSE / 千问的 text/markdown 卡片
      let picked = frags.filter((f) => {
        const k = kindOf(f);
        return k === 'RESPONSE' || k.startsWith('TEXT/');
      });

      // ② 退一步：排除思考类，以及 mimeType 形态的非文本卡片（application/*、vnd.* 等）
      if (!picked.length) {
        const nonAnswer = frags.filter((f) => {
          const k = kindOf(f);
          if (NON_ANSWER_TYPE.test(k)) return false;
          if (k.includes('/') && !k.startsWith('TEXT/')) return false;
          return true;
        });
        picked = nonAnswer;
      }

      // ③ 再不行才全取
      if (!picked.length) picked = frags;

      const text = picked.map((f) => (typeof f.content === 'string' ? f.content : '')).join('');
      return text.length > maxLen ? text.slice(0, maxLen) : text;
    } catch { return ''; }
  }

  /**
   * SSE 事件名 → 状态。
   *
   * 依据（千问线上产物，2026-09-15 取证）：它的流用命名事件，
   * 事件词表含 message / answer / complete / finish / error / audit / security / ping，
   * 且 `complete` 会触发 stateMachine.transition("complete")，即**协议级的结束信号**。
   *
   * 这给了我们除"流关闭"之外的第二个独立终态来源；两者互为佐证。
   * 注意只认明确的终态词，`message` / `answer` / `ping` 等不在此列 ——
   * 误判成终态会让完成判定提前收口。
   */
  const TERMINAL_EVENTS = /^(complete|completed|finish|finished|done|end|ended)$/i;
  const CONTENT_FILTER_EVENTS = /^(audit|security)$/i;
  const ERROR_EVENTS = /^(error|exception)$/i;

  function statusFromEvent(name, current) {
    if (typeof name !== 'string' || !name) return current;
    if (CONTENT_FILTER_EVENTS.test(name)) return noteStatus(current, 'CONTENT_FILTER');
    if (ERROR_EVENTS.test(name)) return noteStatus(current, 'INCOMPLETE');
    if (TERMINAL_EVENTS.test(name)) return noteStatus(current, 'FINISHED');
    return current;
  }

  /**
   * 把一段新增文本按 SSE 帧拆行并解析出增量对象列表。
   *
   * 负载形态（2026-09-15 起三种都要认）：
   *   ① data: {...} / data: [...]   —— 直接是 JSON 结构
   *   ② data: "{...}"               —— **负载是 JSON 字符串**，需再解一层。
   *      千问实测就是这个形态（样本里全是 \" 转义引号）；旧实现只接受 { 或 [ 开头，
   *      于是整条帧被丢弃 —— 表现为 opCount 极小、正文为空。
   *   ③ data: [DONE]                —— 协议级结束标记
   *
   * 注意：② 解开后若仍是**裸字符串**，只登记为诊断样本，不当作正文 ——
   * 千问的流里混有风控遥测（query_risk_shield / vipserver 之类），
   * 盲目当文本追加会污染答案。宁可先留证据，再按实际形态精确适配。
   */
  function parseChunk(chunk, stats) {
    const out = [];
    if (!chunk) return out;
    const bump = (k) => { if (stats && stats.frames) stats.frames[k] = (stats.frames[k] || 0) + 1; };
    let event = null;   // 当前帧的 event 名（空行 = 帧结束）
    for (let raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) { event = null; continue; }
      const m = /^(data|event|id|retry)\s*:\s*([\s\S]*)$/.exec(line);
      const kind = m ? m[1] : null;
      const body = (m ? m[2] : line).trim();
      if (kind === 'event') { event = body; continue; }
      if (!body) continue;
      // 流结束标记：本身不含正文，但它是协议级终态，必须带出来
      if (body === '[DONE]') { out.push({ __event: 'done' }); bump('done'); continue; }
      const head = body[0];
      if (head !== '{' && head !== '[' && head !== '"') { bump('nonJson'); continue; }

      let obj;
      try { obj = JSON.parse(body); } catch { bump('badJson'); continue; }

      // ② 负载是被编码过的 JSON 字符串：再解一层
      if (typeof obj === 'string') {
        const inner = obj.trim();
        if (inner && (inner[0] === '{' || inner[0] === '[')) {
          try {
            const deeper = JSON.parse(inner);
            if (deeper && typeof deeper === 'object') { obj = deeper; bump('jsonStringObject'); }
            else { bump('jsonStringOther'); }
          } catch { bump('jsonStringPlain'); }
        } else {
          bump('jsonStringPlain');
        }
      }

      if (typeof obj === 'string') {
        // 裸字符串：登记为样本供诊断，不并入正文（可能是遥测文本）
        out.push(event ? { __event: event, __rawText: obj } : { __rawText: obj });
        continue;
      }

      const list = Array.isArray(obj) ? obj : [obj];
      for (const one of list) {
        if (!one || typeof one !== 'object') continue;
        bump('object');
        // 只有命名事件才附加 __event；匿名帧保持原样，避免污染还原出的结构
        out.push(event ? Object.assign({ __event: event }, one) : one);
      }
    }
    return out;
  }

  const api = { TERMINAL, RUNNING, STATUS_KEYS, TERMINAL_EVENTS, statusFromEvent, applyOp, mergeDeep, mergeArray, mergeFragments, appendDelta, noteStatus, harvestStatus, extractMarkdown, findFragmentArray, parseChunk };
  if (typeof window !== 'undefined') window.__WEBAGENTS_STREAM_PARSE__ = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
