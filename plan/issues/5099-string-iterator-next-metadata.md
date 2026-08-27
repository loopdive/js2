---
id: 5099
title: "fix(standalone): expose StringIteratorPrototype.next metadata"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: iterators
goal: spec-completeness
files:
  - src/codegen/array-object-proto.ts
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
failed-experiment evidence. This fix must remain metadata-only and must not
change iterator stepping or generic assert/call dispatch.

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

Commands and final counts will be recorded here after implementation. A
mergeable result requires both exact standalone rows and the host regression
control to pass; otherwise this issue remains a draft checkpoint with evidence.
