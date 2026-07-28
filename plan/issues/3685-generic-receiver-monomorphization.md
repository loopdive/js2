---
id: 3685
title: "perf: generic receiver monomorphization — generalize #3683's typed-`this` beyond `this`"
coercion-sites-allow:
  # The typed twin reads a numeric field as an f64 and must hand the value back
  # to the dynamic lane in the same representation the legacy path used. Those
  # three sites CALL the existing `__unbox_number` helper (`ctx.funcMap.get`) —
  # they do not hand-roll a ToNumber matrix, which is what this gate exists to
  # stop.
  - src/codegen/typed-this.ts
func-budget-allow:
  # S1's whole-program receiver-flow walk is one traversal with a per-node-kind
  # switch; splitting it per kind would scatter the flow state it threads.
  - src/codegen/receiver-flow-analysis.ts::analyzeReceiverFlow
status: ready
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: perf
area: codegen
language_feature: compiler-internals
goal: performance
sprint: current
related: [3683, 3673, 1947, 1946, 1584, 1852, 2660]
loc-budget-allow:
  # S3 adds the proven-receiver admission + the guarded trampoline fill to the
  # module that already owns the typed-`this` direct-call machinery — cohesion,
  # not a barrel dumping ground. Crossing 1500 here is intended.
  - src/codegen/typed-this.ts
---

# #3685 — Generic receiver monomorphization

## Problem

#3683 proved the mechanism on ONE receiver: `this` inside a write-once
fnctor prototype method. Measured on compiled acorn, that program
delivered a ~20 % wall-clock win (S3 alone: method-call bridge 18.1 % →
9.6 % self time) and, just as importantly, made Binaryen effective for the
first time — `-O3` was worth ~0 % before #3683 S2, ~5 % after S2, and
**7.1 % after S3** (#3673 rounds 27/30), exactly the "cast removal +
devirtualization start firing" outcome #1947 predicted.

But the mechanism stops at the `this.` prefix. The #3673 round-26 profile
shows what that leaves on the table:

- **`__extern_get` 8.8 % self time** — property reads whose receiver is
  _not_ `this`: `node.start`, `parser.options.locations` (once per AST
  node, from `Node`'s constructor), `state.pos`, `refDestructuringErrors.
shorthandAssign`. Every one is a call returning a boxed value, where the
  `this.` form is a bare `struct.get` of an f64 slot.
- The residual call machinery after S3/S3b — a call whose _callee_ is
  proven but whose _receiver_ expression is a local, parameter, or field
  rather than `this`.

Both are the same missing capability: **prove that an arbitrary expression
denotes an instance of a known fnctor/class struct, then reuse the
lowering #3683 already built.**

## Scope

Generalize the receiver proof, NOT the lowering — the lowering exists:

1. **Receiver-flow analysis** (new, standalone module — the "land the
   analysis inert first" pattern that worked for `numeric-property-
analysis.ts` and `user-method-names.ts`). For each expression position,
   answer: is this provably an instance of exactly one registered fnctor
   struct? Sources of proof, cheapest first:
   - a `new F(...)` result flowing to a `const`/never-reassigned `let`;
   - a parameter whose every call site passes such a value (acorn's
     `Node(parser, …)` — `parser` is always `this` at the call site);
   - a field read whose slot is typed `(ref $__fnctor_F)`;
   - `this` itself (subsumes #3683's case as the degenerate one).
     Everything unproven falls back to today's dynamic path — no exceptions,
     no runtime name guards.
2. **Read/write lowering**: a proven receiver + a declared field of that
   struct → `ref.cast` + `struct.get`/`struct.set`, composing with #3683
   S4a's f64 slots so a numeric field read is unboxed end to end.
3. **Call lowering**: a proven receiver + a write-once method of that
   class → the #3683 S3 direct-call trampoline, unchanged.
4. **Guard placement**: one `ref.test` per receiver _binding_, not per
   access — the win is destroyed if each field read re-tests.

## Non-goals

- Speculative/deoptimizing specialization (V8's model). Everything here
  stays statically proven with a dynamic fallback.
- Changing the boxed representation of unproven values — that is #1947
  (externref laundering) and #1584/#1852 (value representation), which
  this issue composes with rather than replaces.

## Why now

The #3673 scaling decomposition (round 27) showed the remaining gap to
node-acorn is **entirely per-byte throughput** (32.5x/KB, size-independent)
and that ~two thirds of it is the parser's own compiled bodies, not runtime
helpers. Receiver monomorphization is the largest identified lever inside
those bodies, and #3683 has already paid the cost of building the lowering
and the admission machinery it needs.

## Slices

- **S1 — receiver-flow analysis, inert.** New module + unit tests + a
  debug tally over compiled acorn ("how many read/call sites would this
  admit, by proof source"). No lowering change; safe to land alone.
- **S2 — read/write lowering** for proven receivers (composes with #3683
  S4a f64 slots). Gate: the #3673 acorn corpus + full equivalence diffed
  by name.
- **S3 — call lowering** through the #3683 S3 trampolines.
- **S4 — binding-level guard hoisting** (one `ref.test` per binding).

## S1 result (2026-07-27) — analysis landed inert

`src/codegen/receiver-flow-analysis.ts` + 17 pins. **Tallied over real
acorn (226 KB), the analysis was rebuilt three times against the tally —
each rebuild driven by a shape the unit tests did not have:**

| iteration                                                          | verdicts | non-`this` accesses admitted (of 2,363) |
| ------------------------------------------------------------------ | -------- | --------------------------------------- |
| initial rules (const + params + this)                              | 0        | **0**                                   |
| + prototype-ALIAS map                                              | 3        | 20                                      |
| + return-class inference, `var` bindings, call-return initializers | 50       | **150**                                 |

Three findings worth keeping:

1. **The direct `F.prototype.m = …` form is essentially absent from
   shipping code.** acorn's dist has NINE `var pp$N = Parser.prototype`
   aliases and assigns every method through one. The first tally admitted
   literally zero receivers for this reason alone — the unit tests used
   the textbook form. Any future analysis in this family must model
   aliases from the start.
2. **`const`-only admission is worthless on real code.** acorn's dist is
   ES5 `var`. Safety now comes from the DEMOTION pass (any binding written
   after its initializer is withdrawn), not from the declaration keyword —
   which is both stronger and applicable. Pinned both ways.
3. **Return-class inference is what unlocks the dominant shape.**
   `var node = this.startNode()` → `finishNode(node, …)` is how acorn
   moves Nodes around; without it, every `node` parameter and binding is
   unproven. Requires a fixed point (a return can depend on a parameter
   verdict) and must refuse any method with a bare `return` path.

Admitted classes: `Node` 130 accesses, `Parser` 20 — i.e. exactly the
per-AST-node `node.start`/`node.end` traffic the profile blamed. The
2,213 still-unproven accesses are dominated by `this.options.<x>` (a
FIELD read — an explicit S1 non-goal, needs the slot's declared type)
and by `state.<x>` in the RegExp validator (a parameter whose call sites
pass a field read). Both are S2-or-later work.

Cost: 365 ms for 226 KB, single pass, no checker queries.

## The measurement that sizes this issue (#3673 round 31)

The hot-chain experiment compiled acorn's real `readWord1` loop three
ways — acorn's dynamic shape (what we emit today), the identical
algorithm end-to-end typed, and the JavaScript on node:

| variant              | ms/scan    | vs node  |
| -------------------- | ---------- | -------- |
| dynamic (today)      | 0.4294     | 17.9x    |
| **end-to-end typed** | **0.0659** | **2.8x** |
| node                 | 0.0239     | 1x       |

**6.51x from typing alone**, with `__extern_get` 66 → 0, `__apply_closure`
20 → 0, `__box_number` 70 → 2 in the emitted code. That is this issue's
prize: everything the typed variant states by hand, #3685 must DERIVE.
The residual 2.8x is the part inference cannot reach and profile-guided
speculation would have to.

## Acceptance criteria

- `__extern_get` self time on the #3673 deep-warm acorn profile drops
  materially (target: below 4 %, from 8.8 %).
- Devirtualization/inline tallies reported per slice, as #3683 did.
- Every slice measured with #3673's duplicate-baseline control-arm
  methodology; a delta inside the control band is reported as
  indistinguishable from zero.
- No new host imports; standalone canaries keep `imports: ZERO`.
- Full `tests/equivalence` failure set identical by test NAME to the
  merge parent.

## S3 result (2026-07-27) — proven-receiver call lowering landed

**The gap this closes.** #3683 S3 devirtualized `this.m()` _inside_ a typed
twin. It left the ENTRY from ordinary code untouched: `p.inc()`, where `p` is
an ordinary local, still compiled to the full dynamic dispatcher
`__call_m_inc_0` — interned-key lookup, method-cache probe, `ref.test`/cast
ladder, arity check, `call_ref`. Diagnosed from the emitted WAT: the twins
existed (`__closure_0__typed_this`), but no call site outside a twin reached
them.

**What landed.** `tryEmitDirectTwinCall` gained a second admission route. The
`this` route is unchanged byte-for-byte; the new route proves the receiver's
class with the S1 analysis (`receiverClassOf`) and reuses the identical
trampoline machinery. S1 was fully inert before this — it had no caller and no
context field; it is now computed once per source file and memoized.

**The guard is the design point, not a detail.** #3683's trampoline casts the
receiver UNGUARDED, sound only because the sole path to such a call site runs
through the twin's own `ref.cast`. A receiver-flow verdict carries no such
guarantee — it is a whole-program inference, and an unguarded cast would turn
any imprecision into a runtime TRAP with no fallback. So proven-receiver sites
reserve a distinct guarded trampoline (`__dc_<F>_<m>_<n>_g`, guard flag in the
reservation key so the two variants can never share a handle) whose fill emits
`ref.test` → twin arm : legacy-dispatcher arm. An analysis bug therefore costs
a slow call, never a crash.

**Measured** (axis benchmark, all three engines re-run on one machine,
checksums identical):

| axis                | node     | Porffor  | js2 before | js2 after    |
| ------------------- | -------- | -------- | ---------- | ------------ |
| **method dispatch** | 0.940 ms | 8.104 ms | 9.085 ms   | **3.359 ms** |

**9.73x → 3.57x vs node** on that axis, and js2 goes from 1.13x _behind_
Porffor to **2.4x ahead** of it. Other axes flat within noise, as expected —
the tokenizer axis is `this.nextCode()` inside a twin, which #3683 S3 already
devirtualized, so it correctly did not move (0.784 → 0.766 ms).

Pinned by `tests/issue-3685-proven-receiver-calls.test.ts` (7 cases: guarded
variant emitted, `ref.test` precedes `ref.cast`, argument values and
left-to-right order, receiver evaluated once, `this` sites stay on the
unguarded trampoline, unproven receivers stay dynamic, reassigned bindings
withdrawn).

**A pre-existing bug found while pinning, NOT introduced here.** For
`var p = new P(0); p = new Q(); p.inc()` — two classes with a same-named
prototype method and a reassigned binding — the dynamic path answers `null`
instead of dispatching to `Q.prototype.inc`. Verified identical with
`JS2WASM_DIRECT_CALLS=0` and on the pre-slice compiler, and no trampoline is
emitted for that shape at all, so this slice never runs there. The pin asserts
the safety property it owns (no devirtualization of a withdrawn binding)
rather than freezing the wrong return value into a test.

### Root cause of that pre-existing bug (diagnosed 2026-07-27, NOT fixed)

**A fnctor prototype method is only reachable from the DYNAMIC dispatch path
if the program contains at least one STATICALLY-TYPED use of that method.**

```js
function Q() {
  this.v = 9;
}
Q.prototype.inc = function () {
  return 1000;
};
export function test() {
  var p;
  p = new Q();
  return p.inc();
}
// -> 0.  Add ANY typed use of Q.prototype.inc, even one that never runs:
function dead() {
  var q = new Q();
  return q.inc();
}
// -> test() now returns 1000.
```

A _dead_ typed use repairs it, which proves this is a compile-time
registration/emission gap, not a runtime one: the typed path is what causes
the method to be emitted into whatever table the dynamic path consults
(`__call_m_<m>_<n>` → `__method_cache_lookup` → `__extern_method_call`).

Evidence trail, in the order it was established:

- Not the method cache and not a name collision — a method name unique to a
  second class fails identically.
- The receiver IS correct at runtime and the member DOES resolve: after the
  reassignment `p.v` reads Q's field and `typeof p.inc === "function"` is
  `true`. Only the invocation answers undefined.
- Long-standing, not a perf-work regression — reproduces on `upstream/main`
  in a fresh worktree.
- **NOT static/dynamic class disagreement**, which was the first hypothesis
  and is FALSIFIED: a single-class program with no reassignment conflict
  (`var p; p = new Q()`) fails just as hard. The real variable is whether a
  typed use exists anywhere in the program.
- `collectMethodEntries` (closed-method-dispatch) keys on a compiled
  `<Struct>_<method>` function. A fnctor prototype method is a lifted
  _closure_, not a `Q_inc`, so it contributes NO closed-struct arm — which is
  consistent with the emitted `__call_m_inc_0` having no per-struct arms at
  all. That is the most likely place the registration is missing.

> **Superseded — this last bullet was the right neighbourhood but the wrong
> function.** The methods were never lifted or compiled in the first place, so
> there was nothing for `collectMethodEntries` to key on. The registration is
> lost one step earlier, in `bindingOf` (fnctor escape gate). See the fix
> section below and #3719.

One fix was attempted and **reverted**: routing the terminal `else` of
`buildClosurePropMethodCallElseArm` to generic member-get + apply instead of
`ref.null.extern`. It changed nothing, which rules the terminal fallback out.
Not landed — an unverified speculative codegen change is worse than none.

Split out as **#3719** (fixed — see below). `claim-issue.mjs --allocate` could
not be trusted to hand out the id here: it returned #3717, already taken on
this branch, because its open-PR scan silently degrades to main-only when `gh`
is unavailable. #3719 was picked by hand after verifying it was free.

Remaining in this issue: **S2** (read/write lowering for proven receivers —
the `__extern_get` 8.8% self-time bucket) and **S4** (hoist the guard to one
`ref.test` per binding rather than per call site).

## S2 result (2026-07-27) — proven-receiver field reads landed, −33%

`tryEmitProvenReceiverFieldGet` (`src/codegen/typed-this.ts`, wired into
`src/codegen/property-access-dispatch.ts` right after the `this`-form
`tryEmitTypedThisFieldGet`) applies the S1 receiver-flow proof to plain
property **reads** off a generic binding, not just `this`.

Shape emitted, receiver evaluated exactly once into a temp:

```
local.get tmp ; any.convert_extern ; ref.test $F
if (result <fieldType>)
  then  local.get tmp ; any.convert_extern ; ref.cast $F ; struct.get $F <idx>
  else  __extern_get(tmp, "<name>")  coerced to <fieldType>
```

The carve-outs mirror the `this` form exactly (RESERVED_PROPS,
`classAccessorSet`, presence-tracked fields, call-signature receivers), so a
proven receiver never bypasses an accessor or a presence check. The `else`
arm is captured with the body-swap pattern so the pre-existing dynamic
lowering stays byte-identical when the guard fails.

**Measured** (prop axis, `benchmarks/cross-engine/`, same container, same
run): `9.1408 ms` dynamic → `6.1577 ms` with S2, **−33%**, checksums
identical across both lanes.

Two false starts worth recording, both "S2 silently didn't fire":

1. The approved-class set was seeded from `gate.methods.keys()`, i.e. only
   classes that have prototype **methods**. A data-only class has none, so
   its fields were never eligible. Widened to every `__fnctor_*` key in
   `ctx.structMap`.
2. The escape gate was absent entirely for the benchmark's shape — see the
   #3719 bug below.

Kill switch: `JS2WASM_PROVEN_FIELDS=0`. Debug counters:
`JS2WASM_PROVEN_FIELDS_DEBUG=1`.

## S4 result (2026-07-27) — FALSIFIED by measurement, not landed

S4 proposed hoisting the `ref.test` so a proven binding pays one guard per
binding instead of one per access — in the limit, dropping to a bare
`ref.cast` + `struct.get` with no branch.

An A/B over three runs of the prop axis, using the deliberately-unsound
measurement mode `JS2WASM_PROVEN_FIELDS=unguarded` as the upper bound for
what any amount of guard hoisting could buy:

| lane                     |   prop axis |
| ------------------------ | ----------: |
| dynamic (no S2)          |     ~8.7 ms |
| **guarded (S2, landed)** | **~6.2 ms** |
| unguarded (S4 ceiling)   |     ~7.7 ms |

The unguarded lane is **slower than the guarded one**. `ref.cast` is itself a
checked, trapping operation — removing the `ref.test` does not remove the
check, it just moves it somewhere the engine can no longer fold into the
branch it already predicts perfectly. So the theoretical S4 win is negative
on this workload.

S4 is closed as a **null result**. Not landed, deliberately: there is no
version of "hoist the guard" that beats the guard, because the guard is not
what costs. Reopen only with a measurement showing a workload where the
branch itself (not the cast) is the cost.

## Pre-existing bug from S3 — FIXED, split out as #3719

The `.call`/`.apply`-adjacent bug recorded under "Root cause of that
pre-existing bug" above is fixed. Root cause: `bindingOf` in
`src/codegen/fnctor-escape-gate.ts` recognised `const p = new Q()` (a
variable _declaration_) but not `p = new Q()` (an assignment to an existing
binding), so an assigned-to binding lost fnctor approval and fell all the way
back to a dispatch that answers `undefined`. Fix and pins in
`tests/issue-3719-new-assigned-to-binding.test.ts`; write-up in
`plan/issues/3719-new-assigned-to-binding-loses-fnctor-approval.md`.
All five original matrix cases plus the untyped-only control now return 1000.
