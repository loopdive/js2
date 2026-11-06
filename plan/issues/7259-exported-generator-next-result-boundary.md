---
id: 7259
title: "Native regime: an exported generator's next() result crosses the JS boundary with no value/done"
status: ready
sprint: Backlog
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: generators
goal: correctness
parent: 6979
related: [7010, 6708, 1169, 1665, 2662]
---

# #7259 — exported generator: `next()` result has no `value` / `done` at the JS boundary

## Problem

A generator object that crosses the export boundary into JS answers `next()`
with an empty object. Measured on the S7-d base `6a20eb9f18` and on
`upstream/main` `ed76cef7a0` (identical):

```ts
export function* gen(): Generator<number> { yield 1; yield 2; return 0; }
```

Called from JS through the embedder view (`wrapCompiledExports`): `gen()`
returns an object with a callable `next`, but `gen().next()` is
`[Object: null prototype] {}` — `value` and `done` are both `undefined`.
Inside Wasm the same generator works (`export function test() { const it =
gen(); return it.next().value + it.next().value }` answers `3`).

This is fallout of #7010. Before it, an exported generator used the eager host
buffer (`__create_generator`), which returned a real JS iterator. #7010 made
that buffer unreachable, so the native generator's IteratorResult now crosses
the boundary unadapted. #6979 S7-f deleted the dead provider; it did not cause
this.

## Witness rows (marked `it.fails` against this issue by #6979 S7-f)

All 11 fail identically on `upstream/main` `ed76cef7a0`:

- `tests/issue-1169f-7a.test.ts` — "legacy and IR paths produce the same yield sequence" ×3
- `tests/issue-1169f-7b.test.ts` — the same describe ×5
- `tests/issue-1665.test.ts` — "compiled generators resolve Iterator.prototype helpers", "preserves the compiler-owned %IteratorPrototype% object…" ×2
- `tests/issue-2662-gc-lazy-nested-generators.test.ts` — "GUARD: an exported (escaping) generator stays a JS-callable Generator" ×1

## Acceptance

- An exported generator's `next()` / `return()` / `throw()` results read
  `value` and `done` as JS values at the boundary (§27.5.3.3 / §7.4.14
  CreateIterResultObject), and the object inherits the helper-bearing
  `Iterator.prototype` (#1665).
- The 11 rows above pass as plain `it` (drop the `it.fails`).
