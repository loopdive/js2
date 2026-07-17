---
id: 3318
title: 'Compiler crash: "Cannot create property ''declaredType'' on number ''1''" (prototype-delete pattern)'
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-s2
sprint: current
created: 2026-07-16
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone-mode
related: [3170]
origin: "PO re-scope split of #3170 (2026-07-16) — bucket 6 of the verified 42-test residual, unrelated to search-method coercion, split out on its own merits as a compiler crash"
---

# #3318 — compiler crash on a prototype-delete pattern

## Problem

Found via #3170's residual measurement (`-9-a-14`, `-8-a-14` in
`built-ins/Array/prototype/{indexOf,lastIndexOf}`), but the crash mechanism
is unrelated to search-method semantics — it's a general TypeScript-checker/
codegen crash triggered by a prototype-delete pattern:

```
Cannot create property 'declaredType' on number '1'
```

This is a **compiler crash** (hard failure, not a semantic gap), which makes
it independently worth fixing regardless of the array-search-methods theme
it was found under — split out on its own merits per this repo's usual
practice of not bundling drive-by fixes into an unrelated method-family PR.

## Task

1. Reproduce standalone: `test/built-ins/Array/prototype/indexOf/15.4.4.14-9-a-14.js`
   and `.../lastIndexOf/15.4.4.15-8-a-14.js` (or a reduced repro isolating the
   prototype-delete pattern that trips it).
2. Root-cause where `'declaredType'` gets set on a number literal/value
   (likely a type-inference or shape-widening internal map keyed incorrectly
   when a numeric-valued property is later treated as an object needing type
   annotation) — find the actual crash site, not just the symptom.
3. Fix so the compiler either handles the pattern correctly or fails with a
   normal diagnostic instead of an internal crash.

## Acceptance criteria

- Both reproducer files compile without crashing (pass or a clean expected
  failure, not an internal exception).
- No regressions in the existing array-prototype / shape-widening test
  suites.

## Root cause + fix (2026-07-17, fable-s2)

**Not a per-test compiler bug — an in-process realm-pollution crash.** The
in-process runner (`runTest262File`) compiles AND executes tests in the
caller's own realm. `lastIndexOf/15.4.4.15-8-a-14.js` leaves
`Array.prototype[1] = 1` behind (verified: the file PASSES alone, and the
SAME file re-run in the same process then fails `compile_error`). The next
compile crashes inside the TypeScript checker's
`getDeclaredTypeOfClassOrInterface` during `initializeTypeChecker`: its
`symbolLinks` lookup is a plain array read, so `symbolLinks[1]` INHERITS the
polluted `Array.prototype[1]` → `links = 1` →
"Cannot create property 'declaredType' on number '1'".

The sharded CI worker has had `restoreBuiltins()` for this class since
#1153/#1154/#1160/#1220/#1221 (the official lane passes both files) — the
in-process runner (baseline validator, smoke-tests, residual-harvest
measurements like #3170's, where this crash was OBSERVED) had no counterpart,
so harvests manufactured phantom `compile_error` records that depended on
in-process test ORDER.

**Fix:** `tests/test262-restore-builtins.ts` (module-load snapshot of 12 core
prototypes; delete added keys/symbols incl. numeric Array indices, re-assign
changed data values with descriptor-fallback) + an ENTRY call in
`runTest262File`. The worker's version stays untouched (coupled to fork
recycle); unification is #3182 territory.

## Test Results

- `tests/issue-3318.test.ts` (4): cited files back-to-back → pass/pass; same
  file twice → pass/pass (was pass → compile_error); synthetic numeric
  pollution cleared; replaced method value restored.
- Runner-consumer sweep: issue-1049/1318-locator/1385/1450/1567 — 24/24.
