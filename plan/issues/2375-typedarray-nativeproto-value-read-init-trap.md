---
id: 2375
title: "standalone: TypedArray/ArrayBuffer/DataView.prototype value-read cluster is gated on builtin-ctor reflection in the test262 harness, not the $NativeProto glue"
status: blocked
needs_role: architect
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: max
task_type: investigation
area: codegen
language_feature: builtins, reflection, typedarray
goal: standalone-mode
related: [2374, 2376, 2377, 2378, 2193, 2175, 1907, 1888, 2026]
origin: "2026-06-19 — measure-first probe while extending #2374 value-read glue to the TypedArray family; root-caused 2026-06-19 spec-first deep-dive"
---

## RE-GROUND vs current main 218375d60 (2026-06-19, after #2026 classes-as-first-class-values landed)

The #2026 substrate (uniform constructor ABI / classes as first-class values)
**did move the needle on the init-trap, but NOT on the conformance gate**. Wiring
the full TypedArray + ArrayBuffer/SharedArrayBuffer/DataView `$NativeProto`
value-read glue and re-measuring base-vs-patched on 400 TypedArray/DataView/
ArrayBuffer prototype tests (`--target standalone`):

| transition | count | meaning |
|---|---|---|
| pass → CE / pass → fail (regressions) | **0** | glue is clean, no regressions |
| CE → **pass** | **0** | **zero real conformance wins** |
| CE → fail / CE → runtime-exception | ~129 | CE removed, but test now FAILS at runtime |
| CE → CE (still) | 26 | reflective member-body `.call` path, untouched |

**Substrate effect (the one real change):** the pre-#2026 *instantiate-trap*
(`wasm exception during module init`, from the unsatisfiable `[Float64Array,…]`
host-import reflection in `testTypedArray.js` module scope) is GONE — those files
now compile and run. The `forEach/*` harness cluster flipped CE→pass-compile.

**But the conformance gate is unchanged:** the value-read glue alone flips **0
tests to pass**. It only converts a clean, honest `compile_error` ("…value read
is not supported") into a runtime `fail`. Even the 37 CE-base files that read a
*static* concrete-view proto (`Int8Array.prototype.<m>`, no harness var) all land
at fail/CE — never pass — because every such test then either (a) invokes the
member (`.at()`, `byteLength`/`byteOffset` getters) whose native body isn't wired,
or (b) does descriptor reflection (`verifyProperty(TypedArray.prototype,…)`) on
the dynamically-obtained `%TypedArray%` proto. 118/155 CE-base files reach the
proto via `Object.getPrototypeOf(Int8Array)` (the harness `TypedArray` var) — a
**dynamic runtime** path the static value-read glue does not satisfy.

**Decision: do NOT ship the value-read-only glue.** It is net-zero-or-negative
(0 pass, CE→fail is *less* honest than CE). Confirmed the issue's original
"flips 0 and just unmasks the trap" classification — only now it unmasks to
`fail` instead of an init-trap. The glue itself is correct/clean and tsc-green;
it is staged in this investigation only, not committed.

### What IS now architect/runtime-scale (the real remaining gate)
1. **Member bodies** for `%TypedArray%.prototype.<method>` (`at`, `map`, `slice`,
   the index getters, `byteLength`/`byteOffset`/`length` accessor getters) as
   native closures, so a reflected proto member is callable — same shape as the
   #2374/#2377 *member-body* (PR-C) follow-ons, but over the live view receiver.
2. **Dynamic `Object.getPrototypeOf(<builtin ctor>)` → working `%TypedArray%`
   proto object** whose members resolve at runtime (not just a static
   `Int8Array.prototype` identifier read). This is the harness's actual reflection
   path and is the dominant gate (118/155 files).

Route to architect: spec (1)+(2) as the TypedArray member-reflection runtime
slice. The value-read object scaffold is ready to fold in once those land.
Keep `status: blocked`, `needs_role: architect`.

---

## PINNED ROOT CAUSE (2026-06-19 spec-first deep-dive — corrects the original hypothesis)

The original hypothesis below ("the `$NativeProto` materialization for a
concrete-view brand traps at instantiate") is **WRONG**. Isolation proves the
materialization is CLEAN; the trap is elsewhere:

| probe (`--target standalone`) | result |
|---|---|
| `const m: any = Int8Array.prototype; return m ? 1 : 0` (bare value-read, glue wired) | **INSTANTIATES OK** → 1 |
| full `findLastIndex/this-is-not-object.js` (glue wired) | `wasm exception during module init` |

The full TypedArray tests almost all carry `includes: [testTypedArray.js]`,
whose **module-scope** code is the real trap:

```js
var floatArrayConstructors = [Float64Array, Float32Array];   // builtin ctors as values
var TypedArray = Object.getPrototypeOf(Int8Array);            // getPrototypeOf on a builtin ctor
```

Isolation confirms `[Float64Array, Float32Array]` and
`Object.getPrototypeOf(Int8Array)` each independently emit unsatisfiable `env`
host imports under `--target standalone` → instantiate trap. The bare
proto-value-read alone is clean.

**Before the value-read glue this was MASKED**: the
`Int8Array.prototype ... value read is not supported` compile_error stopped
compilation before the harness reflection ran. The glue removes the mask.

### Classification: ARCHITECT-SCALE, not a contained fix

Wiring the TypedArray proto value-read glue flips **0 / 40** sampled tests — the
cluster is gated on the harness's `Object.getPrototypeOf(<builtin ctor>)` +
builtin-ctor-as-value reflection, NOT on the value read. The real blocker is a
separate, broad standalone-reflection gap:
1. `Object.getPrototypeOf(<builtin constructor>)` host-free (return the
   `%TypedArray%` / `Function.prototype` intrinsic).
2. builtin constructor used as a first-class value (`[Float64Array, ...]`) —
   relates to the #2026 classes-as-values / dynamic-new ctor ABI.

Both are runtime/representation-scale → the rail's "do NOT force a guard that
papers over a runtime-state bug" case. Same for ArrayBuffer/SharedArrayBuffer/
DataView (they include `testTypedArray.js`/`testBigIntTypedArray.js` too).

### Recommendation

- The TypedArray/ArrayBuffer/DataView **value-read glue is correct + clean**
  (parity with String/Date/Error/Map/Set), but wire it only **after** the
  harness-reflection gap closes — else it flips 0 and just unmasks the trap.
- Route to **architect**: spec the standalone `Object.getPrototypeOf(builtin)` +
  builtin-ctor-as-value path (likely folds into #2026). Once that lands, the
  TypedArray value-read glue is the same additive ~36+ flip slice as the other
  brands.

---

## Problem (original hypothesis — superseded by the pinned root cause above)

Extending the #2374 `$NativeProto` value-read glue to the TypedArray family
(`%TypedArray%` + the concrete views `Int8Array`…`Float64Array`,
`BigInt64Array`/`BigUint64Array`) — the obvious next slice, since the brands
are pre-reserved in `native-proto.ts` `BUILTIN_BRAND_TABLE` (BASE+3..14) and
`property-access.ts` even comments "S3 adds %TypedArray% / the concrete views"
— does **NOT** behave like the String/Number/Boolean wrapper protos.

Registering `ensureTypedArrayNativeProtoGlue` (mirroring
`ensureArrayNativeProtoGlue`) and wiring it into `tryEnsureNativeProtoBrand`
compiles cleanly (tsc 0), but **measured 1/506 flips** on the
`built-ins/TypedArray/prototype` host-pass/standalone-CE set, and worse:

It turns the static-read compile-error into a **`wasm exception during module
init`** — i.e. the module now *compiles* but **traps at instantiation**.

Verified base-vs-patched on
`built-ins/TypedArray/prototype/findLastIndex/this-is-not-object.js`:

| build | result |
|-------|--------|
| base (upstream/main) | `compile_error`: `Int8Array.prototype built-in static property value read is not supported (#1907 / #1888 S6-b)` |
| + TypedArray glue | `fail`: **wasm exception during module init** |

So the `$NativeProto` materialization (`emitLazyNativeProtoGet`) for a
concrete-view brand produces an init-trapping module — a latent defect in the
existing TypedArray brand / object-runtime interaction, NOT a clean additive
value-read win. The String/Number/Boolean protos (#2374) flip 72 with 0
regressions; the TypedArray protos do not, because something in the
concrete-view brand path (likely the interaction with the existing TypedArray
runtime registration / vec-type machinery, or the `$NativeProto` init order vs
the view-brand init) faults at instantiate.

## Why this is filed separately (not folded into #2374)

#2374 stays narrow + clean (wrapper protos only, measured + byte-identical).
The TypedArray family needs the init-trap root-caused first — it is a real
blocker for the TypedArray value-read cluster (~506 host-pass/standalone-CE,
of which ~38/60 sampled are the `Int8Array.prototype` static-read refusal),
but it is hard, not a clean additive slice.

## Repro

```bash
# In a worktree with the TypedArray glue applied (ensureTypedArrayNativeProtoGlue
# + TYPEDARRAY_BUILTIN_NAMES wired into tryEnsureNativeProtoBrand):
npx tsx -e "
import { runTest262File } from './tests/test262-runner.ts';
const r = await runTest262File(
  'test262/test/built-ins/TypedArray/prototype/findLastIndex/this-is-not-object.js',
  'built-ins/TypedArray', 15000, 'standalone');
console.log(r.status, r.reason);  // => fail :: wasm exception during module init
"
```

## Investigation pointers

- `emitLazyNativeProtoGet` (native-proto.ts) builds the `$NativeProto` struct
  for a brand; for the TypedArray concrete-view brands it apparently emits
  init code that traps. Compare the emitted init sequence for a wrapper-proto
  brand (works) vs a concrete-view brand (traps) — likely a type-index or
  global-init ordering issue specific to the view brands.
- The concrete-view brands also drive the existing TypedArray runtime (vec
  types, `$__subview` #2357/#47); the `$NativeProto` value-read path may
  collide with that registration.
- Once root-caused, the value-read cluster (~506) should flip much like
  #2374's 72 — but only after the init-trap is resolved.
