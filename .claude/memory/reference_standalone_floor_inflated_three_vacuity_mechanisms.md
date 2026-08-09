---
name: reference_standalone_floor_inflated_three_vacuity_mechanisms
description: "Three MEASURED mechanisms that make standalone test262 report PASS for tests that should FAIL — bare top-level throw dropped, dynamic-string sameValue false-positive, verifyProperty vacuous past its a1 gate."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-25T02:14:40.079Z
---

**The standalone lane reports PASS for tests that should FAIL, via three independent
mechanisms** — measured 2026-07-24 by dev-opus5-mop while doing the #2984 ctor-carrier
slice. All three are PRE-EXISTING and independent of that change. Each inflates the
committed standalone floor, so any "standalone pass rate" is an overstatement until
they're fixed.

1. **Bare top-level `throw` is silently dropped.** A test whose only statement is
   `throw new Test262Error("HELLO")` reports **pass**. **CORRECTED 2026-07-24
   (dev-floor-truth):** this is **NOT standalone-specific — the HOST lane drops it too.**
   Exact cause, 3 lines: `src/codegen/declarations.ts:1522` —
   `if (ts.isThrowStatement(stmt)) { if (ctx.wasi) ctx.moduleInitStatements.push(stmt); continue; }`
   — #2968 deliberately scoped that collection to WASI. Corpus footprint measured with the
   TS parser over the whole tree: **40 files** have a top-level ThrowStatement (of 19,202
   that mention `throw`), and almost all are `negative:` tests — so the likely flip
   direction is **fail→pass, not floor inflation**. Small lever, real bug.
2. **~~Dynamic-string `sameValue` false-positives~~ — WRONG DIAGNOSIS. The real cause is an
   ARITY bug, and it is far bigger.** **EVERY `assert.*` is vacuous in standalone** —
   `sameValue`, `notSameValue`, `throws`, all of them. It has nothing to do with strings:
   `assert.sameValue(1,2)` does **not** fail either.
   **Mechanism:** calling a function-object static with **FEWER args than the callee's
   declared params** silently returns `undefined` in standalone. `assert.sameValue(1,2,"msg")`
   (3 args, 3 formals) throws CORRECTLY; `assert.sameValue(1,2)` (2 args, 3 formals) is
   vacuous. `fillApplyClosure` (`src/codegen/object-runtime.ts:4592`) dispatches on
   `n = args.length` only, and `emitClosureMethodCallExportN`
   (`src/codegen/closure-exports.ts:498`) filters `paramTypes.length > arity`, so **no arm
   matches** and the bridge returns its undefined sentinel. The **host lane already fixed
   this in JS** via `max(args.length, __closure_arity(fn))` (#2623 P-7); the in-Wasm bridge
   never got the same fix.
   **MEASURED SIZE — supersede the earlier N=200 figure. N=4,000 uniform sample (seed
   20260725, Fisher-Yates/mulberry32, both arms in ONE process/runner, base `501374bf` =
   RC2 alone before RC1 merged): pass→fail 453 of 2,395 sampled passes = 18.9% vacuous.
   Genuine gains 0.** Sample counts; deliberately NOT scaled to a corpus number.
   **Widening-introduced invalid Wasm: 0** — classifier = innermost wasm frame (a
   dispatcher-introduced trap must be `__call_fn_method_N` ITSELF); 445/453 flips carry no
   wasm frame, the 8 that do are user closures/helpers. **fail→fail signature delta 6 of
   1,202**, so #3439's hard-0 gate has nothing to park on.
   **NO new `STANDALONE_ROOT_CAUSE_BUCKETS` entry is needed** — the router passes on BOTH
   arms with 0 unclassified (OFF 1,204/1,204, ON 1,658/1,658); all 16 ON-only signatures
   route into existing buckets because the standalone matchers are predominantly PATH-based.
   That takes cluster-routing OFF the landing critical path.
   The "blocker" (illegal cast) was REFUTED on two independent files by exact-arity and
   widening-off controls — pre-existing, merely unmasked. Remaining hazard (`i32`/
   non-nullable-`ref` formals with no undefined inhabitant) did NOT fire in 4,000 pairs;
   `minSafeN` fix sketch recorded, to be coded ONLY if the classifier fires on the landing run.
   **It does NOT subsume mechanism 3 — measured and REFUTED.** With the arity fix ON and
   OFF, `verifyProperty(Math.abs,"name",{…writable:TRUE})` (deliberately wrong expectation)
   is *identically non-throwing* in both arms. The arity fix un-vacuums the `assert.*`
   family only. **Treat the `verifyProperty` lever as a separate, still-unexplained root
   cause.** (The lead hypothesised they were one bug; measurement said no.)
3. **`verifyProperty` is vacuous past its a1 gate.** Wrong `value` / `writable` /
   `enumerable` / `configurable` expectations all still report pass; only the first
   (own-property-exists) assert is live. Mechanism: `verifyProperty` accumulates failures
   via `__push`/`__join` (`Function.prototype.call.bind(...)` — the **uncurryThis**
   family), which misbehaves standalone, so the terminal `assert(false, …)` never fires.
   Scale: **4,735 files call `verifyProperty`; only 1,190 pass standalone.** This is the
   uncurryThis half of the PH wall.

**How it was proven (reusable method — A/B wrong-expectation control).** Feed the harness
a *deliberately wrong* expectation and see whether it still passes. Decisive control here:
`verifyProperty(Math.abs, "name", {…writable: TRUE})` passed on an **untouched** #2896 path
even with the new seeding force-disabled — establishing the vacuity as pre-existing rather
than introduced. Use this before crediting any harness-mediated pass count.

**Reporting rule this forces.** Cite harness-gated wins as **"+N rows, a1-gate-earned"**,
never as "+N conforming descriptors". To assert the underlying semantics are real, verify
with independent `===` reads in a vitest suite (numeric `length`, object-identity
`prototype`) rather than through the harness. See [[feedback_measure_never_extrapolate]].

**Related substrate finding:** `Object.prototype.hasOwnProperty` / `gOPD` still answer
false for ANY runtime receiver that is not a native-fn closure or an `$Object` — including
plain object literals (typed structs) and native protos. That, not gOPD-on-builtins, is
the real substrate under this cluster.

Same family as [[reference_standalone_floor_inflated_by_exception_swallow]] (assert fails
vacuously) and the de-inflation program in
[[reference_f1_honest_floor_deinflation_landing_recipe]]. Fixing 1 and 2 will push the
measured floor DOWN — that is correct and expected, not a regression.
