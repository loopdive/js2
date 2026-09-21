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
  #   closure-exports.ts (+62): `topHighClosureMethodCallArity` +
  #     `publishInternalClosureMethodDispatcher` (above-cap dispatchers are
  #     internal, not host-bridge-manifest entries — the manifest is a fixed
  #     18-bit export family) + the `minHostArity` filter, plus the doc
  #     comments carrying the measured reasons: the host/gc lane is gated out
  #     (+21,274 B of unreachable code) and per-arity minting blew the
  #     runner's compile budget (39.5 s vs a 30 s limit).
  #   object-runtime.ts (+52): `fillApplyClosure`'s registry scan for the top
  #     `__call_fn_method_<N>`, the above-cap range arm, and the write-up of
  #     why the arity-overflow trap is retired (a FOREIGN closure's arity read
  #     through the canonical wrapper root was what tripped it).
  #   index.ts (+12): one mint at each of the two dispatcher-mint sites.
  - src/codegen/closure-exports.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-20 (S73, #6655) — same change-set, same rationale. `fillApplyClosure`
  # is the function that BUILDS the ladder, so the above-cap arm cannot be
  # assembled anywhere else without another cross-file indirection; the two
  # generateModule twins grow by their one mint each.
  - src/codegen/object-runtime.ts::fillApplyClosure
  # `emitClosureMethodCallExportN` (+8): the `minHostArity` filter and the
  # internal-vs-host-bridge publish branch, both inside the one function that
  # builds a dispatcher.
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
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

## Root cause — TWO arity ceilings, in two different modules

`fillApplyClosure` (`src/codegen/object-runtime.ts`) builds the dynamic
callable dispatcher as a ladder `if n==0 … if n==8 else <peer/undefined
fallback>`, where

```
n = max(argc, __closure_arity(fn))      // #3592 under-application widening
```

and `__call_fn_method_<N>` dispatchers were minted for `N = 0..min(maxArity, 8)`
(`src/codegen/index.ts`, two sites). Immediately before the ladder sits the one
and only `unreachable` in the filled body:

```ts
declaredArity > APPLY_CLOSURE_MAX_ARITY /* 8 */  ⇒  unreachable
```

added deliberately (#1058) so an above-cap closure "fails loudly rather than
falling through to the undefined sentinel".

**Ceiling 1 — the caller's own ladder (FIXED here).** A dynamic call to a
function with more than eight declared formals matches no arm and hits that
trap. Reduced to a provider-free, link-free probe
(`.tmp/s73/probes/arity4.mts`, case `namedSpread14`): a spread argument list
into a 14-formal object-literal method answers `TRAP unreachable` on the branch
base and `0/u` on the fix. This is the test262 harness's own shape —
`TemporalHelpers.assertPlainDateTime(dt, ...tenValues, "description")`, 14
formals — so the class is real well beyond Temporal, and it is what this issue
fixes.

**Ceiling 2 — the linked PROVIDER's ladder (NOT fixed; the real blocker for
the three briefed rows).** In the linked Temporal rows the consumer's ladder is
never even consulted. Proven, not inferred: a build whose above-cap arm is a
bare `unreachable`, guarded only by `n > 8` and with the caller's overflow trap
removed, does **not** trap on those rows. So `__apply_closure` returns before
reaching the ladder — through one of its prepended front guards, and the only
one that claims an ordinary compiled closure is the **#6420 peer-callable-kind
guard**: it asks the linked provider "is this externref callable?", and under
`canonicalRuntimeTypes` the provider's structural `__is_callable` answers YES
for a closure it has never seen (#6628's ownership ambiguity, still open). The
call is therefore shipped to the PROVIDER's `__apply_closure` — whose own
ladder tops out at 8, because `@js-temporal/polyfill` declares no 9+-formal
closure — and the provider's copy of the same trap fires.

Three observations that only this explanation fits:

1. the trap is `unreachable in __apply_closure()` and that body contains
   exactly one `unreachable`;
2. replacing that `unreachable` with the undefined sentinel clears the trap on
   all three rows — it changes BOTH modules, because both are built by this
   compiler;
3. with the caller's ladder covering arity 14 (instrumented: `top=14`,
   dispatcher entries `[12,14]`) and its arm made unreachable, nothing traps —
   the caller's ladder is not on the path.

## Fix

**1. One above-cap dispatcher per module.**

- `topHighClosureMethodCallArity(ctx, floor)`
  (`src/codegen/closure-exports.ts`) — the module's highest `closureHostArity`
  above `floor`, or `undefined`. ONE dispatcher covers every above-cap arity:
  `emitClosureMethodCallExportN(N)` admits every closure of host arity `<= N`
  and invokes each through its own funcref type with exactly that many of the
  supplied values, so `__call_fn_method_<top>` serves a 12-formal callee as
  correctly as a 14-formal one. Minting per-arity was measurably wasteful —
  the `argument-string-offset.js` consumer declares 12 AND 14, and two full
  ladders pushed its compile from ~25 s to 39.5 s, past the runner's 30 s
  budget, turning the fix into a `compilation timeout`.
- The above-cap dispatcher carries ONLY the above-cap closures and **no**
  native-prototype receivers (`minHostArity`, a new optional parameter that is
  `0` and therefore inert for every ordinary dispatcher). Measured 181
  native-proto arms at arity 14 on a Temporal consumer, all of them claimed by
  their own front guard long before this arm is reachable.
- It is published as an ORDINARY INTERNAL function
  (`mintDefinedFunc`/`pushDefinedFunc`), not through
  `publishClosureHostBridge`. The closure host-bridge manifest is a fixed
  18-bit physical export family (`closureHostBridgeDefinition`) with slots for
  method arities 0..8 only, and an above-cap dispatcher has no host caller —
  it exists solely as a `call` target for the in-module ladder. Without this
  the compile dies with `unknown closure host bridge __call_fn_method_14`.
- Minted only when `ctx.applyClosureReserved` is true, i.e. on the
  standalone/wasi lanes that reserve the bridge. On host/gc it would be
  unreachable bytes: measured **+21,274 B** on the `@js-temporal/polyfill`
  host provider (1,726,098 → 1,747,372) before the gate was added.
- `fillApplyClosure` reads the registry (`__call_fn_method_<N>` keys in
  `ctx.funcMap`) for the top above-cap arity and adds ONE arm, guarded by
  `n > 8` with no upper bound.

**2. The overflow trap stays, with its bound raised to the top minted arity.**

Retiring it was tried and REJECTED on evidence. With it gone the three Temporal
rows flip to `pass` — **vacuously**: a shadow copy of
`overflow-default-constrain.js` with a deliberately wrong expected day (31 → 30,
`.tmp/s73/probes/shadow-run.mts`) passes too, i.e. `assertPlainDateTime` is
never entered and the assertions never run. Trading a loud trap for a silent
wrong answer would inflate conformance with rows that assert nothing, so the
guard keeps its #1058 meaning; only its bound moves from a fixed eight to the
module's real maximum.

**Byte-inertness is structural, not incidental**: a module with no closure
above eight mints nothing, so the registry scan finds nothing and neither the
ladder nor the bridge moves. Both `@js-temporal/polyfill` providers rebuild
byte-identical (host 1,726,098 B; standalone 3,488,870 B) — the polyfill itself
declares no 9+-formal closure; it is the test262 HARNESS that does.

## Acceptance

- `tests/issue-6655-standalone-apply-closure-high-arity.test.ts` fails on the
  true base and passes on the fix. MET.
- Battery: 0 pass→fail across the 13 must-not-move groups + AddSub.
- The three briefed rows: **NOT met, and deliberately not forced.** They are
  blocked on ceiling 2 (the provider's ladder, reached through #6628's
  peer-callable-kind hijack), not on anything this change can reach. The only
  way to make them green from here is to retire the trap, which makes them
  pass without running their assertions — see the measured shadow-mutation
  above.

## Residuals (measured, not fixed)

- **The three briefed rows, and the mechanism behind them.** A consumer-owned
  closure with more than eight formals cannot be invoked once the #6420 peer
  front-guard hands it to the provider: the provider's own ladder stops at its
  own maximum declared arity, and it has no way to mint an arm for an arity
  only the consumer knows. Two candidate directions, both larger than this
  slice: (a) give the peer front-guard a real ownership test — #6628 concluded
  that needs a module-origin tag written at `struct.new`, since
  `canonicalRuntimeTypes` makes `ref.test` ownership-blind BY DESIGN; or (b)
  have the provider's above-top fallback route the callee BACK across the link
  instead of answering the sentinel, which needs a loop-breaker because the
  consumer's own front guard would hand it straight back. Reduced probe for
  (a): `plan/issues/6628-standalone-proxy-trap-peer-callable-kind-misclassification.md`'s
  9-line linked repro; for the arity half, `.tmp/s73/probes/shadow-run.mts`
  (pass/fail is only meaningful with the mutated copy, which is the
  non-vacuity check).

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
