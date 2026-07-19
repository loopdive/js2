---
id: 3422
title: "Strict-mode rerun: read-only assign / delete non-configurable don't match spec — ~666 default reclassifications"
status: ready
created: 2026-07-18
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: test262-conformance
model: fable
sprint: current
horizon: m
related: [3370, 3417]
---

# #3422 — strict-mode rerun failures (read-only assign, delete non-configurable)

## Problem
v8 (#3370) adds the required Test262 **strict rerun** (each non-`raw`/non-`noStrict`
test runs a second time with `"use strict";` prepended — see
`tests/test262-original-harness.ts::assembleOriginalHarness`, `strictRerun`). Tests
that passed in sloppy mode now fail the strict rerun. Measured (oracle-v8):

- `strict rerun: Cannot assign to read only property 'X' of object` = **419**
- `strict rerun: Expected TypeError, got TypeError: Cannot delete non-configurable
  property …` = **247**

## Root cause (two sub-families)
1. **Read-only assignment (419)**: assigning to a read-only property in strict mode
   must throw `TypeError`. The compiler throws the RIGHT error class in some paths but
   the test's own guarding differs, OR it throws in cases the test expects to *succeed*
   under its scenario. Bisect: are these tests that expect NO throw (compiler
   over-throws) or that expect a throw the assert doesn't catch? The message
   "Cannot assign to read only property" is the throw itself surfacing as an
   unhandled/wrong-phase failure.
2. **Delete non-configurable (247)**: `delete` of a non-configurable property in strict
   mode must throw `TypeError`. Signature "Expected TypeError, got TypeError: Cannot
   delete non-configurable property" indicates the compiler DOES throw a TypeError but
   its identity/message or the phase doesn't match what the strict-rerun verdict
   expects — likely a constructor-identity or wrong-phase mismatch (the error escapes
   `__module_init` instead of being caught at the assert site).

## Implementation Plan
- Reproduce one of each via `scripts/test262-worker.mjs` with `strict` rerun and dump
  the caught error's constructor identity + phase.
- Sub-family 1: verify strict-mode assignment-to-read-only throws a **catchable**
  `TypeError` with correct constructor identity at the assignment site (not an
  uncatchable trap and not escaping module init).
- Sub-family 2: ensure `delete` of a non-configurable property throws a real
  `TypeError` whose `.constructor`/`.name` satisfies `assert.throws(TypeError, …)`
  (constructor identity, per #3287 patterns), and that it is thrown at the delete
  expression, not deferred.
- Confirm strict-mode is actually threaded to codegen for the rerun (a
  `"use strict";` prologue must flip the strict-semantics flag for assignment/delete
  lowering; if the rerun compiles sloppy semantics, that's the bug).

## Verification
- Scoped: `language/expressions/assignment/**` read-only + `language/expressions/delete/**`
  non-configurable tests pass the strict rerun.
- Zero-regression on sloppy-mode runs of the same tests.
