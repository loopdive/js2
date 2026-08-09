---
id: 3407
title: "test262 fixture runner emits duplicate and contradictory verdict rows; enforce one canonical result per file"
status: done
completed: 2026-07-23
created: 2026-07-18
updated: 2026-07-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: testing
language_feature: test262-harness
goal: test-infrastructure
sprint: 75
related: [1221, 2913, 2920, 3003]
origin: "2026-07-18 codebase engineering audit (plan/log/2026-07-18-codebase-engineering-audit.md, F2)"
---

# #3407 — enforce one canonical test262 verdict per file

## Problem

The current fetched JS-host baseline has **48,113 JSONL rows for 48,088 unique
test files**: 25 duplicate keys. Twenty-two duplicate pairs are fail/fail with
different diagnostics, and three are contradictory fail/pass pairs:

```text
test/language/module-code/top-level-await/module-import-rejection-body.js
test/language/module-code/top-level-await/module-import-rejection-tick.js
test/language/module-code/top-level-await/module-import-rejection.js
```

The canonical JSONL therefore does not satisfy one-verdict-per-file. The report
builder masks the source defect with worst-status dedup, while `diff-test262`
uses last-write-wins. The same baseline file can be a fail in the published
summary and a pass in regression analysis.

## Verified root cause

`recordResult` writes a JSONL row and throws `ConformanceError` for every
non-pass verdict. In the fixture execution path, the inner catch at
`tests/test262-shared.ts:779-831` catches that sentinel and calls
`recordResult` again:

- an ordinary failure is written once with its real diagnostic, then again as
  `ConformanceError: [fail] ...`;
- a runtime-negative "execution succeeded" failure can be caught and then
  reclassified as a pass.

The outer catch at `tests/test262-shared.ts:833-841` has the #1221 guard that
rethrows `ConformanceError`, but the duplicate has already been written by the
inner catch.

The merge workflow concatenates shard files without validating identity
uniqueness (`.github/workflows/test262-sharded.yml:622-644`). Consumers then
apply incompatible policies:

- worst-status precedence in `scripts/build-test262-report.mjs:902-960`;
- last-write-wins in `scripts/diff-test262.ts:519-533`.

## Relationship to #2913

#2913 completed defensive dedup for headline reports and edition summaries. Its
resolution explicitly left the duplicate-write source as a follow-up. This
issue keeps that completed work intact and owns the remaining producer,
canonical-data, and consumer-consistency contract.

## Scope

- Stop the fixture execution path from recording a second verdict after
  `recordResult` throws its sentinel.
- Define a single result identity key for the current runner. Today that is
  `file` because each row has `strict: "both"`; if future strict variants become
  separate executions, include the variant explicitly rather than overloading
  one file key.
- Validate merged JSONL uniqueness before report construction, diffing, or
  promotion.
- Make every defensive consumer share one duplicate policy. Contradictory
  duplicates must fail loudly; they must not be silently resolved by row order.

## Implementation steps

1. Add a fixture-path regression that forces each inner `recordResult` branch
   (ordinary fail, expected runtime-negative pass, unexpected runtime-negative
   success) and asserts exactly one emitted row.
2. In the inner fixture execution catch, rethrow `ConformanceError` before any
   error-classification branch. Preserve the outer guard as defense in depth.
3. Extract a streaming JSONL identity validator/shared loader used by report,
   diff, and baseline-promotion checks. It should report duplicate keys, both
   statuses, and source row numbers.
4. Add a merge-report step immediately after concatenation that rejects any
   duplicate key. Do not "fix" the canonical artifact by silently deleting
   rows.
5. Align defensive historical-file behavior. Same-status identical retries may
   use one documented deterministic record; conflicting statuses must be a hard
   error unless an explicit retry-attempt schema defines which verdict is
   canonical.
6. Refresh the baseline after the producer fix and verify report, diff, editions,
   trap growth, and feature generators all see the same 48,088 identities.

## Acceptance criteria

- [ ] A full merged JS-host and standalone JSONL contains exactly one canonical
      row per result identity key.
- [ ] The three current fail/pass duplicate files each have one stable verdict.
- [ ] `build-test262-report` and `diff-test262` cannot disagree because of
      duplicate row order.
- [ ] Merge/promotion fails with an actionable diagnostic when synthetic input
      contains a conflicting duplicate.
- [ ] Report totals, category totals, editions, and diff population all reconcile
      to the same unique-key count.
- [ ] Retry metadata remains representable without creating a second canonical
      verdict row.

## Validation plan

- Unit tests with identical duplicates, same-status/different-diagnostic
  duplicates, fail/pass conflicts, malformed rows, and missing file keys.
- Targeted fixture-runner tests for positive, ordinary-fail, compile-error,
  runtime-negative-pass, and runtime-negative-fail paths.
- Build reports from the pre-fix baseline and prove the validator identifies
  exactly the measured 25 keys.
- Run the relevant test262 path filter for `language/module-code` and confirm no
  duplicate keys.
- `pnpm run typecheck`, formatting, and issue integrity.
- If canonical verdict selection changes rather than merely removing the second
  write, follow #3003: version/rebaseline the oracle in a queue-safe rollout.

## Dependencies

- #2913 supplies the current defensive report precedence and fixtures.
- #1221 documents the earlier outer-catch attempt and must not be regressed.

## Risks

- A fail-loud uniqueness check will block baseline promotion until every writer
  obeys the invariant; wire it only with the producer fix in the same change.
- Raw retries may be intentionally append-oriented. Preserve attempt telemetry
  separately instead of treating two attempts as two canonical test results.
- Changing a pass/fail conflict to one verdict can look like a conformance delta.
  The baseline and oracle rollout must make that policy transition explicit.
