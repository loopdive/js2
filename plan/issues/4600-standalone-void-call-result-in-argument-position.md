---
id: 4600
title: "STANDALONE: a void-typed call result in ARGUMENT position arrives as a branded i32 zero — `typeof` reads \"boolean\", it stringifies \"0\", and `x === 0` is true"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: void
goal: es5
related: [4491, 4163]
origin: "2026-08-21 wave-2 obj-MOP lane. Reported rather than taken: a void-as-param-ValType change is a type-mapping fix with fingers in every call path, wider than a lane."
---

# #4600 — void call result materialised into a parameter slot is a branded zero

## Minimal repro (non-test262, verified standalone)

```js
var g = function () {};          // void function
function take(v) { return typeof v; }
take(g());                       // -> "boolean"   (expected "undefined")
"" + g();                        // -> "undefined" (correct — concat is fine)
var x = g(); x === 0;            // -> true        (x is physically an f64 zero)
```

The defect is confined to the coercion applied when a `void`-typed call result
is materialised into a parameter slot: direct concat is right, and `typeof` on
a local is right — but the local physically holds an f64 zero, and in argument
position the value arrives as a **branded i32 zero** (`typeof` "boolean",
stringifies "0").

## Why it was reported, not fixed, by the lane that found it

It is a `void`-as-param-ValType **type-mapping** change, not an ABI-boxing one —
every call path is a consumer. Note the related-but-distinct fix that DID land:
`dadeaaae` (wave-2 obj-MOP slice 2) fixed the void closure's RESULT boxing
across the dynamic `__call_fn_method_*` ABI (`null` → `undefined`); this issue
is the remaining static-call-path half.

## Blocked rows attached

`built-ins/Object/defineProperty/15.2.3.6-4-207`, `-208`, `-312` — their
`obj[0]` side is correct after `dadeaaae`; only the expected-value side
(`getFunc()` passed as an argument) is wrong.

## Acceptance criteria

- All three lines of the repro correct (`"undefined"`, `"undefined"`, `false`).
- The three rows pass, `target=standalone`.
- GC-lane suites relative to the merge base (call-path type mapping is as
  lane-shared as it gets) + the 551-row guard.
