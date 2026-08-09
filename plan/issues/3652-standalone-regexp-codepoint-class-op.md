---
id: 3652
title: "Standalone RegExp: compact code-point class opcode for property-escape residual"
status: done
assignee: ttraenkler/codex-regexp-completion
sprint: 77
created: 2026-07-26
updated: 2026-07-30
completed: 2026-07-26
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen
language_feature: regexp
goal: standalone
related: [2161, 2591, 2723, 2876, 3549, 3567]
loc-budget-allow:
  - src/codegen/native-regex.ts
func-budget-allow:
  - src/codegen/native-regex.ts::ensureRegexRun
files:
  - src/codegen/regex/bytecode.ts
  - src/codegen/regex/parse.ts
  - src/codegen/regex/compile.ts
  - src/codegen/regex/unicode.ts
  - src/codegen/regex/vm.ts
  - src/codegen/native-regex.ts
  - tests/issue-3652.test.ts
---

# Standalone RegExp code-point class opcode

## Problem

The latest standalone baseline (compiler source `52c498db`, whose only drift to
current `origin/main` `cf9b60e5` is planning/baseline-gate code) records
**450/469 passing** files under
`built-ins/RegExp/property-escapes/generated/`. Rechecking all 19 non-pass rows
through the real `scripts/test262-worker.mjs` under the repository's
authoritative Node 25.9.0 / Unicode 17 runtime leaves **11 real failures**:

- 4 `RangeError: regular expression step limit exceeded`:
  `Script_-_Unknown`, `Script_Extensions_-_Unknown`,
  `General_Category_-_Other`, and `Grapheme_Base`;
- 7 `v`-mode properties-of-strings rows (`Basic_Emoji`,
  `Emoji_Keycap_Sequence`, and the five `RGI_Emoji*` properties).

The other 8 baseline non-pass rows pass under the real worker's 30-second
ceiling. Running the same probe under local Node 24 is not authoritative: the
compiler intentionally uses its host RegExp as a compile-time Unicode oracle,
and Node 24 carries Unicode 16 rather than the CI/runtime contract's Unicode 17.

This reconciles the current frontier with the older #3549 result
(290/311 pass, then 4 step-limit + 10 timeout + 7 string-property rows): the
length-scaled budget remains effective, and the remaining code-point rows are
the deepest surrogate-alternation programs.

## Root cause

`enumerateClassRanges` already produces a sorted code-point range table, but
`cpRangesToNode` expands that compact table into a UTF-16 AST:

- one BMP `CLASS`;
- many lead/trail surrogate `concat` arms;
- a `SPLIT`/`JMP` chain across those arms.

For very large complement properties, every input code point executes and
backtracks through enough surrogate arms that the otherwise linear match costs
more than #3549's deliberately conservative 50 steps per input unit. Raising
that budget again would only weaken the ReDoS guard. The engine should consume a
Unicode code point and query the original range table directly.

The existing class-table representation and both existing VMs are sufficient.
This issue does not add another regex engine.

## Implementation plan

1. Append a stable `CPCLASS` bytecode opcode. It reconstructs one Unicode code
   point from the direction-aware UTF-16 input (one unit for BMP/lone
   surrogates, two for a valid pair), then queries the same class table.
2. Preserve enumerated u/v class ranges as a `cpclass` AST node instead of
   expanding them through `cpRangesToNode`. Literal astral characters and
   `\q{…}` string operands continue to use their existing sequence lowering.
3. Change the shared range-table matcher from a linear scan to binary search in
   both the TypeScript reference VM and hand-emitted Wasm VM.
4. Pin forward/backward code-point consumption, lone-surrogate behavior,
   compact program shape, the four real property-escape rows, and the existing
   catastrophic-backtracking guard.

## Prior attempts deliberately not repeated

- #3549 correctly scaled the flat step budget by subject length and recovered
  290/311 rows. Increasing the multiplier again treats the symptom and erodes
  its runaway-backtracking safety margin.
- #2723 specifies a separate PikeVM/linear engine. This bounded fix stays in
  the existing parser/compiler/backtracking VM path and does not create a
  parallel engine.
- #2591 implemented `\q{…}` string disjunctions but carved out properties of
  strings. Those seven rows are a distinct continuation slice and are not
  represented as ordinary code-point ranges here.

## Implementation Summary

The fix keeps the existing parser/compiler/backtracking-VM architecture. The
parser now carries enumerated u/v sets in a `cpclass` node and the compiler
stores their sorted, coalesced ranges in the existing class table. Appending
`CPCLASS` rather than renumbering an opcode preserves persisted bytecode
stability.

Both interpreter implementations reconstruct the input code point before
membership testing. Forward execution combines a lead surrogate at `sp` with a
trail at `sp + 1`; reverse lookbehind combines the trail at `sp - 1` with the
lead at `sp - 2`. A missing or mismatched partner remains a one-unit lone
surrogate. This direction-aware width is essential: treating CPCLASS as a
forward-only operation would silently corrupt lookbehind positions and capture
spans.

The issue's LOC contract is limited to `native-regex.ts`, whose measured
205-line growth implements CPCLASS directly in the hand-emitted Wasm VM:
direction-aware UTF-16 decoding, binary-search membership, and cursor update.
That logic cannot be delegated to the TypeScript reference VM, and no
project-wide LOC baseline is relaxed. The matching function receives the
corresponding function-level allowance because `ensureRegexRun` constructs the
single opcode-dispatch body and CPCLASS must share its existing locals,
backtracking state, and program-counter continuation. Extracting the case into a
second generated Wasm function would change the VM's control-flow and stack
contract rather than reduce implementation complexity.

The common class-table contract was tightened to sorted, disjoint ranges at
compile time, and both the TypeScript and emitted-Wasm membership helpers now
binary-search that contract. Canonicalizing every table also protects legacy
case-fold augmentation, whose source-order ranges are not necessarily sorted.
All parser call sites now use CPCLASS. The superseded
`cpRangesToNode` surrogate-alternation converter and its private helpers were
removed after the dead-export gate correctly identified that no live compiler
path could reach them. Keeping that second lowering path would invite semantic
drift between code-point matching implementations.

## Measured continuation map

The fetched standalone baseline provides a broader RegExp map, but its failures
must not all be labeled regex-engine gaps:

- `built-ins/RegExp`: 1,402 pass / 395 fail / 74 compile error / 8 compile
  timeout (1,879 total). Most failures are RegExp object/protocol behavior:
  `Symbol.replace` (59), `exec` (43 including compile errors), `Symbol.match`
  (34), `Symbol.split` (35), `test` (26), `Symbol.search` (20), and
  `Symbol.matchAll` (26).
- `language/literals/regexp`: 214 pass / 24 fail. Twenty-three failures are
  legacy root tests and one is named-group result exposure.
- String consumers (`match`, `matchAll`, `replace`, `replaceAll`, `search`,
  `split`): 137 pass / 102 fail / 99 compile error / 1 compile timeout. Their
  errors overwhelmingly concern coercion, symbol dispatch, replacement
  callbacks, reflection, or unsupported dynamic invocation rather than pattern
  execution.

After this code-point slice, the coherent remaining pattern-language cluster is
properties of strings plus v-set algebra: the 7 generated property-escape rows
and all 41 current `unicodeSets` failures are string-valued
`\p{Basic_Emoji}`/`\p{RGI_Emoji*}` or set operations involving `\q{…}`. That
requires representing finite strings as first-class set elements, not widening
CPCLASS or raising the step budget. The smaller named-group (29 non-pass) and
match-indices (13) clusters chiefly expose missing result-object shape,
duplicate-name protocol paths, or replacement plumbing. Of the three
lookbehind failures, two require callable `Array.prototype.map`; the remaining
`lookBehind/word-boundary.js` is the only measured row that merits a focused
core-matcher recheck as a later engine slice.

## Completion evidence

The exact standalone worker was run with Node 25.9.0 / Unicode 17, fresh
compiler/runtime bundles, the original Test262 harness, and a 30-second
per-file ceiling:

- historical #3549 property corpus: **300/311 pass, 11 fail** before;
  **304/311 pass, 7 fail** after;
- current generated property corpus: **458/469 live pass, 11 fail** before
  (the fetched JSONL's eight compile timeouts were stale and passed on
  recheck); **462/469 pass, 7 fail, 0 timeout/error** after;
- recovered rows: `Script_-_Unknown`,
  `Script_Extensions_-_Unknown`, `General_Category_-_Other`, and
  `Grapheme_Base`;
- the other 458 live-pass rows remained green. The seven residuals are exactly
  the already-carved-out properties of strings listed in the problem section.

Final-bundle spot rechecks of the four recovered rows plus
`General_Category_-_Surrogate` all pass. Validation also covers:

- `tests/issue-3652.test.ts`, #2091 step-cap, and #3549 budget suites:
  **18/18 pass**;
- pure RegExp bytecode: **277/277 pass**;
- #1911 lookaround/modifier suite: **87/87 pass**;
- #1912 class/backreference suite: **63/63 pass**;
- #2591 v-mode `\q{…}` suite: **61/61 pass**;
- `pnpm run typecheck`: pass;
- native standalone output: `WebAssembly.validate` and instantiation pass,
  including a 1,048,576-unit formerly step-limited property match.

The catastrophic-backtracking tests still throw the intended catchable
`RangeError`; no budget constant was relaxed.
