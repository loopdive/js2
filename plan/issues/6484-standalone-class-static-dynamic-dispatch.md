---
id: 6484
title: "standalone: a class STATIC method is mis-dispatched on every dynamic path, and `Temporal.Duration.from` bottoms out below all of them"
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s19-lane
---

# #6484 — standalone class-static dynamic dispatch, and where the Temporal `from` bucket really ends

Child of [#5383](5383-standalone-temporal-provider.md) (S19), following
[#6483](6483-standalone-link-reverse-method-call.md) (S18).

## Summary

S18 handed over: "`Temporal.Duration.from("P0Y")` throws while
`Temporal.Duration[k]("P0Y")` works; a literal-named member call takes a
per-name `__call_m_<name>` dispatch path with no link-boundary arm, and the
forward terminal is **never consulted** there."

**Every clause of that is wrong**, and the probes say so unambiguously:

| S18 said | measured on S18's own tree (this branch's base) |
| --- | --- |
| the literal call takes `__call_m_from_1` | it emits `call $__extern_method_call` directly — the consumer WAT shows it |
| the forward terminal is never consulted | it IS consulted, and returns from its **apply** exit |
| `Temporal.Duration[k]("P0Y")` works | it answers **`null`** — a silent wrong value, not a pass |
| `const f = Temporal.Duration.from; f("P0Y")` works | it answers **`null`** too |

S18's own instrumentation legend already predicted the true reading — "a thrown
TypeError ⇒ it resolved AND applied, and `__apply_closure` answered null" — and
its prose recorded the opposite. The absence of a marker was evidence of the
apply path, not of a path that was never taken.

**This slice ships NO compiler change.** The bucket is not at the link, is not in
the dispatchers, and does not move by anything reachable in one slice. What it
ships is the measured chain, end to end, plus three independent single-module
reductions found on the way.

## The chain, measured layer by layer

Each row is a separate instrumented build of the real linked provider
(`.tmp/s19/r1-inst{1,2,3,4,5}.out`), fresh `JS2WASM_TEMPORAL_CACHE`,
`cacheHit=false` on every prewarm.

| layer | instrument | verdict for `Temporal.Duration.from("P0Y")` |
| --- | --- | --- |
| consumer `__extern_method_call`, `$Object` arm | `MC-OBJARM` marker | not taken |
| consumer, non-`$Object` arm → forward peer terminal | — | taken |
| provider `__js2wasm_link_method_call`, resolve exits | `MC-NULLGET` / `MC-UNDEFGET` | neither — the member RESOLVED |
| provider `__js2wasm_link_method_call`, apply exit | `MC-APPLYNULL` | **fires** |
| provider `__apply_closure` arity dispatch | `AC-NOARM-n` / `AC-NULLRES-n` | **`AC-NULLRES-1`** — the arm existed, ran, returned null |
| provider `__call_fn_method_1` ladder terminal | `MD-MISS-1` | not reached — an arm matched |
| provider native-proto front arm | removed under `S19_NO_NP` | not the culprit (answer unchanged) |

So the dispatch is correct at every level and **the callee itself returns null**.

### Below the dispatch: it is the polyfill's own `from`, inside one module

A diagnostic was injected into the frozen `Temporal` namespace literal of the
polyfill source (`__s19diag`, `.tmp/s19/diag.mjs`), so the provider answers
questions about itself with the real classes in scope. In **one module, no
link, no consumer**:

| probe, provider-internal | answer |
| --- | --- |
| `Duration.from("P0Y")` | **`null`** |
| `sn("P0Y")` (the whole body of `Duration.from`) | **`null`**, and `=== null` is `true` |
| `Ye.exec("P0Y")` (the duration regex) | a 12-element match — the parse works |
| `Ae("P0Y")` / `lt("P0Y")` | `false` / `false` — so `sn` takes its string branch |
| `new (ce("%Temporal.Duration%"))(1)` then `.toJSON()` | **`!invalid receiver: method called with the wrong type of this-object`** |
| `new Duration(1).toJSON()` | `P1Y` — the real class is fine |
| a plain IIFE, and the exact `iife + destructure + captured-const new` shape `sn` uses | correct (`.tmp/s19/c6-base.out`, 7/7) |

`Duration.from(e)` in the bundle is literally `return sn(e)`, and `sn`'s string
branch ends in `new t(...)` where `t = ce("%Temporal.Duration%")`. The shape
itself compiles correctly. **The intrinsic registry `ce()` hands back a
constructor whose instances fail their own brand check** — that is the next
target, and it is a single-module standalone defect several layers below the
link.

## Three independent reductions, each in ONE standalone module, no link

All three are `--target standalone`, `hostBridge: "off"`, one probe per compiled
module (`.tmp/s19/single.mjs` — module CONTENT changes answers, the #6432
action-at-a-distance hazard).

### A — a computed-but-constant key on a class object passes the RECEIVER as argument 0

```js
class C { static one(a) { return "one:" + a; }
          static two(a, b) { return "two:" + a + "," + b; } }
const k = "one";  C[k]("A");        // "one:function () { [native code] }"
const k2 = "two"; C[k2]("A", "B");  // "two:function () { [native code] },A"
```

The consumer WAT is unambiguous (`.tmp/s19/sw-cmp.txt`): the key is folded at
compile time and the site emits `global.get <class singleton>; call $C_one` —
the class object is pushed as the first argument and the real arguments shift
right by one. `$C_one` takes exactly one parameter; a static has no receiver
slot. A **silent wrong answer**, not a throw.

This is visible in the real provider too: `Temporal.PlainDate[k]("1976-11-18")`
answers `Options parameter must be an object, not string` — the string landed in
`from`'s SECOND formal.

### B — a computed-key method call in a generic helper emits nothing at all

```js
function callDyn(o, k, a) { return o[k](a); }   // callDyn(C, "one", "A") -> null
```

compiles to a two-instruction body: `ref.null extern; return`
(`.tmp/s19/sw-c4.txt`). The same hole appears inline once the receiver is an
`any` holding a class object (`.tmp/s19/sw-c4b.txt`): the call site emits a
literal `ref.null extern`.

### C — a method value taken off a class applies without a receiver and fails with one

```js
function readDyn(o, k) { return o[k]; }
const f = readDyn(C, "one");
f("A");                 // "one:A"        ok
Reflect.apply(f, C, ["A"]);  // "one:A"   ok
const b = { g: f }; b.g("A");  // null     WRONG
f.call(C, "A");         // TypeError: called value is not a function
f.apply(C, ["A"]);      // TypeError: called value is not a function
```

A plain function value is correct in all five shapes; a class value's STATIC
method and a class INSTANCE method value both fail the receiver-bearing ones
(`.tmp/s19/c5-base.out`). `f.call` / `f.apply` here is the same residual #6483
recorded as "`Function.prototype.call` is not reachable on a boundary closure" —
it is not a boundary property at all, it reproduces in one module.

Note the sidecar (#5383 S2i) is DEMAND-minted: with no `o[k]` read anywhere in
the module, `typeof o.one` on an opaque class receiver is `"undefined"` and the
literal call throws `called value is not a function` (`.tmp/s19/c3-base.out`).
Adding an unrelated arity-1 closure to the module changes nothing.

## Why nothing was changed

Criterion 4 of #5383 asks the `called value is not a function` bucket to move.
It cannot move from the link boundary: the boundary already resolves the member
and already applies it, and the applied callee returns null of its own accord
(the table above). A link-side change would be measurable only as churn.

The three reductions are each real and each shippable, but A sits in the
class-static call-emission path — the hottest path in the compiler — and neither
A nor B nor C is on the failing Temporal rows' critical path, so none of them
would move a row either. Shipping a codegen change under a hard "0 legitimate
`pass→fail`" constraint, that cannot move the bucket it is being measured
against, is not worth the regression risk.

**No family measurement is reported and none was needed.** The branch's source
tree is byte-identical to its base (`git diff` against the S18 tip touches no
file outside `plan/issues/`), so there is provably nothing to measure; quoting a
run here would be attribution dressed as measurement.

## Next slice

1. **`ce("%Temporal.Duration%")`** — why `new` on the registry's answer yields an
   object that fails its own brand check, while `new Duration(1)` does not.
   Provider-internal, one module. This is the one that moves rows.
2. Reduction **A** — the receiver-as-argument-0 shift. Silent wrong answers
   across every class static reached by a folded computed key.
3. Reduction **C** — `f.call` / `f.apply` / `bag.m()` on a class-derived method
   value. Retires #6483's residual 2 and part of the named bucket.

## Artifacts

`.tmp/s19/` in `/home/user/js2/.claude/worktrees/agent-a93eeeb2d60f16ed8`:
censuses `c1`–`c6` with their `-base` outs, the real-provider reductions
`r1-base.out` / `r1-inst{1,2,3,4,5}.out`, the provider-internal diagnostics
`diag{1,2,3}.out`, the WAT dumps `w1-names.txt` / `sw-{opaque,cmp,c4,c4b}.txt`,
the drivers `{single,swat,watnames,diag,probe,pair2}.mjs`, and the revert copies
`.tmp/s19base/*`.
