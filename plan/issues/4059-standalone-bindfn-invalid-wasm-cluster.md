---
id: 4059
title: "`__bindfn` invalid-Wasm cluster — ATTRIBUTION REFUTED: not `Function.prototype.bind`; real cause is an operand-stack miscount in `fixupExternConvertAny` (fixed by #4072)"
status: wont-fix
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: standalone-mode
related: [4072]
---
# `__bindfn` invalid-Wasm cluster — attribution refuted, superseded by #4072

## ⚠ CORRECTION 2026-08-02 — do NOT work this issue as originally written

**The root cause below is WRONG, and acting on it would send you to modify code
that is not at fault.** Refuted the same day it was filed, by the `H-crashes`
agent, with a reduced repro.

**What the original said:** the cluster is root-caused to the standalone arm of
`compileFunctionBind`, `src/codegen/expressions/calls.ts:2277-2300`, because the
failing WAT is full of `$__bindfn_tgt_*` locals.

**Why that is wrong:** those locals are the first ~200 characters of
`__module_init`'s **locals list**, and they come from `propertyHelper.js`'s own
prologue (`Function.prototype.call.bind(Array.prototype.join)`), which runs
~150 KB of bytecode *before* the failing instruction. **`bind` is incidental to
the crash.** The reduced repro is **8 lines with no `bind` in it at all**.

This also explains the observation already recorded further down this page — that
a synthetic `call.bind` probe validates fine. That was the refutation sitting in
plain sight: the probe did not reproduce the defect because `bind` was never the
mechanism.

**The real cause** — `fixupExternConvertAny` in `src/codegen/fixups.ts`. It
rewrites `ref.null.extern` → `ref.null $T` for GC-ref params, and located "which
argument produced this instruction" by walking **backward assuming one
instruction == one argument**, with a hand-maintained list of exceptions
(`local.tee`, `struct.new`, `array.new_fixed`, `call`). **`extern.convert_any`
was missing from that list** — and it is emitted on essentially every boxed
argument — so it burned a param index and the `null` at argument 2 received
argument 1's `(ref null $AnyString)` type.

Same shape as #3989: two halves that must agree about a slot type, living apart.
Fixed by modelling the operand stack properly (exact pops/pushes plus a forward
producer-index pass) rather than adding a fifth entry to the exception list.

**Resolution: superseded by #4072 (PR #4007).** Measured there: population 53
goal-scope `invalid Wasm binary`, mechanism 28, reachable 28, **flips 24**,
kill-switch control 28/28 fail with the fix reverted, and 0 attributable
regressions in a 500-file seeded sample.

**Anyone holding a bind-lowering task for these files should drop it.**

---

## Original report (retained for the record — attribution refuted above)

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Handed off unclaimed by s78-dev2 on standing down from #2742. Root-caused but not fixed.

**The cluster.** 28 files corpus-wide emit invalid Wasm, **25 of them host-PASS** (so standalone-only defects). All produce a **single** validation message:

```
call[N] expected type externref, found ref.null of type (ref null N)
```

with locals `__bindfn_tgt` / `__bindfn_arg` / `__bindfn_args` — pointing at the **standalone arm of `compileFunctionBind`**, `src/codegen/expressions/calls.ts:2277-2300`.

**⚠️ The repro is the hard part — read this before starting.** dev2 built a synthetic `Function.prototype.call.bind(...)` probe and it **VALIDATES FINE**. Its positive control was green, so the instrument was live — the synthetic simply does not trigger the defect. **The trigger needs the full `propertyHelper` / `verifyNotWritable` shape.** Budget for reproducing it from a real corpus file rather than a minimal case, and do not conclude "cannot reproduce ⇒ not real" — 28 files say otherwise.

**Attribution boundary — this does NOT double-count against #3571.** It is a **compile-time** sub-mode, distinct from the **runtime receiver-drop** mode #3571 documents. #3571's own S1 analysis (branch `issue-3571-uncurrythis-s1`, `66ab19f84`, still with no PR — task #16) states the **host arm is done via #3635 and only the standalone arm remains**. Read that analysis first rather than re-deriving it.

**Relationship to the larger P3 work (task #44):** same broad seam (`propertyHelper`/uncurryThis), but this is a small, sharply-defined, already-root-caused slice with a single validation signature — so it is worth doing **independently and in its own PR**, and it may serve as a cheap first probe into the seam before the XL P3 effort commits.

**Method to reuse** (proven on the sibling levers this sprint): paired per-file A/B in one process; an in-sweep control that must NOT move; rows floored in both arms; and a final arm with any measurement scaffold deleted, to prove the *shipped* code produces the result rather than the switch.

25 host-pass is the population **gated**, not a flip forecast. Sample and report the measured ratio with its denominator.
