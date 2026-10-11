---
id: 6721
title: "Annex B RegExp non-Unicode p/P identity escapes"
status: in-progress
assignee: ttraenkler/codex-regexp-identity-escape
sprint: current
created: 2026-09-28
updated: 2026-09-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: regexp
goal: standalone-mode
related: [1539, 1912, 2161, 6651, 6677]
---

# Annex B RegExp non-Unicode `p`/`P` identity escapes

## Problem

The frozen original
`test/annexB/language/literals/regexp/identity-escape.js` is a JavaScript
language/Annex B row (`es6id: B.1.4`), not a Unicode-property-escape feature.
At Test262 corpus revision
`b363f29d3c43c626dc852744ad64a0b48a003693`, its SHA-256 is
`d08950bbcec4282b60bb9496f9a56823d0a74904e62aa6390a37abed9a5a4b2f`.
The unchanged original includes `/O\PQ/` without a `u` or `v` flag and expects
the match `"OPQ"`.

The current standalone parser instead emits a compile error for `\P` (and
`\p`) before it reaches the existing non-Unicode identity-escape fallback.
That is a one-row measured compile error in the frozen 11,778-path run, not a
claim about the former broad property-escape cluster. The historical #6651
text that calls this a large Unicode-engine feature is incorrect for this
specific original; it is not changed by this issue.

## Source evidence

Pinned compiler revision:
`422dbf01a07b58cceefc64846444485eb549d9a5`.

- `src/codegen/regex/parse.ts::Parser.parseEscapeAtom` handles `p`/`P` at the
  property-escape branch. Under `u`/`v`, it invokes the property-source parser
  and Unicode enumerator. The baseline unconditionally threw without either
  flag before the subsequent `parseEscapedCodeUnit()` default branch, which
  already returns an escaped ordinary character as an identity escape.
- The baseline `Parser.parseClassMember` separately rejected `p`/`P`; that was
  the only class-specific blocker. In `u`/`v` mode `parseAtom` instead sends
  the whole class through `uEnum`, so `parseClassMember` is the non-Unicode
  class path.
- The separate runtime parser is not part of this repair:
  `src/codegen/regex-runtime/parse.ts` already advances and emits `K_CHAR` for
  non-`u` `p`/`P`, while retaining its property route under `u`.

Thus a parser-only repair may remove the two non-Unicode refusals while leaving
the Unicode/property route and the runtime compiler unchanged.

## Required behavioral proof before source change

Node 24.19.0 oracle completed before any parser edit (root tool receipt
`chunkfdfa9f`, terminal exit `0`): all 22 assertions passed. It used native
`RegExp`, asserted the matched text for the fourteen positive tuples below,
and asserted `SyntaxError` for the eight invalid bare escapes. The inline
oracle was intentionally not retained as a repository file, so this is a
tool receipt rather than a file-hash receipt.

| Pattern | Flags | Input | Native matched text |
| --- | --- | --- | --- |
| `\p` | none | `p` | `p` |
| `\P` | none | `P` | `P` |
| `O\PQ` | none | `MNOPQRS` | `OPQ` |
| `\p{L}` | none | `p{L}` | `p{L}` |
| `\P{L}` | none | `P{L}` | `P{L}` |
| `[\p]` | none | `p` | `p` |
| `[\P]` | none | `P` | `P` |
| `[\p{L}]` | none | `{` | `{` |
| `\p{L}` | `u` / `v` | `A` | `A` |
| `\P{L}` | `u` / `v` | `1` | `1` |
| `[\p{L}]` | `u` / `v` | `A` | `A` |

For each of `u` and `v`, native `RegExp` also threw `SyntaxError` for `\p`,
`\P`, `[\p]`, and `[\P]`. This establishes the required boundary: non-u
forms are Annex B identity escapes; it does not weaken property parsing or
the invalid-bare-escape rules in Unicode modes.

The matrix is a Node oracle only. It does not replace the maintained Test262
verdict or prove the standalone Wasm route.

## Implementation Plan

1. In `src/codegen/regex/parse.ts::parseEscapeAtom`, invoke the existing
   `u`/`v` property-escape block only in Unicode modes, letting non-Unicode
   `p`/`P` fall through to the existing `parseEscapedCodeUnit()` identity
   result. Do not interpret a following `{...}` as a property in non-Unicode
   mode.
2. In `Parser.parseClassMember`, remove only the non-Unicode `p`/`P` refusal so
   its existing `parseEscapedCodeUnit(true)` path emits the identity character.
   Do not alter the earlier `u`/`v` class dispatch, decimal/octal precedence,
   `\k`, `\c`, or any Unicode enumerator.
3. Add one focused `tests/issue-6721-regexp-identity-escape.test.ts` covering
   the original `O\PQ` behavior, plain/braced/class non-Unicode forms, and
   `u`/`v` property and invalid-bare-escape guards. It must test both the pure
   parse/compile/reference-VM path and a standalone module instantiated with
   no RegExp host import.
   Replace the stale non-u `"\\p{L}"` refusal pin in
   `tests/regex-bytecode.test.ts` with explicit native-parity identity-escape
   inputs. Retain every genuine syntax-error refusal in that neighboring suite.
4. Record the `HEAD` parser SHA-256 and swap only these two owned hunks with
   `apply_patch` for the focused baseline/candidate pair; do not use a reset or
   checkout. Use the same test hash, Node 24, one fork, and bounded heap for
   both arms; report every selected row and the terminal code. A passing
   candidate must not be called attributable without the matching baseline
   refusal/control results.
5. Run the maintained dynamic Test262 runner directly on an exact manifest
   containing the unchanged original plus declared positive neighbors. Keep the
   literal upstream body and assembled original harness; `wrapTest()` may aid
   diagnostics but cannot replace the verdict. Require complete
   expected/registered/started/settled/canonical accounting, source/corpus and
   artifact hashes, import evidence, and a captured terminal exit for both
   baseline and candidate arms.

## Focused preliminary A/B receipt

Before the reviewed fixture type-only cleanup below, the candidate parser and
focused test completed with Node 24.19.0, one Vitest fork, and a 4 GiB fork
heap. The candidate run selected one file and passed all 11 tests in 14.03s:
`.tmp/6721/candidate-focused.log`, terminal exit `0`.

The matching baseline then restored only the two owned `parse.ts` hunks with
`apply_patch`. Its parser SHA-256 was exactly the `HEAD` source
`9e5359d4944bf55da6e49d3c1bda495ae4a95a27dd5ca84a34a27f12fc3ab457`, and
the same focused fixture SHA-256 was
`eb1afffc2e212276b97ab03f8bdf91b5c28e280010323a3b964512b2d8821888`.
It exited `1` with 9 failures and 2 passes in 13.84s:
`.tmp/6721/baseline-focused-precleanup.log`.

- The eight non-Unicode atom/braced/class cases failed at the two deliberate
  `RegexUnsupportedError` sites.
- The literal standalone module failed at the same static parser refusals.
- The `u`/`v` property/bare-escape guard passed, as did the independent,
  exported-selector dynamic `new RegExp` control.

The candidate parser was restored with only those two hunks afterward
(candidate SHA-256
`3777c64f67b1585aa6097876d4dba9903700c780e78193543c81e3abedb7cb75`).
The removed `dynamic()` member in the static module's TypeScript export type
was an obsolete type declaration only; it changes no generated source or
semantic assertion. The final focused A/B receipts below use the corrected
fixture hash.

### Final focused baseline

After that type-only cleanup, the final focused baseline reran the same one
file under Node 24.19.0, one fork, and a 4 GiB fork heap. With parser SHA-256
`9e5359d4944bf55da6e49d3c1bda495ae4a95a27dd5ca84a34a27f12fc3ab457` and
final fixture SHA-256
`dd0e813e7897c23117219b46187789f08304ff6cacac7fd0f4f64c5748e1d027`, it
exited `1` after 15.57s: 9 failed, 2 passed, 11 total. The durable log is
`.tmp/6721/baseline-focused-final.log`.

The candidate hunk was then restored exactly (parser SHA-256
`3777c64f67b1585aa6097876d4dba9903700c780e78193543c81e3abedb7cb75`) while
the fixture remained byte-identical. The matching candidate result is recorded
next; this baseline by itself was not a completion claim.

### Final focused candidate

The candidate reran that corrected fixture under the same Node 24.19.0,
single-fork, 4 GiB configuration. It passed all 11 tests in 15.12s with
terminal exit `0`; durable log
`.tmp/6721/candidate-focused-final.log`. The focused test asserts both the
pure parser/compile/reference-VM behavior and a valid standalone module with
no `RegExp` host import. Its independent exported-selector `new RegExp`
control also passed for both nonconstant branches, so the already-working
dynamic non-u parser route remains a positive control rather than an inferred
unchanged path.

### Adjacent parser and v-mode regressions

After replacing the stale flags-0 `"\\p{L}"` refusal expectation with its
explicit native-parity identity semantics, the final scoped Node 24.19.0,
one-fork, 4 GiB run selected the focused #6721 fixture, the full
`tests/regex-bytecode.test.ts` parser suite, and
`tests/issue-2591-vflag-q-string-disjunction.test.ts`. All 350 tests across
3 files passed in 27.04s with terminal exit `0`:
`.tmp/6721/scoped-regressions.log`. This retains the real narrow refusal pins
and validates the existing v-mode property/string-set controls rather than
loosening their behavior.

### Quality gates

The normal quality set completed with terminal exit `0`:
`format:check`, `lint`, TypeScript 7 `typecheck`, `check:issues`, and the
mandatory LOC/function budget checks. Its durable receipt is
`.tmp/6721/quality.log`; the source budget measured one changed `src` file and
net `-8` LOC, with no unallowed function growth.

## Maintained original-row baseline receipt

The direct maintained Test262 baseline used the final exact manifest
`.tmp/6721/maintained-paths-v2.txt` (SHA-256
`31ae7243c1dc91cc56eab6622cad19e36bf6dfe764b630a65ee10f82fce0950a`):
the frozen original plus five accepted-census RegExp controls. The unchanged
original source SHA-256 was
`d08950bbcec4282b60bb9496f9a56823d0a74904e62aa6390a37abed9a5a4b2f`,
and the Test262 gitlink/corpus commit was
`b363f29d3c43c626dc852744ad64a0b48a003693`.

With the pristine parser SHA-256
`9e5359d4944bf55da6e49d3c1bda495ae4a95a27dd5ca84a34a27f12fc3ab457`,
the maintained baseline completed in 20.09s with terminal exit `1`:

- 5 passes and 1 `compile_error`, the frozen
  `annexB/language/literals/regexp/identity-escape.js` target;
- zero exclusions, and a successful completeness validator (exit `0`);
- result JSONL SHA-256
  `aabbc45368e9bbdcb283ad689f0d25bb4891bad4f3cf5d083d760edacf905900`;
- shard receipt SHA-256
  `3f69a3ca6d5abba7c02fa403f34423c200b96135bcb016c00339802213c838b1`.

This was the red baseline control. The matching candidate retained the exact
manifest, corpus, provider regime, and completeness accounting and is recorded
next.

### Maintained candidate and attributable transition

The candidate used the same exact six-path manifest, unchanged corpus source,
Node 24.19.0, `standalone` target, `auto` semantic providers, QuickJS engine,
one fork, and 4 GiB parent/fork/worker bounds. Its direct maintained runner
completed in 20.61s with terminal exit `0`, 6/6 passes, zero exclusions, and
a successful completeness validator (exit `0`):

- result JSONL SHA-256
  `43e8858b389a9a84f247bfe2c917db6eb96679e8b7364713b7acfdf5bdf2c8d0`;
- shard receipt SHA-256
  `de878c677f37be75a0b3156c99ed647f9e6df97704c96d49d5965c42573721dd`;
- candidate compiler and runtime bundle SHA-256 values
  `03d5f3d5a1f39238ddeece2e848f056518113d77070f4cd58997d30ff1fed05c`
  and `4ac7c182289ea06c5bfe377be54749d9c179a2111d383796c0fef94d2657bbba`;
- a separate candidate adapter key `3cc7e6b71ee2d254`, linked-pair verified
  against the approved immutable QuickJS artifact. Its adapter bytes SHA-256
  remained `8b96338e50a0c5a471c2b374f5ea8e1c9737caada447ee4f1020fdf9945a9ffb`,
  matching the distinct baseline adapter bytes while preserving a source-keyed
  cache identity.

The runner recorded the same six expected, registered, canonical, started,
and settled identities/callbacks on both arms. The sole transition is the
frozen `annexB/language/literals/regexp/identity-escape.js` original from
`compile_error` to `pass`; each of the five selected RegExp controls remained
`pass`. This establishes the narrow standalone gain without extrapolating to
the historical broad property-escape cluster.

## Scope and exclusions

Owned files are limited to `src/codegen/regex/parse.ts`, the focused #6721
test, its necessary stale-expectation correction in `tests/regex-bytecode.test.ts`,
and this issue file. The neighboring test previously classified non-u
`"\\p{L}"` as an unsupported Unicode property escape under flags `0`; that
contradicts the Node oracle and Annex B identity grammar. Its replacement
compares `p{L}`, `xp{L}y`, and `A` against native non-u behavior, while all
genuine syntax-error pins remain. This issue does not modify `regex-runtime/*`,
the RegExp VM, Unicode tables/enumerators, IR, shared runtime/dispatch, or the
active #6651 plan. It does not claim that every non-Unicode escaped character
or dynamic RegExp route needs work: the runtime `p`/`P` route is already
implemented and must remain a control.

## Acceptance criteria

- [x] Node behavior matrix is recorded before parser editing, including every
      non-Unicode/plain/braced/class and `u`/`v` guard result.
- [x] The focused parser/reference-VM and no-host-import standalone test has a
      matched baseline/candidate receipt with a byte-identical fixture and
      separately recorded baseline/candidate source hashes.
- [x] The unchanged original `identity-escape.js` has a maintained-runner
      candidate verdict, with exact positive-neighbor manifest and complete
      accounting; no diagnostic-only or `wrapTest()` result substitutes for it.
- [x] No `u`/`v` property behavior, invalid escape behavior, class dispatch,
      dynamic runtime-parser behavior, or unrelated RegExp feature changes.
- [x] Parent historical issue statuses remain unchanged. Implementation
      evidence is complete; publication and review remain pending.
