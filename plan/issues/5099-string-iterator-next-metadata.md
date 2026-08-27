---
id: 5099
title: "fix(standalone): expose StringIteratorPrototype.next metadata"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-28
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

# #5099 — expose StringIteratorPrototype.next metadata

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
iterator stepping or generic assert/call dispatch. Issue #5099 was closed by the
user after the draft checkpoint; this markdown is the only tracking record.

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
repeated after synchronizing with `upstream/main` at `857b343f344d566f3f382168a8538dd8dca26f2c`:

- authoritative standalone first run: `2/2` pass; host first run: `2/2` pass;
  each run's positive controls reported both pass and fail outcomes;
- authoritative standalone repeat: `2/2` pass, `nondeterministic: 0`; host
  repeat: `2/2` pass, `nondeterministic: 0`;
- focused Vitest regression: `6/6` tests passed with one fork (max two workers).

- synchronized-tree repeat: host `2/2` and standalone `2/2`, each with both
  structural controls and `nondeterministic: 0`.

Draft PR #5103 remains held and outside the merge queue until repository
quality gates and CI are green; then it can be marked ready and enqueued.
