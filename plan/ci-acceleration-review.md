# CI Acceleration Review — js2wasm test262 pipeline

- **Author**: fable architect (arch-ci-accel), 2026-07-19 ~00:30 UTC
- **Original review scope**: analysis + prioritized plan only; the
  implementation update below records the later CI changes.
- **Ground truth read**: `.github/workflows/test262-sharded.yml` (2,187 lines), `.github/workflows/ci.yml`, `scripts/gen-test262-mg-matrix.mjs`, `scripts/test262-worker.mjs`, `tests/test262-shared.ts`, `tests/test262-original-harness.ts`, `tests/test262-oracle-version.ts`, issues #3431/#3433/#3438/#3404, plus live `gh run` timing data from 2026-07-18/19.

## 2026-07-21 implementation update

The highest-priority levers from this review have since landed: merge-group
artifact reuse on push, a contention-tolerant compile-timeout guard, the
native-harness implementation behind a separate oracle mode, cached setup,
and a target-weighted merge-group matrix.

The first matrix revision used 34 host + 19 standalone jobs because the old
queue configuration allowed five speculative merge groups to build at once.
That configuration caused both runner oversubscription and cancellation churn:
adding, removing, or ejecting an earlier entry invalidated descendant groups
and restarted their full matrices. The live main ruleset now deliberately has
`max_entries_to_build=1`, so retaining the contention-sized 53-job matrix would
leave more than half of the 120-runner pool idle.

Production merge-group run 29807524490 validated the serial-queue model: all 53
jobs started within one second, with no runner queue. Its `Run shard` timings
were:

| lane       | shards | total runner-s | mean job |  max job |
| ---------- | -----: | -------------: | -------: | -------: |
| js-host    |     34 |         24,071 | 11.8 min | 13.6 min |
| standalone |     19 |         11,284 |  9.9 min | 10.9 min |

The measured 2.13:1 work ratio maps to 72 host + 34 standalone jobs (2.12:1).
That uses 106 runners and reserves 14 for the overlapping quality, equivalence,
differential, Test262-gate, and orchestration jobs. Perfect distribution is
about 334 vs 332 seconds of shard work per runner, targeting a 6–8 minute shard
phase while keeping the existing 25-minute safety ceiling.

The host cost is compilation, not corpus size. Both lanes in the production
run used the honest full in-Wasm harness (the fast native-host mode was not set
in the merge-group environment). Host compile time totaled 77.7M ms versus
42.3M ms standalone; execution totaled only 2.4M versus 0.7M ms. Host interop
codegen is costlier and more host tests reach pass, which also triggers more
strict-mode recompilations.

Other implemented pipeline reductions:

- the pnpm content-addressable store is restored through one shared composite
  setup action, removing repeated `corepack prepare` network points;
- lint, formatting, and typecheck run concurrently inside the existing
  required `quality` context;
- each equivalence shard evaluates its own baseline membership, so the final
  `equivalence-gate` is a status fan-in instead of a second checkout/install
  plus eight artifact uploads and downloads.

Production merge-group run 29810082992 then validated the 106-job matrix. The
Test262 workflow took 13:09 end to end, split across the critical path as:

| phase                                                | wall  | notes                                                           |
| ---------------------------------------------------- | ----: | --------------------------------------------------------------- |
| workflow start → first shard                         |  0:39 | change detection plus matrix release                            |
| first shard start → last shard finish                |  7:47 | 106 jobs; the final standalone job started 50 s after the first |
| post-shard regression gate                           |  4:41 | ran in parallel with the 0:45 report merge                      |
| └ merge-base cache lookup                            |  3:40 | six fetch/probe attempts, including five 30 s sleeps             |
| └ checkout, setup, install, baseline fetch, and diff |  1:01 | all remaining regression-gate work                              |

The cache poll was therefore 78% of the post-shard gate and 28% of the entire
workflow. It also waited on cache entries that can never appear when the
predecessor is doc-only and intentionally ran no shards. The workflow now makes
one immediate exact-base probe against the freshly cloned baseline repository,
then falls through without sleeping to the nearest cached ancestor. The later
predecessor-group artifact lookup remains the strongest exact fallback. This
keeps distance-0 reuse when it is already available without turning a cache
miss into a multi-minute critical-path stall.

Running js-host then standalone on one runner remains a poor fit for the serial
queue and available capacity: it saves setup work but serializes two compiler-
heavy lanes while idle runners are available. Pairing is a contingency only if
runner capacity shrinks. Shared linked harness/runtime code remains the
#2527/#2514 end-state; mutable compiler/checker and execution-realm state stays
process-isolated and is reused only behind the existing periodic recreation,
poison retry, and realm-canary recycle guards.

## 0. Executive summary — the brief is partially stale (good news)

Since the brief was written, **both** in-flight fixes landed:

- **#3374 / issue #3433** (memoized quadratic scans, 2.6–3.8× faster harness compiles) merged 2026-07-18 18:24 UTC.
- **#3365 / issue #3431** (114→59 merge_group shard consolidation) merged 2026-07-19 00:03 UTC, after the 25→50 guard bump (`7948d7770`) and — decisively — after #3374 shrank the population of boundary compiles near the 30 s timeout.
- **#3438** re-derived the 57-way weight maps from post-#3374 timings (merged).

Measured effect (real merge_group runs):

| state                                                          | matrix   | host shard avg/max      | standalone avg/max             | run wall                                                               |
| -------------------------------------------------------------- | -------- | ----------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| pre-#3374 (issue #3431 evidence, run 29631214965)              | 114 jobs | 13.6 / 15.9 min         | 5.8 / 7.0 min                  | 15–19 min uncontended, **38.5 min contended**, ~60+ min in queue waves |
| post-#3374 (run 29665278780)                                   | 114 jobs | 6.7 / 7.6 min           | 5.4 / 6.5 min                  | **12.1 min**                                                           |
| post-#3431, first live run (29666753663, in progress at 00:30) | 59 jobs  | 9.2 / 10.9 min (40-way) | ~12–15 min (19-way, long pole) | est. **~16–18 min**                                                    |

merge_group validation is back from ~1 h to ~12–18 min. The remaining acceleration is therefore **not** about the merge_group run in isolation — it is about (a) the **per-merge total job load** that creates cross-run contention (the push:main 114-job rerun is now the single largest consumer), (b) the **structural ~146k redundant harness compiles per full run** (both lanes), and (c) the **fragile #1942 count guard** that already ejected #3365 twice and remains contention-variable.

Top 3 levers by win ÷ effort:

1. **L2 — make the #1942 count guard contention-tolerant** (AND-gate count with the aggregate signal). Tiny diff; removes the ejection tax (each false ejection ≈ 30–60 min of queue time + a full 59-job re-run).
2. **L1 — reuse the merge_group's merged JSONLs for push:main baseline promotion** (skip the per-merge 114-job rerun; the artifact already exists, keyed by exactly the right SHA). Removes ~66 % of per-merge shard jobs — the biggest remaining contention lever.
3. **L6 — re-derive the mg shard constants from post-#3374 timings** (standalone is now the long pole; the 40/19 split is already stale). One-constant change, ~3–5 min off every merge_group run.

The two stakeholder structural directions (L3 native-JS harness for the host lane, L4 linked harness module for standalone) are real and quantified below, but they are **oracle-policy / linker-roadmap items**, not this-window CI wins. Details and specs follow.

---

## 1. End-to-end pipeline map

Per-PR lifecycle, with measured wall-clock (all runs 2026-07-18/19):

### Stage A — PR-time (on every push to a PR branch)

| check                                                  | workflow                    | jobs | wall                                                              | notes                                                                               |
| ------------------------------------------------------ | --------------------------- | ---- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `cheap gate (main-ancestor + lint)` **(required)**     | test262-sharded.yml:119–181 | 1    | ~1.8–2 min                                                        | typecheck ∥ lint; shallow checkout                                                  |
| `merge shard reports` **(required)**                   | test262-sharded.yml:673+    | 1    | trivial pass                                                      | shards deliberately do NOT run at PR-time (test262-sharded.yml:349–355)             |
| `quality` **(required)**                               | ci.yml:66                   | 1    | ~4–6 min                                                          | lint, format, typecheck, IR-fallback, dead-export, oracle-ratchet, loc-budget gates |
| linear-tests + equivalence-shard ×8 + equivalence-gate | ci.yml:449–525              | 10   | ~3–5 min                                                          | code-change-gated                                                                   |
| observed total PR-time runs                            |                             | ~13  | **~2–3.5 min** for the sharded workflow (runs 29666861222 et al.) | PR-time is NOT a bottleneck                                                         |

### Stage B — queue-time (merge_group, the authoritative gate)

| job                                                                                                                            | jobs                             | wall                                               | notes                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `changes` (+ mg matrix compute, #3431)                                                                                         | 1                                | 0.6 min                                            | doc-only groups skip shards entirely (truth table at test262-sharded.yml:322–338) |
| `test262-shard-mg` (#3431)                                                                                                     | **59** (40 host + 19 standalone) | host max ~10.9, standalone max ~13–15 min          | dynamic entry `tests/test262-chunk-dynamic.test.ts`, pool 4/job (#3425 contract)  |
| `merge-report` (**required**) incl. catastrophic guard, #1942 compile-time guard (lines 1040–1086), #1668 stale-baseline guard | 1                                | ~2–3 min                                           |                                                                                   |
| `regression-gate`                                                                                                              | 1                                | ~1.2 min                                           | parallel to merge-report                                                          |
| ci.yml re-run (quality, equivalence…)                                                                                          | ~12                              | ~4–6 min                                           | parallel, off critical path                                                       |
| **critical path**                                                                                                              |                                  | **max(shard lane) + ~3 min ≈ 16–18 min** currently | was ~60+ min pre-#3374/#3431                                                      |

### Stage C — post-merge (push:main, per merged src-PR)

| job                         | jobs           | wall                                                           | notes                                                          |
| --------------------------- | -------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `test262-shard` full matrix | **114** (57×2) | ~14–17 min (runs 29666312826: 13.6 min; 29665627877: 17.2 min) | sole purpose: produce merged JSONLs for `promote-baseline`     |
| `promote-baseline`          | 1              | ~2–4 min                                                       | pushes baseline to `loopdive/js2wasm-baselines` + main summary |
| ci.yml on push              | ~12            |                                                                |                                                                |

**Per-merge total: ~59 (mg) + 114 (push) + ~25 (ci.yml ×2) ≈ 200 jobs.** The push:main 114-job block does not gate the merge, but it **contends for the same ~120-concurrent-runner ceiling as the NEXT queue entry's merge_group run** — with `max_entries_to_build: 5` (docs/ci-policy.md:110), a busy queue plus 1–2 in-flight push runs still oversubscribes runners ~3×.

---

## 2. Bottleneck analysis, quantified

### 2.1 The ~43k-harness-compiles hypothesis — CONFIRMED, with refinements

Code path: `tests/test262-shared.ts:600` calls `assembleOriginalHarness(source, meta)` → `tests/test262-original-harness.ts:88–116` prepends, **per test**: strict directive + `doneprintHandle.js` (async) + per-test includes (e.g. `propertyHelper.js`, 12 KB) + `scripts/test262-fyi-runtime.js` (1 KB) + `assert.js` (4.6 KB) + `sta.js` (0.7 KB). The whole assembly is compiled to wasm by the fork worker (`scripts/test262-worker.mjs:890 doCompile`) with a 30 s timeout (`test262-shared.ts:876`).

Two multipliers the brief undercounts:

1. **Strict rerun**: `test262-shared.ts:880` — every test that passes and is not raw/module/onlyStrict/noStrict is **compiled a second time** with only a `"use strict";\n` prefix difference (`test262-original-harness.ts:127–131`). Issue #3433 measured the total at **~73k compiles per lane per run** (43k × ~1.7).
2. **Two lanes**: the js-host AND standalone matrices each do this → **~146k full-assembly compiles per full run** (mg or push).

Issue #3433's profiling (plan/issues/3433-test262-prelude-compile-cache.md): the prelude was **75–97 % of every compile**, and compile cost was **superlinear** in source size due to two O(call-sites × file-size) scans (`symbolBindsAsyncFunction` #2612, `resolveAssignedNominalType` #2767). #3374 memoized both: 659 → 250 ms/test mixed (2.64×), propertyHelper-heavy 1,963 → 511 ms (3.8×). **Post-#3374 the prelude codegen is linear but still the dominant per-compile cost** (body-only compile: 59–173 ms vs full assembly 250–511 ms). So the structural redundancy still costs roughly **2–4× per compile**, ~146k times per run.

### 2.2 Contention, not per-job overhead

Issue #3431's evidence stands: fixed per-job setup is ~30–45 s; an uncontended 114-job run finished in 15–19 min while a contended one took 38.5 min with job starts trickling over ~20 min. 5 concurrently-building queue entries × 114 = 570 jobs vs ~120 runner slots ⇒ ~4.75× oversubscription. Post-#3431: 5 × 59 = 295, plus 114 per concurrent push:main run ⇒ still ~2.5–3.4×. **The push:main rerun is now the largest single job-count block in the system** (114 of ~200 per-merge jobs).

### 2.3 The no-skip full-suite change (oracle v8)

`ORACLE_VERSION = 8` (#3370, tests/test262-oracle-version.ts:180–193) made the literal upstream harness authoritative — the _honesty_ win that caused the cost spike. The `changes` job (test262-sharded.yml:183–320) still skips shards for genuinely non-test262 merge groups (fail-safe run-on-uncertainty), so "full suite every time" applies only to src-touching PRs — which is nearly all of them.

### 2.4 Guard fragility (#1942) — the #3365 double-ejection

Mechanism (test262-sharded.yml:1040–1086): two signals from the same diff — (1) **count**: `pass→compile_timeout` > `COMPILE_TIMEOUT_THRESHOLD` (now 50); (2) **aggregate**: shared both-compiled set compile-time Δ > +20 %.

Why the count guard is structurally fragile: the count measures how many tests near the 30 s boundary crossed it **this run** — a function of runner CPU contention (variable, wave-shaped, per §2.2), shard density (doubled by #3431), and the boundary population size (slashed by #3374). #3365's ejections showed exactly the signature of a false positive: **CT > threshold while aggregate Δ = +3.2 %** (a real compile-perf regression that pushes >50 tests past 30 s cannot leave the shared-set aggregate at +3 %). The bump to 50 treats a symptom; the count remains an unbounded function of contention.

There is one honest hole to preserve: **survivor bias** — a pathological slowdown makes its victims time out, which _removes them from the both-compiled shared set_, so the aggregate can stay flat while the count spikes. The fix must keep a count-shaped backstop, just not a contention-priced one (see L2).

---

## 3. Prioritized acceleration levers

| #     | lever                                                | wall/job win                                                                                             | risk                                | effort                               | verdict                                   |
| ----- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------ | ----------------------------------------- |
| L2    | Contention-tolerant #1942 guard                      | removes false ejections (each ≈ 30–60 min queue time + full re-run)                                      | low                                 | **S** (one workflow step)            | **do first**                              |
| L1    | Reuse mg JSONLs for push:main promote-baseline       | −114 jobs/merge (−~66 % of shard-job load); −~800 runner-min/merge; directly de-contends the next mg run | low-med                             | **M** (workflow-only)                | **do**                                    |
| L6    | Re-derive mg shard constants post-#3374              | −3–5 min per merge_group run (standalone long pole); optionally −10–15 more jobs                         | low                                 | **S** (two constants + evidence)     | **do**                                    |
| #3404 | Tolerate single-shard upload flake in promote        | removes rerun-whole-114 on 1 ETIMEDOUT                                                                   | low                                 | S                                    | already filed, endorse                    |
| L3    | JS-host lane: native-JS harness, compile body only   | ~2–4× host compile cut → host lane ~40–50 % faster or half the shards                                    | **high** (oracle policy, v9 rebase) | **L**                                | decision issue first, then build          |
| L4    | Standalone lane: linked harness .wasm                | same shape for standalone lane                                                                           | high                                | **XL** (#1046/#33/#34 linker slices) | endorsed end-state, roadmap               |
| L5    | Re-enable disk cache (task #29)                      | ~0 for src-touching runs (key includes bundle hash ⇒ 100 % miss)                                         | med (the "false baselines" scar)    | M                                    | **recommend wont-fix / superseded by L1** |
| L7    | Cache pnpm store / prebuilt compiler bundle artifact | ~30–45 s/job × ~160 jobs ≈ 100+ runner-min/merge, small wall win                                         | low                                 | S-M                                  | opportunistic                             |

### L1 — Promote from the merge_group's own results (kill the per-merge 114-job rerun)

The merge_group already uploads its merged JSONLs keyed by **exactly the SHA that lands on main**: `test262-group-${{ github.event.merge_group.head_sha }}`, retention 3 days (test262-sharded.yml:1158–1167 — built for #1956 predecessor diffing). The merge queue fast-forwards main to that same head SHA, so the subsequent push:main run's `github.sha` equals the artifact key. Today `promote-baseline` (line 1632, `if: push || workflow_dispatch`) instead waits for a **fresh 114-job `test262-shard` run** of the identical tree — pure duplication, and its 114 jobs contend with the next queue entry's mg run.

Design: on push:main, a cheap first job queries the artifacts API for `test262-group-${github.sha}` (needs `actions: read`, cross-run download — regression-gate already does exactly this pattern, line 1188+). Hit → download, feed merge-report/promote directly, **skip the shard matrix**. Miss (direct push, expired artifact, doc-only) → run the full matrix as today (fail-safe identical to `changes`' bias). Compatibility: the mg run uses pool 4 (test262-sharded.yml:601, #3425 contract) and the full corpus, so the JSONL is baseline-grade by construction; #2099 poison-healing runs at promote time either way.

Estimated win: per merged src-PR, total shard jobs drop 173 → 59 (−66 %); under a 5-deep queue the oversubscription drops from ~3× to ~1.5–2.5×, which is the regime where #3431's evidence showed job-start trickle disappearing. This also makes the queue's drain rate ~independent of merge frequency.

### L2 — #1942 guard: gate on the conjunction, keep a catastrophic ceiling

Replace the flat `CT > 50 ⇒ fail` (test262-sharded.yml:1069–1072) with:

1. `CT > CT_SOFT (50)` **AND** `aggregate Δ > +10 %` ⇒ fail (real slowdowns move both; contention moves only the count — #3365's ejections had Δ=+3.2 %).
2. `CT > CT_HARD (~200, ≈ boundary-population scale)` ⇒ fail unconditionally (closes the survivor-bias hole: a slowdown that times out hundreds of former passes can't hide behind a flat shared-set aggregate).
3. `CT_SOFT < CT ≤ CT_HARD` with flat aggregate ⇒ `::warning` + emit the count into the run summary so drift is visible without ejecting.

Optionally scale `CT_SOFT` by `114/actual-shard-count` so future matrix changes don't need manual re-bumps. The aggregate +20 % arm stays untouched as the systemic backstop.

### L6 — mg shard constants are already stale (standalone inverted into the long pole)

`gen-test262-mg-matrix.mjs:51–52` (`JS_HOST_CHUNKS=40`, `STANDALONE_CHUNKS=19`) was scaled from **pre-#3374** timings (host 13.6, standalone 5.8 min at 57-way). Post-#3374 the 57-way numbers are host 6.7 / standalone 5.4 — near-parity — so at 40/19 the lanes are inverted: first live 59-run shows host max ~10.9 min but standalone ~13–15 min. Re-derive so both lanes finish together, e.g. host≈30 / standalone≈24 (≈12.7 / 12.8 min avg, 54 jobs) or host≈24 / standalone≈20 (≈16 / 15.4 min, 44 jobs, −25 % more contention win). **Answer to "is 59 too aggressive?": no — with #3374 landed the 25-min cap has 10+ min headroom and the boundary-compile population shrank 2.6–3.8×, so guard pressure is far lower than when #3365 first ejected. The original failure was ordering (#3365 entered the queue before #3374's effect existed), not density.** Do L2 before pushing density further.

### L3 — JS-host lane: run the harness as native JS (stakeholder direction 1)

Feasibility: mechanically yes. The host lane already executes with full JS interop (`buildImports`, sandbox globals — scripts/test262-worker.mjs:1397–1431); assert.js/sta.js/propertyHelper.js could execute natively in the sandbox with only the untouched test body compiled to wasm.

Win (from #3433's measurements): body-only compile is 59–173 ms vs 250–511 ms full assembly post-#3374 ⇒ ~2–4× on ~73k host-lane compiles; host shards ~9 → ~5–6 min at 40-way, or halve the host shard count at constant wall — combined with L1/L6 a per-merge total of ~40 shard jobs is plausible.

Correctness — this is the hard part, and it is an **oracle policy change, not a perf tweak** (#3433 "Roadmap" section records the same conclusion + the user design input of 2026-07-18):

- Nothing in test262 requires the harness to _be_ wasm; test262.fyi runs it all in one JS engine. But #3370/v8's honesty contract is "compile the literal assembly" — moving the harness across the boundary changes what a verdict _measures_: `Test262Error` identity across the wasm/JS boundary, `verifyProperty`'s MOP operations against wasm-created objects, script-global sharing (harness `var`s visible to the test body and vice versa), and the strict rerun (a native harness is strict-neutral, but the _body_ still needs both compilations — the 1.7× multiplier stays).
- Some current honest fails would become boundary artifacts; some current passes could flip. ⇒ requires ORACLE_VERSION 9 + `ORACLE_REBASE` + promote-baseline force-refresh, and a deliberate sign-off by the lane owner + user per the #3433 roadmap note.

Recommendation: file it as a **decision issue** (design doc + 200-test A/B sample quantifying verdict flips) before any implementation. Do not sequence CI health on it — L1/L2/L6 deliver the queue-throughput fix without touching the oracle.

### L4 — standalone lane: separately-compiled, linked harness .wasm (stakeholder direction 2)

The standalone lane cannot host-execute the harness by definition (its whole point is host-free wasm; #2961/oracle v6 rejects binaries with host imports — scripts/test262-worker.mjs:1399–1403). The harness must stay in-wasm, so the dedup shape is: compile the assembled prelude **once per (includes-set × strict × compiler-bundle)** into a harness module, then per test compile only the body and link.

Reality check: this is the #1046 separate-compilation / #33 relocatable-object / #34 module-linker path. #3433's roadmap already endorses it as the end-state and notes slice-1's scalar/externref boundary is insufficient — the harness needs class identity (`Test262Error instanceof`), shared script globals, and closure-grade linkage across modules. That is an XL compiler-roadmap item where the harness becomes the driving use case, not a CI-window fix. Interim note: the includes-set cardinality is small (a few dozen distinct prelude combinations cover 43k tests), so when linking exists the per-run compile count collapses from ~73k prelude codegens to ~10² prelude compiles + ~73k body-only compiles.

A cheaper interim was measured and rejected in #3433: front-end-only prelude snapshot ceiling ≈ 13 % — not worth the diagnostics risk.

### L5 — disk cache (task #29): recommend superseding, not re-enabling

The sound key is hash(assembled source) × compiler-bundle hash × target (#3433 plan item 5). But every src-touching PR changes the bundle hash ⇒ ~100 % miss for exactly the runs that matter (mg + push on compiler changes); the old cache step was removed because it added restore/save + double `hashFiles('src/**')` overhead to all 114 jobs for near-zero hits (comment at test262-sharded.yml:505–513), on top of the "stale cache → false baselines" scar (test262-shared.ts:857–858). L1 delivers the only high-hit-rate variant of this idea — whole-run reuse keyed by exact SHA — with none of the staleness risk. Recommend closing #29-shaped work as superseded by L1.

---

## 4. Unblocking #3365 — resolved; codify the fix

#3365 **merged 2026-07-19T00:03 UTC**. What actually unblocked it, in causal order: (1) #3374 landed first and shrank the 30 s-boundary compile population 2.6–3.8×; (2) the count threshold moved 25→50 (`7948d7770`). The brief's question ("the actual fix, not just bump higher") is answered by L2: **a contention-variable count must never be a sole ejection trigger — require the aggregate signal to corroborate it, and keep only a catastrophic absolute ceiling as the unconditional arm.** Had L2 been in place, neither ejection would have happened (Δ was +3.2 % both times) and the 25→50 bump would have been unnecessary. Residual risk to watch: the first live 59-shard runs (29666753663+) — if a flat-aggregate CT>50 recurs there, that is the L2 trigger, and L2 should be treated as a queue-health hotfix.

Sequencing lesson for the log: a shard-density change and a compile-speed change interact through the timeout boundary; land the speedup first (or stack the density PR on it). The queue processed them in the risk-maximizing order.

## 5. Spec'd follow-up issues

Tech lead: allocate ids via `claim-issue.mjs --allocate` (per CLAUDE.md); titles/criteria below. Suggested lane: A (CI/infra).

### A. `ci(test262): promote push:main baseline from the merge_group's own artifacts (skip the 114-job rerun)` — P1, M

Implements L1. **AC**: (1) push:main runs whose `github.sha` has a `test262-group-<sha>` artifact skip `test262-shard` entirely and promote from the downloaded JSONLs; (2) artifact-miss falls back to the current full matrix (fail-safe, logged); (3) promote output byte-comparable to a control full-run promote on the same SHA (one-time validation); (4) `merge shard reports` required-context semantics unchanged on push; (5) mg artifact retention ≥ promote window (3 days OK, document); (6) rollback = revert one workflow diff.

### B. `ci(test262): make the #1942 compile-timeout count guard contention-tolerant` — P1, S

Implements L2. **AC**: (1) fail only on (CT > 50 AND aggregate Δ > +10 %) OR (CT > CT_HARD ≈ 200); (2) flat-aggregate CT spikes emit `::warning` + run-summary metric, not failure; (3) aggregate +20 % arm unchanged; (4) thresholds documented in-workflow with the #3365 ejection evidence (CT>50 at Δ=+3.2 % twice); (5) optional: CT_SOFT scales by 114/shard-count.

### C. `ci(#3431 follow-up): re-derive merge_group shard constants from post-#3374 timings` — P2, S

Implements L6. **AC**: (1) `JS_HOST_CHUNKS`/`STANDALONE_CHUNKS` re-derived from ≥1 completed post-#3374 mg run (e.g. 29666753663) with both-lane max within ~1 min of each other and ≤ ~18 min; (2) evidence table in the script header updated (it currently cites only pre-#3374 numbers); (3) sequenced AFTER issue B (guard tolerance) if density increases.

### D. `#3404` (exists, `ready`): promote tolerates single-shard upload flake — endorse as-is, pairs with A (A also reduces its blast radius since push promotes stop depending on 114 fresh uploads).

### E. `decision(test262): JS-host lane native-JS harness — oracle v9 policy proposal` — P2 until stakeholder decision, then L

Implements L3, gated. **AC for the decision issue** (no implementation): (1) design doc covering Test262Error cross-boundary identity, verifyProperty-on-wasm-objects MOP, script-global sharing, strict-rerun handling; (2) A/B verdict-flip measurement on a ≥200-test stratified sample (native harness vs v8 assembly); (3) explicit sign-off from lane owner + user per the #3433 roadmap note; (4) if approved: ORACLE_VERSION→9 + ORACLE_REBASE plan per tests/test262-oracle-version.ts header.

### F. `arch(#1046/#33/#34): linked harness .wasm as the driving use case for separate compilation` — roadmap, XL

Implements L4. **AC**: #1046 slice-2 spec names the test262 prelude as its acceptance workload: compile the assembled prelude once per (includes-set × strict), link per-test bodies against it; class identity + shared globals across the module boundary; per-run prelude codegens collapse ~73k → ~10². No CI change until the linker slice exists.

### G. Task #29 (disk cache): close as superseded by A (rationale in §L5).

---

## Appendix: evidence index

- Harness prepend: `tests/test262-original-harness.ts:88–135`; strict-rerun second compile: `tests/test262-shared.ts:880–894`; cache disabled: `tests/test262-shared.ts:857–860` + workflow comment `.github/workflows/test262-sharded.yml:505–513`.
- Compile volume + profiling: `plan/issues/3433-test262-prelude-compile-cache.md` (75–97 % prelude share, ~73k compiles/lane, 2.64–3.8× fix, 13 % snapshot ceiling, lane-asymmetric roadmap).
- Contention evidence: `plan/issues/3431-consolidate-mergegroup-test262-shards.md` (runs 29631214965 / 29632953272); `scripts/gen-test262-mg-matrix.mjs:5–49`.
- Guard: `.github/workflows/test262-sharded.yml:1023–1086`; threshold bump commit `7948d7770`.
- Post-#3374 measurements: run 29665278780 (114-job mg, 12.1 min; host 6.7/7.6, sa 5.4/6.5); push runs 29666312826 (13.6 min), 29665627877 (17.2 min); first 59-job mg run 29666753663 (host 9.2/10.9 across all 40; sa ~12–15, in progress).
- promote-baseline duplication: `test262-sharded.yml:1632–1691` vs the #1956 group artifact at `test262-sharded.yml:1158–1167`.
- Weight-map rebalance: `plan/issues/3438-test262-shard-rebalance-post-3374.md`.
- Oracle v8 contract: `tests/test262-oracle-version.ts:34,180–193`.
