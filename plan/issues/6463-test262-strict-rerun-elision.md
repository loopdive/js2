---
id: 6463
title: "test262: elide the strict rerun for strict-neutral bodies (−23 % compile time on the honest lane)"
status: done
created: 2026-09-13
updated: 2026-09-13
completed: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: perf
area: test262-runner
goal: test262-conformance
sprint: current
es_edition: n/a
related: [3433, 3461, 3451, 6462]
files:
  - tests/test262-original-harness.ts
  - tests/issue-6463-strict-rerun-elision.test.ts
---

# #6463 — elide the strict rerun when the body is strict-neutral

## Problem

Test262 runs every unflagged script twice: sloppy, then with `"use strict"`
prepended. In this runner the rerun is a second FULL compile of the harness
assembly (runtime shim + assert.js + sta.js + includes + body), so it doubles
the dominant cost of every passing test.

Measured 2026-09-10 on a 60-test slice (`built-ins/Array/prototype/map` +
`language/statements/for-of`, `COMPILER_POOL_SIZE=1`, 4-core container):

| | value |
| --- | --- |
| compile share of wall time | ~98 % (compile sum 72.2 s, exec sum 1.1 s) |
| median `compile_ms` per test | 1,304 ms |
| in-process warm compile, 7 KB assembly | ~220 ms |
| in-process warm compile, 26 KB assembly (propertyHelper) | ~650 ms |
| body alone | 58 ms |

The median is ≈ 2× the single-compile cost because passing tests compile the
assembly twice.

## Why the rerun is elidable

A test flagged neither `onlyStrict` nor `noStrict` is one whose author asserts
identical behaviour in both modes. The rerun's only remaining job is to catch a
**compiler** bug in strict-mode lowering, and such a bug needs a
strict-sensitive construct in the body to act on. When the body has none, the
strict compile is the sloppy compile with a directive in front.

## Implementation (landed)

`resolveStrictRerun()` in `tests/test262-original-harness.ts`, applied by all
three assemblers (`assembleOriginalHarness`, `assembleNativeHarness`,
`assembleLinkedHarness`). Upstream flag gating is unchanged; on top of it the
rerun is kept when `findStrictSensitiveConstruct()` finds any of:

- `this`; `arguments`, `eval`; `.caller` / `.callee` / `.arguments`
- `with`; `delete`
- legacy octal numerics; octal / `\8` `\9` string escapes
- identifiers reserved only in strict code (`implements` … `yield`, `let`, `static`)
- function declarations in blocks (Annex B)
- assignment / `++` / `--` to an identifier declared nowhere in body or harness
  prefix (scope-insensitive, conservative)
- any negative test; any body TypeScript cannot parse cleanly

`TEST262_STRICT_RERUN=always` restores the unconditional rerun. An elided rerun
is recorded as `strictRerunSkipped: "strict-neutral"` on the assembly.

## Measurements

Corpus scan (48,735 files): 44,680 both-mode tests, **34,230 (77 %)** elide the
rerun. Constructs that keep it: `this` 4,163 · negative 4,023 · reserved/`eval`/
`arguments` identifiers 1,479 · `delete` 514 · octal escapes 131 · block
functions 46 · undeclared assignment 45 · property poison pills 25 · parse
diagnostics 24.

Same 60-test slice, before → after: compile sum 72.2 s → 55.3 s (**−23 %**),
median 1,304 → 914 ms, verdicts byte-identical (50 pass / 9 fail / 1
compile_error, same files).

## Acceptance criteria

- [x] Strict-neutral body ⇒ no `strictRerun` in all three assemblers; every
      listed construct keeps it (`tests/issue-6463-strict-rerun-elision.test.ts`).
- [x] `onlyStrict` / `noStrict` / `raw` / `module` gating untouched.
- [x] `TEST262_STRICT_RERUN=always` restores the old assembly byte-for-byte
      (#3461 AC#2 suite still passes under it).
- [x] Slice verdicts unchanged.
- [ ] Full merge-group run: pass count unchanged vs baseline (the gate that
      actually decides; a strict-lowering bug that only a neutral body exposes
      would show up here as `pass → fail`).

## Risk

A compiler bug in strict lowering that manifests WITHOUT any of the listed
constructs (e.g. directive-prologue handling, source-map offsets) is now
exercised only by the ~23 % of tests that keep the rerun plus all `onlyStrict`
tests. That population is large enough to catch a systematic bug; a bug
specific to one neutral test body would be missed.
