---
id: 6958
title: "standalone: call-site parameter inference types a param as `$__fnctor_F` from one typed call site, but the body (or another allocation site) supplies a non-`F`-struct instance — the externref→struct coercion silently yields null (Octane earley-boyer `sc_display(o, p)`: `p = SC_DEFAULT_OUT` after a `new sc_StringOutputPort()` site)"
status: in-progress
sprint: current
created: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, type-inference
goal: standalone-gap
related: [874, 743, 3548, 4530, 2660, 4506, 6949]
# (2026-10-11) The withdrawal lives next to the other call-site soundness rules
# it composes with (#3548/#4530/#4630/#2867 S2); splitting ~120 lines of
# write-position scanning into a new module would need a new boundaries row for
# a single private consumer.
loc-budget-allow:
  - src/codegen/declarations/param-return-inference.ts
---

# Fnctor-struct parameter inference is unsound against the param's real runtime domain

Found by the Octane standalone triage (Session D, 2026-10-10). After the direct-eval refusal
(`.tmp/#6956`), `earley-boyer` throws
`TypeError: Cannot read properties of undefined (reading 'appendJSString')` from `sc_display`
(earley-boyer.js:2824-2828):

```js
function sc_display(o, p) { if (p === undefined) p = SC_DEFAULT_OUT; p.appendJSString(sc_toDisplayString(o)); }
```

Instrumented run (`.tmp/patch-eb2.mjs`): at the throw `p` is **null** (`typeof p === "object"`, not undefined),
`SC_DEFAULT_OUT` is an object. The benchmark calls `sc_display(result)` (:4650, one arg) and `sc_format` calls
`sc_display(arguments[j], p)` with `var p = new sc_StringOutputPort()` (:3029).

## Minimized — two shapes, same mechanism

**(a) body reassigns the param with another fnctor's instance** (`.tmp/eb22.js`, node `23`, standalone throws):

```js
function A() { this.a = 1; }  A.prototype.append = function (s) { return s.length; };
function B() { this.b = 2; }  B.prototype.append = function (s) { return s.length * 10; };
var OUT = new A();
function display(o, p) { if (p === undefined) p = OUT; return p.append(o); }
function fmt() { var p = new B(); return display("xy", p); }
export function main() { return fmt() + display("xyz"); }
```

**(b) the instance is the #2660 S3a `$Object` reconstruction** (`.tmp/eb18.js` node `4`, standalone throws;
`.tmp/eb21.js` = same with a non-empty ctor body → passes; `.tmp/eb19.js` = instance built inside `main` → passes):

```js
function Port() {}  Port.prototype.append = function (s) { return s.length; };
var OUT = new Port();                                   // top-level externref slot → S3a `__object_create(proto)` $Object
function viaParam(p) { return p.append("abcd"); }       // p inferred as (ref null $__fnctor_Port) from the call site
export function main() { return viaParam(OUT); }       // main: ref.test $__fnctor_Port fails → ref.null → "reading 'append'"
```

Wat of (b) (`.tmp/eb18.js.wat`): `viaParam (param (ref null 17))`; `main` does `global.get $OUT → any.convert_extern →
ref.test (ref 17) → (then ref.cast) (else ref.null 17)` — the miss is silent.

## Root cause

`inferParamTypeFromCallSites` (`src/codegen/declarations/param-return-inference.ts:518`) takes the TS type of the
argument at each call site (`resolveWasmType` → `$__fnctor_F` struct) and only widens for under-application
(#3548, nullable), opaque `any` non-identifier args (#4530), nullish args (#4491), catch bindings (#4630) and
native-proto args (#5151). Two facts it does not consult:

1. **Writes to the parameter inside the body.** A reassigned parameter's domain is whatever the body stores —
   here a different fnctor (`A` into a `$__fnctor_B` slot). The store compiles as externref→`(ref null $B)` with
   a `ref.test` that yields **null on miss** instead of trapping or widening.
2. **The allocation-site representation.** `newExpressionReconstructsAsObject` + `fnctorNewResultConsumedAsExternref`
   (`src/codegen/expressions/new-super.ts:2480-2745`, #2660 S3a / #4506 S1) lower an approved EMPTY-body `new F()`
   whose result lands in an externref slot (every top-level `var x = new F()`) as a native `$Object` — so the
   same `F` has two runtime representations, and the struct-typed param only accepts one.

## Implementation Plan (standalone; gc byte-identical where the arms are standalone-gated)

1. **`param-return-inference.ts` `inferParamTypeFromCallSites`** — add a withdrawal
   `sawParamWrittenInBody`: before the call-site walk, scan the function body for assignments (`=`, `op=`,
   `++/--`, destructuring targets, `arguments[i] = …` in sloppy mapped functions) whose target resolves to this
   parameter's symbol (`ctx.oracle.valueDeclarationOf(target) === param`). If the agreed type is a
   `ref`/`ref_null` to a user fnctor/class struct (`ctx.structMap` value), withdraw to `externref` (keep `f64`/`i32`
   agreements — they are value types; a numeric reassignment is already handled by `usageInference`). Reuse the
   existing `conflict = true` exit so the result is `inconclusive → externref`.
2. **Same function — allocation-site representation**: when the agreed struct is `$__fnctor_F`, withdraw if
   `newExpressionReconstructsAsObject(ctx, site)` is true for ANY `new F(…)` site in the file (the predicate
   already lives in `fnctor-instance-object-slot.ts` for the module-global slot typer, #4506 S1; iterate
   `gate.sites` for `siteCtorName === F`). Rationale: a fnctor with a `$Object` representation anywhere cannot be
   assumed struct-typed at any ABI edge.
3. **Defensive**: the externref→`(ref null $__fnctor_F)` coercion at an argument/param store must not silently
   produce null for a non-null source. Where `coerceType` emits `ref.test … else ref.null` for a fnctor struct
   target, emit a TypeError (or trap in debug) — measure first on `tests/equivalence/`; if it regresses rows, keep
   it behind the standalone lane only. This is the amplifier that turned both shapes into a confusing
   "reading 'x' of undefined".
4. Order: 1 (fixes earley-boyer + eb22) → 2 (eb18) → 3 (optional hardening). Steps 1-2 only change the inferred
   TYPE (externref); the method call then takes the dynamic `__call_m_*`/`__extern_method_call` route, which already
   resolves `A.prototype.append` for approved fnctors.

### Edge cases
- Param written with the SAME fnctor type (`p = p || new B()`): the withdrawal costs the struct fast path; acceptable
  (correctness first), note the perf regression risk for acorn/lodash lanes and re-measure `benchmarks/cross-engine`.
- `arguments`-mapped sloppy writes: treat as writes (conservative).
- Class instances (`class` structs): same rule applies to step 1; step 2 is fnctor-only.

### Acceptance
- `tests/issue-<id>.test.ts` standalone (and gc) vs node: `.tmp/eb22.js` → `23`; `.tmp/eb18.js` → `4`; `.tmp/eb8.js` → `1`;
  controls: `.tmp/eb19.js`, `.tmp/eb21.js`, `.tmp/eb9.js` (`1101`) unchanged; a struct-typed param with no body write keeps
  its `(ref null $…)` signature (hash fixture).
- earley-boyer: with the eval refusal in place, runs past `sc_display`. NOTE: the NEXT failure (if any) is not yet
  known — isolating patch `.tmp/patch-eb4.mjs` (non-empty ctor bodies) did not reach it because shape (a) is the
  one earley hits; the implementer should re-run `node --import tsx .tmp/octane-sa.mjs earley-boyer --script --no-eval`
  after step 1 (compile ≈20 s).
- Size: **M**.

## Ownership / overlap
`param-return-inference.ts` is shared-IR territory; #6949 (`fnctor-prototype.ts`) and #6950 (`declarations.ts`) do
not touch it. Related but distinct from #6949: there the prototype is missing; here the INSTANCE is lost at the ABI edge.

## Implementation notes (2026-10-11)

Steps 1 and 2 of the plan, in `inferParamTypeFromCallSites` (one new tail rule,
`userObjectStructDomainUnproven`). It applies only when the agreed type is a
`ref`/`ref_null` to a USER object struct (`__fnctor_*` or a `classSet` name);
strings, vecs and scalars are untouched. Withdrawal means `externref`, so the
method call takes the dynamic dispatch route.

- **Hole 1, body writes.** `paramWrittenInBody` scans every function declaration
  named `funcName` (nested closures included). A write is `=`/`op=`, `++`/`--`, a
  destructuring target, a `for-in/of` head, or a redeclaring `var p = …`, resolved
  with `ctx.oracle.valueDeclarationOf(id) === param`. Any `arguments[…]` write also
  counts (sloppy mapped arguments alias the params). Why every write and not just
  writes of a different type: the RHS's checker type is a hint, the same as the
  call-site argument's, so a same-typed RHS proves nothing about representation.
- **Hole 2, `$Object` representation.** Withdraw if any `new F()` site of the
  agreed fnctor satisfies `newExpressionReconstructsAsObject`, iterating
  `ctx.fnctorEscapeGate.siteCtorName`. That predicate is imported, not edited, and
  is standalone-only, so this arm is a no-op on gc.
- **Step 3 (coercion hardening) was not done.** It lives in `type-coercion.ts`,
  which is outside this slice's scope.

Validation: `tests/issue-6958-fnctor-param-inference-representation.test.ts` has
5 cases that fail on base and pass on head, plus 4 controls that pass on both.
One control checks that a param with no body write keeps its `(ref null $…)`
signature. The related-test set (257 tests) shows the same 9 pre-existing
failures on base and head. The equivalence gate shows no new regressions.

### Known gaps (not this slice)
- A JSDoc-annotated param (`@param {F} p`) never reaches this inference, so a body
  write to it is not covered.
- A `/** @type {F} */` cast at a call site is still trusted as the argument's
  representation.
- An under-applied struct param keeps `ref_null` (#3548). Inside the callee,
  `p === undefined` then folds to `false`, because a null ref is never undefined.
  Repro: `function P(){this.v=3} function g(o,p){return p===undefined?100:p.v}
  g(1,new P())+g(2)` — node returns `103`, standalone throws. This needs a fix in
  the equality lowering or in #3548's rule; neither is in this file's scope.
- The issue's own `eb22` repro (A non-empty body, `OUT` used only through the
  param) now gets past the null. It then throws `called value is not a function`,
  because `A` is not escape-gate approved and has no prototype object. That is
  #6949. A variant where `OUT` escapes (`keep(OUT)`) gives node's `23`, and that
  variant is the test case.
