---
id: 6652
title: "standalone: the spread-literal return-carrier mismatch survives in every callable shape that is not a top-level function declaration"
status: in-progress
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/sendev-s71
created: 2026-09-20
---

# The five residual shapes of #6650

[#6650](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6650-standalone-spread-literal-return-null)
fixed the return-carrier mismatch — a spread-built object literal is an open
host `$Object` **externref**, while the enclosing function's Wasm result ABI is
the checker-inferred **concrete struct**, so the emitted return is a guarded
downcast (`ref.test` → `ref.cast` / `ref.null none`) that takes the null arm on
every evaluation — for **top-level function declarations only**.

Measured on the S70 base (`78dd538964`) with `.tmp/s71/probes/solo3.mts`, the
same mismatch remains for five other callable shapes:

| shape | base result |
| --- | --- |
| arrow function — `const m1 = () => { …; return { ...o, days: 9 }; }` | `NaN` |
| function expression — `const P1 = function () {…}` | `NaN` |
| object-literal method — `{ mk() {…} }` | TRAP `illegal cast` |
| class method — `class Q1 { mk() {…} }` | TRAP `dereferencing a null pointer` |
| nested function declaration | TRAP `dereferencing a null pointer` |

The minified `@js-temporal/polyfill` uses all five shapes, so the defect is
expected to hold down Temporal rows outside the add/subtract family S70
measured.

## Root cause — the pre-pass that already covers all six shapes is narrowed to accessors

`wasm-dis` of the arrow shape (`.tmp/s71/probes/wat-arrow.wat`) shows the
identical two halves as #6650: the lifted `$__closure_0` builds the literal with
`__new_plain_object` + `__extern_set` (externref), its funcref type
`$28 (func (param (ref null $12)) (result (ref null $20)))` pins the concrete
struct, and the body ends in

```wat
(return (if (result (ref null $20)) (ref.test (ref $20) …)
  (then (ref.cast (ref null $20) …)) (else (ref.null none))))
```

The compiler already has a **pre-pass** that closes this for every callable
shape: `collectAccessorLiteralReturnCarrierTypes`
(`src/codegen/accessor-literal-return-carrier.ts`, #6614). It runs before
`collectDeclarations`, walks every function-like, and puts the return type into
`ctx.objectHashConsumerTypes`, which `resolveWasmType` answers `externref` for
wherever that type lands (result ABI, local slot, struct field, call-site
binding). Its own doc table lists exactly the six spellings and says the
FunctionDeclaration lane is the only one `declarations.ts` covers.

It was deliberately narrowed to **accessor-bearing** literals ("the other
`objectLiteralForcesHostPath` reasons … are a separate, separately-measured
change"). The SPREAD reason (`objectLiteralSpreadTakesHostPath`, #2804 —
context-driven, not shape-driven) was never added. That is the whole defect: the
predicate, not the plumbing, is missing.

Its `unwrapCarrier` also lacked the **comma-expression** peel that #6650 had to
add to `unwrapReturnCarrierExpression` — and that peel is what actually moved
the polyfill's rows (part 1 alone produced a byte-identical binary), because the
minified `Wr()` returns `zr(…), { ...t.date, days: n }`.

## Fix

1. `src/codegen/declarations/host-carrier-object-literal.ts` — `unwrapReturnCarrierExpression`
   moves here from `declarations.ts` and is exported, so the declaration lane
   and the pre-pass peel the identical set of wrappers (parens / `as` / `!` /
   `satisfies` / comma) by construction rather than by two copies agreeing.
2. `src/codegen/accessor-literal-return-carrier.ts` — the return-carrier
   predicate becomes "accessor literal **or** `objectLiteralSpreadTakesHostPath`",
   and the carrier walk uses the shared unwrapper.

`objectLiteralForcesHostPath`'s other arms are deliberately still NOT consulted
here: several of them read `ctx` state (`_hasRuntimeComputedKey`,
`_hasRealmGlobalObjectValue`) that a pre-pass running before
`collectDeclarations` has not populated. `objectLiteralSpreadTakesHostPath` is
pure — it reads only `ctx.checker.getContextualType` — which is what makes it
safe at this point in the pipeline.

## Measurement

(filled in below)
