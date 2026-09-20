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
  const { applyOp, mergeDeep, mergeFragments, appendDelta, noteStatus, harvestStatus, extractMarkdown, parseChunk, statusFromEvent, findFragmentArray } = PARSE;

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
      // 头部样本：sample 只留尾部，而"丢头"类问题要看的是**最前面那几帧的原文** ——
      // 没有它只能靠帧计数猜（2026-09-21 就是这样连猜错两次）。
      head: '',
      /**
       * "答案片段第一次出现"前后的帧窗口（verbatim）。
       * 丢头有两种长相相同的成因，只有这几帧能分辨：
       *   A 答案的头几个增量先于 RESPONSE 片段到达、被并进 THINK，随后又被结构帧整段覆盖掉；
       *   B 那几帧根本没被探针看到。
       * 上一轮想用 THINK 的 tail 判别 A，但 mergeDeep 对字符串是直接赋值（content 会被重写），
       * A 的残留会被抹平 —— 所以必须留帧原文。
       */
      answerStart: null,
      // 正文增量按"落到哪个片段类型"的字数记账（到达即记，见 ingest 里的说明）
      deltaByKind: {},
      // 其中在 has_pending_fragment=true 期间到达的部分（修法判据）
      pendingByKind: {},
      /**
       * 所有碰过 content 的**路径操作**帧原文（有界）。
       * 为什么要它：裸 `{v:"字"}` 增量记在 deltaByKind 里，而路径操作不记 ——
       * 2026-09-21 实抓的算术差口正是这个：RESPONSE 最终 9 字、裸增量只 7 字，
       * 缺的 2 字只能来自一帧 `{"p":"…/content","o":"SET",…}`，而 SET 是**覆盖**不是追加。
       * 没有逐帧原文就只能像之前几轮那样靠聚合数猜（已猜错三次）。
       */
      contentOps: [],
      frameRing: [],       // 最近 6 帧原文，用于在切换点回看前几帧
      // 缺 `o` 且写 content 的帧数：见 ingest 处的说明
      noOpContentWrites: 0,
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

  /** 与 stream-parse 的 NON_ANSWER_TYPE 对齐：这些类型的片段是思考/工具，不是正文 */
  const NON_ANSWER_KIND = /^(THINK|THINKING|COT|TOOL|SEARCH|WEB_SEARCH)/;
  /** 一个对象长得像片段吗（带 type/mimeType 就认） */
  const fragKindOf = (o) => (o && typeof o === 'object' && typeof (o.type || o.mimeType) === 'string')
    ? String(o.type || o.mimeType).toUpperCase() : null;
  /**
   * 这一帧是否把"正式回答片段"结构带了出来 —— 即思考→答案的切换点。
   * 三种下发形态都要认（上一版只认第一种，结果现场没触发）：
   *   ① {v:{response:{fragments:[…]}}}   整块结构
   *   ② {v:[…]}                          数组直发
   *   ③ {p:"response/fragments/-1", v:{id,type,content}}  路径操作直接下发单个片段
   */
  function introducesAnswerFrame(one) {
    const v = one && one.v;
    if (!v || typeof v !== 'object') return false;
    const cands = [];
    if (Array.isArray(v)) cands.push(...v);
    else {
      if (v.response && Array.isArray(v.response.fragments)) cands.push(...v.response.fragments);
      const direct = fragKindOf(v);
      if (direct) cands.push(Object.assign({ type: direct }, v));
    }
    return cands.some((f) => {
      const k = fragKindOf(f);
      return !!k && !NON_ANSWER_KIND.test(k);
    });
  }

  function ingest(rec, chunk) {
    if (!chunk) return;
    rec.sample = (rec.sample + chunk).slice(-MAX_SAMPLE);
    if (rec.head.length < MAX_SAMPLE) rec.head = (rec.head + chunk).slice(0, MAX_SAMPLE);
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
      // —— 帧窗口留证（6 帧、每帧 180 字，代价可忽略）：定位"答案是从哪一帧开始的" ——
      try {
        const line = JSON.stringify(one).slice(0, 180);
        rec.frameRing.push(line);
        while (rec.frameRing.length > 6) rec.frameRing.shift();
        if (!rec.answerStart && introducesAnswerFrame(one)) {
          rec.answerStart = { atOp: rec.opCount, prev: rec.frameRing.slice(0, -1), frame: line };
        }
      } catch { /* 序列化不了不影响解析 */ }
      harvestStatus(one, rec.noteStatus);
      if (typeof one.p === 'string' && (one.o || one.v !== undefined)) {
        // 把"缺 o 的 content 写入"这件事本身变成可观测计数：解析器现在按追加处理是对的，
        // 但它依赖的是"站点对 content 用追加语义"这一实测约定。哪一天站点改回 SET 语义，
        // 这个计数会先动 —— 比事后发现"答案又丢头"早得多（本轮为定位它实抓了六次）。
        if (!one.o && /content$/.test(one.p) && typeof one.v === 'string') rec.noOpContentWrites++;
        if (/content|fragments/.test(one.p) && rec.contentOps.length < 40) {
          rec.contentOps.push({
            atOp: rec.opCount, p: one.p, o: one.o,
            v: typeof one.v === 'string' ? one.v.slice(0, 24) : JSON.stringify(one.v).slice(0, 140),
            vLen: typeof one.v === 'string' ? one.v.length : null,
          });
        }
        applyOp(rec.root, one);
        rec.opCount++;
      } else if (one.v && typeof one.v === 'object' && !Array.isArray(one.v)) {
        mergeDeep(rec.root, one.v);
        rec.opCount++;
      } else if (typeof one.v === 'string' && one.v) {
        // **到达即记账**：这片正文增量落到的是哪种片段。
        // 必须在应用那一刻记，不能事后看片段内容 —— content 会被后续结构帧整段覆盖
        // （mergeDeep 对字符串是直接赋值），被吞掉的头几个字到时候早已不留痕迹。
        // 用法：deltaByKind 与 frags 的 len 对不上，差值就是"落错片段"的字数。
        try {
          const frags = findFragmentArray(rec.root);
          const tail = frags && frags.length ? frags[frags.length - 1] : null;
          const kind = String((tail && (tail.type || tail.mimeType)) || '(无片段)').toUpperCase();
          rec.deltaByKind = rec.deltaByKind || {};
          rec.deltaByKind[kind] = (rec.deltaByKind[kind] || 0) + one.v.length;
          // 站点自己说"还有片段没下发"时，我们却只有思考片段可写 —— 这批字数就是修法判据：
          // 修法应当依这个标记切分，而不是在提取侧猜（猜过一次，错了）。
          const pending = !!(rec.root && rec.root.response && rec.root.response.has_pending_fragment);
          if (pending) {
            rec.pendingByKind = rec.pendingByKind || {};
            rec.pendingByKind[kind] = (rec.pendingByKind[kind] || 0) + one.v.length;
          }
        } catch { /* 记账失败不影响解析 */ }
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
        // 片段清单（类型 + 长度 + 首尾）：**判断"正文归没归对片段"的直接证据**。
        // 2026-09-21 实抓两例：页面 7 字我们回 4 字、页面 12 字我们回 11 字，丢的都在**开头**，
        // 且 THINK 片段紧挨在 RESPONSE 前面 —— 光看 markdownLength 分不清"没收到"还是
        // "收到了但塞进了 THINK、被 extractMarkdown 按类型过滤掉"，所以首尾都要给。
        frags: (() => {
          const frags = findFragmentArray(rec.root);
          if (!Array.isArray(frags)) return null;
          return frags.slice(0, 12).map((f) => ({
            kind: String((f && (f.type || f.mimeType)) || '').slice(0, 24),
            len: typeof f.content === 'string' ? f.content.length : -1,
            head: typeof f.content === 'string' ? f.content.slice(0, 24) : '',
            tail: typeof f.content === 'string' ? f.content.slice(-24) : '',
          }));
        })(),
        // 站点自己的"还有片段没下发"标记 + 思考态：答案头几个字疑似被前一个片段吞掉时，
        // 这两个字段决定修法是靠该标记切分，还是只能在 extractMarkdown 侧兜。
        pendingFragment: (rec.root && rec.root.response && rec.root.response.has_pending_fragment) ?? null,
        thinkingEnabled: (rec.root && rec.root.response && rec.root.response.thinking_enabled) ?? null,
        fragmentCount: (() => {
          const frags = findFragmentArray(rec.root);
          return Array.isArray(frags) ? frags.length : -1;
        })(),
        // 事件词表：站点协议的直接证据。"status 一直为空"时看这里就能判断
        // 是"没有命名事件"还是"事件名不在我们的终态词表里"。
        events: rec.events.slice(0, 20),
        // 帧形态统计与裸字符串样本：一次实跑就能定位"为什么没还原出正文"
        // （例如全是 jsonStringPlain 说明负载是被编码的字符串、我们暂不当正文）
        frames: rec.frames,
        rawTexts: rec.rawTexts.map((t) => String(t).slice(0, 200)),
        sample: rec.sample.slice(-1500),
        headSample: rec.head,
        // 思考→答案切换点的帧原文（含其前 5 帧）
        answerStart: rec.answerStart,
        // 到达即记账：每个片段类型收到过多少字的正文增量
        deltaByKind: rec.deltaByKind,
        pendingByKind: rec.pendingByKind,
        // 碰过 content/fragments 的路径操作逐帧原文（查 SET 覆盖类丢字的唯一硬证据）
        contentOps: rec.contentOps,
        noOpContentWrites: rec.noOpContentWrites,
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
