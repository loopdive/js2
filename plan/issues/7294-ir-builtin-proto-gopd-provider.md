---
id: 7294
title: "IR: `Object.getOwnPropertyDescriptor(<Builtin>.prototype, \"m\")` via a shared compile-time descriptor provider"
status: in-review
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7275, 7267, 7127, 7293]
assignee: "ttraenkler/c-lane-opus"
loc-budget-allow:
  # 2026-11-07 (#7294): the shapes, admission and lowering live in the new
  # src/ir/builtin-proto-member.ts and src/shared/ambient-intrinsics.ts; the
  # god files carry only wiring. from-ast.ts +15: the import, the two
  # one-line lowering hooks (+2 each) and the 8-line resolver adapter
  # `builtinProtoMemberLane`; select.ts +13: the import, two one-line hooks and
  # the selection adapter (+8), the options field and its doc (+2);
  # integration.ts +10: the multi-line re-export import (+4), the resolver
  # method (+2) and the provider arm (+3); index.ts +2: the import and the
  # selection option; builtin-value-read.ts +2: the re-export that keeps the
  # IR bridge off a new ir -> codegen edge (check:ir-layering).
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/codegen/index.ts
  - src/codegen/builtin-value-read.ts
  # 2026-11-07 (#7294, RV7167 B2): array-object-proto.ts +5: Promise's
  # dispatch reservation moves into its glue's `onRegister` hook (the
  # object-spread registration and the hook's 3 lines), so the provisional
  # selection-time query no longer mints `__call_m_then_vararg`.
  - src/codegen/array-object-proto.ts
standalone-arms-allow:
  # 2026-11-07 (#7294): builtinProtoMemberProvided repeats the SAME
  # `ctx.standalone` gate legacy's synthesis already sits behind
  # (`resolveBuiltinProtoGopdReceiver`), so the IR admits exactly where legacy
  # synthesizes the value and descriptor — not a new lane split.
  - src/codegen/native-proto-value-read.ts
func-budget-allow:
  # 2026-11-07 (#7294): one dispatch line per site into the shared module
  # (lowerPropertyAccess, lowerCall, isPhase1Expr: +2 each with prettier's
  # wrap), the resolver method (makeFromAstResolver +2), the selection option
  # (planIrOverlay +1) and the support-function arm beside the other
  # symbol-prefixed providers (resolveAndObserveCallableProvider +3).
  - src/ir/integration.ts::resolveAndObserveCallableProvider
  - src/ir/from-ast.ts::lowerPropertyAccess
  - src/ir/from-ast.ts::lowerCall
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/select.ts::isPhase1Expr
  - src/codegen/index.ts::planIrOverlay
---

# #7294 — IR: builtin-prototype `getOwnPropertyDescriptor` provider

## Problem

`Object.getOwnPropertyDescriptor(<Builtin>.prototype, "<literal>")` in test
module-init has no IR lowering (#7275 shape 2). Legacy synthesises the
descriptor at compile time from the `$NativeProto` glue.

## Measurement (main `c03f7d0e`, 2026-11-07): the provider alone has no file yield

### The family

There are **348** test262 files matching
`getOwnPropertyDescriptor(<Ctor>.prototype, "<lit>")`, either `Object.` or
`Reflect.` (a grep over `test262/test`). The largest directories are
`built-ins/Object` 134, `built-ins/RegExp` 77, `built-ins/Error` 33 and
`staging/sm` 32.

| What else the file needs | Files |
| --- | ---: |
| reads a builtin prototype member as a VALUE (`desc.value === Array.prototype.slice`), i.e. #7275 shape 1 | 224 |
| calls the accessor (`desc.get.call(…)`, `.get` / `.set`) | 178 |
| includes `propertyHelper.js` / `verifyProperty`, or any other `includes:` | 97+ |
| **none of the above** | **6**, all `staging/sm/Iterator/prototype/*/descriptor.js`, and they use `Reflect.getOwnPropertyDescriptor`, not `Object.` |
| no accessor call and no harness include, so the descriptor plus shape 1 suffice (upper bound) | 133 |

The 6 stride-40 sole-blocker files named in #7275 shape 2 are all in the
224 / 178 columns:

- `Object/getOwnPropertyDescriptor/15.2.3.3-4-{43,80,118,159}` assert
  `desc.value === <B>.prototype.<m>`, which is shape 1.
- `RegExp/prototype/{hasIndices,sticky}/this-val-*` call
  `desc.get.call(RegExp.prototype)`: an accessor call with a builtin
  prototype as `this`.

An unmask probe on #7293's branch confirms it: with the namespace admitted,
15.2.3.3-4-80 still fails in from-ast on the `String.prototype.toLocaleUpperCase`
read.

**So the descriptor provider ALONE moves 0 stride-40 files and at most 6
corpus files to zero legacy.** Paired with #7275 shape 1 (builtin prototype
member read as a value: the same identity-stable singleton closure that
`pushBuiltinFnSingletonValueInstrs` materializes, which is also the
descriptor's `.value`), the upper bound is 133 files.

### What the code offers

- **gc byte-identity is automatic.** `resolveBuiltinProtoGopdReceiver` returns
  `undefined` unless `ctx.standalone`, so the legacy arm never runs on gc.
  Lifting it into a shared helper cannot change gc bytes. It can change
  standalone legacy bytes if the helper becomes a called function instead of
  inline instructions.
- **The IR has no value-producing channel for an inline legacy instruction
  sequence.** `raw.wasm` has no SSA result, and prepared components treat it as
  opaque ("raw.wasm is opaque to symbolic dependency discovery"). The existing
  channel is a NAMED support function resolved by `resolver.resolveFunc` (as
  `irRuntimeFuncRef("__unbox_number")` / `"__iterator_return"` are). So the
  shared helper should be a compiler-support FUNCTION per (brand, member)
  returning `externref`, which legacy and IR both `call`. Legacy's standalone
  bytes then change (inline → call) while gc bytes stay identical.

## Status (2026-11-07)

PR #7167, held. It cannot release before #7324 lands. That is a
pre-existing gap: the call-graph gate skips lifted closures. This admission
newly reaches it in one file,
`built-ins/SharedArrayBuffer/prototype/growable/invoked-as-func.js`. #7324 is
merged into this branch once it lands, and then the 108-file byte proof
is redone.

## Implementation Plan (as built)

- **Shapes (syntactic, shared):** `src/shared/ambient-intrinsics.ts` gets
  `builtinProtoMemberValueRead` (`<B>.prototype.<m>` in a value position:
  initializer, `===`/`!==` operand, call argument) and
  `builtinProtoDescriptorCall`
  (`Object.getOwnPropertyDescriptor(<B>.prototype, "<lit>")`).
  - Both shapes use one unshadowed-globals check.
  - One symbol codec per role, `value` and `descriptor`.
- **Admission and lowering (IR):** `src/ir/builtin-proto-member.ts` gets
  `admittedBuiltinProtoMember`, which the selector (`isPhase1Expr`'s call and
  property-access arms) and from-ast (`lowerPropertyAccess`, `lowerCall`)
  both read.
  - It declines ES modules (prepared components), shadowed globals, members
    that are not own, overridden members, and a getter read as a value
    (reading a getter invokes it).
  - Lowering is one `emitCall` of the support function's runtime symbol.
- **The one synthesis (codegen):** `src/codegen/native-proto-value-read.ts`
  `builtinProtoMemberInstrs` builds the singleton closure value, or the
  data/accessor descriptor around it.
  - Legacy's gOPD arm inlines it, so legacy bytes are unchanged.
  - `ensureBuiltinProtoMemberFunc` wraps it as the support function the IR
    calls, resolved in `resolveAndObserveCallableProvider`. The bridge is
    re-exported through `builtin-value-read.ts`, so no new ir → codegen edge
    appears.
- **Selection-time query:** `builtinProtoMemberProvided` (native, non-fast lane,
  member not overridden in the source) runs inside
  `withProvisionalNativeProtoGlue`, so a declined unit leaves no glue
  registered.
- **Quality criterion:** one synthesis shared by legacy and IR, one admission
  shared by the selector and from-ast, no per-builtin arms.

## Recommendation (pre-implementation, superseded by the plan above)

Do shape 1 and shape 2 in ONE lane. Both are the same provider: the
(brand, member) singleton closure. Expose it as two compiler-support
functions, a value getter and a descriptor builder, and add two rows to
`src/ir/ambient-global-function-call.ts`. Built alone, shape 2 is a large
refactor with no measurable yield.
