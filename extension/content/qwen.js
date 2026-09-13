/**
 * 通义千问适配器（www.qianwen.com）
 * 2026-09-13 probe 实测：
 * - 输入框：contenteditable DIV（Tailwind 样式，无 id）
 * - 发送按钮：BUTTON[aria-label="发送消息"]（圆形，size-8）
 * - 回答区：answerList 候选列表，首次成功后建议用 probe 校准为精确选择器
 */
(() => {
  const { wire, sleep } = window.__WEBAGENTS__;

  const ADAPTER = {
    site: 'qwen',
    input: '[contenteditable="true"]',
    answerList: [
      '.markdown-body',
      '[class*="markdown"]',
      '[class*="answer-content"]',
      '[class*="msg-content"]',
      '[class*="answer"] [class*="content"]',
    ],
    // 思考态/生成中指示器（首反馈校验用，宽松策略待 probe 校准）：
    // 思考模式出现「思考中」指示/思考内容块；另有 common.js 跨站兜底（loading/停止按钮等）
    thinkingSel: ['[class*="think" i]'],

    /**
     * 对话模式切换（2026-09-13 二次 probe 实测 DOM）：
     * - 当前模式显示在 radix 下拉触发按钮上（button#radix-…，text=快速/思考/研究）
     * - 「思考」等选项在点击触发按钮后弹出的 radix 菜单里（[data-radix-popper-content-wrapper]）
     * - 「研究」另有独立按钮可直接点
     * - opacity-0 隐藏副本需排除
     * - options: { mode?: "fast" | "think" | "research" }
     */
    async setOptions(opts, _inputEl) {
      if (!opts.mode) return;
      // 2026-09-13 用户确认：下拉菜单里只有两项——「快速」和「思考研究」
      const LABEL = { fast: '快速', think: '思考研究', research: '思考研究' };
      const target = LABEL[opts.mode];
      if (!target) throw new Error(`未知模式: ${opts.mode}（应为 fast|think|research）`);

      const badAncestor = (n) => {
        while (n && n !== document.body) {
          const cls = String(n.className);
          if (cls.includes('opacity-0') || cls.includes('pointer-events-none')) return true;
          n = n.parentElement;
        }
        return false;
      };
      const txt = (el) => (el.innerText || '').trim();
      const modeRe = /^(快速|思考研究|思考|深度思考|研究)$/;

      const findTrigger = () => {
        for (const b of document.querySelectorAll('button')) {
          if (!b.offsetParent || badAncestor(b)) continue;
          if (!modeRe.test(txt(b))) continue;
          if (b.id.startsWith('radix-') || b.getAttribute('aria-haspopup') || b.getAttribute('aria-expanded') !== null) return b;
        }
        return null;
      };

      const isMode = (t) => t === target || (target === '思考研究' && /思考/.test(t));
      const trig = findTrigger();
      if (!trig) throw new Error('未找到模式触发按钮（radix 下拉）');
      if (isMode(txt(trig))) {
        return `已是${txt(trig)}`; // 无需切换
      }

      // 打开下拉菜单（radix 可能需要完整鼠标事件序列）
      const fireMouse = (el) => {
        const r = el.getBoundingClientRect();
        const base = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        for (const t of ['pointerover', 'pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, base));
        }
      };
      fireMouse(trig);
      await sleep(600);

      // 在菜单容器里找目标项：叶子文本 → 逐候选（叶子/父级/最近容器）点击并验证
      const wrapper = document.querySelector('[data-radix-popper-content-wrapper]');
      const scope = wrapper || document;
      const matches = [...scope.querySelectorAll('*')]
        .filter((el) => el !== trig && el.offsetParent && !badAncestor(el))
        .filter((el) => {
          const t = txt(el);
          return t === target || (target === '思考研究' && /思考/.test(t) && t.length <= 10);
        });
      // 候选顺序：精确匹配叶子优先，然后其父级、最近的容器类祖先
      matches.sort((a, b) => (txt(a) === target ? -1 : 1) - (txt(b) === target ? -1 : 1) || txt(a).length - txt(b).length);
      const leaf = matches[0];
      if (!leaf) {
        const menuText = wrapper ? txt(wrapper).slice(0, 120) : '（菜单容器未出现，触发点击可能未生效）';
        throw new Error(`模式切换失败：菜单中没有「${target}」；菜单内容: ${menuText}`);
      }
      const checkMode = async () => {
        const t = findTrigger();
        return !!(t && isMode(txt(t)));
      };
      let done = false;
      // 菜单打开状态确认
      if (!document.querySelector('[data-radix-popper-content-wrapper]')) {
        fireMouse(trig);
        await sleep(600);
      }
      // 实测结论（2026-09-13 内置浏览器验证）：菜单项是 DIV[role="menuitemcheckbox"]，
      // 对命中项直接 el.click() 即可切换（与 Radix 官方 demo 一致），无需 CDP/键盘导航。
      const boxHit = () => {
        const m = document.querySelector('[data-radix-popper-content-wrapper]');
        if (!m) return null;
        const boxes = [...m.querySelectorAll('[role="menuitemcheckbox"], [role="menuitemradio"], [role="menuitem"]')];
        return boxes.find((el) => isMode(txt(el).split('\n')[0])) || null;
      };
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        const hit = boxHit();
        if (hit) {
          hit.click();
          await sleep(1000);
          done = await checkMode();
        }
        if (!done) {
          if (!document.querySelector('[data-radix-popper-content-wrapper]')) {
            fireMouse(trig); // 菜单已关闭，重开
            await sleep(600);
          }
        }
      }
      // 关闭可能仍开着的菜单（Esc 兜底，派发到菜单元素）
      if (!done) {
        const menuRoot = document.querySelector('[data-radix-popper-content-wrapper]') || trig;
        menuRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      }

      // 验证（不抛错：站点可能因当前模型不支持该模式而拒绝，如「Qwen3.8-Max 不支持思考研究」）
      const after = findTrigger();
      const state = after ? txt(after) : '未知';
      if (!isMode(state)) {
        return `警告：模式未切换（仍为「${state}」），当前模型可能不支持「${target}」`;
      }
      return `已切换为${state}`;
    },

    /**
     * 菜单深度诊断（probe 调用）：真实打开菜单并逐步记录焦点/事件行为
     */
    async debugMenu() {
      const out = { steps: [] };
      const log = (s, d) => out.steps.push({ step: s, ...d });
      const txt = (el) => (el && el.innerText || '').trim();

      // 找触发按钮
      const modeRe = /^(快速|思考研究|思考|深度思考|研究)$/;
      let trig = null;
      for (const b of document.querySelectorAll('button')) {
        if (!b.offsetParent) continue;
        if (!modeRe.test(txt(b))) continue;
        if (b.id.startsWith('radix-') || b.getAttribute('aria-haspopup') || b.getAttribute('aria-expanded') !== null) { trig = b; break; }
      }
      if (!trig) return { error: '未找到模式触发按钮' };
      log('触发按钮', { text: txt(trig), id: trig.id, expanded: trig.getAttribute('aria-expanded') });

      const wrapper = () => document.querySelector('[data-radix-popper-content-wrapper]');
      const menu = () => wrapper() && (wrapper().querySelector('[role="menu"]') || wrapper());
      const describe = (el) => el ? {
        tag: el.tagName, role: el.getAttribute && el.getAttribute('role'),
        text: txt(el).slice(0, 20),
        inWrapper: !!el.closest('[data-radix-popper-content-wrapper]'),
      } : null;

      // 事件监听探针（捕获阶段，记录 keydown 实际到达的元素）
      const seen = [];
      const spy = (e) => seen.push({ key: e.key, target: describe(e.target), isTrusted: e.isTrusted });
      document.addEventListener('keydown', spy, true);

      try {
        // 完整鼠标序列打开菜单
        const r = trig.getBoundingClientRect();
        const base = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          trig.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, base));
        }
        await new Promise((res) => setTimeout(res, 700));
        log('打开菜单', { wrapper: !!wrapper(), menuRole: menu() && menu().getAttribute('role'), expanded: trig.getAttribute('aria-expanded') });

        const items = menu() ? [...menu().querySelectorAll('*')].filter((el) => el.children.length === 0 && txt(el)) : [];
        log('菜单项', { count: items.length, items: items.slice(0, 8).map((el) => ({ tag: el.tagName, role: el.getAttribute('role'), text: txt(el).slice(0, 12) })) });

        // ArrowDown × 3，逐步记录焦点
        for (let i = 1; i <= 3; i++) {
          seen.length = 0;
          (menu() || trig).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true }));
          await new Promise((res) => setTimeout(res, 350));
          log(`ArrowDown#${i}`, {
            activeElement: describe(document.activeElement),
            keydownSpyCount: seen.length,
            keydownTargets: seen.map((s) => s.target && s.target.text).filter(Boolean).slice(0, 3),
          });
        }

        // 事件监听位置探测：React 根容器在哪，portal 挂在哪
        const rootLike = [...document.body.children].map((el) => el.tagName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''));
        log('body 子元素', { list: rootLike });
        if (wrapper()) log('wrapper 父链', { chain: (() => { const a = []; let n = wrapper(); while (n && n !== document.body) { a.push(n.tagName + (n.id ? '#' + n.id : '')); n = n.parentElement; } return a; })() });
      } finally {
        document.removeEventListener('keydown', spy, true);
        (menu() || trig).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      }
      return out;
    },

    /**
     * 千问输入框是 Lexical 编辑器（2026-09-14 复盘：昨天的合成 paste/beforeinput 今天被静默忽略，
     * 成败押在"编辑器认不认合成事件+选区是否就位"两个不可控条件上，故剪枝重写）：
     * 主路径 = 显式选区 + execCommand insertText（浏览器内部编辑命令，产生真实 targetRanges，
     * Lexical 原生支持，不依赖站点对合成事件的兼容）；唯一回退 = paste（选区已显式就位）。
     * 已删：beforeinput 逐字符循环、textContent 直清 DOM（绕过编辑器内部状态的脏操作）。
     */
    async setValue(el, text) {
      // 空编辑器的 innerText 含占位符（「向千问提问」）+ BOM，必须归一化后识别
      const PLACEHOLDER = '向千问提问';
      const normalize = (t) => (t || '').replace(/[\u200B\u200C\uFEFF\s]/g, '');
      const isEmpty = (t) => { const s = normalize(t); return !s || s === PLACEHOLDER; };
      const liveEl = () => document.querySelector('[contenteditable="true"]') || el;
      // 显式把选区放进编辑器并折叠到末尾：focus() 不保证 caret 落位，选区才是插入的落点
      const placeSelection = (target) => {
        target.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      };
      const inject = async (target) => {
        placeSelection(target);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(150);
        document.execCommand('insertText', false, text);
        await sleep(500);
        if (normalize(target.innerText) === normalize(text)) return 'execCommand';
        try {
          placeSelection(target);
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch {}
        await sleep(600);
        if (normalize(target.innerText) === normalize(text)) return 'paste';
        return null;
      };

      // 水合自愈：编辑器节点可能被框架异步重挂（注入文本随旧节点死亡）。
      // 注入后等 300ms 复查活编辑器：节点被换/活编辑器为空 → 对活节点重新注入，最多 3 轮。
      ADAPTER.__lastText = text; // send 阶段活编辑器被水合清空时就地补注用
      let target = liveEl();
      for (let round = 0; round < 3; round++) {
        const how = await inject(target);
        await sleep(300);
        const live = liveEl();
        if (how && !isEmpty(live.innerText) && normalize(live.innerText) === normalize(text)) {
          return round ? `${how}+reinject${round}` : how;
        }
        if (live !== target) target = live; // 框架重挂，转投活节点
      }
      throw new Error(`文本注入失败（含水合重挂自愈 3 轮）：活编辑器内容「${(liveEl().innerText || '').slice(0, 50)}」`);
    },

    async send(inputEl) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 空编辑器（含占位符）识别
      const isEmpty = (t) => {
        const s = (t || '').replace(/[\u200B\u200C\uFEFF\s]/g, '');
        return !s || s === '向千问提问';
      };
      const live = () => document.querySelector('[contenteditable="true"]') || inputEl;
      const startPath = location.pathname;
      // 发送判定 = URL 离开发送时的页面（qwen 首次发送必跳会话页，硬信号）。
      // 占位符文本/输入框延迟清空/编辑器重挂全部免疫，比"输入框清空"可靠一个量级。
      const sent = () => location.pathname !== startPath;

      // 入口守卫：活编辑器为空时先就地补注（水合重挂可能吃掉注入文本），补注失败才报错
      if (isEmpty(live().innerText)) {
        const reinject = await reinjectPrompt();
        if (!reinject) {
          throw new Error('编辑器重挂，注入丢失且补注失败（活编辑器为空）——请重试');
        }
      }

      const findBtn = () => {
        for (const b of document.querySelectorAll('button, [role="button"]')) {
          const label = b.getAttribute('aria-label') || b.getAttribute('title') || '';
          if (/发送|send/i.test(label) && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
            return b;
          }
        }
        return null;
      };

      // 就地补注：显式选区 + execCommand insertText（与 setValue 主路径同款），成功以读回非空为准
      async function reinjectPrompt() {
        const text = ADAPTER.__lastText;
        if (!text) return false;
        const target = live();
        target.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(150);
        document.execCommand('insertText', false, text);
        await sleep(500);
        return !isEmpty(live().innerText);
      }

      // 最多等 12s：编辑器框架感知输入有延迟，按钮从禁用变可用需要时间
      for (let i = 0; i < 60; i++) {
        // 水合清空守卫：等待期间活编辑器被重挂清空 → 就地补注后继续找按钮
        if (isEmpty(live().innerText)) {
          await reinjectPrompt();
          continue;
        }
        const b = findBtn();
        if (b) {
          b.click();
          await sleep(1000);
          if (sent()) return 'click';
          break; // URL 判定下第二次点击冗余且有重复发送风险，已剪
        }
        await sleep(200);
      }

      // 唯一回退：Enter（contenteditable 内）——用实时活编辑器派发，inputEl 可能已是重挂后的幽灵节点
      const enterTarget = live();
      enterTarget.focus();
      enterTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      enterTarget.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(2000);
      if (sent()) return 'enter';

      throw new Error(
        `发送失败：按钮点击与 Enter 均未离开发送页 | 按钮:${findBtn() ? '找到可用' : '未找到可用'}`
        + ` | 活编辑器:「${(live().innerText || '').slice(0, 30)}」 | URL:${location.pathname}`
      );
    },
  };

  wire(ADAPTER);
})();
