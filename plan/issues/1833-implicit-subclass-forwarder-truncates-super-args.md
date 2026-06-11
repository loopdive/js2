---
id: 1833
title: "Implicit subclass constructor forwarder truncates multi-arg super(...)"
status: done
pr: 1255
created: 2026-06-04
updated: 2026-06-11
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 61
claimed_by: codex-developer
claimed_at: 2026-06-06T18:07:20.508Z
completed: 2026-06-06
---
# #1833 — implicit derived constructor forwards only the first arg

## Symptom
`class Sub extends DataView {}; new Sub(buf, 0, 16)` constructs the parent with
only `buf` — `0` and `16` are dropped.

## Location
`src/codegen/class-bodies.ts:1103-1131` (pre-reg `:345-354`): the synthetic
forwarder declares a single externref `__arg0` and forwards only the first
argument to `__new_<Parent>`.

## Spec
An implicit derived constructor is `constructor(...args){ super(...args) }`.
(Was deferred as #1366c, which has no file.)

## Fix
Forward the full argument list (rest/vec) to the parent constructor.

## Implementation Summary

Implemented the implicit externref-backed subclass constructor as a parent-shaped
externref forwarder instead of a single `__arg0` function. The synthetic
constructor now registers enough externref slots for the built-in parent's
known constructor arity, forwards all of those locals to `__new_<Parent>`, and
still pads omitted caller arguments as JavaScript `undefined` so the runtime can
trim them for optional parent constructor arguments.

The explicit built-in `super(...)` path now uses the same parent arity so sibling
classes cannot disagree on the `__new_<Parent>` import signature. Local class
constructor calls also coerce emitted arguments to the callee signature, which is
needed for numeric DataView offset/length arguments that are forwarded through
externref synthetic parameters.

Files changed:
- `src/codegen/class-bodies.ts`
- `src/codegen/expressions/new-super.ts`
- `src/codegen/builtin-tags.ts`
- `tests/issue-1833.test.ts`
- `plan/issues/1833-implicit-subclass-forwarder-truncates-super-args.md`

Validation:
- `pnpm exec vitest run tests/issue-1833.test.ts` — pass
- `pnpm exec vitest run tests/issue-1833.test.ts tests/issue-1515.test.ts` — pass
- `pnpm exec tsc --noEmit --pretty false` — pass
- `pnpm exec vitest run tests/issue-1833.test.ts tests/issue-1515.test.ts tests/arraybuffer-dataview.test.ts` — existing `arraybuffer-dataview.test.ts` runtime cases fail because their harness instantiates modules without a `string_constants` import object; `issue-1833` and `issue-1515` pass in the same run.
