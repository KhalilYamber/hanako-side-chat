// assets/markdown.js —— 极简 markdown 渲染管线（三段式：escape→parse→sanitize）
// 手写实现，无外部依赖。UMD：浏览器挂 window.MD，node 下 module.exports。
// 语法：标题 1-6 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块(语言+复制按钮) /
//       引用块 / 有序无序列表(嵌套一层) / 链接 / 表格 / 水平线 / 段落
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
    // 链接优先（避免 [x](y) 内粗体误解析）
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (_, label, url) {
      return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + inlineInner(label) + '</a>';
    });
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
        var codeHtml = escapeHtml(code.join('\n'));
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

  return { mdToHtml: mdToHtml, sanitizeHtml: sanitizeHtml };
});
