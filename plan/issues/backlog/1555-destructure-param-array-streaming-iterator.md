---
id: 1555
title: "refactor: destructureParamArray — streaming IteratorStep-per-element instead of __array_from_iter materialisation"
status: ready
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: destructuring, iterators
goal: spec-completeness
parent: 1542
related: [1432, 1450, 1454, 1550, 1542]
note: "Verified 2026-05-21: destructureParamArray actually lives at destructuring-params.ts:655 (NOT statements.ts); statements.ts split into statements/ subdir; expressions.ts split into expressions/ subdir"
---

# #1555 — Streaming iterator destructuring (replace `__array_from_iter` materialisation)

## Problem

`destructureParamArray` in `src/codegen/destructuring-params.ts:655` (verified
2026-05-21 — function lives in destructuring-params.ts, not statements.ts as
originally cited) and its callers in
`src/codegen/class-bodies.ts` materialises the entire iterator into an array
via `__array_from_iter` before binding elements. This violates the ECMAScript
spec for patterns with elisions, rest elements, or early defaults:

**Repro (from senior-dev investigation of #1542, 2026-05-20):**
```ts
let first = 0; let second = 0;
function* g(): any { first += 1; yield; second += 1; }
class C { method([,] = g()): void {} }
// Spec §13.3.3.6 + §12.14.5.3: first=1, second=0 (one IteratorStep per Elision)
// Current main:                 first=1, second=1  (generator fully exhausted)
```

The `isPatternEmptyOnly` guard (narrowed in #1432 to length-0 patterns only)
does not protect elision-only patterns like `[,]`, so `__array_from_iter` still
runs and exhausts stateful iterators prematurely.

## Root cause

- `__array_from_iter` fully consumes the iterator into a JS array before any
  element binding begins.
- Spec §13.3.3.6 requires one `IteratorStep` call per binding element in
  order, with early termination when the iterator is exhausted — elisions
  consume one step each, rest consumes remaining.
- A streaming approach emits: `IteratorStep` → `IteratorValue` → bind, in
  element order. Elisions: `IteratorStep` only (no value consumed). Rest:
  loop until `IteratorStep` returns done.

## Scope

This is architecturally invasive — `destructureParamArray` is called from:
- `src/codegen/destructuring-params.ts:655` (the actual `destructureParamArray`
  definition — verified 2026-05-21; was incorrectly cited as statements.ts)
- `src/codegen/statements/destructuring.ts` (let/const/var declaration-form;
  also moved from `statements.ts` to `statements/` subdir)
- `src/codegen/class-bodies.ts` (method params ~line 1222)
- `src/codegen/expressions/assignment.ts` (assignment destructuring; moved
  from `expressions.ts` to `expressions/` subdir)

Estimated ~1300 LoC of pipeline + multiple call sites. Needs careful per-call-site
validation against existing test262 coverage.

## Diagnosis artifacts

`tests/issue-1542-repro.test.ts` contains 5 regression tests (3 pass / 2 fail
on current main). These become the acceptance test for this refactor.

## Implementation approach (needs architect spec)

1. Replace `__array_from_iter` call with a fresh `IteratorRecord` local
2. For each element in the pattern (in order):
   - Elision: emit `call $IteratorStep`, drop result
   - Binding: emit `call $IteratorStep` + `call $IteratorValue` (or use done sentinel)
   - Default: if done or undefined, evaluate initializer
   - Rest: loop `IteratorStep` collecting into array until done
3. After all elements: emit `IteratorClose` if iterator not exhausted
4. Gate the new path behind `ctx.streamingDestructure` flag initially; once
   validated, remove the materialisation path entirely

## Notes

- The architect spec for #1542 was incorrect — it pointed at `coerceType`
  externref→vec which already exists in main. The real fix is here.
- The "Cannot destructure null/undefined" error seen in test262 baseline may
  be a separate issue triggered by harness preamble shape; needs re-investigation
  with `pnpm run test:262` filtered to `language/statements/class/*dstr*`.

## Acceptance criteria

- `tests/issue-1542-repro.test.ts` 5/5 passing
- `pnpm run test:262` filtered to array-destructuring paths shows net improvement
- No regression on existing equivalence tests

## Implementation Plan

(Author: architect, 2026-05-21. Builds on the existing approach
above with concrete branch structure, helpers, and edge cases.)

### Entry point

`destructureParamArray` in `src/codegen/destructuring-params.ts:655`.
Also the 3 sibling call sites listed above.

### Algorithm

Replace the body of `destructureParamArray` with:

```
1. local.tee $iterObj <- the value to destructure (call iterator())
2. call $__getIterator -> stores IteratorRecord in $iterRec
3. for each element in pattern.elements:
     match element:
       Elision:
         call $__iteratorStep($iterRec) ;; drop
       BindingElement (identifier or sub-pattern):
         call $__iteratorStepValue($iterRec) -> value, done
         if done: push undefined
         (apply default if undefined)
         (recurse for sub-pattern)
         (bind to local)
       RestElement:
         allocate empty vec
         loop:
           call $__iteratorStep($iterRec) -> value, done
           if done: break
           vec.push(value)
         (bind vec to local)
4. if not iter exhausted (no rest, last element non-elision):
     call $__iteratorClose($iterRec, normalCompletion)
```

### Helpers needed

- `$__getIterator(obj) -> IteratorRecord` — read `obj[Symbol.iterator]()`.
- `$__iteratorStep(record) -> done:i32` — call `record.next()`,
  store `value`/`done`.
- `$__iteratorStepValue(record) -> value:any, done:i32` — same +
  return value.
- `$__iteratorClose(record, completion)` — call `record.return()` if
  present.

All four already exist in some form for `for-of`; check
`src/codegen/statements/for-of.ts` and lift to a shared helper.

### Streaming flag

Add `ctx.streamingDestructure` flag; default false initially. Switch
each call site over one by one with regression test per migration:

1. **destructureParamArray** (params) — first; smallest surface.
2. **let/const/var dstr** in `src/codegen/statements/destructuring.ts`.
3. **assignment dstr** in `src/codegen/expressions/assignment.ts`.
4. **class method params** in `src/codegen/class-bodies.ts`.

After all migrate, delete `__array_from_iter` call sites and the
flag.

### Edge cases

- **`[,] = g()`** — exactly one IteratorStep; second is NOT advanced.
- **`[a = 1, b = 2] = g()`** — 2 steps; defaults if `done` or value
  `undefined`.
- **`[...rest] = g()`** — full loop; iterator exhausted at end.
- **`[a, ...rest, b]`** — syntax error; rejected by TS checker.
- **`[a = (yield 1)]`** — generators inside default-initializers
  require collectInstrs care (see #1257).
- **Pattern with sub-pattern `[[a, b]] = g()`** — outer step yields
  an iterable; recurse with new IteratorRecord on that inner value.
- **Iterator throws during step** — propagate; do NOT call
  `IteratorClose`.
- **Abrupt completion from default initializer** — must call
  `IteratorClose(iter, completion)` per spec §7.4.7.
- **Non-iterable RHS (`null`, `undefined`)** — `__getIterator`
  throws TypeError; matches existing behaviour.
- **Async iteration (`for await`, `[a, b] = await g()`)** — wraps
  steps in `await`; this issue focuses on sync; async path is a
  follow-up (#1543/#1544 territory).

### Test262 paths

- `test/language/expressions/array-destructuring/*`
- `test/language/statements/class/dstr/*`
- `test/language/expressions/assignment/dstr/array-*`
- `test/language/statements/for-of/*-iteration-*` (regression)

Acceptance: 5/5 in `tests/issue-1542-repro.test.ts`; net positive
on test262 dstr paths.

### Dependencies

- **#1542** — parent; this is the real fix.
- **#1257** — funcIdx shift for detached arrays; default-init
  bodies use collectInstrs which is the hazard surface.
- **#1454/#1450** — related earlier dstr regressions; verify they
  still pass.

### Risks

- **Performance**: streaming is per-element-stepping. For large
  arrays without elisions/defaults this is slower than bulk
  materialisation. Acceptable — spec semantics demand it; the
  bulk-materialise was a bug pretending to be an optimisation.
- **Iterator side-effects**: programs relying on the old eager
  behaviour will break (correctly). Document in CHANGELOG.
