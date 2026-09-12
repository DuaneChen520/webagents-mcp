/**
 * content script 公共层：消息接线 + 通用问答/探测逻辑
 * 各站点适配器只需提供 SELECTORS 与 send() 实现，调用 wire(ADAPTER) 即可。
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
          // 立即返回：不做长等待（页面可能整页跳转，长等待必须在 SW 侧轮询）
          try {
            const input = await waitFor(ADAPTER.input);
            if (msg.options && ADAPTER.setOptions) await ADAPTER.setOptions(msg.options, input);
            await (ADAPTER.setValue ? ADAPTER.setValue(input, msg.prompt) : setInputValue(input, msg.prompt));
            const how = await ADAPTER.send(input);
            sendResponse({ ok: true, sent: how });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
          return;
        }
        if (msg.type === 'state') {
          const st = answerState(ADAPTER);
          sendResponse({
            ok: true, url: location.href, count: st.count, text: st.text, sel: st.sel,
            options: ADAPTER.optionState ? ADAPTER.optionState() : null,
          });
          return;
        }
      })();
      return true; // 保持消息通道开启（异步 sendResponse）
    });
  }

  window.__WEBAGENTS__ = { wire, sleep, waitFor, setNativeValue, setInputValue, probe, answerState };
})();
