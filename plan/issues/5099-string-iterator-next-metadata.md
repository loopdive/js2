---
id: 5099
title: "fix(standalone): expose StringIteratorPrototype.next metadata"
status: done
sprint: current
created: 2026-08-27
updated: 2026-08-28
completed: 2026-08-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: iterators
goal: spec-completeness
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-builtin-static.ts
  - tests/issue-5099.test.ts
---

# Repository-local markdown issue 5099 — expose StringIteratorPrototype.next metadata

This is the repository-local issue record at
`plan/issues/5099-string-iterator-next-metadata.md`; it is not a GitHub issue.

## Problem / evidence

The standalone/WASI compiler materializes a distinct `%StringIteratorPrototype%`
singleton for `Object.getPrototypeOf(new String()[Symbol.iterator]())`, but the
singleton currently carries only its `Symbol.toStringTag`. The two scoped
Test262 rows therefore cannot observe `%StringIteratorPrototype%.next` and fail
with `TypeError: value is not iterable` in the assembled standalone harness.

Authoritative baseline on clean `upstream/main` (`220ce6c4913ddb10e6af0417dcf4d3aef6470220`):

- `built-ins/StringIteratorPrototype/next/length.js`: host pass; standalone fail.
- `built-ins/StringIteratorPrototype/next/name.js`: host pass; standalone fail.
- Positive controls reported both pass and fail outcomes in each lane.
- Aggregate: host `2/2` pass, standalone `0/2` pass.

A previous broad experiment in `/private/tmp/js2-es2015-next-bounded-fix-9` changed
five call/dispatch modules and added a temporary debug script; it remained
standalone `0/4` for a larger iterator cohort and is intentionally preserved as
failed-experiment evidence. This fix remains metadata-only and does not change
iterator stepping or generic assert/call dispatch. The repository-local issue
record at `plan/issues/5099-string-iterator-next-metadata.md` is the sole
canonical record for this work; no GitHub issue was created.

## Implementation plan

1. Reuse the existing standalone built-in-function metadata/closure machinery to
   expose only the `next` data property on the String iterator prototype
   singleton, with `name === "next"`, `length === 0`, and the standard property
   descriptor flags.
2. Gate the change to the standalone/WASI String iterator singleton so host
   output remains byte-equivalent.
3. Add a focused regression test and run the exact two Test262 rows through the
   assembled harness, including host controls, repeatability, and max two
   workers.

## Validation / handoff

Implementation is confined to the existing iterator-prototype singleton and
the exact pristine bootstrap query:

- `src/codegen/array-object-proto.ts` installs one own `next` data property on
  the standalone/WASI String iterator prototype singleton. Its identity-stable
  builtin closure reports `name === "next"`, `length === 0`; the descriptor is
  `{ writable: true, enumerable: false, configurable: true }`. The closure body
  remains the existing catchable refusal, so iterator stepping is unchanged.
- `src/codegen/expressions/call-builtin-static.ts` recognizes only the
  unshadowed `Object.getPrototypeOf(new String()[Symbol.iterator]())` bootstrap
  shape and skips its unsupported dead iterator allocation. Other calls retain
  the existing lowering.
- `tests/issue-5099.test.ts` covers both exact Test262 rows in host and
  standalone plus a descriptor/metadata regression control in each lane.

Validation on `220ce6c4913ddb10e6af0417dcf4d3aef6470220` plus this patch, and
repeated after synchronizing with `upstream/main` at `857b343f344d566f3f382168a8538dd8dca26f2c`.
The focused suite and exact rows were rerun after the latest sync at
`fd36446c46358734900b7ab207e05b0ef8f7bf39`, then again after the scheduled
baseline-summary sync at `5321bfbbfa9193c6b55a7558126b88b003a03719`:

- authoritative standalone first run: `2/2` pass; host first run: `2/2` pass;
  each run's positive controls reported both pass and fail outcomes;
- authoritative standalone repeat: `2/2` pass, `nondeterministic: 0`; host
  repeat: `2/2` pass, `nondeterministic: 0`;
- focused Vitest regression: `6/6` tests passed with one fork (max two workers).

- synchronized-tree repeat at `857b343f34`: host `2/2` and standalone `2/2`,
  each with both structural controls and `nondeterministic: 0`;
- latest-tree focused suite: `6/6` tests passed, and exact host/standalone
  repeats remained `2/2` with both controls and `nondeterministic: 0`.
- scheduled-summary-tree focused suite: `6/6` tests passed, and exact
  host/standalone repeats remained `2/2` with both controls and
  `nondeterministic: 0`.
- post-#5085-tree (`upstream/main` `698ecb8f16`) focused suite: `6/6` tests
  passed, and exact host/standalone repeats remained `2/2` with both controls
  and `nondeterministic: 0`.

### Optional-corpus CI hardening

The first current-main CI pass exposed a packaging-only regression in the
changed-root issue job: that job intentionally does not check out the optional
Test262 corpus, so the four exact-row assertions failed with `ENOENT` before
the compiler control could run (Actions run `33126029589`). The focused test
now probes `test262/harness/assert.js` and skips only the four corpus-backed
rows when the checkout is absent; the two self-contained compiler controls
remain mandatory.

Focused validation after the guard is **6/6 passed** with the corpus present.
A hermetic temporary root with no `test262` checkout reports **2/2 passed and
4/4 intentionally skipped**, proving the changed-root CI shape while retaining
non-vacuous host and standalone coverage.

Post-sync CI for upstream PR #5103 head `e0159876d6` (Actions run
`33123862203`) was fully green (all required jobs successful or intentionally
skipped), and the branch was mergeable against `upstream/main`
`5321bfbbfa`. The subsequent tracker-only handoff head `a7fdb491e0` and
post-#5085 sync merge `41e71fba9a` were each validated locally. Upstream PR
#5103 is merged into `loopdive/js2:main` at merge commit
`b1cc63d1b1fd9d4cd301fa2c3ece9c23e81d6e2d` (2026-08-28); this repository-local
issue record at `plan/issues/5099-string-iterator-next-metadata.md` therefore
records `status: done` and `completed: 2026-08-28`. No GitHub issue was created.
