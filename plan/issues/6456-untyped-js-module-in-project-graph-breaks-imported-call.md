---
id: 6456
title: "An untyped `.js` module in a `compileProject` graph breaks every call into it — traps on wasi/standalone, silently returns 0 on gc"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Found while building the [#6428](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6428-standalone-async-return-thenable-value-sink)
regression fixture, which the plan had specified as an untyped `.js` producer +
a `.ts` entry (the dogfood package shape). The fixture failed for a reason that
has nothing to do with #6428: **any** imported function from an untyped `.js`
module in the graph answers wrongly.

The minimal repro has no async, no Promise, no cast — a two-file project whose
producer half is `.js` instead of `.ts`:

```js
// mod.js
export function c2() { return 7; }
```

```ts
// entry.ts
import { c2 } from "./mod.js";
export function tc2(): number { return c2(); }
```

## Measurement (2026-09-13, upstream/main dcdd1efa13, `compileProject` + `WebAssembly.instantiate(binary, importObject)`)

| producer half | `--target wasi` | `--target standalone` | gc / host (default) |
| --- | --- | --- | --- |
| `mod.js` (untyped) | **trap** (`WebAssembly.Exception`) | **trap** | **`0`** (silent wrong answer) |
| `mod.ts` (typed, same body) | `7` | `7` | `7` |
| no second file (body inlined into `entry.ts`) | `7` | `7` | `7` |

`compileProject` reports `success: true` with zero errors in every row, so there
is no compile-time signal at all. The gc row is the worse one: it does not trap,
it returns `0`.

Probe: `.tmp/probe-6456.mjs` on the #6428 worktree (three shapes × three
targets, `compileProject` + `WebAssembly.instantiate`).

## Why it matters

Every dogfood package half is untyped `.js`. The dogfood suites pass, so the
suite runner's own project assembly must be avoiding whatever this path does —
which means the defect is in the plain `compileProject` graph route that an
external user of the compiler hits first. A wrong answer with `success: true`
and no diagnostic is the most expensive failure shape we ship.

## Acceptance criteria

1. All three `mod.js` rows above answer `7`, matching the `mod.ts` rows.
2. Regression test under `tests/` covering the untyped-`.js`-producer project on
   `wasi`, `standalone` and gc, with the `mod.ts` twin as the anti-vacuity
   control.
3. If some part of the untyped-`.js` graph route is genuinely unsupported, it
   must be a **compile error**, never `success: true` with a wrong answer.

## Notes for whoever picks this up

Start by diffing the emitted module for the `mod.js` and `mod.ts` rows — same
body, same entry, so the delta isolates whatever the `.js` route drops (a
signature/ABI mismatch at the cross-module call is the first hypothesis: gc
returning `0` rather than trapping smells like a numeric result read off the
wrong carrier, and wasi/standalone trapping on the same call site fits a
cast/`ref.cast` on a mistyped result).
