/**
 * content script 公共层：消息接线 + 通用问答/探测逻辑
 * 各站点适配器只需提供 SELECTORS 与 send() 实现，调用 wire(ADAPTER) 即可。
 *
 * 分级 fail-fast（2026-09-13）：
 *   stage='inject'           注入后 ≤3s 读回编辑器内容比对（最多尝试 2 次）
 *   stage='send'             触发发送后 ≤5s 确认等价信号（输入框清空/用户气泡出现）
 *   stage='no_site_feedback' 由 background 轮询 state（feedback/blocks 生命信号）判定，≤12s
 * 每级失败立即以 {ok:false, stage, detail} 回传 background → server → MCP，绝不静默挂起。
 */
/* eslint-disable no-undef */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // =====================================================================
  // 主世界流探针桥接（2026-09-15）
  //
  // 背景：站点的"回复结束"是明确的（DeepSeek 有 MessageStatus 枚举 + 终态定义
  // `status !== 'WIP'`），但该状态只在网络响应流里，不写 DOM、不进控制台。
  // 主世界探针 content/stream-probe.js 负责拦流，这里负责接收与上报。
  //
  // 注意：隔离世界读不到主世界的全局变量，探针只能"自报身份"（world 字段）。
  // 若自报 isolated，说明 manifest 的 world:"MAIN" 未生效，上层必须放弃流信号。
  // =====================================================================
  const PROBE_SRC = 'webagents-probe';
  // 探针的"回复"走独立来源标记（它自己的监听器会忽略该来源，避免自问自答递归）
  const PROBE_REPLY_SRC = 'webagents-probe-reply';
  const pendingQueries = new Map();
  const pendingTexts = new Map();
  let probeInfo = { alive: false, world: null };   // 探针可达性与所处世界
  let lastStream = null;                            // 最近一次流记录（缓存，快速路径）
  let lastStreamsList = [];                         // 本页全部流的摘要（诊断用）
  /**
   * 已结束流的正文本地缓存（id → text）。
   * 探针在 stream-end 事件里就把正文带出来了，这里直接存下 ——
   * 上层取正文时无需再跨世界往返（那一跳曾经丢过，见 streamText 处理）。
   */
  const endedStreams = new Map();

  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d) return;
    // 通知类走 PROBE_SRC，回复类走 PROBE_REPLY_SRC，两者都要接收
    if (d.source !== PROBE_SRC && d.source !== PROBE_REPLY_SRC) return;
    switch (d.type) {
      case 'stream-start':
        lastStream = { id: d.id, url: d.url, startedAt: d.startedAt, endedAt: 0, status: null };
        break;
      case 'stream-tick':
        if (lastStream && lastStream.id === d.id && d.status) lastStream.status = d.status;
        break;
      case 'stream-end':
        lastStream = {
          id: d.id, url: lastStream && lastStream.url, startedAt: d.startedAt, endedAt: d.endedAt,
          status: d.status || null, opCount: d.opCount, markdownLength: d.markdownLength, reason: d.reason,
        };
        // 正文随事件带出，本地留档（最多 4 条，够本次问答与上一次回退）
        if (typeof d.text === 'string') {
          endedStreams.set(d.id, d.text);
          while (endedStreams.size > 4) endedStreams.delete(endedStreams.keys().next().value);
        }
        break;
      case 'stream-detail': {
        probeInfo = { alive: !!d.probeAlive, world: d.world || null };
        // 本页全部流的摘要：一次问答可能有多条流（风控预审 + 正式作答），
        // 只看"最新一条"会误判成"没有作答流"（2026-09-15 千问取证踩过）。
        if (Array.isArray(d.streams)) lastStreamsList = d.streams;
        const resolve = pendingQueries.get(d.id);
        if (resolve) { pendingQueries.delete(d.id); resolve(d.data || null); }
        if (d.data) lastStream = d.data;
        break;
      }
      case 'stream-text': {
        const resolve = pendingTexts.get(d.id);
        if (resolve) { pendingTexts.delete(d.id); resolve(d.text || ''); }
        break;
      }
      default:
        break;
    }
  });

  /**
   * 向主世界探针要一次当前流记录。
   * since：只接受该时间戳之后开始的流 —— 每次 ask 前由调用方给定，
   * 避免把上一次问答遗留的流误当成本次的完成信号。
   * 超时即视为探针不可用，上层自动退回 DOM 判定。
   */
  function queryStream(since, timeoutMs = 200) {
    const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pendingQueries.delete(id); resolve(null); }, timeoutMs);
      pendingQueries.set(id, (data) => { clearTimeout(timer); resolve(data); });
      try {
        window.postMessage({ source: PROBE_SRC, type: 'stream-query', id, since: since || 0 }, '*');
      } catch {
        clearTimeout(timer);
        pendingQueries.delete(id);
        resolve(null);
      }
    });
  }

  /** 取探针还原出的原始 markdown 正文（只在需要时调用一次，避免轮询期反复搬运大字符串） */
  function queryStreamText(since, timeoutMs = 1200, streamId = null) {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pendingTexts.delete(id); resolve(''); }, timeoutMs);
      pendingTexts.set(id, (text) => { clearTimeout(timer); resolve(text || ''); });
      try {
        window.postMessage({ source: PROBE_SRC, type: 'stream-text', id, since: since || 0, streamId }, '*');
      } catch {
        clearTimeout(timer);
        pendingTexts.delete(id);
        resolve('');
      }
    });
  }

  /** React 受控 textarea 需要 native setter 才能让框架感知 value 变化 */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 通用注入：textarea/input 走 native setter，contenteditable 走 execCommand */
  function setInputValue(el, text) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      setNativeValue(el, text);
      return;
    }
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  }

  /**
   * 回答状态读取：按 answerList 候选顺序取第一个有内容的容器
   * （不同站点/改版的选择器差异在此吸收）
   */
  function answerState(ADAPTER) {
    for (const sel of ADAPTER.answerList || [ADAPTER.answer]) {
      const blocks = document.querySelectorAll(sel);
      if (blocks.length) {
        const last = blocks[blocks.length - 1];
        // 优先用 DOM→markdown 序列化器拿**结构化正文**（表格还原成管道表、代码块还原成围栏），
        // innerText 只作兜底 —— 它会把工具栏文字混进来、把表格和代码的结构丢掉。
        const DM = window.__WEBAGENTS_DOMMD__;
        let text = '';
        let viaMd = false;
        if (DM && typeof DM.toMarkdown === 'function') {
          try { text = String(DM.toMarkdown(last, { maxLen: 200000 }) || '').trim(); } catch { text = ''; }
          if (text) viaMd = true;
        }
        if (!text) text = (last.innerText || '').trim();
        if (text) return { count: blocks.length, text, sel, viaMd };
      }
    }
    return { count: 0, text: '', sel: null, viaMd: false };
  }
  async function waitFor(selector, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) return el;
      await sleep(300);
    }
    throw new Error(`等待元素超时: ${selector}`);
  }

  /** 归一化：去零宽字符与首尾空白（注入读回比对用） */
  function normalizeText(s) {
    return String(s || '').replace(/[\u200B\u200C\u200D\uFEFF]/g, '').trim();
  }

  /**
   * 空白不敏感比较形（2026-09-14 P3a 修复）：在 normalizeText 基础上再剥除全部空白。
   * 根因：读回与预期肉眼一致仍判不等——Lexical/ProseMirror 类编辑器回显时会调整
   * 内部空白（换行↔段落间距、连续空格折叠），逐字严格相等把等价内容误判为注入失败。
   * 注入校验只关心「文本进了编辑器」，空白形态差异不算差异。
   */
  function squashText(s) {
    return normalizeText(s).replace(/\s+/g, '');
  }

  /** 读回编辑器当前内容：textarea/input 读 value，contenteditable 读 innerText */
  function readInputDefault(el) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value || '';
    return el.innerText || '';
  }

  /** 时限内轮询断言，成立返回 true（fail-fast 校验用） */
  async function verifyWithin(timeoutMs, fn, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let v = false;
      try { v = (await fn()) === true; } catch { v = false; }
      if (v) return true;
      if (Date.now() >= deadline) return false;
      await sleep(stepMs);
    }
  }

  /**
   * 发送成功等价信号（2026-09-14 修订 2）：
   * 1) 输入框已清空（textarea 站点最可靠信号；textarea.value 不计入 body.innerText）
   * 2) 页面正文出现以 prompt 开头的文本（气泡；不依赖类名，兼容哈希类名站点）
   * 注意：发送成功后站点 SPA 跳转会话页会重挂 textarea，必须实时重查活的输入框，
   * 不能用 ask 时捕获的旧引用（游离节点的 value 仍含全文，会造成"假失败"误报）。
   */
  function verifySentDefault(inputEl, prompt) {
    const live = document.querySelector('textarea, [contenteditable="true"]') || inputEl;
    const inBox = normalizeText(readInputDefault(live));
    if (!inBox) return true;
    const head = normalizeText(prompt).slice(0, 30);
    if (!head) return false;
    if (inBox.includes(head)) return false;
    try { return (document.body.innerText || '').includes(head); } catch { return false; }
  }

  /** 回答区原始块数（含未出文本的块），供「新增节点」式生命信号比对 */
  function blockCount(ADAPTER) {
    for (const sel of ADAPTER.answerList || [ADAPTER.answer]) {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch { /* 选择器非法忽略 */ }
      if (n) return n;
    }
    return 0;
  }

  /**
   * 风控挑战（滑块/验证）检测 —— 见方案 A。
   *
   * 为什么必须做：站点标签页是**后台标签**（`active:false`），挑战弹在用户完全看不见的地方。
   * 于是现象不是"请你划一下"，而是"任务无声卡死到超时"。检测到之后由 SW 把标签页切到前台，
   * 用户验证完任务自动继续。
   *
   * 判定策略：**只认"看起来确实是挑战组件"**（可见 + 尺寸合理），
   * 单独加载风控 SDK 不算 —— SDK 每次页面加载都在（千问是阿里霸下，域 sec.qianwen.com），
   * 把它当挑战会误伤每一次正常问答。误判的代价是打断正常任务，所以宁可漏报。
   */
  const RISK_SDK_HOST = /(^|\.)(sec|pre-sec)\.(qianwen|qwen)\.com$/i;
  const CHALLENGE_SEL = [
    '[id*="nc_" i]', '[class*="nc_" i]', '[id*="nocaptcha" i]', '[class*="nocaptcha" i]',
    '[id*="captcha" i]', '[class*="captcha" i]', '[id*="baxia" i]',
    '[class*="slide-verify" i]', '[class*="slider-verify" i]', '[class*="verify-wrap" i]',
    '[class*="verifyWrap"]', '[class*="drag-verify" i]',
  ].join(',');

  function challengeVisible(el) {
    try {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 24) return false;      // 挑战条不会这么小
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
    } catch { return false; }
  }

  let challengeCache = { at: 0, value: null };

  function detectChallenge() {
    const now = Date.now();
    // 节流 1.5s：state 每 600ms 轮询一次，不必每次都全量扫 DOM
    if (now - challengeCache.at < 1500) return challengeCache.value;

    let sdk = false;
    let ui = 0;
    let sel = '';
    try {
      for (const el of document.querySelectorAll('script[src], iframe[src], link[href]')) {
        const u = el.src || el.href || '';
        if (!u) continue;
        try {
          if (RISK_SDK_HOST.test(new URL(u, location.href).host)) { sdk = true; break; }
        } catch { /* 相对/非法 URL 忽略 */ }
      }
    } catch { /* 忽略 */ }
    try {
      for (const el of document.querySelectorAll(CHALLENGE_SEL)) {
        if (challengeVisible(el)) { ui++; if (!sel) sel = el.className ? `.${String(el.className).split(/\s+/)[0]}` : el.tagName.toLowerCase(); }
      }
    } catch { /* 选择器非法忽略 */ }

    // 只有"可见的挑战 UI"才算 present；SDK 已加载仅作为上下文如实上报
    const value = (ui > 0 || sdk) ? { present: ui > 0, ui, sdk, sel: sel || null } : null;
    challengeCache = { at: now, value };
    return value;
  }

  /** 思考态/生成中指示器：适配器 thinkingSel 优先，另附跨站宽松兜底 */
  const FEEDBACK_FALLBACK_SEL = [
    '[class*="thinking" i]', '[class*="loading" i]', '[class*="spinner" i]',
    '[class*="generating" i]', '[aria-label*="停止"]', '[aria-label*="stop" i]',
  ];
  function siteFeedback(ADAPTER) {
    for (const sel of [...(ADAPTER.thinkingSel || []), ...FEEDBACK_FALLBACK_SEL]) {
      let els = [];
      try { els = document.querySelectorAll(sel); } catch { continue; }
      for (const el of els) {
        if (el.offsetParent !== null || el.getClientRects().length > 0) return sel;
      }
    }
    return null;
  }

  /**
   * DOM 级完成标记（站点可选配置 ADAPTER.completeMarker = { sel, done }）。
   * 取标记元素的**最后一个**（多轮对话时最新一条回答才算数）：
   *   true  = done 正则命中（已完成）
   *   false = 标记元素存在但未命中（仍在生成）
   *   null  = 站点未配置 / 页面上找不到标记元素（此时上层按"无标记"处理，不参与判定）
   */
  function completionState(ADAPTER) {
    const cm = ADAPTER && ADAPTER.completeMarker;
    if (!cm || !cm.sel || !cm.done) return null;
    let els = [];
    try { els = document.querySelectorAll(cm.sel); } catch { return null; }
    if (!els.length) return null;
    return cm.done.test(String(els[els.length - 1].className || '')) ? true : false;
  }

  /** DOM 探测：站点改版时用于修正选择器 */
  function probe() {
    const out = { url: location.href, textareas: [], editables: [], markdownish: [], sendCandidates: [], toggles: [] };
    document.querySelectorAll('textarea, input[type="text"]').forEach((el) => {
      out.textareas.push({
        tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 120),
        placeholder: el.placeholder || '', visible: !!el.offsetParent,
      });
    });
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      out.editables.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 120), visible: !!el.offsetParent });
    });
    document.querySelectorAll('[class*="markdown" i], [class*="answer" i]').forEach((el) => {
      const text = (el.innerText || '').trim();
      if (text) out.markdownish.push({ tag: el.tagName, cls: String(el.className).slice(0, 140), text: text.slice(0, 100), visible: !!el.offsetParent });
    });
    // 回答块 HTML 头尾：结构问题（行号/工具栏/卡片标题混入正文）一次看穿。仅诊断用。
    // 头部看根节点类名（完成标记），尾部看代码块结构（表格卡片在前、代码在后，SVG 很占字符）。
    try {
      const mdEls = document.querySelectorAll('[class*="markdown" i], [class*="answer" i]');
      const lastMd = mdEls[mdEls.length - 1];
      if (lastMd) {
        const html = String(lastMd.outerHTML || '');
        out.answerHtml = html.length <= 3400
          ? html
          : html.slice(0, 600) + '\n...[snip]...\n' + html.slice(-2800);
      }
    } catch { /* 忽略 */ }
    document.querySelectorAll('button, [role="button"]').forEach((el) => {
      const cls = String(el.className);
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      if (/send|发送/i.test(cls) || /send|发送/i.test(label)) {
        out.sendCandidates.push({ tag: el.tagName, id: el.id, cls: cls.slice(0, 120), label });
      }
    });
    // 输入栏按钮全量清单（哈希类名站点 send/发送 标记缺失时用）：纵向距输入框 180px 内的可见按钮
    const anchor = document.querySelector('textarea, [contenteditable="true"]');
    if (anchor) {
      const ay = anchor.getBoundingClientRect().y;
      out.barButtons = [];
      document.querySelectorAll('button, [role="button"]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        if (Math.abs(r.y - ay) > 180) return;
        if (!(el.offsetParent !== null || el.getClientRects().length > 0)) return;
        out.barButtons.push({
          tag: el.tagName, id: el.id || '', cls: String(el.className).slice(0, 100),
          label: el.getAttribute('aria-label') || el.getAttribute('title') || '',
          text: (el.innerText || '').trim().slice(0, 16), svg: !!el.querySelector('svg'),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(r.x), y: Math.round(r.y),
        });
      });
      out.barButtons.sort((a, b) => b.x - a.x);
    }
    // 选项开关：按叶子节点文本全量扫描（不限标签/role，覆盖裸 DIV 开关）
    const seen = new Set();
    document.querySelectorAll('body *').forEach((el) => {
      if (el.childElementCount > 0) return;
      const text = (el.innerText || '').trim();
      if (!text || text.length > 12) return;
      if (!/^(深度思考|联网搜索|R1|搜索|思考|研究|快速|深度|联网|think|search|research)/i.test(text)) return;
      const p = el.parentElement;
      if (!p) return;
      const key = `${text}|${p.tagName}.${String(p.className).slice(0, 40)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const chain = [];
      let node = el;
      for (let i = 0; i < 4 && node && node !== document.body; i++) {
        chain.push(`${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}.${String(node.className).slice(0, 60)}`);
        node = node.parentElement;
      }
      out.toggles.push({
        text,
        role: el.closest('[role]')?.getAttribute('role') || '',
        ariaPressed: el.closest('[aria-pressed]')?.getAttribute('aria-pressed') || '',
        visible: !!el.offsetParent,
        chain,
      });
    });
    return out;
  }

  function wire(ADAPTER) {
    // 防 manifest 声明注入 + 程序化 executeScript 补注入导致监听器重复注册（'ask' 会被处理两次）
    if (window.__WEBAGENTS_WIRED__) return;
    window.__WEBAGENTS_WIRED__ = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        if (msg.type === 'ping') {
          sendResponse({ ready: true, site: ADAPTER.site, url: location.href });
          return;
        }
        if (msg.type === 'probe') {
          // 标准探测为主体，debugMenu 合并附加（不再整体顶掉标准输出）
          const data = probe();
          if (ADAPTER.debugMenu) data.debugMenu = await ADAPTER.debugMenu();
          // 流探针诊断：确认探针是否在主世界、能否看到流、字段长什么样
          data.stream = {
            probeAlive: probeInfo.alive,
            probeWorld: probeInfo.world,
            last: await queryStream(msg.since || 0, 800),
          };
          // 顺带带上风控挑战检测：现场取证时最关心的就是"是不是被验证拦住了"
          data.challenge = detectChallenge();
          sendResponse({ ok: true, data });
          return;
        }
        if (msg.type === 'ask') {
          // 分级校验：inject（读回比对 ≤3s×2 次）→ send（等价信号 ≤5s）；每级失败立即回传，绝不静默重试
          let stage = 'inject';
          try {
            let input;
            try {
              input = await waitFor(ADAPTER.input, 2500);
            } catch {
              sendResponse({ ok: false, stage: 'inject', detail: `未找到输入框（${ADAPTER.input}），页面可能未加载完成或未登录` });
              return;
            }
            if (msg.options && ADAPTER.setOptions) {
              stage = 'options';
              await ADAPTER.setOptions(msg.options, input);
              stage = 'inject';
            }
            const readBack = () => normalizeText(ADAPTER.readInput ? ADAPTER.readInput(input) : readInputDefault(input));
            const want = squashText(msg.prompt);
            let injected = false;
            let injectDetail = '';
            for (let attempt = 1; attempt <= 2 && !injected; attempt++) {
              await (ADAPTER.setValue ? ADAPTER.setValue(input, msg.prompt) : setInputValue(input, msg.prompt));
              // 注入校验：空白不敏感比较（P3a 收尾，2026-09-15）。根因实测：Lexical 回显会展开空行
              // （「。\n\n【」读回「。\n\n\n\n\n【」），squashText 修复函数此前已定义但未接线到本比较，
              // 严格相等把多空行长 prompt 误判为注入失败（单行 prompt 不受影响，故回归未暴露）。
              if (await verifyWithin(3000, () => squashText(readBack()) === want)) { injected = true; break; }
              injectDetail = `读回「${readBack().slice(0, 80) || '(空)'}」≠ 预期「${want.slice(0, 80)}」`;
            }
            if (!injected) {
              sendResponse({ ok: false, stage: 'inject', detail: `注入校验失败（已尝试 2 次）：${injectDetail}` });
              return;
            }
            stage = 'send';
            const how = await ADAPTER.send(input);
            // 发送验证窗口 25s（2026-09-15 P3b 试点实测）：长 prompt 注入后站点导航/清空明显变慢，
            // 8s 窗口频繁误报失败（消息实际已发出）；25s 覆盖慢速会话创建。
            const sentOk = await verifyWithin(25000, () =>
              (ADAPTER.verifySent ? ADAPTER.verifySent(input, msg.prompt) : verifySentDefault(input, msg.prompt)));
            if (!sentOk) {
              const still = normalizeText(readInputDefault(input)).slice(0, 40) || '(空)';
              sendResponse({ ok: false, stage: 'send', detail: `发送动作(${how})后 25s 未见发送信号，输入框残留「${still}」` });
              return;
            }
            // 回传首反馈判定基线：发送完成瞬间的回答块数与思考态指示器
            sendResponse({ ok: true, sent: how, baseBlocks: blockCount(ADAPTER), baseFeedback: siteFeedback(ADAPTER) });
          } catch (err) {
            sendResponse({ ok: false, stage, detail: err.message });
          }
          return;
        }
        if (msg.type === 'state') {
          const st = answerState(ADAPTER);
          // 流状态：优先取缓存（快路径），否则主动问一次探针。
          // 200ms 上限远小于 SW 600ms 轮询周期，不会拖慢判定节奏。
          let stream = lastStream;
          if (!stream || stream.startedAt < (msg.since || 0)) {
            stream = await queryStream(msg.since || 0, 200) || stream;
          }
          sendResponse({
            ok: true, url: location.href, count: st.count, text: st.text, sel: st.sel,
            viaMd: !!st.viaMd,   // 正文来自 DOM→markdown 序列化（而非 innerText）
            blocks: blockCount(ADAPTER),
            feedback: siteFeedback(ADAPTER),
            // DOM 级完成标记（如千问的 qk-markdown-complete）：
            //   true=已完成 / false=标记元素在但未完成（仍在生成）/ null=站点无标记或不适用
            complete: completionState(ADAPTER),
            // 风控挑战（滑块等）检测结果：present=true 时上层会把标签页切到前台并等待人工完成
            challenge: detectChallenge(),
            options: ADAPTER.optionState ? ADAPTER.optionState() : null,
            // 探针健康度：即使当前没有流记录，也能知道探针是否可用
            streamProbe: { alive: probeInfo.alive, world: probeInfo.world },
            // stream: null=探针不可用（上层退回 DOM 判定）
            //    endedAt>0 = 服务端已关闭响应流（协议级硬信号）
            //    status    = 站点自报终态（FINISHED / INCOMPLETE / TIMEOUT / ...）
            // 正文不在此处下发（每次轮询都传 200KB 太浪费），需要时用 streamText 单独取
            stream: stream ? {
              id: stream.id,
              probeWorld: probeInfo.world,
              startedAt: stream.startedAt,
              endedAt: stream.endedAt || 0,
              status: stream.status || null,
              opCount: stream.opCount || 0,
              url: stream.url || '',
              markdownLength: stream.markdownLength || 0,
            } : null,
          });
          return;
        }

        if (msg.type === 'streamText') {
          // 取探针还原出的原始 markdown（仅在流已结束后由上层按需调用一次）
          // 路径一：本地缓存（探针在 stream-end 时已把正文带出）—— 不跨世界往返，最可靠
          if (msg.streamId && endedStreams.has(msg.streamId)) {
            sendResponse({
              ok: true, via: 'cache',
              text: endedStreams.get(msg.streamId) || '',
              probeWorld: probeInfo.world,
            });
            return;
          }
          // 路径二：回退到向探针查询（streamId 指定具体哪条流，避免只按"最新"取而张冠李戴）
          const text = await queryStreamText(msg.since || 0, msg.timeoutMs || 1200, msg.streamId || null);
          sendResponse({ ok: true, via: 'probe', text: text || '', probeWorld: probeInfo.world });
          return;
        }

        if (msg.type === 'streamDiag') {
          // 诊断：仅在"流信号不可用/正文还原失败"时由上层调用。
          // 必须当次采集 —— 问答结束后标签页会被导回首页（整页重载），
          // 探针记录随之清空，事后无法再查。
          const data = await queryStream(msg.since || 0, msg.timeoutMs || 1200);
          const st = answerState(ADAPTER);
          let bodyHead = '';
          try { bodyHead = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300); } catch { /* 忽略 */ }
          sendResponse({
            ok: true,
            probeWorld: probeInfo.world,
            probeAlive: probeInfo.alive,
            data: data ? {
              url: data.url, contentType: data.contentType, status: data.status,
              opCount: data.opCount, markdownLength: data.markdownLength,
              rootKeys: data.rootKeys, responseKeys: data.responseKeys,
              events: data.events,
              // 帧形态统计 + 裸字符串样本：定位"为什么没还原出正文"的关键证据。
              // 样本给到 1200 字符 —— 300 字符只够看到遥测头部，看不出正文形态（踩过）。
              frames: data.frames,
              rawTexts: data.rawTexts,
              sampleHead: String(data.sample || '').slice(0, 1200),
            } : null,
            // 本页全部流的摘要：判断"作答流到底有没有被抓到"的决定性证据
            streams: lastStreamsList,
            // 完成标记与生成指示器当次状态：判断"门控是否生效"的直接证据
            complete: completionState(ADAPTER),
            feedback: siteFeedback(ADAPTER),
            dom: {
              url: location.href,
              count: st.count, sel: st.sel,
              textLen: (st.text || '').length,
              textHead: (st.text || '').slice(0, 200),
              blocks: blockCount(ADAPTER),
              bodyHead,
            },
          });
          return;
        }
      })();
      return true; // 保持消息通道开启（异步 sendResponse）
    });
  }

  window.__WEBAGENTS__ = { wire, sleep, waitFor, setNativeValue, setInputValue, probe, answerState, normalizeText, squashText, readInputDefault, queryStream, queryStreamText };
})();
