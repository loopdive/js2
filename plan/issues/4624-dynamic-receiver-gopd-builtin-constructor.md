---
id: 4624
title: "standalone: Object.getOwnPropertyDescriptor(obj, name) through a DYNAMIC receiver answers undefined for a builtin constructor — repairs the two vacuous-pass rows #4519 exposed (S15.3.3.1_A1/_A3)"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: standalone-gap
related: [4519, 4479, 4506]
origin: "dev-4519 residual 6 (2026-08-23): the −2 its guard cost were vacuous passes riding on exactly this gap. Lead routing decision: repair the descriptor lookup so both rows pass for a real reason."
---

# #4624 — dynamic-receiver gOPD for builtin constructors

## Problem (measured by dev-4519)

| shape | result |
| --- | --- |
| `Object.getOwnPropertyDescriptor(Function, "prototype")`, LITERAL receiver | object ✓ |
| `Object.getOwnPropertyDescriptor(o, "a")` via a dynamic parameter, plain object | object ✓ |
| `Object.getOwnPropertyDescriptor(obj, name)` via a dynamic parameter, `obj = Function` | **undefined** |

`object-runtime.ts` states the rule at `__getOwnPropertyDescriptor`'s
registration: missing own prop / **non-`$Object` receiver → undefined** —
and a builtin-constructor carrier is not a `$Object`. The literal-receiver
form works because a static arm intercepts it before the runtime helper.

Consequence: test262's real upstream `propertyHelper.js` (line 457 reads
`.configurable` off the descriptor) turned `built-ins/Function/prototype/
S15.3.3.1_A1.js` and `_A3.js` into VACUOUS passes — `!undefined` satisfied
the assert. #4519's member-get guard (merged) makes that read throw, so
both rows now FAIL honestly. This issue makes them pass for a real reason.
The exposure class is bounded: of the complete 248-file set calling any
deprecated descriptor verifier, exactly these 2 flip (#4519's Test
Results).

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   the three-shape table on current campaign HEAD first.
2. Read the static literal-receiver arm (what does it answer for
   `Function.prototype`? — reuse its answer) and `__getOwnPropertyDescriptor`
   in `object-runtime.ts`. The fix: give the runtime helper an arm for
   builtin-constructor carriers (the #4485/#4621-C carrier family exposes
   callable constructor globals with own `length`/`name`/`prototype`) that
   answers the §20.2.3/§10.2.x-correct descriptor for the own properties
   the carrier actually serves — at minimum `prototype`
   ({writable:false, enumerable:false, configurable:false} for Function
   per §20.2.3). Decline shapes the carrier cannot answer honestly
   (absent-not-wrong) rather than fabricating descriptors.
3. Acceptance rows: `built-ins/Function/prototype/S15.3.3.1_A1.js` and
   `_A3.js` pass; the 246 unmoved verifier files stay unmoved (re-run the
   248-file set, own runs, both arms).
4. Pins: tests/issue-4624.test.ts — the three-shape table as positives,
   verifier-row positives, residual pins for declined shapes.
