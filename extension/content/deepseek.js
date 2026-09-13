/**
 * DeepSeek 适配器（chat.deepseek.com）
 * 选择器于 2026-09 实测验证（与 Playwright 版 deepseek-web-mcp 同源）：
 * - 输入框：无 id 的 <textarea>（placeholder「给 DeepSeek 发送消息」）
 * - 回答块：.ds-markdown.ds-assistant-message-main-content
 * - 发送：优先点击圆形主色按钮，回退 Enter 键
 */
(() => {
  const { wire, sleep, normalizeText, readInputDefault } = window.__WEBAGENTS__;

  const ADAPTER = {
    site: 'deepseek',
    input: 'textarea',
    answer: '.ds-markdown.ds-assistant-message-main-content',
    // 思考态/生成中指示器（首反馈校验用，宽松策略待 probe 校准）：
    // 深度思考时出现思考内容块（.ds-think-*）；另有 common.js 跨站兜底（loading/停止按钮等）
    thinkingSel: ['.ds-think-content', '[class*="ds-think" i]'],

    /**
     * 对话选项开关（2026-09-13 Playwright 实测 DOM）：
     * - .ds-toggle-button 内含文本「深度思考」/「智能搜索」
     * - 激活态 = ds-toggle-button--selected 类
     * - options: { deepThink?: boolean, search?: boolean }，显式指定才切换
     */
    async setOptions(opts, _inputEl) {
      const want = [
        ['deepThink', /深度思考/],
        ['search', /智能搜索/],
      ];
      for (const [key, re] of want) {
        if (opts[key] === undefined) continue;
        const btn = [...document.querySelectorAll('.ds-toggle-button')].find((b) => re.test(b.innerText || ''));
        if (!btn) throw new Error(`未找到选项按钮: ${key}`);
        const isOn = btn.classList.contains('ds-toggle-button--selected');
        if (isOn !== !!opts[key]) {
          btn.click();
          await sleep(300);
        }
      }
    },

    /** 供 state 轮询回传当前开关状态（验证 setOptions 是否生效） */
    optionState() {
      const read = (re) => {
        const btn = [...document.querySelectorAll('.ds-toggle-button')].find((b) => re.test(b.innerText || ''));
        return btn ? btn.classList.contains('ds-toggle-button--selected') : null;
      };
      return { deepThink: read(/深度思考/), search: read(/智能搜索/) };
    },

    async send(inputEl) {
      // 2026-09-14 实测：站点把发送按钮从 <button> 改成 <div>，且单纯 div.click() 不触发其处理
      // （React onClick 对非受信 click 不响应或监听 pointer 事件）。策略：逐级尝试，每级 600ms
      // 内看输入框是否清空，未清空则降级下一级。历史实测 Enter 合成事件有效，故必有兜底。
      const cleared = () => !normalizeText(readInputDefault(inputEl));
      const btn =
        document.querySelector('#send-message-button') ||
        document.querySelector('.ds-button--primary.ds-button--circle');
      if (btn) {
        btn.click();
        await sleep(600);
        if (cleared()) return 'click';
        // pointer/mouse 完整序列
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          btn.dispatchEvent(t.startsWith('pointer')
            ? new PointerEvent(t, { bubbles: true, cancelable: true, view: window, pointerType: 'mouse' })
            : new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        }
        await sleep(600);
        if (cleared()) return 'click+pointer';
      }
      // 回退：聚焦后模拟 Enter
      inputEl.focus();
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(600);
      if (cleared()) return btn ? 'click-failed+enter' : 'enter';
      // 最后兜底：Enter + keypress 组合
      inputEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(600);
      if (cleared()) return 'enter+kp';
      return 'none';
    },
  };

  wire(ADAPTER);
})();
