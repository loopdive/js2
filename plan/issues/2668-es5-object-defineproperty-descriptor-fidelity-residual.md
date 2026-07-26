---
id: 2668
title: "ES5: Object.defineProperty/defineProperties descriptor fidelity residual (~788 fails — largest ES5 cluster)"
status: in-progress
assignee: ttraenkler/sd-2668c
created: 2026-06-25
updated: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: es5
related: [1460, 1462, 929]
sprint: 67
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
