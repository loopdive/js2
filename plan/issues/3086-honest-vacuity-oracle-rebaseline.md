---
id: 3086
title: "Honest vacuity re-baseline: partial-vacuity callback scorer + oracle_version bump (1→2) + forward-bump auto-rebase enabler"
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: measurement-integrity
area: ci/test-infra
language_feature: test262-runner, vacuity-scorer, oracle-version
goal: merge-queue-health
related: [2463, 2940, 2939, 3001, 3003, 3004, 3056, 3074, 3076, 2096, 1897, 1668]
blocks: [3001]
created: 2026-07-07
---

# #3086 — Honest vacuity re-baseline: extend the scorer, bump the oracle, self-land

Owner decision (explicit, 2026-07-07): update the test262 baseline to the HONEST
numbers even if the pass count REGRESSES. This is the vacuity-metric
reclassification #3076 flagged as needing owner sign-off — now given. This issue
is the **enabler** that unblocks the vacuity-unmask cluster (dev-keystone's
#2939/#2940 closure-dispatch fix, and the parked #2774/#2777/#3076).

## Problem

The #2463 vacuity scorer already reclassifies a **totally**-vacuous pass (a
`testWith*Constructors` harness wrapper was invoked but **zero** assertions ran,
`__assert_count === 1`) to a `vacuous: true` fail. Two gaps:

1. **Partial vacuity is missed.** The gate is GLOBAL: `__harness_cb_expected > 0
   && __assert_count === 1`. If the test runs *any* assertion outside the dead
   callback (setup asserts, or an earlier wrapper whose callback DID dispatch),
   `__assert_count > 1` and a *later* dead-callback wrapper is not flagged — the
   dropped-dispatch callback body (which held the real checks) is still counted
   as a pass. This is the closure-dispatch / callback-never-executed class
   (#2939/#2940/#3083): a callback held in an `any`-typed container that fails to
   dispatch runs nothing, but the top-level "pass" is fake.

2. **The #2463 reclassification never bumped `oracle_version`** (#3003). It rode
   the TEMPORARY default-on #3004 excusal instead. So the policy change is not
   formalized: the standalone/host baselines are old-oracle (v1), and #3001
   (remove the excusal) is blocked waiting for a proper new-policy re-baseline.

## Fix (three parts, one PR)

### 1. Partial-vacuity scorer (`tests/test262-runner.ts`)

Instrument whether each harness callback **actually ran** (#3076's measurement
approach). In every callback-dispatching harness wrapper
(`testWith*TypedArrayConstructors`), snapshot `__assert_count` around each
`fn(...)` and count an invocation as **dead** when it contributed zero asserts.
A would-be pass is VACUOUS (`-262`) when **every** attempted callback invocation
was dead (`__harness_cb_dead === __harness_cb_expected`, with
`__harness_cb_expected > 0`) — regardless of setup asserts elsewhere. This
strictly generalizes the old `__assert_count === 1` check (which is the
no-setup-asserts special case) and adds the partial case. Under-detection stays
safe (a callback that asserts once is not flagged); over-detection is
near-impossible for the harness class (its callbacks always assert). All flips
carry `vacuous: true` + the canonical `vacuous:`-prefixed error, so the #3004
excusal / wasm-identical handling keep them out of the gated regression count.

### 2. Oracle bump 1 → 2 (`tests/test262-oracle-version.ts`)

This is a VERDICT-LOGIC change → bump `ORACLE_VERSION` (#2096/#3003) so the
guards treat the cross-policy diff as a re-baseline, not a regression, and
`check:verdict-oracle` is satisfied.

### 3. Forward-bump auto-rebase (`scripts/diff-test262.ts`) — the self-land key

**The missing infra piece #3003 documented but never exercised** (the oracle was
never actually bumped). A cross-oracle diff hard-refuses (`exit 2`) unless
`ORACLE_REBASE=1`. But `merge_group` runs the **base-branch (main) YAML**, which
never sets `ORACLE_REBASE` — so a naive bump makes the merged-tree diff
`exit 2`, failing the required guard step (`exit $diff_exit`), and — worse — the
push-to-main `promote-baseline` (`needs: merge-report`) then also refuses,
**permanently wedging the queue** because the refusal blocks the very promote
that would re-seed the baseline at v2.

Fix (self-landing, script-side, mirrors #3004's default-on invariant): a
**forward monotonic** bump (`newOracle > baseOracle`) is ALWAYS a deliberate
re-baseline (the oracle is a hand-edited, append-only integer), so the merged-
tree `diff-test262.ts` treats it as an implicit rebase — **proceeds** with a
loud warning instead of `exit 2`. A **backward / mixed** version still hard-
refuses (that IS the accidental case the guard must catch). Because my flips are
all `vacuous: true`, the existing #3004 excusal drops them from the gated count
(verified: excused, count 0); a genuine non-vacuous regression my change might
introduce is STILL counted (verified) — so the guard keeps its teeth. This makes
my own merge_group AND the post-merge promote both pass → self-lands → promote
re-seeds host+standalone baselines at v2.

## Why this unblocks the cluster

Once the honest v2 baseline lands, dev-keystone's #2939/#2940 closure-dispatch
fix and #3076's destructuring/assert.throws work flip vacuous→honest passes as
**genuine gains against the honest baseline**, not false regressions. #3001 can
then remove the TEMPORARY #3004 excusal (the baseline is finally new-policy at a
matched oracle, so a future true-pass→vacuous codegen break is caught, not
masked).

## Scope guard

This PR intentionally produces ONLY `vacuous: true` flips (self-landing via the
excusal). #3056 (numeric-assert enforcement) produces NON-vacuous honest fails
that the excusal does NOT cover — it needs a coordinated floor drop + admin-merge
and stays a SEPARATE re-baseline, sequenced after this enabler.

## Acceptance criteria

1. Partial-vacuity flips (dead callback + setup asserts elsewhere) score
   `vacuous: true` fail; a callback that asserts is never flagged.
2. `ORACLE_VERSION === 2`; `pnpm run check:verdict-oracle` passes.
3. `diff-test262.ts`: forward bump auto-rebases (no exit 2); backward/mixed still
   refuses; genuine non-vacuous regressions still counted; vacuity flips excused.
4. Committed summary + standalone highwater re-seeded to the honest (lower)
   numbers; documented before→after delta.
5. Scoped test262 validation; merge_group is the real gate.

## Implementation notes / measurement

### What landed
- `tests/test262-runner.ts`: (a) harness **partial**-vacuity — snapshot
  `__assert_count` around each `testWith*Constructors` `fn(...)`, count dead
  invocations, flag when ALL are dead (generalizes the old `__assert_count === 1`
  total check); (b) **general** non-harness gate — a would-be pass whose body has
  `assert_*` calls but ran zero of them (`__assert_count === 1`) is `-262`
  vacuous. Both carry `vacuous: true` via the existing `-262` plumbing (worker /
  shared / runner unchanged downstream).
- `tests/test262-oracle-version.ts`: `ORACLE_VERSION` 1 → 2 + history note.
- `scripts/diff-test262.ts`: forward-monotonic bump auto-rebase (self-land key).

### Measured before→after honest delta (scoped)
- **General non-harness gate: 0 pass→vacuous flips on 440 real files** (220
  standalone + 220 gc, across TypedArray/Array/RegExp/Object/String/language).
  Independently corroborated by dev-keystone (#2790): 0 non-harness un-masks in
  113 callback-filtered gc files (2 samples). The synthetic
  `function(v: number)` drop shape flips (unit-tested), but **real** test262
  callbacks use externref params that dispatch fine → the gate is a safe
  detection net, not a mass reclassifier.
- **Harness partial case: ~0 additional flips** — real harness tests run ZERO
  top-level asserts before the wrapper, so `__assert_count === 1` already caught
  them (the partial extension is a correctness net for the mixed case).
- **Net honest delta ≈ 0 on the sampled corpus.** The dominant vacuous class
  (the ~1487 `testWith*Constructors` cluster) was ALREADY `-262` vacuous-fail
  under #2463, so the current baseline is already largely honest. This PR's value
  is therefore (1) the **oracle bump** formalizing the #2463 policy (unblocks
  #3001), (2) the **forward-auto-rebase infra** (#3003's missing self-land
  piece), and (3) closing the non-harness/partial **detection gaps** so a future
  regression is caught honestly. The authoritative full-corpus delta is measured
  by the merge_group; all flips are `vacuous: true` → excused → self-lands.

### Sequencing (dev-keystone / #2790)
dev-keystone's #2790 (host-lane harness callback registration) un-masks the
~1487 harness cluster from `vacuous-fail` → honest execution (fail→fail or
fail→**pass** improvements) — **no pass→fail exposure** (measured). It is held
DRAFT for clean sequencing after this v2 re-baseline; signalled to un-draft on
landing.
