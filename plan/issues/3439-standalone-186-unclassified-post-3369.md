---
id: 3439
title: "Classify the 186 standalone failures #3369 exposed; ratchet --max-unclassified-root-causes 300→0"
status: done
completed: 2026-07-24
assignee: ttraenkler/dev-opus-2
sprint: 76
created: 2026-07-18
updated: 2026-07-24
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: testing
language_feature: n/a
goal: standalone-mode
related: [3426, 2961, 3369, 3378]
---

## Resolution (2026-07-24, dev-opus-2, verify-first)

**The bucket work the issue anticipated is no longer needed — the fix is the
gate flip alone.** Measured against CURRENT main (the standalone merged jsonl
from the merge_group runs of pr-3530 `30053686236` and pr-3531 `30053051082`,
both 2026-07-23):

- The #3369-era signature `wasm exception during module init` has **0 records**
  on current main (down from 185), and `error_category: "unreachable"` has **0**
  (the single import.meta record is gone too). Six days of main movement
  fixed/reclassified the 186.
- Running `scripts/build-test262-report.mjs --target standalone
  --max-unclassified-root-causes 0 --include-proposals` on BOTH runs' merged
  jsonl exits **0** with the EXISTING `STANDALONE_ROOT_CAUSE_BUCKETS` —
  `root_cause_map.unclassified.count === 0` on each (20,424 / 20,420
  non-pass-non-skip records, all classified). The broad residual buckets
  (`misc-spec-tail`, `demasked-native-assertion`, `nonstringifiable-wasmgc-exception`,
  `standalone-host-import-leak-reclassification`) absorb every current failure.

So adding a bucket keyed on `wasm exception during module init` would be **dead
code catching 0 records** — and worse, if that signature ever reappears a
pre-existing catch-all would silently absorb it, hiding the very regression the
gate exists to surface (issue acceptance criterion #3 forbids exactly this). No
bucket added.

**Enforcement confirmed live** before flipping: a fixture with one unclassified
`fail` record at `--max-unclassified-root-causes 0` exits **1**
("…1 unclassified failures; threshold is 0."); the enforcement lives at
`build-test262-report.mjs` ~L1101-1108 (`process.exitCode = 1` when
`unclassified.count > threshold`). So restoring 300→0 restores a genuinely
armed gate, not a no-op.

**Change:** `.github/workflows/test262-sharded.yml` "Build merged standalone
test262 report" step — `--max-unclassified-root-causes 300` → `0` (reverting
#3378's temporary relaxation). No `scripts/build-test262-report.mjs` change.

**Test:** `tests/issue-3439.test.ts` (4 tests) locks the load-bearing invariant
— the gate is ARMED at 0 (unclassified → non-zero exit), PASSES when all
failures are classified, is opt-in (no flag → no enforcement), and the relaxed
300 masked a single unclassified (why the flip matters).

**Exposure note:** flipping to a hard 0 arms the gate with zero margin — the
merge_group run gating this PR (or any PR landing while unclassified > 0) will
park if a NEW/transient unclassified signature appears. That is the designed
behavior; the fix for a park is to classify the new signature, not to revert
this flip.

## Problem

#3369 (the "32k lever", merge commit `3634d5ab7`) recovered standalone test262
from **4,312 → 24,172 pass / 43,106** (~56.1%). But the push-to-main promote job
FAILED at the `merge shard reports` → "Build merged standalone test262 report"
step with:

```
Standalone root-cause map has 186 unclassified failures; threshold is 0
```

This is the #2961 policy gate (`--max-unclassified-root-causes 0` in
`scripts/build-test262-report.mjs`, invoked from `.github/workflows/test262-sharded.yml`).
It is a TRIAGE gate, not a regression — the pass count is correct. #3369 simply
exposed 186 previously-masked standalone failures that no root-cause bucket in
`STANDALONE_ROOT_CAUSE_BUCKETS` (scripts/build-test262-report.mjs) matches.

**Temporary unblock (must be reverted by this issue):** hotfix **#3378** (main
HEAD `6a14dc5db`) relaxed the merge-group report-build gate from
`--max-unclassified-root-causes 0` to **300** (test262-sharded.yml line 654) so
the queue could promote the recovered baseline. **The goal of this issue is to
classify the 186 and ratchet that `300` back to `0`.**

The recovered baseline itself was made visible via a one-time hand-promote to
`loopdive/js2wasm-baselines` + the main-repo summary (see "Promote note" below)
— this issue is the follow-up triage only.

## Goal / Acceptance

1. Add one (or a few) root-cause bucket(s) to `STANDALONE_ROOT_CAUSE_BUCKETS`
   in `scripts/build-test262-report.mjs` that claim these 186 records, so
   `node scripts/build-test262-report.mjs --target standalone --max-unclassified-root-causes 0 ...`
   exits 0 on the #3369 merged standalone jsonl.
2. Revert #3378's temporary relaxation: change the merge-group step's
   `--max-unclassified-root-causes 300` back to `0` in
   `.github/workflows/test262-sharded.yml` (the "Build merged standalone test262
   report" step, line 654).
3. New bucket(s) must be HONEST residual catches keyed on the actual failure
   signal — do NOT poach records a narrower feature-path bucket should own
   (same discipline as the existing residual buckets, e.g. `standalone-regexp`,
   the `#2961` host-import honesty bucket). Place them LAST so `find`'s
   first-match never steals path-classified records.

## Analysis (already done — the exact 186)

All 186 are **`fail`** status (0 compile_error). Signature breakdown:

| count | error_category | first line |
| ----- | -------------- | ---------- |
| 185   | `other`        | `wasm exception during module init` |
| 1     | `unreachable`  | `RuntimeError: unreachable` (only `test/language/expressions/import.meta/distinct-for-each-module.js`) |

By top-2 path segment:

```
133  language/expressions   (compound-assignment, call, array, object, instanceof,
                             in, postfix/prefix inc/dec, strict-equals, function/dstr, …)
 18  language/types
  7  built-ins/ShadowRealm
  3  built-ins/{Boolean, SuppressedError, NativeErrors, WeakRef, AggregateError, Error}
  2  built-ins/{AbstractModuleSource, isFinite, isNaN, undefined}
  1  built-ins/{NaN, Infinity}
```

**Key distinction from the buckets that already match.** The classified
`module init` failures carry a structured trap frame the buckets key on, e.g.
`dereferencing a null pointer [in __module_init()]`, `illegal cast [in …]`,
`array element access out of bounds [in __module_init()]`. These 185 residuals
carry only the bare `wasm exception during module init` with **no function-frame
trace and no trap class** — i.e. a thrown exception propagated out of
`__module_init` without a null-deref / illegal-cast / oob signature for a
path/text bucket to grab. Many are property-descriptor / spec-assertion tests
(`prop-desc.js`, `name.js`, `length.js`, the `S11.*` assertion suites), which is
consistent with the test running and throwing a `Test262Error`-class exception
that surfaces generically.

The full 186-file list is reproducible in one command (below); avoid hard-coding
it in the classifier — bucket on the **signature**, not the path.

### Reproduce the exact set

```bash
# merged jsonl from #3369's run 29658061653 (artifact test262-merged-report):
gh run download 29658061653 -R loopdive/js2wasm -n test262-merged-report -D /tmp/m
node scripts/build-test262-report.mjs \
  --input /tmp/m/test262-standalone-results-merged.jsonl \
  --output /tmp/m/out.json --target standalone \
  --max-unclassified-root-causes 0 --baseline-sha 3634d5ab7 --include-proposals
# -> exits 1, "186 unclassified"; inspect out.json .root_cause_map.unclassified
```

## Suggested approach

Add a residual bucket matching `error_category === "other"` (or text
`wasm exception during module init`) with no more specific trap frame, plus fold
the single `unreachable` `import.meta` record into an existing import-meta /
module bucket or a tiny dedicated one. Label it honestly, e.g. "Standalone
`__module_init` threw an exception with no trap-frame / trap-class signal
(generic thrown-exception residual, #3369-exposed)". Then flip the workflow gate
300→0 and confirm the build exits 0.

## Promote note (context)

The recovered 24,172 baseline was published to the landing page via
`loopdive/js2wasm-baselines` (`test262-standalone-current.json` /
`test262-standalone-report.json`) + the main-repo summary
(`public/benchmarks/results/test262-standalone-report.json`,
`benchmarks/results/test262-standalone-highwater.json`). This issue does NOT
touch the baseline data — only the classifier + the gate threshold.
