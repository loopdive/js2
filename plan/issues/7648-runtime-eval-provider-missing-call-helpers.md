---
id: 7648
title: "Runtime-eval provider build omits src/interp/call-helpers.ts: a ReferenceError names `intrinsicErrorConstructor`"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime-eval
goal: runtime-eval
related: [7643]
---

# #7648: the provider is built without `call-helpers.ts`

## Problem

In interpreted code (interpreter-tier provider, `--target standalone`), a reference to an unbound name throws
`ReferenceError: intrinsicErrorConstructor is not defined`. It should throw `ReferenceError: noSuchName is not
defined`.

Measured on main a755911c, linked through `instantiateTest262Module`, with a dead direct-eval site so the result
envelope reads (see #7643):

| probe | result |
| ----- | ------ |
| `(0, eval)(dyn("noSuchName"))` | `ReferenceError: intrinsicErrorConstructor is not defined` |
| `eval(dyn("noSuchName"))` (direct) | same |
| `new Function(dyn("return noSuchName;"))()` | same |
| `(0, eval)(dyn("noSuchFn()"))` | same |

## Cause

`src/interp/loop.ts` imports `constructValue`, `describe` and `intrinsicErrorConstructor` from `./call-helpers.js`.
The provider build concatenates the `INTERP_FILES` sources and strips their imports
(`scripts/runtime-eval-provider.mjs`). `call-helpers.ts` is **not** in `INTERP_FILES`, so all three names are
unbound inside the provider:
- the build still succeeds, because it compiles with `skipSemanticDiagnostics`;
- its canaries never reach these paths.

So `loop.ts:638`, which builds the ReferenceError for an unbound name, itself throws a ReferenceError about the
helper.

Not yet measured: whether `constructValue` (`new` in interpreted code) and `describe` (error messages) fail the same
way. They probably do, since they are unbound in the same build.

## Implementation Plan (draft)

- **Fix.** Add `"call-helpers.ts"` to `INTERP_FILES`, ahead of `loop.ts`. The file is import-free apart from a type
  import, which the build strips.
- **Guard.** Make `tests/issue-2928.test.ts`, which already imports `INTERP_FILES`, assert that every relative value
  import of a listed file resolves to a listed file. A helper split out of `loop.ts` then fails the test instead of
  the provider's error paths.
- **Byte identity.** The provider source and binary change once (its cache key moves). User modules do not change.

## Acceptance

- The four probes above throw `ReferenceError: noSuchName is not defined` (or `noSuchFn`).
- `new` on an interpreted constructor works (a probe added when this is implemented).
- The guard test fails on main and passes with the fix.
