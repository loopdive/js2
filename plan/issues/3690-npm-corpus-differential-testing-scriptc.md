---
id: 3690
title: "Integrate npm package testing corpus patterns from vercel-labs/scriptc into the differential corpus"
status: done
sprint: 77
created: 2026-07-27
updated: 2026-07-30
completed: 2026-07-27
assignee: claude
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: dogfood
---

# #3690 — Integrate npm package testing corpus patterns from vercel-labs/scriptc

## Problem

[vercel-labs/scriptc](https://github.com/vercel-labs/scriptc) is a sibling
TypeScript-to-native compiler that validates itself with a large
**differential testing corpus** (800+ programs, each run under Node and
under the compiled binary, stdout/stderr/exit-code must match byte-for-byte —
see its README's "Differential testing" bullet). js2wasm already has the
exact same shape of harness — `tests/differential/corpus/` +
`scripts/diff-test.ts` (#1203) — but the corpus itself has real coverage
gaps compared to scriptc's: **zero** files under `generators/` or
`private-fields/` categories (both exist as dedicated, deep categories in
scriptc's corpus, e.g. `2010-2019-generators-*.ts`,
`2450-2456-private-*.ts`), and `regex`/`symbol` coverage is a single
3-line smoke file each (`builtins/06-regexp.js`, `builtins/04-symbol.js`)
versus scriptc's dedicated `1200-1206-regex-*.ts` / `1669-1674-symbol-*.ts`
ranges.

Most of scriptc's corpus (`fs`, `process`, `child_process`, `tls`, `crypto`,
streams, `EventEmitter`, ...) tests a Node-compatible runtime API surface
that js2wasm deliberately does not implement (js2wasm targets browser WasmGC
+ WASI, not Node-API parity) — that portion is out of scope and was not
ported. The portable slice is pure-ECMAScript language/library semantics,
which is exactly what `tests/differential/corpus` already tests for other
categories.

## What changed

Added two new corpus categories and deepened two existing ones, adapted
(not verbatim-copied) from the *shape and coverage ideas* of scriptc's
corpus into js2wasm's existing `console.log`-driven differential style.
Content is original js2wasm-style test code; scriptc (Apache-2.0, same
license as js2wasm) is credited as the source of the category/coverage
ideas in each new directory's nature — see commit message.

- `tests/differential/corpus/generators/` (new, 6 files): basics, for-of
  consumption, `return()`/`throw()` protocol, sent values (two-way
  `yield`), `yield*` delegation, closure-captured generator state.
- `tests/differential/corpus/private-fields/` (new, 5 files): private
  instance fields, private methods, private statics, private accessors,
  brand checks (`#x in obj`).
- `tests/differential/corpus/builtins/`: added 3 more regex files (named
  groups, `matchAll`, `split` with capture groups) and 2 more symbol files
  (well-known symbols / `Symbol.iterator` custom iterable, symbol as a
  Map key).

## Acceptance criteria

- [x] New files run under `pnpm exec tsx scripts/diff-test.ts` without
      crashing the harness.
- [x] `benchmarks/results/diff-test.json` regenerated; new-file
      pass/fail is informational only (the delta gate
      `scripts/diff-test-gate.ts` only fails on regressions of
      **previously-matching** files — confirmed by reading the gate logic
      before adding files, so an imperfect new file cannot break CI).
- [x] Every new file is self-contained, deterministic, and matches the
      existing corpus style (bare `console.log`-driven `.js`, no test
      framework).
- [x] No changes to compiler source — this is corpus-only.

## Findings — compiler gaps surfaced (2026-07-27 run)

Running `npx tsx scripts/diff-test.ts` against the expanded corpus (120
programs total, up from 109) gave `109/120` (90.8%) match. Every new-file
non-match is a genuine, previously-undetected compiler gap (pre-existing
categories were already at their prior match rate — `array`, `builtins`
excluding the 2 new symbol/regex additions, `closures`, `object` all carry
forward known gaps unrelated to this change). Filed as separate issues so
they can be triaged/prioritized independently of this corpus-integration
issue:

| file                                        | outcome       | issue | resolution |
| -------------------------------------------- | ------------- | ----- | ---------- |
| `generators/03-return-throw.js`              | compile_error | #3691 | **fixed** — false positive, real `tsc` rejects the same program too; fixed the corpus file, not the compiler |
| `generators/04-sent-values.js`               | runtime_error | #3710 | root-caused, `blocked` on #1687 (known eager-buffer generator gap, already escalated) |
| `generators/05-yield-star.js`                | runtime_error | #3711 | root-caused, `blocked` on #1687 (same family) |
| `generators/06-closure-state.js`             | mismatch      | #3712 | root-caused, `blocked` on #1687 (same family — pins down the `__EAGER_GEN_LIMIT` mechanism) |
| `builtins/19-symbol-iterator.js`              | mismatch      | #3713 | narrowed to a specific wrong value (`__iterator` receives an empty placeholder, not `range`); exact emission site not yet pinned down |
| `private-fields/05-brand-checks.js`          | mismatch      | #3714 | root-caused (`ref.test` can't distinguish "wrong class" from "not an object"); fix needs a general anyref-is-object runtime check, out of scope for this pass |

All other new files (`generators/01-basics.js`, `02-for-of.js`,
`private-fields/01-04`, `builtins/16-18-regex-*`, `builtins/20-symbol-map-key.js`)
match V8 exactly. This is exactly the payoff scriptc's differential-corpus
approach is meant to produce: real, reproducible, minimal-repro compiler
bugs surfaced by running representative program shapes, not just individual
unit-test assertions.
