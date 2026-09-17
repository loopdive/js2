---
id: 6491
title: "Linked lane: 36 negative early-error rows compile with no diagnostic (honest lane reports the SyntaxError)"
status: in-progress
sprint: current
created: 2026-09-16
updated: 2026-09-17
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: test262-runner
goal: test262-conformance
depends_on: [3451]
related: [3451, 6486, 3506]
# (2026-09-17) The under-application fix lives where the defect is: the host
# bridge's free-function dispatch arm in src/runtime.ts. +29 lines, of which the
# executable change is 8; the rest records WHY widening is safe (never above the
# closure's declared arity) and names the residual `arguments.length` answer, so
# the next reader does not re-derive it from a 14-row test262 bucket.
loc-budget-allow:
  - src/runtime.ts
---

# #6491 — early errors not detected on the body-only unit

## Problem (first full-corpus run, 2026-09-16, run 35116762391)

Parity bucket `expected SyntaxError but compiled with no diagnostic (early error
not detected)` = 36 rows: honest `pass` (diagnostic reported), linked `fail`.
The worker passes `enforceJsEarlyErrors: isNegative && negativePhase !== "resolution"`
to both branches, so either the early-error pass does not run on the
`compileMulti` graph the linked body is compiled through, or it runs on the
wrong file (the stub), or the check needs the harness prefix in the same unit
(e.g. duplicate-declaration / `let` redeclaration against a harness name).

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

1. Pull the 36 file names from the parity JSON artifact
   (`test262-linked-baseline-8eeaee8e…`, run 35116762391) and group by the
   early-error kind the honest lane reported.
2. For each group, compile the body-only unit through `compileHarnessLinkedBody`
   with `enforceJsEarlyErrors: true` in a vitest probe and check
   `result.errors`; find where `enforceJsEarlyErrors` is consumed in
   `compileMultiSource` (`src/compiler.ts` ~L1840–1960, `detectEarlyErrors`
   call) and whether it covers every user file of the graph.
3. Fix in the compiler/lane, add the rows' shapes as unit cases, re-measure on
   the next `linked_lane` dispatch (bucket → 0).

## Acceptance

- [x] No honest-lane change (measured: 50/50 rows still `pass`; a 1,297-row
      callback-heavy honest slice flips 0 rows).
- [ ] The 36 rows agree with honest — **15 of 50 fixed; the remaining 35 must
      NOT be "fixed"**: honest passes them only through a spurious warning (see
      below). Needs a lead decision, not more implementation.

## Implementation notes (2026-09-17, Opus lane)

### Setup

Worktree `/home/user/js2/.claude/worktrees/agent-af8bbc7b957057171`, branched at
`91e0fb35bd`. Bundles rebuilt from the bundle ENTRIES
(`scripts/compiler-bundle-entry.ts` / `runtime-bundle-entry.ts`) before every
runner measurement — a worktree without them makes every row a
`worker failed before ready` timeout. Lanes reproduced with the real runner
(`tests/test262-chunk-dynamic.test.ts`, `TEST262_PATH_FILTER` = the 50 rows).

### Finding 1 — 34 of the 36 (a)-rows are honest FALSE PASSES, not linked misses

The early-error pass DOES run on the linked graph: `enforceJsEarlyErrors` →
`runEarlyErrorsOnAllowJs` → `detectEarlyErrors` over every user source file, and
a synthetic `let x; let x;` body is rejected identically in both lanes.

What actually separates the lanes is the **diagnostic the honest unit carries
for an unrelated reason**. Compiling the honest whole-assembly for each of the
36 rows and printing `result.errors` (not just failures):

| honest diagnostics on the 36 rows                                        | rows |
| ------------------------------------------------------------------------ | ---- |
| ONLY `warning: IR path failed for $DONOTEVALUATE … [IR-FALLBACK]`         | 34   |
| that warning plus `warning: Cannot access 'arguments' before initialization` | 1 |
| `error: Duplicate identifier 'x'` (a real rejection)                      | 1    |

`$DONOTEVALUATE` is a HARNESS function. In the linked lane the harness lives in
the provider, so the body-only unit has no such warning and reports
`errors: []` — for all 36. The honest verdict then comes from
`scripts/test262-worker.mjs`'s #2912 **lenient warning arm**: on a negative
parse/early row, ANY diagnostic (warning included) whose type is consistent with
`SyntaxError` scores `pass`. So the honest lane never detected these early
errors at all; it passed them on an IR-fallback note about a harness function.

Making the linked lane "agree" would mean manufacturing that warning. It is not
done and should not be. The real defect is the lenient arm — the same
incidental-pass class #2898/#2920 already names — and tightening it changes
HONEST verdicts corpus-wide, so it needs the lead's sign-off plus a baseline
refresh, exactly as #2920 did. Filed as a finding, not a change, here.

### Finding 2 — `language/import/dup-bound-names.js`: a real rule nobody owned

Honest rejected it, linked did not. The honest rejection was itself an artifact:
the single-source path rewrites unresolvable imports into declarations, and
`checkDuplicateLexicalDeclarations` caught the rewritten pair; the multi-file
path resolves imports through the TS program and never rewrites.

Fix: `checkDuplicateImportedBindings` in
`src/compiler/early-errors/module-rules.ts` (§16.2.1.1 — ImportedBindings are
LexicallyDeclaredNames of a ModuleItemList), wired into `detectEarlyErrors`.
Import-vs-import only; the import-vs-top-level-lexical half needs the
module-goal scoping `checkDuplicateLexicalDeclarations` owns and is left alone.

### Finding 3 — (b) is not about `eval`: under-applied cross-module calls never ran

All 14 `eval-code/direct` rows are `assert.throws(SyntaxError, f)` where `f`
declares parameters and the harness calls it with NONE. Reduced to:

```js
// provider:  function valueOfCall(fn) { return "VAL:" + String(fn()); }
// consumer:  function g(a) { console.log("RAN"); return 1; }
//   single module: RAN | VAL:1        linked: VAL:undefined   (body never ran)
//            g(a = 9): VAL:9          linked: VAL:undefined
```

`__call_fn_N` matches only closures of declared arity N, so the host bridge's
free-function arm (`_wrapWasmClosureUnknownArity`, `src/runtime.ts`) — which
dispatched at the CALL SITE's argument count — selected `__call_fn_0`, matched
nothing and returned `undefined`. The body never ran: no default-parameter
initializer, no throw. This is the #2664 omission hazard, which the METHOD arm
right above it already handles via `__closure_arity`; the free-function arm
never got the same treatment. In one module the call is compiled in Wasm and
never reaches the bridge, which is why only a linked graph shows it.

Fix: widen the free-function dispatch to the closure's own declared arity when
the call is UNDER-applied (never above it, so the low-arity generator rule the
existing comment states is untouched), padding with real `undefined`.
Residual, documented at the site: this family has no argc-seeding wrapper (only
`__call_fn_method_argc_N` exists), so a widened call reports `arguments.length`
as the declared arity — a narrower wrong answer than not running the body, and
confined to calls that previously produced nothing.

Scope note: this is NOT a test262-only fix. Any provider→consumer callback that
under-applies was a silent no-op.

### Before / after (real runner, this worktree, 2026-09-17)

| lane                       | before | after |
| -------------------------- | ------ | ----- |
| linked, the 50 rows        | 0 pass / 50 fail | **15 pass / 35 fail** |
| honest, the 50 rows        | 50 pass | 50 pass (unchanged) |
| honest, 1,297-row callback slice (`Array.prototype.{forEach,map,reduce,sort,filter}`, `Promise.prototype.then`) | 913 pass / 334 fail / 46 CE / 4 CT | identical — **0 flips** |

The 15: the 14 `eval-code/direct` rows + `import/dup-bound-names.js`.
The 35 remaining are Finding 1 and are deliberately left failing in the linked
lane, where the verdict is the correct one.

### Guards

`tests/issue-6491-linked-under-applied-consumer-call.test.ts` (parity: linked vs
single-module, including two regression guards for the exactly-applied and
zero-parameter cases) and `tests/issue-6491-duplicate-imported-bindings.test.ts`
(accept/reject pairs). Re-run green: #1931, #2664 ×2, #2623 P-7, #3451 ×3,
#6474, #6492 ×2. `tests/issue-2623-p7b-observable-resolve.test.ts` fails
`Promise.try is not a function` — verified failing on the BASE runtime too
(this Node build), pre-existing and unrelated.
