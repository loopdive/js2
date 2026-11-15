---
id: 7345
title: "IR: a top-level function stays a direct-call target in a file that contains eval, unless the source can rebind it"
status: done
completed: 2026-11-15
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-11-14
updated: 2026-11-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7283, 7171, 7106, 3630, 7343]
# 2026-11-15 (review round 1): select.ts +12: the option field and its type import, the call-graph
# condition (one call to `isStableDirectCallTarget`, lattice-param-facts.ts, which owns the whole decision),
# and the boundary refusal. whyNotIrClaimable +4: that refusal, after the body walk, so a shape refusal
# keeps its own label. codegen/index.ts +2 and planIrOverlay +1: the option's import and its one spread line
# beside #7128's.
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

## Implementation (2026-11-14, branch `claude/7345-eval-file-call-targets`)

### What changed

- **`localIsRewritten`** (`src/ir/lattice-param-facts.ts`) is main's: a
  direct `eval` in the scope, or a source write (`bindingIsWritten`). The
  call graph instead asks `isStableDirectCallTarget` beside it, which owns
  the whole decision (review round 1, below).
- **One selection option, `runtimeEvalFunctions`**
  (`IrRuntimeEvalFunctionAnswers`, `src/ir/runtime-eval-boundary-plan.ts`).
  It is built next to A1 by `irRuntimeEvalSelectionOption`
  (`src/codegen/ir-overlay-preparation.ts`), on standalone only.
  - `mayRebind(callee, declaration)`: the declaration is in
    `ctx.reassignedFunctionDeclarations` (the set the direct-call side
    excludes) **and** the call resolves to it. A named function expression's
    self-call (`function f(k) { return f(k - 1); }`) reads its own name, not
    the script binding; the #7106 A1 self-reference test pins this.
  - `crossing(declaration)`: A1's own `runtimeEvalBoundaryCrossing`, asked
    only where A1 runs (`callableBoundaryRequired`). The predicate is the
    same, not a mirror: the set of eval-visible names is now a shared helper,
    `evalVisibleBindings`, that the withdrawal uses too.
- **The call graph** (`buildLocalCallGraph`) asks
  `isStableDirectCallTarget(callee, declaration, runtimeEvalFunctions,
  resolve)`: no source write, and no rebinding by evaluated code, which is
  `mayRebind` where the lane passes the option. A lane that passes none (the
  JS environment, WASI, bare selector callers) keeps the earlier rule: a
  direct `eval` in the function's scope may rebind it. That fallback is on
  the ir side because codegen importing `lattice-param-facts` would add a
  codegen→ir edge (`check:import-cycles`).
- **`whyNotIrClaimable`** refuses an otherwise-claimable function that
  `crossing` names as `deferred-feature` /
  `fn-runtime-eval-boundary(<eval-site | eval-visible-binding>)`. The check
  runs after the body walk, so a shape refusal keeps its own label.

### Differences from the plan

- `mayRebind` takes the call's identifier as well, so it can resolve by
  identity (above).
- The refusal is placed after the body walk, not first.
- On standalone, an eval-visible reader's call-graph component now follows
  the selector's closure instead of preparation's `boundary-closure`. In the
  #7106 A1 unit-boundary test, `live` keeps the IR on standalone: it has no
  eval-visible reference of its own, and its caller is refused at select.
  WASI is unchanged. Three #7106 tests are updated for this:
  - `runtime-eval-unit-boundary` (the standalone closure label, and `live`);
  - `runtime-eval-a3-liveness` and `runtime-eval-a1-selfref`, which now read
    the reason from the selector's detail with shape diagnostics on. Their
    assertions are unchanged.

### Measured

Main `1d441ad8eb` against head `06e1870c4d`. The later commit `aa6b4fd69e`
moves only the off-standalone fallback into the selector; standalone behaviour
is unchanged. gc bytes were re-measured on `aa6b4fd69e`.

- **Population:** 1,113 ES5 files from the 2026-11-14 census
  (`plan/log/es5-ir-only-census-2026-11-14.md`) whose record carries
  `harness:assert.js`, `external-call(isPrimitive)` or an eval label, plus a
  seeded 300-file IR-only control. 1,413 files in all, standalone.

| measure | result |
| --- | --- |
| files gained IR-only | **8**: `language/line-terminators/S7.3_A7_T1`–`T8` (the #7209 loss) |
| files lost | 0 |
| files with a unit newly legacy | 0 |
| new compile errors | 0 |
| post-claim errors | 0 on main, 0 on head |
| `formatIdentityFreeValue` / `formatSimpleValue` now IR | 446 files each |
| routing-changed files | 473 (0 of the 300 control files) |

- **Verdicts, runtime-eval provider linked.** The interpreter tier was used:
  `JS2WASM_EVAL_ENGINE=interpreter TEST262_FULL_RUNTIME_EVAL=1`, with the
  provider built per tree. Every run announced `tier: INTERPRETER`.
  - The 473 routing-changed files: main 302 pass / 171 fail, head
    302 / 171. **0 per-file verdict changes.**
  - The 8 regained files fail on both trees with the same message (the eval'd
    source's result `x` is wrong at L21), so the routing change does not cause it.
- **JS-environment bytes:** 673 / 673 identical (the 473 routing-changed
  files plus 200 seeded compiled ES5 files without `eval`).
- **Tests:**
  - `tests/issue-7345-eval-file-call-targets.test.ts`: 5/5, including the
    three rows acceptance criterion 3 says must stay refused;
  - #7283: 4/4; #7306: 46/46;
  - #7106: 66 failures, all of them also failing on main `1d441ad8eb`. On
    main the same files have 67; this change fixes one (A3
    `makes the function live for a direct-eval call`).
- **Quality:** the full list passes, 49/49, run in foreground ranges.

### Not verified

- A full-population census. Only the 1,413-file population above was
  measured.
- Verdicts on files whose routing did not change.
- Acceptance criterion 7 (the adversarial review) is the PR's.

## Review round 1: MET (PR #7239, 2026-11-15)

Reviewer's verdict: no wrong answer on 39 rebinding attack files with the
interpreter provider, no unit lost, no post-claim error, gc bytes identical,
and the #7106 test updates judged legitimate. Two should-fix items, both
fixed in `c63470f261`:

1. **One decision in one place.** `localIsRewritten` special-cased function
   declarations, and the call graph then re-added the eval term through
   `scopeHasDirectEval`.
   - `localIsRewritten` is main's again (`dynamicScope ||
     bindingIsWritten`).
   - The call graph asks `isStableDirectCallTarget`, beside it in
     `lattice-param-facts.ts`, which owns the whole decision.
   - `scopeHasDirectEval` is gone.
   - `select.ts` growth falls from +15 to **+12**, and `whyNotIrClaimable`
     from +7 to +4. The grant above is updated.
2. **Explicit refusal.** `capabilityNo(…) || "deferred-feature"` called a
   predicate for its side effect. The refusal now records its detail with
   `shapeNo` and returns `"deferred-feature"`.

Re-verified on `c63470f261`, which includes main `7996e61a23` (no `src/` or
`tests/` change since the earlier base):

- **Tests:** 95/95. That covers #7345 5/5; the #7106 runtime-eval
  unit-boundary, A3 liveness and A1 self-reference tests; #7283 4/4; and
  #7306 46/46.
- **Routing on the 1,413-file census:** 0 differences in units, codes or
  details from `06e1870c4d`, whose standalone path is the same as
  `a9463bb697`. Against main: +8 IR-only, 0 lost, 0 units newly legacy, 0
  compile errors, 0 post-claim errors.
- **JS-environment bytes:** 673/673 identical.
- **The reviewer's 39 attack files** (`rv7239/zrepro`), interpreter tier, run
  through a private test262 overlay: head 18 pass / 21 fail, main 18 / 21. 0
  per-file differences, and head equals the reviewer's head run.
- **Quality:** the full list passes, 49/49, in foreground ranges.
