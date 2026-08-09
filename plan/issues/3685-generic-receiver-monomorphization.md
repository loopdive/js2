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
status: suspended
assignee: ttraenkler/dev-acorn-codegen
created: 2026-07-27
updated: 2026-07-31
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

## Suspended Work (2026-07-31)

Suspended by a priority switch to standalone ES5, **not** by a blocker. No
compiler source was changed — everything below is measurement and analysis, all
of it already committed.

- **Worktree**: `/workspace/.claude/worktrees/agent-a6d23a0529f6d6f17`
- **Branch**: `issue-3685-receiver-proof-widening` (pushed to `fork` =
  `ttraenkler/js2`, PR loopdive/js2#3868); `origin/main` merged in.
  **That branch also carries the #2908 / #3686 / #3688 work and will be deleted
  when the PR merges — do NOT plan to resume from it.** Resume from `main` once
  #3868 lands; this note travels with the issue FILE, not with the branch, and
  the branch contains no compiler source changes to recover.
- **Claim**: `ttraenkler/dev-acorn-codegen` — released at suspension. Verify
  with `git show origin/issue-assignments:3685.json` before re-claiming; the
  release path has a known ref-lock race with no retry.

**Done**: the coverage audit, the receiver histogram and the caller attribution
below; the profile decomposition and the optimizer negative in #3686. **Not
done**: any codegen change; any wall-clock A/B (the box ran at load 7-14 on 10
cores for the whole session, which invalidates timing at this effect size).

**Resume in this order** — the first step is a measurement, not code, and it
decides whether this issue continues at all:

1. **Instrument the proven-but-not-inlined path.** Add a decline-reason counter
   to the carve-out branches of `tryEmitProvenReceiverFieldGet`
   (`src/codegen/typed-this.ts` ~L1320-1460: `RESERVED_PROPS`,
   `classAccessorSet`, presence-tracked, call-signature receiver, and
   name-not-a-declared-field). One acorn compile then explains the **156**
   proven receivers that produced no inlined read (244 verdicts vs
   `provenFieldStats.gets=88`).
   - dominated by *not-a-declared-field* ⇒ this issue closes; file the
     object-literal shape work separately;
   - a carve-out is over-broad ⇒ landable fix here, and the two hot twins
     (`__closure_571__typed_this`, `__closure_347__typed_this`, together
     **28.5 %** of the `__extern_get` bucket) are what pays for it.
2. **Settle whether `types$1` already has a struct.** `src/codegen/object-ops.ts`
   (~L1642-1666) resolves an object-literal initializer to a struct name by
   field-name matching. If a ~50-property module-level literal gets one, the
   40 % `types$1` residue may be one flow rule in
   `receiver-flow-analysis.ts`, not a new analysis.
3. Only then measure, with #3673's interleaved duplicate-baseline control arm,
   **on an idle box**.

### Which layer does this belong on? (IR vs backend — my judgement)

Asked explicitly, because this issue sits on the boundary. **It splits, and the
split is clean — the seam is already where it should be:**

- **The PROOF belongs in the IR front end.** `receiver-flow-analysis.ts` asks
  "does this expression always denote an instance of class `F`?" That is a
  question about *meaning*, answered from the AST with no checker queries and no
  `ValType` anywhere in its result type (`ReceiverVerdict` is a class NAME plus
  a proof source). It would be identical for a linear-memory backend, which is
  the operative test from `docs/architecture/codegen-axes.md`. Same for
  `numeric-property-analysis.ts` (which property names are always written
  numerically) and the write-once prototype verdicts. Today all three live under
  `src/codegen/` for historical reasons, not architectural ones.
- **The LOWERING belongs in the backend, where it already is.** `struct.get` at
  field index `i` off a `ref.cast $__fnctor_F`, the `ref.test` guard, the
  trampoline ABI, the f64-vs-externref slot decision — every one is a WasmGC
  representation choice with a different linear-memory answer. `typed-this.ts`
  is correctly backend code.

So the migration this issue would want is **not** "move #3685 into the IR"; it
is *move the three analyses* into the front end and have the backend consume
their verdicts. That is a refactor with no behavioural change, and it is worth
doing only when a second backend actually wants the verdicts — the linear lane
is the obvious consumer, since a proven receiver is exactly as useful for a
struct offset in linear memory as for a `struct.get`. **Do not fold that
refactor into a perf slice**; it would make an already hard-to-measure change
impossible to attribute.

One caveat for whoever does move them: the analyses are currently *seeded* from
backend state — the S2 approved-class set is read from `ctx.structMap`'s
`__fnctor_*` keys (see the "two false starts" note above, where seeding it from
`gate.methods.keys()` silently excluded data-only classes). A front-end version
needs its own class registry rather than borrowing the backend's.

**Reproduce the measurements**: probes are in `.tmp/cw/` in the worktree
(`acorn-compile-raw.mjs` compiles standalone acorn with an in-module `__bench`
export at `optimize: 0`; `profile-parse.mjs`, `analyze-prof2.mjs`,
`attrib-helper.mjs`, `cross-metrics.mjs`). `.tmp/` is gitignored, so re-create
them from this description if the worktree is gone.

## Coverage audit 2026-07-31 — #3683's twin machinery is saturated; THIS issue's
## S2 inline path is NOT, and the gap is unmeasured

S1-S3 landed and S4 was falsified, so the question this audit answers is: **on
real acorn, how much is left?** The honest answer has two halves, and an earlier
draft of this section wrongly collapsed them into "saturated" — corrected here
before it could mis-dispatch anyone.

**Half 1 — #3683's twin emission and direct calls ARE saturated.** Those
counters are quoted below and they are unambiguous.

**Half 2 — this issue's own S2 inline path is not, and I did not measure why.**
`declinedTwin=0` is #3683's *twin-emission* counter; it says nothing about
#3685. #3685's counter is `provenFieldStats.gets`, which printed **88** against
**244 proven receiver verdicts** (184 `Node` + 60 `Parser`). So **156 proven
receivers produced no inlined read** — they were proven and then dropped by one
of the carve-outs (`RESERVED_PROPS`, `classAccessorSet`, presence-tracked
fields, call-signature receivers, or "the name is not a declared field of the
struct"). **Which carve-out, and in what proportion, is UNMEASURED.** Some of it
is certainly legitimate — `node.body` / `node.declarations` are expando
properties, not declared `$__fnctor_Node` fields — but the split is not known
and must not be assumed.

Corroborating that the S2 path still has reachable work: **28.5 % of
`__extern_get`'s self time is called from inside typed twins**
(`__closure_571__typed_this` 14.4 % + `__closure_347__typed_this` 14.1 %; see
the caller table below) — ≈2.8 % of total parse time. Inside a twin `this.X` is
already inlined, so every one of those is a **non-`this` receiver read**, which
is exactly the shape S2 exists to take. If S2 were saturated, those calls would
not be happening.

**The one measurement that discriminates**, for whoever continues: add a
decline-reason counter to the proven-but-not-inlined branches of
`tryEmitProvenReceiverFieldGet` (`src/codegen/typed-this.ts` ~L1320-1460) and
run one instrumented acorn compile.
- Dominated by *not-a-declared-field* ⇒ the object-literal/expando story below
  is right and this issue closes.
- A carve-out is over-broad ⇒ that is a landable #3685 fix, and the two hot
  twins above are the target that pays for it.

**Instrumented compile of real acorn 8.16.0** (standalone, whole 226 KB package
plus a bench driver, `JS2WASM_TYPED_THIS_DEBUG=1 JS2WASM_DIRECT_CALLS_DEBUG=1`):

```
[typed-this]   twins=488 declinedTwin=0 get=1366 set=98 compound=18 incdec=98
[direct-calls] sites=3980 trampolines=547 twinFills=518 genericFills=29 legacyFills=0
[direct-calls] declined: no-write-once-verdict=208 named-fn-expr=16 uses-arguments=8
```

- **`declinedTwin=0`** — every candidate prototype method got a typed twin.
- **518 of 547 trampolines fill to a twin**, 29 degrade, **0** fall back to
  legacy.
- Field-inline declines are essentially empty: the `[typed-this] declined
  fields` histogram is 24 `ok:` entries (admitted) and exactly two real
  declines, `nofield:inAsync=6` and `nofield:inTemplateElement=6` — option
  flags that are not struct fields at all.

**Where the residual `__extern_get` actually comes from.** Attributing
`__extern_get`'s own self time to its CALLER in the profile (9.69 % of total
across 11,071 samples; see #3686 for the harness):

| caller | share of `__extern_get` | absolute |
| --- | ---: | ---: |
| `__extern_method_call` | 18.7 % | 1.82 % |
| `__fnctor_Node_new` | 15.2 % | 1.47 % |
| `__closure_571__typed_this` | 14.4 % | 1.40 % |
| `__closure_347__typed_this` | 14.1 % | 1.36 % |
| `__closure_339` (no twin) | 8.5 % | 0.82 % |
| `finishNodeAt` | 6.3 % | 0.61 % |
| `getOptions` | 2.2 % | 0.22 % |

Note the top entry is a *helper* (`__extern_method_call` doing its own
name lookup), not a source-level `x.f` read — so ~19 % of the bucket is not a
receiver-proof target at all.

**And the shapes that decline.** `tryEmitProvenReceiverFieldGet` was asked for a
verdict **3,444** times over the acorn compile: **3,200 unproven (92.9 %)**, 184
→ `Node`, 60 → `Parser`, with only 88 reads actually inlined. Histogramming the
3,200 unproven receivers by source text:

| receiver | sites | what it is |
| --- | ---: | --- |
| `types$1` | **1,287 (40 %)** | acorn's **token-type table** — a module-level `var` bound to an object literal |
| `state` | 434 (14 %) | the RegExp validator's `RegExpValidationState` parameter |
| `node` | 255 | `Node` instances the flow analysis did not reach |
| `prop`, `expr`, `refDestructuringErrors`, `ref`, `list`, `element`, … | ≤136 each | assorted parser locals |

**The finding that matters: the single largest unproven receiver is not a class
instance.** `types$1` is `var types$1 = { num: new TokenType(…), name: …, eof:
…, semi: … }` — a plain **object literal**, read 348 times in acorn's source on
its hottest comparisons (`this.type === types$1.eof`, `this.eat(types$1.semi)`).
This issue's analysis proves "is this an instance of exactly one approved
**fnctor** class"; an object literal has no fnctor class, so no amount of
widening the *flow* rules reaches it. Same for `parser.options.<x>` (15.2 % of
the bucket, via `__fnctor_Node_new`): `parser` **is** already proven, but
`options` is an `externref` slot holding an object literal, so the second hop
has no shape either.

**What the residue needs — and an explicitly OPEN question about how much of it
is new.** The mechanism required is *shape* proof for non-fnctor objects: "this
receiver is always the module-level object literal `L`, whose property set is
fixed", plus a struct to `struct.get` from. It composes with the existing
guarded emitter (`ref.test` → `struct.get` : fall back to `__extern_get`), which
makes escape/mutation soundness a non-issue — `types$1` *is* exported (`export {
types$1 as tokTypes }`, plus `tokTypes: types$1` in the public surface), but a
failed `ref.test` simply takes the dynamic arm.

**Do NOT assume this is a from-scratch capability.** `src/codegen/object-ops.ts`
(~L1642-1666) already resolves a variable whose initializer is an object literal
to a struct name — first via `resolveStructName(ctx, initType)`, and on `ts.Type`
identity mismatch by **matching the literal's property names against
`ctx.structFields`**. So the compiler does mint structs for object literals and
can already map a binding to one. Whether `types$1` (a ~50-property module-level
literal) gets such a struct today is **not measured**; if it does, this may be
one flow rule in `receiver-flow-analysis.ts` rather than a new analysis. Settle
that before scoping the work either way.

Sizing for whoever picks that up: 40 % of unproven receiver *sites*, on the
hottest comparison in a tokenizer, and the two profiles agree the whole
`__extern_get` bucket is 8-10 % of standalone parse time — so the ceiling for
the `types$1` half is low single digits, **and it must be measured with the
duplicate-baseline control arm before anyone believes it.** No wall-clock A/B
was run for this audit: the box was at load 7-14 on 10 cores throughout, which
invalidates timings at this effect size. Every number above is a static tally or
a profile share, both of which survive contention.

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

## Step-1 result (2026-08-01) — the 156 are measured: 100 % presence-tracked

The decline census the suspension note asked for is landed
(`src/codegen/proven-receiver-stats.ts`, `JS2WASM_PROVEN_RECEIVER_STATS=1`,
inert otherwise; pinned by `tests/issue-3685-decline-stats.test.ts`) and run
over one standalone acorn 8.16.0 compile (226 KB dist + the
`__npmCompatStandaloneBenchmark` inline driver, `target: "standalone"`,
`optimize: 0`).

```
[proven-receiver] asked=4002 proven=244 inlined=88 declinedAfterProof=156
```

`proven=244` and `inlined=88` reproduce the audit's figures exactly. The 156
break down as:

| decline reason                        | sites   | share of 156 |
| ------------------------------------- | ------: | -----------: |
| `presence:Node.<f>` (externref field)  | **144** |    **92.3 %** |
| `reserved:Node.name`                   |      12 |       7.7 % |
| `nofield:` (name not a declared field) |   **0** |         0 % |
| `accessor:` / `callsig:` / `no-struct` |       0 |         0 % |

Sums to 156 exactly. Every one of the 144 presence declines is an **externref**
field of `Node` (`loc`/`raw`/`local` 16 each, `key`/`argument` 12 each,
`exported`/`imported`/`expressions`/`operator`/`value`/`property` 8 each,
`id`/`body`/`static`/`quasis`/`properties`/`generator` 4 each). The 12
`reserved:Node.name` sites are annotated `presence-tracked`, i.e. `name` **is**
a declared, presence-tracked slot of `$__fnctor_Node` — so removing the
`RESERVED_PROPS` carve-out alone would just move those 12 into the presence
bucket. **Effectively 156/156 of the miss is the presence-tracked carve-out.**

**Verdict against this issue's own decision rule: the `nofield:` bucket is
ZERO, so the "dominated by not-a-declared-field ⇒ close this issue" branch is
FALSIFIED.** The object-literal/expando story is still real for the 3,758
*unproven* receivers (that is where `types$1` lives), but it explains none of
the proven-but-not-inlined gap. A carve-out is over-broad, so there is a
landable fix inside #3685.

**What the fix is** (described, deliberately NOT implemented in the
instrumentation pass): the carve-out's stated reason — "absence is semantic
(`undefined`), which a bare `struct.get` cannot express" — is true of a bare
`struct.get` and false of the compiler. `emitNullGuardedStructGet`
(`src/codegen/property-access.ts` ~L1280-1297) already emits exactly the needed
shape for a presence-tracked closed-struct read: `presenceTestInstrs` → `if`
→ `struct.get` : `undefinedExternInstrs`. The proven-receiver emitter can nest
that inside its existing `ref.test` then-arm; the `else` (dynamic
`__extern_get`) arm is unchanged. All 144 sites are externref, so the absent
value is a real `undefined` and no f64-default hazard arises — but the
lowering must still refuse a non-externref presence-tracked field, where
`defaultValueInstrs` would silently substitute `0` for `undefined`.

Not measured here, and required before believing it pays: a wall-clock A/B with
#3673's interleaved duplicate-baseline control arm on an idle box. The
attribution table above says the two hot twins
(`__closure_571__typed_this` + `__closure_347__typed_this`, 28.5 % of the
`__extern_get` bucket ≈ 2.8 % of parse time) are the plausible payer, but
nothing in this step measured time.

## Step-2 result (2026-08-01) — the presence carve-out is removed: 88 → 232 inlined

The over-broad carve-out identified by step 1 is gone.
`tryEmitProvenReceiverFieldGet` now admits presence-tracked fields by nesting
the presence test inside its existing `ref.test` then-arm, reusing
`presenceSlotOf` / `presenceTestInstrs` from `fnctor-presence-bits.ts` — the
same shape `emitNullGuardedStructGet` already emits for closed-struct reads:

```
local.get tmp ; any.convert_extern ; ref.test $F
if (result <fieldType>)
  then  local.get tmp ; any.convert_extern ; ref.cast $F ; local.tee c
        ; <presence test on c>
        ; if (result <fieldType>)
            then  local.get c ; struct.get $F <idx>
            else  <undefined>                     ; #2106 singleton
  else  __extern_get(tmp, "<name>")               ; unchanged dynamic arm
```

The cast result is teed into a `(ref null $F)` local so the guarded arm pays
one `ref.cast`, not two.

**Hard correctness condition, explicit in the code**: only **externref**
presence-tracked slots are admitted (`presence-nonextern:` decline otherwise).
`undefined` has an externref-plane representation; it has none in an f64/i32/i64
slot, where the absent arm could only substitute `0`. Also reordered: the
call-signature check now runs *before* the presence decision, so a name that
resolves to a prototype method can never be answered `undefined` by the absent
arm.

**Census, same instrumented standalone acorn 8.16.0 compile as step 1**
(prediction stated before the run: 232 / 12 — confirmed exactly):

| | asked | proven | inlined | declinedAfterProof |
| --- | ---: | ---: | ---: | ---: |
| step 1 (before) | 4002 | 244 | 88 | 156 |
| **step 2 (after)** | 4002 | 244 | **232** | **12** |

All 144 `presence:Node.<f>` sites converted to `ok:Node.<f>:externref:presence`.
The residue is exactly the 12 `reserved:Node.name` sites (`RESERVED_PROPS`,
deliberately untouched — `name` has a dedicated lowering). **Zero
`presence-nonextern:` entries**: every presence-tracked slot in acorn is
already externref, which is also why the emitter widens a conditionally
assigned numeric field (`P.y` in the pins) to `externref` rather than `f64`.

Pinned by `tests/issue-3685-presence-tracked-proven-reads.test.ts`: a
presence-tracked field read **before** it is ever assigned yields `undefined`
(not `null`, not `0`, not a trap) and after assignment yields the value, both
checked against the same source evaluated as plain JS; plus the census
assertion that the read takes the inline path, and the structural pin that a
`:presence` admission always carries an externref slot type. Paired control
run: with `src/codegen/typed-this.ts` reverted the census assertion FAILS
(the semantics assertions pass either way — the dynamic `__extern_get` arm
answers the same values, which is precisely why the path assertion is the
load-bearing one). `tests/issue-3685-decline-stats.test.ts` updated: its
`p.y` case is now an admission, and a never-assigned `p.nope` supplies the
`nofield:` decline it needs.

**No wall-clock measurement was taken** — the box was not verified idle, and at
this effect size a contended timing is worse than none. The payer named by the
attribution table (`__closure_571__typed_this` + `__closure_347__typed_this`,
28.5 % of the `__extern_get` bucket) remains a hypothesis until someone runs
#3673's interleaved duplicate-baseline control arm on an idle box.

## Cross-box caveat on this issue's ranking (#3780 round 4, 2026-07-31)

Every share quoted in this issue comes from a profile of the standalone acorn
self-parse. A fourth profile, taken on a **4-core Linux container / Node
22.22.2** (rounds 1-3 of #3780 and both cross-validated profiles above were
Node 24 / arm64 macOS), disagrees on one bucket by an order of magnitude:

| bucket | Node 24 / macOS profiles | Node 22 / Linux container |
| --- | ---: | ---: |
| GC | 1.5% and 4.3% | **24-37%** |

The Linux figure is corroborated by an independent, profiler-free measurement
(summing inter-GC heap growth from `--trace-gc`: 22.5 ms of a ~120 ms parse
after #3780 round 4's lowerings, 30.1 ms before). I do not know whether the
cause is the V8 version, heap sizing, or the container.

**Why it matters here:** the non-GC buckets are shares of a denominator that
moves with it. If GC is really ~2% on the reference hardware, this issue's
share is correspondingly *larger* there than the Linux profile suggests, and
allocation-side work (#3921/#3927) is correspondingly smaller. Re-measure on
the target hardware before using any of these shares to sequence work.

## Allocation evidence for this issue (#3921 census, 2026-07-31)

This issue has been argued on time shares. The allocation census adds an
independent, deterministic measurement that points at the same place, and it
reframes what "reduce allocation" means for the standalone lane.

Per 226 KB acorn parse, 647,346 allocations. The two largest families:

| family | count/parse | share | what it needs proven |
| --- | ---: | ---: | --- |
| `$AnyValue` box | 310,485 | 47.96% | the **value's type** at the producer |
| generic-dispatch argument vectors | ~87,000 | 13.5% | the **callee** at the call site |

Neither is an allocator defect. Both are the price of an unproven type:
a value whose type is not known must be widened into a 5-field tagged carrier,
and a call whose target is not known must marshal its arguments through the
heap. **Roughly 61% of all allocation in the parse exists because something
was not proven.** That is this issue's axis, measured from the allocation side
rather than the timing side.

Two attempts to attack the allocation directly were measured and both failed,
which is why the work belongs here rather than in an allocator fix:

- **Binaryen `Heap2Local` promotes ZERO sites** on the shipped binary, under
  `--heap2local`, `--closed-world --heap2local` and `--closed-world --gufa
  --heap2local` alike. The optimizer cannot see through the generic calls the
  boxes escape into.
- **Sharing one empty argument vector for zero-arity dispatch** removed only
  840 allocations (0.13%) and was reverted. The zero-arity arm fires 420 times
  per parse against 43,527 `__objvec_new` calls; the mass is genuine N-argument
  marshalling, not wasted empty containers.

Sizing note, so this is not over-sold: the whole dispatch family
(`__call_m_*`, `__call_fn*`, `__extern_method_call`, `__apply_closure`,
`__objvec*`, `__method_cache_lookup`) is **3.87% of parse self-time**, spread so
thin that no single dispatcher exceeds 0.08%. So devirtualization's payoff is
NOT mainly the dispatch time — it is the allocation and the downstream
`$AnyValue` widening that the generic path forces. Anyone sizing this issue off
the 3.87% alone will under-value it; anyone sizing it off the 61% will
over-value it. The honest statement is that the two are coupled and neither has
been measured in isolation.

Current admission rate remains this issue's S1 figure: **150 of 2,363**
non-`this` accesses (6.3%).
