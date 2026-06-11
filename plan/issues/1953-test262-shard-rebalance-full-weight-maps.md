---
id: 1953
title: "test262: shard durations spread 32–153s — regenerate weight maps with full per-test coverage"
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: low
sprint: 61
depends_on: [1957]
area: ci
---
## Problem

The CI shard wall-clock is set by the slowest of the 57 chunks. On the first
post-#1311 run (27309868379), shard job durations spread **32s → 153s**
(p50 110s) — i.e. ~40s of every run's wall is pure imbalance.

Root cause: `tests/test262-slow-tests.json` only carried **189 entries**
(refresh threshold 1000ms). The other ~47,900 tests were assumed a uniform
`DEFAULT_TEST_WEIGHT_MS` = 250ms by `assignBalancedChunk` — but the real
distribution (baseline JSONL, 2026-06-10) is nothing like uniform:

| compile+exec | tests |
|---|---|
| ≤10ms | 5,005 |
| 10–50ms | 17,847 |
| 50–250ms | 18,257 |
| 250–400ms | 5,806 |
| >400ms | 967 |
| untimed (skip etc.) | 235 |

Roughly half the corpus runs in ≤50ms, yet each such test was weighted 250ms —
so bins stuffed with fast/skipped tests came out tiny (the 32s shard) while
compile-heavy bins overflowed (the 153s shard).

## Fix (implemented by this issue's PR)

- `scripts/refresh-slow-tests.mjs`: clamp emitted weights to ≥1ms (the loader
  in `tests/test262-shared.ts` drops 0 values), so `--threshold 0` produces a
  **full map** including near-zero and untimed (skip) tests.
- Regenerate both maps from the current baselines-repo JSONLs with
  `--threshold 0`: `tests/test262-slow-tests.json` (host) and
  `tests/test262-slow-tests-standalone.json`.
- Verified by simulating `assignBalancedChunk` offline against ground-truth
  durations (see PR description for predicted spread before/after).

## RESOLVED (2026-06-11) — unblocked by #1957

The deterministic contamination pairings documented below were fixed at the
root by #1957 (realm-contamination canary: workers detect actual intrinsic
drift after each test and recycle before the next one; the poisoned-builtin
fail-status retry gap is also closed). The maps below re-landed with this
issue's second PR, regenerated from the post-#1957 baselines.

## Historical context — first landing attempt (pre-#1957)

The regenerated maps were validated offline (simulated bin spread 43s → 0s
with the exact `assignBalancedChunk` algorithm) but BOUNCED off the
regression gate twice on PR #1314 with net −1 (7 pass→fail / 6 fail→pass).
**5 of the 7 regressions were identical across two independent runs** — the
new deterministic shard assignment creates *fixed* cross-test contamination
pairings (pre-existing isolation bugs in the unified fork pool):

- `annexB/.../func-if-decl-else-decl-a-…switch.js` + `func-switch-case-…switch.js`
  (eval-harness state; two sibling annexB tests flipped fail→pass in the
  same runs — the family trades victims with the assignment)
- `built-ins/Array/length/S15.4.4_A1.3_T1.js` (`Array.prototype.length`
  mutated by a fork sibling; `built-ins/Array/prototype/length.js`
  simultaneously flipped fail→pass)
- `built-ins/Object/defineProperties/15.2.3.7-2-14.js`
  (`Property description must be an object: JSON` — JSON global clobbered)
- `built-ins/String/prototype/charAt/S15.5.4.4_A10.js`
  (`wasm exception during compile (poisoned built-in)` — #1862 class, but
  recorded as status=fail, which BYPASSES the poison retry: the retry only
  triggers on status=compile_error)

Any weight/shard-count change will hit this same wall — the gate cannot
distinguish redistribution of pre-existing contamination from real
regressions. Unblock options (pick one):

1. **Stakeholder-approved one-time step change**: land the maps with an
   admin merge accepting net −1; the next push-to-main run re-anchors the
   baseline and subsequent PRs diff clean.
2. **Extend the #1862 poison retry to status=fail poison-class errors**
   (rescues the 2 poisoned-builtin flips deterministically) + a bounded
   isolation-retry for fails matching known contamination signatures
   (`Cannot redefine property`, `Property description must be an object`,
   `eval harness assertion`) — rescues the rest, and reduces baseline noise
   for every future PR, then re-land the maps.
3. Fix the underlying fork-state isolation (recycle worker between tests of
   mutating families) — correct but largest.

The maps were REMOVED from PR #1314 so #1951/#1952/#1954 could land; the
refresh-script clamp (≥1ms) stayed in. Regenerate with
`node scripts/refresh-slow-tests.mjs --threshold 0` when unblocked.

## Refresh policy

Re-run `node scripts/refresh-slow-tests.mjs --threshold 0` (and
`--target standalone`) whenever shard durations visibly skew again — compiler
perf changes shift the distribution. Source JSONLs come from
`scripts/fetch-baseline-jsonl.mjs` / the baselines repo.
