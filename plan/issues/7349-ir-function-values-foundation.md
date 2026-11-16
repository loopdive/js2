---
id: 7349
title: "IR foundation: function values — one planner, one call path"
status: blocked
sprint: current
created: 2026-11-15
updated: 2026-11-15
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7347, 7348, 7106, 7195, 7198, 7287, 3214]
loc-budget-allow:
  # 2026-11-15 (#7349 S1a): the selector's carrier consumers (argument, construct and function-object store),
  # its function-value read and its dynamic-call carrier kinds read selector state (`currentDynamicParamNames`,
  # the move-only scan, `currentModuleBindingResolver`), so they stay beside it; the position rule, the
  # value-read rule and the call shape are in `src/ir/function-values.ts`.
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-15 (#7349 S1a): one arm each for a call through a dynamic value in value position (Phase-1, the
  # move-only scan's dyn-shaped test and its value-position scan).
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
---

# #7349 — IR foundation: function values

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only"). Direction since 2026-11-15 (`CLAUDE.md`, "IR
migration: foundations first"): build the mechanisms many files need.

A function used as a value is the largest such mechanism. The IR has four
separate, narrow ways to make or call one, each with its own admission:

| mechanism | what it covers | what restricts it |
| --- | --- | --- |
| planned closures (`src/codegen/function-member-closure-planning.ts`) | an unannotated function expression at four sites | boolean, void or string result; no captures; `this` only with a void or string result |
| annotated closures (`src/ir/select-closure-literal.ts`) | `const f = (x: T): U => …` | needs annotations, so never applies to JavaScript |
| dynamic value call (`lowerDynamicValueCall`) | a call through a dynamic value | statement position on a script variable, or a planned closure's dynamic parameter |
| function objects (`lowerTopLevelFunctionValue`) | a top-level declaration as a value | only as an expando receiver or the stored value of `F.x = g` |

Everything else is refused: `var f = function…`, a call through a parameter
or variable in value position, an IIFE, a callback, a declaration assigned or
passed, `new` on a function value.

## Measured

Standalone, 2026-11-15, on origin/main `8032c37eb2`, from the 2026-11-14
census rows (6,990 blocked ES5 files) and probe runs. Research record:
session scratch `fnfound/research.md` (not in the repository; the tables that
matter are copied here).

| measure | files |
| --- | --- |
| blocked files carrying a function-value refusal | 3,699 |
| of those, nothing else blocks | 700 |
| `var f = function…` (`vardecl-let-closure`) | 1,099 |
| IIFE or other non-identifier callee | 793 |
| `new F()` with an unproven constructor body | 503 |
| `new` through a script variable | 271 |
| call through a parameter or variable (`expr-local-call-target`) | 256 |
| unannotated function literal outside the four sites | 236 |
| a declared function genuinely used as a value | 332 |

- 1,481 further files show a declared function's name as "not in scope"
  only because that function's own unit is legacy (eval in 872,
  `propertyHelper.js` in 899). They are collateral, not function-value work.
- `assert.js` + `sta.js` compile with zero legacy units on their own.
  `propertyHelper.js` needs function values **and** built-in globals as
  values.
- #7348 Step 0 (2026-11-15): admitting every storage-agreement refusal let
  the IR claim every unit in only 41 of 1,438 sampled blocked files. So a
  whole-file all-dynamic closure ABI is not the lever; function values must
  be shared with legacy units.

What a legacy unit does with a function value (WAT probes):

- read from a shared slot: it tests the funcref against the signature the
  TypeScript checker infers (`var f = function(){ return 1; }` is
  `() -> f64`) and calls it typed; a mismatch takes the "not a function"
  path;
- received as an untyped parameter: an inline ladder over the closure types
  registered so far.

## Implementation Plan

### Target structure

- **One representation.** Every function expression, arrow or declaration
  used as a value is a closure on the canonical wrapper signature
  (`computeClosureWrapperSig`). That signature is a function of the checker's
  signature, not of a legacy special case: untyped parameters are dynamic,
  the result is f64, i32, string or dynamic. Legacy and IR units then hold
  each other's function values with no agreement check.
- **One planner.** `planMemberClosure` becomes the single function-value
  planner. Its four site functions (`memberAssignmentSite`,
  `argumentPositionSite`, `callArgumentSite`, `scriptVarSite`) are replaced
  by one value-position rule whose only job is to name the owner unit. The
  planner lives in its own module under `src/ir/` with the admission
  (signature, parameters, body proof) split from the position rule;
  `function-member-closure-planning.ts` (844 lines) shrinks to the codegen
  services the planner asks.
- **One call path, one optimisation.** A callee that is statically known (a
  declaration, or a never-written `var f = function…`) gets a direct typed
  call. Every other call goes through `lowerDynamicValueCall`
  (`__apply_closure`), in any expression position.
- **Declarations** use the cached per-declaration closure that exists
  (`lowerTopLevelFunctionValue`), in any expression position.
- **What it reuses.** The planned-closure admission and allocation, the
  annotated-closure capture environment and ref cells, `__apply_closure`,
  `__is_callable`, the declaration singletons.
- **What duplicates it removes.** The four site functions; the
  statement-position special case of the dynamic call
  (`isStatementDynamicModuleCall`); the position list of function objects;
  #7347's planned fifth site (object-literal property), which becomes one
  position of the value rule.

### Slices

Yields are **static estimates** over the 700 files where function values are
the only refusal family; a calibration against a real selector run suggests
0.5 to 0.7 of each. Each slice re-measures on current main before it starts
and reports compiled results.

| slice | content | cumulative files (static) | added |
| --- | --- | ---: | ---: |
| S1a | a top-level declaration as a value in any position; calls through a dynamic value in value position, on parameters and locals as well as script variables | 19 | 19 |
| S1b | the one planner: unannotated literals anywhere (including object-literal properties and descriptor fields), number and dynamic results, untyped parameters, `var f = function…` with direct calls | 69 | 50 |
| S2 | IIFE and other expression callees: the literal is a call-graph unit, called directly | 179 | 110 |
| S3 | nested function declarations and captured locals, read and written (the annotated-closure environment, without annotations) | 353 | 174 |
| S4 | `this` in a plain function | 447 | 94 |
| S5 | the `arguments` object and extra arguments | 494 | 47 |
| S6 | `new` of a function value beyond the proven constructor shapes | 627 | 133 |
| S7 | `f.call`, `f.apply`, `f.bind` | 669 | 42 |

Outside the 700: S1 is a prerequisite for the 332 files that use a declared
function as a value and, together with built-in globals as values, for the
899 `propertyHelper.js` files.

### Hazards to prove per slice

1. **The legacy ladder is order-dependent.** A wrapper type must be
   registered at planning time (as `ensureFuncValueWrappersRegistered` does
   for declarations), or a legacy ladder emitted earlier does not see it.
2. **Typed readers.** A legacy unit that reads the value from a shared slot
   tests it against the checker's signature. Probe each result kind in both
   directions (IR writes and legacy calls; legacy writes and IR calls).
3. **Refusing a function at select drags its IR callers to legacy** through
   the call-graph closure. Every slice measures units newly legacy on a wide
   control set, not only on the target files.
4. **Bodies.** The 2026-11-13 research found that answering the binding
   question alone gained 0 files, because a body blocker sat behind it. A
   slice's yield counts only files that end with zero legacy units.

### Constraints

- Standalone only; no new host imports; JS-environment output
  byte-identical.
- No test verdict regresses; no unit that main lowers on IR is lost; refuse
  at select, never claim and then withdraw.
- The selector asks the planner. It carries no copy of the planner's
  admission.
- Size: the planner module and its position rule are separate files from the
  start; no budget grant for `select.ts` or `from-ast.ts` beyond a dated,
  justified one.

## Acceptance criteria

Per slice:

1. Census on the function-value carriers (3,699 files) and 500 IR-only
   control files: files gained, files lost 0, units newly legacy 0, new
   compile errors 0, post-claim errors not increased.
2. Verdicts of every routing-changed file unchanged or improved.
3. A probe matrix against node covering both directions of hazard 2 for the
   slice's positions and result kinds: nothing claimed answers differently.
4. JS-environment output byte-identical on the routing-changed files and on
   200 others.

Code quality:

5. After S1b the four site functions are gone, and no fifth exists.
6. One call path for a non-static callee; the statement-position special
   case is gone after S1a.
7. A fresh-context adversarial review per slice records its verdict in the
   PR body.

## Parked 2026-11-16

Owner decision 2026-11-16: the program goal is the prepared-program IR path
(`TEST262_COMPILER_PATH=ir`, #7188), not zero legacy units in the ordinary
pipeline. S1a is parked on branch `claude/7349-s1a` (head `a7d240cab2`), no PR.

### What S1a builds

- `src/ir/function-values.ts` (new):
  - `functionValueUse`: a top-level function read as a receiver of its own
    expandos, or as a whole value. It replaces the stored-value position list.
  - `carrierSink`: the positions that consume the dynamic carrier as-is. The
    host supplies arguments, `new` and function-object stores.
  - `memberStoreRoot`: the one store-root rule, replacing
    `isFunctionObjectStoredValue` in both the selector and the planner.
  - `bareCallCallee` and `argumentsCrossSyntactically` (moved out of
    `module-bindings.ts`).
- Selector (`select.ts`):
  - `dynamicCallCarrier` (closure / parameter / script-var) replaces
    `dynamicValueCallTarget` and `isStatementDynamicModuleCall`.
  - Value-position dynamic calls are judged by `carrierSink`, or by the
    move-only scan for parameters.
  - Function values and dynamic-call results read as family `dynamic`.
  - The call graph uses the same rule.
- `from-ast.ts`: the dynamic-call arm also takes a `<module-init>` module
  global, with no statement-position restriction.
- Planner (`ir-imported-call-planning.ts`): plans whole-value reads.
- New backend capability `native-function-values` (host-free standalone, not
  fast, not the JS environment's native regime). It gates every new admission,
  so JS-environment bytes stay identical. Stores on a function object keep
  every lane.

### Measured (base origin/main `8032c37eb2`, src identical to `d253210865`; standalone)

- Census of 3,699 function-value carriers and 500 IR-only controls (head
  `2e448ad904`; the routing and binary re-run on `a7d240cab2` is identical):

  | measure | result |
  | --- | --- |
  | files gained (IR-only now) | 4 (S15.10.6.3_A2_T10, S10.1.1_A1_T1, S13_A4_T1, S15.10.6.2_A2_T10) |
  | files lost | 0 |
  | units newly legacy | 0 |
  | new compile errors | 0 |
  | post-claim errors | 1 → 1 |
  | routing changed | 6 files |
  | standalone binary changed | only those 6 files |
  | controls | unchanged |

- Verdicts of the 6 routing-changed files: 6/6 pass on both trees.
- The first census run found a defect: a certified propertyHelper alias call
  was taken as a dynamic script-var call, making 7,094 units newly legacy.
  Fixed in `2e448ad904`.
- Re-measure before coding: of the 341 target files (the 19 of the static
  estimate plus the 332 genuine declaration-value files), 30 had only S1a-scope
  refusals. The measured yield is 4.
- Beyond ES5: 6,181 non-ES5 files where S1a can change routing (text filter
  `s1afilter.mjs`). On `2e448ad904`, 0 files gained or lost, 0 new compile
  errors, post-claim errors not increased, 54 binaries changed. Verdicts on
  those 54: identical on both trees (24 pass, 26 fail, 4 skip).
- JS-environment bytes: identical on 309 binaries at `a7d240cab2` (the 6
  changed files, the 54 beyond-ES5 changed files, every 21st census file and
  25 probe programs × 2 wrappers).
- Probe matrix (25 programs, against node): every claimed program answers as
  node does. On main 38 units stayed legacy across the matrix; on head 17.
- Tests and gates: the loc and func gates pass, with grants in this file. The
  coercion, oracle-ratchet and dead-exports gates pass.

### Unmeasured

- The beyond-ES5 re-run on `a7d240cab2` stopped at 6,096 of 6,181 files:
  routing differs in 3 files, binaries in 48. Verdicts for these 48 at
  `a7d240cab2` were not run; the earlier run at `2e448ad904` showed no
  verdict change.
- The equivalence gate and the vitest suites were not run on this branch.
- No fresh-context adversarial review was done.

### Known open defects and limits

- Member reads of a function value in general positions (`F.prototype ===
  …`) stay refused: only receiver uses are admitted.
- A realm member (`F.bind`, `F.caller`) is refused by design, because the boxed
  function object does not resolve it.
- `Function(…)` and `Object(f)` callees are built-in globals as values, not
  S1a.

### Resume

1. `git checkout claude/7349-s1a`, then merge `origin/main`.
2. Re-run the census:
   - `scratchpad/s1a/chunk.sh head|base <census-list> c` for routing with
     refusal details, then `compare.py`;
   - `rc.sh head|base <list> cr` for routing and binary, then `crcmp.py`.
3. Finish the beyond-ES5 run: `bchunk.sh head` resumes, then `bcmp.py`. Run
   verdicts on `beyond-changed.txt` with
   `scripts/run-test262-paths.mts --standalone` on both trees.
4. Run the probe matrix (`matrix.mts`) and JS-environment bytes (`bytes.mts`
   with `bytes-list.txt`). Run the equivalence gate (8 shards), the IR tests
   and the adversarial review.
5. For the prepared-program path: the `from-ast.ts` arm and
   `function-object-lowering.ts` are shared. The selector, call-graph and
   planner changes are ordinary-pipeline only.
