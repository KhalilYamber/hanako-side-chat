// assets/markdown.js —— 极简 markdown 渲染管线（三段式：escape→parse→sanitize）
// 手写实现，无外部依赖。UMD：浏览器挂 window.MD，node 下 module.exports。
// 语法：标题 1-6 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块(语言+复制按钮+极简高亮) /
//       引用块 / 有序无序列表(嵌套一层) / 链接(URL 括号配对) / 表格 / 水平线 / 段落
// 安全：原始 HTML 一律剥离；href 协议白名单（http/https/mailto）；标签/属性白名单。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 基础工具 ----------

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- 消毒层（sanitize） ----------

  var ALLOWED_TAGS = {
    p: 1, br: 1, hr: 1, strong: 1, em: 1, del: 1, code: 1, pre: 1, a: 1,
    ul: 1, ol: 1, li: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    blockquote: 1, table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1,
    span: 1, button: 1, div: 1,
  };
  var ALLOWED_ATTR = { class: 1, href: 1, target: 1, rel: 1, 'data-role': 1, 'data-lang': 1 };
  var SAFE_PROTO = /^(https?:|mailto:)/i;

  /** 白名单消毒：剥离一切不在白名单的标签与属性；href 只保留安全协议。 */
  function sanitizeHtml(html) {
    var out = '';
    var tagRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)\s*\/?>/g;
    var last = 0;
    var m;
    while ((m = tagRe.exec(html)) !== null) {
      out += escapeHtml(html.slice(last, m.index));
      var name = m[1].toLowerCase();
      if (!ALLOWED_TAGS[name]) { last = m.index + m[0].length; continue; } // 未知标签：丢弃
      var attrs = m[2] || '';
      var attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
      var am;
      var attrOut = '';
      while ((am = attrRe.exec(attrs)) !== null) {
        var key = am[1].toLowerCase();
        var val = am[3] !== undefined ? am[3] : (am[4] !== undefined ? am[4] : am[5]);
        if (!ALLOWED_ATTR[key]) continue;
        if (key === 'href') {
          var trimmed = val.trim().replace(/[\u0000-\u001F\u007F\s]/g, '');
          if (!SAFE_PROTO.test(trimmed) && !trimmed.startsWith('#')) continue; // 危险协议：丢弃 href
        }
        attrOut += ' ' + key + '="' + escapeHtml(val) + '"';
      }
      var close = m[0].startsWith('</');
      out += '<' + (close ? '/' : '') + name + attrOut + '>';
      last = m.index + m[0].length;
    }
    out += escapeHtml(html.slice(last));
    return out;
  }

  // ---------- 行内解析（parse inline） ----------

  /** 行内：先保护行内代码，再处理粗/斜/删/链，最后还原代码。 */
  function inline(text) {
    var codes = [];
    var t = text;
    t = t.replace(/`([^`\n]+)`/g, function (_, c) {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    // 链接优先（避免 [x](y) 内粗体误解析）；URL 括号配对解析（T2a）
    t = parseLinks(t);
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    t = t.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return '<code>' + escapeHtml(codes[+i]) + '</code>';
    });
    return t;
  }

  function inlineInner(text) {
    // 链接 label 内的粗斜体
    return text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }

  /** 行内链接解析：URL 括号配对（T2a）。[label] 部分保持原语义；URL 内 ( 深度 +1、) 深度 -1，
   *  深度归零的 ) 才是链接结束，从而 URL 可含括号不被截断。危险协议仍由 sanitizeHtml 兜底。 */
  function parseLinks(text) {
    var out = '';
    var i = 0;
    var n = text.length;
    while (i < n) {
      var open = text.indexOf('[', i);
      if (open < 0) { out += text.slice(i); break; }
      out += text.slice(i, open);
      // 找 [label]( 起始：首个 ] 后紧跟 (
      var close = -1;
      var k = open + 1;
      while (k < n - 1) {
        if (text[k] === ']' && text[k + 1] === '(') { close = k; break; }
        k++;
      }
      if (close < 0) { out += '['; i = open + 1; continue; }
      var label = text.slice(open + 1, close);
      // 括号配对扫描 URL
      var depth = 1;
      var j = close + 2;
      var urlEnd = -1;
      while (j < n) {
        var ch = text[j];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { urlEnd = j; break; }
        }
        j++;
      }
      if (urlEnd < 0) { out += '['; i = open + 1; continue; }
      var url = text.slice(close + 2, urlEnd);
      // 可选 "title"（链接后空白 + 引号串）：消费后丢弃（与原实现一致）
      var tm = /^\s+"[^"]*"/.exec(text.slice(urlEnd + 1));
      var end = urlEnd + (tm ? 1 + tm[0].length : 0);
      // URL 非空且不含空白才算链接，否则按普通文本处理（保持原 [^)\s] 的空白约束）
      if (!url.trim() || /\s/.test(url)) { out += '['; i = open + 1; continue; }
      out += '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + inlineInner(label) + '</a>';
      i = end + 1;
    }
    return out;
  }

  // ---------- 极简代码高亮（T2b，纯函数，无外部依赖） ----------

  var HL_LANGS = { js: 1, javascript: 1, ts: 1, typescript: 1, json: 1 };
  var HL_KEYWORDS = {
    const: 1, let: 1, var: 1, function: 1, return: 1, if: 1, else: 1, for: 1, while: 1,
    class: 1, new: 1, async: 1, await: 1, try: 1, catch: 1, throw: 1, import: 1, export: 1, from: 1,
  };

  /** 极简 tokenizer：按字符扫描，识别字符串（含模板串简易版）/ 行注释与块注释 / 关键字 / 数字。
   *  只对 js/javascript/ts/typescript/json 染色（json 只染字符串与数字），其它语言原样转义。
   *  输出先 HTML 转义再包 span，防注入；span 包裹不影响 code 元素 textContent（复制仍是纯文本）。 */
  function highlight(code, lang) {
    var l = String(lang || '').toLowerCase();
    if (!HL_LANGS[l]) return escapeHtml(code);
    var isJson = l === 'json';
    var s = String(code == null ? '' : code);
    var out = '';
    var i = 0;
    var n = s.length;
    function emit(text, cls) {
      var esc = escapeHtml(text);
      out += cls ? '<span class="' + cls + '">' + esc + '</span>' : esc;
    }
    while (i < n) {
      var c = s[i];
      // 注释（json 不处理）
      if (!isJson && c === '/' && s[i + 1] === '/') {
        var lc = s.indexOf('\n', i);
        if (lc < 0) lc = n;
        emit(s.slice(i, lc), 'tok-com');
        i = lc;
        continue;
      }
      if (!isJson && c === '/' && s[i + 1] === '*') {
        var bc = s.indexOf('*/', i + 2);
        var bend = bc < 0 ? n : bc + 2;
        emit(s.slice(i, bend), 'tok-com');
        i = bend;
        continue;
      }
      // 字符串（含模板串简易版，不展开 ${}）
      if (c === '"' || c === "'" || c === '`') {
        var q = i + 1;
        while (q < n) {
          if (s[q] === '\\') { q += 2; continue; }
          if (s[q] === c) { q++; break; }
          q++;
        }
        emit(s.slice(i, q), 'tok-str');
        i = q;
        continue;
      }
      // 数字
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        var m = /^(0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
        var numLen = m ? m[0].length : 1;
        emit(s.slice(i, i + numLen), 'tok-num');
        i += numLen;
        continue;
      }
      // 关键字 / 标识符
      if (/[A-Za-z_$]/.test(c)) {
        var w = i + 1;
        while (w < n && /[A-Za-z0-9_$]/.test(s[w])) w++;
        var word = s.slice(i, w);
        emit(word, (!isJson && HL_KEYWORDS[word]) ? 'tok-kw' : null);
        i = w;
        continue;
      }
      // 其它单字符
      emit(c);
      i++;
    }
    return out;
  }

  // ---------- 块级解析（parse block） ----------

  function mdToHtml(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var i = 0;
    var n = lines.length;

    function flushParagraph(buf) {
      if (buf.length) {
        out.push('<p>' + inline(buf.join(' ')) + '</p>');
        buf.length = 0;
      }
    }

    var para = [];

    while (i < n) {
      var line = lines[i];

      // 代码块
      var fence = /^```([^\s]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph(para);
        var lang = fence[1];
        var code = [];
        i++;
        while (i < n && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++; // 跳过闭合
        var codeHtml = highlight(code.join('\n'), lang);
        out.push(
          '<div class="md-codeblock">' +
            '<div class="md-codeblock-head"><span class="md-codeblock-lang">' +
            escapeHtml(lang || 'code') + '</span>' +
            '<button type="button" class="md-copy" data-role="md-copy">复制</button></div>' +
            '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' +
            codeHtml + '</code></pre></div>'
        );
        continue;
      }

      // 标题
      var h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        flushParagraph(para);
        out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>');
        i++;
        continue;
      }

      // 水平线
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph(para);
        out.push('<hr>');
        i++;
        continue;
      }

      // 引用块（连续 > 行）
      if (/^\s*>\s?/.test(line)) {
        flushParagraph(para);
        var quote = [];
        while (i < n && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>');
        continue;
      }

      // 列表（无序）
      if (/^\s*[-*+]\s+/.test(line)) {
        flushParagraph(para);
        var ul = [];
        while (i < n && /^\s*[-*+]\s+/.test(lines[i])) { ul.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
        out.push('<ul>' + ul.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ul>');
        continue;
      }

      // 列表（有序）
      if (/^\s*\d+\.\s+/.test(line)) {
        flushParagraph(para);
        var ol = [];
        while (i < n && /^\s*\d+\.\s+/.test(lines[i])) { ol.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
        out.push('<ol>' + ol.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ol>');
        continue;
      }

      // 表格（表头 + 分隔行 + 数据行）
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < n && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flushParagraph(para);
        var splitRow = function (r) {
          return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
        };
        var header = splitRow(line);
        i += 2;
        var rows = [];
        while (i < n && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        out.push(
          '<table><thead><tr>' + header.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead>' +
          '<tbody>' + rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table>'
        );
        continue;
      }

      // 空行 → 段落分隔
      if (/^\s*$/.test(line)) { flushParagraph(para); i++; continue; }

      // 普通行 → 段落累积
      para.push(line.replace(/^\s+|\s+$/g, ''));
      i++;
    }
    flushParagraph(para);

    return out.join('\n');
  }

  // ---------- 复制按钮事件（自包含，document 级委托） ----------

  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.md-copy') : null;
      if (!btn) return;
      var block = btn.closest('.md-codeblock');
      var codeEl = block && block.querySelector('code');
      if (!codeEl) return;
      var text = codeEl.textContent || '';
      function done(ok) {
        btn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(function () { btn.textContent = '复制'; }, 1500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done(true);
        } catch (err) { done(false); }
      }
    });
  }

  return { mdToHtml: mdToHtml, sanitizeHtml: sanitizeHtml, highlight: highlight };
});
