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
import-cycles-allow:
  - frontend->ir: 19 # 2026-11-19 (#7368): prepare-object-statics.ts asks the one Object statics table (ir/object-statics.ts) and its realm predicates (ir/module-bindings.ts); both move with the frontend inventory split
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

**The TypeErrors, over #7354 O4.** §20.1.2.4 step 1's Object test (`emitThrowTypeErrorUnlessObject`) lowers on the
Prepared path through O4's Object `tag.test` (lane S3, merged here). Two arms are added to the dynamic-value
legalization (`src/ir/program/dynamic-value-legalization.ts`) so that it lowers completely:

- the Function test is constant false, because no carrier kind is callable;
- `throw new TypeError(m)` from `throw-type-error.ts` builds the realm's TypeError through `js.object.create-type-error`,
  the contract O4 added.

In a program that binds a catch, a caught error would be read as a dynamic value, and no carrier kind holds an error
(O4's rule for a nullish member read). So two cases refuse by name there:

- an IR-level TypeError throw (`refuseUnadmittedThrows`, unchanged);
- a define or [[GetOwnProperty]] on anything but a fresh `create-default` object, because it may reject with the
  realm's own TypeError (`REALM_REJECTING`).

A unit that calls a planned static is legalized even when none of its bindings or signatures is dynamic
(`callsObjectStatic` in `source-dynamic-contracts.ts`). Before this, `var n = 5; Object.defineProperty(n, …)` reached
the program driver with an unlowered `__new_TypeError` and crashed.

**Not in this issue.** Reading the defined property back (`o.x`, `desc.writable`) is #7354 O4's member read. That read
refuses by name in a program that names `Object`, because a static could install a property it has not proved.

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

Measured on this branch on 2026-11-19. The branch merges lane S3's `origin/claude/7354-o` at `0c7109594b` and
`origin/claude/7354-crashes` at `f0a23832`. The base is `origin/main` at `89e47482`.

**Tests.** `tests/issue-7368-prepared-object-statics.test.ts` has 11 cases, all passing. Each runnable program goes through the
strict Prepared entry and is checked against node twice: with the right answer it returns, with a wrong one it throws.

- A data define on a fresh object; a descriptor map; FromPropertyDescriptor as an object, and `undefined` for a
  primitive's absent property.
- ToObject's TypeError for a `null` or `undefined` receiver.
- A define on a binding, checked through `hasOwnProperty`, and a number target that throws the Object test's TypeError.
- A non-configurable redefinition: the same value returns, a different value throws the descriptor pack's TypeError.
- Pinned named refusals:
  - reading the defined property, or a descriptor's field (#7354 O4's member read in a program that names `Object`);
  - a define that may reject, in a program that catches;
  - `getOwnPropertyNames`, whose answer is an array;
  - a descriptor that is not an inline literal.

Related suites were run with `--maxWorkers=1`: the `issue-7354-*` and `issue-7364-*` files, every file matching
`*object-static*` or `*define-property*`, and the five `issue-3518` files the commit hook selects. The failure sets
were:

| tree | failing tests |
| --- | --- |
| head (31 files, 1,544 passed) | `issue-3663` host paths (2); `issue-7354-h` "object literal returned from an unannotated function" (1) |
| S3's merged branches (`0c7109594b` + `f0a23832`) | the same three |
| `origin/main` (22 of the files exist there) | `issue-3663` host paths (2) |

No failure is new against S3's branches. Pins this issue moves on purpose:

- `#3518`: the accessor-literal pins now expect acceptance, because `define-accessor` is realm-served; the provider-id
  count is twelve.
- `#7354 H`: the `Object.defineProperty` row runs now, instead of refusing for want of a home.
- `#7364`: the unadmitted define uses a descriptor held in a variable.

**Byte identity.** The ordinary pipeline was compiled on 100 test262 files that call `Object.defineProperty` (every
7th match under `built-ins/Object/defineProperty`, `language` and `built-ins/Array`, with their harness includes), in
both the default and the standalone mode. Head and base agree on all 200 rows: 176 binaries are identical, and 24 rows
fail to compile with the same errors on both.

**Gates.** All run unpiped: loc, func, coercion-sites, oracle-ratchet, dead-exports, compiler-boundaries inventory,
lint, format, import-cycles, ir-layering and issues, plus loc and func again against
`LOC_GATE_BASE=origin/main`. One grant was needed: `import-cycles-allow` `frontend->ir: 19` (+2, dated above). No
function-budget grant is needed.

**Census.** Run with `scripts/ir-census/prepared-census.mts --harness stand-in --jobs 1`, from
`origin/claude/es5-census-1119` at `940936f9`.

| files | stopped before (census of 2026-11-19, main `ee3fcdd610`) | stop now |
| --- | --- | --- |
| 26 of `crash-object-static-not-admitted.tsv` | `Object.defineProperty is not an admitted Object static` | 20: the stand-in's `__assert_sameValue` (`1 / actual`, ToPrimitive of an object in a program that names `Object`, #7354 O4); 3: a descriptor that is not an inline literal (`descriptor`); 2: `Object` read as a value; 1: `Array` not in scope |
| 40 `propertyHelper.js` includers (every 22nd of 905) | 17 built-in call or method, 14 script-var home of an object literal, 7 array literal, 1 call result, 1 new-expression | all 40: `propertyHelper.js` `verifyProperty`, `empty array 'failures' escapes before its element type is closed` |

No file passes yet. 23 of the 26 no longer stop at a define. The other 3 still stop there, now with the table's
reason (`descriptor`). The 20 stand-in stops are the next gap, and that gap belongs to S3's ToPrimitive of an object.
