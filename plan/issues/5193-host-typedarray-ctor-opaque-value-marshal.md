---
id: 5193
title: Compiled value handed to host Float64Array constructor has no marshalling path — blocks Temporal polyfill module init
status: done
sprint: current
priority: high
horizon: m
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/opus-dev-5193
created: 2026-08-29
completed: 2026-08-29
# Four small, deliberate growths. Each lands where the mechanism it belongs to
# already lives; the bulk of the new code went into two NEW subsystem modules
# (src/runtime/init-marshal-registry.ts, src/codegen/init-marshal-helpers.ts).
#  - runtime.ts (+23): the `__register_init_export` import handler must be in the
#    import-resolution switch, and three marshal call sites swap one expression.
#  - codegen/index.ts (+10): one import + one call in each of the two finalize
#    pipelines, at a placement contract that is only expressible there.
#  - codegen/context/types.ts (+6): one documented `needsInitMarshalHelpers` flag.
#  - expressions/new-super.ts (+6): the one line that sets it, plus its rationale.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/new-super.ts
# Both are dispatch/sequence functions whose growth IS the new arm/step:
#  - resolveImport (+15): one more `if (name === …)` import handler; splitting
#    the switch is out of scope for a bug fix.
#  - generateModule (+7): one call + its placement-contract comment, and the
#    placement is the whole point (see init-marshal-helpers.ts header).
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::generateModule
---

# #5193 — host TypedArray constructor cannot accept an opaque compiled value

## Problem

With the #5191 fix applied (builtin-derived classes get their class-object
singleton), the `@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0` linked ESM bundle
advances past jsbi's statement 2 during module init and now stops at:

```
TypeError: cannot marshal opaque compiled value to host Float64Array constructor
```

`moduleInitRuns` stays `false`, so the module still yields no exports, and
#4628 Option A (Temporal as a real runtime global) remains gated on this.

## Repro

On a tree containing both the #5191 fix (PR #5242) and the instrumented
harness (PR #5239):

```
node --import tsx tests/dogfood/temporal-polyfill-harness.mjs
```

esm linked lane → `moduleInitError: TypeError: cannot marshal opaque compiled
value to host Float64Array constructor`.

A reduced repro should be extracted first (the polyfill/jsbi init passes a
compiled (WasmGC-backed) value — likely an array or ArrayBuffer produced by
compiled code — to the host `Float64Array` constructor import). Expect the
shape to be roughly:

```js
const src = [1.5, 2.5];        // compiled-side value
const f = new Float64Array(src); // host ctor receives an opaque ref
```

## Direction

The host-lane TypedArray constructor import needs a marshalling path for
compiled-side values (iterable/array-like → host copy), or the constructor
call needs to detect a compiled receiver argument and route through a
compiled-side construction instead. Decide with evidence; keep the standalone
lane's behavior unchanged (this failure is in the host lane's imports).

## Acceptance criteria

1. Reduced repro compiles and runs correctly on the host lane (values
   readable back, `.length` correct).
2. The Temporal harness advances: module init gets past this error. If a new
   later blocker appears, file it (don't fix here) and record it.
3. If `moduleInitRuns` flips to `true`, say so loudly — that un-gates #4628's
   integration step.
4. No regressions in scoped TypedArray tests (name the files run).

## Fix

### Root cause: a TIMING window, not a missing marshaller

The reduced repro says it in one line — the SAME expression passes inside a
function and fails at module scope:

| where `new Float64Array(new ArrayBuffer(8))` sits | base    |
| ------------------------------------------------- | ------- |
| inside an exported function                       | works   |
| at module top level                               | THROWS  |
| in a top-level object literal / class static      | THROWS  |

In the JS-host lane top-level code runs via the wasm `start` section, i.e.
DURING `WebAssembly.instantiate`. The host cannot call `setInstance` until that
returns, so `callbackState.getExports()` is `undefined` for the **whole** of
module init. Every probe the runtime decodes a compiled value with —
`__vec_len`, `__vec_get`, `__is_vec`, `__dv_byte_len`, `__dv_byte_get`,
`__ab_max_len` — is an **export**. During init they are all unreachable, so
`_compiledAbToHostBuffer` returned `undefined`, `_materializeIterable` returned
the raw struct, and `_marshalHostConstructArg` fell through to its #3335 loud
refusal on a perfectly ordinary buffer.

That is the same family as #2796 (`for…in` over a struct at top level
enumerates zero keys) and #2800 (`__in_module_init`) — both worked around the
window rather than closing it.

The call shape in jsbi is exactly the minimal repro:

```js
JSBI.__kBitConversionBuffer = new ArrayBuffer(8);
JSBI.__kBitConversionDouble = new Float64Array(JSBI.__kBitConversionBuffer);
JSBI.__kBitConversionInts   = new Int32Array(JSBI.__kBitConversionBuffer);
```

### Decision: the module hands the runtime its own helpers, as funcrefs

Three options were on the table:

1. **Copy the buffer bytes compiled-side** into a host ArrayBuffer at the
   construct site. Rejected: needs ~4 new imports plus a synthesized byte-copy
   loop, must re-implement the `_abHostBufferCache` identity rule so sibling
   views alias, and must special-case resizable/detached buffers. More surface,
   same result.
2. **Pre-register the buffer at `new ArrayBuffer(n)`** with a zero-filled host
   twin. Rejected on correctness: it silently loses any bytes compiled code
   wrote before the marshal.
3. **Close the window** — chosen.

`ref.func` values passed to a JS import materialize as JS function objects, and
measurably as the *identical* object the export later yields (probe:
`received === instance.exports.f`, Node/V8). So the module registers its own
marshalling helpers with the host at the top of `__module_init`, via one new
import `__register_init_export(id: i32, fn: funcref)`. This is a pure timing
shim: the runtime gets the same callables, just earlier. Ids rather than names
because a name would need a string-constant import global, which cannot be
added at the late codegen point where the prologue is emitted.

Deliberately kept **out of `getExports()`**: the runtime has many
`getExports() !== undefined` branches that mean "post-instantiation", and
flipping those during init would be a broad, unrelated behaviour change. Only
the three marshalling paths consult the new `getStartExports()`.

The standalone/WASI lane is untouched — it has no start-section marshalling
(init runs from `_start` with exports already wired), and the emitter bails on
`ctx.wasi || noJsHost(ctx)`.

### Files

- `src/runtime/init-marshal-registry.ts` (new) — the id↔name wire ABI and
  `marshalExports()`, the "exports usable for marshalling right now" resolver.
- `src/codegen/init-marshal-helpers.ts` (new) — emits the registration
  prologue. Placement contract in its header: after the vec/DataView/resizable
  export emitters (so the helper functions exist), before dead-import
  elimination (so the added import is seen as live), before the #1984 index
  freeze (so `ensureLateImport` is legal).
- `src/runtime/instance-lifecycle-adapter.ts` — `getStartExports` /
  `registerStartExport` on the callback state.
- `src/runtime.ts` — the `__register_init_export` import handler; three marshal
  call sites resolve through `marshalExports`.
- `src/codegen/index.ts` — one call in each finalize pipeline.
- `src/codegen/expressions/new-super.ts` — sets `ctx.needsInitMarshalHelpers`.

Emission is gated on that flag, set only by `emitHostTaBufferConstruct`, so a
module that never takes the host TypedArray construct bridge is **byte-identical**.

**Known scope limit (deliberate):** the flag is set by the host-TA bridge only.
Other compiled→host marshals during module init (a host call whose argument is
a compiled array, say) still see the empty registry and behave as before. The
mechanism generalises — widening is one extra `ctx.needsInitMarshalHelpers = true`
at the producer site — but widening it speculatively would change the bytes of
every host-lane module with no measured need.

## Validation

- `tests/issue-5193-init-marshal-host-typedarray.test.ts` — 5 cases. On base
  4 fail with the exact TypeError; the 5th (same construct inside a function)
  passes on base by design, so the file also pins the boundary. All 5 pass with
  the fix. The alias case asserts `Int32Array[1] === 0x3ff80000` after writing
  `1.5` through the Float64Array — jsbi's actual bit-conversion idiom, i.e.
  proof the two module-scope views share bytes rather than each getting a copy.
- Scoped TypedArray regression run, all A/B'd against base:
  `tests/typed-array-basic.test.ts` (11 fail on base AND with the fix —
  pre-existing `string_constants` import failure, unrelated),
  `issue-1787-packed-typedarray-semantics`, `issue-2593-typedarray-intwidth`,
  `issue-2648-typedarray-search-packed-elem`,
  `issue-2934-typedarray-packed-iterator-get`,
  `issue-4383-uuid-typed-array-identity`, `issue-1670-atomics-typedarray-cast`,
  `issue-3239-standalone-subclass-typedarray-native-ctor` — all pass.
  `tests/issue-3097.test.ts` + `tests/issue-3058-dyn-view-proto-methods.test.ts`
  have 4 failures that are **identical on base** (verified by reverting the
  five touched files and re-running).
  `tests/equivalence/ir-slice10-arraybuffer-dataview`,
  `ir-slice10-typed-array`, `array-prototype-methods`, `array-of-structs` pass.

## Temporal harness outcome

`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs`, esm linked lane:

| lane           | base                                                        | with fix                                  |
| -------------- | ----------------------------------------------------------- | ----------------------------------------- |
| compile        | success, 0 errors                                            | success, 0 errors                         |
| validate       | OK                                                           | OK                                        |
| instantiate    | `cannot marshal opaque compiled value to host Float64Array…` | `TypeError: __clzmsd is not a function`   |
| moduleInitRuns | false                                                        | **still false** — a NEW, LATER blocker    |

This issue's error is gone and module init advances past jsbi's
`__kBitConversionBuffer`. `moduleInitRuns` has **not** flipped to true, so
#4628's integration step stays gated on the next blocker below.

### Next blocker (filed separately — NOT fixed here)

`TypeError: __clzmsd is not a function`, thrown from `src/runtime.ts`'s
`__proto_method_call` arm (`throw new TypeError(methodName + " is not a
function")`). jsbi declares `__clzmsd()` as an **instance method of
`class JSBI extends Array`** and calls it as `_.__clzmsd()`. Codegen lowered
that call to `Array.prototype.__clzmsd.call(receiver)` — dispatching a
USER-DEFINED method of a builtin-derived class as if it were a built-in
`Array.prototype` method, which of course does not exist. Same #5191 family
(builtin-derived classes). A one-line probe of the obvious shape
(`class J extends Array { clzmsd() {…} }`, called at init and in a function)
does **not** reproduce, so the trigger is narrower than "method on an
Array-derived class" and needs a real reduction pass.

Id allocation for that issue could not be done from this lane:
`node scripts/claim-issue.mjs --allocate --by ttraenkler/opus-dev-5193` exits
**6** (`open-PR id scan FAILED … gh offline/unauthenticated`), and
`--allow-unscanned` was explicitly withheld. Reported to the coordinator for
allocation.

## Notes

- Found by dev-5191 while validating PR #5242 (see its "Temporal harness"
  section for the A/B).
- Id #5193 reserved with a degraded PR scan (gh offline); manually verified
  against all 19 open PR head branches on 2026-08-29 — none carries a 5193
  issue file. The `check:issue-ids:against-main` gate arbitrates.
