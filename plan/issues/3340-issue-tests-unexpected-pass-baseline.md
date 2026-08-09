---
id: 3340
title: "issue-tests: keep inverted expected-failure sentinels out of the root baseline"
status: done
completed: 2026-07-24
assignee: ttraenkler/dev-opus-search
created: 2026-07-17
updated: 2026-07-24
priority: high
feasibility: medium
reasoning_effort: medium
task_type: test
area: ci, test-infra
language_feature: regression-gating
goal: quality-infra
sprint: Backlog
horizon: s
es_edition: n/a
complexity: M
related: [2143, 2787, 3008, 3337]
origin: "2026-07-17 stronger-model current-origin/main audit: root baseline records two now-valid malformed-Wasm guards and a WASI it.fails unexpected pass as ordinary failures"
---

# #3340 - Keep expected-failure inversions out of the root baseline

## Problem

The root issue-test gate classifies every failed Vitest assertion as an ordinary
known failure. It cannot distinguish a real regression from an `it.fails` test
whose body now passes, or from a stale negative sentinel that still expects
valid output to be malformed. Bootstrap consequently absorbed three
improvements as baseline rot, so main can stay green while tests demand obsolete
bad behavior.

## Evidence on current `origin/main`

- `tests/issue-2143-validate-unoptimized.test.ts:27-45` labels
  `array/02-push-pop.js` and `control/12-for-in-object.js` as
  `KNOWN_MALFORMED` and asserts `WebAssembly.validate(...) === false`.
  Current-main focused execution fails both assertions because both binaries
  now validate. The representative positive guard passes.

  ```ts
  const KNOWN_MALFORMED = ["array/02-push-pop.js", "control/12-for-in-object.js"];
  expect(r.success).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(false);
  ```

- `tests/real-world-wasi.test.ts:39-58` is `it.fails`, but its only assertions
  (`success` and binary validity) both pass. Vitest reports `Expect test to
fail`; #3337 separately owns the still-missing argv runtime semantics.
- The current `loopdive/js2wasm-baselines/issue-tests-baseline.json` includes
  all three exact failure IDs, so they are treated as accepted main failures
  rather than ratchet work:

  ```text
  tests/issue-2143-validate-unoptimized.test.ts :: #2143 ... array/02-push-pop.js ...
  tests/issue-2143-validate-unoptimized.test.ts :: #2143 ... control/12-for-in-object.js ...
  tests/real-world-wasi.test.ts :: real-world: WASI command-line programs reads process.argv as a valid WASI module
  ```

- `scripts/issue-tests-gate.mjs:141-159` puts every failed assertion into one
  `failing` set based only on `a.status`.
- `scripts/issue-tests-gate.mjs:162-180` serializes/merges only `failing` and
  `passing`; no unexpected-pass class survives sharding.
- `scripts/issue-tests-gate.mjs:188-215` writes or bootstraps every failure into
  `knownFailures`, then computes improvements only when an ID appears in the
  passing set. An inverted sentinel can therefore never self-ratchet.
- #3008's completed implementation explicitly left post-bootstrap rot-cluster
  triage as follow-up work at
  `plan/issues/3008-issue-tests-not-in-required-ci.md:105-110`.

## Impact

The gate currently turns compiler improvements into permanent accepted
failures. That hides stale test intent, inflates the baseline, and can later
encourage developers to preserve or reintroduce invalid output just to satisfy
an obsolete negative assertion. Because the root suite is a post-merge safety
net, classification integrity is a prerequisite for trusting its regression
signal.

## Root cause / unknowns

Vitest's JSON report represents an unexpected pass of `it.fails` as a failed
assertion, and the gate discards failure-message semantics. Negative
characterization tests also have no metadata that says when their expected bad
behavior has become stale. The implementation should parse the stable Vitest
unexpected-pass signal and add a narrow source-policy guard; it should not infer
all assertion intent heuristically.

## Proposed approach

1. Extract failed assertion messages in `issue-tests-gate.mjs` and classify the
   Vitest `Expect test to fail` condition into an `unexpectedPasses` set.
2. Preserve that set in shard artifacts and merge results. Never seed or update
   those IDs into `knownFailures`; report them as `UNEXPECTED PASS` requiring
   test promotion.
3. Add focused gate fixtures for bootstrap, update, ratchet, sharding, and a
   genuine regression so classification cannot weaken the existing gate.
4. Convert #2143's two now-valid programs to positive compile-and-validate
   guards.
5. Replace the weak WASI `it.fails` validity check with either a tracked todo
   for #3337 or a characterization that tests the actual missing runtime/import
   contract without asserting already-correct validity should fail.
6. Add a narrow policy check preventing positive compiler fixtures from
   asserting that otherwise-valid source must fail `WebAssembly.validate`,
   while explicitly exempting encoder-negative tests built from intentional
   malformed byte sequences.

## Non-goals

- Implementing WASI argv semantics (#3337).
- Fixing malformed-Wasm producer families (#3024 and related issues).
- Making the entire root issue suite a required per-PR gate.
- Removing all `it.fails` tests or rewriting the Vitest runner.
- Treating every changed error message as an unexpected pass.

## Dependencies / related issues

- No hard dependency; gate classification and the two stale #2143 tests can be
  fixed immediately.
- #3008 created the root-suite baseline workflow and explicitly deferred rot
  triage. This issue is one verified classification cluster from that follow-up.
- #2143's differential-harness validation remains correct; only its stale
  negative fixtures need promotion.
- #3337 owns real `process.argv` behavior. This issue owns how its stale
  expected-failure test is represented in the baseline.
- #2787 is related test-classification/gate infrastructure, not this root-suite
  unexpected-pass path.

## Why this is not already covered

#3008 is complete and intentionally bootstrapped the existing failure set, with
rot triage left as follow-up. #2143 is complete and owns differential result
classification, not root-baseline semantics. #3337 owns WASI implementation.
Searches for `Expect test to fail`, `unexpectedPasses`, the three baseline IDs,
and `KNOWN_MALFORMED` found no issue or gate logic that distinguishes these
improvements from regressions.

## Acceptance criteria

- [ ] The two #2143 corpus programs are positive guards and pass only when
      compilation succeeds and their binaries validate.
- [ ] A gate fixture proves an `it.fails` unexpected pass is reported as
      `UNEXPECTED PASS`, fails the maintenance run, and is never written to
      `knownFailures` by bootstrap or `--update`.
- [ ] Sharded partial artifacts and merge mode preserve the unexpected-pass
      classification.
- [ ] A genuine failed assertion remains a regression or known failure under
      the existing rules; collection failures still gate.
- [ ] The WASI test no longer fails merely because binary validation succeeds,
      and its unresolved runtime semantics point to #3337.
- [ ] The current baseline ratchets out the two #2143 IDs and the stale WASI
      expected-pass ID after the corrected main workflow completes.
- [ ] Intentional malformed-byte encoder tests remain supported by the policy
      check and are documented as the explicit exemption.

## Validation plan

- Run focused unit/integration tests for `scripts/issue-tests-gate.mjs` in
  bootstrap, update, ratchet, shard, and merge modes.
- Run `pnpm test tests/issue-2143-validate-unoptimized.test.ts tests/real-world-wasi.test.ts`.
- Run a local root issue-test shard containing both an `it.fails` unexpected
  pass and a genuine failure; inspect the partial JSON and merged report.
- Validate the baseline diff against the current external baseline and confirm
  exactly the three stale IDs are removed by this slice.

## Progress — LANDED (dev-opus-search, 2026-07-24)

Unmasked the 3 stale inverted sentinels + built the durable gate-level
distinction (per lead: the durable part is the gate, not just the unmask).

**Unmask (the 3 banked improvements now assert CORRECT behavior):**
- `tests/issue-2143-validate-unoptimized.test.ts` — `array/02-push-pop.js` +
  `control/12-for-in-object.js` moved from `KNOWN_MALFORMED` (asserting
  `validate === false`) to `NOW_VALID` positive guards (compile + validate). The
  malformed-set is now empty with a one-way-ratchet comment; the #2143 detection
  mechanism stays.
- `tests/real-world-wasi.test.ts` — the `reads process.argv` `it.fails` (now an
  unexpected pass: the native-string codegen defect that made it emit an invalid
  binary is fixed) → a positive validity guard. Runtime argv semantics remain
  and are pointed at **#3337** (validity only asserted here).

**Durable gate (`scripts/issue-tests-gate.mjs`):** a new `unexpectedPasses`
classification — an `it.fails` whose body passes (vitest status "failed" +
"Expect test to fail") is split OUT of `failing` into `unexpectedPasses`, which
(a) is never seeded into `knownFailures` (bootstrap/`--update`) and (b) hard-
fails the run BEFORE any baseline write, forcing promotion. Threaded through the
shard partial artifact + `mergePartials` so sharded runs preserve it.

**Fixture:** `tests/issue-3340.test.ts` (3/3) drives the gate CLI in merge mode:
unexpected-pass → exit 1 + `UNEXPECTED PASS` (never baselined); ordinary
baselined failure → exit 0 (control); genuine new regression → exit 1 +
`REGRESSION` (gate not weakened).

**Baseline:** the 3 stale IDs ratchet out post-merge — the converted tests no
longer fail, so the post-merge `--update` (full-rewrite from current `failing`)
drops them; they can never be re-absorbed because an inverted sentinel now
hard-fails.

**Deferred (noted, not blocking):** the optional static "policy check" (approach
step 6 — reject a NEW positive fixture asserting valid source must fail
`WebAssembly.validate`, exempting encoder-negative tests) is a secondary
write-time guard on top of the runtime `unexpectedPasses` gate; left as a
follow-up since the runtime gate already catches the class at maintenance time.

**Validated:** issue-2143 3/3, real-world-wasi 7/7, issue-3340 3/3; tsc clean.
