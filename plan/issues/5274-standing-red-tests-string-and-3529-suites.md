---
id: 5274
title: "17 tests across 5 string/#3529 suites are red on main and invisible to CI"
status: ready
sprint: current
created: 2026-09-02
updated: 2026-09-02
priority: high
horizon: s
complexity: S
feasibility: easy
reasoning_effort: medium
task_type: test-fix
area: tests, ci
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r6
---

# 17 tests across 5 string/#3529 suites are red on main and invisible to CI

## Problem

Measured on `origin/main` `351f2bfc6b` (2026-09-02, before the F2-S3 lane's
first edit — recorded in the #3526 F2-S3 checkpoint note, probe P4) and
re-confirmed on `3ba791164e`: **17 tests fail across 5 files** with no change
in the working tree:

| file | red | what they pin |
| --- | --- | --- |
| `tests/issue-320.test.ts` | 1 | "handles programs with no dead imports (no-op)" — WAT now carries `string_constants."add"` / `""` module-init globals |
| `tests/imported-string-constants.test.ts` | 4 | string-constant import surface |
| `tests/issue-3529-equivalence-error-imports.test.ts` | 8 | error-path import surface |
| `tests/issue-3529-dataflow-outcomes.test.ts` | 2 | "records unary `!` coercion as unsupported" (now `emitted@patch` after #4512 `!ref` ToBoolean, `from-ast.ts:12378-12384`) and the paired invariant |
| `tests/issue-3529-ir-producer-parity.test.ts` | 2 | "preserves inferred boolean identity across an externref console boundary"; "types array-literal widening" (extra `<module-init>` outcome row) |

These are stale pins, not compiler defects: each froze a routing/import fact
that a later landed slice (#4512 ToBoolean, the module-init outcome rows of
#3523 gap 4, the string-constant global registration) deliberately changed.
The same class as #5259 (`issue-3517-map-module-init` rot, 5/14 red).

## Why CI never caught it

Same three conditions as #5259: the only job running `tests/issue-*.test.ts`
is not a required check (`issue-tests`, `.github/workflows/ci.yml:713-740`),
its pinned list (`scripts/select-changed-issue-tests.mjs:39-68`) covers none of
these five files (only `issue-3529-selector-preclaim` of the 3529 family), and
its changed-files step (`:741-745`) is advisory. Two IR-migration lanes in one
day (#3526 F2-S1/S3) each had to re-measure this red on base to keep their own
non-vacuity counts honest.

## Acceptance criteria

1. All five files green on main (`npx vitest run` on each), 17/17 fixed.
2. Each stale pin is **rewritten to assert the current truthful behavior**,
   not deleted, with a one-line comment citing the slice that changed the fact
   (#4512, #3523 gap 4, the string-constant registration change) — the #5259
   standard.
3. The fixed files' assertions are checked against the intent of the original
   issue (#320, #3529) so a real regression in that area would still be caught.
4. A note in this issue records whether the `issue-tests` job would have
   surfaced any of the 17 on a recent PR run (one run link), feeding the
   separate CI-gate decision that #5259 already asks for. Changing the gate
   design is OUT of scope here.

## Context

- Found by the #3526 F2-S3 implementation lane while establishing its
  revert-non-vacuity baseline (checkpoint note, probe P4: "17 failing tests
  across 5 files, not 4"); the F2-S3 PR (#5448) deliberately did not touch them.
- Together with #5259 this is the second standing red found in one session by
  lanes that measure base before editing; a required, changed-files-driven
  issue-tests gate would make both classes impossible to accumulate.
