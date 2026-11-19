---
id: 7399
title: "Native parseInt: the radix is not converted with ToInt32 (parseInt(s, 4294967312) answers NaN)"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime
goal: ir-full-coverage
related: [7350, 1663]
---

# #7399 — Native parseInt: the radix is not converted with ToInt32

## Problem

ECMA-262 §19.2.5 `parseInt(string, radix)` step 8: `Let R be ℝ(? ToInt32(radix))`. A radix of 2³² + 16
(4294967312) is therefore 16, and `parseInt("ff", 4294967312)` is 255. The standalone native `parseInt`
(`buildParseIntDefinition`, `src/runtime/wasmgc/values/parse-number-bodies.ts`, moved from
`src/codegen/parse-number-native.ts` by #7350 B2c-1) answers NaN: it truncates the f64 radix without the
modulo-2³² wrap, so an out-of-int32-range radix falls outside 2..36.

Found by review RV7323b of PR #7323 (an edge-input sweep with radix 0 / 1 / 2 / 8 / 10 / 16 / 36 / 37 / −1 /
NaN / 2³² + 16). The behaviour is the same on main `89e4748241`; the move did not change it.

## Fix

Apply ToInt32 to the radix (wrap modulo 2³², then sign-extend) before the 0 / 2..36 checks, in the one body
builder, so the codegen native and the realm's `%parseInt%` (B2c) share the fix.

## Acceptance

- `parseInt("ff", 4294967312) === 255`, `parseInt("11", -4294967294) === 3` (ToInt32 gives 2), and the existing
  radix rows (0, 1, 37, −1, NaN, `undefined`) keep their answers; checked against node on standalone and WASI.
- The test262 `built-ins/parseInt` rows that cover radix conversion pass on standalone (re-measure; name them
  in the PR).
