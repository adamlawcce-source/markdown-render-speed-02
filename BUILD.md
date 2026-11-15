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
