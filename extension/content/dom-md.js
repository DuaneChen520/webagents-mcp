/**
 * WebAgents DOM → markdown 序列化器（纯逻辑，可脱离浏览器单测）
 *
 * 为什么需要它：站点渲染出来的答案就是**最终确定性结果**，而且 DOM 携带的结构
 * 远比 innerText 丰富 —— 表格是真 <table>、代码块是真 <pre>、工具栏/行号是独立元素。
 * 之前用 innerText 抓答案，等于把结构扔掉再抱怨失真：
 *   · 表格变成制表符碎片，且混入"下载为表格/导出为图片"这类工具栏文字
 *   · 代码块混入行号（1/2/3）与语言标签，且丢掉 ``` 围栏
 *
 * 设计原则：
 *   · 只依赖最小 DOM 接口（tagName / className / childNodes / nodeType / nodeValue /
 *     getAttribute），因此可以用普通对象树做单元测试；
 *   · 站点无关：不写死任何站点的类名，跳过"看起来是界面装饰"的子树；
 *   · 宁可漏掉装饰，不可漏掉正文 —— 跳过判据必须指向明确的装饰特征。
 *
 * 挂到 window.__WEBAGENTS_DOMMD__ 供内容脚本使用（隔离世界）。
 */
(() => {
  'use strict';

  // 界面装饰特征：命中即整棵跳过（工具栏/操作按钮/行号列等）。
  // 注意保持克制：这里列的都是"明确是装饰"的词。像 select-wrapper / card-header
  // 这类词看似装饰，实际可能出现在**回答容器自身**的类名里
  //（千问就是 message-select-wrapper-answer-xxx），加进来会把整个答案跳掉。
  const SKIP_CLASS = /(toolbar|tool-bar|actionbar|actions?-bar|operation|copy|download|export|regenerate|re-generate|code-header|code-toolbar|line-number|line-numbers|linenums?|linenumber|gutter|hljs-ln|lang-label)/i;
  const NUM_ONLY = /^\d{1,4}$/;

  const tagOf = (el) => String((el && el.tagName) || '').toLowerCase();

  /** className 兼容：普通元素是字符串，SVG 是 SVGAnimatedString（取 baseVal） */
  function classOf(el) {
    if (!el) return '';
    const c = el.className;
    if (typeof c === 'string') return c;
    if (c && typeof c.baseVal === 'string') return c.baseVal;
    if (el.classList && el.classList.length) {
      try { return Array.prototype.join.call(el.classList, ' '); } catch { /* 忽略 */ }
    }
    return '';
  }

  function attrOf(el, name) {
    if (!el) return null;
    if (typeof el.getAttribute === 'function') {
      try { return el.getAttribute(name); } catch { return null; }
    }
    return (el.attrs && el.attrs[name]) != null ? String(el.attrs[name]) : null;
  }

  const kidsOf = (el) => (el && el.childNodes) ? Array.prototype.slice.call(el.childNodes) : [];
  const isTextNode = (n) => !!n && n.nodeType === 3;
  const isElement = (n) => !!n && n.nodeType === 1;

  /** 这棵子树是不是"界面装饰"？命中则整体跳过 */
  function isChrome(el) {
    const tag = tagOf(el);
    if (tag === 'button' || tag === 'svg' || tag === 'input' || tag === 'select') return true;
    if (attrOf(el, 'role') === 'button') return true;
    if (attrOf(el, 'aria-hidden') === 'true') return true;
    const cls = classOf(el);
    return !!(cls && SKIP_CLASS.test(cls));
  }

  /** 行内文本：保留加粗/斜体/行内代码/换行的语义 */
  function inlineText(el, depth) {
    if (depth > 30) return '';
    let out = '';
    for (const n of kidsOf(el)) {
      if (isTextNode(n)) { out += (n.nodeValue != null ? n.nodeValue : (n.textContent || '')); continue; }
      if (!isElement(n)) continue;
      if (isChrome(n)) continue;
      const tag = tagOf(n);
      if (tag === 'br') { out += '\n'; continue; }
      const inner = inlineText(n, depth + 1);
      if (tag === 'strong' || tag === 'b') out += inner ? `**${inner}**` : '';
      else if (tag === 'em' || tag === 'i') out += inner ? `*${inner}*` : '';
      else if (tag === 'code') out += inner ? '`' + inner.replace(/`/g, '') + '`' : '';
      else out += inner;
    }
    return out;
  }

  const squash = (s) => String(s || '').replace(/[ \t\u00A0]+/g, ' ').trim();

  /** 在子树里找第一个匹配标签的元素（深度优先） */
  function findTag(el, re, depth) {
    if (depth > 30) return null;
    for (const n of kidsOf(el)) {
      if (!isElement(n)) continue;
      if (re.test(tagOf(n))) return n;
      const found = findTag(n, re, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /**
   * 代码块提取。
   * 难点：行号。两种常见结构都能处理 ——
   *   ① 行号是独立兄弟列（gutter）→ "容器里全部子节点都是纯数字"整列跳过
   *   ② 每行是 <div><span class=lineno>1</span><span>代码</span></div> → 行号是**父容器的
   *      第一个元素子节点**才跳过。不能无脑跳过所有纯数字元素 —— 代码里的数值字面量
   *      （如 hljs-number 的 "1"）也是纯数字，无脑跳过会把 `let score = 1;` 吃成
   *      `let score =;`（2026-09-15 实测踩过）。
   * 语言：优先 class 的 language-xxx / lang-xxx。
   */
  /** gutter 列：容器里全部元素子节点都是纯数字（≥2 个）→ 返回数字个数，否则 0 */
  function gutterCount(el) {
    const ek = kidsOf(el).filter(isElement);
    if (ek.length >= 2 && ek.every((n) => NUM_ONLY.test(squash(n.textContent || '')))) return ek.length;
    return 0;
  }

  function extractCode(el) {
    // 语言：优先 class 的 language-xxx / lang-xxx（pre / code / 外层容器都可能带）
    const langFrom = (n) => { const m = /(?:language|lang)-([a-z0-9+#-]+)/i.exec(classOf(n)); return m ? m[1] : ''; };
    let lang = langFrom(el) || langFrom(el.firstElementChild) || '';

    // 单链下钻：pre→code、[gutter + code] 两件套 → 行真正的容器往往比传入节点深一层。
    // 不下钻的话，"按子元素边界拆行"会发生在错误的层级（2026-09-15 测试抓出）。
    let root = el;
    let gutterN = 0;
    for (let i = 0; i < 8; i++) {
      const ek = kidsOf(root).filter(isElement);
      if (ek.length === 1) {
        lang = lang || langFrom(ek[0]);
        root = ek[0];
        continue;
      }
      const nonGutter = ek.filter((n) => !isChrome(n) && !gutterCount(n));
      if (!gutterN) gutterN = ek.reduce((acc, n) => acc + gutterCount(n), 0);
      if (ek.length >= 2 && nonGutter.length === 1 && gutterN > 0) {
        lang = lang || langFrom(nonGutter[0]);
        root = nonGutter[0];
        continue;
      }
      break;
    }
    if (!lang) lang = langFrom(root) || langFrom(root.firstElementChild) || '';

    /** 递归收集；buf 里 push 文本与 '\n' */
    const walk = (node, depth, buf) => {
      if (depth > 40) return;
      const kids = kidsOf(node);
      const elemKids = kids.filter(isElement);
      if (gutterCount(node)) return; // 行号列整体跳过
      for (const n of kids) {
        if (isTextNode(n)) {
          const t = String(n.nodeValue != null ? n.nodeValue : '');
          // 代码里空格是语法的一部分：千问的高亮器把空格/换行放在**独立的 span** 里
          //（<span> </span>、<span>\n</span>），用 trim() 判空会把它们全部丢掉，
          // 得到 "constPI=3.14" 这种改变标识符语义的粘连（2026-09-15 实测踩过）。
          if (t.length) buf.push(t);
          continue;
        }
        if (!isElement(n)) continue;
        if (isChrome(n)) continue;
        const tag = tagOf(n);
        if (tag === 'br') { buf.push('\n'); continue; }
        // 行号（"每行一个 div + 行号"结构）：纯数字且是父容器**第一个**元素子节点才跳过。
        // 不能无脑跳过所有纯数字元素 —— 代码里的数值字面量（hljs-number 的 "1"）也是
        // 纯数字，无脑跳过会把 `let score = 1;` 吃成 `let score =;`（2026-09-15 实测踩过）。
        if (elemKids.length >= 2 && elemKids[0] === n && NUM_ONLY.test(squash(n.textContent || ''))) continue;
        walk(n, depth + 1, buf);
        // 行级元素结束 = 换行（"每行一个 div"的结构靠这里还原换行）
        if (/^(div|p|li|tr)$/.test(tag)) buf.push('\n');
      }
    };

    // 顶层逐个直接子元素收集（保留子元素边界：行被"块级样式的 span"渲染时没有换行符，
    // 只能靠子元素边界拆行 —— 2026-09-15 实测千问代码块就是这种形态）
    const topBufs = [];
    const kids = kidsOf(root);
    const elemKids = kids.filter(isElement);
    if (gutterCount(root)) return { text: '', lang }; // 整个代码块就是一行号列
    for (const n of kids) {
      if (isTextNode(n)) {
        const t = String(n.nodeValue != null ? n.nodeValue : '');
        if (t.length) topBufs.push([t]); // 空白也保留（代码里空格有语义，见上）
        continue;
      }
      if (!isElement(n)) continue;
      if (isChrome(n) || gutterCount(n)) continue;
      if (tagOf(n) === 'br') { topBufs.push(['\n']); continue; }
      if (elemKids.length >= 2 && elemKids[0] === n && NUM_ONLY.test(squash(n.textContent || ''))) continue;
      const buf = [];
      walk(n, 1, buf);
      if (/^(div|p|li|tr)$/.test(tagOf(n))) buf.push('\n');
      if (buf.length) topBufs.push(buf);
    }

    const flat = topBufs.map((b) => b.join(''));
    let text = flat.join('');
    // 行被粘成一行：顶层有 ≥2 个子元素却没有任何换行 → 按子元素边界拆行。
    // 若存在 gutter，行数必须与 gutter 数字个数一致才拆（防止把 token 拆成碎行）。
    const nonEmpty = flat.filter((s) => s.trim());
    if (!text.includes('\n') && nonEmpty.length >= 2 && (!gutterN || nonEmpty.length === gutterN)) {
      text = nonEmpty.join('\n');
    }
    text = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    return { text, lang };
  }

  /** 表格 → 管道表格（首行作表头） */
  function tableMd(table) {
    const rows = [];
    const walk = (node, depth) => {
      if (depth > 30) return;
      for (const n of kidsOf(node)) {
        if (!isElement(n)) continue;
        const tag = tagOf(n);
        if (tag === 'tr') {
          const cells = [];
          for (const c of kidsOf(n)) {
            if (isElement(c) && /^(td|th)$/.test(tagOf(c))) {
              cells.push(squash(inlineText(c, 0)).replace(/\|/g, '\\|').replace(/\n/g, ' '));
            }
          }
          if (cells.length) rows.push(cells);
          continue;
        }
        if (tag === 'table') continue;   // 嵌套表格不展开
        walk(n, depth + 1);
      }
    };
    walk(table, 0);

    if (!rows.length) return '';
    const width = Math.max.apply(null, rows.map((r) => r.length));
    const norm = rows.map((r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; });
    const line = (r) => '| ' + r.join(' | ') + ' |';
    const head = line(norm[0]);
    const sep = '| ' + norm[0].map(() => '---').join(' | ') + ' |';
    return [head, sep].concat(norm.slice(1).map(line)).join('\n');
  }

  /** 列表 → markdown 列表（支持嵌套缩进） */
  function listMd(listEl, ordered, level, depth) {
    const out = [];
    let idx = 1;
    for (const n of kidsOf(listEl)) {
      if (!isElement(n) || tagOf(n) !== 'li') continue;
      const parts = [];
      let nested = null;
      for (const c of kidsOf(n)) {
        if (isTextNode(c)) { const t = squash(c.nodeValue); if (t) parts.push(t); continue; }
        if (!isElement(c)) continue;
        const tag = tagOf(c);
        if (tag === 'ul' || tag === 'ol') { nested = nested || []; nested.push(c); continue; }
        const t = inlineText(c, 0).replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      }
      const marker = ordered ? `${idx++}. ` : '- ';
      out.push('  '.repeat(level) + marker + parts.join(' '));
      for (const sub of nested || []) out.push(listMd(sub, tagOf(sub) === 'ol', level + 1, depth + 1));
    }
    return out.filter(Boolean).join('\n');
  }

  /** 是否"像代码块"：pre，或类名含 code 的块级元素 */
  function isCodeBlock(el) {
    const tag = tagOf(el);
    if (tag === 'pre') return true;
    if (tag !== 'div') return false;
    return /code-block|codeblock|code-container/i.test(classOf(el));
  }

  /**
   * 把一个"回答块"元素序列化为 markdown。
   *
   * 只处理块级语义（表格/代码/标题/列表/引用/段落），其余容器下钻；
   * 文本节点视为段落文本。结果做过空行收敛。
   */
  function toMarkdown(root, opts) {
    if (!root) return '';
    const maxLen = (opts && opts.maxLen) || 200000;
    const out = [];
    const seen = new Set();

    const walk = (el, depth) => {
      if (depth > 60 || out.join('').length > maxLen) return;
      if (!isElement(el) || seen.has(el)) return;
      seen.add(el);
      // 根元素（depth 0）**永不跳过**：调用方明确指定要序列化这棵子树，
      // 而回答容器的类名可能恰好长得像装饰（千问就是 message-select-wrapper-answer-…）。
      if (depth > 0 && isChrome(el)) return;

      const tag = tagOf(el);

      if (isCodeBlock(el) || tag === 'pre') {
        // 容器级代码块（div[class*=code-block] 之类）往往带着语言标签/"编辑"按钮等头部 ——
        // 只序列化内层 pre/code，头部自然被排除（不靠猜类名）。
        const inner = (tag !== 'pre') ? (findTag(el, /^(pre|code)$/, 0) || el) : el;
        const code = extractCode(inner);
        // 语言标记可能只在外层容器的 class 上（inner 是下钻后的 pre/code）
        const langHint = (/(?:language|lang)-([a-z0-9+#-]+)/i.exec(classOf(el)) || [])[1] || '';
        if (code.text) { out.push('\n```' + (code.lang || langHint) + '\n' + code.text + '\n```\n\n'); return; }
        if (inner !== el) return; // 内层存在但为空：不再下钻（否则头部会被当正文混入）
        // 代码块里没取到内容：不 return，继续下钻（宁可多一层也不要丢正文）
      }
      if (tag === 'table') { const t = tableMd(el); if (t) { out.push('\n' + t + '\n\n'); return; } }
      if (/^h[1-6]$/.test(tag)) {
        const t = squash(inlineText(el, 0));
        if (t) { out.push('\n' + '#'.repeat(Number(tag[1])) + ' ' + t + '\n\n'); return; }
      }
      if (tag === 'ul' || tag === 'ol') {
        const t = listMd(el, tag === 'ol', 0, 0);
        if (t) { out.push('\n' + t + '\n\n'); return; }
      }
      if (tag === 'blockquote') {
        const t = squash(inlineText(el, 0));
        if (t) { out.push('\n> ' + t + '\n\n'); return; }
      }
      if (tag === 'hr') { out.push('\n---\n\n'); return; }

      if (tag === 'p') {
        const t = squash(inlineText(el, 0));
        if (t) out.push(t + '\n\n');
        return;
      }

      // 通用容器：文本节点按段落处理，元素节点下钻
      for (const n of kidsOf(el)) {
        if (isTextNode(n)) {
          const t = squash(n.nodeValue);
          if (t) out.push(t + '\n\n');
        } else if (isElement(n)) {
          // "卡片"结构：子元素内嵌 table/pre（如表格卡片带"表格"标题栏、代码卡片带语言标签栏）
          // → 只取内层 table/pre 的内容，卡片自身的标题/工具栏不混入正文（不靠猜类名）。
          // 注意代码卡片只认 **pre**：段落里的行内 <code> 不是卡片，走正常行内语义。
          if (tagOf(n) !== 'table' && findTag(n, /^table$/, 0)) {
            const t = tableMd(findTag(n, /^table$/, 0));
            if (t) { out.push('\n' + t + '\n\n'); continue; }
          }
          if (findTag(n, /^pre$/, 0)) {
            const code = extractCode(findTag(n, /^pre$/, 0));
            const langHint = (/(?:language|lang)-([a-z0-9+#-]+)/i.exec(classOf(n)) || [])[1] || '';
            if (code.text) { out.push('\n```' + (code.lang || langHint) + '\n' + code.text + '\n```\n\n'); continue; }
          }
          walk(n, depth + 1);
        }
      }
    };

    walk(root, 0);
    return out.join('').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLen);
  }

  const api = { toMarkdown, extractCode, tableMd, listMd, inlineText };
  if (typeof window !== 'undefined') window.__WEBAGENTS_DOMMD__ = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
