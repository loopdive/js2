---
id: 1986
title: "strict === between any-typed and number-typed operands applies ToNumber coercion (null === 0 → true, '1' === 1 → true)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-13
completed: 2026-06-13
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: equality
goal: core-semantics
related: [1943, 1939]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1986 — mixed any/number strict equality lowers to f64.eq after ToNumber

## Problem

When exactly one operand of `===` is `any`-typed and the other is
number-typed, the `any` operand is unboxed via ToNumber and the comparison
lowers to `f64.eq` — i.e. `===` behaves *looser* than `==`:

```ts
const f: any = false; const s1: any = "1"; const nl: any = null;
String(f === 0) + "," + String(s1 === 1) + "," + String(nl === 0)
```

| expr | wasm | node |
|------|------|------|
| `false === 0` | true | false |
| `"1" === 1` | true | false |
| `null === 0` | true | false |
| `true === 1` | true | false |

`null === 0` → true is wronger than even loose equality. any/any pairs are
correct (they route through `__any_strict_eq`).

## Root cause

`src/codegen/binary-ops.ts:906-921` — the `__any_strict_eq` dispatch is
gated on `leftIsAny && rightIsAny`. Single-side-any falls through to the
numeric path (binary-ops.ts:1654 block), which unboxes via `__any_to_f64`
(null→0, false→0, "1"→1) and emits plain `f64.eq`
(`compileNumericBinaryOp`, binary-ops.ts:2385-2390).

## Fix direction

When either side is `any` and the operator is `===`/`!==`, box the typed
side and route through `__any_strict_eq` (spec §7.2.16 IsStrictlyEqual:
different types → false, no coercion).

## Acceptance criteria

- All four repros return false; `==` semantics unchanged
- any/any strict equality unchanged (no regression)

## Dupe check

#1943 covers switch-case strict equality only; #1939 is relational.
#1380/#1360/#136/#1134 are done. No open issue covers mixed-operand `===`.
