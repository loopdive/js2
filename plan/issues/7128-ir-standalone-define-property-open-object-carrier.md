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
# 2026-10-28 (S1): the open-carrier logic lives in its own modules
# (src/ir/empty-object-literal.ts, src/ir/open-object-carrier.ts,
# src/codegen/declarations/ir-open-object-binding.ts). What remains in the god-files is the
# hook each needs: from-ast's define arm extracted into its own function plus the
# from-ast half of the U1 lowering (it needs lowerExpr / boxConcreteToDynamic),
# the selection option at the production planning site, and two-line hooks in
# the selector's subject reset, move-only gate and scan.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/ir/select.ts::whyNotIrClaimable
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
  - src/codegen/index.ts::planIrOverlay
import-cycles-allow:
  - largestSccSize: 725 # 2026-10-28 (#7128 S1): src/codegen/declarations/ir-open-object-binding.ts asks legacy's var-slot typing (statements/variables.ts) and is read by codegen/index.ts, so it joins the SCC exactly as its sibling ir-dynamic-construct.ts does
  - ir->runtime: 10 # 2026-10-28 (#7128 S1, review of PR #6957): src/ir/empty-object-literal.ts reads Object.prototype's own keys from runtime/contracts/native-realm-catalog.ts, the pure-data spec catalog ir/program/native-realm-requirements.ts already imports; the alternative is a second hand-written copy of that key list
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

## S1 result (2026-10-28, ttraenkler/opus-7128-s1)

**Landed: the function-local half of S1.** Module-init bindings still decline
(see "Remaining"). Branch `claude/7128-s1-define-property-open-carrier`.

### What the code does

- **Selection** (`src/ir/select.ts` hooks, `src/ir/empty-object-literal.ts`).
  - An empty literal on an un-annotated identifier binding is admitted when it
    has no references (#4471, unchanged) or when it is an open carrier.
  - Open carrier means four things hold:
    - every same-text reference is U1 or U2;
    - the literal sits directly in the current subject's own body;
    - the selection option `isOpenObjectBinding` is present;
    - that option says legacy keeps the binding an unwidened externref
      `$Object`.
  - The option is `src/codegen/declarations/ir-open-object-binding.ts`. It checks
    `widenedTypeProperties` / `widenedVarStructMap` and legacy's own slot
    typing (`resolveSpillLocalValType`).
  - The binding then joins `dynNames`, as a catch binding does. So the
    move-only scan governs every consumer of `o.k`, and the define call scans
    as a concrete statement.
  - On top of that scan, U2 admits only an allow-list of `o.k` consumers and
    no key `Object.prototype` owns (item 5 below).
  - The admitted literal is recorded once in a `WeakSet`, which the lowering
    reads (`admittedEmptyLiteralIsOpenCarrier`); it is not re-derived.
- **Lowering.**
  - `src/ir/open-object-carrier.ts` holds the emission.
  - from-ast's defineProperty arm is now its own function,
    `lowerObjectDefinePropertyCall`.
  - The literal becomes `__new_plain_object`, typed raw externref.
  - The define builds a `$Object` descriptor: `__new_plain_object` plus one
    `__extern_set` per field in source order, with values boxed by
    `boxConcreteToDynamic`. It then calls `__obj_define_from_desc`.
  - A null result throws a TypeError (`__new_TypeError`) with legacy's
    message.
  - `o.k` takes the existing #7106 S1c raw-externref arm, `__dyn_member_get`.

### Corrections to the design (measured on main `b6250f09`)

1. **Binding type.**
   - The binding is raw `irVal(externref)`, not `extern{className:"Object"}`.
   - An `extern` receiver routes `o.k` into the extern-class arm of
     `lowerPropertyAccess`.
   - The raw externref takes the S1c `__dyn_member_get` arm with no from-ast
     change, so D5 needed no new read arm.
2. **One define path.**
   - Every descriptor goes to `__obj_define_from_desc`; the
     `__defineProperty_value` fast path is not used.
   - The S1 brief limits the helpers to `__new_plain_object`, `__extern_set`,
     `__obj_define_from_desc` and `__dyn_member_get`, and one path is less
     code. Legacy's static expansion reaches the same store.
   - One more existing helper is used: `__new_TypeError` (the IR already uses
     it in `native-in.ts`). The rejection is reachable within U1 alone:
     redefining a non-configurable property throws, and the test covers it.
3. **No `objectDefinePropertyNativeTarget` resolver method.**
   - On a lane with no host define helper, from-ast lowers the certified U1
     define through `irRuntimeFuncRef("__obj_define_from_desc")`, the same way
     it reaches `__extern_set`.
   - A lane gate in `integration.ts` would add a new `ir → codegen` import,
     which the `check:ir-layering` ratchet refuses.
   - The only gate is the selection option. It is set at the production
     planning site in `codegen/index.ts`, and is absent from the compatibility
     planning site in `integration.ts`.
4. **The gc gate is the raw target.**
   - The IR capability profile projects the native-regime gc lane to
     `target: "standalone"` (`projectIrBackendTargetProfile`), so no backend
     capability can tell gc from standalone.
   - The option is present only when `ctx.targetProfile.target ===
     "standalone" && !ctx.fast`.
   - Review nit 6 (PR #6957) asked for a named capability instead. None
     fits: every `IrBackendTargetCapability` is answered from that projected
     profile, so a new one would switch the arm on for native-regime gc,
     whose A/B has not run (gc output must stay byte-identical). The token
     `ctx.standalone` is the native regime, which is true on gc as well. The
     raw `CompileTargetProfile.target` is the only spelling that keeps gc
     declining. When the gc lane gets its own A/B, the check becomes a
     registry capability.
5. **Narrower U1 and U2 than D1.**
   - U1 must be an expression statement, because a used result would alias
     the carrier.
   - U2 admits a read `o.k` only where it is consumed DIRECTLY: one side of a
     strict `===`/`!==` whose other side is a primitive literal, `null` or
     `undefined` (review round 3, PR #6957). Rounds 1 and 2 used a wider
     allow-list, and each round found a new failing shape in it:
     - ToBoolean, `o.k.y` and `o.k?.y` (round 1);
     - loose `== null` and `switch` through an alias (round 2);
     - an alias `var y = o.k` passing the value on to `y.z` / `y?.z`, which
       miscompiled, and `- * / %` with a string or boolean operand, which
       demoted after the claim (round 3).
     So every alias (`var y = o.k`, `y = o.k`, `return`, `throw`) and every
     arithmetic, relational, loose-equality, ToBoolean, member, element and
     non-null consumer now keeps the function on legacy, which is correct by
     construction. A read used as a bare statement is refused by the scan
     anyway.
   - U2 also refuses a key that `Object.prototype` owns (taken from
     `NATIVE_REALM_CATALOG`). `__dyn_member_get` on the open `$Object`
     answers undefined for an inherited key, so `var t = o.valueOf; t ? 1 : 0`
     gave 0 under the IR (legacy and node: 1), even though a `var` initializer
     is an allowed consumer.
   - `+` is not on the allow-list. The move-only scan admits
     `<dynamic> + v`, and from-ast then demotes it ("operands not provably
     both-number or both-string"). This gap predates S1: on main,
     `function g(p) { return p.x + 1 === 4 ? 1 : 0; }` claims and then
     demotes. **No tracking issue exists for this gap yet**; it is named here
     until one is filed.
   - Two siblings of that gap are now closed in the shared dynamic-value scan
     (round-2 review, PR #6957), on both lanes and for dynamic parameters
     too: a `null` operand is buildable only under strict equality (loose
     `<dynamic> == null` demoted post-claim), and a dynamic `switch`
     discriminant is refused (it demoted with "switch disc must lower to
     i32/f64"). Both reached the carrier through `o.k == null` and through
     the `var v = o.k` alias.
   - **Still open, predates S1:** a catch binding compared loosely with null,
     `try { throw null } catch (e) { return e == null ? 1 : 0 }`, claims and
     demotes (`nullish-value-unsupported`) on base and head. The catch
     binding takes a different scan route from the dynamic-value one fixed
     above. No tracking issue exists yet.
   - Descriptor values are number, string and boolean literals only;
     `undefined` and `null` are deferred.
6. **The admission is per subject.**
   - The open-carrier names are reset at each subject's start.
   - Both the literal arm and the define arm require the subject's own body:
     `enclosingProjectionOwner(...) === currentSelectionSubject`.
   - So a closure's or module-init's carrier is never admitted by text.

### Measurements

| Check | Result |
| --- | --- |
| `tests/issue-7128-define-property-open-carrier.test.ts` | 28/28 pass, exit 0. Covers claim plus IR = legacy = node on 12 shapes; 14 refused use kinds staying on legacy with no post-claim error; module-init declining; gc declining with gc IR-on binary = IR-off binary. |
| Ad-hoc battery (`.tmp/battery.mts`, 50 shapes, `.ts` and `.js`) | IR value = legacy value on every shape; 0 post-claim errors. |
| gc byte identity, base `b6250f09` vs head | 427/427 gc binaries identical. Inputs: 50 battery sources plus the 378 data-descriptor rows run through `wrapTest`, all compiled with `experimentalIR` on. One source, the `.js` annotated case, fails to compile on both sides. |
| Standalone conformance A/B, 378 rows (`15.2.3.6-4-*`, no `get:`/`set:`) | base 371 pass / 7 fail, head 371 pass / 7 fail, **0 pass→fail, 0 status changes**. Expected: every row is a script body, so its define runs in module-init, which S1 does not claim. |
| Equivalence files touching defineProperty or objects (12 files) | All pass, exit 0: define-property-typeerror, empty-object-widening, numeric-key-object, object-create, object-define-property{,-accessors,-extended,-return}, object-keys, object-mutability, object-literal-getters-setters, object-to-primitive. |
| Gate chain (`LOC_GATE_BASE=origin/main`) | All exit 0. LOC and func growth are granted above. `largestSccSize` 724→725 is granted: the new codegen query joins the SCC as its sibling `ir-dynamic-construct.ts` does. `check:ir-fallbacks` shows no unintended or post-claim increase. |

Review round (PR #6957, 2026-10-28, base `origin/main` merged in):

| Check | Result |
| --- | --- |
| PR test file + 14 `tests/equivalence/*{define-property,object}*` files | 15 files, 131/131 pass. The PR file has 44 tests: 14 claimed shapes = node, 24 refused shapes (incl. every review repro) on legacy with no post-claim error, plus the non-null, returned-read, annotated, module-init and gc cases. |
| gc byte identity vs `origin/main` | 37/37 identical (13 playground examples + 24 hand-written programs, incl. every review repro). Standalone: the 9 allow-listed programs differ, the other 28 are identical. |
| Standalone A/B, the 378 rows | base 371/7, head 371/7, 0 pass→fail, 0 status changes. |
| Gate chain, `LOC_GATE_BASE=origin/main` | 11/11 exit 0, with one new grant: `ir->runtime: 10` (the catalog import). |

Commands:

```bash
npx vitest run tests/issue-7128-define-property-open-carrier.test.ts
# A/B: base = git worktree of origin/main at .claude/worktrees/base-7128
#   (node_modules and test262 symlinked in)
(cd <root> && npx tsx /tmp/claude-0/ab/ab-rows.mts rows.txt)   # runTest262File(..., "standalone") per row
(cd <root> && npx tsx /tmp/claude-0/ab/gc-bytes.mts)          # sha256 of each gc binary
for f in <12 files>; do npx vitest run tests/equivalence/$f.test.ts; done
```

### Remaining for S1

- **Module-init bindings.** On standalone, `var obj = {}` at top level rejects
  as `vardecl-var-kind`, and `let`/`const` reject as
  `vardecl-module-storage-unrepresentable`. The module-binding resolver has no
  slot kind for an open-`$Object` global.
- **What it needs.** That resolver kind, U2 reads of a module global inside
  module-init, and the move-only treatment of module-init. This overlaps
  #7132 (PR #6866, held), which binds a script `var` to legacy's externref
  slot. It should land on top of that.
- **D6(b).** Function-local bindings need no D6 work. The module-scope refusal
  of bindings referenced by a non-claimed unit stays open with the
  module-init step.
