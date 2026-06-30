---
id: 2872
title: "Standalone: TypedArray.prototype.* cluster (294 host-pass/standalone-fail, de-masked from #2862)"
status: ready
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 2651]
umbrella: 2860
---

# Standalone: TypedArray.prototype.\* failures (de-masked)

## Problem

The single largest concrete standalone cluster surfaced by the #2870 de-mask:
~**294** `built-ins/TypedArray/prototype/**` tests are host-pass but
standalone-fail (previously mis-recorded under the phantom "Cannot convert object
to primitive value" signature, #2862). Plus ~39 `TypedArrayConstructors/**`.

## Representative repros

- `test/built-ins/TypedArray/prototype/fill/length.js` — `verifyProperty`
  /`propertyHelper` over `%TypedArray%.prototype.fill` (arity/name + descriptor).
- `test/built-ins/TypedArray/prototype/toLocaleString/prop-desc.js`.

These hit `propertyHelper.js`/`verifyProperty` reflective descriptor reads over
TypedArray prototype members and throw a Wasm exception in standalone.

## Root cause (to triage)

Likely a mix of: (a) `%TypedArray%.prototype` member descriptor reflection not
materialised standalone (overlaps the native-proto glue work #2651/#2861), and
(b) `ToIndex`/`ToNumber` coercion of object args (`fill(value,start,end)` with
object bounds). Triage per sub-path with `runTest262File(file,cat,undefined,"standalone")`,
group by the exact assertion that throws.

## Test plan

`test/built-ins/TypedArray/prototype/**` standalone fail → pass; full
`merge_group` + standalone high-water. `ctx.standalone` only.

(Large — split into sub-tasks per failing member family if the root causes
diverge.)
