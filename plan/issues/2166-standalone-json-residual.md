---
id: 2166
title: "Standalone JSON conformance residual (~76 tests)"
status: ready
sprint: 63
created: 2026-06-15
updated: 2026-06-15
priority: low
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: json
goal: standalone-mode
parent: 1599
---

# Standalone JSON conformance residual

## Problem

The standalone JSON parser/stringifier landed in #1599 (`done`, sprint 58).
The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows
**76 tests pass in host mode but fail standalone**, attributed to JSON
parse/stringify residuals — currently **untracked**.

## Evidence

- Gap category: `built-ins/JSON` 76; mix of runtime `fail` (reviver/replacer
  behavior, number formatting) and a few compile errors.

## Acceptance criteria

- Standalone pass count for `built-ins/JSON` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1599. Part of sprint-62 standalone catch-up (rank 12 by gap
impact). Likely benefits from the coercion engine (#1917) number/string path.

---

## Progress (2026-06-15, dev3) — boolean-typed `JSON.stringify` slice

**Status stays `ready`** — this is one slice of the 76-test bucket, not the
whole residual.

Investigation against `origin/main` @ `516feec44` found the standalone
`JSON.stringify` primitive/static-fold slices (#1324 / #1599) are in much
better shape than the gap suggests; verified working in standalone (compared
INTERNALLY, since standalone native strings don't marshal across the JS export
boundary):

- `JSON.stringify` of **static** object/array/number/string/nested literals →
  correct (folded by `tryEmitJsonStringifyStatic`).
- `JSON.stringify` of a **dynamic** number / string → correct.
- `JSON.parse` of a runtime number/`true`/`false`/`null` string → correct.

**One concrete bug fixed (this PR):** `JSON.stringify` of a **`boolean`-typed**
value (`const b: boolean = …`) refused to compile in standalone. TypeScript
models `boolean` as the union `true | false`, so the value carries the `Union`
type flag and was wrongly rejected by the ambiguous-shape early-return in
`tryEmitJsonStringifyPrimitive` (`src/codegen/expressions/calls.ts`) before
reaching the boolean stringify branch. The fix recognizes the `boolean` union
(`Boolean` flag + `intrinsicName === "boolean"`) ahead of the mask. Static
`true`/`false` literals were unaffected and keep working; a genuinely mixed
union (`boolean | number`) still falls through to the host import (intrinsicName
guard). Regression test: `tests/issue-2166.test.ts` (8 cases, host + standalone).

**Still open (the bulk of the 76):** `JSON.stringify` / `JSON.parse` of
**dynamic object graphs** (runtime-built objects, runtime JSON text →
object/array) still refuse with the #1599 Phase-2 compile error — they need the
pure-Wasm JSON codec + a dynamic value representation. That is the #1599 Phase 2
architect-spec follow-up (large; benefits from the #1917 coercion engine and the
value-rep work), not a point fix.

## Tech-lead note (2026-06-15, from dev3)

PR #1488 fixed one slice (standalone `JSON.stringify` of a boolean-typed value).
Stays `ready`: the ~75-test bulk is dynamic object-graph stringify/parse, needing
the #1599 Phase-2 pure-Wasm JSON codec + dynamic value rep (architect/senior).

## Progress (2026-06-16, d2) — `JSON.stringify(value, null, space)` indentation slice

**Status stays `ready`** — another increment of the bucket, not the whole residual.

Probing standalone JSON against `upstream/main` @ `cc833a2c9` surfaced a concrete
compile-error gap independent of the dynamic-graph bulk: the common pretty-print
form **`JSON.stringify(obj, null, 2)`** (and any call with a `space` argument) hit
the #1599 refusal. The static-fold caller in `src/codegen/expressions/calls.ts`
was gated on `expr.arguments.length === 1`, so a `space` argument was never
threaded into the compile-time fold.

**Fix (this PR):**
- `src/codegen/json-standalone.ts` — `tryEmitJsonStringifyStatic` now accepts the
  optional `replacer` and `space` args. A `null`/`undefined`/omitted replacer is
  honoured; a static numeric/string `space` is resolved (`staticSpaceValue`) and
  forwarded to JS's own `JSON.stringify(value, null, space)`, which applies the
  §25.5.2 clamping/indentation. A function/array replacer or a dynamic space
  returns `undefined` → the caller keeps the #1599 refusal (no silent wrong
  output).
- `src/codegen/expressions/calls.ts` — relaxed the gate to `>= 1` arg and pass
  args 1 (replacer) and 2 (space) through.

Regression test: `tests/issue-2166.test.ts` (+10 cases: numeric/string space,
nested, space 0, `null` replacer, `--target wasi`, 1-arg compact regression
guard, and refusal for function/array replacer + dynamic space). No `JSON_*`
host-import leak. Existing 8 boolean-slice cases + #1599/#1636 suites stay green.

**Still open (the bulk of the 76):** dynamic object-graph `JSON.stringify` /
`JSON.parse` (runtime-built objects, runtime JSON text → object/array) — needs
the #1599 Phase-2 pure-Wasm JSON codec + dynamic value rep (architect/senior).
