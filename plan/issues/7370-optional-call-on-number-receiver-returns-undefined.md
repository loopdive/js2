---
id: 7370
title: "`x?.toFixed()` on a `number | undefined` receiver returns `undefined` even for a defined `x`"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7360, 2049, 4292]
---

# #7370 — an optional method call on a primitive receiver never runs

## Problem

Found by the #7360 review (RV7307, finding 2). On `origin/main` (ee3fcdd610), default and `--target standalone`
alike:

```ts
function f(x: number | undefined) { return x?.toFixed(1); }
f(2); // node "2.0"; we return undefined
```

| receiver | before |
| --- | --- |
| `x: number \| undefined` (f64 slot), `toFixed` / `toString` / `toPrecision` | always `undefined` |
| `x?: number`, `x: number \| null` (externref slot) | always `undefined` |
| plain `x: number` | correct (the IR path claims it) |

## Cause

Three places in the legacy optional-call path:

1. `compileOptionalCallExpression` (`expressions/calls-optional.ts`) treats every value-type (non-reference)
   receiver as "the representation of `undefined`/`null`" (#1603) and short-circuits unconditionally.
2. For an externref receiver, the non-null branch has no arm for a Number/Boolean/BigInt method: the #4292
   delegation to the generic receiver-method ladder is gated on `any`/`unknown`.
3. The ladder (`compileReceiverMethodCall`) and the import pre-scan both read the receiver's type as
   `number | undefined`, so no Number arm matches and `number_toFixed` is never registered.

## Implementation Plan

Legacy codegen only.

- **One receiver-type rule.** `optionalChainReceiverType(method, type)` in `builtin-subclass-receiver.ts` (the
  module that already owns "which type does a method receiver dispatch on"): past `x?.` the receiver is
  non-nullish. Used by `methodReceiverStaticType` (the ladder) and by `collectorReceiverType` (the pre-scan);
  `collectorReceiverType` now takes the property access, and its unused `ctx` parameter is gone.
- **Value receivers.** `compileOptionalValueReceiverCall` in `calls-optional.ts`: a receiver whose f64 slot can
  hold `undefined` (#7360's `f64MayHoldUndefined`) short-circuits on the sentinel; one whose static type admits
  neither `null` nor `undefined` always calls. Any other value slot (the #1603 `const x = undefined` i32) keeps the
  old short-circuit.
- **Externref receivers.** The #4292 delegation also takes a primitive receiver type
  (`isPrimitiveMethodReceiver`, which counts `boolean` as the `true | false` union it is).
- **Receiver re-evaluation.** Both arms call the ordinary ladder, which re-reads the receiver, so both take only a
  repeatable receiver (an identifier or `this`). The existing predicate is renamed from
  `isRepeatableDynamicOptionalReceiver` to `isRepeatableOptionalReceiver`, since it no longer serves only dynamic
  receivers.
- **Short-circuit value.** The new arms yield the lane's real `undefined` (`canonicalUndefinedExternInstrs`) for an
  externref result. The `any`/`unknown` arm keeps its existing default, so its bytes do not change.
- **Quality criterion.** One receiver-type rule shared by ladder and pre-scan; the new arms reuse the existing
  delegation and repeatability predicate instead of a second method-call path.

## Result (2026-11-19, on `claude/7360-nullish-f64` b210f2d40b)

- `tests/issue-7370-optional-call-value-receiver.test.ts`: 8 programs × gc/standalone, answers from node.
  Before: 14 of 16 fail; after: 16/16.
- Byte identity: 100 test262 files × gc/standalone, binaries identical (200/200).
- Gates: loc/func budget (also with `LOC_GATE_BASE=origin/main`), coercion sites, oracle ratchet, dead exports
  pass.

### Left open

- **Non-repeatable receivers** (`g()?.toFixed()`, `c.a?.toFixed()`) still short-circuit wrongly. The ladder
  re-reads its receiver, so those shapes need the receiver bound to the value already tested. That is a second
  mechanism, not this slice.
- **`b?.toString()` with `b: boolean | undefined`**: the parameter lowers to a bare i32 that cannot hold
  `undefined`, so `f(true)` and `f(undefined)` cannot be told apart. It is a representation gap, and main behaves
  the same.
