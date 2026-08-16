---
id: 4509
title: "test262 print shim is a statement-position console.log — couples #4462's console claim surface to every suite compile once param types resolve"
status: ready
sprint: Backlog
created: 2026-08-16
priority: medium
horizon: s
feasibility: medium
task_type: hardening
area: ir, test262
goal: ir-full-coverage
related: [4462, 4605]
origin: "dev-4605-park diagnosis 2026-08-16 — found while refuting the #4605 park (which was stale-base collateral, not a real regression)"
---

# #4509 — test262 `print` shim exactly matches the console claim surface

## Finding (measured 2026-08-16)

`scripts/test262-fyi-runtime.js` is prepended verbatim to every non-raw
test262 test and contains:

```js
var print = function (value) { console.log(value); };
```

— a statement-position, single-argument `console.log` that matches
`isHostFreeConsoleCallReceiver` (#4462) **exactly**. Today it is inert: the
untyped `value` parameter keeps the unit out of IR claiming (byte-identity
measured 440/440 across the class-elements family on main vs the #4605
branch, with a live positive control). But any future widening of param-type
resolution makes the console claim surface live across the ENTIRE test262
suite in one step — a maximal-blast-radius coupling that would surface as a
suite-wide diff attributed to whatever innocent PR lands the widening.

## Acceptance criteria

1. A test pins the current inertness: compile the shim shape
   (`var print = function (value) { console.log(value); };` at top level with
   an untyped param) and assert byte-identity IR-on vs IR-off, so the day it
   goes live is a deliberate test flip, not a surprise.
2. A decision is recorded (in this issue) whether the console surface should
   claim an untyped-param forwarder at all, or demote it by policy until
   #2949's union/dynamic value work lands.
