---
id: 4537
title: "merge_group gate admitted PR #4629 carrying a −42/−44 per-lane regression, then parked the two innocent PRs behind it — determine the admission hole"
status: ready
created: 2026-08-16
sprint: current
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
goal: ci-hardening
related: [2547, 3448, 3467, 1235, 2562]
---

# The gate caught the wrong PRs

## Facts (2026-08-16, all from the record)

- PR #4629 (`fix(#1888): Array.isArray static fast path…`, merge `cccbaa4ba`,
  07:20Z) regressed ~42 standalone / 43 host test262 files (all assert
  `Array.isArray`; dstr rest-from-exhausted-iterator family + Object/entries).
  Reverted by PR #4634.
- #4629's OWN merge_group re-validation PASSED — it merged.
- The next two queue entries, PR #4631 and PR #4627 (mutually unrelated, and
  both unrelated to isArray), were auto-parked at ~07:42Z with the IDENTICAL
  bucket signature (standalone `37d9311a9cb806e4` 42 files; host run
  31933649385/job/95134197756: 43 regressions / 3 improvements, net −40), and
  the drift warning "baselines JSONL is 1 test262-relevant commit behind main
  HEAD (83m)" — that one commit being #4629.

## Question to answer (do not assume)

How did #4629's merge_group pass? Candidate mechanisms, all checkable:

1. Its shard matrix was skipped (`&test262-paths` anchor mismatch) so the
   regression gates green-skipped — but the diff touched
   `src/codegen/expressions/call-builtin-static.ts` and
   `src/codegen/object-runtime.ts`, which should trigger shards.
2. Per-SHA merge-base baseline reuse (#3448/#3467) picked a baseline that
   already contained the failures, or missed the comparison.
3. The regressions only manifest against the corpus state present AFTER a
   subsequent merge (interaction) — unlikely (#4630 was docs-only) but rule out.
4. A gate-ordering/quarantine path (e.g. the union-only quarantine seen on
   `async-gen-meth-static-dflt-ary-ptrn-rest-id-exhausted`) swallowed the
   cluster on #4629's run but not on followers.

Pull #4629's merge_group run, read which jobs ran shards, which baseline SHA
each gate compared against, and write the mechanism here. Acceptance: the
mechanism is named from run logs (not inferred), and either a fix PR for the
admission hole or an explicit "working as designed, here is the invariant"
verdict with the invariant stated.

## Why it matters

A queue whose gate passes the offender and parks its followers converts every
real regression into (a) a silently lowered floor if baseline promotion runs,
plus (b) one wasted ~19-minute merge-group run per innocent PR behind it. The
detector failed exactly where it cannot say "I don't know" (see MEMORY
CRITICAL RULES).
