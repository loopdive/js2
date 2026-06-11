---
id: 2065
title: "for-of over an array hoists length and data once — mutation during iteration not observed (push invisible, pop over-iterates)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: iterators
goal: iterator-protocol
related: [365, 1130]
origin: "2026-06-10 deep-audit sweep (control-flow agent): verified miscompile on main"
---

# #1945 — for-of array fast path snapshots length/data

## Problem

Array iterators ([§23.1.5.1](https://tc39.es/ecma262/#sec-createarrayiterator))
re-read the live length each step. The for-of array fast path snapshots the
vec's `data` and `length` once before the loop, so elements pushed during
iteration are never visited and popped elements are still visited (stale data
pointer also breaks if growth reallocates the backing array).

## Repro (verified on main)

```ts
export function grow(): number {
  const arr: number[] = [1, 2, 3];
  let log = 0;
  for (const x of arr) { log = log*10 + x; if (x === 1) arr.push(4); }
  return log;
}
export function shrink(): number {
  const arr: number[] = [1, 2, 3, 4];
  let log = 0;
  for (const x of arr) { log = log*10 + x; arr.pop(); }
  return log;
}
```

| fn | wasm | node |
|----|------|------|
| `grow` | `123` | `1234` |
| `shrink` | `1234` | `12` |

## Root cause

`src/codegen/statements/loops.ts:2696-2718` (`compileForOfArray`) snapshots the
vec's `data` array and `length` into locals once before the loop; the loop
condition (:2773-2777) compares against the stale `lenLocal`, and element reads
go through the stale `dataLocal`.

## Fix direction

Re-read `length` (struct.get field 0) and `data` (field 1) from the vec local
at the top of each iteration instead of hoisting; keep the hoisted form only
when the body provably doesn't mutate the array — the
`loopBodyMutatesIndexOrArray` analysis at loops.ts:228 already exists for
bounds-check elimination and can gate this.

## Acceptance criteria

- Both repros match Node
- Reallocation-during-growth case correct (push past capacity mid-loop)
- Non-mutating loops keep the hoisted fast path (no perf regression)

## Dupe check

Grepped `mutat` + `for-of`, `stale length`, `collection mutation`: #365 (done —
only removed runner skip filters), #1130 (getter-observing array methods,
different). Not covered.
