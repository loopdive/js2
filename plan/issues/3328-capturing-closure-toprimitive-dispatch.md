---
id: 3328
title: "standalone: `+=` on a captured string inside a closure compiles to f64.add + a trapping null placeholder (kills every capturing toString/valueOf — coercion-order.js class)"
status: done
assignee: ttraenkler/sendev-date-3174
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: hard
model: fable
task_type: bug
area: codegen
es_edition: multi
language_feature: closures
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [3306, 3174, 795, 2120, 2873]
origin: "root-caused during #3306 (toString-only ToNumber); initially presumed to be the #2873 funcref-RTT dispatch class — WAT tracing disproved that"
loc-budget-allow:
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/closures.ts
---

# #3328 — capturing-closure `+=` string trap (the coercion-order.js blocker)

## Problem

Under `--target standalone`, ANY object whose `toPrimitive` method captures
and `+=`-appends a function-scoped string traps `dereferencing a null
pointer` the first time the method runs:

```ts
export function test() {
  var log = "";
  var year = { toString: function () { log += "y"; return 5; } };
  return +year; // RuntimeError: dereferencing a null pointer (inside __closure_0)
}
```

This is the exact shape of the test262 side-effect-ordering suites —
`Date/coercion-order.js`, `Date/UTC/coercion-order.js`, every
`set*/arg-coercion-order.js`, and sibling coercion-order rows across
builtins (`{toString(){ log += 'x'; return v; }}`) — so the whole class
hard-trapped standalone. Module-scoped `log` worked (globals, no ref cell).

## Root cause (WAT-verified — NOT the presumed #2873 funcref-RTT class)

The trap is **inside the closure body**, not in the ToPrimitive dispatch
guard (the funcref sig-test passes; stack trace pins `__closure_0`).

`log` is a mutable capture → boxed into a ref cell
(`struct { value: (mut ref null $AnyString) }`). The boxed-capture compound
assignment arm (`operator-assignment.ts`) has a string-concat gate from
#795 that tests **`boxed.valType.kind === "externref"`** — the HOST-mode
string representation. Under nativeStrings the captured string's cell
valType is `ref/ref_null $AnyString` — the gate never fires and `+=` falls
to the f64 arithmetic arm:

1. `coerceType(cellValue: ref $AnyString → f64)` — StringToNumber,
2. `f64.add`,
3. writeback `coerceType(f64 → ref $AnyString)` — **no such arm exists**,
   emitting `drop; ref.null; ref.as_non_null` — an always-trapping
   placeholder.

## Fix

1. **`operator-assignment.ts`** — native-strings analog of the #795 arm in
   the boxed-capture compound path: same string-detection heuristics
   (rhs/lhs static string, `hasStringAssignment`), RHS via the existing
   `compileAndCoerceToAnyStr` (numbers/booleans included), `__str_concat`,
   flatten when the cell is a concrete `$NativeString`, null-guarded
   `struct.set` writeback — mirroring the unboxed
   `compileNativeStringCompoundAssignment` discipline. Numeric captured
   compounds (`count += 1`, #2120) are untouched.
2. **`closures.ts` / `registry/types.ts`** (defence-in-depth, same bug
   class one level deeper): the three `alreadyBoxed` capture-materialization
   sites defaulted a missing outer `boxedCaptures` entry to
   `valType: f64` — silently retyping captured strings as numbers. New
   `refCellValueType(ctx, refCellTypeIdx)` reads the cell's field-0 type
   (the authoritative value type) as the fallback before f64.

## Measured

- All capture shapes fixed: valueOf/toString numeric, string-hint, template
  literal, loose-eq, nested captures, 2/3/7-arg Date ctor coercion-order.
- `built-ins/Date`: +2 (`coercion-order.js`, `UTC/coercion-order.js`), zero
  regressions (the one diff row, `toJSON/called-as-function.js`, fails
  identically on current main — pre-existing drift).
- `language/expressions/compound-assignment` (454): byte-identical vs main.

## Notes

- The `value-to-primitive-*` Date ctor rows remain (different gaps:
  @@toPrimitive-on-arg, runtime string-result → `__date_parse` dispatch —
  documented in #3306's follow-ups).
- The #2873 funcref-RTT dispatch theory was WRONG for this class — recorded
  here so the next agent doesn't chase it again for coercion-order rows.
