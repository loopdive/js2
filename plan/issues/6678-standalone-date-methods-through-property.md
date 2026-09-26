---
id: 6678
title: "standalone: a Date stored in an object property loses its methods on read-back (`o._d.getTime()` → undefined) — moment's next standalone-dynamic blocker"
status: ready
sprint: current
created: 2026-09-24
updated: 2026-09-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [6674, 6671, 5208]
---

# #6678 — standalone: Date methods vanish through an object property

## Problem

After #6674, moment's npm-compat `standalone-dynamic` lane passes module-init
and reaches the checksum, which is wrong:

```
checksum mismatch: Wasm 12, Node 10
```

`12` is `"Invalid date".length`: every moment is invalid in standalone, even
`moment(1577923200000)`. moment keeps its Date in `this._d` and validates it
with `this._d.getTime()`; in standalone that call answers `undefined`, so
`isNaN(...)` makes the moment invalid.

Minimal repro (`--target standalone`, no moment, measured 2026-09-25 on the
#6674 branch merged with main `1b733c858e`):

```js
function box(v) { var o = {}; o._d = v; return o; }
var b = box(new Date(1577923200000));
var a = [new Date(1577923200000)][0];
```

| expression | standalone | expected |
| --- | --- | --- |
| `a.getTime()` (array element) | `1577923200000` | same |
| `b._d.getTime()` | `undefined` | `1577923200000` |
| `b._d.getFullYear()` | `undefined` | `2020` |
| `typeof b._d.getTime` | `"undefined"` | `"function"` |
| `b._d.valueOf()` | the `toString()` text | `1577923200000` |
| `Object.prototype.toString.call(b._d)`, `b._d instanceof Date` | `[object Date]`, `true` | same |

So the carrier survives the property round-trip (brand and `instanceof` are
right), but a member read on the untyped property value does not reach the
`Date.prototype` methods. `valueOf` falls to the generic `Object.prototype`
path.

The earlier content of this issue (a `console.warn` VALUE read threw) was fixed
on main by #6671 before this issue was picked up; re-probed 2026-09-25:
`typeof console.warn` → `"function"`, `console.warn ? "t" : "f"` → `"t"`.

## Acceptance

- Every row above answers the expected value in `--target standalone`, with no
  new host import.
- Re-run `npx tsx scripts/generate-npm-compat-report.mjs --only moment
  --no-write --perf-only --lane standalone-dynamic` and record the next status.
