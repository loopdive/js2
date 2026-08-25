---
id: 4673
title: "standalone: arrow-function lexical this capture residual"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
assignee: codex/es6-arrow-wave3
priority: high
horizon: s
feasibility: medium
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [4444, 4447, 368, 2797]
loc-budget-allow:
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/helpers/body-references-own-this.ts
func-budget-allow:
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/helpers/body-references-own-this.ts::findOwnThisReference
---

# #4673 — arrow-function lexical `this` capture residual

## Problem

The ES2015 standalone arrow-function cluster was re-measured against a fresh
`test262-standalone-current.jsonl` (48,735 entries, SHA-256
`9bbc9cd8ab6afe460088443ecd3181b00ba1908edf90b765c6dbd8bf89aa3b5c`,
2026-08-25). Of 343 files under
`language/expressions/arrow-function`, 308 pass, 32 fail at runtime, and 3
have compile errors. The failures are heterogeneous; this issue owns the
bounded lexical-receiver slice only.

The clearest failures are:

- `lexical-this.js`: an arrow created by a constructor reads a null receiver;
- `arrow/binding-tests-1.js` and `arrow/binding-tests-2.js`: arrows returned
  from a function's dynamic lexical scope are expected to retain that scope's
  receiver (the standalone harness currently stops earlier at the independent
  runtime-eval refusal);
- `lexical-super-property.js` and
  `lexical-super-property-from-within-constructor.js`: an arrow's inherited
  `this` path produces `0` instead of `1`/`2`;
- `lexical-new.target*.js`: lexical `new.target` is a separate global-carrier
  problem and remains deferred here;
- `lexical-super-call-from-within-constructor.js`: a lexical `super()` call
  needs constructor completion machinery and remains deferred here.

The current closure planner scans free identifiers but does not add the
synthetic `this` binding. Consequently `compileThisKeyword` cannot find the
enclosing function's receiver in a lifted arrow body and falls back to the
`__current_this`/unbound path. In ordinary function frames, the receiver is
represented by that ambient global rather than a `localMap` slot, so the
capture path must materialize a private receiver local at arrow construction;
it must not install `this` into the ordinary function's local map, because a
preceding direct `this` read would otherwise observe an uninitialized local.
Non-arrow closures must retain their own receiver behavior.

## Implementation Plan

1. Add a scope-aware lexical-`this` check for arrow bodies and include
   `"this"` in the existing immutable capture plan when the enclosing frame
   already has a receiver local.
2. For ordinary frames whose receiver is supplied through `__current_this`,
   materialize that value into a private local at each arrow construction and
   resolve the synthetic capture through that local. Keep it separate from
   the normal `this` binding so direct reads before closure creation remain
   unchanged.
3. Add focused unit regressions for an ordinary function returning an arrow,
   constructor-created arrows, a class-method arrow, and an ordinary function
   expression control. Re-run the exact lexical Test262 cohort and compare
   the scoped baseline for zero-loss evidence. Do not absorb
   destructuring/default-parameter, generator-host-import, `with`,
   direct-eval, prototype-reflection, or lexical `new.target`/`super()`
   residuals; those require their owning issues or a follow-up slice.

## Baseline Evidence

Full authoritative filter: 343 total, 308 pass, 32 runtime failures, 3
compile errors. The complete residual list is retained in the run output; the
representative lexical rows above are the acceptance cohort. The existing
scoped runner uses the interpreter fallback in this worktree because the
QuickJS artifact is unavailable.

## Test Results

- Before (authoritative baseline, 2026-08-25): the scoped arrow-function
  filter was 343 total / 308 pass / 32 runtime failures / 3 compile errors.
  The focused ambient-receiver probe returned `0`; the three controls were
  green (1 failure, 3 passes in the eventual four-test regression file).
- After: the four focused Vitest cases pass (4/4). The ambient-receiver
  probe is now `1` (0 → 1); constructor, class-method, and ordinary-function
  controls remain green (3/3).
- Real assembled standalone Test262 cohort after the fix: 4 files yielded
  1 pass (`cannot-override-this-with-thisArg.js`) and 3 unchanged failures.
  `lexical-this.js` still fails in the dynamic member-call/harness path, and
  the two `binding-tests-*` rows stop at the independent #2928 runtime-eval
  refusal. This slice does not claim those residuals are fixed.
- Zero-loss evidence: the assembled positive control and negative control
  both retained their expected verdicts; scoped Biome lint passed for all
  modified source and test files; the ordinary-function receiver control
  stayed green before and after.

## Scope Notes

The issue is intentionally narrow. The remaining arrow failures include
destructuring/iterator close/default-initializer cases overlapping #4447,
generator carrier imports owned by #2864/#3178, dynamic `with`/eval paths,
prototype reflection, and independent `new.target`/`super()` carrier work.
