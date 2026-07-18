---
id: 2728
title: "Object(Symbol()) should box to a Symbol-wrapper object (typeof → 'object')"
status: done
assignee: dev-builtins
completed: 2026-07-17
created: 2026-06-26
updated: 2026-07-17
priority: low
feasibility: medium
task_type: bugfix
area: codegen
goal: test262-conformance
sprint: current
depends_on: []
related: [1568, 3280, 3383]
# (#2728) The new `__new_Symbol` host handler belongs in runtime.ts alongside
# every other `__new_*`/`__box_*` host import. Kept self-contained (its own
# id→Symbol resolution) rather than reusing #3280's extern_class `__new_Symbol`
# arm, which boxes the raw i32 id as a Number — see #3383 for that cleanup.
loc-budget-allow:
  - src/runtime.ts
---
# #2728 — `Object(Symbol())` → Symbol-wrapper object

Split out of **#1846** (descoped). This is the single remaining failing
assertion in `test/language/expressions/typeof/symbol.js`; the bare
`typeof Symbol()` cases already pass.

## Problem

§7.1.18 ToObject (Table 13): `Object(sym)` for a symbol primitive must return a
**Symbol-wrapper object**, whose `typeof` is `"object"`.

Verified on current main:

```ts
export function test(): string { return typeof Object(Symbol()); }   // → "symbol" (want "object")
```

`tryObjectCoercionCall` (`src/codegen/expressions/calls-guards.ts`) boxes
`Object(x)` for Number / String / Boolean / BigInt, but has **no Symbol branch**,
so a symbol argument falls through to the identity case (returns the raw symbol →
`typeof` `"symbol"`).

## Failing test262 (baseline 2026-06-26)

- `test/language/expressions/typeof/symbol.js` — asserts #3/#4
  `typeof Object(Symbol()) === "object"` / `typeof Object(Symbol("A")) === "object"`.

## Implementation sketch (medium)

1. Add a dedicated `__new_Symbol` host helper that boxes a symbol into a wrapper
   object via the spec's literal `Object(sym)` — **Symbol is not a constructor**,
   so the generic `__new_<Ctor>` path (`new Symbol(...)`) throws, exactly like
   `__new_BigInt` (#1568). It must reuse the per-instance symbol id→Symbol cache
   that `__box_symbol` uses (`src/runtime.ts`, `instanceState.symbolCache`), so
   the wrapped symbol preserves identity/description. The runtime already
   recognises Symbol-wrapper objects (`Symbol.prototype.description` unwraps
   them — `src/runtime.ts` ~L10115).
2. Add `else if (isSymbolType(argTsType))` to `tryObjectCoercionCall` mirroring
   the Number/String/Boolean branches: compile the arg to its i32 symbol id and
   call `__new_Symbol(i32) -> externref`.
3. Standalone fallback: identity (no JS host wrapper) — JS-host is the target.

## Risk / why split from #1846

The `Object(x)` call-lowering is a **busy, broad-coverage path** (it produced the
#2149 / #2702 merge_group regressions). Adding a new branch is lower-risk than
touching existing arms, but it must be validated against the full
`Object(...)` / typeof surface, not just symbol.js. Verify-first.

## Notes

Low movement (single test). Parked in Backlog. Links to the Symbol-wrapper
machinery (`__box_symbol`, `instanceState.symbolCache`, Symbol.prototype
description unwrap) in `src/runtime.ts`.
