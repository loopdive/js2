---
id: 6655
title: "standalone: a dynamic call to a 9+-formal function traps `unreachable` in `__apply_closure` — the bridge's dispatcher ladder stops at arity 8 and its overflow guard is a hard trap"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone
parent: 5383
requested_by: ttraenkler/fable-lead
created: 2026-09-20
assignee: ttraenkler/senior-dev-s73
loc-budget-allow:
  # 2026-09-20 (S73, #6655) — the above-cap dispatcher path has to live in the
  # three files that already own the mechanism; there is no subsystem module to
  # push it into without splitting one mechanism across four files.
  #   closure-exports.ts (+50): `collectHighClosureMethodCallArities` (the
  #     arity set) + `publishInternalClosureMethodDispatcher` (above-cap
  #     dispatchers are internal, not host-bridge-manifest entries — the
  #     manifest is a fixed 18-bit export family) + their doc comments, which
  #     carry the measured reason the host/gc lane is gated out (+21,274 B of
  #     unreachable code).
  #   object-runtime.ts (+25): `fillApplyClosure`'s registry scan for
  #     `__call_fn_method_<N>` above 8, the ladder built over that set instead
  #     of a fixed range, and the raised overflow bound.
  #   index.ts (+10): one mint loop at each of the two dispatcher-mint sites.
  - src/codegen/closure-exports.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-20 (S73, #6655) — same change-set, same rationale. `fillApplyClosure`
  # is the function that BUILDS the ladder, so the ladder's arity set cannot be
  # computed anywhere else without another cross-file indirection; the two
  # generateModule twins grow by their one mint loop each.
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

## Problem

Three `--target standalone` Temporal rows fail with
`RuntimeError: unreachable in __apply_closure()`:

| row | trap frame |
| --- | --- |
| `test/built-ins/Temporal/PlainDateTime/from/overflow-default-constrain.js` | `at source L496 (via __apply_closure ← __module_init_chunk_2@L14 ← __module_init@L33)` |
| `test/built-ins/Temporal/PlainDateTime/from/argument-string-offset.js` | `at source L496 (via __apply_closure ← __closure_393@L31 ← __module_init_chunk_2@L30)` |
| `test/built-ins/Temporal/Duration/compare/order-of-operations.js` | `at source L964 (via __apply_closure ← __runtime_eval_call_aot ← __apply_closure)` |

The brief framed these as a callable-KIND misclassification (the #6628
provider-owned-closure residual) and as possibly two mechanisms — an
eval-path one and a module-init one. Both framings are wrong. **All three are
one mechanism and it is not about ownership at all: it is ARITY.**

## Root cause

`fillApplyClosure` (`src/codegen/object-runtime.ts`) builds the dynamic
callable dispatcher as a ladder `if n==0 … if n==8 else <peer/undefined
fallback>`, where

```
n = max(argc, __closure_arity(fn))      // #3592 under-application widening
```

and `__call_fn_method_<N>` dispatchers are minted for `N = 0..min(maxArity, 8)`
(`src/codegen/index.ts`, two sites). Immediately before the ladder sits the one
and only `unreachable` in the filled body:

```ts
declaredArity > APPLY_CLOSURE_MAX_ARITY /* 8 */  ⇒  unreachable
```

added deliberately so an above-cap closure "fails loudly rather than falling
through to the undefined sentinel".

The failing callees are ordinary **test262 harness functions whose declared
formal count exceeds eight**:

- `TemporalHelpers.assertPlainDateTime(datetime, year, month, monthCode, day,
  hour, minute, second, millisecond, microsecond, nanosecond, description,
  era, eraYear)` — **14 formals** (`test262/harness/temporalHelpers.js` L252,
  source L496 of the harness+test concatenation the trap names);
- `createDurationPropertyBagObserver(name, y, mon, w, d, h, min, s, ms, µs, ns)`
  — **11 formals** (`Duration/compare/order-of-operations.js` L173, source
  L964).

Each is invoked through the dynamic bridge (a spread argument list in the
first two, the #6647 live-global-binding route via `__runtime_eval_call_aot`
in the third), the widening lifts `n` to 14 / 11, no arm exists, and the
overflow guard traps. The `__runtime_eval_call_aot` frame in the Duration row
is the CALLER of `__apply_closure`, not a second defect.

**Confirmed by direct instrumentation, not by inspection.** Replacing that one
`unreachable` with the undefined sentinel (`ref.null.extern` + `return`) and
re-running the three rows moved all three off the trap — the two PlainDateTime
rows to `pass` (vacuously: the assert never ran) and the Duration row to
`TypeError: expected a string, not null`. Nothing else in the module can
produce that trap: `fillApplyClosure`'s emitted body contains exactly one
`unreachable`.

## Fix

Support the arities a module actually declares instead of raising a constant.

1. `collectHighClosureMethodCallArities(ctx, floor)`
   (`src/codegen/closure-exports.ts`) — the DISTINCT `closureHostArity` values
   above `floor`. A set, not a range: the contiguous `0..8` loop is untouched
   and only the arities a module really has are minted above it.
2. `src/codegen/index.ts`, both dispatcher-mint sites (single-source
   finalize + multi-source twin): mint one `__call_fn_method_<N>` per
   above-cap arity, after the existing `0..cap` loop and before
   `fillApplyClosure` runs.
3. `emitClosureMethodCallExportN` publishes an above-cap dispatcher as an
   ORDINARY INTERNAL function (`mintDefinedFunc`/`pushDefinedFunc`), not
   through `publishClosureHostBridge`. The closure host-bridge manifest is a
   fixed 18-bit physical export family (`closureHostBridgeDefinition`) with
   slots for method arities 0..8 only; an above-cap dispatcher has no host
   caller — it exists solely as a `call` target for the in-module ladder — so
   widening the published ABI would be wrong as well as impossible. Without
   this the compile dies with `unknown closure host bridge
   __call_fn_method_14`.
4. `fillApplyClosure` reads the registry (`__call_fn_method_<N>` keys in
   `ctx.funcMap`) for above-cap arities, appends one ladder arm per registered
   arity, and raises the overflow guard's bound to the top minted arity.

**Byte-inertness is structural, not incidental**: a module with no closure
above eight mints nothing extra, so the registry scan finds nothing, the
ladder is the same nine arms, and the guard constant is still 8. Measured on
the unlinked probe (`.tmp/s73/probes/arity3.mts`): the two arity-8 cases are
byte-identical base vs fix (143,416 B / 143,017 B); the arity-14 cases grow
~1.5 KB for the one extra dispatcher.

## Acceptance

- The three rows above stop trapping and the assertions actually run.
- `tests/issue-6655-standalone-apply-closure-high-arity.test.ts` fails on the
  true base and passes on the fix.
- Battery: 0 pass→fail across the 13 must-not-move groups + AddSub.

## Residuals (measured, not fixed)

- `H.m.apply(H, ARR12)` where `m` has 14 formals fails to COMPILE — the
  #2090 stack-balance gate reports an operand underflow of 14 in the caller.
  Identical on the true base (`.tmp/s73/probes/arity3.mts`, case `apply14`),
  so it is pre-existing and independent of this issue; a `Function.prototype.
  apply` call site emits a dispatcher call whose operand count does not match
  the dispatcher's formals.
- `hide(v).m(0, ...DATA, "d")` (12 actual args into 14 formals through an
  "any"-typed receiver) answers `0/d` — the trailing argument lands in the
  LAST formal rather than the 12th. Identical base and fix
  (`.tmp/s73/probes/arity4.mts`, case `anyRecv14`); an argument-placement
  defect on the open-receiver route, not an arity-ladder one.
