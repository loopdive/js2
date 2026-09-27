---
id: 6494
title: "ES2015 standalone: six Proxy/Reflect paths that must throw a TypeError return silently instead"
status: in-review
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
related: [5316, 1355, 6493]
# 2026-09-17 — the four guards this slice adds are FRONT GUARDS on existing
# natives and one call-site gate, so they land inside the functions that already
# own those bodies; there is no seam to move them behind without splitting a
# god-function this slice does not otherwise touch. Most of the growth is the
# WHY comments recording the two measured traps (`__proxy_set_dispatch`'s
# trap-absent `ref.null.extern` placeholder, and `__defineProperty_value`
# carrying no proxy front guard) that cost the #6493 lane a full round.
loc-budget-allow:
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-ops.ts
  - src/codegen/expressions/call-namespace-static.ts
func-budget-allow:
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/object-ops.ts::compileObjectDefineProperty
# 2026-09-17 — the three new `__is_truthy` calls are not a hand-rolled coercion
# matrix: each is literally the spec's ToBoolean on a [[Set]] / [[DefineOwnProperty]]
# success bit (§Set(O,P,V,true) step 4, §DefinePropertyOrThrow step 4). They call
# the SAME shared `__is_truthy` native the six neighbouring proxy front guards
# already use — `Reflect.set` and `Reflect.defineProperty` read the identical
# value through it — so this makes the OrThrow wrappers agree with the Reflect
# arms rather than introducing a second rule.
coercion-sites-allow:
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-ops.ts
---

# Six Proxy/Reflect paths that must throw and do not

`--target standalone`. Each row below is a spec step whose whole content is
"throw a TypeError". Measured directly against `origin/main` @ `c698c755bb`
with `result.imports === []` on every probe — not inferred from test262 error
strings.

| probe | measured | spec |
| --- | --- | --- |
| `Reflect.get(1, "x")` | **no throw** | §28.1.6 step 1 — Type(target) is not Object |
| `Reflect.has(1, "x")` | **no throw** | §28.1.9 step 1 |
| revoked proxy reached through `Array.prototype.map` | **no throw** | §10.5.x — a revoked proxy throws on every internal method |
| `Object.defineProperty(revokedProxy, …)` | **no throw** | ditto, via §10.5.6 |
| `defineProperty` trap returns `false` | **no throw** | §DefinePropertyOrThrow step 4 |
| `set` trap returns `false`, strict | **no throw** | §Set(O,P,V,true) step 4 |

Controls that already behave correctly, so the slice is a residual and not a
rewrite — do not regress them:

| control | measured |
| --- | --- |
| `deleteProperty` trap returns `false` | throws ✓ |
| `setPrototypeOf` trap returns `false` | throws ✓ |
| `preventExtensions` trap returns `false` | throws ✓ |
| a present non-callable trap | throws ✓ |
| `Reflect.construct(f, [], 1)` with a non-constructor newTarget | throws ✓ |
| a revoked proxy read **directly** (`r.proxy.x`) | throws ✓ |

## Why these two traps and not the others

#5316 ("r4: §10.5 descriptor-model invariants") is **done** (landed
2026-09-07) and wired the success bit for `deleteProperty`, `setPrototypeOf`
and `preventExtensions`, plus the non-callable-trap check. It left
`defineProperty` and `set` un-wired. That is the same pair the #6493 lane hit
from the other direction: its S4 had to special-case both inside
`emitErrorStackSetterBody` because no general path carried their success bit.
This issue generalises that fix instead of leaving it as one accessor's
private workaround.

The stated blocker in `object-runtime-proxy.ts` — *"those need the standalone
descriptor-attribute model (#797/#1460/#1462) and are deferred to the
invariant slice (G)"* — **is stale.** #797, #1460 and #1462 are all `done`.

## Scope note, stated because it decides whether this is worth doing

Of the 36 ES2015 standalone rows that report *"Expected a TypeError to be
thrown but no exception was thrown at all"* under `Proxy`/`Reflect`,
**15 end in `-realm.js`** and fail on the runner's `createRealm` stub, not on
any of the above; those belong to the cross-realm decision recorded in #4444
and are out of scope here. The realistic yield of this slice is the remaining
~21 rows minus whatever needs mechanisms not listed above. **Measure it; do
not assume it.** If the measured gain is small, that is still the correct
answer to report — these are real spec defects either way.

## Implementation Plan

### S1 — the two un-wired trap success bits

`__proxy_define_dispatch(proxy, key, desc) -> externref` and
`__proxy_set_dispatch(proxy, key, value) -> externref` both already **return
the trap's booleanish result**; `__is_truthy` coerces it. What is missing is
the caller-side check that turns a falsy result into the TypeError the spec
step owes.

Two cautions, both learned the hard way in #6493 S4 and not to be re-derived:

- **`__proxy_set_dispatch`'s trap-ABSENT arm pushes `ref.null.extern`** as a
  placeholder that `__extern_set`'s front guard *drops* rather than reads.
  `__is_truthy(null)` is 0, so checking that arm's result would throw on
  **every trap-absent proxy**. Use the 4-argument
  `__proxy_set_receiver_dispatch(recv, key, v, recv)`, which owns its answer on
  both arms and is literally the spec's shape for §Set(O,P,V,true).
- **`__defineProperty_value` carries no Proxy front guard at all** (only
  `__obj_define_from_desc` does), so on a proxy receiver it `ref.cast $Object`s
  the carrier and stores into it — the define trap runs **zero** times through
  that entry point. Wiring the front guard is what makes both the `false`
  return *and* a throwing trap observable.

### S2 — revoked-proxy reachability

A revoked proxy throws when read directly but not when it reaches an internal
method through `Array.prototype.map` or `Object.defineProperty`. Find which
entry points bypass the revoked check and route them through the same guard.
Start from the difference between the two measured cases — the direct read
already works, so the guard exists and the question is which callers miss it.

### S3 — `Reflect.get` / `Reflect.has` argument validation

Both must throw when `target` is not an Object, before any other observable
step. This is the cheapest item and should not be bundled into S1/S2's risk.

## Hard constraints

- **`result.imports` must stay `[]`.** `__extern_is_object` and `__to_boolean`
  are host imports; `__is_truthy` and the `__proxy_*_dispatch` family are
  `registerNative` standalone natives.
- **Zero rows lost.** The per-test edition ratchet fails the required `merge
  shard reports` check on a single pass→not-pass in ES2015, with no waiver.
- **Every control above stays green** — a "not an object" probe that widens
  into rejecting genuine objects is the failure mode to guard against. Prefer
  a union of positive tests over a negative one, as #6493 round 2 did.
- The host/gc lane must not move: these paths are standalone-gated.

## Acceptance

1. All six probes throw a TypeError; all six controls unchanged.
2. The ~21 non-realm Proxy/Reflect rows measured on both a merge-base tree and
   the branch, same `.test262-cache` symlinked into both, **zero lost**.
3. A control set over `built-ins/Proxy`, `built-ins/Reflect` and
   `built-ins/Object` re-run on both trees, zero lost.
4. Pin file covering each of the six defects and each of the six controls.
5. All gates exit 0, run bare.

## Implementation notes (2026-09-17)

Four changes, each a guard rather than a mechanism. Written up by WHY, because
three of the four are where a plausible-looking fix is wrong.

### 1. `Reflect.get` / `Reflect.has` — a STATIC nullish target, not a runtime one

`src/codegen/reflect-target-guard.ts` + `src/codegen/expressions/call-namespace-static.ts`.

The plan's row said `Reflect.get(1, "x")` does not throw. **It already threw.**
The measurement that produced that row used the `(Reflect as any).get(1, "x")`
spelling, which is a *dynamic member call* and never reaches the namespace-static
arm; test262 writes `Reflect.get(1, 'p')`, and on `c698c755bb` the number and
string spellings both threw. The residual was `null` and `undefined` — half the
assertions in `Reflect/{get,has}/target-is-not-object-throws.js`.

`emitNativeReflectNonObjectGuard` *deliberately* declines to brand nullish at
runtime, and its comment explains why at length: this compiler's alias/element
widening nulls ORDINARY objects, so a runtime null-brand turns working programs
into TypeErrors. The fix therefore had to be a compile-time fact about the
**argument expression** — `Reflect.get(null, 'p')` cannot be a nulled real
object. `staticallyNullish` seeds the existing predicate with `1` instead of `0`,
so the emitted shape is unchanged and no new throw site appears. `undefined` is
decided by `ctx.oracle.typeFactOf`, not by the spelling, so a shadowing
`var undefined = {}` keeps its previous lowering.

The `(Reflect as any).get(...)` spelling is STILL open. It is a different
lowering path and out of this slice.

### 2. `Object.defineProperty` with a falsy `defineProperty` trap result

`src/codegen/object-ops.ts`, `emitDefinePropertyRejectionThrow`.

`Reflect.defineProperty(p, k, d)` already answered `false` correctly — it reads
the applier result through `__is_truthy`. `Object.defineProperty` read the same
value with **`ref.is_null`**, and a `false` trap return is a boxed `false`, not
null, so §DefinePropertyOrThrow step 4 never fired. The `falsyIsRejection`
option is opt-in because the other four call sites hand this helper a *non-proxy*
applier result whose falsiness is not a [[DefineOwnProperty]] answer.

### 3. Strict `proxy.x = v` with a falsy `set` trap result

`src/codegen/object-runtime-proxy.ts`, a front guard on `__extern_set_strict`.

`$Proxy` is **not** a subtype of `$Object`, so `__extern_set_strict` took its
non-`$Object` arm into `__extern_set`, whose proxy guard runs the trap and
*drops* the answer.

Both of the plan's paid-for cautions held and are worth restating:

- Only the trap-**present** arm is intercepted. `__proxy_set_dispatch`'s
  trap-absent arm pushes `ref.null.extern` as a placeholder the front guard
  drops rather than reads, and `__is_truthy(null)` is 0 — reading it would
  throw on every trap-absent proxy. Gating on the trap's presence removes the
  question, and the guard has no `return` on that path, so the forward path is
  untouched.
- The receiver form is `__proxy_set_receiver_dispatch(recv, key, v, recv)`,
  literally §Set(O,P,V,true)'s shape, with the 3-argument dispatch as a fallback
  for modules where the ordinary receiver walk was never reserved. On the
  trap-present arm the two are the same trap call with the same receiver.

Sloppy mode is unaffected and was checked directly, not assumed: a source file
with no top-level import/export stays a script, and there the same program does
not throw (§Set(O,P,V,false)). Adding a `"use strict"` prologue flips it, which
is the control proving the probe can see a throw at all.

### 4. Revoked-proxy reachability

Two disjoint holes, both `src/codegen/object-runtime-proxy.ts` /
`src/codegen/object-ops.ts`:

- `Object.defineProperty(p.proxy, …)`. The standalone proxy-receiver reroute
  recognised only a syntactic `new Proxy(...)`, so a `Proxy.revocable(...).proxy`
  receiver fell to the inline `__defineProperty_value` fast path, which
  `ref.cast $Object`s the carrier and stores into it — **the define trap ran
  ZERO times** (the plan's second paid-for caution, confirmed by direct
  measurement: trap-call counter 0). Widening the recogniser to
  `Proxy.revocable(...).proxy` — requiring the *declaration* to be
  `Proxy.revocable(...)`, so it stays a proof and not a guess — routes it
  through `__obj_define_from_desc`, whose front guard owns the revoked check.
  Note the fix is the RECOGNISER, not a guard inside `__defineProperty_value`:
  wiring a descriptor-building proxy arm into that very hot native is a much
  larger change for the same rows.
- `Array.prototype.map.call(revoked, f)`. `__extern_length` and
  `__extern_get_idx` carry no proxy front guard at all. **`__extern_length`
  alone now carries the revoked bit** — LengthOfArrayLike is the first internal
  method `map` performs, so guarding the length read is enough to make the
  generic path throw, and a live proxy still falls through to the untouched
  body.

  **`__extern_get_idx` is deliberately NOT guarded, and this is the one thing
  the sweep caught that no probe would have.** It cannot take a naive
  `body.unshift`: `fillExternGetIdxVecArms` locates its splice point by that
  function's **3-instruction preamble shape** (documented around
  `fillClassProtoLookupArm` in `codegen/index.ts`), so prepending silently
  drops every typed-vec arm. Measured: with the prepend in,
  `Proxy/defineProperty/{trap-is-undefined,return-boolean-and-define-target}.js`
  both went **pass → fail**, the harness reporting
  `Invalid descriptor field: undefined` — `names.length` still right,
  `names[i]` gone. All twelve probes were green at that moment; only the
  before/after row run saw it. Adding an index guard has to participate in that
  late-prepend ordering protocol, and it buys no row this slice measured.

  Routing either terminal into `__proxy_get_dispatch` would change what every
  LIVE proxy answers for `length`/index reads; that is a real pre-existing gap
  (a live proxy over `[1,2,3]` maps to an empty array, on base and on this
  branch alike) and is deliberately left open.

### Lane containment

`gc` is byte-identical on both a Proxy-free probe and the full probe file
(sha256 `fd0aa18d8fad3947` / `94545f0dec39c32f`, base and branch). The two
proxy-runtime guards are `ctx.standalone`-gated for the reason
`registerProxyInvariantValidators` gives about `--target wasi`: ungated, a
Proxy-free wasi probe moved by 113 bytes, and a lane this slice does not measure
should not move. wasi *does* still move on a program that literally writes
`Reflect.get(null, …)` (same byte count, the seed constant flips) — that arm is
a compile-time constant with no attribute-model dependency, so it is correct in
every lane.

### Measured result (2026-09-17)

Both trees ran the SAME path lists with the same `.test262-cache`, `node_modules`
and `test262` symlinked into each:
`COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`.
Base tree = a detached worktree at `c698c755bb`.

**Target set — every row under `built-ins/Proxy` + `built-ins/Reflect`, 464 rows:**

| | pass | fail | compile_error |
| --- | --- | --- | --- |
| base `c698c755bb` | 367 | 91 | 6 |
| branch | **370** | 88 | 6 |

**Lost: 0. Gained: 3. Net +3.**

```
fail→pass  built-ins/Proxy/defineProperty/null-handler.js
fail→pass  built-ins/Reflect/get/target-is-not-object-throws.js
fail→pass  built-ins/Reflect/has/target-is-not-object-throws.js
```

+3 against the issue's "~21 minus whatever needs other mechanisms" estimate.
The estimate was right to be hedged, and the shortfall is not mysterious — of
the 24 rows in `built-ins/Proxy|Reflect` reporting an unthrown TypeError, 15 are
`-realm.js` (out of scope per #4444) and 3 of the remaining 9 are the
`trap-is-{missing,null,undefined}-target-is-proxy.js` family, which needs
nested-proxy forwarding over EXOTIC targets (`new String("str")`'s
non-configurable `length`, a RegExp's `lastIndex`, array `length`) rather than
any success bit. Two more (`Reflect/apply/arguments-list-is-not-array-like.js`,
`Reflect/construct/target-is-not-constructor-throws.js`) need
CreateListFromArrayLike / IsConstructor work, and
`Proxy/getPrototypeOf/instanceof-*` needs `instanceof` to route through the
`getPrototypeOf` trap. None of those is a Proxy success-bit or a revoked check.

The three rows this slice does NOT convert but the probes do fix — a falsy
`defineProperty` trap, a falsy strict `set` trap, and a revoked proxy through
`Array.prototype.map` — have no dedicated ES2015 row of their own; they are
real spec defects that the corpus happens not to isolate.

**Control set — 630 rows, stride-sampled so it is a real sample and not a
neighbourhood:** every 5th row of `built-ins/Object/{defineProperty,
defineProperties, create, freeze, seal, getOwnPropertyDescriptor}` (2,341 rows
→ 469) plus every 4th row of `language/expressions/assignment` (→ 161, the
strict-write surface `__extern_set_strict` sits on).

| | pass | fail | compile_error |
| --- | --- | --- | --- |
| base `c698c755bb` | 611 | 14 | 5 |
| branch | 611 | 14 | 5 |

**Lost: 0. Gained: 0.** Row-for-row identical, not just count-identical — the
comparison is per-path, so a one-in/one-out swap could not hide in it.

Across both sets, **1,094 rows on each tree, zero lost.**

### What the plan got wrong, recorded so the next lane does not re-derive it

1. **`Reflect.get(1, "x")` already threw.** The row was measured with the
   `(Reflect as any).get(...)` spelling, a different (dynamic member-call)
   lowering; test262's `Reflect.get(1, 'p')` threw on base. The actual residual
   was `null`/`undefined`. The dynamic spelling is still open.
2. **The define trap does fire through `Object.defineProperty` on a
   `new Proxy(...)`-bound receiver** — the plan's "runs zero times" is true only
   for the `Proxy.revocable(...).proxy` spelling, because the reroute gate is
   syntactic. That distinction is what made the fix a one-line recogniser
   widening instead of surgery on `__defineProperty_value`.
3. **`Reflect.defineProperty` and `Reflect.set` already surfaced the trap's
   `false` correctly.** Only the two OrThrow wrappers were missing it, which is
   why the fix is at the call site and not in the dispatch.
4. **`__extern_get_idx` cannot take a naive front guard** — see §4 above. This
   is the one finding that no probe produced; it took the before/after row run.
