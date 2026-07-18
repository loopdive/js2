---
id: 3015
title: "Standalone: array predicate methods route an opaque-externref (dynamic function-typed param) callback to the __call_1_f64 host bridge instead of native call_ref"
status: ready
sprint: Backlog
created: 2026-07-03
updated: 2026-07-03
priority: low
feasibility: medium
task_type: feature
area: codegen
language_feature: closures, array-methods
goal: standalone-mode
related: [1851, 1852, 2939]
origin: "2026-07-03 leak-analysis round-6 §5 (__call_1_f64, 6 GENUINE sole-import passes) — measured down to the exact trigger, correcting the round-6 'routing artifact' framing"
---

# #3015 — array-method callback that is an opaque externref leaks `__call_1_f64`

## Problem

In standalone (host-free) mode, `Array.prototype` predicate methods
(`some`/`every`/`forEach`/`find`/`filter`/`map`/`reduce`/…) emit the
`env::__call_1_f64` (or `__call_1_i32` in fast mode) **host callback bridge**
when the callback argument evaluates to an **opaque `externref`**. This is one
of the round-6 GENUINE sole-import levers (6 official passes route through it).

Round-6 (`plan/log/investigations/2026-07-03-leak-analysis-round6.md` §5)
framed this as a routing artifact ("native methods exist; the import name is a
routing artifact"). **A measure-first pass on current `main` corrects that**:
it is not a mislabeled import — the callback genuinely has no callable
closure/funcref type available at the array-method call site.

## Measured trigger (standalone, current main)

Reproduced by compiling with `target: "standalone"` and inspecting emitted
`env::` imports:

| callback shape                                                              | result                   |
| --------------------------------------------------------------------------- | ------------------------ |
| inline arrow `arr.some(x => …)`                                             | **native** (call_ref)    |
| named top-level fn `arr.some(isEven)`                                       | **native** (call_ref)    |
| typed-array `new Uint8ClampedArray(...).some(isEven)`                       | **native** (call_ref)    |
| **dynamic function-typed param** `function run(cb){ return arr.some(cb); }` | **LEAKS `__call_1_f64`** |

The direct-call and manual-`for`-loop forms of the _same_ param callback
(`cb(3)`, `for (…) if (cb(a[i])) …`) also compile to **native call_ref** — so
the capability exists; only the array-method value-argument path misses it.

### Root cause

`setupArrayCallback` (`src/codegen/array-methods.ts:5999-6052`) evaluates a
non-inline callback via `compileExpression(cbArg)`. For a function-typed
_parameter_, that yields `cbResult.kind === "externref"` — an **opaque
externref**, with no `closureTypeIdx`. So:

```
// array-methods.ts:6018-6038 (instrumented)
if (cbResult.kind === "ref" | "ref_null") { closureTypeIdx = …; closureInfo = closureInfoByTypeIdx.get(…) }
// cbResult is externref → branch skipped → closureInfo undefined
if (!closureInfo) { bridge = ctx.fast ? "__call_1_i32" : "__call_1_f64"; … }  // host bridge
```

With no closure struct type there is no `funcTypeIdx` to `call_ref`, so the code
falls to the host bridge. In **call position** the compiler recovers a typed
call from the same param (via the callee's TS signature), but in
**value-argument position** the function value is coerced to the generic opaque
`externref` representation — the function-value-representation gap this issue
sits on (see #1851 / #1852).

## Approach (design — not yet implemented)

The array-method callback path must obtain a callable closure/funcref for a
callback that arrives as an opaque `externref`. Two candidate directions:

1. **Preserve the closure struct through argument evaluation.** Compile the
   callback argument in a mode that keeps the closure struct type (as the
   call-position lowering does) rather than coercing to `externref`, so
   `closureInfoByTypeIdx.get(closureTypeIdx)` resolves and the existing
   native `call_ref` path (`setupArrayCallback` → per-method invocation sites)
   is taken unchanged. Lowest-risk if the closure struct is actually available
   for the param — needs verifying how the param's local ValType is registered.
2. **Synthesize a `call_ref` from the callback's TS call signature.** When
   `cbResult` is `externref` and `ctx.checker.getTypeAtLocation(cbArg)` yields a
   single call signature, build/lookup a `funcTypeIdx` for that signature,
   extract a funcref from the externref closure value, coerce the per-element
   arg to the signature's param type, and `call_ref`. Mirrors the existing
   `closureInfo` invocation but sourced from the TS type rather than a
   registered closure. Requires a reliable externref→funcref recovery for
   dynamic function values (the substrate-adjacent part).

Either way the change lands in `src/codegen/array-methods.ts` and touches the
~7 per-method invocation sites that today branch on `closureInfo` vs
`callBridgeIdx`. Prefer factoring a single "invoke dynamic callback" helper both
paths call, so the per-method sites stay uniform.

## Risk / why deferred

- **Hot, broadly-exercised path.** Every array callback method routes through
  `setupArrayCallback`; a mistake in the invocation lowering (arg coercion,
  return-type handling, void callbacks, thisArg threading, reduce's
  accumulator arity) regresses a large test262 surface. Must validate IN BATCH
  - `runTest262File`, not scoped checks — no local test262 for a dev agent.
- **Function-value-representation-adjacent (#1851/#1852).** Direction 2 depends
  on recovering a callable from an opaque externref, which is the general
  function-value-rep question; scope this issue to the array-method path and
  lean on Direction 1 first if the closure struct is recoverable.

## Acceptance criteria

- `function run(cb: (x: number) => boolean) { const a = [1,2,3]; return a.some(cb); }`
  compiled `target: "standalone"` emits **no** `env::__call_1_*` import and
  invokes `cb` via native `call_ref`.
- Same for `forEach`/`every`/`find`/`filter`/`map`/`reduce` with a dynamic
  function-typed param callback.
- Byte-neutral for the already-native cases (inline arrow, named fn, typed
  array). No test262 regression (validate IN BATCH + `runTest262File`).
- The round-6 `__call_1_f64` sole-lever (6 official passes) converts to
  host-free.

## Key sites

- `src/codegen/array-methods.ts`: `setupArrayCallback` (:5999-6052; the
  `closureInfo` vs `callBridgeIdx` fork at :6018-6038), and the per-method
  `call_ref` invocation blocks (e.g. :951-1006, :1467-1520, :1625+).
- `src/codegen/array-methods.ts:6030` — the `__call_1_i32`/`__call_1_f64`
  bridge selection.
- Closure invocation infra: `src/codegen/closures.ts`
  (`computeClosureWrapperSig` :1436, `emitFuncRefAsClosure` :3522,
  `emitCachedFuncClosureAccess` :4358) and `ClosureInfo`
  (`src/codegen/context/types.ts:208`).

## Related

- #1851 — per-backend legalization boundary / value conversion.
- #1852 — per-backend value representation (function values).
- #2939 — any-callable scalar-param dispatch (adjacent callback-dispatch work).
