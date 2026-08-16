// debug/md-render-test.mjs —— markdown 渲染管线单测（node 直跑）
// 用法：node debug/md-render-test.mjs
// 覆盖：基础语法 / 嵌套组合 / 代码块安全 / XSS 注入 / 边界 / URL 括号配对 / 代码高亮
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const MD = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'markdown.js'));

const { mdToHtml, sanitizeHtml, highlight } = MD;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function contains(hay, needle) {
  return String(hay).includes(needle);
}
function notContains(hay, needle) {
  return !String(hay).includes(needle);
}
// 剥标签 + 解实体，用于校验「高亮后 code 元素 textContent 仍是纯文本」
function htmlToText(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ---------- 基础语法 ----------
check('标题 h2', mdToHtml('## 标题').includes('<h2>标题</h2>'), mdToHtml('## 标题'));
check('粗体', mdToHtml('**粗**').includes('<strong>粗</strong>'));
check('斜体', mdToHtml('*斜*').includes('<em>斜</em>'));
check('删除线', mdToHtml('~~删~~').includes('<del>删</del>'));
check('行内代码', mdToHtml('`x`').includes('<code>x</code>'));
check('链接', mdToHtml('[点](https://a.b)').includes('<a href="https://a.b" target="_blank" rel="noopener noreferrer">点</a>'));
check('代码块语言标注', mdToHtml('```js\nlet a=1;\n```').includes('class="language-js"'));
check('代码块内容', mdToHtml('```\n**not bold**\n```').includes('**not bold**'));
check('代码块复制按钮', mdToHtml('```\nx\n```').includes('data-role="md-copy"'));
check('引用块', mdToHtml('> 引用').includes('<blockquote>引用</blockquote>'));
check('无序列表', mdToHtml('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'));
check('有序列表', mdToHtml('1. a\n2. b').includes('<ol><li>a</li><li>b</li></ol>'));
check('表格', mdToHtml('|a|b|\n|-|-|\n|1|2|').includes('<table>') && mdToHtml('|a|b|\n|-|-|\n|1|2|').includes('<td>1</td>'));
check('水平线', mdToHtml('---').includes('<hr>'));
check('段落', mdToHtml('你好').includes('<p>你好</p>'));

// ---------- 嵌套与组合 ----------
const nest = mdToHtml('- **粗体** 和 `code`');
check('列表内粗体+代码', nest.includes('<li><strong>粗体</strong> 和 <code>code</code></li>'), nest);
const q = mdToHtml('> `代码`');
check('引用内代码', q.includes('<blockquote><code>代码</code></blockquote>'), q);

// ---------- 代码块安全 ----------
const c1 = mdToHtml('```\n<script>alert(1)</script>\n```');
check('代码块内脚本被转义', notContains(c1, '<script>'), c1);
const c2 = mdToHtml('```js\nconst a = `<b>hi</b>`;\n```');
check('代码块内标签转义', notContains(c2, '<b>hi</b>'), c2);

// ---------- XSS 注入组（测最终链路：sanitizeHtml(mdToHtml(x))，与前端调用一致） ----------
const xs = [
  ['脚本标签', '<script>alert(1)</script>', '<script'],
  ['img onerror', '<img src=x onerror=alert(1)>', '<img'],
  ['javascript: 链接', '[x](javascript:alert(1))', 'javascript:'],
  ['data: 链接', '[x](data:text/html,alert(1))', 'data:'],
  ['事件属性', '<a href="https://a.b" onclick="alert(1)">x</a>', 'onclick='],
  ['iframe', '<iframe src="https://evil"></iframe>', '<iframe'],
  ['style 属性', '<div style="position:fixed">x</div>', 'style='],
];
for (const [name, input, evil] of xs) {
  const out = sanitizeHtml(mdToHtml(input));
  check('XSS: ' + name, notContains(out, evil), out.slice(0, 80));
}
const jsUrl = sanitizeHtml(mdToHtml('[点](javascript:alert(1))'));
check('javascript: 链接 href 被移除', notContains(jsUrl, 'href="javascript:') && notContains(jsUrl, 'javascript:'), jsUrl);

// ---------- 边界 ----------
check('空串', mdToHtml('') === '');
check('纯文本', mdToHtml('普通文本').includes('<p>普通文本</p>'));
const open = mdToHtml('```js\n未闭合');
check('未闭合代码块', open.includes('未闭合'), open.slice(0, 60));
check('sanitize 白名单保留', sanitizeHtml('<p><strong>ok</strong></p>').includes('<strong>ok</strong>'));

// ---------- URL 括号配对（T2a） ----------
const linkParen1 = mdToHtml('[点](https://a.b/c_(d))');
check('URL 单层括号完整保留', linkParen1.includes('<a href="https://a.b/c_(d)"') && notContains(linkParen1, '</a>)'), linkParen1);
const linkParen2 = mdToHtml('[x](https://a.b/(c(d)))');
check('URL 多层括号', linkParen2.includes('<a href="https://a.b/(c(d))"'), linkParen2);
const linkParen3 = mdToHtml('[x](https://a.b/f(d))');
check('URL 末尾括号不误吞', linkParen3.includes('<a href="https://a.b/f(d)"') && notContains(linkParen3, '</a>)'), linkParen3);
const linkNormal = mdToHtml('[x](https://a.b/foo)');
check('普通链接不回归', linkNormal.includes('<a href="https://a.b/foo"'), linkNormal);

// ---------- 代码高亮（T2b） ----------
check('高亮: JS 关键字', highlight('const', 'js').includes('<span class="tok-kw">const</span>'));
check('高亮: 字符串', highlight('"hi"', 'js').includes('<span class="tok-str">&quot;hi&quot;</span>'));
check('高亮: 模板串', highlight('`a${b}`', 'js').includes('<span class="tok-str">'));
check('高亮: 行注释', highlight('// 注释', 'js').includes('<span class="tok-com">// 注释</span>'));
check('高亮: 块注释', highlight('/* x */', 'js').includes('<span class="tok-com">/* x */</span>'));
check('高亮: 数字', highlight('42', 'js').includes('<span class="tok-num">42</span>'));
check('高亮: 转义防注入', notContains(highlight('const a = "<script>"', 'js'), '<script>'), highlight('const a = "<script>"', 'js'));
check('高亮: 未知语言不染色', notContains(highlight('const x', 'python'), 'tok-kw'));
check('高亮: 空代码块不崩', highlight('', 'js') === '');
const hlJson = highlight('{"k": "v", "n": 1}', 'json');
check('JSON 只染字符串/数字', hlJson.includes('<span class="tok-str">&quot;v&quot;</span>') && hlJson.includes('<span class="tok-num">1</span>') && notContains(hlJson, 'tok-kw'), hlJson);
const hlCode = 'const a = "hi" + 1;\n// 注释';
check('高亮后复制文本仍正确', htmlToText(highlight(hlCode, 'js')) === hlCode, htmlToText(highlight(hlCode, 'js')));
const hlBlock = mdToHtml('```js\nconst a = 1;\n```');
check('代码块高亮集成', hlBlock.includes('<span class="tok-kw">const</span>'), hlBlock);

// ---------- 汇总 ----------
const passed = results.filter((r) => r.ok).length;
console.log(`\n---- ${passed}/${results.length} PASS ----`);
process.exit(passed === results.length ? 0 : 1);
