---
id: 2727
title: "Top-level (sloppy script) `this` should be the global object (typeof this === 'object')"
status: done
assignee: ttraenkler/claude-es2015-v13
created: 2026-06-26
updated: 2026-10-07
completed: 2026-10-07
priority: low
feasibility: hard
task_type: bugfix
area: codegen
goal: test262-conformance
sprint: Backlog
depends_on: []
---
# #2727 — top-level sloppy-script `this` = global object

Split out of **#1846** (descoped). This is the single remaining failing
assertion in `test/language/expressions/typeof/built-in-exotic-objects-no-call.js`
— every `typeof new X()` case already returns `"object"` correctly on current
main.

## Problem

In a **non-strict (sloppy) script**, the top-level `this` is the global object,
so `typeof this === "object"`. test262 runs these as scripts, not modules.

Our pipeline wraps each test body into an exported `test()` function. Inside that
(strict module) function, `this` is `undefined`, so `typeof this` evaluates to
`"undefined"` instead of `"object"`.

Verified on current main:

```ts
export function test(): string { return typeof this; }   // → "undefined" (want "object")
```

## Failing test262 (baseline 2026-06-26)

- `test/language/expressions/typeof/built-in-exotic-objects-no-call.js` — assert
  #1 `typeof this === "object"` (all other asserts in the file already pass).

## Root cause

We model every compilation unit as a strict module; there is no notion of a
sloppy-script top-level `this` bound to a global object. The test-harness wrapper
turns the script body into a strict function whose `this` is `undefined`.

## Possible directions (need design — feasibility: hard)

- **Harness-level**: bind the wrapper's `this` to a global-like object for tests
  flagged as flat/sloppy scripts (narrow, but a harness hack, not a compiler
  fix).
- **Compiler-level**: model a top-level (script-mode) `this` that resolves to a
  global object value. Broad semantics change — touches `this` resolution and a
  global-object representation. Should be specced before implementation.

## Notes

Low movement (single assertion). Parked in Backlog until the global-object /
script-mode-`this` semantics are designed. Do NOT attempt as a one-off.

## Resolution — 2026-10-07 (#6651 slice V13)

- **The original row already passes.** `language/expressions/typeof/built-in-exotic-objects-no-call.js`
  passes on `fcc80f1a4c` in both the standalone and the gc (host) lane
  (measured in-process, `runTest262File`): the test262 lanes compile the file
  as a sloppy script, and a script's top-level `this` is the realm global
  object, so `typeof this === "object"`.
- **The remaining global-object residual is closed for standalone by #6651 V13.**
  Reads and writes that reach the global object at run time (`this` in a
  plainly called sloppy function, `f.call(this)`, `globalThis[k]`) now see the
  same storage as the top-level `var` binding. Mechanism, measurements and
  residuals: `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`
  § "2026-10-07 — Slice V13".
- **Repro / pins:** `tests/issue-6651-v13-global-var-binding.test.ts` (5 cases,
  all red on the pre-V13 base) and the test262 rows
  `test/language/expressions/typeof/built-in-exotic-objects-no-call.js` and
  `test/built-ins/Array/from/source-array-boundary.js`.
