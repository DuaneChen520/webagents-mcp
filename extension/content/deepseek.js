/**
 * DeepSeek 适配器（chat.deepseek.com）
 * 选择器于 2026-09 实测验证（与 Playwright 版 deepseek-web-mcp 同源）：
 * - 输入框：无 id 的 <textarea>（placeholder「给 DeepSeek 发送消息」）
 * - 回答块：.ds-markdown.ds-assistant-message-main-content
 * - 发送：优先点击圆形主色按钮，回退 Enter 键
 */
(() => {
  const { wire, setNativeValue, sleep } = window.__WEBAGENTS__;

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
      // 优先点击发送按钮（主色圆形；2026-09-14 probe 实测已从 <button> 变为 <div>，故不加标签限定）
      const btn =
        document.querySelector('#send-message-button') ||
        document.querySelector('.ds-button--primary.ds-button--circle');
      if (btn) {
        btn.click();
        return 'click:' + String(btn.className).slice(0, 60);
      }
      // 回退：聚焦后模拟 Enter（部分站点仅响应聚焦目标上的按键）
      inputEl.focus();
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return 'enter';
    },
  };

  wire(ADAPTER);
})();
