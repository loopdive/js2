---
id: 735
title: "- Async iteration correctness (329 tests)"
status: blocked
created: 2026-03-22
updated: 2026-04-28
priority: medium
feasibility: hard
goal: async-model
depends_on: [680, 681]
test262_fail: 329
files:
  src/codegen/statements.ts:
    breaking:
      - "for-await-of codegen"
  src/codegen/expressions.ts:
    breaking:
      - "async generator functions"
---
# #735 -- Async iteration correctness (329 tests)

## Status: backlog

## Problem

329 test262 tests related to async iteration fail with assertion errors:
- language/statements/for-await-of: 146 tests
- language/expressions/async-generator: 102 tests
- language/statements/async-generator: 39 tests
- language/expressions/async-function: 11 tests
- Other async patterns: 31 tests

### What needs to happen

1. Depends on #680 (pure Wasm generators) and #681 (pure Wasm iterators) -- async generators build on both
2. `for-await-of` must properly await each iterator result
3. Async generator `yield` must produce promises
4. Error propagation through async iteration chain

## Complexity: L (>400 lines, builds on generator + iterator + async)

## Implementation Plan

(Author: architect, 2026-05-21. Blocked on #680 + #681 + #1042;
specced now so it's ready to dispatch as soon as those land.)

### Entry points

- `src/codegen/statements/for-of.ts` — extend the for-of compiler
  for `await` flag.
- `src/codegen/declarations.ts` — async generator function
  lowering.
- New `src/codegen/async-generators.ts` for the combined state
  machine.

### Algorithm

1. **for-await-of(x of iter)**:
   1. Get async iterator: try `iter[Symbol.asyncIterator]()` first,
      fall back to `iter[Symbol.iterator]()` then wrap.
   2. Loop:
      a. `await iter.next()` — emit `await` of the promise.
      b. If result.done → break.
      c. `x = await result.value` (yes, double-await for
         async iteration on a sync iterator returning promises).
      d. Execute body.
   3. On break/throw/return: call `iter.return()` if defined.

2. **Async generator (`async function*`)**:
   - Combines #680's state machine with #1042's promise-resolver
     machinery.
   - Each yield produces a Promise; the state-resume function is
     scheduled when the promise's resolver fires.
   - State struct gains: `$pendingPromise`, `$resolver`.

3. **`yield` inside async generator**:
   - Allocate a new Promise.
   - Save state.
   - Return the Promise (caller awaits).
   - On `.next(arg)`, the awaiter resolves the Promise with the
     yielded value, then schedules the resume.

4. **`yield*` async delegation** — delegates to another async
   iterator; each step awaits.

### Edge cases

- **Sync iterator passed to for-await-of** — wrap each yielded
  value in `Promise.resolve(value)` per spec §13.7.5.13.
- **Iterator throws after partial consumption** — call
  `iter.return()` in the catch block.
- **Async return** — `gen.return(v)` returns a fulfilled promise
  with `{value: v, done: true}`.
- **Async throw** — `gen.throw(e)` returns a rejected promise.
- **`yield* asyncIter`** — must propagate `next/return/throw`
  through the delegate.
- **`for await` inside non-async function** — syntax error.
- **`for await` over an iterator whose `next()` returns a
  non-thenable** — wrap in Promise.resolve.

### Test262 paths

- `test/language/statements/for-await-of/*` (146)
- `test/language/expressions/async-generator/*` (102)
- `test/language/statements/async-generator/*` (39)
- `test/built-ins/AsyncIteratorPrototype/*`
- `test/built-ins/AsyncFromSyncIteratorPrototype/*`

Acceptance: ≥250 of 329 tests pass.

### Dependencies

- **#680** (generators) — hard blocker.
- **#681** (iterators) — hard blocker.
- **#1042** (async state machine) — hard blocker.
- **#1543/#1544** — destructuring inside for-await; coordinate.

### Risks

- **State explosion**: async + generator state machine is the
  product of both. Test deeply nested cases.
- **Microtask ordering**: spec mandates precise microtask queue
  positions for `await`. Use the existing scheduler in
  `src/codegen/async-scheduler.ts`.
