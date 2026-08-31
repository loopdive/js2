---
id: 5232
title: "Issue-test regression gate lets files and assertions disappear without a verdict"
status: ready
sprint: current
created: 2026-08-31
updated: 2026-08-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: max
task_type: infrastructure
area: testing, ci
language_feature: n/a
goal: dogfood
related: [3008, 3340, 3552, 4253]
requested_by: ttraenkler/codex-sol-ultra
---

# #5232 — make regression-test population loss a failing event

## Problem

The post-merge issue-test gate protects only observed failures. Its IDs encode
the observed file and assertion name, but it has no expected population or
explicit shard identity:

- `scripts/issue-tests-gate.mjs:60-73` enumerates only files that exist now;
- reporter parsing at lines 154-170 records only `failed` and `passed`
  assertions;
- shard artifacts at lines 191-201 contain three observed ID sets but no shard
  number, enumerated file list, expected assertion denominator, or skip/todo
  population;
- the baseline at lines 204-205 stores only `knownFailures`;
- comparison at lines 253-255 asks only whether a current failure is new or a
  known current assertion now passes.

The required PR selector compounds this: `scripts/hooks/changed-root-tests.sh`
uses `git diff --diff-filter=AM`, so deletion is outside the per-PR gate.

Consequently, deleting or renaming a green regression file, changing an
assertion to `.skip`/`.todo`, or losing part of collection simply removes
identities from observation. `runVitest()` also ignores the subprocess status
whenever a JSON report exists, so a non-zero run that emits a partial report can
still produce a successful shard artifact. A missing identity is neither
failing nor passing, so the merge verdict can remain green.

The normal matrix does **not** hide a failed or missing shard job:
`.github/workflows/issue-tests.yml:79-80` makes `gate` depend on the complete
`shard` matrix. The unchecked case is a matrix whose jobs report success but
whose downloaded artifacts are incomplete, duplicated, mislabeled, or empty;
the merge has no expected artifact count or identity against which to compare.

## Deterministic reproduction

Given a baseline:

```json
{"knownFailures":["tests/deleted.test.ts :: previously known broken assertion"]}
```

and a successfully downloaded partial set containing empty `failing`,
`passing`, and `unexpectedPasses` arrays, the normal `--update-on-decrease`
command reports:

```text
0 failing, 0 passing, 1 known in baseline.
No new root-suite regressions.
```

and exits **0** without changing the baseline. Previously green assertions are
even less visible because their identities were never recorded.

Positive controls remain sound: an unexpected pass exits 1, an ordinary known
failure exits 0, and a new observed regression exits 1. This issue is the
unprotected *loss of observation*, not those verdict paths.

## Direction

Carry a reviewed population contract through every shard: shard identity,
enumerated files, assertion IDs/counts, and skipped/todo counts. Store at least
the expected file/assertion identity set, including known-green assertions.
Require explicit rename/removal metadata for intentional shrinkage and reject
missing, duplicate, or wrong-identity artifacts before merging verdicts. Treat
a non-zero Vitest subprocess as failed even if it managed to write JSON.

## Acceptance criteria

- [ ] Deleting or renaming a registered assertion exits non-zero and names the
      lost identity.
- [ ] Converting a registered assertion to `.skip` or `.todo` exits non-zero.
- [ ] An intentional removal/rename needs explicit, reviewed metadata and
      cannot silently broaden to unrelated tests.
- [ ] Missing, duplicate, or wrong-identity shard artifacts are rejected.
- [ ] A shard process that exits non-zero cannot emit a successful partial even
      when a JSON report exists.
- [ ] Existing positive controls for new regression, known failure, and
      unexpected pass keep their current verdicts.
- [ ] An unchanged full population across all expected shards exits 0.
