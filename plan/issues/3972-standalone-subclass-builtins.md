---
id: 3972
title: "Standalone: `class Sub extends <builtin>` leaks one env::__new_<Parent> host import per parent (or is refused outright), failing the whole subclass-builtins family"
status: done
sprint: 78
created: 2026-08-01
completed: 2026-08-01
updated: 2026-08-18
assignee: ttraenkler/senior-dev-subclass-builtins
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: classes, inheritance, builtins
es_edition: multi
goal: standalone-mode
related: [2917, 3238, 3239, 2620, 2029, 2961, 2043]
origin: "2026-08-01: largest cluster in the untagged standalone bucket (baseline run 20260801-010858)."
---

# `class Sub extends <builtin>` does not construct host-free in standalone

## Problem

On the standalone lane, `class Sub extends <builtin>` failed for 13 builtin
parents, in two shapes:

- **Host-import leak (7 parents)** — `ArrayBuffer`, `DataView`, `Date`,
  `Function`, `Promise`, `RegExp`, `WeakRef`. `super()` / the implicit derived
  constructor lowers parent creation through the host-constructible path (these
  names are in `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`), which registers a late
  `__new_<Parent>` **import**. Standalone has no JS host to satisfy it, so the
  module leaked exactly one `env::__new_<Parent>` — and the #2961 guard
  correctly refuses any standalone binary carrying host imports. That single
  leaked import was the **sole** reason these rows failed.
- **Explicit compile-time refusal (6 parents)** — `Map`, `Set`, `WeakMap`,
  `WeakSet` (#2620) and `Number`, `Boolean` (#2029). For these the host path
  additionally produced invalid Wasm, so the compiler refused loudly instead.

## Population and denominators

From the standalone baseline run `20260801-010858`, untagged bucket. The
dispatched cluster was 30 files; **28 share this root cause**, 2 do not:

| Group | Rows | Note |
| --- | --- | --- |
| `subclass-builtins` (13 parents x expression/statement form) | 26 | the family this issue is about |
| `built-ins/Symbol/species/subclassing.js` | 1 | leaks the same `__new_RegExp` |
| `built-ins/TypedArrayConstructors/ctors/no-species.js` | 1 | leaks the same `__new_ArrayBuffer` |
| **target population** | **28** | |
| `built-ins/Promise/try/promise.js` | 1 | **different cause**: `__get_builtin` dynamic-shape op |
| `built-ins/Promise/any/species-get-error.js` | 1 | **different cause**: `Promise_any` + `__js_array_new`/`__js_array_push` |

The last two are reported separately and are **not** addressed here.

## Root cause

Not a missing substrate. Every one of the 13 parents already has a native
standalone carrier, and the conformance rows only ever ask for **identity**:

```js
class Subclass extends Map {}
const sub = new Subclass();
assert(sub instanceof Subclass);
assert(sub instanceof Map);
```

`instanceof` on both sides is resolved at **compile time** by
`tryStaticInstanceOf`, which reads the recorded builtin parent out of
`ctx.classBuiltinParentMap` and walks the static `isBuiltinSubtype` hierarchy —
it never inspects the runtime value. So the only missing piece was a fresh
native value for `super()` to return instead of an imported one.

## Fix

New module `src/codegen/standalone-subclass-ctors.ts`, wired into the existing
ladder `resolveStandaloneBuiltinSuperCtorIdx` in `src/codegen/class-bodies.ts` —
the same ladder that already serves `Object` (#3238), `Array` (#2917) and
TypedArray/SharedArrayBuffer (#3239). Every arm registers a **defined** function,
never an import; that is the load-bearing property, because with no late import
there is also no `addUnionImports`/`flushLateImportShifts` reorder, so the #2043
index-shift class of invalid Wasm cannot arise from construction either.

Carriers are chosen per group rather than uniformly:

| Group | Carrier | Why |
| --- | --- | --- |
| ArrayBuffer, DataView, Date, Function, Promise, RegExp, WeakRef | fresh `__new_plain_object()` | identity-only. A plain object is chosen **over** a faithful-looking carrier on purpose: an incorrectly branded value (e.g. a `$__vec_i32_byte` for `ArrayBuffer`) would make brand-testing paths answer confidently wrong, whereas a plain object carries no false brand. |
| Map, Set, WeakMap, WeakSet | real `$Map` via `__map_new(kind)` | a genuine one costs 3 instructions, and `MAP_LAYOUT.M_KIND` is read by the spec receiver-brand checks and the value-representation dispatch. Correct branding is what lets an inherited `sub.add(1)` still resolve host-free. |
| Number, Boolean | real `$Object` wrapper box via `__new_Number`/`__new_Boolean` | the box already existed; #2029 was an **ABI mismatch** (f64 callee vs externref forwarder), which the new shim resolves by declaring externref params, ignoring them, and supplying the f64 itself. |

### Refusals: one narrowed, one retired

- **#2029 (Number/Boolean) is RETIRED.** Its cited cause was purely the ABI
  mismatch; the shim removes it at the root, so nothing is left to guard.
  `isPrimitiveWrapperSubclassUnsupported` / `PRIMITIVE_WRAPPER_SUBCLASS_UNSUPPORTED`
  are deleted.
- **#2620 (collections) is NARROWED, not deleted** — to property/accessor
  declarations only. Two measurements set that boundary:
  1. The feared *"lifting this leaks `env::Set_add`"* **does not happen**. A bare
     subclass plus `s.add(1)` compiles with **zero** imports and runs: the typed
     method path does gate on the receiver's static symbol name (so the
     `"Set"`-named arm misses for a subclass-typed receiver), but the
     fall-through reaches the value-representation dispatch, which brand-tests
     `$Map` and reads `M_KIND`. Declared methods and an explicit
     `constructor() { super(); }` also compile and return correct values.
  2. What **is** still broken is a declared **property or accessor**: those trap
     (`illegal cast`). That is **not** collection-specific — it is a pre-existing
     defect of the whole externref-backed subclass family that `main` already
     ships unguarded for the earlier rungs (`extends Array { tag = 3 }` and
     `extends Uint8Array { tag = 3 }` trap identically today; `extends Object`
     silently yields NaN).

  Keeping a clean CE for that one shape is deliberately asymmetric with the
  Array/TypedArray rungs, in the conservative direction. The terminal fix is to
  repair field storage across the family, at which point the guard should be
  deleted for all rungs at once.

## Scope — stated plainly

**Construction and identity, not faithful behaviour.** The instance is not a
functional `Map`/`Date`/`Promise`: no `[[DateValue]]`, no compiled pattern, no
executor is run, no `byteLength`. Constructor arguments are still
side-effect-evaluated at the call site (§13.3.7.1, pinned by a test) and then
**dropped**. This is exactly the #3239 scope.

That bound is set by measurement: of **25,692** passing standalone test262 rows,
**zero** contain `extends <one of the 13>` in their source — the regression
surface is empty. Faithful argument-honouring construction is follow-up work,
worth doing when a behaviour test for one of these parents can actually pass.

## Results

Paired per-file A/B, both arms in **one process** via a collection-time kill
switch, then re-measured with the **scaffold deleted** (both runs agree exactly).

| Metric | Value |
| --- | --- |
| Row floor (both arms) | 74 / 74 |
| `compile_error` → `pass` | **26 / 28** target population |
| Host-import census 1 → 0 | **16 / 16** of the leak-group rows |
| In-sweep control (46 known-passing `subclass-builtins` rows) | 46 / 46 unchanged |
| Regressions (`pass` → not `pass`) | **0** |

The 2 non-flipping target rows are the cluster-B singletons: both now compile
**host-free** (import census 1 → 0, real progress) but still fail, because they
depend on `Symbol.species` / TypedArray-from-buffer behaviour that the
identity-only scope deliberately does not provide.

**Measurement caveat.** `runTest262File` does **not** apply the #2961 refusal, so
a fix whose mechanism is "stop emitting a host import" reads as +0 locally. The
harness therefore replicates the worker's rule (`errors → compile_error`, else
`imports > 0 → compile_error`, else execute) and reports the import census
directly. The CI pass-count for the 16 leak-group rows is a **derivation** from
that rule, not an observation.

**Instrument validation.** The harness was validated against the CI baseline
*before* any code change, reproducing all 28 target rows with their exact error
strings and exact leaked import names, and all 46 control rows as passing. Its
first version was **broken** — `compile()` is async and was not awaited, so
`result.success` was `undefined` and every row scored a fictitious
`compile_error`, which is indistinguishable from "the feature is entirely
broken". It now throws on a malformed result rather than scoring it.

## Verification

- `tests/issue-3972-standalone-subclass-builtins.test.ts` — the 7 identity
  parents: zero `env::` imports, instantiate against an **empty** import object,
  correct `instanceof`; plus class-expression form, two arities of the same
  parent (the #2917 per-arity mis-call hazard), argument side-effect
  preservation, and gc/host non-regression.
- `tests/issue-2620-extends-set-standalone-refusal.test.ts` — rewritten to pin
  the new contract, including the narrowing's load-bearing premise (inherited
  `Set.add` stays host-free) and the surviving field/accessor refusal.
- `tests/issue-2029-primitive-wrapper-subclass-standalone.test.ts` — rewritten
  to assert host-free + instantiable + correct identity, which is strictly
  tighter than the refusal it replaces (the original defect was invalid Wasm, so
  it fails at the instantiate step).

Gates run locally: `typecheck`, `lint`, `format:check`, `check:loc-budget`
(green with **no** allowance — the new code went into its own module rather than
growing three god-files), `check:func-budget`, `check:oracle-ratchet`,
`check:pushraw`, `check:any-box-sites`, `check:coercion-sites`,
`check:speculative-rollback`, `check:stack-balance`, `check:codegen-fallbacks`,
`check:dead-exports`, `check:ir-fallbacks`, host-import allowlist, guard suite.

## Follow-ups

- Field/accessor storage for externref-backed builtin subclasses — family-wide
  defect (`extends Array { tag = 3 }` traps on `main` today). Fixing it retires
  the remaining #2620 guard.
- Teach the typed collection-method dispatch to resolve the receiver's builtin
  **ancestor** via `ctx.classBuiltinParentMap` rather than its leaf symbol name.
- Argument-honouring construction (`new Sub(5)` on a `Number` subclass, iterable
  initialisers for collections, real `Date`/`RegExp`/`ArrayBuffer` values) — when
  a behaviour test for one of these parents can pass standalone.
