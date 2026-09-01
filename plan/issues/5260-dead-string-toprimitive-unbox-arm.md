---
id: 5260
slug: dead-string-toprimitive-unbox-arm
status: ready
sprint: Backlog
priority: low
horizon: s
goal: ir-full-coverage
feasibility: medium
created: 2026-09-01
requested_by: ttraenkler/opus
related: [3526, 3522, 4208, 3168]
files:
  - src/ir/from-ast.ts
  - src/ir/select.ts
---

# `emitUnaryToNumber`'s string OrdinaryToPrimitive arm is dead code

## Problem

`src/ir/from-ast.ts` `emitUnaryToNumber` has an arm for a closed
OrdinaryToPrimitive object literal whose preferred method returns a **string**:

```ts
if (primitiveType.kind === "string") {
  const number = cx.builder.emitCall(
    irRuntimeFuncRef("__unbox_number"),
    [cx.builder.emitCoerceToExternref(primitive)],
    irVal({ kind: "f64" }),
  );
  …
}
```

**Its guard cannot be satisfied.** Two independent gates agree that a closed
structural literal never carries a string-returning method:

- the selector (`src/ir/select.ts`, `hasPreparedParityReturn`) admits a
  `string` return **only** when the method is a `ts.FunctionExpression`;
- the lowering (`lowerOrdinaryToPrimitiveObjectLiteral`, same predicate)
  applies the identical rule, and then routes any literal containing a function
  expression to the **open `extern:Object` protocol** — which reaches the
  *other* arm (the `__to_primitive` + `__unbox_number` pair) instead.

So the only two shapes that can produce an IR `object` type with `valueOf` /
`toString` closure fields are shorthand-method literals returning `number` or
`boolean`, and neither takes the string sub-arm: the `f64` case returns the
primitive directly and the `i32` case converts it.

## Evidence (measured 2026-09-01, during #3526 F1-S4 verification V-A/V-D)

With a temporary stderr trace at the arm:

- `pnpm run check:ir-fallbacks` (the fixed `playground/examples` corpus) fires
  it **zero** times;
- the `tests/equivalence/`-adjacent and linear/stdlib/selfhost/cutover suites
  fire it **zero** times;
- five hand-built candidate shapes were compiled across gc-host,
  gc-native-strings, standalone, WASI and linear:

| shape | result |
| --- | --- |
| `{ valueOf(): string { … } }` (shorthand) | demotes at IR **selection**, `body-shape-rejected` |
| `{ valueOf: function (): string { … } }` | IR-claims, but lowers to `extern:Object` → the **open** arm |
| `{ valueOf: () => "7" }` (arrow) | demotes at selection |
| `function f(o: { valueOf: () => string })` | `type-resolution-unsupported` |
| `const o: S = { valueOf: () => "7" }` | demotes at selection |

The companion arm — the `extern:Object` / `__to_primitive` one — IS reachable
and is exercised by the second shape above.

## Why it matters

This is not merely unused code. It was the reason #3526 F1-S4's sub-A parity
cell for that site would have been **vacuous**: a byte-comparison of a migrated
arm nothing reaches proves nothing. Any future slice that migrates the
ToPrimitive unbox seam (see [#5261]) needs to know which of the two arms
carries real traffic before it can claim neutrality.

## Decision required

Two honest options, and the choice is a semantics call rather than a cleanup:

1. **Delete the arm.** It is unreachable, and its presence implies a
   capability the closed route does not have.
2. **Close the gap in the closed route** — admit string-returning shorthand
   methods, which would make the arm live. The selector comment says
   string-returning shorthand "remains direct until a native
   string-to-number IR intrinsic avoids the larger generic boxed conversion",
   so this is a deliberate deferral, not an oversight.

Either way, record the decision at both gates (`select.ts` and
`from-ast.ts`), since today they encode it in two places without naming it.

## Acceptance criteria

- The arm is either removed, or reachable with a fixture that proves it.
- `check:ir-fallbacks` census output-identical (this shape is not in the
  corpus, so a real change here must not move it).
- If the arm is deleted: byte parity on the two shapes that DO reach
  `emitUnaryToNumber` (the `extern:Object` route and the numeric shorthand
  route), on all five lanes.
- The deferral rationale is stated once, in one place, and cited from the
  other.

## Out of scope

`__to_primitive` itself, the `extern:Object` arm's own `__unbox_number` call
(that is [#5261]), and `lower.ts:1440`'s defensive `coerceToF64ForBitwise`
unbox (#1305).
