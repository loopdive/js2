---
id: 4490
title: "standalone: builtin ctor own-property coherence — delete/gOPD disagree on synthetic meta arms; needs D7 ctor-value-as-real-$Object (one ctor per PR)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-25
loc-budget-allow:
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructFromLocals
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/call-receiver-method.ts::tryEmitTaStaticOfFrom
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
  - src/codegen/property-access-dispatch.ts::tryConstructorPrototypeIdentity
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen
es_edition: es6
goal: standalone-mode
related: [4444, 2175, 4449]
---

# #4490 — builtin ctor own-property coherence (v2 D7 carrier change)

## Problem (measured, team-reflection triage 2026-08-15 — see #2175 S3b-3 notes)

~32 ES6-bucket standalone tests: the 18
`built-ins/TypedArrayConstructors/<View>/{length,name}.js` files plus the 14
`%TypedArray%` ctor-object statics from #2175's S3b-1 residual.

**The descriptors are already spec-correct** (`{value, writable:false,
enumerable:false, configurable:true}`). The failures come from
`verifyProperty` proving configurability by DELETE-then-recheck:
`delete C.length` answers true and `"length" in C` answers false, but
`gOPD(C, "length")` STILL returns a descriptor — because a builtin ctor's own
properties are served by **synthetic meta arms** (`__builtinfn_get_meta` +
`ta-ctor-meta.ts`, `builtin-static-gopd.ts`) that have no notion of deletion.
No table population can fix this while those arms answer independently of
mutation state.

## Direction

This is #2175 v2's **D7**: back the ctor VALUE with a real `$Object` (seeded
with the §17 own props) so reads, `in`, `delete`, and gOPD all consult ONE
mutable carrier, and retire the synthetic arms for that ctor. v2's own
constraint applies: **one ctor name per PR, each with its own regression
sweep** — this is a carrier-representation change with wide blast radius.

Suggested order: `Int8Array` first (largest test coverage via the 9 views ×
{length,name} — verify whether one `$__ta_ctor` carrier serves all views or
per-view carriers are needed), then `%TypedArray%` itself (the 14 statics).

Out of scope here (bounded point fixes, #2175 lane): the `$__ta_ctor`
property-access `.length`-answers-0 defect (~9 files) and the #4120 typeof
arm gap (`typeof Int8Array !== "function"`) — those don't need D7.

## Acceptance

Per-ctor PR: the delete/gOPD/`in` triple stays coherent through mutation;
the affected `{length,name}.js` files flip; zero regressions on the
TypedArray scoped suites + emit-identity where the static path is untouched.

## Wave 2 — Int8Array slice (PR pending)

The first D7 carrier slice is intentionally limited to `Int8Array`; this
umbrella issue remains open for the other concrete constructors and the
`%TypedArray%` intrinsic.

### Before-state (upstream `main` @ `8a75a22c`)

Through an `any`-typed helper, the Int8Array constructor value had split
reflection answers: `hasOwnProperty("length")` was true, `"length" in C` was
false, dynamic `C.length` read as the numeric fallback `0`, and
`delete C.length` reported true.  The element-access spelling returned `3`,
while descriptor probes disagreed with the mutation state.  The official
`Int8Array/length.js` and `name.js` rows both failed in the configurability
verification step.

### Implementation

- Add `Int8Array` to the standalone builtin-constructor identity set so its
  bare value is one lazy, mutable `$Object` carrier.
- Seed `length`, `name`, `prototype`, and the non-configurable
  `BYTES_PER_ELEMENT` own data property on that carrier.
- Route typed-view `.constructor`, dynamic-view `.constructor`, dynamic
  `BYTES_PER_ELEMENT`, and dynamic `new C(...)` through the same carrier
  identity; retire kind-0 `$__ta_ctor` metadata for Int8Array only.
- Recognize that carrier in the inherited `TypedArray.from/of`, dynamic
  call-without-`new`, and cross-realm intrinsic-prototype dispatch paths.
- Keep all other TypedArray constructors on their existing `$__ta_ctor` path.

### Test Results

Focused coherence test (`tests/issue-4490-int8array-carrier.test.ts`): **5/5
passed**.  TypeScript typecheck: **passed**.

Standalone test262 rows run through `runTest262File`:

- `built-ins/TypedArrayConstructors/Int8Array/{length,name,BYTES_PER_ELEMENT,constructor,is-a-constructor}.js`: **5/5 passed**.
- `built-ins/TypedArrayConstructors/ctors/no-args/returns-object.js`: **passed** (dynamic `new TA()` control across the constructor harness).
- `built-ins/TypedArrayConstructors/ctors/length-arg/new-instance-extensibility.js`: **passed**.
- `built-ins/TypedArrayConstructors/ctors/buffer-arg/proto-from-ctor-realm.js`: **passed**.

The merge-queue standalone regression guard originally identified 32
Int8Array-only regressions across inherited `from/of`, constructor calls
without `new`, and cross-realm prototype selection. The carrier-aware
dispatch repairs cover each cluster while leaving the legacy `$__ta_ctor`
arms unchanged.

### Remaining blockers / follow-up

The remaining concrete TypedArray constructors and `%TypedArray%` statics
still require their own carrier slices.  `Int8Array/prototype/{proto,BYTES_PER_ELEMENT}.js`
retain pre-existing prototype/native-proto gaps and are not part of this
own-property carrier change.  The issue stays `in-progress` until those
ctor-specific PRs land.
