#!/usr/bin/env node
/**
 * DOM → markdown 序列化器 单元测试（普通对象树模拟 DOM，不需要浏览器）
 *
 * 为什么需要：千问的答案只能从页面 DOM 拿（作答流不在我们 hook 的通道里），
 * 而 innerText 会把表格结构、代码围栏全丢掉，还混入工具栏文字。
 * 这个序列化器是保真度的关键，必须用"照着千问真实结构建模"的用例锁住。
 *
 * 运行：node test-dom-md.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 测试住在 tests/ 下：ROOT = 仓库根（被测代码在 server/ 与 extension/）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const P = require(path.join(ROOT, 'extension', 'content', 'dom-md.js'));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`); }
}

// ---- 构树辅助（与真实 DOM 的最小接口对齐；nodeType 必须有）----
const el = (tag, cls, kids, attrs) => ({ nodeType: 1, tagName: tag, className: cls || '', childNodes: kids || [], attrs: attrs || {} });
const tx = (v) => ({ nodeType: 3, nodeValue: v });

/** 照千问实测结构建模：工具栏（按钮）+ 表格 + 代码工具栏 + 带行号的代码块 */
function qianwenAnswer() {
  const cell = (t, kind) => el(kind || 'td', '', [tx(t)]);
  const line = (n, code) => el('div', 'code-line', [
    el('span', 'line-number', [tx(String(n))]),
    el('span', 'code-text', [tx(code)]),
  ]);
  return el('div', 'message-select-wrapper-answer-rqWekn', [
    // 表格工具栏（应被整棵跳过）
    el('div', 'table-toolbar', [
      el('button', '', [tx('表格')]),
      el('button', '', [tx('下载为表格')]),
      el('button', '', [tx('导出为图片')]),
    ]),
    // 表格
    el('table', '', [
      el('thead', '', [el('tr', '', [cell('区别点', 'th'), cell('let', 'th'), cell('const', 'th')])]),
      el('tbody', '', [
        el('tr', '', [cell('重新赋值'), cell('允许修改变量的值'), cell('不允许重新赋值（常量）')]),
        el('tr', '', [cell('初始化要求'), cell('声明时可以不赋初始值'), cell('声明时必须立即赋值')]),
      ]),
    ]),
    // 代码工具栏（语言标签 + 编辑按钮，应被跳过）
    el('div', 'code-toolbar', [
      el('span', 'lang-label', [tx('javascript')]),
      el('button', '', [tx('编辑')]),
    ]),
    // 代码块（带行号）
    el('div', 'code-block language-javascript', [
      line(1, 'let count = 1;'),
      line(2, 'count = 2; // 合法，let 允许重新赋值'),
      line(3, 'const PI = 3.14;'),
    ]),
  ]);
}

console.log('\n[1] 千问形态：工具栏剔除、表格还原成管道表、代码还原成围栏');
{
  const md = P.toMarkdown(qianwenAnswer());
  check('表格还原为管道表（含表头分隔行）',
    md.includes('| 区别点 | let | const |\n| --- | --- | --- |\n| 重新赋值 | 允许修改变量的值 | 不允许重新赋值（常量） |'),
    true);
  check('代码块还原为围栏（带语言）', md.includes('```javascript\nlet count = 1;\ncount = 2; // 合法，let 允许重新赋值\nconst PI = 3.14;\n```'), true);
  check('不含工具栏文字「下载为表格」', md.includes('下载为表格'), false);
  check('不含工具栏文字「导出为图片」', md.includes('导出为图片'), false);
  check('不含「编辑」按钮文字', md.includes('编辑'), false);
  check('不含行号「1」行', /\n1\n/.test(md), false);
  check('代码内容完整保留', md.includes('let count = 1;') && md.includes('const PI = 3.14;'), true);
}

console.log('\n[1b] 千问实测结构（answerHtml 取证）：react-syntax-highlighter，空白在独立 span 里');
{
  // 2026-09-15 answerHtml 实锤：行号是 .linenumber span，token 是 .token span，
  // **空格与换行各自在无类名的 span 里**（<span> count </span>、<span>\n</span>）。
  const lineno = (n) => el('span', 'linenumber react-syntax-highlighter-line-number', [tx(String(n))]);
  const tok = (t) => el('span', 'token', [tx(t)]);
  const ws = (t) => el('span', '', [tx(t)]);
  const line = (n, parts) => el('span', '', [lineno(n), ...parts, ws('\n')]);
  const root = el('div', '', [
    el('div', 'code-card', [
      el('div', 'code-header', [el('span', '', [tx('javascript')]), el('button', '', [tx('编辑')])]),
      el('pre', '', [
        el('code', '', [
          line(1, [tok('let'), ws(' count '), tok('='), ws(' '), tok('1'), tok(';')]),
          line(2, [ws('count '), tok('='), ws(' '), tok('2'), tok(';'), ws(' '), tok('// 合法：let 允许重新赋值')]),
          line(3, [tok('const'), ws(' '), tok('PI'), ws(' '), tok('='), ws(' '), tok('3.14'), tok(';')]),
        ]),
      ]),
    ]),
  ]);
  const md = P.toMarkdown(root);
  check('空格 span 保留 → token 间距正确（constPI 不再粘连）',
    md.includes('let count = 1;\ncount = 2; // 合法：let 允许重新赋值\nconst PI = 3.14;'), true);
  check('换行由 <span>\\n</span> 还原', md.includes('let count = 1;\ncount = 2;'), true);
  check('行号不混入', /\n1\n|\n2\n|\n3\n/.test(md), false);
  check('「编辑」按钮与头部「javascript」不混入', md.includes('编辑') || md.includes('javascript'), false);
  check('数值字面量 1 / 2 / 3.14 完整', md.includes('count = 2;') && md.includes('3.14'), true);
}

console.log('\n[1c] 表格卡片：纯 div 标题（非按钮）不混入');
{
  const cell = (t, kind) => el(kind || 'td', '', [tx(t)]);
  const root = el('div', '', [
    el('div', 'table-card', [
      el('div', 'card-caption', [tx('表格')]),   // 不是 button —— 类名也不含装饰词
      el('table', '', [
        el('thead', '', [el('tr', '', [cell('维度', 'th'), cell('let', 'th')])]),
        el('tbody', '', [el('tr', '', [cell('重新赋值'), cell('允许')])]),
      ]),
    ]),
    el('p', '', [tx('表格之后的正文')]),
  ]);
  const md = P.toMarkdown(root);
  check('表格还原', md.includes('| 维度 | let |'), true);
  check('卡片标题「表格」不混入', md.includes('表格\n'), false);
  check('卡片外的正文保留', md.includes('表格之后的正文'), true);
}

console.log('\n[1d] 兜底：行无换行 span → 按子元素边界拆行（gutter 行数校验防碎行）');
{
  const line = (parts) => el('span', 'code-line', parts);
  const num = (v) => el('span', 'hljs-number', [tx(v)]);
  const root = el('div', '', [
    el('div', 'code-block language-python', [
      el('div', 'gutter', [el('span', '', [tx('1')]), el('span', '', [tx('2')])]),
      el('pre', '', [
        el('code', '', [
          line([tx('print('), num('1'), tx(')')]),
          line([tx('print('), num('2'), tx(')')]),
        ]),
      ]),
    ]),
  ]);
  const md = P.toMarkdown(root);
  check('无换行 span 时按子元素边界拆行', md.includes('print(1)\nprint(2)'), true);
  check('gutter 行号不混入', /\n1\n|\n2\n/.test(md), false);
}

console.log('\n[2] 行号是独立 gutter 列的结构（另一种常见形态）');
{
  const root = el('div', '', [
    el('div', 'code-block language-python', [
      el('div', 'gutter', [el('span', '', [tx('1')]), el('span', '', [tx('2')])]),
      el('pre', '', [el('code', '', [tx('print(1)\nprint(2)')])]),
    ]),
  ]);
  const md = P.toMarkdown(root);
  check('gutter 的行号不混入', md.includes('\n1\n'), false);
  check('代码完整且带围栏', md.includes('```python\nprint(1)\nprint(2)\n```'), true);
}

console.log('\n[3] 常见块级语义');
{
  const root = el('div', '', [
    el('h2', '', [tx('结论')]),
    el('p', '', [tx('这是'), el('strong', '', [tx('加粗')]), tx('与'), el('em', '', [tx('斜体')]), tx('以及'), el('code', '', [tx('code()')]), tx('。')]),
    el('ul', '', [
      el('li', '', [tx('第一项')]),
      el('li', '', [tx('第二项'), el('ul', '', [el('li', '', [tx('嵌套项')])])]),
    ]),
    el('blockquote', '', [tx('引用内容')]),
  ]);
  const md = P.toMarkdown(root);
  check('标题层级还原', md.includes('## 结论'), true);
  check('行内语义还原', md.includes('这是**加粗**与*斜体*以及`code()`。'), true);
  check('列表与嵌套还原', md.includes('- 第一项') && md.includes('- 第二项') && md.includes('  - 嵌套项'), true);
  check('引用还原', md.includes('> 引用内容'), true);
}

console.log('\n[4] 防御性：role=button / aria-hidden / 空输入');
{
  const root = el('div', '', [
    el('div', '', [tx('正文')]),
    el('div', '', Object.assign(el('span', '', [tx('装饰')]), { attrs: { 'aria-hidden': 'true' } })),
    el('span', '', [tx('伪装')], { role: 'button' }),
  ]);
  const md = P.toMarkdown(root);
  check('aria-hidden 子树被跳过', md.includes('装饰'), false);
  check('role=button 被跳过', md.includes('伪装'), false);
  check('正文保留', md.includes('正文'), true);
  check('null 输入安全', P.toMarkdown(null), '');
  check('空对象安全', P.toMarkdown({ tagName: 'DIV', childNodes: [] }), '');
}

console.log('\n[5] 回退：结构不认识时至少给出文本（宁可失真不可空手）');
{
  const root = el('div', 'weird-thing', [
    el('div', 'weird-inner', [tx('只有纯文本的答案')]),
  ]);
  const md = P.toMarkdown(root);
  check('未知结构也能取出文本', md.includes('只有纯文本的答案'), true);
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
