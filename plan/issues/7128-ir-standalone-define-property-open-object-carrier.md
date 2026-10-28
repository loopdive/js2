---
id: 7128
title: "IR: standalone Object.defineProperty(o, k, d) via an open-object ($Object) carrier for escaping object literals"
status: in-progress
sprint: current
created: 2026-10-22
updated: 2026-10-28
assignee: ttraenkler/opus-7128-s1
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
---

# #7128 — IR: standalone `Object.defineProperty` via an open-object carrier

## Problem

The #7124 census (PR #6852) found ambient `Object.defineProperty(o, k, d)`
(`expr-object-define-property-target`) in 19 of 200 sampled test262 bodies. It
is the largest call-resolution cluster.

The IR arm is host-only. `objectDefinePropertyTarget()`
(`src/ir/integration.ts`) returns `null` on standalone, WASI and
strict-no-host. So on standalone every such body stays on legacy.

Fixing the call alone is not enough. Typical targets look like this
(`test262/test/built-ins/Object/defineProperty/15.2.3.6-4-326.js`):

```js
var obj = {};
Object.defineProperty(obj, "prop", { value: 2010, writable: true, enumerable: true, configurable: true });
var propertyDefineCorrect = (obj.prop === 2010);
obj.prop = 1001;
```

The IR lowers `{}` to a zero-field closed struct (`object.new` with
`fields: []`). It only claims that literal when it is unreferenced
(`isInertEmptyObjectLiteral`, #4471). A define has nowhere to land on that
struct where a later IR `obj.prop` read would see it. The fix needs an open
`$Object` carrier first.

Measured on main (2026-10-22, `.tmp/probe.mts`): a function-local
`var o = {}; Object.defineProperty(o, "x", {value: 1, …}); return o.x` gives
`f:unsupported/body-shape-rejected`, with `JS2WASM_IR_SHAPE_DIAG=1` reason
`objectlit-empty`, on both standalone and gc. Legacy returns 1 on both lanes.

## What legacy does on standalone (the semantics to match)

1. **Representation choice (pre-pass).** `collectEmptyObjectWidening`
   (`src/codegen/declarations/object-shape-widening.ts`) does not widen
   `var X = {}` into a struct in these cases:
   - X is a define target with a non-literal descriptor
     (`markStandaloneOutOfShapeDataDefineTargets` →
     `ctx.dynamicDescriptorWidenVars`);
   - X is an accessor-define target (`markStandaloneAccessorDefineTargets`);
   - X has a hash-only consumer (`objectHashConsumerVars`).

   X then stays an open-hash `$Object` built by `__new_plain_object`, typed
   `externref`.
2. **The define.** `emitDefinePropertyDescRuntime` (`src/codegen/object-ops.ts`)
   does the following:
   - calls `markRuntimeDefinedProperty`, which records `"X:key"` in
     `ctx.sidecarDefinedPropertyKeys` with owner scope (#5383);
   - converts the target to externref;
   - reifies a closed-struct descriptor into a fresh `$Object`
     (`emitDescriptorStructReify`), but only when
     `isDescriptorTranscribableStruct` holds (#2372/#4180/#4176);
   - calls the Wasm-native `__obj_define_from_desc(obj, key, desc)`.

   That helper performs:
   - the `$Proxy` front guard → `[[DefineOwnProperty]]` trap (#1355/#6651);
   - ToPropertyDescriptor via `__desc_has_own` and `__extern_get`, so getter
     side effects and ordering match the spec;
   - the §10.1.6 non-object descriptor TypeError;
   - ValidateAndApplyPropertyDescriptor, including non-extensible, frozen and
     non-configurable rejection (TypeError);
   - the store in `__defineProperty_value` / `__defineProperty_accessor`.

   It returns the target.

   **Measured exception (2026-10-22, standalone WAT of
   `var o = {}; Object.defineProperty(o, "x", {value: 1, writable: false, …})`).**
   `o` is still an externref `$Object`, so step 1 holds even for a pure data
   literal. The define itself does not go through `__obj_define_from_desc`.
   It takes the static expansion `emitExternDefinePropertyValue`
   (`object-ops.ts`), which works in three steps:
   - it converts the key to a string (`emitStandaloneDefinePropertyKeyToString`);
   - it calls `__defineProperty_value(obj, key, boxedValue, flags)`, with the
     attribute flags folded to an f64 constant;
   - it throws TypeError when the result is null.

   The read-back `o.x` is `__extern_get`, narrowed to f64 at the consumer.
   (On the host lane, a pure data literal instead keeps a widened struct
   plus a flag side channel: `definePropertyRoutesToRuntimeStore` returns false,
   `widenedDefinePropertyKeys`. That is host-only and out of scope.)
3. **Later reads.** `o.key` checks `sidecarDefinedPropertyKeys`
   (`src/codegen/property-access.ts` ~L4155) and then `emitRuntimeDescriptorGet`.
   That is `__extern_get(recv, "key")`. On standalone it is always externref:
   an accessor can produce a value the checker never saw (15.2.3.6-4-498
   family).
4. **Later writes.** `o.key = v` goes through the `$Object` MOP set. It honours
   `[[Writable]]` and setters. In sloppy mode a write to a read-only property
   is ignored; in strict mode it throws TypeError.

## Design

### D1. Open-carrier admission (selector, `src/ir/select.ts`)

Add a second empty-literal arm next to `isInertEmptyObjectLiteral`:
`isOpenCarrierEmptyObjectLiteral(expr)`. It admits `{}` only when all of the
following hold:

- The literal initializes an un-annotated `var`/`let`/`const` identifier
  binding. Same rule as #4471: an annotation selects a different legacy
  representation.
- Legacy also keeps the binding open. The selector must ask legacy, not
  re-derive the answer. Add a resolver query `isOpenObjectBinding(decl)` that
  returns true only when two conditions hold:
  - legacy's resolved local type for the declaration is `externref`;
  - no widened-struct entry exists for it (`ctx.widenedDefinePropertyKeys`,
    the widened-literal registry).

  This matters because if the IR claimed a binding that legacy widens into a
  struct, two units sharing the binding would see different stores. The
  pure-data-literal case is open on standalone (measured, see above), so this
  query admits S1's target shape.
- Every reference to the binding in its owner, nested closures included,
  matches by TEXT like #4471, and is one of these use kinds:
  - **U1:** the first argument of an exact ambient `Object.defineProperty`
    call that D3 admits;
  - **U2:** a named read `o.k` that is not a write target, call callee,
    `delete` operand, `typeof`-of-member, or `++`/`--` operand.

  Any other reference rejects the literal. In particular this refuses
  everything the first slice does not handle:
  - writes (`o.k = v`);
  - method calls (`o.hasOwnProperty`, `o.propertyIsEnumerable`);
  - passing `o` to another call (`Object.getOwnPropertyDescriptor(o, k)`,
    `verifyProperty`);
  - aliasing and closure capture.

  Later slices widen this set one use kind at a time, each against legacy and
  node. The order is in "Slices" below.

The selector's local-type map types the binding as raw `externref`
(`extern { className: "Object" }`). It must not be typed `dynamic`. That
matches legacy's local type, so a module-init `var` keeps legacy's global type
when IR and legacy units share it.

### D2. Lowering the open literal (`src/ir/from-ast.ts`, `lowerObjectLiteral`)

An admitted open `{}` lowers to `emitCall(irRuntimeFuncRef("__new_plain_object"), [], extern<Object>)`.
This reuses the call that `lowerOrdinaryToPrimitiveObjectLiteral` already
makes, so the IR adds no new helper, import or instruction. Its pre-registration
goes through the existing `integration.ts` `__new_plain_object` case.

### D3. The define (from-ast arm + `integration.ts` resolver)

Keep the existing exact-ambient interception in `lowerCallExpression`. It runs
before receiver lowering, which matches how #6846/#7118 treat the `Object`
receiver: `Object` is not read as a value, and no `dyn.member_get(global,
"Object")` is emitted. Do not route this through #7118's intrinsic-value
`dyn.global_object` path. A user-shadowed `Object` is already rejected by
`cx.scope.get("Object") === undefined && isAmbientBinding`. Tighten that to
#7118's `isLibOnlyBinding` once #6846 lands.

On native-first (`ctx.targetProfile.semanticProviders === "native-first"`),
add a separate resolver method, `objectDefinePropertyNativeTarget()`. It calls
`ensureObjectRuntime(ctx)` and returns
`irRuntimeFuncRef("__obj_define_from_desc")`. Leave the host method alone so gc
output stays byte-identical. Admit the call only when all of these hold:

- **arg0** is a D1 open-carrier binding (extern<Object>);
- **arg1** is a string literal or numeric literal (the sidecar key needs a
  static name, as in `markRuntimeDefinedProperty`);
- **arg2** is an inline object literal descriptor, lowered as in D4.

**Target per descriptor shape: mirror legacy's choice so the two match
helper-for-helper.**
- A pure data literal (`value` present, no `get`/`set`, no explicit-`undefined`
  field, static key) goes to `__defineProperty_value(obj, key, box(value),
  flags)`. Compute the flags constant with legacy's flag encoder, shared rather
  than copied. Then emit the same null-result → TypeError check that
  `emitExternDefinePropertyValue` emits. This is what legacy runs today for
  `15.2.3.6-4-326`, so S1 should use it.
- Every other descriptor goes to `__obj_define_from_desc` with a `$Object`
  descriptor (D4).

Discard the result when the call is an expression statement. Otherwise it is
the target (externref).

**Proxies, frozen and non-extensible targets** need no IR logic. The helper
owns every branch: the `$Proxy` guard, ValidateAndApply rejection, the throw.
An open-carrier binding admitted by D1 cannot itself be a proxy or frozen,
because every use is U1/U2. Once later slices admit `Object.freeze(o)` /
`Object.preventExtensions(o)` uses, those also run inside `$Object` runtime
helpers that the same define helper reads. The IR must never inline a
fast-path define store.

### D4. Descriptor objects

Do not lower a descriptor literal through `object.new`, because a closed struct
reaches the helper as a non-`$Object`. Lower it the way legacy's reify ends up:
`__new_plain_object` plus one `__extern_set(desc, "<field>", box(value))` per
property, in source order.

- **First slice (data descriptors):** admit only keys from
  `{value, writable, enumerable, configurable}`, with no duplicates. Values must
  be primitive literals (number, string, boolean, `undefined`, `null`) boxed by
  the existing coerce-to-externref. Source order is observable only through
  getters, which this slice does not admit, so the order cannot diverge.
- **Accessor descriptors (later slice):** `get: function () { … }` and
  `set: function (v) { … }`. Box the closure with `emitCallablePack`, exactly as
  `lowerOrdinaryToPrimitiveObjectLiteral` does for `valueOf`. Then do
  `__extern_set`. Before admitting, measure that `__defineProperty_accessor`
  invokes a callable-packed IR closure with the right `this`. Also mirror
  legacy's sidecar effects that react to accessor defines
  (`DESCRIPTOR_FLAG_ACCESSOR`, `runtimeAccessorDescriptorKey`).
- **A descriptor held in a variable** (`var d = {value: 1}; defineProperty(o,
  k, d)`) stays refused until `d` itself is an open carrier. The variable is
  then just an extern<Object> argument, with no reify step.

### D5. Later reads (U2)

`o.k` on an extern<Object> receiver reuses the #7106 S1c raw-externref arm in
`lowerPropertyAccess`: box the receiver → `emitDynMemberGet(recv, "k")`. The gc
`__dyn_member_get` body is the native `__extern_get` that legacy's
`emitRuntimeDescriptorGet` calls, so accessors fire identically. The result is
`dynamic`. Consumers narrow through the existing dynamic coercions, as legacy
narrows its externref at the consumer.

The selector currently admits that arm only for catch bindings
(`currentCatchBoundNames`). Widen the admission to "catch binding OR D1
open-carrier binding". Do not widen it to arbitrary externref.

### D6. Shared-state hazard with legacy

`markRuntimeDefinedProperty` also feeds legacy-only analyses of the same
binding: GOPD folds (`builtin-static-gopd.ts`), `typeof` / `delete` guards
(`typeof-delete.ts`), and `Object.keys` (`call-builtin-static.ts`). They are
keyed by `name:key` and owner scope. As long as D1 requires every use to be
U1/U2 inside one claimed unit, no legacy unit reads that binding. A binding
shared with legacy units is a module-init `var` read by a legacy-compiled
function. For that case D1 must either:

- (a) also record the sidecar key from the IR selector into
  `ctx.sidecarDefinedPropertyKeys`, through a resolver call, with the same
  owner scope; or
- (b) refuse module-scope bindings that any non-claimed unit references.

The first slice takes (b).

## Slices

1. **S1 (exact):** function-local or module-init `var o = {}`, uses only
   U1 (data descriptor literal, static key) and U2. Tests: IR vs legacy-only vs
   node on standalone, asserting the IR claim, zero post-claim errors and an
   equal value. On gc, assert that the function still declines and the binary
   is byte-identical to main.
2. **S2:** member writes `o.k = v`, through the `$Object` MOP set that legacy
   uses. Required evidence: a write to a non-writable property is ignored in
   sloppy mode (test262 non-strict body) and throws TypeError in strict mode.
3. **S3:** `o.propertyIsEnumerable(k)`, `o.hasOwnProperty(k)` and
   `Object.getOwnPropertyDescriptor(o, k)` round-trips. This needs
   `Object.<static>` routing and receiver-method dispatch on extern<Object>.
4. **S4:** accessor descriptor literals (D4), then `verifyProperty` harness
   calls, once #7106's harness units claim.
5. **S5:** array-literal targets, the census's second shape.

## Why no code slice shipped with this issue

S1 needs five coordinated changes:

- the D1 selector arm plus the resolver query into legacy's widening sets;
- D2;
- the D3 native resolver and arm;
- D4's descriptor builder;
- widening the D5 S1c admission.

Each must be proven against legacy on both lanes, with gc byte-identity. That
did not fit the rc-12 time box with the required gate chain. Claiming a partial
version (for example the define without D1's all-uses rule) produces wrong code:
the define would land in a `$Object` that the closed-struct reads never see.
Per #7124's own finding, S1 alone moves `ir_only_pass` by 0. Every
census body also has `var` declarations (#6835/#7114) and harness calls in
front of it, so S1 is groundwork and must not be tuned for a pass count.

## Acceptance criteria

- S1 lands with `tests/issue-7128-define-property-open-carrier.test.ts`
  covering:
  - claim + value parity on standalone, for both function-local and
    module-init bindings;
  - gc declining and byte-identical to main;
  - every refused use kind from D1 (write, method call, pass-to-call, alias,
    capture, annotated binding, descriptor variable, computed key) still going
    to legacy with no post-claim error.
- No new host import. Only existing runtime helpers are used:
  `__new_plain_object`, `__extern_set`, `__obj_define_from_desc`,
  `__dyn_member_get`.
- Conformance A/B on the 15.2.3.6-4-* data-descriptor rows
  (`test262/test/built-ins/Object/defineProperty/15.2.3.6-4-326.js` and its
  siblings): zero pass→fail rows on standalone.
