---
id: 1688
title: "Symbol→string implicit coercion must throw TypeError (value-representation gap, split from #1637)"
status: wont-fix
created: 2026-05-27
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: types, symbols
goal: spec-completeness
sprint: 56
parent: 1637
related: 1319, 1342
closed_reason: "Symbol→string coercion was FIXED, not deferred. dev-1606 landed a static isSymbolType guard in src/codegen/string-ops.ts + src/codegen/expressions/calls.ts (branch issue-1637-boolean-symbol-coercion, commit 9aadfafc3) under #1637. No architect spec needed — the static type guard catches symbols at compile time, so the numeric-handle concern that motivated this split does not apply. Symbol fix tracked under #1637."
---
> **CLOSED 2026-05-27 (wont-fix — superseded by the real #1637 fix).**
> This issue was created on the premise that the Symbol→string half was
> *deferred* as a value-representation problem needing an architect spec.
> That premise was wrong: dev-1606 fixed it directly with a static
> `isSymbolType` guard in `src/codegen/string-ops.ts` +
> `src/codegen/expressions/calls.ts` (commit `9aadfafc3`, under #1637). The
> static guard catches symbols at compile time, so no representation change /
> architect spec is required. Kept for the historical record.

# #1658 — Symbol→string implicit coercion must throw TypeError

Split from #1637 (Boolean half landed in PR #659). This is the **Symbol→string
coercion half** (~45 test262 fails in `built-ins/Symbol`), deferred from #1637
because it is a Symbol **value-representation** issue, not a localized method fix.

## Problem

`"v" + sym` returns `"v101"` instead of throwing `TypeError`. Per spec
(§13.15 / §7.1.x ToString, §20.4.3.3 Symbol.prototype.toString), implicit
Symbol→string coercion must throw a `TypeError`; only explicit
`String(sym)` / `sym.toString()` are allowed.

## Root cause (verified on main HEAD by dev-1606, 2026-05-24)

Symbols are represented as **numeric (f64/i32) handles**, not externref-tagged
objects with a brand. So binary-`+` concat with a Symbol operand lowers through
`number_toString(handle)` and **never reaches `__concat_*`** — which already
throws on `typeof === "symbol"` (landed in #1342). Because the operand looks
numeric at the codegen type level, the throwing path is bypassed entirely.

This is why a localized fix in a method registry does not work: the value
representation hides the symbol-ness before the concat lowering decides which
path to take.

## Why this needs an architect spec

The fix touches how Symbol values flow through type coercion. Candidate
approaches (to be evaluated in the spec):
- Route non-statically-numeric (externref/any) operands of string-`+` through
  the throwing `__concat_*` path instead of `number_toString` — at
  `compileStringBinaryOp` in `src/codegen/string-ops.ts`. But Symbols currently
  present *as numeric handles*, so the codegen-time type may not distinguish a
  Symbol handle from a real number.
- Alternatively, change the Symbol value representation so symbol-ness is
  visible at coercion sites (larger, cross-cutting).

The architect should decide whether to make the Symbol handle distinguishable
at the `+`-lowering decision point, or to tag/brand symbols so coercion sites
can `ref.test` them, without regressing legitimate numeric concat
(`"v" + 5` → `"v5"` must still work).

## Files (real sites — note #1637's registry/symbol.ts path was stale)

- `src/codegen/string-ops.ts` — `compileStringBinaryOp` (the `+` lowering that
  routes to `number_toString` vs `__concat_*`)
- `src/runtime.ts` — `__concat_*` (already throws on `typeof === "symbol"`),
  Symbol value representation / handle allocation

## Acceptance criteria

1. `"v" + Symbol()` throws `TypeError` (implicit coercion).
2. Template literal `` `${sym}` `` throws `TypeError`.
3. `String(sym)` → `"Symbol(...)"` and `sym.toString()` → `"Symbol(...)"` still work (explicit OK).
4. Legitimate numeric concat unaffected: `"v" + 5` → `"v5"`.
5. `built-ins/Symbol` pass-rate rises toward the ≥75% target from #1637.

## History

PR #659 fixed the Boolean half of #1637 (Boolean.prototype.toString/valueOf.call
on primitives via thisBooleanValue coercion in `__extern_method_call`,
runtime.ts:4521). This issue carries the remaining Symbol→string half.
