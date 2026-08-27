---
id: 5104
title: "fix(standalone): preserve Boolean prototype Symbol.toStringTag"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: boolean-wrapper
es_edition: 2015
goal: spec-completeness
assignee: "ttraenkler/es2015-next-lane-b2"
files:
  - src/codegen/array-object-proto.ts
  - tests/issue-5104-boolean-prototype-tostringtag.test.ts
  - plan/issues/5104-boolean-prototype-tostringtag.md
---

# Boolean prototype `Symbol.toStringTag`

## Scope and baseline

This plan owns exactly these two official Test262 rows:

```text
test/built-ins/Boolean/prototype/S15.6.3.1_A1.js
test/built-ins/Boolean/S15.6.2.1_A4.js
```

On clean source `caeaa2e1cf2aa225297c53076d27f97c8449a527`, the assembled
official harness reports host `2/2` and standalone `0/2`. Both rows delete the
own `Boolean.prototype.toString` method and then rely on
`Object.prototype.toString`; standalone observes `"false"` instead of the
required `"[object Boolean]"`. Structural controls report one required pass
and one required failure in both lanes, and the standalone repeat is stable.

The cohort is file-disjoint from the active iterator, Set, BigInt, yield-star,
isNaN, and WeakCollection work. It changes no constructor, wrapper unboxing,
or generic `Object.prototype.toString` behavior.

## Root-cause theory

Standalone Boolean wrapper prototypes are represented by the shared native
prototype companion. Boolean glue currently registers only the string-named
`toString` and `valueOf` members, without the required own
`Symbol.toStringTag` data property. When the method is deleted, the generic
object tag therefore falls through to the Boolean payload representation and
returns `"false"`.

Passing the existing glue registration the tag string `"Boolean"` should let
the existing native-prototype companion seeder install the spec descriptor
(`writable: false`, `enumerable: false`, `configurable: true`) in standalone
output. Host output and all Boolean method/boxing paths remain unchanged.

## Implementation plan

1. Add only the Boolean glue's existing `symbolTag` metadata argument; do not
   alter method dispatch or wrapper conversion.
2. Add a focused regression covering both exact rows in host and standalone,
   plus direct value/descriptor controls for the Boolean prototype tag.
3. Re-run the exact rows with pass/fail controls and determinism in both lanes,
   using no more than two workers, then run focused and repository gates.

## Acceptance criteria

- Both exact rows pass in host and standalone, with no control loss or new hard
  error; repeats report zero nondeterminism.
- `Boolean.prototype[Symbol.toStringTag]` is exactly `"Boolean"` with the
  standard non-writable, non-enumerable, configurable descriptor in both lanes.
- The source diff remains confined to Boolean native-prototype glue and the
  regression test; no host imports or iterator/collection paths are touched.
- Typecheck, lint, format, budget, ratchet, issue-integrity, and normal
  pre-push gates pass.

## Handoff

The atomic assignment reservation for this plan is held on the upstream
assignment registry as `5104`; no external issue is used for tracking. Update
this file with exact baseline/final counts, commit/head, and PR state after
implementation. Keep any PR draft and held outside the merge queue until the
exact rows, focused controls, and CI are green and the branch is mergeable.
