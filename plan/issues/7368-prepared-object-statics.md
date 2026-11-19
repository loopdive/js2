---
id: 7368
title: "Prepared path: Object.defineProperty / defineProperties / getOwnPropertyDescriptor through the Object statics table"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: [7364]
related: [7354, 7338, 7339, 7350]
---

# #7368 — Object statics on the Prepared path

## Problem

The Prepared whole-program path (`wholeProgram: { kind: "prepared-program-required" }`) has no selector, and it had
no `Object` statics: an `Object.defineProperty` refused by name (#7364) or, before #7364, crashed the compile. In the
ES5 census of 2026-11-19 (main `ee3fcdd610`, stand-in harness) 26 files stopped at exactly that refusal
(`crash-object-static-not-admitted.tsv`). The statics are wider than that list: 1,760 positive ES5 files call
`Object.defineProperty`, 638 `getOwnPropertyDescriptor` and 622 `defineProperties` (counts from a grep of the files,
2026-11-19), and `propertyHelper.js` (905 ES5 includers) calls them through stored aliases.

The ordinary pipeline already lowers these statics through one table (`src/ir/object-statics.ts`,
`objectStaticCallPlan`) and one emitter (`emitObjectStaticCall` in `src/ir/open-object-carrier.ts`) over legacy's
helpers (`__obj_define_from_desc`, `__getOwnPropertyDescriptor`, `dyn.own_property`). None of those helpers exists on
the Prepared path, whose objects live in the native realm and are reached only through the `js.object.*` contracts.

## Implementation Plan

Approved by the lead (2026-11-19).

**Admission: one table.** `objectStaticCallPlan` stays the only admission. The Prepared lane answers what the table
asks of a lane through a Prepared builtin resolver, `prepareObjectStaticsResolver`
(`src/frontend/builtins/prepare-object-statics.ts`). It is wired like `prepareObjectCreateResolver` in
`prepareSourceBuiltinResolvers`, which moves out of `src/ir/program-source.ts` into
`src/frontend/builtins/prepare-source-builtins.ts` beside the resolvers it combines. from-ast reads the Prepared plan
where the resolver has one (`objectStaticPlanOf`), else the selector's, and lowers either through one function.

**Lowering: one emitter.** The call-site lowering moves out of from-ast into `src/ir/object-static-lowering.ts`
(`lowerObjectStaticCall`, `lowerDescriptorDefinition`, `refuseObjectStatic`) behind a small host. That removes from
from-ast its own copy of the operand loop and the two invariant arms. `emitObjectStaticCall` and `emitOwnPropertyTest`
keep their one order of steps (the TypeError tests, the helper, each definition). What differs per lane is an
`ObjectStaticRuntime` parameter: a fresh `{}`, the row's helper, applying one definition, and the own-property test.

- Ordinary pipeline: `OPEN_CARRIER_RUNTIME`, which is legacy's helpers exactly as before, so the bytes are identical.
- Prepared path: `ORDINARY_OBJECT_RUNTIME` (`src/ir/ordinary-object-statics.ts`).
  - A define passes the literal's mask (the presence of each field and ToBoolean of each attribute, as the
    contracts' descriptor word) to `js.object.define-data`, `define-accessor` or `define-attributes`, chosen by the
    descriptor's kind (§20.1.2.4 step 4).
  - No descriptor object is built, and there is no second define lowering.

**Runtime: three new contracts.** Each is one row in `src/ir/runtime/ordinary-object-callables.ts` and the manifest,
plus one adapter row in `src/backend/wasmgc/resources/native-source-objects.ts`, with its body in
`src/runtime/wasmgc/values/source-object-bodies.ts`.

- `js.object.has-own` and `js.object.property-is-enumerable` are the object runtime's own kernels
  (`buildOwnPropertyBody`, `buildPropertyIsEnumerableBody` in `own-property-bodies.ts`) with the carrier's non-object
  arm. `buildPropertyIsEnumerableBody` takes that arm as an optional binding; its default is the old arm, so legacy's
  bytes are unchanged.
- `js.object.get-own-property` is FromPropertyDescriptor (§6.2.5.4) over the storage pack's own-entry lookup. It builds
  its descriptor with `js.object.create-default` and the descriptor pack's public `define-data`.
- `getOwnPropertyNames` and a non-null `Object.create` refuse by name: they need an array result or a prototype that
  no contract serves yet.

**Refusals.** The arms that assumed a selector's claim ("refused … after selection admitted it", "own-property test …
planned by neither …") go through `refuseUnselected` (#7364): an invariant after a selector's claim, a named refusal on
the Prepared path.

**Not in this issue.** §20.1.2.4 step 1's Object test (`emitThrowTypeErrorUnlessObject`) needs the Prepared
`tag.test` of the Object kind, and the own-property tests' nullish TypeError needs `js.object.create-type-error`. Both
are #7354 O4 (lane S3). Until O4 lands, a define on a target that is not an inline `{}` refuses by that name
(`tag.test of tag 6 has no Prepared intrinsic`). A read of a descriptor's field needs the Prepared dynamic member read.

**Code-quality acceptance criteria.**

- One admission (`objectStaticCallPlan`), one emitter (`emitObjectStaticCall`), and one call-site lowering
  (`lowerObjectStaticCall`) for both pipelines.
- No define, own-property or descriptor algorithm is written twice: the adapters call the realm's existing kernels.
- `src/ir/from-ast.ts` does not grow.
- No function-budget grant: `prepareIrProgramSources` is split (`prepareSourceModuleGlobals`) instead.
- Ordinary-pipeline bytes are identical, head against base.

## Verified: the descriptor pack's defines are ValidateAndApplyPropertyDescriptor

Read on 2026-11-19 in `src/runtime/wasmgc/values/ordinary-object-descriptor-{data,accessor,definitions}.ts`.

- The public defines (`buildOrdinaryDefine{Data,Accessor,Attributes}Definition`) first test that the target is an
  ordinary `$Object` and that the word has only the operation's bits (data 191, accessor 822, attributes 54). Either
  failure throws the pack's TypeError, so an accessor-and-value descriptor is rejected (§6.2.5.5 step 10). An accessor
  half must be callable or `undefined` (§6.2.5.5 steps 7 and 8).
- The data body's preflight is §10.1.6.3:
  - step 2: a new key on a non-extensible object throws;
  - step 4.a: `configurable: true` over a non-configurable property throws;
  - step 4.b: a different `enumerable` throws;
  - step 4.c: data to accessor, unless the descriptor is generic, throws;
  - step 4.d: on a non-writable data property, `writable: true` or a value that is not SameValue throws;
  - steps 5 to 10 merge in place and keep every unspecified attribute.
- The accessor body does the same for step 7: `configurable`, `enumerable`, data to accessor, and a changed `get` or
  `set`.
- Every rejection is `descriptorTypeError`: a TypeError object thrown with the realm's exception tag (parked first
  for `Reflect.defineProperty` where the rejection channel is configured). A non-configurable redefinition therefore
  throws the pack's TypeError. On the Prepared path that program still refuses at the Object test until #7354 O4.

## Result

See the PR-visible summary below; figures were measured on this branch on 2026-11-19.

RESULT_PLACEHOLDER
