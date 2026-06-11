---
id: 2030
title: "IteratorResult.done stringifies as 0/1 (raw i32, no boolean brand); exhausted .value becomes NaN instead of undefined"
status: done
sprint: 61
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: generators
goal: core-semantics
related: [2035, 2016, 1931]
origin: "2026-06-10 spec-conformance sweep (iterators agent): verified on main"
---

# #2030 — .done typed raw i32; .value(f64) erases undefined

## Problem

```ts
function* g() { yield 1; yield 2; yield 3; }
const it = g(); let s = "";
let r = it.next();
while (!r.done) { s += r.value + "," + r.done + ","; r = it.next(); }
s += r.value + "," + r.done;
// wasm: "1,0,2,0,3,0,NaN,1"   node: "1,false,2,false,3,true,undefined,true"
```

(The trailing `3,true` vs `3,0` discrepancy interacts with #2035.)

## Root cause

`src/codegen/property-access.ts:2706-2713` types `.done` as raw `i32` with
no boolean brand → numeric stringification; `:2694` routes `.value` of
`IteratorResult<number>` through `__gen_result_value_f64`, whose host shim
(`src/runtime.ts:8352-8360`) does `Number(undefined)` = NaN.

## Fix direction

Brand `.done` as boolean (same brand comparisons carry, cf. #2016); for
`.value` after exhaustion, return externref or guard the f64 path so
undefined survives (coordinate with #1852 representation work).

## Acceptance criteria

- Repro matches Node; numeric contexts of `.done`/`.value` unchanged

## Dupe check

#1620/#1684 are standalone iterator-result struct wiring. New.
