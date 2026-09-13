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
        const text = (last.innerText || '').trim();
        if (text) return { count: blocks.length, text, sel };
      }
    }
    return { count: 0, text: '', sel: null };
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
          sendResponse({ ok: true, data: ADAPTER.debugMenu ? await ADAPTER.debugMenu() : probe() });
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
            const want = normalizeText(msg.prompt);
            let injected = false;
            let injectDetail = '';
            for (let attempt = 1; attempt <= 2 && !injected; attempt++) {
              await (ADAPTER.setValue ? ADAPTER.setValue(input, msg.prompt) : setInputValue(input, msg.prompt));
              // 注入校验：读回编辑器内容与预期一致（3s 内确认，编辑器回显可能略滞后）
              if (await verifyWithin(3000, () => readBack() === want)) { injected = true; break; }
              injectDetail = `读回「${readBack().slice(0, 80) || '(空)'}」≠ 预期「${want.slice(0, 80)}」`;
            }
            if (!injected) {
              sendResponse({ ok: false, stage: 'inject', detail: `注入校验失败（已尝试 2 次）：${injectDetail}` });
              return;
            }
            stage = 'send';
            const how = await ADAPTER.send(input);
            const sentOk = await verifyWithin(8000, () =>
              (ADAPTER.verifySent ? ADAPTER.verifySent(input, msg.prompt) : verifySentDefault(input, msg.prompt)));
            if (!sentOk) {
              const still = normalizeText(readInputDefault(input)).slice(0, 40) || '(空)';
              sendResponse({ ok: false, stage: 'send', detail: `发送动作(${how})后 8s 未见发送信号，输入框残留「${still}」` });
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
          sendResponse({
            ok: true, url: location.href, count: st.count, text: st.text, sel: st.sel,
            blocks: blockCount(ADAPTER),
            feedback: siteFeedback(ADAPTER),
            options: ADAPTER.optionState ? ADAPTER.optionState() : null,
          });
          return;
        }
      })();
      return true; // 保持消息通道开启（异步 sendResponse）
    });
  }

  window.__WEBAGENTS__ = { wire, sleep, waitFor, setNativeValue, setInputValue, probe, answerState, normalizeText, readInputDefault };
})();
