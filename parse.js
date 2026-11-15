// A fast, dependency-free Markdown parser: CommonMark 0.31.2 + GFM 0.29,
// byte-identical output to marked 18.1.3 with default options (gfm on,
// breaks off, pedantic off). Written from scratch; the reference
// (marked's test expectations) was used only to check behaviour.
// Entry point: parse(markdown) -> HTML string.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// --- regex builder: substitute a named placeholder with a pattern,
// dropping a stray ^ that a sub-pattern carried in with it.
const CARET = /(^|[^\[])\^/g;
function edit(src, flags) {
  let text = typeof src === 'string' ? src : src.source;
  return {
    replace(name, sub) {
      let s = typeof sub === 'string' ? sub : sub.source;
      s = s.replace(CARET, '$1');
      text = text.replace(name, s);
      return this;
    },
    regex() {
      return new RegExp(text, flags);
    }
  };
}

// Cached factory for indent-dependent regexes: marked clamps the indent
// level to 0..3 (max(0, min(3, n-1))) and memoises the four variants.
function cached(make) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = make(i));
  };
}

// --- small helpers ---
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_RE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(s, encode) {
  if (encode) {
    return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]) : s;
  }
  return ESCAPE_TEST_NO_ENCODE.test(s) ? s.replace(ESCAPE_RE_NO_ENCODE, (c) => ESCAPE_MAP[c]) : s;
}

function unescapeEntities(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Trim trailing occurrences of `ch` (or, when strip is set, trailing
// characters that are not `ch`).
function rtrim(s, ch, strip) {
  let n = s.length;
  if (n === 0) return '';
  let i = 0;
  while (i < n) {
    const c = s.charAt(n - i - 1);
    if (c === ch && !strip) i++;
    else if (c !== ch && strip) i++;
    else break;
  }
  return s.slice(0, n - i);
}

// Remove at most two trailing blank lines from an indented code block.
function trimCodeBlock(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, tracking the column (default 0).
function expandTabs(s, col = 0) {
  let n = col;
  let out = '';
  for (const c of s) {
    if (c === '\t') {
      const w = 4 - (n % 4);
      out += ' '.repeat(w);
      n += w;
    } else {
      out += c;
      n++;
    }
  }
  return out;
}

// Find the index of the closing bracket matching an opener, or -1
// (unbalanced), -2 (unclosed). Backslash escapes are skipped.
function findClosingBracket(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Normalise a link-reference label: trim, collapse whitespace, fold case.
function normalizeRef(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row into cells, honouring escaped pipes and optional
// leading/trailing pipes; pad or trim to the expected column count.
function splitCells(row, count) {
  const t = row.replace(/\|/g, (m, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// --- shared "other" patterns ---
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (b) => new RegExp(`^( {0,3}${b})((?:[ \t][^\n]*)?(?:\n|$))`),
  nextBulletRegex: cached((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cached((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cached((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cached((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cached((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cached((n) => new RegExp(`^ {0,${n}}>`))
};

// --- block rules (GFM) ---
const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
// The same pattern with a non-capturing outer group, for embedding inside
// composite regexes (a capturing group there would shift group numbers).
const HR_NC = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_LIST = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BLOCK_BULL).regex();
const BLOCK_TEXT = /^[^\n]+/;
const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BLOCK_DEF = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/).regex();
const BLOCK_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BLOCK_HTML = edit("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", 'i')
  .replace('comment', BLOCK_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).regex();

// GFM table: header line, delimiter line, optional body rows.
const BLOCK_TABLE = edit("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace('hr', HR_NC)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAGS).regex();

// Paragraph: lines that keep going until a block start (or a blank line).
// The GFM paragraph stops at a table start; the blockquote paragraph
// (built by the same maker without a table pattern) does not.
const PARA_BODY = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function makeParagraph(listPattern, tablePattern) {
  const b = edit(PARA_BODY)
    .replace('hr', HR_NC)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listPattern)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS);
  if (tablePattern) b.replace('table', tablePattern);
  else b.replace('|table', '');
  return b.regex();
}
const BLOCK_PARA = makeParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, BLOCK_TABLE);
// Paragraph as seen inside a blockquote (its list pattern differs).
const BLOCKQUOTE_PARA = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const BLOCK_BLOCKQUOTE = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', BLOCKQUOTE_PARA).regex();

// Setext heading: the lookahead excludes block starts in the heading text.
const SETEXT_BODY = /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const BLOCK_LHEADING = edit(SETEXT_BODY)
  .replace(/bull/g, BLOCK_BULL)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, HR_NC)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).regex();

const BLOCK = {
  newline: BLOCK_NEWLINE,
  code: BLOCK_CODE,
  fences: BLOCK_FENCES,
  hr: BLOCK_HR,
  heading: BLOCK_HEADING,
  blockquote: BLOCK_BLOCKQUOTE,
  list: BLOCK_LIST,
  html: BLOCK_HTML,
  def: BLOCK_DEF,
  table: BLOCK_TABLE,
  lheading: BLOCK_LHEADING,
  paragraph: BLOCK_PARA,
  text: BLOCK_TEXT
};

// --- inline rules (GFM) ---
const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;
const PUNCTUATION = edit(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).regex();

// Emphasis delimiter runs.
const EM_STRONG_L = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const INLINE_EM_STRONG_L = edit(EM_STRONG_L, 'u').replace(/punct/g, PUNCT_NOT_TILDE).regex();
const EM_STRONG_R_AST =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const INLINE_EM_STRONG_R_AST = edit(EM_STRONG_R_AST, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .replace(/punctSpace/g, PUNCT_SPACE_NOT_TILDE)
  .replace(/punct/g, PUNCT_NOT_TILDE).regex();
const EM_STRONG_R_UND =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const INLINE_EM_STRONG_R_UND = edit(EM_STRONG_R_UND, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT).regex();

// Strikethrough delimiter runs.
const INLINE_DEL_L = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).regex();
const DEL_R =
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const INLINE_DEL_R = edit(DEL_R, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT).regex();
const INLINE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Autolinks, tags, links.
const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const INLINE_AUTOLINK = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', EMAIL_RE).regex();
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const INLINE_TAG = edit("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
  .replace('comment', edit(HTML_COMMENT).replace('(?:-->|$)', '-->').regex())
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).regex();
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', BRACKETED).regex();
const LINK_HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const LINK_TITLE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
const INLINE_LINK = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LINK_LABEL)
  .replace('href', LINK_HREF)
  .replace('title', LINK_TITLE).regex();
const INLINE_REFLINK = edit(/^!?\[(label)\]\[(ref)\]/).replace('label', LINK_LABEL).replace('ref', LABEL).regex();
const INLINE_NOLINK = edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL).regex();
// The search form used to mask link text while scanning for emphasis.
const REFLINK_SEARCH_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', BRACKETED).regex();
const REFLINK_SEARCH_REF = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const INLINE_REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/).replace('label', REFLINK_SEARCH_LABEL).replace('ref', REFLINK_SEARCH_REF).regex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', REFLINK_SEARCH_REF).regex()).regex();
const HAS_LOOKBEHIND = (() => {
  try { new RegExp('(?<=1)(?<!1)'); return true; } catch { return false; }
})();
const INLINE_BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', HAS_LOOKBEHIND ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/).regex();
const ANY_PUNCT = edit(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).regex();
const ANY_PUNCT_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).regex();

// Extended autolinks (www., http(s)://, ftp://, bare e-mails).
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_LOCAL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const AUTOLINK_EMAIL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_LOCAL).regex();
const INLINE_URL = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', AUTOLINK_EMAIL)
  .replace('protocol', PROTOCOL)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).regex();
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Inline text: consumes up to the next token that could start.
const INLINE_TEXT = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', HAS_LOOKBEHIND ? '(?<![^\\s*_~(])www\\.' : 'www\\.').regex();

// Fast path for plain text runs: the first char that could start an inline token.
const TEXT_TRIGGER = /[\\<!\[`*~_]/;

const INLINE = {
  escape: INLINE_ESCAPE,
  code: INLINE_CODE,
  br: INLINE_BR,
  del: INLINE_DEL,
  delLDelim: INLINE_DEL_L,
  delRDelim: INLINE_DEL_R,
  emStrongLDelim: INLINE_EM_STRONG_L,
  emStrongRDelimAst: INLINE_EM_STRONG_R_AST,
  emStrongRDelimUnd: INLINE_EM_STRONG_R_UND,
  autolink: INLINE_AUTOLINK,
  tag: INLINE_TAG,
  link: INLINE_LINK,
  reflink: INLINE_REFLINK,
  nolink: INLINE_NOLINK,
  reflinkSearch: INLINE_REFLINK_SEARCH,
  blockSkip: INLINE_BLOCK_SKIP,
  url: INLINE_URL,
  _backpedal: URL_BACKPEDAL,
  punctuation: PUNCTUATION,
  text: INLINE_TEXT
};

// --- emphasis masking: where the last possible closer for *, _ or ~ sits ---
// The lexer caches one scan per masked source (a WeakMap on the tokenizer).
const MASK_CACHE = new WeakMap();
function scanDelimiters(src) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < src.length && src[j] === c) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '~') lastDel = i;
      else lastEm[c] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}
function maskSource(tokenizer, src) {
  const entry = { maskedSrc: src, ...scanDelimiters(src) };
  const list = MASK_CACHE.get(tokenizer);
  if (list) list.push(entry);
  else MASK_CACHE.set(tokenizer, [entry]);
}
function unmaskSource(tokenizer) {
  const list = MASK_CACHE.get(tokenizer);
  if (list) {
    list.pop();
    if (list.length === 0) MASK_CACHE.delete(tokenizer);
  }
}
function lastEmCloser(tokenizer, masked, ch) {
  const top = MASK_CACHE.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === masked) return top.lastEm[ch];
  return scanDelimiters(masked).lastEm[ch];
}
function lastDelCloser(tokenizer, masked) {
  const top = MASK_CACHE.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === masked) return top.lastDel;
  return scanDelimiters(masked).lastDel;
}

// --- the tokenizer: turns source text into tokens ---
class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (m) {
      const raw = trimCodeBlock(m[0]);
      const text = raw.replace(O.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (m) {
      const raw = m[0];
      let text = m[3] || '';
      const indent = raw.match(O.indentCodeCompensation);
      if (indent !== null) {
        const w = indent[1];
        text = text.split('\n').map((line) => {
          const lead = line.match(O.beginningSpace);
          if (lead === null) return line;
          return line.slice(Math.min(lead[0].length, w.length));
        }).join('\n');
      }
      return {
        type: 'code',
        raw,
        lang: m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2],
        text
      };
    }
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (O.endingHash.test(text)) {
        const stripped = rtrim(text, '#');
        if (!stripped || O.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, tokens: this.lexer.inline(text) };
    }
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: rtrim(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return;
    let lines = rtrim(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const chunk = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (O.blockquoteStart.test(lines[i])) { chunk.push(lines[i]); inQuote = true; }
        else if (!inQuote) chunk.push(lines[i]);
        else break;
      }
      lines = lines.slice(i);
      const joined = chunk.join('\n');
      const stripped = joined
        .replace(O.blockquoteMarkerWhitespace, (g, p1, p2) => p1 + expandTabs(p2, p1.length))
        .replace(O.blockquoteSetextReplace, '\n    $1')
        .replace(O.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + joined : joined;
      text = text ? text + '\n' + stripped : stripped;
      const top = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(stripped, tokens, true);
      this.lexer.state.top = top;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const rest = lines.join('\n');
        const reparsed = last.raw + '\n' + rest.replace(O.blockquoteSetextReplace2, '');
        const nested = this.blockquote(reparsed);
        tokens[tokens.length - 1] = nested;
        const leftover = reparsed.substring(nested.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (consumed.length > 0) {
          raw = raw + '\n' + consumed.join('\n');
          text = text.substring(0, text.length - last.text.length) + nested.text;
          lines = lines.slice(consumed.length);
          if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
        }
        break;
      } else if (last?.type === 'list') {
        const rest = lines.join('\n');
        const extended = last.raw + '\n' + rest;
        const relisted = this.list(extended);
        tokens[tokens.length - 1] = relisted;
        const extra = relisted.raw.length > last.raw.length
          ? extended.slice(last.raw.length + 1, relisted.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + taken;
          text = text + '\n' + taken;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return;
    const full = src;
    const consumed = () => full.length - src.length;
    const bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
    const bulletRe = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = O.listItemRegex(bulletRe);
    let sawBlank = false;
    while (src) {
      let isBlankItem = false;
      let body = '';
      const itemMatch = itemRe.exec(src);
      if (!itemMatch || BLOCK.hr.test(src)) break;
      const itemStart = consumed();
      src = src.substring(itemMatch[0].length);
      const firstLine = itemMatch[2].split('\n', 1)[0];
      const bulletWidth = itemMatch[1].length;
      let line = firstLine.replace(O.leadingSpaceTab, (w) => expandTabs(w, bulletWidth));
      let nextLine = src.split('\n', 1)[0];
      const empty = !line.trim();
      let indent;
      if (empty) {
        indent = bulletWidth + 1;
      } else {
        indent = line.search(O.nonSpaceChar);
        if (indent > 4) indent = 1;
        body = line.slice(indent);
        indent += bulletWidth;
      }
      if (empty && O.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        isBlankItem = true;
      }
      if (!isBlankItem) {
        const nextBullet = O.nextBulletRegex(indent);
        const hrRe = O.hrRegex(indent);
        const fenceRe = O.fencesBeginRegex(indent);
        const headRe = O.headingBeginRegex(indent);
        const htmlRe = O.htmlBeginRegex(indent);
        const quoteRe = O.blockquoteBeginRegex(indent);
        const parts = [body];
        let prev = line;
        let prevBlank = empty;
        while (src) {
          const rawLine = src.split('\n', 1)[0];
          const expanded = rawLine.replace(O.leadingSpaceTab, (w) => expandTabs(w));
          if (fenceRe.test(rawLine) || headRe.test(rawLine) || htmlRe.test(rawLine) || quoteRe.test(rawLine) || nextBullet.test(rawLine) || hrRe.test(rawLine)) break;
          if (expanded.search(O.nonSpaceChar) >= indent || !rawLine.trim()) {
            parts.push('\n' + expanded.slice(indent));
          } else {
            if (prevBlank || line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4 || fenceRe.test(prev) || headRe.test(prev) || htmlRe.test(prev) || hrRe.test(prev)) break;
            const setext = /^ {0,3}(?:=+|-+) *$/.test(rawLine) && BLOCK.lheading.test(`${line}\n${rawLine}`);
            parts.push('\n' + (setext ? `    ${expanded.replace(/^ {0,3}/, '')}` : rawLine));
          }
          prevBlank = !rawLine.trim();
          prev = expanded.slice(indent);
          line = expanded.slice(indent);
          src = src.substring(rawLine.length + 1);
        }
        body = parts.join('');
      }
      const itemRaw = full.slice(itemStart, consumed());
      if (!list.loose) {
        if (sawBlank) list.loose = true;
        else if (O.doubleBlankLine.test(itemRaw)) sawBlank = true;
      }
      list.items.push({ type: 'list_item', raw: itemRaw, task: O.listIsTask.test(body), loose: false, text: body, tokens: [] });
    }
    const lastItem = list.items.at(-1);
    if (!lastItem) return;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = full.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        list.loose = spaces.length > 0 && spaces.some((t) => O.anyLine.test(t.raw));
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(O.listReplaceTask, '');
        first.raw = first.raw.replace(O.listReplaceTask, '');
        first.text = first.text.replace(O.listReplaceTask, '');
        for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
          if (O.listIsTask.test(this.lexer.inlineQueue[i].src)) {
            this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(O.listReplaceTask, '');
            break;
          }
        }
        const check = O.listTaskCheckbox.exec(item.raw);
        if (check) {
          const box = { type: 'checkbox', raw: check[0] + ' ', checked: check[0] !== '[ ]' };
          item.checked = box.checked;
          if (list.loose) {
            if (first && (first.type === 'paragraph' || first.type === 'text') && 'tokens' in first && first.tokens) {
              first.raw = box.raw + first.raw;
              first.text = box.raw + first.text;
              first.tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (m) {
      const raw = trimCodeBlock(m[0]);
      return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
    }
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (m) {
      if (!O.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return;
      const tag = normalizeRef(m[1]);
      const href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
      const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1') : m[3];
      return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
    }
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !O.tableDelimiter.test(m[2])) return;
    const headers = splitCells(m[1]);
    const aligns = m[2].replace(O.tableAlignChars, '').split('|');
    const rows = m[3]?.trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
    const table = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
    if (headers.length === aligns.length) {
      for (const a of aligns) {
        table.align.push(O.tableAlignRight.test(a) ? 'right' : O.tableAlignCenter.test(a) ? 'center' : O.tableAlignLeft.test(a) ? 'left' : null);
      }
      for (let i = 0; i < headers.length; i++) {
        table.header.push({ text: headers[i], tokens: this.lexer.inline(headers[i]), header: true, align: table.align[i] });
      }
      for (const row of rows) {
        table.rows.push(splitCells(row, headers.length).map((cell, i) => ({ text: cell, tokens: this.lexer.inline(cell), header: false, align: table.align[i] })));
      }
      return table;
    }
  }

  lheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.lexer.inline(text) };
    }
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }
}

// --- inline tokenizers ---
function hasUnclosedLink(src, text, offset, rules) {
  if (!text.includes('<')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '`') {
      const code = rules.code.exec(text.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (text[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tag = rules.tag.exec(rest) || rules.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > text.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link/image token, parsing its text inline. Returns undefined
// when a link would contain another link (marked drops it).
function makeLink(match, ref, raw, lexer) {
  const href = ref.href;
  const title = ref.title || null;
  const text = match[1].replace(O.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const inLink = lexer.state.inLink;
  const emitted = lexer.state.linkEmitted;
  const inRaw = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const nested = lexer.state.linkEmitted;
  lexer.state.linkEmitted = emitted;
  lexer.state.inLink = inLink;
  if (!isImage) {
    if (nested) {
      lexer.state.inRawBlock = inRaw;
      return;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

class InlineTokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  }

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (m) {
      if (!this.lexer.state.inLink && O.startATag.test(m[0])) this.lexer.state.inLink = true;
      else if (this.lexer.state.inLink && O.endATag.test(m[0])) this.lexer.state.inLink = false;
      if (!this.lexer.state.inRawBlock && O.startPreScriptTag.test(m[0])) this.lexer.state.inRawBlock = true;
      else if (this.lexer.state.inRawBlock && O.endPreScriptTag.test(m[0])) this.lexer.state.inRawBlock = false;
      return { type: 'html', raw: m[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: m[0] };
    }
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = INLINE.link.exec(src);
    if (!m) return;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasUnclosedLink(src, m[1], bang, INLINE)) return;
    let hrefSrc = m[2].trim();
    if (O.startAngleBracket.test(hrefSrc)) {
      if (!O.endAngleBracket.test(hrefSrc)) return;
      const stripped = rtrim(hrefSrc.slice(0, -1), '\\');
      if ((hrefSrc.length - stripped.length) % 2 === 0) return;
    } else {
      const close = findClosingBracket(m[2], '()');
      if (close === -2) return;
      if (close > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const trailing = rtrim(m[0].slice(0, -1), '\\');
    if ((m[0].length - trailing.length) % 2 === 0) return;
    let dest = m[2];
    let title = '';
    title = m[3] ? m[3].slice(1, -1) : '';
    dest = dest.trim();
    if (O.startAngleBracket.test(dest)) {
      dest = dest.slice(1, -1);
    }
    return makeLink(m, {
      href: dest && dest.replace(ANY_PUNCT, '$1'),
      title: title && title.replace(ANY_PUNCT, '$1')
    }, m[0], this.lexer);
  }

  reflink(src, links) {
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!m) return;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasUnclosedLink(src, m[1], bang, INLINE)) return;
    const ref = links[normalizeRef(m[2] || m[1])];
    if (!ref) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLink(m, ref, m[0], this.lexer);
  }

  emStrong(src, masked, prevChar = '') {
    const open = INLINE.emStrongLDelim.exec(src);
    if (!open || (!open[1] && !open[2] && !open[3] && !open[4])) return;
    const delim = open[0][0];
    const sameAsPrev = prevChar === delim;
    const start = masked.length - src.length;
    let left = start;
    while (left > 0 && masked[left - 1] === delim) left--;
    const beforeRun = [...masked.slice(Math.max(0, left - 2), left)].at(-1) ?? '';
    const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    if (left < start) prevChar = beforeRun;
    const afterIsPunct = left < start ? beforeIsPunct : !!INLINE.punctuation.exec(prevChar);
    if (open[4] && prevChar.match(O.unicodeAlphaNumeric)) return;
    const openerText = open[1] || open[3] || '';
    if (!openerText || !prevChar || afterIsPunct) {
      const runLen = [...open[0]].length - 1;
      let g, b, remaining = runLen, extra = 0;
      const fromPrev = start - left + runLen;
      const canOpen = !!beforeRun.trim() && (!!openerText || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = lastEmCloser(this, masked, delim);
      const firstPossible = masked.length - src.length + runLen;
      if (lastCloser < firstPossible) return;
      const rest = masked.slice(firstPossible);
      const limit = lastCloser - firstPossible;
      for (closerRe.lastIndex = 0; ; ) {
        const close = closerRe.exec(rest);
        if (close === null || close.index > limit) break;
        g = close[1] || close[2] || close[3] || close[4] || close[5] || close[6];
        if (!g) continue;
        b = [...g].length;
        if (close[3] || close[4]) { remaining += b; continue; }
        if (close[5] || close[6] || canOpen) {
          if (sameAsPrev && (close[5] || close[6])) break;
          if (fromPrev % 3 && !((fromPrev + b) % 3)) { extra += b; continue; }
        }
        remaining -= b;
        if (remaining > 0) continue;
        b = Math.min(b, b + remaining + extra);
        const tokenLen = [...close[0]][0].length;
        const raw = src.slice(0, runLen + close.index + tokenLen + b);
        if (Math.min(runLen, b) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (m) {
      let text = m[2].replace(O.newLineCharGlobal, ' ');
      const hasNonSpace = O.nonSpaceChar.test(text);
      const padded = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
  }

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  }

  del(src, masked, prevChar = '') {
    const open = INLINE.delLDelim.exec(src);
    if (!open) return;
    if (!(open[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const runLen = [...open[0]].length - 1;
      let g, len, remaining = runLen;
      const closerRe = INLINE.delRDelim;
      const lastCloser = lastDelCloser(this, masked);
      const firstPossible = masked.length - src.length + runLen;
      if (lastCloser < firstPossible) return;
      const rest = masked.slice(firstPossible);
      const limit = lastCloser - firstPossible;
      for (closerRe.lastIndex = 0; ; ) {
        const close = closerRe.exec(rest);
        if (close === null || close.index > limit) break;
        g = close[1] || close[2] || close[3] || close[4] || close[5] || close[6];
        if (!g || (len = [...g].length) !== runLen) continue;
        if (close[3] || close[4]) { remaining += len; continue; }
        remaining -= len;
        if (remaining > 0) continue;
        len = Math.min(len, len + remaining);
        const tokenLen = [...close[0]][0].length;
        const raw = src.slice(0, runLen + close.index + tokenLen + len);
        const inner = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (m) {
      let text, href;
      if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
      else { text = m[1]; href = text; }
      return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }

  url(src) {
    const m = INLINE.url.exec(src);
    if (!m) return;
    let text, href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let cur = m[0];
      let next;
      do {
        next = cur;
        cur = INLINE._backpedal.exec(cur)?.[0] ?? '';
      } while (next !== cur);
      text = cur;
      href = m[1] === 'www.' ? 'http://' + cur : cur;
    }
    return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  inlineText(src) {
    const cut = src.search(TEXT_TRIGGER);
    if (cut !== 0) {
      const raw = cut === -1 ? src : src.slice(0, cut);
      if (!raw.includes('www.') && !raw.includes('@') && !raw.includes('://') && !raw.includes('mailto:') && !raw.includes('xmpp:') && !raw.includes('  \n')) {
        const inRaw = this.lexer.state.inRawBlock;
        return { type: 'text', raw, text: inRaw ? raw : unescapeEntities(raw), escaped: inRaw };
      }
    }
    const m = INLINE.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeEntities(m[0]), escaped: inRaw };
    }
  }
}

// --- the lexer: turns source into a token tree ---
class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.blockTokenizer = new Tokenizer(this);
    this.inlineTokenizer = new InlineTokenizer(this);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  lex(src) {
    if (src.includes('\r')) src = src.replace(O.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], nested = false) {
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let token;
      if ((token = this.blockTokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (token.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(token);
        continue;
      }
      if ((token = this.blockTokenizer.code(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(token);
        continue;
      }
      if ((token = this.blockTokenizer.fences(src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = this.blockTokenizer.heading(src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = this.blockTokenizer.hr(src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = this.blockTokenizer.blockquote(src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = this.blockTokenizer.list(src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = this.blockTokenizer.html(src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = this.blockTokenizer.def(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.tokens.links[token.tag]) this.tokens.links[token.tag] = { href: token.href, title: token.title };
          tokens.push(token);
        }
        continue;
      }
      if ((token = this.blockTokenizer.table(src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = this.blockTokenizer.lheading(src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if (this.state.top && (token = this.blockTokenizer.paragraph(src))) {
        const prev = tokens.at(-1);
        if (nested && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(token);
        nested = src.length !== token.raw.length;
        src = src.substring(token.raw.length);
        continue;
      }
      if ((token = this.blockTokenizer.text(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(token);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  // Queue a string for inline parsing; the tokens array is filled later.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  // Does this text contain a link (used when masking for emphasis)?
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const open = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeRef(s.slice(open + 1, -1)))) &&
          !(open > 1 && this.linkInText(s.slice(1, open - 1)))) return true;
    }
    return false;
  }

  // Mask link/code/html spans so emphasis scanning sees plain text.
  maskInline(src) {
    let out = src;
    if (this.tokens.links && src.includes('[')) {
      const search = INLINE.reflinkSearch;
      const maskRef = (match) => {
        const open = match.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeRef(match.slice(open + 1, -1)))) return match;
        if (open > 1 && match.charAt(0) !== '!') {
          const inner = match.slice(1, open - 1);
          if (this.linkInText(inner)) return '[' + inner.replace(search, maskRef) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      };
      out = out.replace(search, maskRef);
    }
    out = out.replace(ANY_PUNCT_OUTSIDE_CODE, (m, ticks, punct) =>
      punct ? '+'.repeat(m.length) : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : m);
    out = out.replace(INLINE.blockSkip, (m, g1, g2) => {
      const keep = g2 ? g2.length : 0;
      return m.slice(0, keep) + '[' + 'a'.repeat(m.length - keep - 2) + ']';
    });
    return out;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
      const masked = hasDelim ? this.maskInline(src) : src;
      if (hasDelim) maskSource(this.inlineTokenizer, masked);
      try {
        return this.inlineLoop(src, masked, tokens);
      } finally {
        if (hasDelim) unmaskSource(this.inlineTokenizer);
      }
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineLoop(src, masked, tokens) {
    let wasText = false;
    let prevChar = '';
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!wasText) prevChar = '';
      wasText = false;
      let tok;
      if ((tok = this.inlineTokenizer.escape(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.inlineTokenizer.tag(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.inlineTokenizer.link(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.inlineTokenizer.reflink(src, this.tokens.links))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.emStrong(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.inlineTokenizer.codespan(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.inlineTokenizer.br(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.inlineTokenizer.del(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.inlineTokenizer.autolink(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (!this.state.inLink && (tok = this.inlineTokenizer.url(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.inlineTokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        wasText = true;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }
}

// --- the renderer: turns tokens into HTML ---
class Renderer {
  constructor() {
    this.parser = null;
  }

  space() { return ''; }
  code(token) {
    const lang = (token.lang || '').match(O.notSpaceStart)?.[0];
    const text = token.text ? token.text.replace(O.endingNewline, '') + '\n' : '';
    const body = token.escaped ? text : escapeHtml(text, true);
    return lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>\n`
      : `<pre><code>${body}</code></pre>\n`;
  }
  blockquote(token) {
    return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
  }
  html(token) { return token.text; }
  def() { return ''; }
  heading(token) {
    return `<h${token.depth}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
  }
  hr() { return '<hr>\n'; }
  list(token) {
    const tag = token.ordered ? 'ol' : 'ul';
    const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
    let body = '';
    for (const item of token.items) body += this.listitem(item);
    return `<${tag}${start}>\n${body}</${tag}>\n`;
  }
  listitem(token) {
    return `<li>${this.parser.parse(token.tokens)}</li>\n`;
  }
  checkbox(token) {
    return `<input ${token.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
  }
  paragraph(token) {
    return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
  }
  table(token) {
    let head = '';
    for (const cell of token.header) head += this.tablecell(cell);
    const headRow = this.tablerow({ text: head });
    let body = '';
    for (const row of token.rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
  }
  tablerow(token) {
    return `<tr>\n${token.text}</tr>\n`;
  }
  tablecell(token) {
    const text = this.parser.parseInline(token.tokens);
    const tag = token.header ? 'th' : 'td';
    return (token.align ? `<${tag} align="${token.align}">` : `<${tag}>`) + text + `</${tag}>\n`;
  }
  strong(token) {
    return `<strong>${this.parser.parseInline(token.tokens)}</strong>`;
  }
  em(token) {
    return `<em>${this.parser.parseInline(token.tokens)}</em>`;
  }
  codespan(token) {
    return `<code>${escapeHtml(token.text, true)}</code>`;
  }
  br() { return '<br>'; }
  del(token) {
    return `<del>${this.parser.parseInline(token.tokens)}</del>`;
  }
  link(token) {
    const text = token.autolink ? escapeHtml(token.text, true) : this.parser.parseInline(token.tokens);
    const href = cleanUrl(token.href);
    if (href === null) return text;
    let out = `<a href="${escapeHtml(href, token.autolink)}"`;
    if (token.title) out += ` title="${escapeHtml(token.title)}"`;
    return out + `>${text}</a>`;
  }
  image(token) {
    const alt = token.tokens ? this.parser.parseInline(token.tokens, this.parser.textRenderer) : token.text;
    const href = cleanUrl(token.href);
    if (href === null) return escapeHtml(alt);
    let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
    if (token.title) out += ` title="${escapeHtml(token.title)}"`;
    return out + '>';
  }
  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    return 'escaped' in token && token.escaped ? token.text : escapeHtml(token.text);
  }
}

// Plain-text rendering (used for image alt text).
class TextRenderer {
  constructor() {
    this.parser = null;
  }
  strong(token) { return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text; }
  em(token) { return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text; }
  codespan(token) { return token.text; }
  del(token) { return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text; }
  html(token) { return token.text; }
  text(token) { return token.text; }
  link(token) { return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text; }
  image(token) { return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text; }
  br() { return ''; }
  checkbox(token) { return token.raw; }
}

// --- the parser: walks tokens with the renderer ---
class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space': out += this.renderer.space(token); break;
        case 'hr': out += this.renderer.hr(token); break;
        case 'heading': out += this.renderer.heading(token); break;
        case 'code': out += this.renderer.code(token); break;
        case 'table': out += this.renderer.table(token); break;
        case 'blockquote': out += this.renderer.blockquote(token); break;
        case 'list': out += this.renderer.list(token); break;
        case 'checkbox': out += this.renderer.checkbox(token); break;
        case 'html': out += this.renderer.html(token); break;
        case 'def': out += this.renderer.def(token); break;
        case 'paragraph': out += this.renderer.paragraph(token); break;
        case 'text': out += this.renderer.text(token); break;
        default: throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape': out += renderer.text(token); break;
        case 'html': out += renderer.html(token); break;
        case 'link': out += renderer.link(token); break;
        case 'image': out += renderer.image(token); break;
        case 'checkbox': out += renderer.checkbox(token); break;
        case 'strong': out += renderer.strong(token); break;
        case 'em': out += renderer.em(token); break;
        case 'codespan': out += renderer.codespan(token); break;
        case 'br': out += renderer.br(token); break;
        case 'del': out += renderer.del(token); break;
        case 'text': out += renderer.text(token); break;
        default: throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }
}

// --- entry point ---
export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  const parser = new Parser();
  return parser.parse(tokens);
}
