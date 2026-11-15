# markdown-render-speed-02 — build log

Entry: a hand-written, dependency-free CommonMark 0.31.2 + GFM 0.29 parser
(`parse.js`, ES module) plus an own driver (`main.ts`).

## Status

- **Practice set: 720/720 cases byte-identical** (scorer `passed: 1`).
- **Timing (practice set, 2.8 MB, Node 24.22.1 on VM, 9 runs each, 3 repeats):**
  - mine: median **631–659 ms** (range 585–814)
  - marked 18.1.3 baseline: median **748–759 ms** (range 678–965)
  - **speedup: ~1.13–1.20x median** (consistently faster across repeats)
- Repo size: ~51 KB total (parse.js 50.7 KB, main.ts 912 B) — well under the 1 MiB cap.
- Smoke tests: 10/10 hand cases pass.

## Fixes that got it to 720/720 (in order)

1. `D()` clamp: marked's indent regexes use `max(0, min(3, n-1))` — my
   `RE_*_N` allowed one too many spaces, flattening nested lists.
   Fixed by clamping; regexes now precomputed per clamp value (also a speed win).
2. `def()` rewrite: faithful paren truncation + `anyPunctuation` unescape
   for href/title; label needs the `(?!\s*\])` lookahead (whitespace-only
   labels are not defs) — fixed cm-552.
3. `expandTabs` default column 0 (tabs vanished on continuation lines).
4. List else-branch break tests use the updated previous line (`prev`),
   not the stale first line.
5. Blockquote lazy continuation: removed a bare `break` at the loop end so
   lazy lines are processed; the paragraph merge in `blockTokens` (top=true)
   joins them into one `<p>`.
6. Nested-blockquote branch: consumed lines come from `rest`, not `lines`,
   and `rest` advances by the consumed count — fixed doc-21 duplication.
7. Shared `InlineLexer` across `renderBlocks` recursion: an unclosed `<a>`
   tag leaves `inLink` true, which suppresses later autolinks (marked
   behaviour) — fixed doc-03/06/30.
8. xmpp autolink path: `xmpp:email(?:\/[A-Za-z0-9@.]+)?` — one optional
   path segment (was a stray space in the pattern) — fixed gfm-634/635,
   doc-35/36.
9. Regex caching: `RE_*_N` factories precompute the 4 clamp variants at
   load instead of compiling a RegExp per list item.
10. List item body accumulated in an array and joined once, instead of
    repeated string concatenation per continuation line.

## What remains

- Do NOT submit / push / seal — parent handles that.
- Timing is a ~1.20x median on this VM; the sandbox may differ.
  The largest remaining cost is `list()` (per-line substring/split) and
  the inline `RE_ITEXT` regex; a list inner-loop rewrite to index-based
  line iteration is the next lever if more margin is wanted, but it was
  not attempted to protect the 720/720.

## Rebuild (2026-11-15, new recording 01a1e159)

The first build passed 720/720 but its recording could not be sealed
(seal refused: fingerprinted session lines were gone), so `parse.js` and
`main.ts` were rewritten from scratch in this recording, guided by the
design above. Old files were never restored or copied.

- **Practice set: 720/720 cases byte-identical** (scorer `passed: 1`).
- **Timing (practice set, Node 24.22.1 on VM, in-process parse only,
  5 runs each, median): entry 669 ms vs marked 699 ms (~1.04x).**
  Wall-clock `node main.ts` runs are noise-dominated by fixed overhead
  (~1350–1490 ms vs marked ~1420–1570 ms, roughly tied) — slower than
  the first build's 1.13–1.20x in-process median; no further lever was
  attempted after the fast path below, to protect the 720/720.
- Repo size: ~132 KB total (parse.js 58.9 KB, main.ts 912 B) — well
  under the 1 MiB cap. `package.json` (`{"type":"module"}`) added so
  Node reads `parse.js` as ESM (the baseline ships one).

Rebuild-specific fixes (all caught by the scorer, not present as bugs
in the first build):

11. `emStrongRDelimUnd` template: alt 5 is `(?!_)punctSpace(_+)`, not
    `(?!_)[\s](_+)`, and there is no 8th
    `(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)`
    alternative — fixed cm-372 group (`_(_foo)` must stay plain text).
12. `emStrongRDelimUnd` `punct` replacement is plain `PUNCT`
    (`[\p{P}\p{S}]`), NOT the tilde-excluded `PUNCT_NOT_TILDE` — a
    closer `_`/`__` right after `~~` must match (marked's und-variant
    uses plain punct; only the ast-variant excludes `~`) — fixed
    doc-03 (`_faster same ~~required fast~~_`) and doc-25.
13. `url()`: `raw` is the backpedaled URL text, not the full match —
    the trimmed tail (`.`, `))`, `&hl;`, …) must survive as plain text
    after the link — fixed gfm-624/625/627/629 and all doc diffs.
14. `INLINE_BR`: the regex needs exactly `\\` (one literal backslash)
    in the file; the rebuild initially had 4, then 3 (syntax error).
15. List continuation tracks `prevBlank` (previous line blank) — the
    else-branch break test used only the first line's `empty`; missing
    it let blank-line-separated lines get absorbed into list items
    (cm-255, cm-313).

Rebuild optimizations (720/720 re-verified after each):

- `inlineText` fast path: a plain run up to the first trigger char
  (`TEXT_TRIGGER = /[\\<!\[`*~_]/`) is emitted directly when the run
  contains no `www.` / `@` / `://` / `mailto:` / `xmpp:` / `  \n`;
  otherwise falls through to the full text regex. Median 723 ms
  → 669 ms in-process.
- `inlineTokens` skips the delimiter scan (`maskSource`) entirely when
  the source contains no `*`, `_`, or `~`.
- `lex()` skips the `\r` replace when the source contains no `\r`.
