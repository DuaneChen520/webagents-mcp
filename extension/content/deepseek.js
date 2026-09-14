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
      // 两级发送（剪枝定稿）：click+pointer 为主，Enter 唯一回退；每级 600ms 内以
      // 「实时重查活输入框已清空」为生效判据（ask 后 SPA 会重挂 textarea，禁止用旧引用判断）
      const cleared = () => {
        const live = document.querySelector('textarea, [contenteditable="true"]') || inputEl;
        return !normalizeText(readInputDefault(live));
      };
      // 2026-09-15 取证：旧的主选择器 #send-message-button 已从线上产物中移除
      // （CSS/JS 均 0 命中），实际一直靠下面的回退选择器在工作，故删掉死选择器。
      // 另注：发送与"停止生成"是同一个 DOM 元素，只是生成期间行为不同 —— 因此
      // 不能靠"按钮消失"判断答完，完成判定走流探针（见 content/stream-probe.js）。
      const btn = document.querySelector('.ds-button--primary.ds-button--circle');
      if (btn) {
        btn.click();
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          btn.dispatchEvent(t.startsWith('pointer')
            ? new PointerEvent(t, { bubbles: true, cancelable: true, view: window, pointerType: 'mouse' })
            : new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        }
        await sleep(600);
        if (cleared()) return 'click';
      }
      inputEl.focus();
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(600);
      return cleared() ? (btn ? 'click-failed+enter' : 'enter') : 'none';
    },
  };

  wire(ADAPTER);
})();
