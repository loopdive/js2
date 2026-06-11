---
id: 1525b
title: "ToPrimitive residuals: object-method trampoline invalid Wasm + §7.1.1.1 step-6 TypeError"
status: done
created: 2026-05-27
updated: 2026-06-11
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: to-primitive, abstract-operations
goal: spec-completeness
sprint: 61
related: [1525, 1602, 1669, 1130, 983, 1253]
test262_fail: 142
claimed_by: codex-developer
claimed_at: 2026-06-06T18:07:15.311Z
pr: 1254
completed: 2026-06-06
---
# #1525b — ToPrimitive residuals carved from #1525

Carved from #1525 after root cause #1 (`new Object()` / `Object()` →
ordinary-prototype object) landed as its own PR. These two remaining root
causes are independent and hard; they need an architect spec before a dev
fix.

## Root cause #2 (the dominant ~142) — object-method trampoline invalid Wasm

Object literal with a user `toString`/`valueOf` coerced via an explicit
`String(obj)` / `String.prototype.trim*` / `charAt` etc. throws because the
object-method trampoline + `__extern_toString` path can't dispatch the user
method. The concrete failure is **invalid Wasm** in
`finalizeMethodTrampolines` (`src/codegen/closures.ts`): a double
`f64.convert_i32_s` (`expected i32, found f64`) when the wrapper/method-result
kinds drift.

Overlaps:
- #1602 / #1669 — trampoline signature drift
- #1130 / #983 — host struct-method dispatch / live-mirror

Failing unit case (skipped in `tests/issue-1525.test.ts`):
`explicit String(obj) calls toString even with valueOf present`.

## Root cause #3 — §7.1.1.1 step-6 TypeError

When both `valueOf` and `toString` return objects, `ToPrimitive` must throw a
`TypeError` (§7.1.1.1 step 6). Currently the path bottoms out (eager
`extern.convert_any` + later `__unbox_number` silently yields
`"[object Object]"` → NaN) instead of surfacing the error to the Wasm
`catch_all`, so a user `try/catch` never observes it.

Failing unit case (skipped in `tests/issue-1525.test.ts`):
`TypeError when both valueOf and toString return objects`.

## Acceptance criteria

1. `String(obj)` with a user `toString` returns the string result (no invalid
   Wasm from `finalizeMethodTrampolines`).
2. `obj + 1` where both `valueOf`/`toString` return objects throws a
   `TypeError` observable in a Wasm `try/catch`.
3. Un-skip the two `tests/issue-1525.test.ts` cases referencing #1525b.
4. No regression in the #1525 root-cause-#1 fix.

## Notes

Needs an architect spec — the trampoline-result coercion drift is shared with
#1602/#1669 and the host struct-method dispatch with #1130/#983. Do not inline
a localized patch.

## Refreshed standalone evidence - 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The standalone root-cause classifier assigns **876** rows to the ToPrimitive /
object-to-string dispatch family shared by #1525, #1525b, and #1759. The
dominant runtime signature is still:

```text
Cannot convert object to primitive value
```

Example files:

- `test/language/expressions/grouping/S11.1.6_A3_T6.js`
- `test/language/expressions/logical-not/S11.4.9_A3_T4.js`

The current artifact shows this is no longer just the original `new Object()`
null-prototype bug; that was fixed in #1525. The remaining standalone root
cause still points at dynamic object method dispatch, user `toString` /
`valueOf` trampoline paths, and native number/string bridge behavior.

## Implementation Summary - 2026-06-06

Current `main` already contains the #1525b implementation from PR #871
(`fix(#1525b): ToPrimitive residuals — trampoline shift + ref→f64 step-6`).
This issue file had been reset to `ready`, so this branch reconciles the
stale metadata and records the final validation status.

What landed in PR #871:
- `pendingMethodTrampolines` side-channel indices are shifted with late import
  insertion, with a defensive `finalizeMethodTrampolines` guard for missed
  shifts.
- Ref-returning `valueOf` paths now route through the existing
  `emitToPrimitiveHostCall` helper so OrdinaryToPrimitive can fall through to
  `toString` and throw TypeError when both methods return objects, matching
  ECMA-262 §7.1.1.1.
- The skipped #1525 cases were unskipped, and focused coverage was added in
  `tests/issue-1525b.test.ts`.

Validation on this branch:
- `pnpm test tests/issue-1525b.test.ts tests/issue-1525.test.ts` — 15 tests
  passed.
