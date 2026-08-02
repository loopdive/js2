---
id: 4059
title: "`__bindfn` invalid-Wasm cluster — 28 corpus-wide / 25 host-pass, one validation message, root-caused to `compileFunctionBind`'s standalone arm"
status: ready
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
---
# `__bindfn` invalid-Wasm cluster — 28 corpus-wide / 25 host-pass, one validation message, root-caused to `compileFunctionBind`'s standalone arm

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
