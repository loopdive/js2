---
id: 3434
title: "Original-harness propertyHelper strict write probe rethrows host TypeError"
status: backlog
created: 2026-07-18
updated: 2026-07-18
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime, testing
language_feature: strict-mode, property-descriptors, exceptions
goal: es5
related: [1460, 2017, 3374, 3426]
---

# #3434 — propertyHelper strict write probe rethrows host TypeError

## Problem

The original-harness strict variant of
`test/built-ins/Object/defineProperty/15.2.3.6-3-179.js` fails with:

```text
strict rerun: Cannot assign to read only property 'property' of object
```

The test defines `obj.property` with `writable: null`, correctly producing a
non-writable property. `propertyHelper.js` then probes writability by assigning
inside `try/catch`; strict assignment is supposed to throw `TypeError`, and the
helper explicitly accepts that exception. The host `__extern_set_strict` path
does throw, but this original-harness shape still lets the exception escape (or
fails its `instanceof TypeError` check and rethrows it).

This is deterministic and separate from #3426's cross-test intrinsic metadata
contamination. Held #3287 run `29641967485` and the current-main baseline both
report the same strict-rerun failure. Against the older requested #3287 replay
baseline it is the sole expected stable non-timeout regression after #3426's
worker recycle fix.

## Scope

- Reproduce the exact unmodified Test262 source through
  `assembleOriginalHarness` and the unified worker, including primary followed
  by strict on a pool-size-1 fork.
- Trace whether the failure is an uncaught host exception or a caught value
  whose `instanceof TypeError` identity check is false.
- Preserve #3374/#2017 strict failed-write semantics: strict writes must still
  throw a branded, catchable `TypeError`; sloppy writes must remain no-ops.
- Do not special-case this Test262 path or weaken `propertyHelper.js`.

## Acceptance criteria

- `15.2.3.6-3-179.js` passes both original-harness variants.
- A strict write to the non-writable descriptor is caught as
  `error instanceof TypeError` inside compiled code.
- The equivalent sloppy write remains a no-op.
- Existing #2017 and #3374 suites remain green.
