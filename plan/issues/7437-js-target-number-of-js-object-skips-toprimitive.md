---
id: 7437
title: "JS target: `Number(o)` on a JS object returns NaN and never reads `valueOf` / `toString`"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: high
horizon: s
task_type: bug
area: runtime, boundary
goal: core-semantics
related: [7380, 6708, 6979]
---

# #7437 — `Number(o)` on a JS object skips ToPrimitive on the JS target

## Problem

A wrong answer on the JS target (`target: "host"`, ordinary pipeline, `experimentalIR: false`):

```ts
export function run(o: any): number { return Number(o); }
```

Called from JavaScript:

| argument | js2wasm | node |
| --- | --- | --- |
| `{ valueOf() { return 5; } }` | NaN | 5 |
| `{ toString() { return "6"; } }` | NaN | 6 |
| `{ get valueOf() { throw 99; } }` | NaN, getter never read | throws 99 |
| null prototype, `valueOf: undefined`, `toString` getter returning `() => 7` | NaN (the getter is read) | 7 |

The object reaches the module through the `__boundary_object_*` imports; ToPrimitive on it neither calls `valueOf`
nor `toString`. Measured on `claude/7380-pins-a` `e41fd9cc1d` (#7380 PR 2b triage).

## Evidence

`tests/issue-3518-host-coercion-get-abrupt.test.ts`, 10 red tests (utf8 off and on): "propagates number / object /
type-error / runtime-error from the original getter without reading toString", "keeps ordinary fallback for missing,
noncallable and object-returning valueOf".

## Acceptance criteria

1. The four rows above give node's answer, with and without `utf8Storage`.
2. The 10 tests of `issue-3518-host-coercion-get-abrupt` pass unchanged.
3. Standalone output unchanged.
