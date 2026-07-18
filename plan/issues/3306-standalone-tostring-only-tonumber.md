---
id: 3306
title: "standalone: ToNumber of a toString-only object drops the native-string result to NaN (§7.1.1.1 OrdinaryToPrimitive → §7.1.4.1 StringToNumber)"
status: done
assignee: ttraenkler/sendev-date-3174
created: 2026-07-16
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: medium
model: fable
task_type: bug
area: codegen
es_edition: multi
language_feature: coercion
goal: standalone
umbrella: 2860
sprint: current
horizon: s
related: [3174, 3304, 2891, 866, 1806]
origin: "root-caused during #3174 residual analysis (Date ctor coercion-order rows); carried through #3304 as the next-next candidate"
loc-budget-allow:
  - src/codegen/type-coercion.ts
coercion-sites-allow:
  # __str_to_number +2 — NOT a fresh hand-rolled matrix: routes the toString
  # closure result through the EXISTING StringToNumber scanner (the same
  # helper the direct string→f64 arm uses), replacing a spec-violating
  # drop+NaN.
  - src/codegen/type-coercion.ts
---

# #3306 — standalone: toString-only object ToNumber → NaN

## Problem

Under `--target standalone` (nativeStrings), ToNumber of an object whose only
ToPrimitive method is `toString` runs the method but throws away its string
result:

```ts
var arg = { toString: function() { return "7"; } };
+arg;                      // NaN (should be 7)
Number(arg);               // NaN (should be 7)
new Date(0).setTime(arg);  // NaN (should be 7-ish ms)
```

`{ valueOf }` and `{ valueOf-returns-object + toString }` (#2891's
fallthrough) both work — only the **no-valueOf** shape fails.

## Root cause (WAT-verified 2026-07-16)

`tryToStringFallback` (type-coercion.ts, #866) DOES find and `call_ref` the
`toString` closure — but every one of its three result-conversion sites treats
a `ref`/`ref_null`-kind return as "object → drop + NaN":

- the eqref-field inline converter (the arm object literals actually hit —
  emitted `call_ref 44; drop; f64.const NaN`),
- `emitToStringResultToF64` (closure-ref field arm),
- `emitToStringResultToF64ByKind` (`${name}_toString` funcMap arm).

Under nativeStrings a `toString(){ return "7" }` closure returns a **native
string struct** (`ref $NativeString` / `ref $AnyString` subtype) — a ref kind.
Per §7.1.1.1 OrdinaryToPrimitive + §7.1.4 ToNumber, a String primitive result
must convert via StringToNumber (§7.1.4.1) — the `__str_to_number` scanner the
direct string→f64 arm (type-coercion.ts ~2277) already uses.

The externref arm (host-string returns) already unboxes correctly; only the
ref-kind (native-string) returns were dropped.

## Fix

One shared `refResultStringToF64Instrs` helper: runtime `ref.test $AnyString`
on the ref-kind result → hit: `extern.convert_any` + `__str_to_number`; miss
(genuine object return): keep the existing NaN. Wired into all three
converter sites. Runtime-tested (not static-typeIdx-matched) so loosely-typed
closure returns (eqref/anyref) convert too.

## Out of scope (follow-ups)

- `any`-typed receiver (`var arg: any = { toString... }; +arg`) traps
  `illegal cast` — a different path (`__to_primitive`'s $Object toString
  dispatch / funcref RTT class, cf. #2873). Not touched here.
- Spec-exact TypeError when BOTH valueOf/toString return non-primitives
  (currently NaN on the toString-only path) — pre-existing, unchanged.

## Acceptance criteria

- `+{toString(){return "7"}}` === 7; `Number(...)` and Date setter args
  likewise, host-free standalone.
- `{valueOf}` / fallthrough shapes byte-equivalent (no regression).
- Zero host-mode changes; zero standalone high-water regressions.
