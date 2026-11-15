// parse.js — a fast drop-in for marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29).
// Hand-written from the CommonMark spec and marked's documented behavior.
// Renders directly to HTML strings; no token trees are built for inline content.
//
// Entry: export function parse(markdown) -> HTML string, identical to
// marked.parse(markdown) with marked's defaults (gfm on, breaks off).

// ---------- small helpers ----------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESC = /[&<>"']/g;
const RE_ESC_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_ESC_NOENC_T = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

// Escape HTML. encode=true escapes & < > " ' ; false leaves valid entities alone.
function esc(s, encode) {
  if (encode) return s.replace(RE_ESC, (c) => ESC_MAP[c]);
  return s.replace(RE_ESC_NOENC, (c) => (c === '&' ? '&amp;' : ESC_MAP[c]));
}

const RE_NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUMREF_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
// Decode numeric character references in inline text; bare & becomes &amp;.
function decodeEntities(s) {
  if (!RE_NUMREF.test(s)) return s;
  return s.replace(RE_NUMREF_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    return cp === 38 ? '&amp;' : String.fromCodePoint(cp);
  });
}

// Clean a URL the way marked does: encodeURI, then restore %25 to %.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes; trim cells; pad/truncate to count.
function splitCells(row, count) {
  const parts = row.replace(/\|/g, (m, off, str) => {
    let back = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) back = !back;
    return back ? '|' : ' |';
  }).split(' |');
  if (parts.length && !parts[0].trim()) parts.shift();
  if (parts.length && !parts[parts.length - 1].trim()) parts.pop();
  if (count !== undefined) {
    if (parts.length > count) parts.length = count;
    while (parts.length < count) parts.push('');
  }
  for (let i = 0; i < parts.length; i++) parts[i] = parts[i].trim().replace(/\\\|/g, '|');
  return parts;
}

// Strip `ch` chars from the end of s (like marked's trailing-char trim).
function stripEnd(s, ch, not) {
  let n = s.length, k = 0;
  if (not) { while (k < n && s.charAt(n - k - 1) !== ch) k++; }
  else { while (k < n && s.charAt(n - k - 1) === ch) k++; }
  return s.slice(0, n - k);
}

// Expand tabs to spaces given a starting column.
function expandTabs(s, col) {
  let out = '', c = col || 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\t') {
      const w = 4 - (c % 4);
      out += '    '.slice(0, w);
      c += w;
    } else {
      out += s[i];
      c++;
    }
  }
  return out;
}

// Normalize a link reference label: collapse whitespace, case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the unmatched closing paren in a link destination.
// Returns -1 balanced, -2 too many opens, else the index of the bad close.
function parenClose(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Trim trailing blank lines the way marked does (keeps at most one blank line
// plus the final newline structure): drop trailing blank lines beyond two.
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// ---------- regexes (block) ----------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const RE_SPACE = /^(?:[ \t]*(?:\n|$))+/;
const RE_INDENTED_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;

// HTML block (CommonMark types 1-7), GFM flavour.
const RE_HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const RE_HTML_BLOCK = new RegExp(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
  '|comment[^\\n]*(\\n+|$)' +
  '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
  '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
  '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
  '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .source.replace('comment', RE_HTML_COMMENT.source).replace(/tag/g, BLOCK_TAGS).replace(/attribute/g, HTML_ATTR.source);
const RE_HTML = new RegExp(RE_HTML_BLOCK, 'i');

// Can a line start an HTML block (used to interrupt a paragraph)?
const RE_HTML_BEGIN = new RegExp(
  `^ {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');

// Link reference definition.
const RE_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const RE_TITLE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const RE_DEF = new RegExp(
  `^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)`
    .replace('label', RE_LABEL.source).replace('title', RE_TITLE.source));

// GFM table.
const RE_TABLE = new RegExp(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)'
    .replace('hr', RE_HR.source)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('blockquote', ' {0,3}>')
    .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`));

// Setext heading + paragraph patterns are built in the next section with sub()
// because they compose several sub-patterns (list/fence/blockquote/table stops).

// ---------- regex composition ----------
// Like a tiny template engine: replace each key (string or /g regex) in the
// template with the replacement's source, stripping leading ^ anchors from
// replacements so they compose mid-pattern. Keys are replaced in order.
function sub(tpl, map, flags) {
  let s = typeof tpl === 'string' ? tpl : tpl.source;
  const f = flags !== undefined ? flags : (typeof tpl === 'object' ? tpl.flags : '');
  for (const [k, v] of map) {
    const rep = (typeof v === 'string' ? v : v.source).replace(/(^|[^\[\\])\^/g, '$1');
    s = s.replace(k, () => rep);
  }
  return new RegExp(s, f);
}

const RE_HR_SRC = RE_HR.source;
const RE_HR_NC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const RE_HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const RE_HTML_BEGIN_SRC = ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;
const RE_FENCES_BEGIN_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const RE_BQUOTE_SRC = ' {0,3}>';

// Paragraph body (CommonMark): lines that do not start a new block.
const AE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const RE_PARA = sub(AE, [
  ['hr', RE_HR_NC],
  ['heading', RE_HEADING_SRC],
  ['|lheading', ''],
  ['table', RE_TABLE],
  ['blockquote', RE_BQUOTE_SRC],
  ['fences', RE_FENCES_BEGIN_SRC],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
  ['html', RE_HTML_BEGIN_SRC],
  ['tag', BLOCK_TAGS],
]);

// Setext heading (GFM flavour).
const OE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const RE_LHEADING = sub(OE, [
  [/bull /g, ' {0,3}(?:[*+-]|\\d{1,9}[.)])'],
  [/blockCode/g, '(?: {4}| {0,3}\\t)'],
  [/fences/g, ' {0,3}(?:`{3,}|~{3,})'],
  [/blockquote/g, RE_BQUOTE_SRC],
  [/heading/g, RE_HEADING_SRC],
  [/hr/g, RE_HR_NC],
  [/html/g, ' {0,3}<[^\\n>]+>\\n'],
  [/table/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n'],
]);

// Paragraph used inside blockquote matching (list stops are looser there).
const RE_PARA_BQ = sub(AE, [
  ['hr', RE_HR_NC],
  ['heading', RE_HEADING_SRC],
  ['|lheading', ''],
  ['|table', ''],
  ['blockquote', RE_BQUOTE_SRC],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'],
  ['html', RE_HTML_BEGIN_SRC],
  ['tag', BLOCK_TAGS],
]);
const RE_BQUOTE = sub(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/, [
  ['paragraph', RE_PARA_BQ],
]);

// List start: optional indent + bullet/ordered marker + rest of first line.
const RE_LIST_START = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const RE_LIST_ITEM = (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`);
// marked's D() memoizer clamps the indent: n -> max(0, min(3, n-1)), and caches
// the 4 variants. We precompute the same 4 variants at load so list() never
// compiles a RegExp per item.
const clampN = (n) => Math.max(0, Math.min(3, n - 1));
const _mkN = (f) => [0, 1, 2, 3].map((n) => f(n));
const _NB = _mkN((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`));
const _HRN = _mkN((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`));
const _FEN = _mkN((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const _HDN = _mkN((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const _HTN = _mkN((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const _BQN = _mkN((n) => new RegExp(`^ {0,${n}}>`));
const RE_NEXT_BULLET = (n) => _NB[clampN(n)];
const RE_HR_N = (n) => _HRN[clampN(n)];
const RE_FENCES_BEGIN_N = (n) => _FEN[clampN(n)];
const RE_HEADING_N = (n) => _HDN[clampN(n)];
const RE_HTML_BEGIN_N = (n) => _HTN[clampN(n)];
const RE_BQUOTE_N = (n) => _BQN[clampN(n)];

const RE_TEXT = /^[^\n]+/;
const RE_BLANK = /^[ \t]*$/;
const RE_DBLANK = /\n[ \t]*\n[ \t]*$/;
const RE_ANYLINE = /\n.*\n/;
const RE_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const RE_CHECKBOX = /\[[ xX]\]/;
const RE_LEADING_WS_TAB = /^[ \t]+/;
const RE_NONSPACE = /[^ ]/;
const RE_BEGIN_SPACE = /^\s+/;
const RE_FENCE_INDENT = /^(\s+)(?:```)/;
const RE_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_STRIP = /^ {0,3}>[ \t]?/gm;
const RE_LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_TABLE_ALIGN_R = /^ *-+: *$/;
const RE_TABLE_ALIGN_C = /^ *:-+: *$/;
const RE_TABLE_ALIGN_L = /^ *:-+ *$/;
const RE_TABLE_ALIGN_STRIP = /^\||\| *$/g;
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_START_ATAG = /^<a(?=[\s>])/i;
const RE_END_ATAG = /^<\/a>/i;
const RE_START_PRE = /^<(?:pre|script|style)(?:\s|>)/i;
const RE_END_PRE = /^<\/(?:pre|script|style)>/i;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;
const RE_ENDING_HASH = /#$/;
const RE_ENDING_SPACE = / $/;
const RE_START_SPACE = /^ /;
const RE_NOT_SPACE_START = /^\S*/;
const RE_END_NEWLINE = /\n$/;
const RE_SPACE_LINE = /^ +$/gm;
const RE_TAB_GLOBAL = /\t/g;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

// ---------- block lexer ----------
// Tokens are plain objects: {type, raw, ...}. Inline sources are kept as
// `text` and rendered later, once every link definition is known.

const RE_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapePunct(s) {
  return s.replace(RE_ANY_PUNCT, '$1');
}

class BlockLexer {
  constructor() {
    this.links = Object.create(null);
    this.state = { top: true, inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  }

  space(src) {
    const m = RE_SPACE.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return undefined;
  }

  indentedCode(src) {
    const m = RE_INDENTED_CODE.exec(src);
    if (!m) return undefined;
    const raw = trimTrailingBlanks(m[0]);
    const text = raw.replace(RE_CODE_INDENT, '');
    return { type: 'code', raw, text, lang: undefined };
  }

  fences(src) {
    const m = RE_FENCES.exec(src);
    if (!m) return undefined;
    const raw = m[0];
    let text = m[3] || '';
    // Indent compensation: strip the opening fence's indent from code lines.
    const ind = raw.match(RE_FENCE_INDENT);
    if (ind) {
      const w = ind[1].length;
      text = text.split('\n').map((line) => {
        const lead = line.match(RE_BEGIN_SPACE);
        if (!lead) return line;
        return line.slice(Math.min(lead[0].length, w));
      }).join('\n');
    }
    const lang = m[2] ? unescapePunct(m[2].trim()) : m[2];
    return { type: 'code', raw, text, lang };
  }

  heading(src) {
    const m = RE_ATX.exec(src);
    if (!m) return undefined;
    let text = m[2].trim();
    if (RE_ENDING_HASH.test(text)) {
      const stripped = stripEnd(text, '#');
      if (!stripped || RE_ENDING_SPACE.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: stripEnd(m[0], '\n'), depth: m[1].length, text };
  }

  hr(src) {
    const m = RE_HR.exec(src);
    if (!m) return undefined;
    return { type: 'hr', raw: stripEnd(m[0], '\n') };
  }

  blockquote(src) {
    const m = RE_BQUOTE.exec(src);
    if (!m) return undefined;
    const rawAll = stripEnd(m[0], '\n');
    const lines = rawAll.split('\n');
    let raw = '', text = '';
    const tokens = [];
    let rest = lines;
    while (rest.length > 0) {
      let i = 0, hasMarker = false;
      const group = [];
      for (; i < rest.length; i++) {
        if (RE_BQ_START.test(rest[i])) { group.push(rest[i]); hasMarker = true; }
        else if (!hasMarker) group.push(rest[i]);
        else break;
      }
      rest = rest.slice(i);
      const joined = group.join('\n');
      const stripped = joined
        .replace(RE_BQ_MARKER_WS, (g, p1, p2) => p1 + expandTabs(p2, p1.length))
        .replace(RE_BQ_SETEXT, '\n    $1')
        .replace(RE_BQ_STRIP, '');
      raw = raw ? raw + '\n' + joined : joined;
      text = text ? text + '\n' + stripped : stripped;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(stripped, tokens, true);
      this.state.top = savedTop;
      if (rest.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (!last) break;
      if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
      if (last.type === 'blockquote') {
        const bq = last;
        const combined = bq.raw + '\n' + rest.join('\n').replace(RE_BQ_STRIP, '');
        const inner = this.blockquote(combined);
        tokens[tokens.length - 1] = inner;
        const after = combined.substring(inner.raw.length).replace(/^\n/, '');
        const nLines = after ? after.split('\n').length : 0;
        const consumed = nLines ? rest.slice(0, rest.length - nLines) : rest;
        if (consumed.length > 0) {
          raw = raw + '\n' + consumed.join('\n');
          text = text.substring(0, text.length - bq.text.length) + inner.text;
          rest = rest.slice(consumed.length);
        }
        if (rest.length > 0 && RE_BQ_START.test(rest[0])) continue;
        break;
      }
      if (last.type === 'list') {
        const lst = last;
        const combined = lst.raw + '\n' + rest.join('\n');
        const inner = this.list(combined);
        tokens[tokens.length - 1] = inner;
        const extra = inner.raw.length > lst.raw.length ? combined.slice(lst.raw.length + 1, inner.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const added = rest.slice(0, extra).join('\n');
          raw = raw + '\n' + added;
          text = text + '\n' + added;
        }
        rest = rest.slice(extra);
        continue;
      }
      // Last token was paragraph/text/space: lazy continuation lines follow;
      // fall through to the next group (marked's loop just continues).
    }
    return { type: 'blockquote', raw, text, tokens };
  }

  list(src) {
    const m = RE_LIST_START.exec(src);
    if (!m) return undefined;
    const src0 = src;
    const marker = m[1].trim();
    const ordered = marker.length > 1;
    const listObj = {
      type: 'list', raw: '', ordered,
      start: ordered ? +marker.slice(0, -1) : 0,
      loose: false, items: [],
    };
    const bullPat = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRe = RE_LIST_ITEM(bullPat);
    let prevDoubleBlank = false;
    let rest = src;
    while (rest) {
      let emptyItem = false;
      const t = itemRe.exec(rest);
      if (!t || RE_HR.test(rest)) break;
      const itemStart = src0.length - rest.length;
      rest = rest.substring(t[0].length);
      let first = t[2].split('\n', 1)[0];
      const markerLen = t[1].length;
      let content = first.replace(RE_LEADING_WS_TAB, (v) => expandTabs(v, markerLen));
      let nextLine = rest.split('\n', 1)[0];
      const isEmpty = !content.trim();
      let indent;
      if (isEmpty && RE_BLANK.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        let bodyParts;
        let prev;
        if (isEmpty) {
          indent = markerLen + 1;
          bodyParts = [];
          prev = '';
        } else {
          const at = content.search(RE_NONSPACE);
          indent = at > 4 ? 1 : at;
          bodyParts = [content.slice(indent)];
          indent += markerLen;
          prev = bodyParts[0];
        }
        const nextBull = RE_NEXT_BULLET(indent);
        const hrRe = RE_HR_N(indent);
        const fenRe = RE_FENCES_BEGIN_N(indent);
        const headRe = RE_HEADING_N(indent);
        const htmlRe = RE_HTML_BEGIN_N(indent);
        const bqRe = RE_BQUOTE_N(indent);
        let blank = isEmpty;
        while (rest) {
          const line = rest.split('\n', 1)[0];
          const expanded = line.replace(RE_LEADING_WS_TAB, (v) => expandTabs(v));
          if (fenRe.test(line) || headRe.test(line) || htmlRe.test(line) || bqRe.test(line) || nextBull.test(line) || hrRe.test(line)) break;
          if (expanded.search(RE_NONSPACE) >= indent || !line.trim()) {
            bodyParts.push(expanded.slice(indent));
          } else {
            if (blank || prev.replace(RE_TAB_GLOBAL, '    ').search(RE_NONSPACE) >= 4 || fenRe.test(prev) || headRe.test(prev) || htmlRe.test(prev) || hrRe.test(prev)) break;
            if (/^ {0,3}(?:=+|-+) *$/.test(line) && RE_LHEADING.test(prev + '\n' + line)) {
              bodyParts.push('    ' + expanded.replace(/^ {0,3}/, ''));
            } else {
              bodyParts.push(line);
            }
          }
          blank = !line.trim();
          rest = rest.substring(line.length + 1);
          prev = expanded.slice(indent);
        }
        const itemRaw = src0.slice(itemStart, src0.length - rest.length);
        if (!listObj.loose) {
          if (prevDoubleBlank) listObj.loose = true;
          else if (RE_DBLANK.test(itemRaw)) prevDoubleBlank = true;
        }
        listObj.items.push({
          type: 'list_item', raw: itemRaw, task: false, checked: false,
          loose: false, text: bodyParts.join('\n'), tokens: [],
        });
      } else {
        const itemRaw = src0.slice(itemStart, src0.length - rest.length);
        if (!listObj.loose) {
          if (prevDoubleBlank) listObj.loose = true;
          else if (RE_DBLANK.test(itemRaw)) prevDoubleBlank = true;
        }
        listObj.items.push({
          type: 'list_item', raw: itemRaw, task: false, checked: false,
          loose: false, text: '', tokens: [],
        });
      }
    }
    const lastItem = listObj.items[listObj.items.length - 1];
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    listObj.raw = src0.slice(0, src0.length - rest.length).trimEnd();
    for (const item of listObj.items) {
      const savedTop = this.state.top;
      this.state.top = false;
      this.blockTokens(item.text, item.tokens);
      this.state.top = savedTop;
      if (!listObj.loose) {
        const spaces = item.tokens.filter((tok) => tok.type === 'space');
        if (spaces.length > 0 && spaces.some((tok) => RE_ANYLINE.test(tok.raw))) listObj.loose = true;
      }
    }
    // Task lists: strip the marker, record checked, insert a checkbox token.
    // A checkbox only appears when the first block token is text/paragraph.
    for (const item of listObj.items) {
      if (!RE_TASK.test(item.text)) continue;
      const first = item.tokens[0];
      if (!first || (first.type !== 'text' && first.type !== 'paragraph')) continue;
      item.task = true;
      item.text = item.text.replace(RE_TASK_STRIP, '');
      first.raw = first.raw.replace(RE_TASK_STRIP, '');
      first.text = first.text.replace(RE_TASK_STRIP, '');
      const cb = RE_CHECKBOX.exec(item.raw);
      if (!cb) { item.task = false; continue; }
      item.checked = cb[0] !== '[ ]';
      const box = { type: 'checkbox', raw: cb[0] + ' ', checked: item.checked };
      if (listObj.loose) {
        first.prefix = box;
      } else {
        item.tokens.unshift(box);
      }
    }
    if (listObj.loose) {
      for (const item of listObj.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return listObj;
  }



  html(src) {
    const m = RE_HTML.exec(src);
    if (!m) return undefined;
    const raw = trimTrailingBlanks(m[0]);
    return { type: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' };
  }

  def(src) {
    const m = RE_DEF.exec(src);
    if (!m) return undefined;
    const tag = normLabel(m[1]);
    let s = m[2].trim();
    if (RE_START_ANGLE.test(s)) {
      if (!RE_END_ANGLE.test(s)) return undefined;
      const l = stripEnd(s.slice(0, -1), '\\');
      if ((s.length - l.length) % 2 === 0) return undefined;
    } else {
      const l = parenClose(m[2], '()');
      if (l === -2) return undefined;
      if (l > -1) {
        const h = 4 + m[1].length + l;
        m[2] = m[2].substring(0, l);
        m[0] = m[0].substring(0, h).trim();
        m[3] = '';
      }
    }
    const r = stripEnd(m[0].slice(0, -1), '\\');
    if ((m[0].length - r.length) % 2 === 0) return undefined;
    let o = m[2], i = '';
    i = m[3] ? m[3].slice(1, -1) : '';
    o = o.trim();
    if (RE_START_ANGLE.test(o)) o = o.slice(1, -1);
    return { type: 'def', raw: stripEnd(m[0], '\n'), tag, href: o && o.replace(RE_ANY_PUNCT, '$1'), title: i && i.replace(RE_ANY_PUNCT, '$1') };
  }

  table(src) {
    const m = RE_TABLE.exec(src);
    if (!m || !RE_TABLE_DELIM.test(m[2])) return undefined;
    const header = splitCells(m[1]);
    const alignsRaw = m[2].replace(RE_TABLE_ALIGN_STRIP, '').split('|');
    const rowsRaw = m[3] && m[3].trim() ? m[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
    const table = { type: 'table', raw: stripEnd(m[0], '\n'), header: [], align: [], rows: [] };
    if (header.length !== alignsRaw.length) return undefined;
    for (const cell of alignsRaw) {
      if (RE_TABLE_ALIGN_R.test(cell)) table.align.push('right');
      else if (RE_TABLE_ALIGN_C.test(cell)) table.align.push('center');
      else if (RE_TABLE_ALIGN_L.test(cell)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < header.length; i++) {
      table.header.push({ text: header[i], align: table.align[i], header: true });
    }
    for (const row of rowsRaw) {
      table.rows.push(splitCells(row, header.length).map((cell, i) => ({ text: cell, align: table.align[i] })));
    }
    return table;
  }

  lheading(src) {
    const m = RE_LHEADING.exec(src);
    if (!m) return undefined;
    return { type: 'heading', raw: stripEnd(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() };
  }

  paragraph(src) {
    const m = RE_PARA.exec(src);
    if (!m) return undefined;
    let text = m[1];
    if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
    return { type: 'paragraph', raw: m[0], text };
  }

  text(src) {
    const m = RE_TEXT.exec(src);
    if (!m) return undefined;
    return { type: 'text', raw: m[0], text: m[0] };
  }

  blockTokens(src, tokens, inBq = false) {
    let prevLen = Infinity;
    while (src) {
      if (src.length >= prevLen) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      prevLen = src.length;
      let tok;
      if ((tok = this.space(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.indentedCode(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.fences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.heading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.hr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.blockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.list(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.html(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.def(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
        } else {
          if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.table(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.lheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top) {
        const cut = inBq ? src : src;
        if ((tok = this.paragraph(cut))) {
          const last = tokens[tokens.length - 1];
          if (inBq && last && last.type === 'paragraph') {
            last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            last.text += '\n' + tok.text;
            src = src.substring(tok.raw.length);
          } else {
            tokens.push(tok);
            src = src.substring(tok.raw.length);
          }
          continue;
        }
      }
      if ((tok = this.text(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
        } else tokens.push(tok);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }
}
// ---------- chunk 4: inline lexer ----------
const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_SCHEME = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const RE_EMAIL = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const RE_EMAIL_BARE = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RE_OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const RE_PUNCT_SINGLE = /^((?![*_])[\s\p{P}\p{S}])/u;
const RE_ALNUM = /[\p{L}\p{N}]/u;
const RE_HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const RE_LINK_LABEL = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const RE_LABEL_T = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const RE_REF = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const RE_REF_BE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const RE_TITLE_INLINE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
const RE_LINK = sub(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/, [['label', RE_LINK_LABEL], ['href', RE_HREF], ['title', RE_TITLE_INLINE]]);
const RE_REFLINK = sub(/^!?\[(label)\]\[(ref)\]/, [['label', RE_LABEL_T], ['ref', RE_REF_BE]]);
const RE_NOLINK = sub(/^!?\[(ref)\](?:\[\])?/, [['ref', RE_REF_BE]]);
const RE_REFLINK_SEARCH = sub(/(?:reflink|nolink(?!\())/g, [['reflink', RE_REFLINK], ['nolink', RE_NOLINK]]);
const RE_URL_PROTO = sub(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, [[/email/g, RE_EMAIL_BARE]]);
const RE_URL = sub(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, [[/emailProtocol/g, RE_URL_PROTO], ['protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/], ['email', RE_EMAIL_BARE]]);
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_TAG = sub(/^comment|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/, [['comment', /<!--(?:-?>|[\s\S]*?-->)/], ['attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/]]);
const RE_AUTOLINK = sub(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, [['scheme', RE_SCHEME], ['email', RE_EMAIL]]);
const RE_ITEXT = sub(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/, [[/emailProtocol/g, /(?:mailto|xmpp):/], ['protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/], ['wwwStart', /(?<![^\s*_~(])www\./]]);
const RE_EM_L = sub(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?|^_+(?:((?!_)punct)|([^\s_]))?)/u, [[/punct/g, /[\p{P}\p{S}]/u]]);
const RE_EM_R_AST = sub(/^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)punct(\*+)(?=[\s]|$)|notPunctSpace(\*+)(?!\*)(?=punctSpace|$)|(?!\*)punctSpace(\*+)(?=notPunctSpace)|[\s](\*+)(?!\*)(?=punct)|(?!\*)punct(\*+)(?!\*)(?=punct)|notPunctSpace(\*+)(?=notPunctSpace)/gu, [[/notPunctSpace/g, /[^\s\p{P}\p{S}]/u], [/punctSpace/g, /[\s\p{P}\p{S}]/u], [/punct/g, /[\p{P}\p{S}]/u]]);
const RE_EM_R_UND = sub(/^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)/gu, [[/notPunctSpace/g, /[^\s\p{P}\p{S}]/u], [/punctSpace/g, /[\s\p{P}\p{S}]/u], [/punct/g, /[\p{P}\p{S}]/u]]);
const RE_DEL_L = sub(/^~~?(?:((?!~)punct)|[^\s~])/u, [[/punct/g, /[\p{P}\p{S}]/u]]);
const RE_DEL_R = sub(/^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)/gu, [[/notPunctSpace/g, /[^\s\p{P}\p{S}]/u], [/punctSpace/g, /[\s\p{P}\p{S}]/u], [/punct/g, /[\p{P}\p{S}]/u]]);
const RE_BLOCK_SKIP = sub(/link|precode-code|html/g, [['link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/], [/precode-/, /(?<!`)()/], ['code', /(?<b>`+)[^`]+\k<b>(?!`)/], ['html', /<(?! )[^<>]*?>/]]);
const RE_ANY_PUNCT_OUTSIDE_CODE = sub(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/gu, [[/punct/g, /[\p{P}\p{S}]/u]]);

function linkInText(e, links) {
  if (!e.includes('[')) return false;
  for (const n of e.matchAll(RE_BLOCK_SKIP)) {
    if (RE_LINK.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(RE_REFLINK_SEARCH)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

function maskSrc(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const repl = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (linkInText(i, links)) return '[' + i.replace(RE_REFLINK_SEARCH, repl) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(RE_REFLINK_SEARCH, repl);
  }
  t = t.replace(RE_ANY_PUNCT_OUTSIDE_CODE, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(RE_BLOCK_SKIP, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  return t;
}

function scanClosers(a) {
  const e = { '*': -1, '_': -1 };
  let t = -1;
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    while (i < n && a[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') t = s; else e[r] = s;
    }
    s = i - 1;
  }
  return { lastEm: e, lastDel: t };
}

function isLinkBeyond(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') { const i = RE_CODE.exec(label.slice(s)); if (i) { s += i[0].length - 1; continue; } }
    if (label[s] !== '<') continue;
    const r = src.slice(offset + s);
    const o = RE_TAG.exec(r) || RE_AUTOLINK.exec(r);
    if (o) { if (o[0].length > label.length - s) return true; s += o[0].length - 1; }
  }
  return false;
}

class InlineLexer {
  constructor(links) {
    this.links = links || Object.create(null);
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
    this.masked = '';
    this.scan = null;
  }

  inline(src, plain) {
    if (!src) return '';
    const saveLPP = this.state.linkParenPossible;
    const saveMasked = this.masked, saveScan = this.scan;
    this.state.linkParenPossible = saveLPP && src.includes(')');
    this.state.inRawBlock = false;
    const needMask = src.includes('*') || src.includes('_') || src.includes('~');
    this.masked = needMask ? maskSrc(src, this.links) : src;
    this.scan = scanClosers(this.masked);
    try {
      return this._inline(src, !!plain);
    } finally {
      this.state.linkParenPossible = saveLPP;
      this.masked = saveMasked; this.scan = saveScan;
    }
  }

  _textRun(rest, plain) {
    const m = RE_ITEXT.exec(rest);
    if (!m) return { html: '', len: 0, last: null };
    const raw = m[0];
    const last = raw.endsWith('_') ? null : raw.slice(-1);
    let html;
    if (this.state.inRawBlock) html = raw;
    else if (plain) html = decodeEntities(raw);
    else html = esc(decodeEntities(raw));
    return { html, len: raw.length, last };
  }

  _inline(src, plain) {
    let out = '', rest = src, prevChar = '', wasText = false, guard = Infinity;
    while (rest) {
      if (rest.length < guard) guard = rest.length;
      else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      if (!wasText) prevChar = '';
      wasText = false;
      const c = rest[0];
      let html = '', n = 0, last = null;
      if (c === '\\') {
        let m = RE_ESCAPE.exec(rest);
        if (m) { html = plain ? m[1] : esc(m[1]); n = m[0].length; }
        else if ((m = RE_BR.exec(rest))) { html = plain ? '' : '<br>'; n = m[0].length; }
        else { const t = this._textRun(rest, plain); html = t.html; n = t.len; last = t.last; wasText = true; }
      } else if (c === '`') {
        const m = RE_CODE.exec(rest);
        if (m) {
          let txt = m[2].replace(/\n/g, ' ');
          if (/\S/.test(txt) && /^ /.test(txt) && / $/.test(txt)) txt = txt.substring(1, txt.length - 1);
          html = plain ? txt : '<code>' + esc(txt, true) + '</code>';
          n = m[0].length;
        } else { const t = this._textRun(rest, plain); html = t.html; n = t.len; last = t.last; wasText = true; }
      } else if (c === '*' || c === '_') {
        const em = this._emStrong(rest, prevChar);
        if (em) {
          html = plain ? this.inline(em.inner, true) : '<' + em.tag + '>' + this.inline(em.inner, false) + '</' + em.tag + '>';
          n = em.raw.length;
        } else { const t = this._textRun(rest, plain); html = t.html; n = t.len; last = t.last; wasText = true; }
      } else if (c === '~') {
        const d = this._del(rest, prevChar);
        if (d) {
          html = plain ? this.inline(d.inner, true) : '<del>' + this.inline(d.inner, false) + '</del>';
          n = d.raw.length;
        } else { const t = this._textRun(rest, plain); html = t.html; n = t.len; last = t.last; wasText = true; }
      } else if (c === '[' || c === '!') {
        const lk = this._link(rest) || this._reflink(rest);
        if (lk) { html = this._renderLink(lk, plain); n = lk.raw.length; }
        else { const t = this._textRun(rest, plain); html = t.html; n = t.len; last = t.last; wasText = true; }
      } else if (c === '<') {
        const m = RE_TAG.exec(rest);
        if (m) {
          const tag = m[0];
          if (!this.state.inLink && RE_START_ATAG.test(tag)) this.state.inLink = true;
          else if (this.state.inLink && RE_END_ATAG.test(tag)) this.state.inLink = false;
          if (!this.state.inRawBlock && RE_START_PRE.test(tag)) this.state.inRawBlock = true;
          else if (this.state.inRawBlock && RE_END_PRE.test(tag)) this.state.inRawBlock = false;
          html = tag; n = tag.length;
        } else {
          const al = this._autolink(rest);
          if (al) { html = this._renderLink(al, plain); n = al.raw.length; }
          else { const t = this._textRun(rest, plain); html = t.html; n = t.len; last = t.last; wasText = true; }
        }
      } else {
        let u = null;
        if (c === ' ') {
          const b = RE_BR.exec(rest);
          if (b) { html = plain ? '' : '<br>'; n = b[0].length; }
        }
        if (!n && !this.state.inLink) u = this._url(rest);
        if (u) { html = this._renderLink(u, plain); n = u.raw.length; }
        else if (!n) { const t = this._textRun(rest, plain); html = t.html; n = t.len; last = t.last; wasText = true; }
      }
      if (!n) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      out += html;
      rest = rest.slice(n);
      if (wasText && last !== null) prevChar = last;
    }
    return out;
  }

  _emStrong(rest, prevChar) {
    const m = RE_EM_L.exec(rest);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
    const delim = m[0][0];
    const sameAsPrev = prevChar === delim;
    const masked = this.masked;
    const idx = masked.length - rest.length;
    let left = idx;
    while (left > 0 && masked[left - 1] === delim) left--;
    const beforeRun = left > 0 ? [...masked.slice(Math.max(0, left - 2), left)].at(-1) ?? '' : '';
    const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || RE_PUNCT_SINGLE.test(beforeRun);
    let n = prevChar;
    if (left < idx) n = beforeRun;
    const canOpen = left < idx ? beforeIsPunct : RE_PUNCT_SINGLE.test(n);
    if (m[4] && RE_ALNUM.test(n)) return null;
    const afterPunct = m[1] || m[3] || '';
    if (!afterPunct || !n || canOpen) {
      const k = [...m[0]].length - 1;
      let g, b, mm = k, f = 0;
      const y = idx - left + k;
      const R = !!beforeRun.trim() && (!!afterPunct || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return null;
      const closerRe = delim === '*' ? RE_EM_R_AST : RE_EM_R_UND;
      const lastCloser = this.scan.lastEm[delim];
      const Q = idx + k;
      if (lastCloser < Q) return null;
      const sliced = masked.slice(idx + k);
      const limit = lastCloser - Q;
      closerRe.lastIndex = 0;
      let s;
      while ((s = closerRe.exec(sliced)) !== null && !(s.index > limit)) {
        g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
        if (!g) continue;
        b = [...g].length;
        if (s[3] || s[4]) { mm += b; continue; }
        else if (s[5] || s[6] || R) {
          if (sameAsPrev && (s[5] || s[6])) break;
          if (y % 3 && !((y + b) % 3)) { f += b; continue; }
        }
        if ((mm -= b), mm > 0) continue;
        b = Math.min(b, b + mm + f);
        const te = [...s[0]][0].length;
        const raw = rest.slice(0, k + s.index + te + b);
        if (Math.min(k, b) % 2) return { raw, inner: raw.slice(1, -1), tag: 'em' };
        return { raw, inner: raw.slice(2, -2), tag: 'strong' };
      }
    }
    return null;
  }

  _del(rest, prevChar) {
    const m = RE_DEL_L.exec(rest);
    if (!m) return null;
    if (m[1] && prevChar && !RE_PUNCT_SINGLE.test(prevChar)) return null;
    const o = [...m[0]].length - 1;
    let p = o;
    const idx = this.masked.length - rest.length;
    const lastCloser = this.scan.lastDel;
    const d = idx + o;
    if (lastCloser < d) return null;
    const sliced = this.masked.slice(idx + o);
    const limit = lastCloser - d;
    RE_DEL_R.lastIndex = 0;
    let s;
    while ((s = RE_DEL_R.exec(sliced)) !== null && !(s.index > limit)) {
      const i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!i) continue;
      const l = [...i].length;
      if (l !== o) continue;
      if (s[3] || s[4]) { p += l; continue; }
      if ((p -= l), p > 0) continue;
      const ll = Math.min(l, l + p);
      const g = [...s[0]][0].length;
      const raw = rest.slice(0, o + s.index + g + ll);
      return { raw, inner: raw.slice(o, -o) };
    }
    return null;
  }

  _link(rest) {
    if (this.state.linkParenPossible === false) return null;
    const t = RE_LINK.exec(rest);
    if (!t) return null;
    const n = t[0].charAt(0) === '!' ? 2 : 1;
    if (isLinkBeyond(rest, t[1], n)) return null;
    const s = t[2].trim();
    if (RE_START_ANGLE.test(s)) {
      if (!RE_END_ANGLE.test(s)) return null;
      const l = stripEnd(s.slice(0, -1), '\\');
      if ((s.length - l.length) % 2 === 0) return null;
    } else {
      const l = parenClose(t[2], '()');
      if (l === -2) return null;
      if (l > -1) {
        const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
        t[2] = t[2].substring(0, l);
        t[0] = t[0].substring(0, h).trim();
        t[3] = '';
      }
    }
    const r = stripEnd(t[0].slice(0, -1), '\\');
    if ((t[0].length - r.length) % 2 === 0) return null;
    let o = t[2], i = '';
    i = t[3] ? t[3].slice(1, -1) : '';
    o = o.trim();
    if (RE_START_ANGLE.test(o)) o = o.slice(1, -1);
    return this._makeLink(t, { href: o && o.replace(RE_ANY_PUNCT, '$1'), title: i && i.replace(RE_ANY_PUNCT, '$1') }, t[0]);
  }

  _reflink(rest) {
    const n = RE_REFLINK.exec(rest) || RE_NOLINK.exec(rest);
    if (!n) return null;
    const s = n[0].charAt(0) === '!' ? 2 : 1;
    if (isLinkBeyond(rest, n[1], s)) return null;
    const r = this.links[normLabel(n[2] || n[1])];
    if (!r) return { type: 'text', raw: n[0].charAt(0), text: n[0].charAt(0) };
    return this._makeLink(n, r, n[0]);
  }

  _makeLink(a, e, raw) {
    const href = e.href, title = e.title || null;
    const text = a[1].replace(RE_OUTPUT_LINK_REPLACE, '$1');
    const isImage = a[0].charAt(0) === '!';
    const p = this.state.inLink, h = this.state.linkEmitted, u = this.state.inRawBlock;
    this.state.inLink = true; this.state.linkEmitted = false;
    const html = this.inline(text, false);
    const k = this.state.linkEmitted;
    this.state.linkEmitted = h; this.state.inLink = p;
    let plain = null;
    if (isImage) {
      const save = this.state.inLink; this.state.inLink = true;
      plain = this.inline(text, true);
      this.state.inLink = save;
    }
    if (!isImage) {
      if (k) { this.state.inRawBlock = u; return null; }
      this.state.linkEmitted = true;
    }
    return { type: isImage ? 'image' : 'link', raw, href, title, text, html, plain };
  }

  _autolink(rest) {
    const t = RE_AUTOLINK.exec(rest);
    if (!t) return null;
    let n, s;
    if (t[2] === '@') { n = t[1]; s = 'mailto:' + n; } else { n = t[1]; s = n; }
    return { type: 'link', raw: t[0], text: n, href: s, autolink: true };
  }

  _url(rest) {
    const t = RE_URL.exec(rest);
    if (!t) return null;
    let n, s;
    if (!/^(?:www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:)/i.test(t[0])) { n = t[0]; s = 'mailto:' + n; }
    else {
      let r;
      do { r = t[0]; t[0] = RE_BACKPEDAL.exec(t[0])?.[0] ?? ''; } while (r !== t[0]);
      n = t[0];
      s = t[0].startsWith('www.') ? 'http://' + t[0] : t[0];
    }
    return { type: 'link', raw: t[0], text: n, href: s, autolink: true };
  }

  _renderLink(lk, plain) {
    if (lk.type === 'text') return plain ? lk.text : esc(lk.text);
    if (plain) {
      if (lk.type === 'image') return lk.plain;
      const save = this.state.inLink; this.state.inLink = true;
      const out = this.inline(lk.text, true);
      this.state.inLink = save;
      return out;
    }
    if (lk.autolink) {
      const content = esc(lk.text, true);
      const href = cleanUrl(lk.href);
      if (href === null) return content;
      return `<a href="${esc(href, true)}">${content}</a>`;
    }
    if (lk.type === 'image') {
      const href = cleanUrl(lk.href);
      if (href === null) return esc(lk.plain);
      let o = `<img src="${esc(href)}" alt="${esc(lk.plain)}"`;
      if (lk.title) o += ` title="${esc(lk.title)}"`;
      return o + '>';
    }
    const content = lk.html;
    const href = cleanUrl(lk.href);
    if (href === null) return content;
    let l = `<a href="${esc(href)}"`;
    if (lk.title) l += ` title="${esc(lk.title)}"`;
    return l + '>' + content + '</a>';
  }
}

// ---------- chunk 4b: renderer + entry ----------
function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCell(cell, lx) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${lx.inline(cell.text)}</${tag}>\n`;
}

function renderBlocks(tokens, links, lx) {
  lx = lx || new InlineLexer(links);
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)?.[0] || '';
        const r = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        const body = esc(r, true);
        out += lang ? `<pre><code class="language-${esc(lang)}">${body}</code></pre>\n` : `<pre><code>${body}</code></pre>\n`;
        break;
      }
      case 'heading':
        out += `<h${tok.depth}>${lx.inline(tok.text)}</h${tok.depth}>\n`;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens, links, lx)}</blockquote>\n`;
        break;
      case 'html':
        out += tok.text;
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += `<${tag}${start}>\n`;
        for (const item of tok.items) out += `<li>${renderBlocks(item.tokens, links, lx)}</li>\n`;
        out += `</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += checkboxHtml(tok.checked);
        break;
      case 'paragraph': {
        let inner = lx.inline(tok.text);
        if (tok.prefix) inner = checkboxHtml(tok.prefix.checked) + inner;
        out += `<p>${inner}</p>\n`;
        break;
      }
      case 'text': {
        let inner = lx.inline(tok.text);
        if (tok.prefix) inner = checkboxHtml(tok.prefix.checked) + inner;
        out += inner;
        break;
      }
      case 'table': {
        let head = '';
        for (const c of tok.header) head += renderCell(c, lx);
        let body = '';
        for (const row of tok.rows) {
          let r = '';
          for (const c of row) r += renderCell(c, lx);
          body += `<tr>\n${r}</tr>\n`;
        }
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n` + (body ? `<tbody>${body}</tbody>` : '') + `</table>\n`;
        break;
      }
    }
  }
  return out;
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lexer = new BlockLexer();
  const tokens = lexer.blockTokens(src, []);
  return renderBlocks(tokens, lexer.links);
}
