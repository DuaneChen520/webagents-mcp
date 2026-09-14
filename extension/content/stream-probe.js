/**
 * WebAgents 流探针（MAIN world / document_start）
 *
 * 为什么需要它：
 *   站点的"回复是否结束"是明确的（DeepSeek 有 MessageStatus 枚举 + 终态定义
 *   `status !== 'WIP'`），但这个状态只存在于前端内部数据与网络响应流里，
 *   既不写进 DOM 属性、也不进控制台。因此唯一可靠的读法 = 在页面主世界拦下响应流。
 *
 * 本文件只读不改，绝不干扰站点自身逻辑：
 *   1. 判定"服务端已把响应流关闭"——协议级硬信号，与站点文案/类名无关
 *   2. 尽力从路径-操作增量（{p,o,v}）还原结构化结果与原始 markdown
 *      （纯解析逻辑在 content/stream-parse.js，可脱离浏览器单测）
 *
 * 通信：window.postMessage({ source:'webagents-probe', ... })
 *      由隔离世界的 content/common.js 接收后并入 state 载荷。
 */
(() => {
  'use strict';
  if (window.__WEBAGENTS_STREAM_PROBE__) return;
  window.__WEBAGENTS_STREAM_PROBE__ = true;

  const PARSE = window.__WEBAGENTS_STREAM_PARSE__;
  if (!PARSE) return;   // 解析模块未加载（manifest js 顺序错误）→ 放弃探针，但不影响站点
  const { applyOp, mergeDeep, mergeFragments, appendDelta, noteStatus, harvestStatus, extractMarkdown, parseChunk, statusFromEvent } = PARSE;

  const PROBE = 'webagents-probe';
  /**
   * 回复专用来源标记（必须与 PROBE 区分）。
   * 教训：曾经用同一个 source 回复，结果探针自己的 message 监听器把自己的回复
   * 当成新查询 → 再回一次 → 无限递归，异常被 try/catch 静默吞掉，
   * 外部表现为"查询拿不到结果"（正文突然变空）。分离来源后即时收敛。
   */
  const PROBE_REPLY = 'webagents-probe-reply';
  const MAX_SAMPLE = 4000;        // 诊断用原始样本上限
  const MAX_MARKDOWN = 200000;    // 还原文本上限，防爆内存
  const MAX_STREAMS = 8;          // 同时跟踪的流数量上限

  /**
   * 自报所处世界：只有隔离世界才拿得到 chrome.runtime.id。
   * 隔离世界读不到主世界的全局变量，因此只能由探针"自报身份"；
   * 若自报 isolated，说明 manifest 的 world:"MAIN" 未生效，上层必须放弃流信号。
   */
  const IN_MAIN_WORLD = !(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

  const streams = [];
  let seq = 0;

  /**
   * 诊断开关：探针可以被临时关掉。
   *
   * 为什么需要运行时开关：DeepSeek 走 XHR（我们只读 responseText，不复制流），
   * 而千问走 fetch —— 我们对 fetch 做了 `clone()` 再读，属于"与站点共享同一条流"。
   * 一旦 clone 处理有副作用，站点自己读流就会被拖住，表现为"提交了但永远不出答案"。
   * 要证伪这条假设，必须能做"A/B 关掉探针再试"，且不必每次改代码重载。
   *
   * 跨世界传参只能用 DOM（主世界读不到 chrome.storage，隔离世界写不了主世界全局变量），
   * 因此由隔离世界的 common.js 把开关写到 documentElement 的 data 属性上，这里懒读取。
   */
  function probeDisabled() {
    try {
      return document.documentElement && document.documentElement.dataset
        && document.documentElement.dataset.waProbeOff === '1';
    } catch { return false; }
  }

  function post(payload) {
    try { window.postMessage(Object.assign({ source: PROBE }, payload), '*'); } catch { /* 忽略 */ }
  }

  /** 回复走独立来源标记，避免被自己的监听器再次当成查询（见 PROBE_REPLY 注释） */
  function postReply(payload) {
    try { window.postMessage(Object.assign({ source: PROBE_REPLY }, payload), '*'); } catch { /* 忽略 */ }
  }

  function current() { return streams.length ? streams[streams.length - 1] : null; }

  function newStream(url, contentType) {
    const rec = {
      id: `s${++seq}`,
      url: String(url || '').slice(0, 200),
      contentType: contentType || '',
      startedAt: Date.now(),
      endedAt: 0,
      status: null,
      opCount: 0,
      offset: 0,
      sample: '',
      rawTexts: [],        // 裸字符串负载的样本（不并入正文，仅诊断用）
      frames: {},          // 帧形态统计：一次实跑就能判断站点用了哪种负载
      root: {},
      text: '',
      events: [],          // 见过的事件名（去重，供诊断快速判断站点协议）
    };
    // 终态优先：已经收到 FINISHED/TIMEOUT 等之后，不被迟到的 WIP 覆盖
    rec.noteStatus = (v) => { rec.status = noteStatus(rec.status, v); };
    streams.push(rec);
    while (streams.length > MAX_STREAMS) streams.shift();
    post({ type: 'stream-start', id: rec.id, url: rec.url, startedAt: rec.startedAt });
    return rec;
  }

  /**
   * 消费新增的文本块：拆帧 → 解析 → 应用增量。
   *
   * 三种信封都要处理（都是 2026-09-15 实抓确认的，缺任何一种都会丢正文）：
   *   ① {p, o, v}      路径-操作（一轮问答仅 2 条）
   *   ② {v: {...}}     无路径整体合并（承载消息结构与 fragments 数组）
   *   ③ {v: "<文本>"}  正文逐片追加（**实际正文的全部内容**）
   * 末尾两条为防御分支：尚未实抓出现，但宁可多认一种形态，不要静默丢弃。
   *
   * 另有命名事件（SSE `event:` 行）：千问的终态就在事件名上（`complete`），
   * 因此事件名也要参与终态判定 —— 这是除"流关闭"之外第二个独立的完成信号。
   */
  /** 帧内是否含"可能承载正文"的键（用于判断这条流像不像问答流，而非遥测/心跳） */
  const CONTENTISH_KEY = /^(content|c|answer|cards|fragments|response|text|delta|data|message)$/i;
  function hasContentishKey(o) {
    for (const k of Object.keys(o)) if (CONTENTISH_KEY.test(k)) return true;
    return false;
  }

  function ingest(rec, chunk) {
    if (!chunk) return;
    rec.sample = (rec.sample + chunk).slice(-MAX_SAMPLE);
    const stats = { frames: rec.frames };
    for (const raw of parseChunk(chunk, stats)) {
      // 裸字符串负载：留样本，不并入正文（可能是风控遥测，混进去会污染答案）
      if (typeof raw.__rawText === 'string') {
        if (rec.rawTexts.length < 5) rec.rawTexts.push(raw.__rawText.slice(0, 300));
        continue;
      }
      const ev = typeof raw.__event === 'string' ? raw.__event : null;
      // 事件名只用于状态判定，不参与结构还原（否则 __event 会被合并进消息树）
      let one = raw;
      if (ev) { one = Object.assign({}, raw); delete one.__event; }
      if (ev) {
        if (!rec.events.includes(ev)) rec.events.push(ev);
        rec.noteStatus(statusFromEvent(ev, rec.status));
      }
      harvestStatus(one, rec.noteStatus);
      if (typeof one.p === 'string' && (one.o || one.v !== undefined)) {
        applyOp(rec.root, one);
        rec.opCount++;
      } else if (one.v && typeof one.v === 'object' && !Array.isArray(one.v)) {
        mergeDeep(rec.root, one.v);
        rec.opCount++;
      } else if (typeof one.v === 'string' && one.v) {
        appendDelta(rec.root, one.v);
        rec.opCount++;
      } else if (Array.isArray(one.v)) {
        if (mergeFragments(rec.root, one.v)) rec.opCount++;
      } else if (ev) {
        // 命名事件且 data 本身就是消息对象（千问的风格：event:answer + data:{...}）
        mergeDeep(rec.root, one);
        if (hasContentishKey(one)) rec.opCount++;
      } else if (one.response && typeof one.response === 'object') {
        // 防御：极少数帧可能不套 v 直接下发消息对象
        mergeDeep(rec.root, one);
        rec.opCount++;
      }
    }
  }

  function finish(rec, reason) {
    if (!rec || rec.endedAt) return;
    rec.endedAt = Date.now();
    rec.text = extractMarkdown(rec.root, MAX_MARKDOWN);
    post({
      type: 'stream-end',
      id: rec.id,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      status: rec.status,
      opCount: rec.opCount,
      markdownLength: rec.text.length,
      reason,
      // 正文随结束事件一并带出（只此一次，最多 200KB）：
      // 上层即可在本地缓存直接取用，省掉一次跨世界往返 —— 那一跳曾经丢过。
      text: rec.text,
    });
  }

  /**
   * 判定一个响应是不是"流式回复"。
   *
   * 不能只看 Content-Type：千问的 fetch 请求 accept 里同时列了
   * application/json / text/event-stream / text/plain / 通配，而它读响应体前
   * **并不校验 content-type**（线上产物里 readStream 直接读 body）。
   * 若服务端回的是 text/plain，只看 header 就会整条漏掉。
   *
   * 因此加一条内容侧判据：样本看起来像 SSE 帧（event: / data: 行开头），
   * 或含 DeepSeek 的路径-操作特征。两条任一命中即按流跟踪。
   */
  const looksLikeStream = (ct, sample) => {
    if (/text\/event-stream/i.test(ct || '')) return true;
    if (typeof sample === 'string' && sample) {
      const head = sample.slice(0, 600);
      // 收紧到"确实是 SSE 帧"的形态，避免把普通 JSON / HTML 误判成流：
      //   event:xxx            命名事件
      //   data:{...} / data:[  数据帧且负载是 JSON
      if (/^[ \t]*event[ \t]*:/m.test(head)) return true;
      if (/^[ \t]*data[ \t]*:[ \t]*[{[]/m.test(head)) return true;
      if (/"o"\s*:\s*"(APPEND|SET|BATCH)"/.test(sample)) return true;
    }
    return false;
  };

  // ---- 1) XMLHttpRequest（DeepSeek 走这条：包内无 EventSource / fetch 流式痕迹）----
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        this.__waUrl = url;
        this.__waRec = null;
        return origOpen.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        const xhr = this;
        try {
          const attach = () => {
            try {
              if (probeDisabled()) return;   // 诊断 A/B：关掉探针时完全不参与
              const ct = String(xhr.getResponseHeader('content-type') || '');
              const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
              // 内容侧判据需要一点样本才成立，因此要求已有足够长度再判断
              const isStream = looksLikeStream(ct, text.length > 24 ? text.slice(0, 600) : '');
              if (!isStream) return;
              if (!xhr.__waRec) xhr.__waRec = newStream(xhr.__waUrl, ct);
              if (text.length > xhr.__waRec.offset) {
                const delta = text.slice(xhr.__waRec.offset);
                xhr.__waRec.offset = text.length;
                ingest(xhr.__waRec, delta);
                post({ type: 'stream-tick', id: xhr.__waRec.id, chars: text.length, status: xhr.__waRec.status });
              }
            } catch { /* responseType 非文本 / 头部不可读，忽略 */ }
          };
          xhr.addEventListener('progress', attach);
          xhr.addEventListener('readystatechange', () => {
            if (xhr.readyState === 3) attach();
            else if (xhr.readyState === 4) { attach(); finish(xhr.__waRec, 'xhr-done'); }
          });
          xhr.addEventListener('load', () => { attach(); finish(xhr.__waRec, 'xhr-load'); });
          xhr.addEventListener('error', () => finish(xhr.__waRec, 'xhr-error'));
          xhr.addEventListener('abort', () => finish(xhr.__waRec, 'xhr-abort'));
        } catch { /* 绝不阻断站点请求 */ }
        return origSend.apply(this, arguments);
      };
    }
  } catch { /* 忽略 */ }

  // ---- 2) fetch（千问走这条：fetch + body.getReader 读流，见线上产物 doSend/readStream）----
  //
  // 关键：**要在读完第一个数据块之后才决定跟不跟**。因为站点可能不回
  // `content-type: text/event-stream`（千问的 accept 列了 text/plain 与 */*，
  // 且它不校验 header 就直接读 body），此时只看 header 会整条漏掉。
  // 读的是 clone，站点自己的那份不受影响；判定为非流则立刻 cancel，避免缓冲无限增长。
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const url = (typeof input === 'string') ? input : (input && input.url) || '';
        return origFetch.apply(this, arguments).then((resp) => {
          try {
            // 诊断 A/B：关掉探针时**连 clone 都不做**（这就是要验证的变量）
            if (probeDisabled()) return resp;
            if (!resp || !resp.body || typeof resp.body.getReader !== 'function') return resp;
            const ct = String((resp.headers && resp.headers.get('content-type')) || '');
            const clone = resp.clone();
            const reader = clone.body.getReader();
            const dec = new TextDecoder();
            let rec = null;
            let decided = false;
            (function pump() {
              reader.read().then(({ done, value }) => {
                if (done) { if (rec) finish(rec, 'fetch-done'); return; }
                const text = dec.decode(value, { stream: true });
                if (!decided) {
                  decided = true;
                  if (!looksLikeStream(ct, text)) {
                    try { reader.cancel(); } catch { /* 忽略 */ }
                    return;
                  }
                  rec = newStream(url, ct);
                }
                ingest(rec, text);
                pump();
              }).catch(() => { if (rec) finish(rec, 'fetch-error'); });
            })();
          } catch { /* 绝不阻断站点请求 */ }
          return resp;
        });
      };
    }
  } catch { /* 忽略 */ }

  // ---- 3) EventSource ----
  try {
    const ES = window.EventSource;
    if (typeof ES === 'function') {
      const Wrapped = function (url, config) {
        const inst = new ES(url, config);
        try {
          const rec = newStream(url, 'text/event-stream');
          inst.addEventListener('message', (ev) => ingest(rec, ev && ev.data));
          inst.addEventListener('error', () => finish(rec, 'es-error'));
          inst.addEventListener('close', () => finish(rec, 'es-close'));
          const origClose = inst.close.bind(inst);
          inst.close = function () { finish(rec, 'es-manual-close'); return origClose(); };
        } catch { /* 忽略 */ }
        return inst;
      };
      Wrapped.prototype = ES.prototype;
      try { Object.setPrototypeOf(Wrapped, ES); } catch { /* 忽略 */ }
      window.EventSource = Wrapped;
    }
  } catch { /* 忽略 */ }

  // ---- 4) WebSocket（2026-09-15 取证：千问的作答流不在我们已 hook 的 fetch/XHR 里）----
  //
  // 证据：一次问答页面上只看到 /api/v2/chat 这一条流，其内容是风控预审
  //（model=chat_audit_qa、problem_code=pass、messages:[]、sse_end:"1"），
  // 而页面明明渲染出了答案 —— 说明作答数据走了我们还没 hook 的通道。
  // fetch/XHR/EventSource 都已覆盖，剩下最常见的就是 WebSocket。
  //
  // 注意：这里只读不改。文本帧交给 ingest（有帧统计，能判断形态）；
  // 二进制帧只计数不解码（解码成本高，先确认"有没有"再决定"怎么解"）。
  try {
    const WS = window.WebSocket;
    if (typeof WS === 'function' && !WS.__webagentsPatched) {
      const Wrapped = function (url, protocols) {
        const inst = protocols === undefined ? new WS(url) : new WS(url, protocols);
        try {
          if (!probeDisabled()) {
            const rec = newStream(String(url), 'websocket');
            inst.addEventListener('message', (ev) => {
              try {
                const d = ev && ev.data;
                if (typeof d === 'string') ingest(rec, d);
                else if (d && typeof d === 'object') {
                  // 二进制帧：先计数。若确认答案在这里，再按帧头解码。
                  rec.wsBinary = (rec.wsBinary || 0) + 1;
                  rec.wsBinaryBytes = (rec.wsBinaryBytes || 0) + (d.size || d.byteLength || 0);
                }
              } catch { /* 忽略 */ }
            });
            inst.addEventListener('close', () => finish(rec, 'ws-close'));
            inst.addEventListener('error', () => finish(rec, 'ws-error'));
          }
        } catch { /* 绝不干扰站点 */ }
        return inst;
      };
      Wrapped.prototype = WS.prototype;
      try { Object.setPrototypeOf(Wrapped, WS); } catch { /* 忽略 */ }
      try { Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSING = 2; Wrapped.CLOSED = 3; } catch { /* 忽略 */ }
      try { Object.defineProperty(Wrapped, '__webagentsPatched', { value: true }); } catch { /* 忽略 */ }
      window.WebSocket = Wrapped;
    }
  } catch { /* 忽略 */ }

  // ---- 供隔离世界按需取状态/诊断 ----
  // since：只返回该时间点之后开始的流，避免把上一次问答的流当成本次的
  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || d.source !== PROBE) return;

    const pick = () => {
      const since = Number(d.since) || 0;
      let rec = null;
      for (let i = streams.length - 1; i >= 0; i--) {
        if (!since || streams[i].startedAt >= since) { rec = streams[i]; break; }
      }
      if (!rec && !since) rec = current();
      return rec;
    };

    if (d.type === 'stream-text') {
      // 优先按 id 精确取（一次问答可能有多条流，按"最新"取会张冠李戴）
      let rec = null;
      if (d.streamId) rec = streams.find((x) => x.id === d.streamId) || null;
      if (!rec) rec = pick();
      postReply({
        type: 'stream-text', id: d.id,
        world: IN_MAIN_WORLD ? 'main' : 'isolated',
        streamId: rec ? rec.id : null,
        text: rec ? rec.text : '',
      });
      return;
    }

    if (d.type !== 'stream-query') return;
    const rec = pick();
    postReply({
      type: 'stream-detail',
      id: d.id,
      world: IN_MAIN_WORLD ? 'main' : 'isolated',
      probeAlive: true,
      data: rec ? {
        id: rec.id, url: rec.url, contentType: rec.contentType,
        startedAt: rec.startedAt, endedAt: rec.endedAt, status: rec.status,
        opCount: rec.opCount, markdownLength: rec.text.length,
        markdownHead: rec.text.slice(0, 500),
        rootKeys: Object.keys(rec.root || {}),
        responseKeys: rec.root && rec.root.response ? Object.keys(rec.root.response) : [],
        // 事件词表：站点协议的直接证据。"status 一直为空"时看这里就能判断
        // 是"没有命名事件"还是"事件名不在我们的终态词表里"。
        events: rec.events.slice(0, 20),
        // 帧形态统计与裸字符串样本：一次实跑就能定位"为什么没还原出正文"
        // （例如全是 jsonStringPlain 说明负载是被编码的字符串、我们暂不当正文）
        frames: rec.frames,
        rawTexts: rec.rawTexts.map((t) => String(t).slice(0, 200)),
        sample: rec.sample.slice(-1500),
      } : null,
      // **本页跟踪到的所有流**的摘要。决定性证据：一次问答可能有多条流
      // （风控预审 + 正式作答），只看"最新一条"会误判成"没有答案流"。
      streams: streams.map((s) => ({
        id: s.id, startedAt: s.startedAt, endedAt: s.endedAt,
        opCount: s.opCount, status: s.status, mdLen: s.text.length,
        contentType: s.contentType,
        urlTail: s.url.split('?')[0].split('/').slice(-1)[0] || s.url,
        frames: s.frames, events: s.events.slice(0, 8),
        // 二进制帧计数：若答案走 WS 且是二进制，这里能直接看出来
        wsBinary: s.wsBinary || 0,
        wsBinaryBytes: s.wsBinaryBytes || 0,
        rawTexts: s.rawTexts.length,
      })),
    });
  });
})();
