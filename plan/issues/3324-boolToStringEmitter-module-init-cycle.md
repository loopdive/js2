---
id: 3324
title: "tests/issue-2949-s5-2-eq.test.ts fails standalone with a module-init cycle: 'Cannot access boolToStringEmitter before initialization'"
status: done
assignee: ttraenkler/fable-3317
completed: 2026-07-16
sprint: current
created: 2026-07-16
priority: medium
feasibility: medium
task_type: bug
area: codegen
goal: standalone-mode
related: [2949]
origin: "found as a side-effect of #3164 (#2040 A1 classifier flip) conflict-resolution validation, 2026-07-16 — pre-existing on main, unrelated to that PR"
---

# #3324 — module-init ordering cycle crashes a standalone test suite

## Problem

`tests/issue-2949-s5-2-eq.test.ts` fails at the suite level (not a single
assertion) on unmodified `origin/main` when run standalone:

```
ReferenceError: Cannot access 'boolToStringEmitter' before initialization
  at src/codegen/coercion-engine.ts:675
  via src/codegen/string-ops.ts:3587
  via src/codegen/expressions/builtins.ts:18
```

This is a circular module-import ordering bug: something in the
`builtins.ts` → `string-ops.ts` → `coercion-engine.ts` import chain reads
`boolToStringEmitter` before its declaring module has finished initializing.
Confirmed pre-existing (reproduces on a clean, detached `origin/main`
worktree) — not caused by, or related to, whatever PR happened to be in
flight when it was noticed.

## Task

1. Reproduce: run `tests/issue-2949-s5-2-eq.test.ts` standalone on current
   `main` and confirm the same stack trace.
2. Trace the actual import cycle (`coercion-engine.ts` ↔ `string-ops.ts` ↔
   `expressions/builtins.ts` — likely more modules involved) and find where
   `boolToStringEmitter` is referenced before its owning module's top-level
   initialization completes.
3. Fix the ordering — likely a lazy-init/factory-function indirection at the
   read site, or restructuring which module owns `boolToStringEmitter` to
   break the cycle. Don't just reorder imports if the underlying cycle is
   structural; fix the cycle itself.

## Acceptance criteria

- `tests/issue-2949-s5-2-eq.test.ts` passes standalone.
- No new circular-import warnings/errors introduced elsewhere.

## Root cause + fix (2026-07-16, fable-3317)

The #1917 Step 1 registration kept the mutable emitter slots
(`let boolToStringEmitter` / `let nativeStringRefFromExternrefEmitter`) INSIDE
`coercion-engine.ts` and had `string-ops.ts` call
`registerStringHelperEmitters(...)` at module top level. That is
initialization-ORDER-dependent: when module evaluation enters
coercion-engine.ts first (entry importing `any-helpers.js` before anything
that pulls string-ops — exactly `tests/issue-2949-s5-2-eq.test.ts`'s import
list), the engine's own import chain (`./index.js` → … →
`expressions/builtins.ts` → `string-ops.ts`) re-enters the register call
while coercion-engine.ts is still mid-initialization, and the assignment to
its TDZ'd top-level `let` throws.

Fix: moved the slots + register function into a new leaf module,
`src/codegen/string-emitter-registry.ts`, with NO runtime imports (types
only). A leaf with no imports can never be partially initialized when either
side touches it, so the registration is order-immune — the cycle hazard is
broken structurally, not by import reordering. `coercion-engine.ts` reads via
`getBoolToStringEmitter()`/`getNativeStringRefFromExternrefEmitter()`;
`string-ops.ts` registers into the leaf.

## Test Results (2026-07-16)

- `tests/issue-2949-s5-2-eq.test.ts`: 7/7 pass (was: suite-level
  ReferenceError at collection).
- New `tests/issue-3324.test.ts` (2/2): mirrors the crashing entry order
  (any-helpers first) — pre-fix it fails at import, before any `it` — plus an
  end-to-end standalone `String(any-bool)` compile+run.
- Full issue-2949 family (9 files, 101 tests) green; coercion suites
  (issue-1917-\*, issue-1470, call-arg-type-coercion) green except one
  PRE-EXISTING failure identical on pristine main
  (issue-1917-coercion-plan "externref → anyref/eqref" expects no
  `ref.cast_null` — stale on main, not caused here).
- tsc clean; oracle-ratchet / coercion-sites / loc-budget / dead-exports OK.
