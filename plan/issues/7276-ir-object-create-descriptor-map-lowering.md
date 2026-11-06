---
id: 7276
title: "IR module-init: `Object.create(proto, {descriptor map})` lowered the way legacy does, by compile-time expansion"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7275, 7128, 7267, 7189]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-06 (#7276): the plan and the lowering live in the new
  # src/ir/object-create-call.ts. What remains in the god-files is wiring
  # with no other home:
  #   - select.ts +13: the selector adapter (lane + binding facts) and the
  #     one Phase-1 call arm beside `Object.defineProperty`'s;
  #   - from-ast.ts +28: the resolver capability union, the from-ast adapter,
  #     the arm at `lowerMethodCallWithSourcePlan` (the seam both call entries
  #     share), `lowerDataDescriptorFields` (which the #7128 open-carrier
  #     define now shares instead of keeping its own copy) and the `in` arm's
  #     fixed-name flag (review finding 1);
  #   - integration.ts +1: the import of the `in` probe's symbol set for its
  #     existing pre-registration.
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
func-budget-allow:
  # 2026-11-06 (#7276): one sibling arm in the flat call dispatch, beside
  # `Object.defineProperty`'s; splitting the dispatcher is its own refactor.
  - src/ir/select.ts::isPhase1Expr
---

# #7276: `Object.create(proto, {descriptor map})` in the IR

## Problem

#7275 measured 10 stride-40 files whose only legacy unit is `<module-init>`
and whose test body calls `Object.create({}, { <descriptor map> })`. Legacy
expands the descriptor map at compile time, so no runtime provider is needed
(`call-builtin-static.ts`, the `Object.create` arm).

## Measurement (2026-11-06)

**Legacy's expansion** (`call-builtin-static.ts`, the `Object.create` arm, ~L2674–2900) is two compile-time paths. Both start with `__object_create(<proto>)`; on standalone the proto literal is built as a native `$Object` by `compileProtoArg`:

- **Path A.** Taken when every descriptor is statically expandable (`mayStaticallyExpandCreateDescriptor`): one `__defineProperty_value(obj, key, value, flags)` per key, with the flags folded by `staticToBoolean`.
- **Path B.** Taken otherwise: one `__obj_define_from_desc(obj, key, <descriptor $Object>)` per key. This is the native `Object.defineProperty` applier, the same one the #7128 open-carrier define calls.

Neither output can be reused byte for byte from a from-ast arm, because legacy emits Wasm instructions and the IR emits IR. Path B's runtime callables are already IR-callable, though (`irRuntimeFuncRef`): `__new_plain_object`, `__object_create`, `__obj_define_from_desc`. So the IR emits path B, which is legacy's own construction. For a literal data descriptor, A and B compute the same ToPropertyDescriptor.

**The 10 stride-40 files.** I probed each by admitting `Object.create` in the selector (scratch, reverted) and recording the next refusal:

| file (`built-ins/Object/…`) | map shape | next blocker once `Object.create` is admitted |
| --- | --- | --- |
| `create/15.2.3.5-4-154` | `{prop: {value: "…"}}` | none: lowers |
| `create/15.2.3.5-4-229` | `{prop: {writable: "false"}}` | `newObj.hasOwnProperty("prop")` (`expr-module-scalar-method`) |
| `create/15.2.3.5-4-305` | `{prop: {enumerable: true}}` | same |
| `create/15.2.3.5-4-268` | `{prop: {set: function…}}` (accessor: refused) | same |
| `create/15.2.3.5-4-116` | `{prop: descObj}`, `new Number(-9)` | `new Number` before the call |
| `create/15.2.3.5-4-191` | `{prop: fun}` | the function-expression `var` before the call |
| `create/15.2.3.5-4-57` | `{prop: descObj}` | `var proto = {}` storage before the call |
| `create/15.2.3.5-4-94` | `{prop: {enumerable: argObj}}` | the `arguments` IIFE before the call |
| `hasOwn/…_inherited_getter…`, `prototype/hasOwnProperty/8.12.1-1_15` | `Object.create(base)`, no map | `var base = {}` storage before the call |

All 320 `built-ins/Object/create` files under the same scratch admission:

- 46 become fully selector-claimable;
- 10 of those are the all-literal subset: proto `{}`, plus keys whose descriptors carry primitive-literal data fields only;
- the other 36 have accessors, non-literal flags (`enumerable: new Boolean(…)`), non-literal descriptors or non-`{}` protos.

**Expected zero-legacy delta, stated before coding:** +1 at stride 40 (`15.2.3.5-4-154`), and at most +10 in `built-ins/Object/create`.

## Implementation Plan

- **Module.** `src/ir/object-create-call.ts` holds ONE plan, `objectCreateDescriptorMap`, and the lowering:
  - **Admission:**
    - shape: `Object.create({}, <map literal>)`;
    - lane: `native-dynamic-member-read`, standalone only, as for #7267's `JSON.parse`. WASI's IR member read does not answer for an open `$Object`;
    - binding: the lib-only `isUnshadowedLibGlobal`.
  - **Lowering:** `__new_plain_object` → `__object_create` → `emitOpenCarrierDefine` per key → box onto the dynamic carrier.
- **Reuse, and the duplicates it removes.**
  - `literalDataDescriptorFields` is extracted from #7128's `openCarrierDefinePlan`; the open-carrier define now calls it.
  - from-ast's field boxing becomes `lowerDataDescriptorFields`, shared by the #7128 define and this arm.
  - `isUnshadowedLibGlobal` is extracted identically to #7267, so the two PRs merge clean.
- **Wiring.**
  - Selector: one Phase-1 call arm beside `Object.defineProperty`'s. The call's TS type is `any`, so the binding is already dynamic and `dynamicUsesAreMoveOnly` needs no arm (measured: removing the two arms first drafted there changes nothing).
  - from-ast: one arm in `lowerMethodCallWithSourcePlan`, the seam that expression calls and statement calls both enter. The first cut sat in `lowerCall` and was a claim-then-refuse for statement-position calls.
- **Refused, so legacy keeps the call:**
  - a `null` proto: `__object_create` reads null as the `%Object.prototype%` terminal, and the IR has its own `Object.create(null)` contract;
  - a non-empty proto;
  - an accessor, a computed or non-literal flag, a non-literal descriptor;
  - a canonical array-index key: §20.1.2.3.1 defines in [[OwnPropertyKeys]] order, legacy in source order;
  - `__proto__`, which sets the map's prototype;
  - a duplicate key: the literal keeps the last value, while legacy defines twice and throws;
  - a source `Object` binding.
- **Code-quality criterion.**
  - The selector and from-ast read one plan.
  - No second descriptor parser and no second field-boxing loop.
  - No new host imports and no new provider.
