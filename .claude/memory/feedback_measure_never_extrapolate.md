---
name: feedback_measure_never_extrapolate
description: "THE measurement rule (user: make permanent, 2026-07-23). Never size or claim work by extrapolation. Compiles ≠ passes. Gates-N ≠ flips-N. Signatures lie about their cause. The coordinator's hypotheses get measured too — 4 of the lead's were wrong in one day."
metadata:
  node_type: memory
  type: feedback
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
  modified: 2026-07-23T16:03:07.523Z
---

**User directive (2026-07-23): make this permanent, for the lead AND every agent.**
It caught four wrong hypotheses in a single day — all four the LEAD's — and stopped a
"~1,200 tests" claim from reaching a PR body. It is the highest-value discipline we have.

## The rule (seven parts)

1. **MEASURE before building, and again before claiming.** Never size work from a cluster
   label, a category table, or a signature share. Run the real files; count actual flips.
   *Evidence: a 29% signature share projected ~1,190 flips; measured **2 of 198** — 600× off.*
2. **"Compiles" ≠ "passes."** Gate every win on **measured runtime PASS**. Converting a
   compile error into a runtime trap is **%-neutral** — it moves the failure, not the score.
   Whole families in this project were CE→valid-but-still-failing "wins".
3. **"Gates N tests" ≠ "flips N tests."** Defects are frequently LAYERED. Even a *measured*
   gate ("all 311 rows execute this function") can yield **zero** flips because another layer
   sits behind it. *Evidence: 311 → fix → **0 flips** → second fix → 290.* Only a post-fix
   re-measure settles it. Budget multi-layer families as chains of unknown length.
4. **Error signatures lie about their cause ("echo signature").** The reported message is
   often produced by whatever code *reacts* to the defect, not by the defect. Trace to the
   emitting site (WAT/instrumentation) before believing the subsystem named in the message.
   *Evidence in one day: a "Cannot destructure" cluster manufactured by the test template
   from a null rejection reason; an "async continuation" cluster that was an arity trap;
   a "regexp .index" mirage; an error-ctor "mega-lever" that was a narrow static shape.*
5. **The coordinator's hypotheses get measured like anyone else's.** The lead sees AGGREGATES
   (counts, shares, tables) — exactly the altitude at which "29% of the sample" *feels* like
   "29% of the tests." It repeatedly wasn't. Agents see compiled output and real results.
   *In one day the lead was wrong on: "biggest defect on the board" (measured ~106 candidates),
   "super-linear perf bug" (measured perfectly linear), "the cliff may collapse to one cause"
   (measured 104 signatures), and the ~1,190 extrapolation.* **Never let an agent defer to a
   lead hypothesis — instruct them to prove or disprove it.**
6. **Always report DENOMINATORS.** "19 of 49", not "19 flips". Sample + extrapolation must be
   labelled as such and separated from measured counts.
7. **Report the HONEST SPLIT.** Newly-scored tests that now FAIL matter as much as those that
   pass. An observability fix that makes 3,258 tests scoreable (2,271 pass / 985 fail) must be
   reported both ways. Never bank only the good half.

## Corollary — vacuous passes make real work look like regression

Where assertions don't actually run, a correct fix can measure **+14 real wins / −22 visible
regressions**, and CI sees ONLY the −22. Improvements inside vacuous-pass territory are
INVISIBLE to the pass count. Anyone optimising the visible metric would abandon correct work.
See [[project_test262_lane_parity_program]], [[reference_host_restore_triage_verify_first_measure]].

## Where it must live (not just here)

This rule existed ONLY in the lead's memory and in ~15 hand-typed agent messages until
2026-07-23 — it died with the session. It must be in **CLAUDE.md** and the
**pre-completion checklist** so it is enforced rather than remembered.
