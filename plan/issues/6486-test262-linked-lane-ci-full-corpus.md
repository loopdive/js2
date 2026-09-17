---
id: 6486
title: "test262 CI: run the linked-harness lane on the full corpus as a shadow job with a same-run parity report — prerequisite for making it the default"
status: done
completed: 2026-09-16
sprint: current
created: 2026-09-16
updated: 2026-09-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infra
area: ci
goal: test262-conformance
depends_on: [3451, 6474, 6477]
related: [3451, 6482, 6483, 5353]
---

# #6486 — linked lane on the full corpus in CI (slice 5 of #3451)

## Why

The project lead wants the linked-harness lane (`TEST262_ORACLE_MODE=linked`,
body compile 15–20× faster, sample wall 156 s vs 414 s) to be the CI default.
#3451's own order is: slice 5 (full-corpus two-lane parity) BEFORE slice 6 (the
authority flip). Today nothing in CI runs the linked lane at all —
`.github/workflows/test262-sharded.yml` never sets `TEST262_ORACLE_MODE` — so
the only parity numbers are hand-run samples (471 rows: linked 361 vs honest
371 after #6474/#6477). A flip on that evidence would trip the regression gate
on an unknown number of rows and would re-seed the published baseline from a
lane that has never been measured whole.

This issue adds the measurement: a non-blocking CI job that runs the linked
lane over the same 52 host chunks as the honest job, plus a same-run parity
report. The flip itself is a follow-up issue gated on this report.

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

### P1 — shadow job `test262-linked` in `test262-sharded.yml`

Model it on `test262-native-first` (~L925–1071, the existing non-promoting
shadow lane), not on the required host job:

- `if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.linked_lane)`
  — add the `linked_lane` boolean input next to `native_first` (~L73). It must
  NOT run on `merge_group` / `pull_request` and must never be a required check.
- Same chunk matrix as the host job (the 52-chunk list the required
  `test262 js-host shard` matrix uses — read it from the workflow, do not copy
  the native-first 57-list blindly), `TEST262_TARGET: gc`.
- `env`: `TEST262_ORACLE_MODE: linked`, `TEST262_RESULT_PREFIX: test262-linked`,
  `RUN_TIMESTAMP: ${{ github.run_id }}-linked-chunk${{ matrix.chunk }}`, the
  same pool/heap/proposals settings as the host job.
- Steps identical to native-first (checkout, setup, install, build compiler
  bundle + runtime bundle, run shard, completeness validation, upload
  `test262-linked-shard-<n>` with the #3404 retry). The worker builds harness
  providers on demand per fork (`getWorkerHarnessProvider`, memoised per
  prefix); 64 providers × 0.7–2.9 s is acceptable per shard, so no prewarm step
  in this slice. If shard time shows provider builds dominating, use
  `scripts/prewarm-test262-harness-providers.mjs` + a cached artifact the way
  the Temporal provider is downloaded (#5353) — measure first.
- Also stamp the honest job's rows? No — do not touch the required jobs.

### P2 — `merge-linked-report` + parity report

- Job modelled on `merge-native-first-report` (~L1074–1111): download
  `test262-linked-shard-*`, concatenate to
  `linked-results/test262-linked-current.jsonl`, validate completeness across
  all manifests, build the report JSON, upload `test262-linked-baseline-<sha>`.
  It never promotes anything.
- Parity: `scripts/diff-test262.ts` REFUSES a linked lane unconditionally (L1616–
  1625) — that guard stays. Add a separate, clearly non-authoritative tool
  `scripts/test262-linked-parity.mjs <honest.jsonl> <linked.jsonl>` that:
  - joins rows by test path (both lanes of the SAME run: the honest rows come
    from the `test262-js-host-shard-*` artifacts of this run, so the job needs
    `needs: [test262-linked, <host shard job>]` with `if: always()` semantics
    like the merge job, and must skip cleanly when the host shards did not run);
  - reports: common rows, agreement count and %, linked pass/fail/CE/timeout
    totals vs honest, `pass→fail` / `fail→pass` lists, rows stamped
    `oracle_lane: linked-harness-fallback` with their `fallbackReason`
    histogram (a fallback row is a linked-lane miss, count it separately), and
    a message-bucket histogram of the differences (first 80 chars of the
    error) sorted by size;
  - writes `linked-results/test262-linked-parity.json` + a Markdown summary to
    `$GITHUB_STEP_SUMMARY`; exit 0 always (measurement, not a gate).
  - Unit test `tests/issue-6486-linked-parity-report.test.ts` on two tiny
    synthetic JSONL files (agreement, a fallback row, a pass→fail row).
- Wall time: the shard job durations are in the Actions API; in the summary,
  print each lane's total `Run shard` seconds if cheaply available from
  `${{ toJson(needs) }}` — otherwise sum the rows' `compile_ms`/`exec_ms`
  (both lanes) and say which one it is.

### P3 — first full-corpus measurement (Fable lane, after merge)

Dispatch the workflow on main with `linked_lane: true`, record in
`plan/issues/3451-…md`: full-corpus agreement, fallback count and reasons,
top difference buckets (file each as an issue or attribute to #6482/#6483),
and wall time per lane. That record is the input for the flip issue.

### Acceptance

- [ ] `workflow_dispatch` with `linked_lane: true` runs 52 linked shards + the
      parity job green; required checks and the merge-queue path are untouched
      (`docs/ci-policy.md` list unchanged; the new jobs are not in the ruleset).
- [ ] `tests/issue-6486-linked-parity-report.test.ts` green; the parity tool
      exits 0 on differences and refuses nothing.
- [ ] `scripts/diff-test262.ts`'s linked-lane guard unchanged (test in
      `tests/issue-3451-linked-harness-lane.test.ts` still green).
- [ ] Workflow lint: `node scripts/check-workflow-*.mjs` if present, and the
      `quality` gate's workflow checks.

## Implementation notes (2026-09-16, Opus lane) — P1 + P2 done, P3 open

`status:` stays **in-progress** on purpose: P3 (the first full-corpus dispatch
and the record written into #3451) is the lead's, and nothing in this branch
can produce that number.

### What landed

**P1 — `test262-linked`** in `.github/workflows/test262-sharded.yml`, inserted
between `merge-native-first-report` and `test262-shard`, modelled on
`test262-native-first`.

- `if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.linked_lane)`;
  new boolean input `linked_lane` next to `native_first`.
- Matrix is the **57**-chunk list, not 52 — the plan and the dispatch brief
  both say "the 52-chunk matrix the required js-host job uses", but the job's
  actual list, read out of the workflow as instructed, is 1…57 (identical to
  native-first's). 52 does not appear anywhere in this workflow. Using 57 is
  what makes the rows join 1:1 with the honest host rows, which is the whole
  point of the count; `--expected-shards 57` in the merge job matches.
- `env`: `TEST262_TARGET: gc`, `TEST262_ORACLE_MODE: linked`,
  `TEST262_RESULT_PREFIX: test262-linked`,
  `RUN_TIMESTAMP: ${{ github.run_id }}-linked-chunk${{ matrix.chunk }}`, plus
  the host job's pool/heap/proposals settings.
- No harness-provider prewarm, per the plan; the comment records the #5353
  escape hatch and says to measure first.

**P2 — `merge-linked-report`** + `scripts/test262-linked-parity.mjs`.

- The job downloads `test262-linked-shard-*`, concatenates, validates
  completeness across all manifests, builds
  `linked-results/test262-linked-current.json`, runs the parity tool, and
  uploads `test262-linked-baseline-<sha>`. It promotes nothing.
- The honest side is a `continue-on-error` download of this run's
  `test262-js-host-shard-*`. On a **schedule** run `test262-shard` does not run
  at all (its `if:` admits only push/workflow_dispatch), so there are no honest
  artifacts and the parity step skips cleanly through `--allow-missing`; the
  linked report is still published. `needs: [test262-linked, test262-shard]`
  with `always() && needs.test262-linked.result == 'success'` is what makes that
  skip a skip rather than a failure.
- The tool reports: common/only-one-side row counts, agreement count and %,
  per-status totals per lane, `pass→fail` / `fail→pass` / other-difference
  lists, the fallback-row count with a **reason histogram**, error-message
  buckets (first 80 chars, sorted by size), and row-summed compile/exec ms —
  explicitly labelled as row-summed, **not** job wall time, since `toJson(needs)`
  does not carry step durations.
- It joins on **(file, strict)**, not file alone: a file with both strict
  variants emits two rows and a file-only key would collide them.
- `scripts/diff-test262.ts`'s linked-lane refusal is **untouched** (verified:
  the file is not in this branch's diff); the tool's header says why the
  cross-lane comparison is allowed *here* — its output can never reach a gate
  or a published baseline.

**Row-schema change (not in the plan, needed by it).** The plan asks for a
`fallbackReason` histogram, but the reason was never in the JSONL — only
`linkedFallback: true` (→ `oracle_lane: linked-harness-fallback`) plus a
once-per-fork stderr line that cannot be joined back to the rows it degraded.
So `scripts/test262-worker.mjs` now carries `linkedFallbackReason` on the
payload and `tests/test262-shared.ts` emits `linked_fallback_reason` (truncated
to 200 chars). It is present **only** on a fallback row in the linked lane;
honest rows are byte-identical.

### Validated in-container

- `tests/issue-6486-linked-parity-report.test.ts` — 8 tests green (agreement,
  fallback counted separately + reason histogram, pass→fail and fail→pass
  split, (file,strict) keying, wrong-lane rows rejected rather than mixed,
  Markdown says NON-AUTHORITATIVE, CLI exits 0 on a difference and writes the
  JSON, `--allow-missing` skip path).
- **End-to-end on real rows**: `tests/test262-local-shard1.test.ts` run twice
  with `COMPILER_POOL_SIZE=1 TEST262_PATH_FILTER=language/statements/if`, once
  honest and once with `TEST262_ORACLE_MODE=linked`, then the tool on the two
  JSONLs. 12 common rows, 100 % agreement, **11 of 12 rows were linked-lane
  fallbacks** with reasons like "Lexical declaration cannot appear in a
  single-statement context" (×4) and "Generator declarations are not allowed in
  statement position" (×3). That directory is the pathological case for a
  body-only split, so it is not a corpus estimate — but it is exactly the
  signal P3 needs, and it would have been invisible without the reason field.
- Workflow parsed structurally with `yaml`: 57 linked chunks == 57 host chunks;
  `merge-linked-report` is the ONLY job whose `needs` mentions either new job;
  no required context name (`merge shard reports`, `check for test262
  regressions`, `cheap gate`, `quality`, `equivalence-gate`, `cla-check`) is
  produced by them. `docs/ci-policy.md` is not modified.
- `tests/issue-3451-linked-harness-lane.test.ts` (4) and `tests/issue-3462.test.ts`
  (12) still green.
- Gates, run bare: loc-budget, func-budget, coercion-sites, oracle-ratchet,
  dead-exports, host-import-policy, typecheck, lint — all exit 0.

### NOT validated in-container

The live workflow run. There is no `gh` in this container and a 57-shard matrix
is not runnable locally, so `workflow_dispatch(linked_lane: true)` — the first
acceptance box — is unverified by construction. The failure modes it would
catch that the structural parse cannot: an artifact-name typo between the
shard upload and the merge download, and the `--expected-shards 57`
completeness assertion against a real 57-shard set.

### Acceptance box status

- [~] `workflow_dispatch` with `linked_lane: true` runs 52 (→ **57**) linked
      shards + the parity job green — **not verifiable in-container**;
      structurally parsed, matrix count matched to the host job, isolation from
      the required jobs verified. Required checks and the merge-queue path are
      untouched: `docs/ci-policy.md` unchanged, neither new job is in the
      ruleset, and no required job `needs:` them.
- [x] `tests/issue-6486-linked-parity-report.test.ts` green; the tool exits 0
      on differences and refuses nothing.
- [x] `scripts/diff-test262.ts`'s guard unchanged;
      `tests/issue-3451-linked-harness-lane.test.ts` green.
- [x] No `scripts/check-*workflow*` script exists in this repo; `npm run lint`
      (biome) and `typecheck` pass.

### Fallback class identified before P3 (2026-09-16, Fable lane)

The 11/12 fallbacks the in-container `language/statements/if` run showed are
all `negative: SyntaxError` rows (`if-const-else-const.js`, `if-gen-no-else.js`,
…): the linked compile fails with exactly the expected diagnostic, the worker
records a fallback and recompiles the honest assembly, which fails the same way
and scores `pass`. Verdict correct, cost small (a parse failure never reaches
codegen). For P3, read the parity report's fallback histogram with negative
rows split out: a fallback on a `negative: parse|early` row is expected and
cheap; a fallback on a positive row is the throughput signal. If the positive
share is material, the worker can score a negative row's linked diagnostic
directly instead of recompiling — a later, separate change.

## P3 — first full-corpus measurement (2026-09-16, run 35116762391, main @ 8eeaee8e, `linked_lane=true`)

| metric | honest | linked |
| --- | ---: | ---: |
| rows | 48,735 | 48,735 |
| pass | 38,551 | 34,420 |
| fail | 9,551 | 13,846 |
| compile_error | 507 | 349 |
| compile_timeout | 12 | 6 |
| shard wall, median / max (57 shards) | 326 s / 376 s | 152 s / 199 s |
| shard wall, total | 17,989 s | 8,508 s |
| row-summed compile_ms | 52.7 M | 16.1 M |
| row-summed exec_ms | 2.17 M | 1.44 M |

Agreement 43,742 / 48,735 (89.75 %); pass→fail 4,499; fail→pass 368; other
126. Linked fallbacks 4,635 (9.5 %), all `linked compile failed: <syntax
diagnostic>` — i.e. negative-syntax rows scored by the honest recompile, as
predicted above.

Difference buckets, attributed:

| rows (≈) | bucket | cause |
| ---: | --- | --- |
| ~1,300 | `Temporal is not defined`, `… null (reading 'since'/'until'/…)`, `since/until/round/total is not a function`, `Expected a RangeError but got a TypeError` | #6489 — the linked job never downloads the Temporal / runtime-eval providers |
| ~1,340 | `dereferencing a null pointer [in testWithAllTypedArrayConstructors() …]` | #6490 — provider-side null deref in the typed-array helper |
| 36 | `expected SyntaxError but compiled with no diagnostic` | #6491 |
| 35 + 27 + 24 | `Invalid descriptor field: label`, `0 descriptor should not be …`, `4 should be an own property` | #6482 residuals |
| 49 + 29 | `Expected a undefined to be thrown …`, `Expected a undefined but got a TypeError` | unclassified — a provider-side `assert.throws(undefined, …)`-shaped mismatch; sample after #6489/#6490 |

The `check for test262 regressions` job of the same dispatch failed on the
HONEST lane against a 35-hour-old baseline from a different lane (29,587 pass,
compile-time base 6× lower) — a measurement artifact of the dispatch path, not
of this slice; no promotion happened.

Conclusion for the flip: with #6489 and #6490 fixed the expected remaining
difference is well under 1 % of the corpus; the flip PR (slice 6) waits for the
next dispatch after those two land.

## P3b — second full-corpus measurement (2026-09-16, run 35144322208, main @ c55be108e0, after #6489 PR #5948 + #6490 PR #5949)

| metric | honest | linked |
| --- | ---: | ---: |
| rows | 48,735 | 48,735 |
| pass | 38,555 | 35,332 |
| fail | 9,546 | 12,883 |
| compile_error | 507 | 400 |
| compile_timeout | 13 | 6 |
| row-summed compile_ms | 51.6 M | 13.9 M |
| row-summed exec_ms | 2.12 M | 1.94 M |

Agreement 44,655 / 48,735 (91.63 %, from 89.75 %); pass→fail 3,576 (from
4,499); fail→pass 353; other 151. Linked fallbacks 9,246 (18.97 %): 4,611 are
`temporal row: honest compile` (the #6489 honesty stamp — every Temporal row is
honest-compiled inside the linked run), the rest negative-syntax rows as before.

Difference buckets, attributed:

| rows | bucket | cause |
| ---: | --- | --- |
| 2,000 + 723 + 155 | `assert is not defined`, `TemporalHelpers is not defined`, `verifyProperty is not defined` | #6489 second-run finding: the Temporal branch compiled the body-only unit without the harness prefix inside a linked run. Fixed in the #6489 follow-up PR (A/B on three rows: fail→pass). |
| 128 | `Cannot convert 0 to a BigInt (Testing with BigInt64Array …)` | new, provider-side: the #6490 host-dispatch path now reaches the BigInt typed-array constructors; sample next run |
| 61 | `AsyncTestFailure: … Cannot read properties of null (reading 'the…` | unclassified async rows |
| 49 + 26 | `Expected a undefined to be thrown …` / `… but got a TypeError` | unclassified (carried from P3) |
| 36 | `expected SyntaxError but compiled with no diagnostic` | #6491 |
| 35 + 27 + 24 + 19 + 18 | descriptor-shape buckets | #6482 residuals |
| 24 | `Cannot read properties of null (reading 'catch') [in __module_init()]` | unclassified |
| 23 + 12 | `No dependency provided for extern class "badArrayType" / "OProxy"` | provider-side extern class stubs; new |
| 22 | `illegal cast [in __cb_2() ← __closure_62]` | provider-side, likely #6490 sibling (`compileReceiverMethodCall`) |

The `dereferencing a null pointer` (#6490) and `Temporal is not defined` (#6489)
buckets are both gone. Removing the harness-prefix bucket alone puts the lane
at ≈ 97 % agreement; the flip (slice 6) waits for that dispatch and a triage of
the ~600 residual rows above.

## P3c — third full-corpus measurement (2026-09-16, run 35152748683, main @ 52b8143a39, after the #6489 harness-prefix fix PR #5950)

| metric | honest | linked |
| --- | ---: | ---: |
| rows | 48,735 | 48,735 |
| pass | 38,555 | 38,203 |
| fail | 9,546 | 10,050 |
| compile_error | 507 | 362 |
| compile_timeout | 13 | 6 |
| row-summed compile_ms | 52.7 M | 26.0 M |
| row-summed exec_ms | 2.15 M | 2.38 M |

Agreement 47,564 / 48,735 (**97.6 %**); pass→fail 705; fail→pass 353; other
113; net −352 pass. Fallbacks unchanged at 9,246 (4,611 Temporal rows honest-
compiled WITH the harness now, which is why row-summed compile rose from 13.9 M
to 26.0 M — those rows pay the honest price by design until a Temporal co-link
slice). Both harness buckets (`assert`/`TemporalHelpers is not defined`) are
gone, as the A/B predicted.

Residual buckets (all provider-side or verdict-side; tracked in #6492 unless
named):

| rows | bucket | owner |
| ---: | --- | --- |
| 128 | `TypeError: Cannot convert 0 to a BigInt (Testing with BigInt64Array …)` | #6492 |
| 61 | `AsyncTestFailure: Cannot read properties of null (reading 'the…` | #6492 |
| 49 + 26 | `Expected a undefined to be thrown …` / `… but got a TypeError` | #6492 |
| 36 | `expected SyntaxError but compiled with no diagnostic` | #6491 |
| 35 + 27 + 24 + 19 + 18 + 10 | descriptor-shape buckets | #6482 |
| 24 + 9 + 9 | `Cannot read properties of null/undefined (reading 'catch'/'next') [in __module_init()]` | #6492 |
| 23 + 12 | `No dependency provided for extern class "badArrayType" / "OProxy"` | #6492 |
| 22 | `illegal cast [in __cb_2() ← __closure_62]` (uncatchable trap — blocks the flip via the #3189 trap ratchet) | #6492 |
| 22 | `Thrown value was not an object!` | #6492 |
| 18 + 15 + 14 + 12 | `Expected a TypeError …`, `async completion marker not observed`, `Expected a SyntaxError …`, `AsyncTestFailure: Expected true but got false` | #6492 |
| 16 | `import.defer(...) is not supported` (proposal rows; honest lane CE, linked fail) | verdict-shape, harmless |

The 353 fail→pass rows are mostly `dynamic-import/syntax/valid/*import-defer|source*` (honest CE, linked pass) and `Object.defineProperty`/`Proxy/*-realm` rows; they are not counted against the lane but are listed in the JSON artifact for the flip's rebase declaration.

Slice 6 plan: `plan/issues/3451-linked-harness-wasm-separate-compilation.md`, "Implementation Plan — slice 6".

## P3d — fourth full-corpus measurement (2026-09-17, run 35169442028, main @ 4602588c69, after #6492 round 1 PR #5953)

| metric | honest | linked |
| --- | ---: | ---: |
| pass | 38,555 | 38,309 |
| fail | 9,546 | 9,944 |
| compile_error | 507 | 362 |
| compile_timeout | 13 | 6 |
| row-summed compile_ms | 51.7 M | 24.5 M |
| row-summed exec_ms | 2.10 M | 2.22 M |

Agreement 47,666 / 48,735 (**97.81 %**); pass→fail 601 (from 705); fail→pass
355; other 113; net −246. Fallbacks unchanged (9,246). The `illegal cast`
bucket is gone and **no new uncatchable-trap category appears** — the #3189
ratchet precondition for the flip holds. `AsyncTestFailure … null (reading
'then')` 61 → 23 (the scoped async-callback fix covers the linked consumer;
the remaining 23 are rows whose callback is minted inside the provider — same
lane-independent defect, see #6492). `Cannot convert 0 to a BigInt` 128 is
unchanged here because round 2 (PR #5954) had not landed; its 275-row sample
measured 40 → 0.

Residual after P3d, top buckets: BigInt 128 (fixed in #5954), class-value
crossing 49 + 26 (#6492 round 3), #6491 36, #6482 descriptor family ≈ 130,
extern-class stubs 35, `__module_init` null catch/next 33, async-null 23.
Projection once #5954 lands: ≈ 473 pass→fail; after the class-value crossing
≈ 370.
