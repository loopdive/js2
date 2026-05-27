---
id: 1525b
title: "ToPrimitive residuals: object-method trampoline invalid Wasm + §7.1.1.1 step-6 TypeError"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: to-primitive, abstract-operations
goal: spec-completeness
sprint: Backlog
related: [1525, 1602, 1669, 1130, 983, 1253]
test262_fail: 142
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
