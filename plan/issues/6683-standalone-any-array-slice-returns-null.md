---
id: 6683
title: "standalone: `<any array>.slice(0)` answers null (`id([1,2,3]).slice(0)`) — moment's next standalone-dynamic blocker"
status: ready
sprint: current
created: 2026-09-26
updated: 2026-09-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6678, 6447]
---

# #6683 — standalone: `.slice(0)` on an `any` array receiver answers null

## Problem

After #6678, moment's npm-compat `standalone-dynamic` lane gets past
validation (`moment(1577923200000).format("YYYY-MM-DD")` is right) and fails
the checksum phase on the string-input workload with (verbatim):

```
TypeError: Array.prototype.some called on null or undefined
```

moment's string parser ends `configFromStringAndFormat` with
`getParsingFlags(config).parsedDateParts = config._a.slice(0);` and `isValid`
then runs `some.call(flags.parsedDateParts, …)`. `config` is a parameter, so
`config._a` is an `any` array, and its `.slice(0)` answers null.

Minimal repro (`--target standalone`, measured 2026-09-26 on the #6678 branch):

```js
function id(v) { return v; }
id([1, 2, 3]).slice(0);            // null        (expected: a 3-element copy)
function run2(c) { c._a = [2020, 0, 2]; return c._a.slice(0); }
run2({});                          // null
var c = {}; c._a = [1, 2, 3]; c._a.slice(0);   // ok (length 3) — receiver typed locally
```

## Acceptance

- The rows above answer a copied array in `--target standalone`, no new host
  import.
- Re-run `npx tsx scripts/generate-npm-compat-report.mjs --only moment
  --no-write --perf-only --lane standalone-dynamic` and record the next status.
