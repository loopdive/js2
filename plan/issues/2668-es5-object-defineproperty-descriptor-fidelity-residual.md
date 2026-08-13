---
id: 2668
title: "ES5: Object.defineProperty/defineProperties descriptor fidelity residual (~788 fails — largest ES5 cluster)"
status: ready
created: 2026-06-25
updated: 2026-08-04
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: es5
related: [1460, 1462, 929, 3185, 4008, 4158]
sprint: current
---
# #2668 — ES5 Object.defineProperty/defineProperties descriptor fidelity residual

## Edition / impact

- **Edition:** ES5.
- **Fail count:** **~788** — the single largest ES5 cluster.
  - `built-ins/Object/defineProperty`: **506**
  - `built-ins/Object/defineProperties`: **282**
  - (plus tails: `Object/create` 89, `getOwnPropertyDescriptor` 26 — track here too).
- **Highest ES5 bang-for-buck.** Residual after #1460 / #1462 / #929 (all done) —
  those landed core descriptor support; this is the long tail of full
  [[DefineOwnProperty]] spec fidelity.

## Problem

`Object.defineProperty` / `defineProperties` do not fully implement the
ES5/ES2015 9.1.6 `[[DefineOwnProperty]]` / `ValidateAndApplyPropertyDescriptor`
algorithm. The failing tests exercise the validation matrix that the current
implementation handles only partially:

- **Attribute defaulting** when adding a new property (missing attributes
  default to `false`/`undefined`).
- **Reconfiguration rules** on existing properties: non-configurable properties
  may not change configurable/enumerable, may not switch data<->accessor, may
  not change a non-writable data value (with the `SameValue` exception), etc. —
  each illegal change must throw `TypeError`.
- **Array exotic [[DefineOwnProperty]]**: defining `"length"` (RangeError on
  invalid length, deletion of out-of-range indices), defining an index ≥ length
  updating `length`, non-writable `length` blocking index adds.
- **Accessor descriptors**: get/set must be callable-or-undefined; redefinition
  preserves unspecified attributes.
- **Side-effect ordering**: descriptor field reads (`get`, `set`, `value`,
  `writable`, `enumerable`, `configurable`, plus `ToPropertyKey` on the key) in
  the spec-mandated order, each read once.

Failure signatures are dominated by `assert.sameValue(obj.prop, ...)`,
`verifyProperty(...)`, `assert.throws(TypeError/RangeError, ...)`.

## Failing-test cluster (examples)

```
built-ins/Object/defineProperty/15.2.3.6-4-*           (the big 4-* descriptor-matrix family)
built-ins/Object/defineProperty/name.js, length.js, descriptor-*-*.js
built-ins/Object/defineProperties/15.2.3.7-*           (multi-descriptor application + ordering)
built-ins/Object/create/15.2.3.5-*                     (create with property descriptors)
```

## Acceptance criteria

- Target: pass **≥ 600 of the ~788** failing `defineProperty`/`defineProperties`
  tests (full `ValidateAndApplyPropertyDescriptor` matrix).
- All non-configurable-property illegal-change cases throw `TypeError`.
- Array `length` define cases throw `RangeError` on invalid length and update
  `length` correctly on index define.
- Descriptor-field reads occur in spec order, once each.
- No regression in currently-passing Object.* tests.

## Notes — feasibility: hard

This is core property-machinery work and touches the object model; route to the
architect for an implementation spec before dispatch. Likely a focused rewrite
of the shared `[[DefineOwnProperty]]` helper rather than per-method patches.
Consider slicing: (a) data-descriptor matrix, (b) accessor + data<->accessor
switch, (c) Array-exotic length/index. Each slice is independently shippable.

## Slice A — landed (sd-2668a, host mode)

**Status:** Slice A merged; the issue stays open for Slices B (accessors),
C (array-`length` exotic) and D (cleanup). The full architect plan lives in
PR #2068 (`arch-2668-spec`).

### Verify-first finding — the real dominant bug differs from the spec framing

The architect plan described a struct fast-path ↔ runtime-validator divergence
for the *inline-literal* path. Verifying per-file on current main (isolated
runs; the in-process batch driver is unreliable here — fork-state poisoning
inflated the apparent `compile_error` bucket to ~1021/1131, but each flagged
file PASSES in isolation) showed the inline-literal GOPD round-trip already
works. The genuine bucket is the **`15.2.3.6-3-*` family where the descriptor
is supplied as a non-literal expression** — most commonly a *local whose
initializer is an object literal* (`var d = {value:1};
Object.defineProperty(o, k, d)`).

Two fixes (final scope after an auto-park merge_group diagnosis, below):

1. **Host route for LITERAL-resolvable dynamic descriptors.** The inline fast
   paths in `compileObjectDefineProperty` (`src/codegen/object-ops.ts`) only fire
   for a *syntactic* object-literal descriptor at the call site. A descriptor
   identifier whose declaration initializer is an object literal fell through to
   `emitExternDefinePropertyNoValue`, which has no descriptor to read and
   silently dropped the value + every attribute. **Fix:** in host mode, when
   `descriptorInitializerForIdentifier(descArg)` resolves to a literal, route to
   `emitDefinePropertyDescRuntime` → `__defineProperty_desc` (full
   ToPropertyDescriptor + `_validatePropertyDescriptor`, §10.1.6.3), mirroring
   the standalone `__obj_define_from_desc` route.

2. **Typed-field value not synced.** A `const o: any = {}` whose property is
   later defined gets a *typed* struct shape (e.g. `(struct (field $property …))`)
   because the checker widens it; the member read `o.property` ref-tests as that
   struct type and lowers to a static `struct.get`, which never consults the
   sidecar. The runtime descriptor appliers wrote only the sidecar, so the
   static read returned the field's stale initializer. **Fix:** new
   `_structFieldWriteback` (`src/runtime.ts`) mirrors a defined data VALUE into
   the real struct field via the compiled `__sset_<key>` export, called from
   `__defineProperty_desc` and `__defineProperty_value` (value case). It does
   NOT re-run `_safeSet`'s flag enforcement — the appliers already validated.

### Auto-park merge_group diagnosis (#2547) — what got cut from Slice A

PR #2074's first enqueue was auto-parked: the `merge_group` re-validation
(merged state — catches what PR-level checks miss) reported **+41 improvements
but 9 regressions** (net +32 pass), tripping the 10% regression-ratio gate
(22%). All 9 regressions were in the same `15.2.3.6-3-23..45` for-in family.
Localized locally (paired base-vs-fix isolated runs) to **two** over-reaching
parts of the first cut, both removed:

- A **for-in enumerability filter** (drop a typed field whose `_wasmPropDescs`
  entry is `DEFINED && !ENUMERABLE`). It is correct for a *genuine*
  `enumerable:false`, but these tests' descriptors carry `enumerable:true` on a
  **prototype** that the runtime ToPropertyDescriptor reader can't see, so the
  property was recorded non-enumerable and wrongly hidden. Reverted — the
  for-in honoring needs the proto-read fix first (deferred).
- The dynamic-descriptor route was **narrowed** from "any non-literal
  descriptor" to "identifier resolving to an object **literal**". Arbitrary
  host-object descriptors (`Math`, `Date` instance, `Object.create(proto)`) are
  left on their prior path, because `__defineProperty_desc`'s reader resolves a
  WasmGC-struct descriptor's attrs only on its OWN level and would drop a
  prototype-inherited `enumerable`/`configurable`.

### Out of scope / deferred

- **For-in / Object.keys honoring `enumerable:false` on a typed field** — needs
  the proto-inherited-attribute read fix first (the `Object.create(proto)` +
  proto-sidecar gap below); deferred to a follow-up.
- **Prototype-chain attribute reading for a WasmGC-struct descriptor** —
  `Object.create(proto)` / `Array.prototype.<attr>` descriptors read attrs as
  absent (own-level only). Pre-existing substrate gap.
- Arbitrary host-object descriptors (`Math`/`Date` as descriptor;
  `15.2.3.6-3-144/145-1`) — not routed (would need the proto fix).
- `Object.defineProperty(arguments, …)` mapped-arguments rows
  (`15.2.3.6-4-292`) — mapped-args territory (#1511/#2667).
- The `#2130 delete-then-re-add → "in" true again` vitest fails on base main
  too (confirmed by reverting this PR's src and re-running) — pre-existing.

### Test results

- New: `tests/issue-2668.test.ts` (8 cases, all green) — literal-resolvable
  descriptor value application + GOPD round-trip + ToBoolean attr +
  default-attrs + explicit w/e + 3 no-regression guards (inline define, plain
  assign, and the proto-inherited for-in case Slice A must NOT regress).
- Regression: all 52 existing `defineProperty` cases (`issue-1460/1629*`) green;
  broad object suites (`issue-2017/2042/1364a/1364b/2580-m3-bacc/
  delete-operator/...`) green; the 9 auto-parked regressions verified
  recovered (isolated runs). `tsc --noEmit` clean.
- Conformance: net-positive, **0 regressions** — re-validated via the
  `merge_group` floor (core define/read path is broad-impact).

## Slice B — landed (sd-2668b, host mode)

**Status:** Slice B merged; issue stays open for Slice C (array-`length`
exotic) and D (cleanup). Slice B targets **own-property accessor descriptor
identity**: `Object.getOwnPropertyDescriptor(o, k).get/.set` returning the same
function the user passed, and redefine-preserves-the-other-half.

### Verify-first finding — the real bug is accessor re-synthesis, not read-back

The box was quiet, so the per-file signal sd-2668a couldn't get earlier was
reliable here (fresh single-process `runTest262File`, not the in-process batch).
Repro (host/JS): `Object.defineProperty(o, "p", { get: getter, set: setter });
Object.getOwnPropertyDescriptor(o, "p").get === getter` → **false** on main, even
though `o.p` invokes the getter correctly.

Root cause is in **codegen**, not the runtime read-back. For an
*identifier-reference* accessor half (`{ get: fnRef }`), the
`emitExternDefinePropertyNoValue` getExpr/setExpr branches
(`src/codegen/object-ops.ts`) resolved `fnRef` back to its function
*declaration* (`resolveExprToFuncNode`) and **re-synthesized a FRESH closure**
via `emitAccessorFn`. That fresh closure is a different object than the value the
user holds, so the descriptor's get/set never matched `=== fnRef`. (The runtime
already memoizes the `_wrapWasmClosure` invocation bridge per source closure and
`_hostEqComparableValue` unwraps it on `===`, so once the *stored* value derives
from the user's actual closure, identity round-trips for free.)

### The fix (one change, host mode)

`emitAccessorRefValue` (`src/codegen/object-ops.ts`): in **host mode**, compile
the `get`/`set` reference expression *directly* to push the user's actual
function value (function-reference identity is stable in this compiler), instead
of re-synthesizing from the declaration. Standalone keeps `emitAccessorFn`
(host-free closure the native accessor arms dispatch through) — byte-identical
standalone output. Invocation is unaffected (the runtime bridge dispatches via
`__call_fn_method_0/1`, which also threads the receiver as `this` — a strict
improvement over the captureless re-synthesized fn).

### Discarded approach — runtime GOPD unwrap (documented to save the next dev)

An earlier cut ALSO unwrapped the accessor bridge back to the raw closure at the
`__getOwnPropertyDescriptor(s)` boundary. It produced the same +33 on the
accessor batch but was **reverted** — it returns the raw WasmGC closure, which
is `typeof "object"` (violates "accessor get is a function") and is **not
dynamically invocable** (`desc.get()` → `NaN` in TS mode; broke the existing
`issue-1629` "preserves referenced getter identity" vitest). The codegen-only
fix avoids this entirely: the descriptor keeps the invocable JS-function bridge,
and identity is recovered by the existing `__host_eq` unwrap.

### Scope / two comparison regimes (why some shapes still differ)

- **Regime 1 — `any === any` (the test262 regime).** test262's harness is
  untyped JS, so `desc.get === origGetter` lowers to the JS-host `__host_eq`
  path, which unwraps the bridge → identity matches. **This is what Slice B
  fixes.**
- **Regime 2 — statically function-typed `fnRef === any GOPD result`.** Lowers
  to WasmGC `ref.eq` across two representations (a closure-ref vs the host bridge
  externref) and does not match. This is a deeper representation-canonicalization
  gap (out of Slice B scope) — the Slice B vitest cases use `any`-typed function
  values to reflect the regime that is actually fixed.
- Proto-inherited accessor attribute reads remain deferred to **#2680**.
- Inline-method (`get(){}`) `this`-binding capture (`issue-929` "accessor
  descriptor" case) fails on base too — pre-existing, untouched, separate.

### Test results

- New: 4 `#2668 Slice B` cases in `tests/issue-2668.test.ts` (get/set identity
  round-trip + typeof, redefine-preserves-other-half, invocable-after-define,
  data-value identity no-regression guard). Full file green (12 cases).
- Per-file accessor batch (734 `defineProperty`/`defineProperties`/
  `getOwnPropertyDescriptor` files touching get/set, fresh single-process):
  **+33 pass (342→375), 0 regressions** (pass→fail).
- Regression: `issue-1460/1629*/1364a/1364b/2017/2580-m3-bacc/2042-s3` +
  `accessor-side-effects` green (119 passed; the lone fail is the pre-existing
  `issue-929` inline-capture case, fails on base). `tsc --noEmit` clean.

## Slice C — landed (sd-2668c, host/standalone mode-agnostic)

**Status:** Slice C merged; issue stays open for Slice D (cleanup). Slice C
targets **Array exotic `[[DefineOwnProperty]]` for the `length` property** —
`Object.defineProperty(arr, "length", desc)`, ES §10.4.2.1 `ArraySetLength`.

### Verify-first finding — every failing array-length test fails at the FIRST `assert.throws`

Reproduced per-file on current main (fresh single-process `runTest262File`, NOT
the in-process batch — fork-state poisoning). Every `15.2.3.6-4-*` array row and
every `built-ins/Array/length/define-own-prop-*` row fails at the **first
`assert.throws(RangeError|TypeError, …)`**: `Object.defineProperty(arr,
"length", desc)` was a silent no-op — `parseCanonicalArrayIndex` explicitly
rejects `"length"` so `maybeEmitVecLengthGrowth` skipped it, and the generic
descriptor path has no array-length-exotic handling. So nothing threw, and a
valid value never updated `vec.length` (struct field 0).

### The fix (one new function, `src/codegen/object-ops.ts`)

`maybeEmitVecLengthDefine(ctx, fctx, objArg, propArg, descArg)` — called from
`compileObjectDefineProperty` just before `maybeEmitVecLengthGrowth`; returns a
`ValType` (handled, caller returns immediately) or `false` (defer, unchanged).
Fires only for a `"length"` string-literal key + object-literal descriptor +
side-effect-free receiver that resolves to a WasmGC vec. Implements the
spec-mandated **rejections** plus the simple length set:

- get/set accessor descriptor on `length` → **TypeError** (length is a data prop).
- `configurable:true` / `enumerable:true` (literal) → **TypeError** (illegal
  change of a non-configurable, non-enumerable property's attributes).
- `value` (number/boolean/null/undefined/**string**) whose ToUint32 ≠ ToNumber
  (NaN / ±Infinity / fractional / negative / > 2³²−1 / non-numeric string) →
  **RangeError** (computed inline: `nl≥0 && nl≤4294967295 && floor(nl)===nl`).
  Spec order is preserved — the value RangeError is checked **before** the
  illegal-attr TypeError when both are present.
- a valid uint32 `value` → set `vec.length` (field 0), **growing the backing
  `$data` array** when `newLen` exceeds capacity (mirrors
  `maybeEmitVecLengthGrowth` — the vec invariant length ≤ array.len(data) must
  hold; setting the length field alone caused an OOB read). Allocation guarded
  at `nl ≤ 16M`. Shrinks keep the backing capacity (reads are length-bounded).

Strings are admitted because `StringToNumber` (§7.1.4.1) has **no** observable
side effects — same "no object ToPrimitive" guarantee as a number.

### Out of scope / deferred

- **Per-index configurability on shrink** (`15.2.3.6-4-116/117/168-177`):
  shrinking length below a non-configurable index must throw TypeError and stop
  at that index — needs per-index descriptor tracking (an array substrate gap),
  not present. Those rows stay failing (no regression).
- **Object/symbol-valued length descriptors** (`15.2.3.6-4-146-151`): need the
  full host ToNumber/ToPrimitive engine + spec field read-order. Deferred.
- **Frozen (`writable:false`) length blocking later index adds** (`-188/-189`):
  needs a per-array frozen-length sidecar bit. Deferred.
- **Sparse near-2³² lengths** (`-154/-155/-183-186`): a dense WasmGC vec cannot
  represent a 4-billion-slot sparse array. Deferred.
- **`getOwnPropertyDescriptor(arr, "length")` attribute fidelity** + the
  `verifyProperty` tails (`-116/-222/…`): depend on the per-index work above.

### Test results

- New: 9 `#2668 Slice C` cases in `tests/issue-2668.test.ts` (RangeError on
  fractional/negative/undefined value, TypeError on configurable/enumerable
  true + accessor descriptor, valid value updates `length`, no-throw on valid
  integer, index-define growth no-regression guard). Full file green (21 cases).
- Per-file array-length batch (79 files: `15.2.3.6-4-*` array rows +
  `Array/length/*`, fresh single-process): **+18 pass, 0 regressions**
  (pass→fail). `tsc --noEmit` clean.
- Conformance: net-positive, **0 regressions** — re-validated via the
  `merge_group` floor (define/array path is broad-impact).

---

## Implementation Plan

> Author: architect (arch-es5), 2026-06-25. Grounded by reading the live
> mechanism on current main (the defineProperty path is untouched on
> `po-edition-gaps`, so the anchors hold for both). All file:line anchors below
> are against that tree — re-`grep` the function name before editing, sibling
> PRs shift line numbers (memory `feedback_reground_spec_against_current_main`).

### Root cause — the dual-path divergence

There are **two independent `[[DefineOwnProperty]]` implementations** in the
tree, and they disagree:

1. **Runtime path (high fidelity).** `_validatePropertyDescriptor`
   (`src/runtime.ts:1556`) is a near-complete ES §10.1.6.3
   `ValidateAndApplyPropertyDescriptor`: attribute defaulting on first define,
   redefine-preserves-omitted, all non-configurable illegal-change throws,
   `SameValue` value check, data↔accessor switch guard. It is reached by the
   JS-host imports `__defineProperty_desc` (`runtime.ts:8312`),
   `__defineProperty_value` (`runtime.ts:8418`), `__defineProperty_accessor`
   (`runtime.ts:8457`) and `__obj_define_from_desc` — all call
   `_validatePropertyDescriptor` (callers at `runtime.ts:8381, 8442, 8492, 8642,
   8673`) and store flags into the canonical sidecar tables `_wasmStructProps`
   (value, `runtime.ts:48`) + `_wasmPropDescs` (flags, `runtime.ts:583`) +
   `_wasmStructAccessors` (`runtime.ts:590`). The read-back path
   `_readOwnDescriptor` (`runtime.ts:4301`) reads those **same** tables, so the
   host-runtime round-trip is largely correct.

2. **Inline / struct fast-path (partial fidelity).** When the receiver resolves
   to a static WasmGC struct *and* the descriptor is an object literal with a
   `value`, `compileObjectDefineProperty` (`src/codegen/object-ops.ts:919`)
   takes the `useStruct` branch (`object-ops.ts:1308`, body at
   `object-ops.ts:1614`). This branch:
   - emits a raw `struct.set` for the value,
   - tracks attributes at **compile time** in `ctx.definedPropertyFlags`
     (Map keyed `varName:propName`, `object-ops.ts:1660-1717`) and
     `ctx.shapePropFlags` (`object-ops.ts:1726`),
   - runs a **hand-rolled, partial** validation inline
     (`object-ops.ts:1685-1714`) — and a second, separate runtime flag-check
     helper `emitDefinePropertyFlagCheck` (`object-ops.ts:709`) that stores
     flags into a **third, divergent** side-table keyed `__pf_<propName>`
     (`object-ops.ts:717`) via `__extern_get/set` — a table **nothing in
     `_readOwnDescriptor` consults**.

The failures are the cartesian product of the two paths disagreeing:

- **Attribute round-trip drops.** The struct fast-path's compile-time
  `definedPropertyFlags` and `__pf_` table are not the `_wasmPropDescs` table
  the read path reads — so `getOwnPropertyDescriptor` / `verifyProperty` see
  default `{writable,enumerable,configurable}=true` regardless of what was
  defined. This is the **single biggest** bucket (the `15.2.3.6-4-*`
  `verifyProperty` family, 735 tests).
- **Runtime behavior doesn't honor flags.** `writable:false` on a struct field
  does not block a later `obj.x = v` (the struct.set assignment path has no
  flag guard); `enumerable:false` is honored only when the read consults
  `_wasmStructPropertyIsEnumerable` (`runtime.ts:4389`) — but struct-fast-path
  fields never populate `_wasmPropDescs`, so for-in still lists them;
  `configurable:false` does not block `delete`. `verifyProperty` mutates the
  object to probe exactly these, so a dropped flag fails 2-3 assertions.
- **Partial inline validation.** `object-ops.ts:1685-1714` omits the
  `SameValue` value-equality exception, the accessor get/set-identity check, and
  only fires when both receiver var-name and prop-name are static literals
  (`varName`/`propName` both resolved). Any dynamic key or non-identifier
  receiver silently skips validation.
- **Array-exotic `length` unhandled.** `maybeEmitVecLengthGrowth`
  (`object-ops.ts:463`) handles *only* index-define→length-growth. Defining
  `"length"` itself (`RangeError` on a non-uint32 / fractional value; deleting
  out-of-range indices when shrinking; `writable:false` length blocking
  subsequent index adds) is **entirely missing** — `parseCanonicalArrayIndex`
  (`object-ops.ts:433`) explicitly rejects `"length"`.

### The fix strategy — converge on the runtime validator

**Do NOT extend the inline `__pf_`/`definedPropertyFlags` machinery.** It is a
parallel half-implementation. The strategy is to **route every define through
the already-correct `_validatePropertyDescriptor` + `_wasmPropDescs` sidecar**
and make the struct fast-path *also* publish to that sidecar, so reads,
for-in, writes, and delete all consult one source of truth. Concretely:

- Keep the `struct.set` value write (it is the zero-overhead storage for the
  common `{value}` case — the no-regression fast path), **but** after it, always
  emit a side-effecting call that records the *full descriptor flags* into
  `_wasmPropDescs` via the runtime — i.e. fold the struct path's flag handling
  into the **same** `__defineProperty_value(obj, key, val, flags)` sidecar write
  the externref path already uses (`emitExternDefinePropertyValue`,
  `object-ops.ts:2130`), rather than the divergent `__pf_` table. The struct
  path already has a TODO-shaped comment acknowledging this
  (`object-ops.ts:1305-1307`): *"emit an additional side-effect
  `__defineProperty_value` call … so attribute flags are propagated to the
  runtime sidecar (`_wasmPropDescs`) for later
  `Object.getOwnPropertyDescriptor` reads."* Verify whether that call is
  actually emitted today (read `object-ops.ts:1760-1960`) — if it is, the bug is
  that the *flags integer* passed is incomplete; if it isn't, that's the drop.
- Make **runtime behavior honor the sidecar flags**: the struct-field write
  path (member assignment `obj.x = v` lowering in
  `src/codegen/expressions/assignment.ts`) and `delete obj.x`
  (`src/codegen/typeof-delete.ts`) must consult `_wasmPropDescs` for
  writable/configurable when the field has a defineProperty'd descriptor. For
  the **standalone** target (no JS host) this needs a Wasm-native flag check;
  for **host** target the existing `__extern_set`/`__obj_delete` runtime entries
  already gate on the sidecar — confirm and wire the struct path to them.
- **Standalone parity (`ctx.standalone`)**: the `__defineProperty_*` and
  `__extern_*` host imports are refused under `--target standalone` (#1472
  Phase B — see the gate at `object-ops.ts:1224-1230`). The standalone path
  currently relies on the struct fast-path + `shapePropFlags` for flags. Slices
  must either (a) keep standalone on a Wasm-native flag-table struct field, or
  (b) explicitly scope each slice to **host mode first** and file a standalone
  follow-up. Recommend **(b)** per slice to keep slices small — the bulk of the
  788 fails run in host mode (the default test262 runner target). Coordinate
  the standalone value-rep with #2580 (the any-typed value-read substrate) and
  `project_standalone_any_string_value_read_substrate` — do **not** invent a new
  standalone descriptor representation here; defer standalone descriptor
  fidelity to a #2580-dependent follow-up.

### Representation — where per-property attributes live

| Store | Location | Holds | Read by |
|-------|----------|-------|---------|
| `_wasmPropDescs` | `runtime.ts:583` | `Map<key, flags:int>` WEC+ACCESSOR+DEFINED bits | `_readOwnDescriptor`, `_wasmStructPropertyIsEnumerable`, delete/write gates — **canonical** |
| `_wasmStructProps` | `runtime.ts:48` | dynamically-added / defineProperty'd **values** | read-back, has-check |
| `_wasmStructAccessors` | `runtime.ts:590` | `{get,set}` fns (incl. symbol keys) | accessor read-back |
| `ctx.definedPropertyFlags` | compile-time Map | `varName:propName → flags` | **inline path only — divergent, to be retired** |
| `ctx.shapePropFlags` | compile-time, per-structTypeIdx | WEC bits per user field | standalone GOPD fallback |
| `__pf_<prop>` extern table | `emitDefinePropertyFlagCheck` | boxed flags via `__extern_set` | **nothing canonical — to be retired** |

The flag bit layout is **already unified** between codegen and runtime:
`PROP_FLAG_*` (`object-ops.ts:646-650`: WRITABLE=1, ENUMERABLE=2,
CONFIGURABLE=4, DEFINED=8, ACCESSOR=16) ≡ `_SC_*` in `runtime.ts`. Reuse them;
do not introduce a new encoding.

**Target end-state representation:** `_wasmPropDescs` (host) is the single
source of truth for attributes; the struct field remains the value store for
the data-`{value}` fast path; `definedPropertyFlags` / `__pf_` are deleted once
their last reader is migrated. Standalone keeps `shapePropFlags` until #2580.

### Slice breakdown (each independently shippable)

Order matters: **Slice A first** — it is the largest bucket *and* establishes
the "publish-to-`_wasmPropDescs`" convergence the later slices build on.

#### Slice A — data-descriptor attribute round-trip + runtime honoring (host)
**~480-520 fails** (the `15.2.3.6-4-*` `verifyProperty` data-property family +
much of `defineProperties`). Highest ROI; do first.

- **Scope:** data descriptors (`value`/`writable`/`enumerable`/`configurable`),
  host mode. No accessors, no array-length.
- **Changes:**
  1. `src/codegen/object-ops.ts` — `compileObjectDefineProperty` `useStruct`
     branch (`~1614`): after the `struct.set`, ALWAYS emit the
     `__defineProperty_value(obj, key, val, flags)` sidecar call
     (`emitExternDefinePropertyValue`, `~2130`) with the **complete**
     `computeDescriptorFlags(...)`/`applyDescriptorFlags(...)` integer — so
     `_wasmPropDescs` is populated identically to the externref path. Verify the
     existing "additional side-effect" call at `~1760-1960` and fix the flags
     integer it passes (or add the call if absent).
  2. Retire the inline `emitDefinePropertyFlagCheck` (`~709`) / `__pf_` table
     for this path — let `_validatePropertyDescriptor` (already called by
     `__defineProperty_value`, `runtime.ts:8442`) be the sole validator. Remove
     the partial inline validation at `object-ops.ts:1685-1714` for non-frozen
     receivers (keep the `nonExtensibleVars` extensibility throw at `~1679`).
  3. **Runtime honoring of `writable:false`**: the `obj.x = v` struct-field
     assignment lowering (`src/codegen/expressions/assignment.ts` — grep
     `struct.set` member-assign) must, when `obj` has a `_wasmPropDescs` entry
     with `!WRITABLE`, route the write through the runtime
     `__extern_set` (which silently no-ops a non-writable data prop and throws in
     strict mode) instead of a bare `struct.set`. Simplest: when a field has
     *ever* been `defineProperty`'d on this receiver (`definedPropertyFlags`
     has the key, or unknown receiver), lower the assignment via the sidecar
     write rather than `struct.set`.
  4. `delete obj.x` honoring `configurable:false`: `src/codegen/typeof-delete.ts`
     — gate the struct-field delete on the sidecar's CONFIGURABLE bit (host
     `__obj_delete` already does — confirm the struct path reaches it).
- **Verify:** `15.2.3.6-4-100..140` (value/attribute round-trip),
  `15.2.3.6-4-292..360` (writable/enumerable/configurable behavior),
  `15.2.3.6-4-1.js` (non-extensible throw).

#### Slice B — accessor descriptors + data↔accessor switch (host)
**~140-180 fails** (the `15.2.3.6-4-*` accessor sub-family +
`defineProperties` accessor rows). Depends on Slice A's sidecar convergence.

- **Scope:** `get`/`set` descriptors (inline fn, fn-ref, `undefined`),
  redefinition preserving unspecified accessor halves, data↔accessor switch
  validation, host mode.
- **Changes:**
  1. `compileObjectDefineProperty` accessor branch (`~1355-1612`): ensure the
     accessor is mirrored into `_wasmStructAccessors` + `_wasmPropDescs` (the
     `emitExternDefinePropertyNoValue` → `__defineProperty_accessor` path,
     `runtime.ts:8457`, already does this — the bug is the static-struct branch
     `~1355` captures the getter into the compiled `${structName}_get_<prop>`
     fast path *instead of* the sidecar, so `getOwnPropertyDescriptor(o,k).get`
     identity and `verifyProperty` fail). Make the static-struct accessor branch
     **also** publish to the sidecar (one write reconciles every reader — the
     comment at `object-ops.ts:1331-1335` describes exactly this for the
     `any`-receiver case; extend it to the static-struct case for GOPD identity).
  2. data↔accessor switch validation is already in `_validatePropertyDescriptor`
     (`runtime.ts:1616-1632`) — once the accessor publishes through
     `__defineProperty_accessor`, the switch guards fire for free. Remove the
     partial inline data↔accessor throw (`object-ops.ts:1707-1712`).
- **Verify:** `15.2.3.6-4-209.js` (accessor update-all), the
  `get`/`set`-identity redefine rows, `defineProperty` accessor `verifyProperty`
  rows.

#### Slice C — Array-exotic `[[DefineOwnProperty]]` for `length` + index (host)
**~60-90 fails** (`defineProperty` array rows + a slice of `Array` length
tests). Independent of A/B (touches the vec path), can land in parallel.

- **Scope:** `Object.defineProperty(arr, "length", desc)` and the non-writable
  length / index-add interaction.
- **Changes:**
  1. `src/codegen/object-ops.ts` — add a `maybeEmitVecLengthDefine` sibling to
     `maybeEmitVecLengthGrowth` (`~463`): when `propArg === "length"` on a vec
     receiver, implement ES §10.4.2.1 `ArraySetLength`:
     - `ToUint32(value) !== ToNumber(value)` → **RangeError** (throw via
       `emitThrowRangeError` — add if missing, mirror `emitThrowTypeError`);
     - new length < current → delete (zero/tombstone) indices in
       `[newLen, oldLen)`; if any is non-configurable, throw TypeError and stop
       at that index (set length to that index + 1);
     - `writable:false` in the length descriptor → record a "frozen length" flag
       in the sidecar so subsequent index-defines beyond length throw.
  2. `maybeEmitVecLengthGrowth` (`~463`): before bumping, consult the
     frozen-length flag and throw TypeError if the index ≥ frozen length.
  3. `parseCanonicalArrayIndex` (`~433`) stays as-is (correctly rejects
     `"length"`); the new `"length"` handler is a separate branch.
- **Verify:** `defineProperty/redefine-length-with-various-values-and-configurable-true.js`,
  array index-define rows in `15.2.3.6-4-*` (e.g. `15.2.3.6-4-209.js` array
  receiver), `Array/length/*` define cases.

#### Slice D (optional cleanup, post A/B) — retire divergent tables
**0 direct fails** (regression-guard only). After A+B land and all readers
consume `_wasmPropDescs`, delete `emitDefinePropertyFlagCheck`, the `__pf_`
extern table, and `ctx.definedPropertyFlags` (keep `shapePropFlags` for
standalone). Pure simplification — ship only once A+B are green to avoid
churn during the migration.

### Edge cases (apply across slices)

- **First-define defaulting:** omitted attributes default to `false`/`undefined`
  — already correct in `_validatePropertyDescriptor` (`runtime.ts:1581-1599`).
  Ensure the struct fast-path computes the same via `computeDescriptorFlags`
  (`object-ops.ts:657`), **not** `PROP_FLAGS_DEFAULT_DATA` (which defaults all
  true — correct only for *plain assignment* `obj.x = 1`, **wrong** for
  `defineProperty`).
- **Redefine preserves omitted attributes** (`{value:5}` on an existing prop
  keeps its w/e/c) — runtime `applyFlag` (`runtime.ts:1581`) handles it; the
  struct path's `applyDescriptorFlags` (`object-ops.ts:671`) must pass the
  *current* flags, not defaults — verify the `currentFlags` resolution at
  `object-ops.ts:1662-1664`.
- **Non-configurable illegal changes** all throw TypeError: configurable
  false→true, enumerable flip, data↔accessor switch, writable false→true,
  non-`SameValue` value on non-writable. All in `_validatePropertyDescriptor`
  (`runtime.ts:1606-1646`). Slices A/B just need to *reach* it.
- **`SameValue` exception** (`runtime.ts:1642`, `Object.is`): a non-writable
  non-configurable data prop may be "redefined" with the *same* value (incl.
  `+0`/`-0`, `NaN`). Do not regress — the inline path lacks this (a reason to
  retire it).
- **Non-extensible receiver** adding a *new* prop → TypeError; redefining an
  *existing* field is allowed. Inline check at `object-ops.ts:1679` is
  receiver-var-name-gated; the runtime `__defineProperty_value` extensibility
  check (via `__ne`, `object-ops.ts:876-896` + runtime) is the general one.
- **Descriptor-field read order / read-once** (§ToPropertyDescriptor): the
  failing tests in this cluster are dominated by `verifyProperty` /
  `assert.throws`, not side-effect-ordering probes — **defer** strict
  read-order to a follow-up; it is a small sub-bucket. Note it in the slice-A
  PR as a known gap.
- **`defineProperties` batching:** `compileObjectDefineProperties`
  (`object-ops.ts:2628`) iterates descriptor entries; once each entry routes
  through the converged single-property path (A/B), batching is correct. The
  spec requires **all** descriptors validated against the live object in order;
  the dynamic fallback `__defineProperties` (`object-ops.ts:3260`,
  `runtime.ts`) already does this — ensure the inline-literal batching loop
  (`~2660-2703`) delegates per-entry to the same converged path rather than the
  old inline flag handling.
- **`ToPropertyKey` on the key**: numeric keys (`defineProperty(o, 0, …)`) box
  as number-externref and must be ToString'd — handled by #2042 PR-A
  (`object-ops.ts:2098`). No new work, just don't regress.

### Risks / coordination

- **File conflict surface:** `src/codegen/object-ops.ts` is the hot file; A, B,
  C all touch it. Land **A first**, then B and C rebased on it. C is the most
  isolated (vec path) and can go in parallel with B if devs coordinate the
  `object-ops.ts` import block.
- **`assignment.ts` / `typeof-delete.ts`** (Slice A steps 3-4) are shared with
  many other features — scope the flag-gate narrowly (only when the receiver has
  a defineProperty'd descriptor) to avoid regressing the plain-assignment fast
  path.
- **Standalone (`ctx.standalone`)**: every slice is **host-mode-first**.
  Standalone descriptor fidelity is gated on #2580's value-rep substrate — file
  a standalone follow-up per slice, do not block host-mode landing on it.
- **#2580 (any-typed value-read substrate)** and #2585/#2040 (tag-5 classifier)
  overlap the standalone struct-value read; keep this issue's standalone work
  out of scope to avoid colliding with that in-flight substrate work.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — sliced. Slice A (host mode) landed (an auto-park merge_group diagnosis, #2547, trimmed its scope). Slices B (accessor descriptors) + C (Array-exotic length/index, ArraySetLength) remain; the ~788-fail ES5 cluster is not closed. Stays in-progress.

## ⚠️ RE-SCOPE 2026-07-26 (opus-loop-e, task #24) — PART OF THE RATIONALE IS VOID

**A different failure mode from the other false-label cases: the *status* here is
fine, the *reason* is partly wrong.** This issue is not falsely `done` — it is
live work justified in part by a defect that does not exist.

This issue inherits the ES5 census #3626 §2.2 framing, including the
**A2 "delete of non-configurable succeeds" (22 tests)** row. **That defect does
not exist.** Re-measured on HEAD (see #3626 §2.2.1, landed via PR #3657):

- `defineProperty(o,"x",{value:1,configurable:false}); try { delete o.x } catch(e){ e.name }`
  → **"threw TypeError"**, matching a V8 control. Spec-correct today.
- The census probe read `"x" in o` **after** a `delete` that throws, so that
  expression never evaluated — the recorded `false` is a swallowed-exception
  artifact. It measured the throw, not the value.
- Corroboration: no 22-test cluster exists corpus-wide. `configurable`-mentioning
  failure signatures total **~16, all singletons**.

The **A1** row is also inverted: the dominant direction is properties being
**over-restricted** (34 "expected to be writable, but was not") rather than
under-enforced (~10, all `using`/`await-using`, not ES5). And the
`defineProperty` bucket is **276 failures across 102 distinct signatures**
(largest 17, 6 %) — not one mechanism, so the "ceiling 564" framing is withdrawn.

**Remaining valid scope: the array/vec residual only.** Re-scope accordingly and
do not carry the A2 delete-non-configurable justification forward.

**Caveat on the A1 number, so it is not misused:** that ~10 was measured against
the cached baseline jsonl, which **predates the #3603 de-inflation**. The
post-de-inflation regression set contains a much larger `writable`/`configurable`
wrongly-TRUE population (#3653, 202 + 134), which the pre-de-inflation baseline
could not see. The two are measured on different trees and do **not** contradict —
do not cite the ~10 against #3653.

## Re-measure 2026-08-04 — standalone lane, ES5 + untagged scope

Source: `plan/log/analysis-2026-08-04-es5-untagged-standalone-clusters.md`.
Baselines fetched 2026-08-04, `oracle_version` 12, lane `honest`, baseline SHA
`d3d7ec4c`. Scope is edition label `ES5` ∪ `Unclassified (untagged)` ∪
`Unclassified (legacy)`, standalone lane, `scope_official` only.

**762 files** — the largest cluster in that scope, ahead of Array traversal (738).
605 `ES5`-tagged, 157 untagged. This is the descriptor family as a whole:
attribute round-trip via `verifyProperty` (381) plus the
`defineProperty`/`defineProperties`/`create`/`gOPD`/`seal`/`freeze` residual (381).

Top failure shapes:

```
65  obj.property   Expected SameValue(«undefined», «…»)   built-ins/Object/defineProperty/15.2.3.6-3-228-1.js
37  accessed !== true                                     built-ins/Object/defineProperty/15.2.3.6-3-40.js
31  Expected obj[…] to be writable, but was not           built-ins/Object/defineProperty/15.2.3.6-4-302-1.js
31  data           Expected SameValue(…)                  built-ins/Object/defineProperties/15.2.3.7-5-b-244.js
27  desc.writable  Expected SameValue(«undefined», «true»)built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-4.js
24  Expected obj[…] to equal …, actually null             built-ins/Object/defineProperty/15.2.3.6-4-231.js
22  newObj.prop    Expected SameValue(«undefined», «…»)   built-ins/Object/create/15.2.3.5-4-250.js
21  afterWrite     Expected SameValue(«false», «true»)    built-ins/Object/defineProperty/15.2.3.6-3-159.js
```

**Sizing caveat — 422 of 762 (55 %) also fail on the JS-host lane.** Only 340 are
standalone-only. This is not a standalone-substrate line item; most of the work
pays into ES5 conformance on both lanes, and quoting 762 as standalone yield
overstates it roughly 2×. (Same finding as the 2026-08-01 census, refutation #5.)

**Framing:** this cluster and #3185's array-traversal cluster are two faces of one
substrate gap — property access is shape-specialised rather than routed through
the ordinary-object MOP (`[[Get]]` / `[[Set]]` / `[[HasProperty]]` /
`[[DefineOwnProperty]]` over a descriptor table and the prototype chain).
Together with #3185 they account for 1,500 of the 3,854 non-passes in scope.
Sequencing note: a substrate fix that lands the MOP for ordinary objects should
move both, so measure them together rather than claiming each in full.

**Missing-throw sub-cluster:** 59 of these are `assert.throws` seeing no exception
at all (illegal reconfiguration silently accepted). They belong here and to
#4008, not to the new #4158, which covers the Reference-layer remainder.

**Not verified by repro.** These counts derive from the published baselines; no
compiler was built for this re-measure.

## Current-main implementation plan (2026-08-13)

This section supersedes the stale 2026-08-04 sizing above. It is grounded on
exact upstream `main` compiler SHA
`81125e5e248847a5df94c3e2a3a20016782e1df4`, baselines-repo SHA
`356b7ffd2127fd58b1091852d4483a436c0bee32`, and test262 corpus SHA
`b363f29d3c43c626dc852744ad64a0b48a003693`. The source inventory is
`.tmp/es5-host-inventory/host-es5-nonpass.jsonl`; its checked summary is
`.tmp/es5-host-inventory/summary.json`. The joined full-lane inputs are
`.tmp/es5-host-inventory/test262-current-81125e5e.jsonl` and
`.codex/worktrees/es5-complete-20260813/.test262-cache/test262-standalone-current-81125e5.jsonl`.
These are measurement artifacts, not files to commit.

### Current census and scope boundary

The landing-ES5 manifest contains **9,029** files. Joining by exact test path,
deduplicating each baseline first, gives:

| Current result | Files |
|---|---:|
| pass in both lanes | 7,145 |
| host non-pass, standalone pass | 1,115 |
| host pass, standalone non-pass | 263 |
| non-pass in both lanes | 506 |
| **total** | **9,029** |

Host therefore has 7,408 pass and 1,621 non-pass (1,597 fail, 21
`compile_error`, 3 `compile_timeout`); standalone has 8,260 pass and 769
non-pass (705 fail, 60 `compile_error`, 4 `compile_timeout`). `compile_error`
and `compile_timeout` are never counted as pass.

The exact issue-family filter is:

```text
^test/built-ins/Object/(defineProperty|defineProperties|create|getOwnPropertyDescriptor|freeze|seal|preventExtensions|isFrozen|isSealed|isExtensible|getOwnPropertyNames|keys)/
```

It selects **567** files: `defineProperty` 299, `defineProperties` 175,
`create` 44, `getOwnPropertyDescriptor` 27, `freeze` 8,
`getOwnPropertyNames` 4, `keys` 5, `preventExtensions` 3, and `isSealed` 2.
All 567 are host non-passes (563 fail, 4 compile errors); 492 pass standalone
and 75 are non-passes in both lanes. Thus this family accounts for 492/1,115
of the current host-only gap, but only the 75 shared non-passes are evidence
for a cross-lane substrate defect.

The ES5 filename stages are useful diagnostics, not root-cause labels:

| Diagnostic filename group | Total | standalone pass | shared non-pass |
|---|---:|---:|---:|
| `Object.create/4-*` Properties application | 42 | 35 | 7 |
| other `Object.create` | 2 | 1 | 1 |
| `defineProperty/3-*` ToPropertyDescriptor | 70 | 68 | 2 |
| `defineProperty/4-*` DefineOwnProperty | 227 | 191 | 36 |
| other `defineProperty` | 2 | 1 | 1 |
| `defineProperties/5-b-*` ToPropertyDescriptor | 30 | 30 | 0 |
| `defineProperties/6-a-*` application | 125 | 112 | 13 |
| other `defineProperties` | 20 | 17 | 3 |
| the remaining APIs | 49 | 37 | 12 |
| **total** | **567** | **492** | **75** |

Manual localization of those 75 shared rows, using the first failing
assertion plus the current writer/reader path, gives the following exhaustive
partition. These are **implementation boundaries, not independently proven
causal counts**; every claimed flip still requires the A/B protocol below.

| Localized boundary | Files |
|---|---:|
| exotic `Properties`/descriptor-carrier storage and enumeration | 8 |
| `Object.create` prototype/method dispatch | 2 |
| explicit-`undefined` descriptor presence/redefinition | 5 |
| accessor return or missing-argument `undefined` ABI | 5 |
| sparse uint32 array index/logical-length representation | 6 |
| canonical vec own-index state/default descriptor/readers | **13** |
| vec backing capacity after length-only growth | 2 |
| vec accessor/heterogeneous-value routing | 4 |
| closure callback illegal-cast before an array assertion | 2 |
| unavailable QuickJS provider in the measurement environment | 1 |
| mapped `Arguments` exotic object | 7 |
| ordinary plural-transition validation | 2 |
| named expando/prototype/global-object MOP | 9 |
| intrinsic/global descriptor seeding | 5 |
| empty-string own-key enumeration | 1 |
| preventExtensions identity or boxed-String exotic behavior | 2 |
| optional `Document` host facility/import leak | 1 |
| **total** | **75** |

This issue remains restricted by the 2026-07-26 re-scope to the array/vec
residual. The first implementation slice below targets the coherent 13-file
vec-index boundary. It does **not** absorb the sparse-uint32 rows, mapped
Arguments, ordinary-object descriptor work (#4008), runtime-eval accessor
carrier invocation (#4197), or the residual tombstone/sparse-array work in
#4222. A slice may land after demonstrating a two-lane improvement, but this
issue must not be called complete from a source-shape subset: the completion
boundary is **9,029/9,029 landing-ES5 passes in each lane**, including tests
whose harness uses `eval`, `Function`, or `with`.

### Root cause: vec length is not vec own-property presence

The compiler currently splits one array index's state across the backing vec,
standalone `$Object`/`$PropEntry` overlay entries, host WeakMap sidecars,
`FLAG_COMPANION_VALUE` (`src/codegen/vec-overlay.ts:106`),
`FLAG_DELETED_INDEX` (`src/codegen/vec-overlay.ts:107`), and several
compile-time `definedPropertyFlags` readers. No one query distinguishes:

1. an absent index (out of range, elision, length-grown hole, or tombstone),
2. a live backing element with the implicit array-element descriptor
   `{writable:true, enumerable:true, configurable:true}`,
3. an explicit data descriptor, whose value authority is either the backing
   vec or the companion entry, and
4. an explicit accessor descriptor.

The host implementation exposes the ambiguity directly in
`_vecDefineOwnProperty` (`src/runtime.ts:6041`): an in-bounds element without a
sidecar cannot be distinguished from a compiler-created hole after pre-growth,
so it is treated as a fresh all-false define. Standalone has more tombstone
plumbing, but its definition, presence, reflection, enumeration, delete, and
integrity paths still reconstruct different answers. Consequently an ordinary
live element can lose its implicit attributes, a hole can appear own, and a
metadata entry can disagree with the value read.

### Semantic contract

Introduce one representation-neutral vec-index classification used by both
lanes. The state names are normative even if the implementation encodes them
as bits rather than an enum:

| State | Own? | Descriptor/value rule |
|---|---|---|
| `ABSENT` | no | prototype lookup may continue; omit from own-key readers |
| `DEFAULT_DATA` | yes | backing vec value; W/E/C are all true |
| `EXPLICIT_DATA` | yes | overlay attributes; backing value unless `FLAG_COMPANION_VALUE` |
| `ACCESSOR` | yes | overlay getter/setter and attributes; no backing-value fallback |

The invariant is **absence-exception based**: `index < logical length` is live
by default, except where a hole/tombstone marker says otherwise. Reuse the
existing deleted-index marker as the canonical absent-index bit if possible;
do not create another descriptor table. A length increase or array elision
marks the newly exposed indices absent; assignment or successful data/accessor
definition clears absence at that index; delete marks it absent; shrink makes
all indices at or above the new length unobservable; later growth marks the
newly exposed range absent again and must not resurrect stale values or
descriptors.

For dense numeric/f64/string vecs, do not materialize one `$PropEntry` per
implicit element. Store hole exceptions in the existing overlay ownership
layer (a side bitmap/range set is acceptable), keyed by vec identity. Host and
standalone must implement the same four-state contract. In particular, do not
encode holes by a JS `undefined`/Wasm null value: those are valid present data
values, and f64/native-string vecs cannot carry a universal hole sentinel.

### Changes

**Files: `src/runtime.ts` (`_readOwnDescriptor` line 5345,
`_ownStructKeys` line 5573, `_vecDefineOwnProperty` line 6041,
`_wasmStructHasOwn` line 3625, `_safeGet` line 4506, `_safeSet` line 4785,
`_testIntegrityLevel` line 787)**

- Add one host-side `_readVecIndexState(obj, key, exports)` helper returning the
  canonical index plus `ABSENT | DEFAULT_DATA | EXPLICIT_DATA | ACCESSOR` and,
  for explicit states, the one sidecar descriptor read during classification.
- Canonicalize the key once with the existing array-index predicate. `"01"`,
  `"-0"`, `"1.0"`, `2^32-1`, symbols, and non-index named keys remain on the
  named-property path. Do not infer presence from backing capacity.
- Make `_vecDefineOwnProperty` synthesize the current descriptor from that
  state before ValidateAndApplyPropertyDescriptor. For `DEFAULT_DATA`, the
  current W/E/C bits are all true. For `ABSENT`, apply new-property defaults.
  Preserve descriptor-field presence bits; omitted fields are not explicit
  false/undefined fields.
- Route host `Get`, `Set`, HasOwn/HasProperty, gOPD, own-key enumeration,
  deletion, and freeze/seal/preventExtensions checks through the same query.
  Read the sidecar once per operation so a later branch cannot observe a
  different descriptor.
- Extend the existing host vec sidecar ownership with an absence bitmap/range
  set. It must be weakly keyed by vec identity and must not retain compiled
  instances after they become unreachable.

**Files: `src/codegen/vec-overlay.ts` (flags lines 106-107 and
`fillVecOverlayHelpers` around line 637),
`src/codegen/vec-overlay-presence.ts` (`buildVecHasIdxPresencePrologue` line
99), `src/codegen/vec-bag-seed.ts` (`buildVecDeletePrologue` line 390)**

- Add the standalone implementation of the same four-state query to the
  existing vec-overlay subsystem. One acceptable ABI is a native multi-result
  helper returning `(canonicalIndex:i32, kind:i32, entry:(ref null
  $PropEntry))`; `canonicalIndex = -1` means the key is not an array index and
  callers must use the named-property path.
- Reuse `FLAG_DELETED_INDEX` for `ABSENT`. `FLAG_COMPANION_VALUE` only selects
  the value authority for an `EXPLICIT_DATA` entry; it must not by itself imply
  presence. Accessor entries never fall back to `array.get`.
- Replace the separate deleted-index tests in the HasOwn/HasProperty and delete
  builders with this query. Preserve the carrier-bag split for non-index keys.
  Generate fresh `Instr[]` objects at every splice site; the finalize passes
  must not receive shared instruction objects (#1302).
- Every `ref.cast` introduced by classification must be dominated by the
  appropriate `ref.test`; wrong-shape inputs take the ordinary/named fallback
  or a catchable JS `TypeError`, never an `illegal_cast` trap.

The standalone control flow should have this shape (indices and concrete helper
names are allocator-owned):

```wasm
local.get $recv
local.get $key
call $__vec_index_state
local.set $entry       ;; third result
local.set $kind        ;; second result
local.set $index       ;; first result

local.get $kind
i32.const $ABSENT
i32.eq
if
  ;; no own property; Get may continue at the prototype
else
  local.get $kind
  i32.const $DEFAULT_DATA
  i32.eq
  if
    ;; descriptor W/E/C = 1/1/1; typed array.get owns the value
  else
    ;; one $PropEntry owns attributes/accessors;
    ;; FLAG_COMPANION_VALUE selects companion vs backing data value
  end
end
```

**Files: `src/codegen/array-length-define.ts`
(`maybeEmitVecLengthDefine` line 111 and assignment validation line 496), plus
the array construction/mutation emitters selected by code search**

- On length growth, mark `[oldLength,newLength)` absent before publishing the
  new logical length. Use word/range operations rather than an O(newLength)
  `$PropEntry` allocation loop. On shrink, make entries at and above the new
  length unobservable and discard explicit descriptors when safe.
- Array literal elisions and `new Array(n)` create absent ranges. A direct
  index assignment, `push`, or a successful index define clears absence for
  exactly the written index. `delete`, `pop`, and length shrink mark/remove
  state consistently. Audit `shift`, `unshift`, `splice`, and helper-returned
  arrays before retiring the old reader paths because they renumber or create
  indices.
- Do not solve the six sparse-uint32 rows here by allocating a huge backing
  vec. The current signed-i32/logical-length limitation is a separate sparse
  array representation change (#4222).

**Files: `src/codegen/object-runtime-descriptors.ts`
(`__obj_define_from_desc` lines 1910-2256),
`src/codegen/object-runtime.ts` (`fillDynamicForinVecArms` line 8108), and all
vec gOPD/own-key/integrity helper builders found from these entry points**

- Keep ToPropertyDescriptor and ValidateAndApplyPropertyDescriptor in their
  existing shared runtime-MOP entry points. Change only the vec receiver arm:
  obtain the current descriptor through the canonical state query, apply the
  transition once, then update value/metadata/absence atomically.
- Route gOPD, `Object.keys`, `Object.getOwnPropertyNames`, for-in,
  `hasOwnProperty`, `in`, delete, freeze and seal through that state. The
  `overlayDirty` module pre-scan may remain an optimization, but it may only
  prove that no overlay query is needed; it must not define semantics.
- After `freeze`, every present data index reads writable=false and
  configurable=false; holes remain absent. Enumeration emits each present
  canonical index once, in numeric order, and filters only by the descriptor's
  enumerable bit.

**Files: `src/ir/from-ast.ts` (`IrFromAstResolver` lines 325-333 and exact
ambient call lowering lines 6049-6097), `src/ir/select.ts` (lines 6787-6805 and
7777-7785), `src/ir/backend/legality.ts` (capability table lines 18-59),
`src/ir/integration.ts` (`objectDefinePropertyTarget` lines 4134-4137), and
`src/codegen/object-ops.ts` (`emitDefinePropertyDescRuntime` line 281)**

- IR owns only the semantic call
  `Object.defineProperty(target,key,rawDescriptor)`. It must not own vec flags,
  hole state, descriptor defaults, or lane representations.
- Rename/widen the current host-only capability to a WasmGC
  `object-define-property-runtime` capability. For the already supported
  three-argument, non-spread, exact ambient binding, integration resolves
  `env::__defineProperty_desc` on host and the allocator-owned runtime function
  `__obj_define_from_desc` on standalone after ensuring that helper exists.
- Preserve the current no-loss gate in `from-ast.ts`: select the IR call only
  when target, key, and descriptor already have an exact externref-backed
  carrier. If a standalone typed descriptor struct still needs legacy
  reification (`object-ops.ts:307-335`), selection must decline cleanly to
  legacy; do not make it externref with a lossy coercion.
- Both IR and legacy paths must converge below the call boundary on the same
  lane runtime MOP. Add shape tests proving the host target remains a symbolic
  import, the standalone target is a symbolic runtime function, and neither
  route embeds a raw function index. This IR convergence is architectural
  ownership work; claim **zero test262 gain** from it unless an A/B row flips.

`compileObjectDefineProperties` (`src/codegen/object-ops.ts:3071`) retains its
static batching and dynamic fallback for this slice. Each applied descriptor
must eventually delegate to the same single-property MOP, but widening the
plural IR surface before the single-property invariant is green would combine
two independent changes.

### Staging and removal gate

1. **S0 — characterization, no semantics:** add the four-state contract tests
   and IR shape tests. Record exact
   `81125e5e248847a5df94c3e2a3a20016782e1df4` A arms in both lanes.
2. **S1 — read-side query, gated:** implement host and standalone classifiers;
   route gOPD, hasOwn/`in`, keys/gOPN, and Get through them behind one temporary
   `vec-index-state-mop` development gate. Default remains old behavior.
3. **S2 — writer convergence:** make array construction/length growth,
   assignment, define, delete, and freeze maintain/query absence and metadata.
   Flip the gate for the candidate branch and run the targeted A/B.
4. **S3 — IR ownership:** widen exact externref-backed ambient
   `Object.defineProperty` calls to the lane-neutral symbolic runtime target;
   keep typed-descriptor reification on legacy until it has an exact carrier.
5. **S4 — audit and retire:** audit every array mutator and every shared reader,
   run the full two-lane ES5 matrix, then delete the duplicate readers and the
   temporary gate. Do not delete `definedPropertyFlags` wholesale: retain any
   compile-time facts still used outside vec-index semantics and remove only
   facts whose consumers have converged.

Removal criterion: the new path is the default only after both targeted A/B
arms and the full 9,029-file two-lane gate are green for regressions. Delete the
old path and development gate in the same landing series; do not leave two
long-term semantic implementations.

### RED tests and positive controls

Add `tests/issue-2668-vec-index-state.test.ts`, running every behavioral case
under host and `--target standalone`. The minimal mechanistic RED cases are:

1. `Object.getOwnPropertyDescriptor([7], "0")` reports value 7 and W/E/C all
   true before any sidecar exists; redefining only `value` preserves those bits.
2. After `a.length = 3`, index 1 is absent, an inherited prototype index is
   visible to Get but `a.hasOwnProperty("1")` is false, and writing `a[1]`
   clears the hole.
3. Deleting index 1 from an array returned by `Object.keys` makes
   `hasOwnProperty("1")`, `in`, gOPD, and own-key enumeration agree that it is
   absent.
4. `defineProperty(a,"0",{writable:true})` on a hole creates a present data
   property with value `undefined` which shadows an inherited index.

Add `tests/issue-2668-object-defineproperty-ir.test.ts` with host and standalone
IR-shape assertions for the exact ambient, three-argument externref-backed
call, plus negative controls for a shadowed `Object`, spread arguments, and a
standalone typed descriptor that must remain legacy.

The exact current candidate census is **0/13 pass in host and 0/13 pass in
standalone**:

```text
test/built-ins/Object/defineProperty/15.2.3.6-4-191.js
test/built-ins/Object/defineProperty/15.2.3.6-4-210.js
test/built-ins/Object/defineProperty/15.2.3.6-4-212.js
test/built-ins/Object/defineProperty/15.2.3.6-4-216.js
test/built-ins/Object/defineProperty/15.2.3.6-4-251.js
test/built-ins/Object/defineProperties/15.2.3.7-6-a-187.js
test/built-ins/Object/defineProperties/15.2.3.7-6-a-198.js
test/built-ins/Object/defineProperties/15.2.3.7-6-a-211.js
test/built-ins/Object/defineProperties/15.2.3.7-6-a-231.js
test/built-ins/Object/freeze/15.2.3.9-2-a-14.js
test/built-ins/Object/keys/15.2.3.14-5-13.js
test/built-ins/Object/keys/15.2.3.14-5-a-4.js
test/built-ins/Object/getOwnPropertyNames/15.2.3.4-4-b-6.js
```

This list is an at-risk denominator, not a promised +13. Report every remaining
non-pass and demonstrate any blocker before narrowing it. Use these already
passing files as positive semantic controls in both lanes:

```text
test/built-ins/Object/defineProperty/15.2.3.6-4-182.js
test/built-ins/Object/defineProperty/15.2.3.6-4-275.js
test/built-ins/Object/defineProperty/15.2.3.6-4-276.js
test/built-ins/Object/defineProperties/15.2.3.7-6-a-184.js
test/built-ins/Object/keys/15.2.3.14-5-3.js
test/built-ins/Object/getOwnPropertyNames/15.2.3.4-2-2.js
```

### A/B measurement and CI acceptance

1. Put the 13 candidate paths and six positive controls in a temporary list.
   Run `npx tsx scripts/harness-flip-probe.ts --self-test`, then record A at
   exact SHA `81125e5e248847a5df94c3e2a3a20016782e1df4` separately for `--target host` and
   `--target standalone`. Record B at the exact candidate SHA with the same
   dependencies, corpus, timeout, and test list. Compare only local A to local B
   with `--diff`; never diff a local sweep against the committed baseline.
2. The driver must observe its mandatory must-pass and must-fail fixtures in
   each arm. If any candidate reports `quickjs provider missing`, the arm is
   invalid rather than a compiler result. The in-process probe is status-only;
   `scripts/test262-worker.mjs` in authoritative CI owns runtime-eval provider
   setup and final classification.
3. Publish the complete partition for each lane: fail-like→pass,
   pass→fail-like, other status changes, unchanged, entered, and left; assert
   that the buckets sum to the union. Keep compile errors/timeouts distinct.
4. Targeted acceptance requires all four mechanistic RED tests in both lanes,
   no positive-control regression, and a reported 13-file denominator for each
   lane. Do not infer success from emitted IR shape or a handwritten source
   shape.
5. Before landing, run authoritative CI over the exact **9,029 landing-ES5
   files in both lanes**. Required regression gate: zero pass→non-pass and zero
   new compile error/timeout in either lane. Tests using `eval`, `Function`, or
   `with` remain in the denominator. The issue-level completion gate is stronger:
   9,029/9,029 pass in host and 9,029/9,029 pass in standalone.

### Risks and coordination

- **Shared-reader regression:** changing only defineProperty can improve gOPD
  while breaking Get, `in`, keys, delete, or freeze. Land the classifier and
  its reader matrix before retiring any per-call-site logic.
- **Presence-storage cost:** length growth must not allocate one descriptor per
  hole, retain dead vecs, or scan to uint32 max. Benchmark dense arrays and a
  large legal in-memory length; use compact weak side state/ranges.
- **Value representation:** null and explicit `undefined` are present values;
  neither may double as absence. Preserve f64/native-string fast storage and
  use `FLAG_COMPANION_VALUE` only when the overlay truly owns the data value.
- **Prototype semantics:** `ABSENT` permits inherited Get/HasProperty, whereas
  HasOwn/gOPD/own keys stop. A present value-less own property shadows the
  prototype. Test both directions.
- **IR fallback correctness:** standalone typed descriptors still require the
  legacy reification at `object-ops.ts:307-335`. An eager IR selection would
  turn valid descriptor objects into wrong-shape traps.
- **Hot files/conflicts:** `src/codegen/object-ops.ts`, `object-runtime.ts`,
  `vec-overlay.ts`, and `runtime.ts` overlap #4008, #4197, and follow-ups to
  #4222. Rebase after those changes and keep the canonical classifier in one
  owned module rather than copying its bit tests.
- **Measurement ceiling:** the 13 rows are only 13/506 current shared ES5
  non-passes and 13/567 in this family. Do not restate the withdrawn ~788/762
  headlines or credit unrelated host-only rows without measured flips.
