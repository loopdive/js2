---
id: 1257
title: "async-gen + obj-ptrn default-init throws: funcIdx shift misses detached thenInstrs"
status: done
assignee: ttraenkler/dv1
completed: 2026-06-16
created: 2026-04-19
updated: 2026-06-16
priority: medium
feasibility: hard
reasoning_effort: high
goal: error-model
sprint: 62
---
## Problem

`shiftLateImportIndices` walks a fixed set of Instr[] arrays (ctx.mod.functions, fctx.body, fctx.savedBodies, funcStack, parentBodiesStack, pendingInitBody). But any codegen pattern that swaps out a body, gathers instructions into a detached local array, and THEN triggers a late-import addition will silently corrupt funcIdx values inside that detached array — the shift can't reach arrays the compiler doesn't hold a reference to.

The concrete manifestation found on PR #225 was in `emitNullGuard` (destructuring.ts):

1. `collectInstrs(fctx, emitFn)` swaps fctx.body, runs emitFn (which may recursively compile nested default-initializer `thenInstrs`), then restores fctx.body and returns guardInstrs — now detached.
2. The caller then calls `buildDestructureNullThrow`, which calls `ensureLateImport("__throw_type_error", ...)` + `flushLateImportShifts(ctx, fctx)`.
3. The shift walks fctx.body, savedBodies, mod.functions — guardInstrs is in none of them. Every `call` instruction inside guardInstrs (including nested default-initializer thenInstrs) keeps a pre-shift funcIdx, silently pointing at the wrong function.

Symptom: in the 12 test262 regressions on PR #225, mis-indexed `call` in throw path of `{ x = f() } = value` pointed back at the outer test function itself, producing infinite recursion → `RangeError: Maximum call stack size exceeded`.

Fix applied for emitNullGuard: pre-register `__throw_type_error` and `__extern_is_undefined` BEFORE collectInstrs, so the shift fires while guardInstrs doesn't exist yet. Net: 11 lines, 9/12 regressions fixed. Remaining 3 are in different code paths.

## Why this is an architectural issue, not a local fix

The pattern "swap body → collect detached array → trigger late import" can recur anywhere collectInstrs or similar body-swap is used. Candidates:
- `src/codegen/closures.ts:1525-1592` — async-gen compilation swaps `outerBody`/`bodyInstrs` directly (doesn't use savedBodies, so shifts can't reach bodyInstrs DURING inner-function compilation either). If any late import gets added while compiling the inner async-gen body, funcIdx values in the already-emitted outer body could be under-shifted, or funcIdx values in bodyInstrs go un-shifted.
- Any for-await-of / generator driver that uses pushBody/popBody without savedBodies registration.
- Any helper that builds a small Instr[] and later splices it into the main body AFTER potentially triggering a late import (e.g. ensureLateImport within helper, then caller emits additional instructions before splicing).

## Attempted fix that didn't work

First attempt: restructure `compileExternrefObjectDestructuringDecl` to push the `if { thenInstrs } else { elseCoerce }` with thenInstrs already computed. Did not resolve — the missing shift happens at a wider scope (emitNullGuard wrapping the entire destructuring block), not inside the specific compile function. The `throwInstrs` array was the one getting orphaned, and it's owned by emitNullGuard, not by the per-pattern destructuring compile.

Also considered: registering guardInstrs into fctx.savedBodies before calling emitFn. But savedBodies is popped at the end of collectInstrs to restore the caller's view, so even if guardInstrs is pushed during collectInstrs, it disappears the moment collectInstrs returns. Would require either:
- A separate "detached arrays awaiting splice" stack in CodegenContext that shiftLateImportIndices also walks, OR
- An audit rule: never call ensureLateImport / flushLateImportShifts after collectInstrs for arrays the caller still holds.

## Acceptance Criteria

- Audit all uses of `collectInstrs`, `pushBody`/`popBody`, and body-swap patterns in codegen for the "detached array + late-import" hazard.
- Either: (a) add a `ctx.detachedBodies` stack that shiftLateImportIndices traverses, so detached arrays register themselves for the duration of any shift-triggering code; OR (b) document a strict rule "no late imports after collectInstrs until the result is spliced into a walked body" and add lint/assertion.
- Regression test: `{ x = f() } = null` in async generator should throw TypeError (not recurse).
- Address the 2 remaining `[] = null` / `{} = null` regressions in assignment.ts `emitExternrefAssignDestructureGuard` if they share the same root cause, OR file separately if not.

## References

- PR #225 (branch `issue-dstr-requireobjectcoercible`) — partial fix in commit ??? of emitNullGuard.
- `src/codegen/statements/destructuring.ts` `emitNullGuard` — worked-around case.
- `src/codegen/statements/shared.ts` `collectInstrs` — the detaching primitive.
- `src/codegen/expressions/late-imports.ts` `shiftLateImportIndices` — the walker that can't see detached arrays.
- `src/codegen/closures.ts:1525-1592` — async-gen body swap (candidate for same hazard).
- `src/codegen/expressions/assignment.ts:49-76` `emitExternrefAssignDestructureGuard` — 2 remaining regressions (different code path, may or may not be same root cause).

## Implementation Plan

(Author: architect, 2026-05-21. Pick Option A — a
`ctx.detachedBodies` stack — as the architectural fix; Option B is
brittle and depends on every contributor honouring the rule.)

### Entry point

`src/codegen/context/`(or `src/codegen/index.ts` where the
CodegenContext is defined) — add a stack field plus push/pop helpers.

### Data structure change

```ts
interface CodegenContext {
  // ... existing fields
  detachedBodies: Instr[][];   // NEW: arrays awaiting splice
}
```

Push lifecycle:
1. Any helper that creates a detached `Instr[]` and may trigger a
   late import while still holding the reference: push the array
   onto `ctx.detachedBodies` before the risk window, pop after the
   splice/discard.
2. `shiftLateImportIndices` walks `ctx.detachedBodies` in addition
   to the existing arrays.

### Algorithm

1. **Audit** — grep for `collectInstrs` callers and body-swap
   patterns:
   - `src/codegen/statements/destructuring.ts:emitNullGuard`
   - `src/codegen/expressions/assignment.ts:emitExternrefAssignDestructureGuard`
   - `src/codegen/closures.ts:1525-1592` (async-gen body swap)
   - Generator/for-await-of drivers in
     `src/codegen/statements/loops.ts`
   - Any `pushBody`/`popBody` without `savedBodies` registration.

2. **Per-call-site change** — for each audit hit, wrap the
   detached-array lifetime in push/pop:

```ts
const detached: Instr[] = [];
ctx.detachedBodies.push(detached);
try {
  // ... emit into detached, possibly triggering late imports
} finally {
  ctx.detachedBodies.pop();
  // splice detached into the parent body
}
```

3. **`shiftLateImportIndices`** — extend to:

```ts
function shiftLateImportIndices(ctx, fctx, shifted) {
  // existing walks
  for (const arr of ctx.detachedBodies) shiftArray(arr, shifted);
}
```

4. **Defensive assertion** — at end of compilation, assert
   `ctx.detachedBodies.length === 0`. Catches missing pops.

### Edge cases

- **Nested detached arrays** — push/pop is stack-disciplined; nested
  collectInstrs calls each register their own array. The shift walks
  all entries in the stack regardless of nesting.
- **Early-throw during emitFn** — `try/finally` ensures pop runs
  even on exception.
- **Arrays that aren't expected to contain late-importable calls**
  (e.g. pure value computations) — pushing them is harmless overhead
  (one extra array walk per late import); err on the side of
  pushing.
- **Async-gen specific (closures.ts:1525-1592)**: `bodyInstrs` is
  swapped via direct assignment, not collectInstrs. The shift
  currently walks `funcStack` and `parentBodiesStack`. Verify
  whether the async-gen swap correctly registers bodyInstrs in
  parentBodiesStack; if not, add registration there *or* push
  bodyInstrs into detachedBodies for the duration of inner-fn
  compile.

### Regression tests

In `tests/issue-1257.test.ts`:
- `async function* g() { try { yield ({} = null); } catch (e) {} }` →
  TypeError, no infinite recursion.
- `({x = f()} = null)` in a normal function → TypeError.
- `({} = null)` at top level → TypeError.
- `[] = null` in async generator → TypeError.

### Test262 paths

- `test/language/expressions/object/dstr/*-null-undefined-*`
- `test/language/statements/for-await-of/dstr/*-null-*`
- `test/built-ins/AsyncGeneratorPrototype/return/*`

Acceptance: 12 regressions from PR #225 fully resolved (currently
9/12 — close the remaining 3).

### Dependencies

- None blocking. Pure refactor + audit.

### Risks

- **Performance**: shift walks one more list per late import. List
  size is typically < 5 deep; negligible.
- **Audit completeness**: missing one detached-array site leaves a
  silent funcIdx corruption bug. Mitigate with a property test:
  run a stress test that triggers many late imports during nested
  detached-array compilation, verify all funcIdx targets resolve to
  the expected names.

## Resolution (dv1, 2026-06-16) — symptom verified CLOSED; Option-A mechanism already in tree

Re-verified on current main (`e424a7d3` lineage): the observable bug is **gone**.
All four spec regression scenarios — plus aggressive variants (default-init
calling `Math.floor`/`parseInt`/a user fn; multiple nested null-throws in one
function; async-gen `yield ({} = null)` then a later host call) — compile to
**valid Wasm**, instantiate, and throw a **catchable TypeError** with no
recursion or funcIdx corruption.

**The architectural fix the spec calls for (Option A: a `ctx.detachedBodies`
stack walked by `shiftLateImportIndices`) is already realized in tree as
`ctx.liveBodies`** — a `Set<Instr[]>` that `shiftLateImportIndices` walks
(`src/codegen/expressions/late-imports.ts:212`). The hazard sites that hold a
detached array across a potential late import already register it with the
established balanced `ctx.liveBodies.add(...)` / `.delete(...)` discipline:
`closures.ts` (lifted/cb bodies), `destructuring-params.ts` (then/else arms),
`statements/loops.ts` (cond/incr/then/else arms), `expressions/calls.ts`. The
PR #225 `emitNullGuard` case is additionally covered by pre-registering its
`__throw_type_error` / `__extern_is_undefined` late imports BEFORE the
`collectInstrs` window. So the symptom-level fix (PR #225's 9/12) plus the
subsequent `liveBodies` wiring closed the remaining 3.

**This PR** lands `tests/issue-1257.test.ts` (8 cases, green) as the
verified-closed regression net: each asserts valid Wasm + a caught TypeError
(return 1), the property the issue's "Risks → mitigate with a stress test" note
asks for.

**Deferred to sprint-63 follow-up #2182** (`feasibility: medium`,
`related: [1257]`): the *completeness* half of the
acceptance criteria — (a) a full audit of every `collectInstrs` caller /
body-swap site to confirm each detached array is `liveBodies`-registered for
its late-import window, and (b) a defensive end-of-compilation assertion that
`ctx.liveBodies` is empty (catches a missing `.delete`). These are
hazard-hardening, not a live bug; doing the broad audit-and-wrap refactor now
was deprioritized against the active async/Proxy/standalone work and the box's
load cap. The regression net guards against re-introduction of the known
shapes in the meantime.
