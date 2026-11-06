---
id: 7005
title: "standalone: `Array.from(<native generator>)` emits INVALID Wasm (`array.set[2] expected f64, found externref`) when the generator's element carrier is externref (`yield*` of a returning inner generator, `yield` inside catch/finally with a non-numeric fact); `for…of` over the same generator is correct"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: generators, Array.from, iteration
goal: standalone-gap
related: [3050, 680]
---

# `Array.from(generator)` assumes the f64 carrier

Reported by the 2026-10-15 audit (control-flow lane; CONFIRMED as a compile-time validation failure). Not re-run by the lead — reproduce first.

## Repro

```js
function* inner(){ yield 1; return 9; } function* outer(){ yield* inner(); yield 5; }
console.log(Array.from(outer()).join(","));   // node "1,5"; standalone: WebAssembly.Module(): __module_init: array.set[2] expected f64, found externref
```
Also `function* g(){ try { throw 1 } catch(e){ yield 10 + e; yield 12 } finally { yield 13 } }` with `Array.from(g())`.

## Root cause

- `src/codegen/generators-native.ts:540-580` `generatorElemValType` picks externref when a non-numeric fact is seen (`sawOther`: `yield*` of a non-numeric-array source, `10 + e`), but the `Array.from`-of-native-generator lowering (grep `Array.from` in `src/codegen/array-from-native.ts` / `array-from-vec-carrier.ts`) assumes the f64 element carrier when building the result vector.

## Implementation Plan

1. In the `Array.from(gen)` lowering, read the generator's `elemValType` and build the result array with the matching carrier (boxed/`any` array for externref), or box each element to the array's element type before `array.set`. Mirror what the `for…of` consumer does (it is correct).
2. If the mismatch cannot be resolved at compile time, the lowering must REFUSE (typed compile error), never emit an invalid module.
3. Tests: both repros, plus a numeric generator control (`function* g(){ yield 1; yield 2 }`) asserting the fast f64 path still applies.

## Acceptance

- Repros compile and match node on standalone; gc unchanged.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-7005-array-from-generator-externref-carrier.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
