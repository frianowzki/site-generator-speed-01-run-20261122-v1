// solve.js v1 — faster drop-in for makefun-site 1.0.0.
// Faithful reimplementation of the reference pipeline (README.md is the spec,
// index.js/lib/*.js is the reference where they differ), fused and de-allocated:
//  - Markdown lex+render in one pass, no token array, inline writes into one parts array
//  - escapeHtml scans char codes and pushes chunks, never a regex per character
//  - slugify has an ASCII fast path and a per-build cache (titles/tags/headings repeat)
//  - front matter is parsed from the small header slice only; the body is never split+rejoined
//  - reading_minutes / date_long / card objects are computed once per source and cached
//  - templates render into a parts array instead of string += per node
// No module-level cache: every cache lives inside one build() call, so nothing
// is carried from one case to the next. Dependency-free ES module.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Append s to out[] with & < > " ' escaped. One native regex scan replaces
// the per-character JS loop: for the long strings this is called on (fence
// lines, code spans, template values) the regex finds the next escapable
// character in C++ instead of testing every char in JS. escAppend never
// re-enters itself, so sharing one global regex is safe (lastIndex is
// reset on every call).
const ESC_RE = /[&<>"']/g;
function escAppend(out, s) {
  let start = 0;
  ESC_RE.lastIndex = 0;
  let m;
  while ((m = ESC_RE.exec(s)) !== null) {
    if (m.index > start) out.push(s.slice(start, m.index));
    out.push(ESCAPES[m[0]]);
    start = m.index + 1;
  }
  if (start < s.length) out.push(s.slice(start));
}

function escStr(s) {
  const out = [];
  escAppend(out, s);
  return out.join('');
}

// Single-character escape (inline fast path): returns the escaped form of c,
// which is one character; c is never a multi-char string here.
function escChar(c) {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  if (c === "'") return '&#39;';
  return c;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The slug of text, exactly as lib/text.js: NFKD, combining marks dropped,
// A-Z lowered, each run of non [a-z0-9] one '-', none at either end, max 64
// (a '-' left at the cut dropped), 'untitled' when nothing is left.
function slugifyRaw(text) {
  if (/[^\x00-\x7F]/.test(text)) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDateRaw(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Words: runs of characters other than whitespace. A tight char-code loop
// instead of match(): match() allocates one ~400-element array per body
// (1070 bodies per set), and the allocation + GC cost more than the scan.
// The whitespace set is exactly JS \s: ASCII tab/LF/VT/FF/CR/space, plus
// the Unicode spaces (U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029,
// U+202F, U+205F, U+3000, U+FEFF). Every other code unit, including
// control characters and surrogate halves, is a word character.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws = false;
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) ws = true;
    else if (c > 127) ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  let closeIdx = -1;
  let closeEnd = -1;
  let search = nl;
  while (true) {
    const idx = text.indexOf('\n---', search);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text[after] === '\n') {
      closeIdx = idx;
      closeEnd = after;
      break;
    }
    search = idx + 1;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(nl + 1, closeIdx);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd < text.length && text[closeEnd] === '\n' ? text.slice(closeEnd + 1) : '';
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
// Next character that needs handling in inline text. One native regex scan
// replaces a per-character JS loop over plain runs; lastIndex is set before
// every exec, so recursion into inlineTo cannot corrupt the caller's search.
const SPECIAL_RE = /[\\`*\[&<>"']/g;

// Fast line classifiers. The reference uses a regex per line for blank /
// fence / heading / hr / list tests; on ~45k lines per set that is a large
// share of Markdown time. These are exact equivalents of those regexes,
// checked character by character (spaces/tabs only where the regex says so).

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

// The fence language, or null: /^```([A-Za-z0-9_+-]*)[ \t]*$/
function fenceOpenOf(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      lang += line[i];
      i++;
    } else if (c === 32 || c === 9) break;
    else return null;
  }
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

// /^```[ \t]*$/
function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  if (line.charCodeAt(n) !== 32 && line.charCodeAt(n) !== 9) return null;
  let s = n;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: n, text: line.slice(s, e) };
}

// /^(?:---|\*\*\*)[ \t]*$/
function isHR(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Does this line end a paragraph? Exact equivalent of
// isBlank || fenceOpenOf !== null || headingOf !== null || isHR, but fused
// into one first-character dispatch: a blank line can only start with
// space/tab (or be empty), a fence with `, a heading with #, an HR with
// - or *. Any other first character ends none of the four tests, so the
// paragraph loop no longer pays four function calls and scans per line.
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceOpenOf(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  return false;
}

// /^[-*] (.*)$/ — the item text, or null.
function bulletOf(line) {
  if (line.length >= 2 && (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

// /^(\d{1,9})\. (.*)$/ — { num, text }, or null.
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

// /^ {2,}\S/
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  const c = line.charCodeAt(i);
  return c !== 32 && c !== 9 && c !== 11 && c !== 12 && c !== 13;
}

// Is the character at p escaped by a backslash? The reference scan walks
// from `from`, consuming `\X` pairs (X escapable) left to right, so a run of
// k backslashes immediately before p escapes p exactly when k is odd (the
// backslashes pair up; a leftover one pairs with p). Count only the run at
// or after `from`, since the scan starts there.
function isEscapedAt(s, p, from) {
  let k = 0;
  for (let j = p - 1; j >= from && s[j] === '\\'; j--) k++;
  return k % 2 === 1;
}

function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscapedAt(s, j, from)) j = s.indexOf(what, j + 1);
  return j;
}

function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscapedAt(s, j, from)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      // The reference scan skips BOTH stars of a "**" pair (its j++ inside
      // the loop plus the loop's own j++), so the second star is never
      // returned as a lone star; resume after the pair.
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

// Inline render into out[] (no intermediate strings for nested strong/em/link:
// the nested content is rendered straight into the same parts array).
function inlineTo(out, s, env) {
  let i = 0;
  const len = s.length;
  while (i < len) {
    const c = s[i];
    if (c === '\\' && i + 1 < len && ESCAPABLE.has(s[i + 1])) {
      out.push(escChar(s[i + 1]));
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push('<code>');
        escAppend(out, s.slice(i + 1, j));
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push('<strong>');
          inlineTo(out, s.slice(i + 2, j), env);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out.push('<em>');
        inlineTo(out, s.slice(i + 1, j), env);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        escAppend(out, env.link(target));
        out.push('">');
        inlineTo(out, s.slice(i + 1, k), env);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out.push(escChar(c));
      i++;
      continue;
    }
    // Plain run: up to the next character that needs handling (native scan).
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const j = m === null ? len : m.index;
    out.push(s.slice(i, j));
    i = j;
  }
}

function inlineStr(s, env) {
  const out = [];
  inlineTo(out, s, env);
  return out.join('');
}

// Render one body: its HTML, toc (level 2/3 headings) and excerpt (first
// paragraph's inline HTML). slug is the per-build cached slugify.
function renderMarkdown(src, env, slug) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpenOf(line);
    if (lang !== null) {
      const parts = [];
      parts.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${escStr(lang)}">`);
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        escAppend(parts, lines[i]);
        parts.push('\n');
        i++;
      }
      i++;
      parts.push('</code></pre>');
      blocks.push(parts.join(''));
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slug(heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') body.push(t);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(body.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bulletText = bulletOf(line);
    const ordered = bulletText === null ? orderedOf(line) : null;
    if (bulletText !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let start = 1;
      if (isOrdered) start = ordered.num;
      while (i < n) {
        const cur = lines[i];
        let t;
        if (isOrdered) {
          const o = orderedOf(cur);
          t = o === null ? null : o.text;
        } else {
          t = bulletOf(cur);
        }
        if (t !== null) {
          items.push([trimLine(t)]);
          i++;
        } else if (isContinued(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const parts = [];
      parts.push(open);
      parts.push('\n');
      for (const item of items) {
        parts.push('<li>');
        inlineTo(parts, item.join('\n'), env);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// For each template, the root names it reads from its scope (transitively
// through includes), excluding names bound by its own for-loops. A template
// whose includes form a cycle gets null (uncacheable): its rendered output
// could then depend on the cycle's entry point, which a key cannot capture.
// With this set, an include's rendered string depends only on the looked-up
// values of those roots (plus its include depth), so it can be cached by
// (name, depth, root values). Objects are keyed by identity via a WeakMap;
// the pipeline never mutates a looked-up value object after it is built
// (cards, pages, tags), so identity implies identical content. The loop
// frame itself is mutated per iteration, but 'loop' is excluded from every
// template's uses, so it never enters a cache key. A fresh object with
// identical content only costs a cache miss, never a wrong hit.
function computeUses(templates) {
  const memo = new Map();
  const visiting = new Set();
  function usesOf(name) {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return null;
    const nodes = templates.get(name);
    if (nodes === undefined) return new Set();
    visiting.add(name);
    const uses = new Set();
    let bad = false;
    const walk = (ns, bound) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) uses.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) uses.add(n.path[0]);
          walk(n.then, bound);
          if (n.else) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) uses.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') {
          const u = usesOf(n.name);
          if (u === null) bad = true;
          else for (const x of u) uses.add(x);
        }
      }
    };
    walk(nodes, new Set());
    visiting.delete(name);
    const res = bad ? null : uses;
    memo.set(name, res);
    return res;
  }
  const out = new Map();
  for (const name of templates.keys()) out.set(name, usesOf(name));
  return out;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        // textOf inlined: strings/numbers/booleans are the common case, and
        // skipping the textOf call per variable is worth ~a few ms per set.
        const v = lookup(scope, n.path);
        if (typeof v === 'string') escAppend(out, v);
        else if (typeof v === 'number') escAppend(out, String(v));
        else if (v === true) out.push('true');
        else if (v === false) out.push('false');
        else if (Array.isArray(v)) escAppend(out, v.map(textOf).join(', '));
        break;
      }
      case 'raw': {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') out.push(v);
        else if (typeof v === 'number') out.push(String(v));
        else if (v === true) out.push('true');
        else if (v === false) out.push('false');
        else if (Array.isArray(v)) out.push(v.map(textOf).join(', '));
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One vars/loop/scope trio reused across iterations instead of three
        // fresh objects per item: rendering is fully synchronous and templates
        // never store a scope, so nothing can observe the reuse. A nested
        // for-loop (or a re-entrant include) builds its own trio.
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          vars.loop = loop;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          const uses = ctx.uses.get(n.name);
          if (uses !== null && uses !== undefined) {
            const parts = [n.name, 'd' + depth];
            for (const root of uses) {
              const v = lookup(scope, [root]);
              if (v !== null && typeof v === 'object') {
                let id = ctx.objIds.get(v);
                if (id === undefined) {
                  id = ++ctx.nextId;
                  ctx.objIds.set(v, id);
                }
                parts.push(root + '#obj' + id);
              } else {
                parts.push(root + '=' + JSON.stringify(v));
              }
            }
            const key = parts.join('\u0000');
            const hit = ctx.cache.get(key);
            if (hit !== undefined) {
              out.push(hit);
              break;
            }
            const sub = [];
            renderNodes(t, scope, ctx, depth + 1, sub);
            const str = sub.join('');
            ctx.cache.set(key, str);
            out.push(str);
          } else {
            renderNodes(t, scope, ctx, depth + 1, out);
          }
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- Build

const RESERVED = ['posts', 'tags', 'page'];

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function run(input) {
  return build(input);
}

function build(input) {
  const slugCache = new Map();
  const slug = (t) => {
    let v = slugCache.get(t);
    if (v === undefined) {
      v = slugifyRaw(t);
      slugCache.set(t, v);
    }
    return v;
  };
  const dateCache = new Map();
  const longDate = (d) => {
    let v = dateCache.get(d);
    if (v === undefined) {
      v = longDateRaw(d);
      dateCache.set(d, v);
    }
    return v;
  };

  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();
  const bySource = new Map();

  // 1. Sources, sorted by path in code-unit order; .md is a source, else static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    // Only ~5% of generated sources contain \r; the regex replace allocates
    // a fresh copy of every body, so skip it when no \r is present.
    if (f.path.endsWith('.md')) {
      const raw = f.content;
      sources.push({ path: f.path, text: raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in the reference's check order; first failure is reported.
  {
    const kept = [];
    for (const s of sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own;
      for (const d of RESERVED) {
        if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
          own = d;
          break;
        }
      }
      if (own !== undefined) {
        report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!templates.has(layout)) {
        report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    sources = kept;
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  {
    const taken = new Map();
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      let set = taken.get(dir);
      if (set === undefined) {
        set = new Set(dir === '' ? RESERVED : []);
        taken.set(dir, set);
      }
      const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
      s.slug = sl;
      s.outDir = dir === '' ? sl : `${dir}/${sl}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Markdown, links resolved to pages and static files.
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    for (const s of sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, slug);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, ordered by count then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const names2 = s.data.tags ?? [];
    for (const name of names2) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push({ name, slug: sl });
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug: sl } of ownTags(p)) {
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(({ name, slug: sl }) => bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards / pages as templates read them; each card is built once.
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: every page, the index pages, the tag pages, then statics.
  {
    const cards = new Map(posts.map((p) => [p, cardOf(p)]));
    const site = { title: input.site.title, base_url: base };
    const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
    const ctx = { templates, uses: computeUses(templates), cache: new Map(), objIds: new WeakMap(), nextId: 0 };
    const render = (name, vars) => {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      const out = [];
      renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
      return out.join('');
    };
    for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of tags) {
      const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
      if (html !== null) output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
    for (const f of statics) {
      if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
      else output[f.path] = f.content;
    }
  }

  // 8. Report: every line reported above and each broken link, sorted, then counts.
  {
    const lines = [...report, ...broken].sort(byCodeUnits);
    const pages = sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
    output['build-report.txt'] = `${lines.join('\n')}\n`;
  }

  return output;
}
