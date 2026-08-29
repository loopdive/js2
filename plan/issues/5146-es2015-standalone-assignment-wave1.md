---
id: 5146
title: "ES2015 standalone: assignment conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/identifier-assignment.ts
  - src/codegen/iterator-native.ts
  - src/codegen/function-instance-meta.ts
  - src/codegen/js-errors.ts
  - src/compiler/early-errors/node-checks.ts
  - src/codegen/statements/destructuring.ts
  # 2026-08-28 (#5146 cluster E): the `.name` fold needs a simple-assignment
  # NamedEvaluation probe (`x = (0, function(){})` must stay unnamed), which
  # lives next to `resolveLogicalAssignmentName` in property-access.ts and is
  # consumed by the `.name` arm in property-access-dispatch.ts.
  - src/codegen/property-access.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  # 2026-08-28 (#5146 clusters C/D/F): the PutValue guards, the computed-key
  # evaluation and the nested-pattern default arms are new emitted-code paths
  # inside the existing destructuring drivers, not refactors.
  - src/codegen/expressions/assignment.ts::compileDestructuringAssignment
  - src/codegen/expressions/assignment.ts::compileArrayDestructuringAssignment
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
---

# #5146 — ES2015 standalone: assignment conformance wave 1

## Problem

All 98 ES2015-bucket "assignment" work-package tests still fail on the
standalone target (re-verified per-test on head `86739f05`, 2026-08-28:
84 FAIL + 14 COMPILE_ERROR, 0 already fixed since the baseline). 96 of the 98
are `language/expressions/assignment/dstr/` — destructuring assignment
*expressions*. The lowering (`src/codegen/expressions/assignment.ts`)
eagerly materializes the RHS iterable via `__array_from_iter_n`, then returns
the materialized vec as the expression's completion value (spec: the original
rval), silently drops element-access and nested-initializer targets, and skips
the PutValue const/TDZ/strict-unresolvable checks. This is the same
§13.15.5.2/.5 semantics family that #5144 fixes for for-of heads; landing both
closes the largest remaining `language/expressions` gap on the road to 100 %
ES2015 standalone. Growth allowance for the files above granted 2026-08-28 for
this change-set (rationale: per-element iterator drive + PutValue guards are
new emitted-code paths, not refactors).

Target list (regenerated today, authoritative):
`.tmp/es2015/wp-assignment-current-fails.txt` (98 paths).
Minimal repro probes used below are in `.tmp/es2015/asn/*.js`
(run via `npx tsx .tmp/probe-one.mts <abs-path>`).

## Current failure clusters

Counts verified by classifying all 98 paths; sums to 98. Sample paths are
relative to `test262/test/language/expressions/assignment/`.

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| G | generator-coupled (gated on #5141/#680) | 26 (14 CE + 12 FAIL) | Native generator lowering (`src/codegen/generators-native.ts` candidacy gates, #680): `yield` inside a destructuring assignment is not an admitted shape. 12 `*rtrn-close*` CE with "sequential numeric yields only"; 10 `*yield-expr*` compile but resume wrong (`.next().value` = `[object Object]`, expected `undefined`); `array-iteration`/`array-rest-iteration` trap `unreachable in __gen_resume___closure` on bare `yield;`. Same admission-gate clusters as #5141 A1/A2/A3. | `dstr/array-elem-iter-rtrn-close.js`, `dstr/obj-id-init-yield-expr.js`, `dstr/array-iteration.js` |
| B | IteratorClose fidelity + abrupt/order | 23 | `assignment.ts:2439` (`compileExternrefArrayDestructuringAssignment`): materialize-first via `__array_from_iter_n` (`:2471-2486`) calls all `next()`s before any target lref is evaluated (order test expects `[source, iterator, target, target-key, iterator-step, …]`, we produce `[source, iterator, iterator-step, iterator-done, target]`); an abrupt completion during target assignment never triggers IteratorClose and non-identifier targets don't even throw (probe `p-thrw.js`: thrower never runs, returnCount=0). Empty pattern `[] = iterable` skips GetIterator entirely (`target.elements.length > 0` gate at `:2470`). `__iterator_return` (`iterator-native.ts:541`, body `:1589`-area) discards return()'s result — `*close-null*` tests need "inner result not an Object ⇒ TypeError" on normal-completion close. | `dstr/array-elem-iter-thrw-close.js`, `dstr/array-empty-iter-close.js`, `dstr/array-elem-iter-nrml-close-null.js` |
| A | completion value ≠ rval | 13 | `assignment.ts:2635`: pushes `tmpLocal` as the expression result, but `tmpLocal` was overwritten with the materialized vec at `:2484` — `result = [x] = vals` yields the internal vec, not `vals` (probe `probe1.js`: `result === iterable` false while nextCount/returnCount are already correct). Every `assert.sameValue(result, vals)` in the suite fails on this; these 13 fail on *only* this. | `dstr/array-elem-iter-nrml-close.js`, `dstr/array-elem-target-simple-no-strict.js`, `dstr/array-elision-iter-nrml-close-skip.js` |
| C | PutValue guards: const/TDZ/strict-unresolvable | 13 | Destructuring writes land via `emitResolvedIdentifierWriteFromStack` (`identifier-assignment.ts:35`) without the guards plain assignment has: assignment to `const` silently no-ops (probe `p-const.js`, spec: TypeError), write before `let` in scope skips TDZ (probe `p-tdz.js`, spec: ReferenceError; plain assignments use `emitModuleLexicalAssignmentTdzGuard`, `identifier-assignment.ts:23`), and strict-mode unresolvable throws a **null payload** — `emitStrictPutValueThrow` (`assignment.ts:1115`) emits `ref.null.extern; throw`, so tests see "Thrown value was not an object!" instead of a ReferenceError instance (probe `p-unres.js`). | `dstr/obj-id-put-const.js`, `dstr/obj-id-put-let.js`, `dstr/obj-id-put-unresolvable-strict.js` |
| E | NamedEvaluation (fn-name) | 9 | `function-instance-meta.ts:256` (`fnInstanceNameOf`): no arm for `ShorthandPropertyAssignment.objectAssignmentInitializer` (`{ x = function(){} } = {}` → name ""); `fnInstanceMetaOf` (`:320`) excludes `ClassExpression` entirely, so `cls = class {}` has `cls.name === undefined` (probe `p-fnname.js`: `fn=|cls=undefined|arrow=`). `fn-name-cover` additionally shows the comma form `(0, function(){})` getting named — verify the paren-only walk at `:284` isn't bypassed by a second naming source (checker-symbol fallback in `property-access-dispatch.ts:2876-2890`). | `dstr/obj-id-init-fn-name-fn.js`, `fn-name-class.js`, `dstr/array-elem-init-fn-name-class.js` |
| F | nested-pattern initializers dropped | 6 | Nested patterns recurse (`assignment.ts:2624` array path; object path `:1137`ff) but the recursion never applies defaults: `({ a: { x = 5 } } = { a: {} })`, `[ { y = 6 } ]`, `[ [ z = 7 ] ]` all leave the target `undefined` (probe `p-nested.js`). Top-level initializers work (`:1491` handles `objectAssignmentInitializer`); the nested entry points bypass that handling. | `dstr/obj-prop-nested-obj-yield-ident-valid.js`, `dstr/array-elem-nested-array-yield-ident-valid.js` |
| D | member/computed targets dropped | 6 | `emitAssignToTarget` (`assignment.ts:2735`): the ElementAccess arm (`:2790`) handles only wasm-vec receivers (`{length,data}` struct) and silently `return`s for externref/object receivers — `[ x[k] ] = [33]` drops the write while `[ y.prop ] = [44]` works (probe `p-elemtarget.js`; the PropertyAccess arm routes misses through `emitDynamicMemberSet` `:2664` since #2869 — the ElementAccess arm never got the same fix). Rest-to-member (`[...x[k]] = vals`) is dropped too: the rest branch (`:2519`) handles only `ts.isIdentifier(restTarget)`. Computed property *names* in object patterns (`{ [a.b]: x } = {}`) don't evaluate the key, so its TypeError never throws. | `dstr/array-elem-target-yield-valid.js`, `dstr/array-rest-yield-ident-valid.js`, `dstr/obj-prop-name-evaluation-error.js` |
| H | early-error false positives (parser) | 2 | `src/compiler/early-errors/node-checks.ts:1926`: the escaped-`let` check fires on every Identifier `let` containing `\u`, including property-name positions where `let` is a legal IdentifierName (`{ let: x } = { let: 42 }`); the `break`-escaped twin passes because only `let` has this blanket check. `node-checks.ts:1357`: duplicate `__proto__` early error applies to object *literals* but must not apply when the ObjectLiteral covers an ObjectAssignmentPattern (`({ __proto__: x, __proto__: y } = value)` is legal). | `dstr/ident-name-prop-name-literal-let-escaped.js`, `destructuring/obj-prop-__proto__dup.js` |

## Implementation Plan

Written 2026-08-28 against head `86739f05`. Re-run
`npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-assignment-current-fails.txt`
plus the spotcheck list after each step; error text shifts as clusters land, so
re-cluster rather than trusting the table's strings after step 2. All work is
Wasm-native — **no new host imports without a standalone fallback** (the runner
fails any test whose module emits host imports); host-mode (`src/runtime.ts`)
twins may need matching fidelity fixes to keep equivalence tests green.

**Step 0 — do NOT implement cluster G here.** The 26 generator-coupled tests
(`*rtrn-close*`, `*yield-expr*`, `array-iteration`, `array-rest-iteration`)
are #5141's scope (its native-generator admission-gate steps, tracking #680).
None of the steps below touch `generators-native*.ts`. After #5141 lands,
re-run the full list and fold G's survivors into a re-cluster.

**Step 1 — Cluster A (13, plus a hidden co-failure in ~every dstr test): keep
the original rval as the completion value.** One-local fix, do it first.
In `compileExternrefArrayDestructuringAssignment` (`assignment.ts:2439`), the
`__array_from_iter_n` result overwrites `tmpLocal` (`:2484`); the tail
(`:2635`) then pushes `tmpLocal` as "the RHS value". Allocate a separate
`__arr_destruct_mat_*` local for the materialized vec, keep `tmpLocal` holding
the original externref, and push `tmpLocal` at the tail. Audit the object path
(`compileDestructuringAssignment`, `:1137`) and the strict-throw early-outs for
the same invariant (they push `ref.null.extern` — fine, unreachable).
Accept: probe `probe1.js` reports `resultIsIterable=true`; the 13 A tests pass.

**Step 2 — Cluster B (23): per-element iterator drive + IteratorClose for
ArrayAssignmentPattern.** The big one. **Coordinate with #5144 Step 2** — it
builds the identical per-element drive for for-of heads
(`for-of-destructuring.ts:2055`) and pushes the §7.4.4/§7.4.9 refinements
*into the shared runtime* (`__iterator_next` result-must-be-Object TypeError,
`iterator-native.ts:516`; `__iterator_return` close-result validation,
`buildIteratorReturnBody` `iterator-native.ts:1589`). Whoever lands first
builds those runtime refinements once; the other consumes them. For this
issue's path, replace the eager materialization in
`compileExternrefArrayDestructuringAssignment` (`:2470-2486`) with:
- GetIterator once (`__iterator`), keep a `done` i32 local (IteratorRecord
  `[[done]]`).
- Per AssignmentElement in §13.15.5.5 order: (1) evaluate the target lref
  FIRST when the target is not a nested pattern — member/element targets
  evaluate receiver+key here (fixes the two `evaluation-order` tests and the
  `{}[thrower()]` shape); (2) IteratorStep via `__iterator_next` — a throw
  from next propagates WITHOUT close; (3) default check + PutValue; (4) any
  abrupt completion in (1)/(3), while `done` is false, runs IteratorClose with
  that throw completion (return()'s own result/errors swallowed on throw
  completions) and rethrows.
- After the last element, no rest: if `done` false → IteratorClose with
  NORMAL completion, which must validate: `return` absent/undefined ⇒ no-op,
  non-callable ⇒ TypeError, call result not an Object ⇒ TypeError (the
  `*close-null*` tests).
- Empty patterns `[] = iterable`: still GetIterator then immediately close —
  remove the `elements.length > 0` gate (fixes `array-empty-iter-close*`,
  `array-empty-iter-get-err`).
- Elisions consume an IteratorStep each; rest drains until done (rest path
  keeps its unbounded drain but through the same live record so close/abrupt
  rules apply — fixes `array-rest-lref*`, `array-rest-iter-thrw-close*`).
- Wasm pattern for close-on-abrupt: `try_table` with **empty blocktype** only
  (`1f 40`) — model callers `promise-executor.ts:192`, `calls.ts:152`. #5141
  cluster-B found the codebase's one result-typed `try_table` traps V8 12.4;
  do not add a second.
- Keep the wasm-vec/tuple fast paths (`:1962`ff) untouched for statically
  typed sources — the live drive is the externref/user-iterable lane only
  (byte-stability for the common case, same rule as #5144 Step 2).
- Prior art: `buildArrayFromIterNBody`'s bounded-stop close (#3100 S5,
  `iterator-native.ts:769`ff) shows the record/next/return call shapes; #1454
  is the host-mode ancestor of this exact bug class.
Accept: all 23 B tests pass; A tests still pass.

**Step 3 — Cluster C (13): PutValue guards on destructuring identifier
writes.** All in the write funnel, so array+object paths get fixed together:
- In `emitResolvedIdentifierWriteFromStack` (`identifier-assignment.ts:35`) —
  or a thin wrapper used by the destructuring call sites — add the same
  const/TDZ handling plain assignment has: reuse
  `emitModuleLexicalAssignmentTdzGuard` (`identifier-assignment.ts:23`) /
  `emitTdzCheck` (`statements/tdz.ts:61`) for `let` targets in their TDZ
  (mimic #1128's declaration-side work), and emit
  `emitThrowTypeError(ctx, fctx, "Assignment to constant variable.")`
  (`js-errors.ts:111`) when the resolved symbol's declaration is a `const`
  (use `ctx.oracle` / the declaration node — do NOT call the raw TS checker;
  oracle-ratchet gate #1930/#3273).
- Fix `emitStrictPutValueThrow` (`assignment.ts:1115`) to throw a real
  ReferenceError instance via `emitThrowReferenceError` (`js-errors.ts:119`)
  instead of `ref.null.extern` — fixes all four `*put-unresolvable-strict`
  ("Thrown value was not an object!") and the `p-unres.js` probe.
Accept: 13 C tests pass; `dstr/array-elem-put-unresolvable-no-strict.js`
(sloppy: global write succeeds) must NOT regress — it's in cluster A's list.

**Step 4 — Cluster E (9): NamedEvaluation in assignment positions.**
- `fnInstanceNameOf` (`function-instance-meta.ts:256`): add an arm for
  `ts.isShorthandPropertyAssignment(parent) && parent.objectAssignmentInitializer === node`
  → `parent.name.text` (the `{ x = function(){} } = {}` shape; array-element
  defaults `[x = fn]` already hit the BinaryExpression arm at `:300`).
- `fnInstanceMetaOf` (`:320`): admit `ClassExpression` — anonymous classes
  must carry `name` (+ correct descriptor: writable false, enumerable false,
  configurable true — the tests use `verifyProperty`). Follow #1119/#1049
  (the declaration-side SingleNameBinding fix,
  `property-access-dispatch.ts:2876-2890`) for where the name surfaces in the
  property model; class statics layout lives in `class-bodies.ts` — check how
  named class expressions publish `name` today and reuse that slot.
- `fn-name-cover`: `xCover = (0, function(){})` must stay UNnamed; if step
  probes show it named, find and gate the second naming source (checker-symbol
  contextual naming) with the same comma-vs-paren walk `fnInstanceNameOf` uses.
Accept: 9 E tests pass; probe `p-fnname.js` prints `fn=x|cls=c|arrow=a`.

**Step 5 — Cluster F (6): apply initializers in nested patterns.** Route the
nested-pattern recursion through the same default-check used at top level: the
array path's nested branch (`assignment.ts:2624`,
`emitObjectDestructureFromLocal` `:2840`ff) and the object path's nested
property handling must, for each leaf with an initializer, do the
`__extern_is_undefined`-guarded default emit exactly as `:1491-1530` does
(undefined fires the default, JS null does NOT). Standalone note:
`__extern_is_undefined`'s `ensureLateImport` has a native registration —
verify it resolves in standalone (the `:1508` comment warns the fallback
treats null as undefined; that fallback would break `null`-vs-`undefined`
tests). #4719 (in-review) touches the adjacent nested-array-undefined throw —
merge its branch first or rebase over it.
Accept: probe `p-nested.js` prints `x=5 y=6 z=7`; the 6 F tests pass.

**Step 6 — Cluster D (6): stop dropping member/computed targets.**
- `emitAssignToTarget` ElementAccess arm (`assignment.ts:2790`): when the
  receiver is not a wasm-vec struct, route through `emitDynamicMemberSet`
  (`:2664`) with the computed key — exactly what the PropertyAccess arm does
  since #2869 (its comment at `:2785` documents the silent-drop hazard this
  arm still has). Fixes `[ x[k] ] = [33]` (probe `p-elemtarget.js`).
- Rest branch (`:2519`): accept PropertyAccess/ElementAccess rest targets —
  drain into a fresh vec (existing `__extern_slice` shape), then assign via
  `emitAssignToTarget` instead of requiring an Identifier.
- Object-pattern computed property names (`{ [expr]: x } = v`): evaluate
  `expr` (its abrupt completion must propagate — `obj-prop-name-evaluation-error`
  expects the TypeError from `a.b` on undefined `a`) before the property read.
- The two `obj-literal-prop-ref-init(-active)` tests: property-access target
  with initializer — the lref (receiver+key) must be evaluated once, the
  getter NOT invoked, the setter invoked with the final value; make sure the
  step-2 lref-first ordering plus the default check compose here.
Accept: 6 D tests pass.

**Step 7 — Cluster H (2): early-error precision.**
- `node-checks.ts:1926` (escaped `let`): skip identifier-NAME positions —
  property names in PropertyAssignment/PropertyAccess/Method/PropertyDeclaration
  (reuse the `isPropertyName` predicate shape at `:1740`). `let` as a
  *binding/keyword* position must still error (spotcheck has
  `syntax-error-ident-ref-let-escaped.js`-family tests — do not over-relax).
- `node-checks.ts:1357` (duplicate `__proto__`): suppress when the
  ObjectLiteralExpression is a destructuring assignment pattern — LHS of `=`
  (walk parents through parens/nesting to a BinaryExpression EqualsToken LHS
  position or a for-of/for-in head; `src/compiler/early-errors/assignment.ts`
  already classifies pattern positions — reuse it).
Accept: both H tests pass; spotcheck escaped-keyword tests still pass.

**What NOT to do:**
- No new host imports without a standalone fallback (dual-mode rule; the
  standalone runner hard-fails on any `env::*` import — #2961 gate).
- Never edit `tests/test262-runner.ts`, skip lists, or `scripts/*baseline*.json`.
- Do not touch `generators-native*.ts` (that's #5141; avoids cross-PR
  conflicts and the #5060 regression zone).
- Do not "fix" cluster A by changing what `__array_from_iter_n` returns — its
  vec result shape is load-bearing for #5144/for-of and spread consumers.
- Do not regress the vec/tuple fast paths for typed sources — externref/user
  -iterable lane only for the new drive.
- Do not use result-typed `try_table` blocktypes (V8 12.4 trap, #5141 B).

## Acceptance criteria

- All tests in `.tmp/es2015/wp-assignment-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-assignment-current-fails.txt`
  — with the carve-out that the 26 cluster-G paths (the `*rtrn-close*` /
  `*yield-expr*` / `array-iteration` / `array-rest-iteration` families listed
  above) are gated on #5141; if #5141 has not merged, wave-1 is complete when
  the remaining 72 pass and cluster G's failures are unchanged-or-better.
- Every test in `.tmp/es2015/wp-assignment-passing-spotcheck.txt` still passes
  (baseline today: 40/40, verified on head `86739f05`).
- Ratchet gates pass (`node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, chained,
  plus the `LOC_GATE_BASE` CI-base simulation per CLAUDE.md).
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`).

## References

- **#5141** (`plan/issues/5141-es2015-standalone-generators-wave1.md`) — owns
  cluster G's root cause (generator admission gates, #680); its Step 1 also
  fixes the #5060 resume-trap.
- **#5144** (`plan/issues/5144-es2015-standalone-forof-wave1.md`) — sibling
  wave building the SAME per-element iterator drive + shared
  `__iterator_next`/`__iterator_return` refinements (its Step 2). Build the
  runtime refinements once between the two PRs.
- **#680** — native generator complex shapes (status: ready); cluster G's
  upstream tracking issue.
- **#1454, #1016, #1219, #1347** (done) — IteratorClose/error-propagation
  prior art on other destructuring paths.
- **#2904, #3100** (done) — `__array_from_iter_n` native drain + GetIterator
  dispatch this plan builds on.
- **#2869, #2664** (done) — dynamic member-set dispatcher; cluster D extends
  it to the ElementAccess arm.
- **#1119, #1049** (done) — SingleNameBinding/fn-name-cover NamedEvaluation
  prior art for cluster E.
- **#1128** (done) — destructuring TDZ prior art for cluster C.
- **#4719** (in-review) — nested array element undefined throw; step 5
  rebases over it.
- **#2961** (done) — standalone host-import leak gate that makes cluster
  fixes standalone-real.

## Results

Measured 2026-08-28 on this branch with
`npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-assignment-current-fails.txt`
(98 paths) and the 40-path spotcheck.

| | before | after |
|---|---|---|
| pass | 1 | 47 |
| fail | 84 | 39 |
| compile_error | 13 | 12 |
| spotcheck | 40/40 | 40/40 |

Note on the "before" numbers: the target list's own baseline reads 84 FAIL /
14 CE. On this box two of those FAILs were an environment miss (the quickjs
eval artifact was not reachable from a fresh worktree); after symlinking
`.test262-cache` the pre-change state is 84 FAIL / 13 CE / 1 PASS, which is
the baseline the table compares against.

### Fixed

- **Cluster A (completion value)** — the materialized vec now lands in its own
  `__arr_destruct_mat_*` local, so `result = [x] = vals` yields `vals`
  (`assignment.ts::compileExternrefArrayDestructuringAssignment`). An
  out-of-range element of a vec source also reads `undefined` instead of JS
  `null` (`emitBoundsCheckedArrayGet(..., ctx, true)`).
- **Cluster C (PutValue guards)** — `emitStrictPutValueThrow` throws a real
  ReferenceError instance; a new `emitPutValueTargetGuard`
  (`identifier-assignment.ts`) applies the TDZ-then-const checks on every
  destructuring identifier write, including rest targets and the
  "field absent, value is undefined" arm; TDZ *reads* throw a ReferenceError
  instance in the host-free lane.
- **Cluster D (member / computed targets)** — the ElementAccess arm of
  `emitAssignToTarget` routes a non-vec receiver through a new
  `emitDynamicElementSet` (`__extern_set_strict`) instead of silently dropping
  the write; an unresolvable computed property NAME is now evaluated for its
  effect, so `({ [a.b]: x } = {})` throws.
- **Cluster E (NamedEvaluation)** — `fnInstanceNameOf` gained the
  ShorthandPropertyAssignment initializer arm, and the `.name` fold no longer
  names a binding whose only assignments install a covered form
  (`x = (0, function(){})`).
- **Cluster F (nested patterns)** — nested array patterns accept member targets
  and initializers; nested OBJECT patterns over an externref source are
  destructured at all (new `emitExternrefObjectPatternWrites`) instead of
  stopping at the null guard; the array-like rest-object reader stopped folding
  a non-index key to element 0 and now honours defaults.
- **Cluster B (partial)** — the `elements.length > 0` gate is gone, so
  `[] = iterable` performs GetIterator and closes it
  (`array-empty-iter-close`, `-close-err`, `-get-err`).
- **Cluster H (partial)** — the duplicate-`__proto__` Early Error no longer
  fires when the ObjectLiteral covers an ObjectAssignmentPattern.

### Skipped — carried forward

- **Cluster G (12 CE + ~10 FAIL)** — generator-coupled, owned by #5141 as the
  plan's Step 0 says. Untouched.
- **Cluster B, the per-element iterator drive (~20)** — `*-thrw-close*`,
  `*-nrml-close-null*`, `array-rest-lref*`, the two `evaluation-order` tests.
  This is the plan's Step 2 and needs the lref-first / IteratorClose rewrite
  plus the shared §7.4.9 runtime refinements co-owned with #5144. One concrete
  blocker found while scoping it: the close-result "must be an Object"
  TypeError cannot be added inside `__iterator_return` alone, because the same
  helper serves BOTH normal-completion closes (validate ⇒ throw) and
  throw-completion closes (swallow); the completion kind has to reach it first.
- **The 4 class-`name` tests** (`fn-name-class`, `*-init-fn-name-class`) —
  `cls.name` already folds to `"cls"`, but the own-property DESCRIPTOR still
  reports the compiler's synthetic `__anonClass_cls_1`. Setting the
  NamedEvaluation name in `collectClassDeclaration` was verified to reach
  `classObjectNameMetadata` with the right `displayName` and still did not
  change the emitted descriptor, so a second, unidentified source publishes
  that value; the change was reverted rather than shipped unproven.
- **`obj-id-put-let` (1)** — a module-level `let x;` with NO initializer is not
  registered in `ctx.tdzGlobals`, so the write-side guard has no flag to test.
  Registering initializer-less lexicals is a broader change than this wave.
- **`obj-prop-elem-target-obj-literal-prop-ref-init{,-active}` (2)** — member
  target with an initializer over an object-literal receiver; needs the
  step-2 lref-first ordering to compose with the default check.
