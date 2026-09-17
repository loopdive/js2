---
id: 6494
title: "ES2015 standalone: six Proxy/Reflect paths that must throw a TypeError return silently instead"
status: ready
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
