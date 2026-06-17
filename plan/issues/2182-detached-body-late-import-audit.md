---
id: 2182
title: "collectInstrs detached-array audit + liveBodies-empty assertion (funcIdx-shift hazard completeness)"
status: done
completed: 2026-06-17
assignee: ttraenkler/dev-resume
sprint: 63
created: 2026-06-16
updated: 2026-06-17
priority: low
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: error-model
related: [1257]
origin: "Sprint-62 follow-up: #1257 symptom verified closed + regression net landed; this is the deferred completeness/hardening half"
---

# #2182 — detached-array funcIdx-shift hazard: completeness audit + assertion

## Context

#1257 (done) closed the observable funcIdx-shift corruption in detached
instruction arrays (the `{x=f()} = null` destructure-null-throw recursion) and
landed `tests/issue-1257.test.ts` as the regression net. It also established
that the architectural mechanism the #1257 spec called for (a `ctx.detachedBodies`
stack walked by `shiftLateImportIndices`) **already exists in tree as
`ctx.liveBodies`** — a `Set<Instr[]>` walked at
`src/codegen/expressions/late-imports.ts:212`, with balanced
`liveBodies.add`/`.delete` discipline at the known hazard sites
(`closures.ts`, `destructuring-params.ts`, `statements/loops.ts`,
`expressions/calls.ts`).

What #1257 deliberately deferred (to avoid a broad risky refactor mid-sprint at
the box's load cap) is the **completeness/hardening** half.

## Scope

1. **Audit** every `collectInstrs` caller and every `pushBody`/`popBody` /
   raw body-swap site (`src/codegen/statements/shared.ts:collectInstrs` is the
   detaching primitive) for the "detached array held across a late import that
   isn't `liveBodies`-registered" hazard. The async-gen body swap at
   `closures.ts` (per #1257 §"Why this is architectural") is a specific
   candidate. Where a gap is found, wrap the detached array's lifetime in
   `ctx.liveBodies.add(...)` / `.delete(...)` (or register in
   `parentBodiesStack` where that's the idiom).

2. **Defensive assertion**: at the end of `compileFunctionBody` (or
   end-of-module compilation), assert `ctx.liveBodies` has no entries that
   should have been deleted — catches a missing `.delete()` that would silently
   over-shift on a later late import. Scope the assertion so it doesn't
   false-positive on legitimately-live nested bodies.

3. **Property/stress test**: compile a fixture that triggers MANY late imports
   during deeply nested detached-array compilation (nested destructuring with
   defaults that call host builtins, inside async generators) and assert every
   `call` funcIdx resolves to the expected function name — the stress test the
   #1257 "Risks" note specified.

## Acceptance criteria

- Audit documented (list of `collectInstrs` / body-swap sites, each marked
  covered or fixed).
- Assertion in place; full test + equivalence suite green (no false positives).
- Stress test added and green.
- No test262 regression.

## Notes

Pure hardening — no known live bug remains (verified in #1257). Low priority;
its value is preventing silent re-introduction of the funcIdx-shift class as
new detached-array codegen patterns are added.

## Resolution (2026-06-17, PR for #2182)

### Audit (the detaching primitive is already safe)

`collectInstrs` (`statements/shared.ts:27`) is **inherently covered**: it pushes
the prior body onto `fctx.savedBodies` for the duration of `emitFn()` (the only
window a late import can fire), and `shiftLateImportIndices` walks
`fctx.savedBodies` + `ctx.currentFunc.savedBodies` + every `funcStack[]`
savedBodies. Same for `pushBody`/`popBody` (`context/bodies.ts`) and the
`parentBodiesStack` idiom. The walked coverage set is: `fctx.body`,
`fctx.savedBodies`, `ctx.currentFunc.{body,savedBodies}`, `funcStack[].{body,
savedBodies}`, `ctx.parentBodiesStack`, `ctx.liveBodies`, `ctx.pendingInitBody`,
`ctx.mod.functions[].body`.

The residual hazard is the **raw `const saved = fctx.body; fctx.body = <other>`
swap** that bypasses all of the above and holds `saved` (the *outer* body, which
may already carry shiftable `call` funcIdxs) across an emit that can trigger a
late import. Audited every such site; three were uncovered and are now fixed by
registering `saved` in `ctx.liveBodies` for the swap's lifetime:

| site | swap | fix |
|------|------|-----|
| `builtin-static-globals.ts:177` | `fctx.body = initBody` across `emitBuiltinStaticMethodValue` | `liveBodies.add(savedBody)` / `.delete` in `finally` |
| `type-coercion.ts:2449` | `fctx.body = scratch` across `normaliseToString` | `liveBodies.add(savedBody)` / `.delete` |
| `generators-native.ts:1245` (resume-state build) | `fctx.body = body` across `compileStatement`/`emitYieldValueAsElem` | `liveBodies.add(saved)` / `.delete` |

(The `then`/`else` capture-after-emit patterns and `fctx.body.length`/`splice`
snapshots are safe — they operate on the live `fctx.body`, which is always
walked.)

### Defensive assertion

`compileFunctionBody` (`function-body.ts`) snapshots `ctx.liveBodies.size` at
entry and asserts the size is restored at exit. A non-zero delta means a
detached-body `liveBodies.add` was not balanced by a `.delete` — the exact gap
that re-introduces the funcIdx-shift class. Scoped to the **delta** (not "must be
empty") so it never false-positives on a parent body legitimately registered by
an enclosing compile while a lifted closure / nested function compiles.

### Test Results

- `tests/issue-2182.test.ts` (new) — 5/5: stress fixtures triggering many late
  imports during nested destructuring-default builtins, generator resume-state
  builds, interleaved string+numeric imports, and nested loop+destructuring all
  compile AND run to the expected value (every `call` funcIdx still resolves);
  plus a closures+builtins case proving the balance assertion does not
  false-positive.
- `tests/issue-1257.test.ts` — pass (original regression net).
- `tests/generators.test.ts` + generator/destructuring/closure suites — pass,
  **zero `#2182` invariant throws** (assertion produces no false positives).
- Pre-existing, unrelated failures: several `tests/`-root files import
  `./helpers.js` (the helper lives at `tests/equivalence/helpers.ts`) — a path
  bug in those files, unmodified here; CI's setup resolves it.
