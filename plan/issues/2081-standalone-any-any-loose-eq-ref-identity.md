---
id: 2081
title: "standalone: loose == between two any operands compares references, never coerces ('1' == 1 → false)"
status: done
sprint: 62
created: 2026-06-11
updated: 2026-06-14
completed: 2026-06-14
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: equality
goal: host-independence
related: [2073, 1986]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2081 — any/any == lowers to ref identity in standalone mode

## Problem

```ts
const a: any = "1"; const b: any = 1;
String(a == b)   // standalone: "false"   node: "true"
const c: any = []; c == 0   // standalone: false   node: true
```

## Root cause

`src/codegen/binary-ops.ts:1750+` — any/any equality lowers to ref
identity standalone instead of §7.2.13 IsLooselyEqual. The `[] == 0` half
may be absorbed by #1900 (in-review, native ToPrimitive) — recheck after
PR 1251 lands; the boxed primitive-vs-primitive half is NOT claimed by it.

## Fix direction

Native IsLooselyEqual over `$AnyValue` tags (shares the lowering #2073
needs for mixed static types — implement together).

## Acceptance criteria

- Both repros match Node standalone (the array case may ride #1900)
- Reference identity preserved for object==object

## Dupe check

#1986/#1987 (strict ===, host), #1990 (host loose eq), #1900/#1910
(object ToPrimitive). Partially new — the primitive/primitive half. Filed.

## Resolution (2026-06-14, sdev) — CORRECTED root cause + fix

The architect spec (in the sprint-branch copy) routed the fix to extending
`__any_eq`'s §7.2.15 coverage. **That was wrong for the live repro**: WAT-tracing
`const a: any = "1"; const b: any = 1; a == b` under `--target wasi` showed it
NEVER reaches `__any_eq` — `ctx.anyValueTypeIdx` stays `-1` (the module never
boxes an `any` into `$AnyValue`), so the `compileAnyBinaryDispatch → __any_eq`
gate (`binary-ops.ts:950`, `>= 0`) is skipped entirely. The `==` instead lowers
through the **#1776 no-JS-host native equality cascade** (`binary-ops.ts:~1936`,
gated `noJsHost && one-externref`): it handled number/number, bool/bool,
bigint/bigint, then fell to **eqref `ref.eq` identity** — never the §7.2.15
cross-type coercion. So `"1" == 1` compared two distinct externrefs by identity →
`false`. (The original issue title — "compares references, never coerces" — was
right; the spec's "already routes to __any_eq" correction was not.)

### Fix — `src/codegen/binary-ops.ts` (#1776 native equality cascade)
Added the missing §7.2.15 LOOSE arms (gated `!isStrict && (== | !=)` so strict
`===` is unchanged — `"1" === 1` stays `false` by type):
- **null/undefined (steps 2-3):** wrap the cascade in a both-nullish guard —
  both `ref.is_null` ⇒ `true`; nullish-vs-non-nullish ⇒ `false` (never coerce —
  `null == 0` stays false). (Under this rep null and undefined are both
  `ref.null extern`, so one guard covers all three nullish pairings.)
- **Number/Boolean (step 8):** broaden the numeric arm for loose eq to
  number-OR-boolean, ToNumber each (`__unbox_boolean`+`f64.convert` for bool,
  `__unbox_number` for number), `f64.eq` — so `true == 1`, `false == 0`.
- **String⇄Number (steps 4-7):** when exactly one side is a native string ref
  and the other is `typeof number`, ToNumber both — string via the §7.1.4.1
  `__str_to_number` scanner (NaN unparseable, 0 empty, hex/inf; NOT `parseFloat`),
  number via `__unbox_number` — `f64.eq`. Falls back to the existing
  string==string `__str_equals` / eqref-identity arm otherwise.

Also (defensive, for any module that DOES box to `$AnyValue`):
- `src/codegen/any-helpers.ts` — added the String⇄Number arm to `__any_eq`
  (the spec's intended change; correct but not the live path for this repro).
- `src/codegen/binary-ops.ts` — the externref loose-eq host fallback now routes
  through native `__any_eq(__any_from_extern(a), __any_from_extern(b))` in
  standalone instead of leaking the unsatisfiable `__host_loose_eq` import.

DEFERRED (out of scope, unchanged): object⇄primitive ToPrimitive (`[] == 0`)
rides #1900; BigInt⇄String exact compare; the strict `null === undefined`
representation collapse (separate — needs distinct undefined sentinel).

### Verification
- New `tests/issue-2081.test.ts` (11 cases, standalone): `"1"==1`/reversed,
  `""==0`, `"abc"==0` (false), hex, `!=`, `true==1`/`false==0`/`true==2`(false),
  `null==undefined`(true)/`null==0`(false), object identity (same==true,
  distinct==false), strict `===` no-coerce, number/number. All pass; valid
  module, zero host imports.
- Equality regression suites green (82 tests across issue-1776/1986/1990/2063 +
  equivalence equality/comparison/typeof/struct-null/boolean-relational).
- Full `tests/equivalence/` sweep: identical failing-set vs origin/main
  (verified by swapping the original binary-ops.ts/any-helpers.ts back in).
