---
id: 3422
title: "Strict-mode rerun: read-only assign / delete non-configurable don't match spec — ~666 default reclassifications"
status: done
completed: 2026-07-20
assignee: ttraenkler/senior-dev
created: 2026-07-18
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: test262-conformance
model: fable
sprint: 73
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

## Resolution (2026-07-20)

**Verify-first re-scoping against the current oracle-v8 baseline** (fetched from
`loopdive/js2wasm-baselines`, timestamped 19:05 on 2026-07-19 — *after* both
sibling PRs merged). The two originally-cited families had already diverged:

| Family (strict-rerun signature) | issue estimate | baseline residual |
| --- | --- | --- |
| `Cannot assign to read only property …` | 419 | **2** (fixed by #3471) |
| `Cannot delete non-configurable property …` | 247 | **313** (this fix) |

So #3470 (name/length realm-restore) and #3471 (read-only-assign real-TypeError
via the isSameValue param-inference fix) already retired the read-only-assign
family. The **residual after them is the `delete` non-configurable family**, and
it is **NOT realm-pollution** — it reproduces on a fresh, never-mutated realm.

**Root cause.** `src/codegen/typeof-delete.ts` threw the strict-mode
non-configurable-`delete` refusal (§13.5.1.2 step 6.b) as a **bare string** on the
shared exception tag (`deleteThrowInstrs`/`emitDeleteThrow`). The legacy `wrapTest`
harness stripped `assert.throws`' expected constructor, so a string sufficed. The
authentic harness (#3370) runs the real `propertyHelper.js::isConfigurable()`:
`try { delete obj[name] } catch (e) { if (!(e instanceof TypeError)) throw
Test262Error("Expected TypeError, got " + e) }`. A thrown string is not
`instanceof TypeError`, so the guard tripped — hence "Expected TypeError, got
TypeError: Cannot delete non-configurable property in strict mode" (the string
carried its own "TypeError:" prefix). Exactly the `delete` counterpart of #3471's
read-only-assign fix.

**Fix.** Route the three delete-refusal throw sites (strict non-configurable
TypeError ×2, super-reference ReferenceError ×1) through the canonical
`buildThrowJsErrorInstrs` (`js-errors.ts`), which builds a **real** error instance
— host `__new_<Kind>` import in JS-host mode, in-module `emitWasiErrorConstructor`
in standalone/wasi — with the established `{ flush: fctx }` late-import-shift
handling. `deleteThrowInstrs`/`emitDeleteThrow` now take `(ctx, fctx, kind,
message)`; the "Kind:" prefix moved out of the message (the constructor supplies
it). Dual-mode: standalone `delete` refusals now throw a real `instanceof
TypeError` too.

## Test Results
- New `tests/issue-3422.test.ts` (7 cases): host + standalone `instanceof TypeError`
  probes, plus 5 real test262 files from the 313-cluster passing primary + strict
  rerun end-to-end. All green.
- Real-file honest-harness sweep (`runTest262File` on the fixed build):
  **60/60 random** + **32/32 category-spread** of the 313 flip to `pass`, zero
  remaining error buckets ⇒ essentially the full **~313 host flips**.
- Regression: the 8 existing delete/typeof vitest suites show an **identical**
  3-fail/36-pass on main and on this branch — **zero new failures**. (Those 3
  pre-existing failures are a *separate*, out-of-scope **sloppy**-mode bug: a
  sloppy non-configurable `delete` currently throws instead of returning `false`.)

**Honest scope.** This fix targets the `delete` non-configurable family (313 of
the 347 total `strict rerun:` failures on the baseline). The read-only-assign
residual (2) is already handled by #3471; the remaining ~32 are other, unrelated
families and are out of scope for this issue.
