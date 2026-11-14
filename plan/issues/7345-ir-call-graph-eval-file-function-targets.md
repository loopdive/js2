---
id: 7345
title: "IR: a top-level function stays a direct-call target in a file that contains eval, unless the source can rebind it"
status: in-progress
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-11-14
updated: 2026-11-14
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7283, 7171, 7106, 3630, 7343]
# 2026-11-14: the selection option, the call-graph check and the select-time boundary refusal live with
# their siblings in select.ts (+7: the option field, its type import, one call-graph condition, the refusal).
# codegen/index.ts +2 and planIrOverlay +1: the option's import and its one spread line beside #7128's;
# whyNotIrClaimable +3: the refusal, before the body walk, where the subject's other early refusals are.
loc-budget-allow:
  - src/ir/select.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/ir/select.ts::whyNotIrClaimable
  - src/codegen/index.ts::planIrOverlay
---

# #7345 — IR: function call targets in files that contain eval

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only").

In a file that contains any `eval(` call, the selector's local call graph
treats **every** call to a top-level function as external. The harness
helpers in `assert.js` call each other (`formatSimpleValue` calls
`formatIdentityFreeValue`, which calls `isNegativeZero`; `isPrimitive`), so in
such a file those helpers are refused as `external-call` although nothing
rebinds them.

- Where: the call graph's callee check (`src/ir/select.ts`, the branch that
  asks `localIsRewritten` and falls through to `markExternal`).
  `localIsRewritten` (`src/ir/analysis/lattice-param-facts.ts`) answers
  "rewritten" whenever the scope contains an `eval(` call anywhere in the
  file. #7283 extended that rule to function declarations.
- The rule is coarser than the fact it stands for. The precise fact already
  exists: legacy's `ctx.reassignedFunctionDeclarations`, filled by
  `registerReassignedFunctionGlobals` from the runtime-eval plan's dynamic
  source writes and references. The direct-call side already excludes exactly
  that set (`makeIrFunctionObjectValueResolver` in
  `src/codegen/ir-imported-call-planning.ts`, and the closure plans in
  `src/codegen/function-member-closure-planning.ts`).

## Measured

Census of 2026-11-14 (`plan/log/es5-ir-only-census-2026-11-14.md`, main
`8e2a65b374`, 8,591 ES5 files compile, 1,601 IR-only):

- The two helpers are refused in 872 files (515 on 2026-11-11).
  `harness:assert.js` is carried by 1,054 blocked files and is the sole
  blocker of 36; `external-call(isPrimitive)` is a greedy set-cover step of
  its own.
- PR #7209 (#7171) lost 8 IR-only files with this shape
  (`language/line-terminators/S7.3_A7_T1` to `T8`), which nothing flagged.

Probe of the change below on 327 eval-carrying files (research of 2026-11-13,
not committed):

| measure | result |
| --- | --- |
| files where the helpers become IR | 167 of 278 |
| helpers still refused, correctly (eval may rebind them) | 106 |
| helpers still behind the caller-activation gate | 10 |
| files newly IR-only | 3 |
| new post-claim errors | 0 |
| files losing a unit | 6 |
| JS-environment binaries changed | 167 of 167 routing-changed files |

Most of these files stay blocked by the `eval` in their own top-level code,
so the direct file yield is small (the 8 lost files, plus a few). The value is
removing a spurious refusal from several hundred files, so that the eval lever
(#3630) and the harness levers stop being hidden behind it.

## Which change made the rule coarse: #7209, not #7283 (settled from the code, 2026-11-14)

The research above attributes the "any eval in the file" rule to #7283
(`3c063b5c2e`, 2026-11-07). The code says otherwise:

- #7283 made `localIsRewritten` apply to function declarations, but its check
  was by name only (`collectWrittenNamesIncludingNested`): `f = …` anywhere in
  the scope. It had no eval term. The 11-11 census, taken after #7283, has the
  eight `line-terminators/S7.3_A7_T*` files IR-only.
- #7209 (#7171 / #7306, merge `23518e79fc`) rewrote the index
  (`writeIndexOf`) and added `dynamicScope`: a direct `eval` call anywhere in
  the scope, and `if (index.dynamicScope) return true;` in `localIsRewritten`.
  It did not touch assert.js or the call chain. Applied to function
  declarations, that one line makes every top-level function in an eval file
  "rewritten", so `formatIdentityFreeValue → isNegativeZero` and
  `formatSimpleValue → formatIdentityFreeValue` became `external-call`. The
  eight files flip exactly at `23518e79fc` (measured: IR-only at `8b3e5ff1e9`,
  blocked at `23518e79fc`).

So the coarse term to remove is #7209's `dynamicScope` term, for function
declarations; #7283's name check stays.

## Implementation Plan

### Target structure

- **One definition both sides ask.** The call graph treats a top-level
  function declaration as a stable direct-call target unless the source
  writes its binding, or the runtime-eval plan says dynamic code may rebind
  it. The second part is the existing `reassignedFunctionDeclarations` set,
  passed to the selector as one selection option
  (`isReassignedFunctionDeclaration(decl)`); no second scan of the source.
- **What it reuses.** `localIsRewritten`'s write index for the first part;
  the runtime-eval plan's set for the second. `localIsRewritten` loses its
  "any eval in the file" term for function declarations.
- **What duplicate it removes.** The coarse eval term, which restates the
  runtime-eval plan's answer imprecisely.

### Refuse at select what preparation withdraws

The probe lost 6 units: a newly selected caller is withdrawn at preparation
(`eval-visible-binding` in `src/codegen/ir-overlay-preparation.ts`), and the
boundary closure then drags an already-IR callee back to legacy. A unit that
references an eval-visible binding must therefore be refused at select,
through the same option, so that nothing is claimed and then withdrawn. This
is part of the slice, not a follow-up: the slice may not lose a unit main
lowers.

### Lane

The JS environment runs the same selector, so without a gate its output
changes on every routing-changed file. Gate the new answer to the standalone
lane the way #7280 and #7340 gate theirs, so JS-environment output stays
byte-identical.

### Constraints

- Standalone only; no new host imports.
- JS-environment output byte-identical.
- No unit that main lowers on IR may be lost; no new post-claim error.
- `select.ts` does not grow beyond a dated grant in this file.

## Acceptance criteria

Correctness:

1. Census on all ES5 files that contain `eval(` or include a harness file
   whose helpers call each other: files gained IR-only >= 8 (the
   line-terminators files), files lost 0, units newly legacy 0, new compile
   errors 0, post-claim errors not increased.
2. Verdicts of every routing-changed file are unchanged with the runtime-eval
   provider available (interpreter engine built locally, or the CI
   merge-group shards); a local run without the provider is not evidence.
3. A file whose eval source can rebind a helper keeps the refusal: test rows
   for a literal eval source that names the function, an unknown eval source,
   and a direct assignment to the function's name.
4. JS-environment output byte-identical on the routing-changed files and on
   200 files without eval.

Code quality:

5. The "any eval in the file" term is gone for function declarations; the
   selector asks one option backed by the runtime-eval plan's set, and the
   direct-call side asks the same set.
6. No flag parameter added to `localIsRewritten` to switch the old behaviour
   back on.
7. A fresh-context adversarial review records its verdict in the PR body.
