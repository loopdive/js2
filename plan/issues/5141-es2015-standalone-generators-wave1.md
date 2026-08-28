---
id: 5141
title: "ES2015 standalone: generators conformance wave 1"
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
  - src/codegen/generators-native.ts
  - src/codegen/generators-native-consumer.ts
  - src/codegen/iterator-native.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/new-super.ts
  - src/compiler/early-errors/module-rules.ts
  - src/compiler/early-errors/node-checks.ts
  - src/compiler/early-errors/predicates.ts
  - src/ir/try-table.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
---

# #5141 — ES2015 standalone: generators conformance wave 1

## Problem

166 of the 186 ES2015-bucket "generators" work-package tests still fail on the
standalone target (re-verified on head `86739f05`, 2026-08-28; 20 of the
day-old baseline already pass). Worse, **head carries a live regression**:
PR #5060 (merge `8896b73f`, 2026-08-28 13:48 UTC) makes EVERY native-generator
first resume trap `RuntimeError: unreachable` on Node 22 — 25 of the 40
previously-passing spotcheck tests now fail (measured: spotcheck 15/40 pass on
head vs 40/40 at baseline). The remaining failures cluster into 10 root causes;
the top five cover 86% of the list. Generators are a load-bearing ES2015
feature (for-of, destructuring, iteration protocol all consume them), so this
package gates the 100% ES2015 standalone goal.

The `loc-budget-allow` grant above is deliberate growth allowance for this
change-set (yield* gate widening, generator object-model installs, brand
checks), rationale dated 2026-08-28 (this issue). The sibling class wave
(#5139) independently observed the same head regression via its own spotcheck.

Target list (regenerate after cluster B lands — see Plan step 0):
`.tmp/es2015/wp-generators-current-fails.txt` (166 paths).
Probe: `npx tsx .tmp/run-standalone.mts --list <file>` (split >150 lines).

## Current failure clusters

Counts from the 2026-08-28 head re-run (166 fails). Clusters ordered by yield.

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| B | resume-trap regression | 39 (+25 spotcheck collateral) | `src/codegen/generators-native.ts:4419-4438` (`ensureNativeGeneratorResumeFunction`): PR #5060's close-on-abrupt wrapper emits the codebase's only **result-typed** `try_table` (`1f 63 2d` — blocktype `(ref null $result)`); Node 22's V8 12.4 traps `unreachable` at that instruction on first execution (every other call site — `promise-executor.ts:192`, `calls.ts:152`, statement try/catch — uses empty blocktype `1f 40` and works). Verified by bisect (good `5fe8ddbb`, bad `8896b73f`) and by reverting the single hunk at head → repro passes. CI's newer Node runs it fine, which is why the merge_group stayed green. | `language/expressions/generators/yield-as-statement.js`, `language/statements/generators/no-yield.js`, `built-ins/GeneratorPrototype/next/return-yield-expr.js` |
| A1 | `yield*` delegation rejected (#680 CE) | 38 | `src/codegen/generators-native.ts:838-960` — delegation admits only: direct native-gen call (#2170), numeric vec (#2173-2a), type-visible generic iterable (#2173-2b). `isGenericIterableDelegate` (line 1052) requires the TS type to expose `__@iterator`, so sloppy-JS hand-rolled iterator objects (`obj[Symbol.iterator] = fn`) bail; `yield*` inside a non-replay try-region hard-bails (line 843, #3050). | `language/expressions/yield/star-iterable.js`, `star-rhs-iter-thrw-thrw-call-non-obj.js`, `star-rhs-iter-rtrn-res-value-final.js` |
| F2 | GeneratorFunction intrinsic | 17 | No `%GeneratorFunction%` object model: `constructor`/`name`/`length`/`prototype` descriptors, `Symbol.toStringTag`, `has-instance` all missing. Prototype-chain singletons exist in `src/codegen/array-object-proto.ts:2884` (`__native_generator_function_prototype`) but the constructor-function object and its descriptors are not installed. 5 of the 17 (`invoked-as-function-*`, `instance-yield-expr-in-param`) need **dynamic function creation from strings** — eval-class, defer. | `built-ins/GeneratorFunction/name.js`, `prototype/Symbol.toStringTag.js`, `instance-length.js` |
| F1 | generator fn object model | 16 | No per-generator-function own `.prototype` data property: instances don't get `[[Prototype]]` from `g.prototype`, `g1.prototype === g2.prototype` (should differ), `typeof g.prototype === "undefined"`, `instanceof` fails. `.prototype` reads route through the shared intrinsic (`src/codegen/property-access-dispatch.ts:1958,2084`) instead of a per-function slot. | `language/statements/generators/prototype-uniqueness.js`, `language/expressions/generators/has-instance.js`, `default-proto.js` |
| A3 | misc shape rejects (#680 CE) | 12 | Candidacy/plan gates (`isNativeGeneratorCandidate` line 2241, `buildNativeGeneratorPlan` line 440): non-numeric/non-string yield operands (regexp, template-middle, primitives via boxed-any carrier gaps in `generatorElemValType` line 379), rest params, `yield` in relational expr. | `language/expressions/yield/rhs-regexp.js`, `rhs-template-middle.js`, `in-rltn-expr.js` |
| C | dstr runtime failures | 11 | Pattern-param destructuring inside generators: `Cannot destructure 'null' or 'undefined'` for `[[] = init]`-style params (frame rehydration drops the argument — #3386 residual class); 4 `iter-get-err-array-prototype` tests need GetIterator failure → TypeError before body entry. | `language/statements/generators/dstr/ary-ptrn-elem-ary-empty-init.js`, `dstr/ary-init-iter-get-err-array-prototype.js` |
| A2 | dstr-param rejects (#680 CE) | 8 | Same admission gate as A1/A3: destructuring param shapes not admitted by the fn-expr/param-shape gates in `isNativeGeneratorCandidate`. | `language/expressions/generators/dstr/ary-ptrn-elem-id-init-fn-name-gen.js` |
| D | `yield`-identifier early error | 8 | `src/compiler/early-errors/module-rules.ts:204-223`: the upward walk looking for an enclosing generator **does not stop at non-generator function boundaries**, so `yield` as an identifier inside an ordinary function nested in a generator (legal, [~Yield] resets) is rejected; sloppy top-level `var yield` also errors when the source is treated as module/strict. The `await` rule directly below (line 228+) already walks correctly — mirror it. | `language/expressions/generators/yield-as-identifier-in-nested-function.js`, `yield-identifier-non-strict.js` |
| G | fn-name binding semantics | 5 | Named generator expression's name binding: strict-mode reassignment must throw TypeError, sloppy must be immutable-silent (#2037/#1049 class of fix, applied to generator expressions). | `named-strict-error-reassign-fn-name-in-body.js`, `scope-name-var-open-strict.js` |
| F3 | GeneratorPrototype brand/ctor | 5 | `next`/`throw`/`return` must be non-constructors (`new gen.next` → TypeError), `%GeneratorPrototype%.constructor` descriptor; brand-check work overlaps in-flight #1344. | `built-ins/GeneratorPrototype/next/not-a-constructor.js`, `constructor.js` |
| E | invalid-Wasm CE | 3 | Rest-param generators emit `__call_fn_*` with wrong call_ref arity; `statements/.../yield-star-before-newline.js` hits a `local.tee` type mismatch in `__gen_resume_g`. | `language/expressions/generators/scope-param-rest-elem-var-open.js` |
| H | env: quickjs eval provider not built | 4 | Not a compiler bug: `JS2WASM_EVAL_ENGINE=quickjs` but `.test262-cache/quickjs-artifact-*` missing in this container. Excluded from acceptance. | `built-ins/GeneratorFunction/proto-from-ctor-realm.js` |

## Implementation Plan

Ordered so partial completion maximizes yield. Steps 1 is a REGRESSION fix and
must land first (alone if necessary — it un-breaks ~25+ currently-regressed
tests beyond this package's 39).

**Step 0 — after each cluster lands, re-run the probe over
`.tmp/es2015/wp-generators-current-fails.txt` and re-cluster.** Cluster B masks
downstream errors (e.g. the three `from-state-executing` tests currently trap
in B but will still need the §27.5.3 "executing"-state TypeError afterwards).
Regenerate the list; do not trust this table's error text after step 1.

**Step 1 — Cluster B (39 + spotcheck collateral): reshape the #5060 close-on-abrupt wrapper.**
- File: `src/codegen/generators-native.ts`, `ensureNativeGeneratorResumeFunction`,
  the `if (ctx.standalone || ctx.wasi)` branch at ~4419.
- Keep #5060's intent (§27.5.3.4: an unhandled body exception must set
  `STATE_FIELD` to `doneState` before propagating — see
  `plan/issues/4768-generator-argument-eagerly-drained-at-call-boundary.md`),
  but do NOT emit a result-typed `try_table`. Re-emit with the empty-blocktype
  shape every other standalone EH site uses (model:
  `src/codegen/promise-executor.ts:192`, `src/codegen/expressions/calls.ts:152`,
  both `buildStandardTryTable({kind:"empty"}, …)`): route the normal-path
  result through `resultLocal` and a `br` past the handler, e.g.
  `block $out(result R) { block $h(payload externref) { try_table (catch $exc $h) { <trampoline>; } br $out (local.get resultLocal) } <setState done>; throw $exc }`
  — the trampoline already `local.set`s `resultLocal`, so no blocktype is
  needed on the try_table itself. `buildStandardTryTable` bumps escaping
  branch depths for you; verify with the repro below, not by eye.
- Alternative (equally acceptable): drop the wrapper and set `doneState`
  inside the existing explicit throw paths + the exnref rethrow seam, if all
  abrupt exits are enumerable.
- Repro (must go from RUN_TRAP to RUN_OK on Node 22):
  compile `function *foo() { yield 1; } var g = foo(); g.next();` with
  `target: "standalone"`, instantiate with `{}`, call `_start`. Then run the
  40-line `.tmp/es2015/wp-generators-passing-spotcheck.txt` — all 40 must pass
  (today: 15). Also keep the #5060 win: `tests/issue-4768-generator-call-boundary.test.ts`
  must stay green.
- Why it trapped: the wrapper is the only result-typed `try_table` the emitter
  produces; V8 12.4 (Node 22, `package.json` engines `>=20`) executes it as
  `unreachable`. CI's Node is newer, so the merge_group missed it — add a
  scoped vitest (equivalence or issue test) exercising a standalone generator
  resume so the local lane catches any recurrence.

**Step 2 — Cluster A1 (38): widen `yield*` delegation.**
- File: `src/codegen/generators-native.ts` lines 838-960 + the drivers in
  `generators-native-consumer.ts` / `iterator-native.ts`.
- 2a. Replace the type-driven `isGenericIterableDelegate` (line 1052 — note it
  is pre-oracle `ctx.checker` code; NEW code must go through `ctx.oracle`,
  #1930/#3273) with an admit-by-default runtime `GetIterator` path: lower
  `yield* <expr>` to the native `__iterator`/`__iterator_next` runtime
  (#2038) with a runtime TypeError when the operand is not iterable. Follow
  the existing slice-2b emit (search `delegationKind: "iterable"`) — the
  runtime driver already exists; the gate is the blocker.
- 2b. Delegation protocol completeness (the `star-rhs-iter-*` family):
  forward `.throw()`/`.return()` into the delegate per §27.5.3.7 —
  `GetMethod(iterator, "throw"/"return")`, TypeError on non-object inner
  results, `done`-value passthrough. #1691 (in_progress) owns part of this;
  check its branch before implementing, reference rather than duplicate.
- 2c. `yield*` inside try-regions (line 843 hard bail): keep bailing in this
  wave if 2a/2b land without it — but the bail must remain the clean #680
  diagnostic, never silent wrong codegen. Cite #3050.
- Blocked sibling #3711 (yield-star delegation illegal cast) documents a known
  cast pitfall in the consumer — read it before touching the driver.

**Step 3 — Clusters F1+F2+F3 (38, minus 5 deferred): generator object model.**
- 3a. Per-function `.prototype` (F1): give every generator function object an
  own writable, non-enumerable, non-configurable `.prototype` data slot
  initialized to a fresh object whose `[[Prototype]]` is
  `%GeneratorPrototype%`; the factory must stamp instances with it, and
  `instanceof` must honor it. Emit sites: `src/codegen/array-object-proto.ts`
  (~2767-2960, the `__native_generator_prototype_obj` /
  `__native_generator_function_prototype` singletons) and
  `src/codegen/property-access-dispatch.ts:1958,2084` (`.prototype` reads —
  currently return the shared intrinsic). #3236 (ready, sprint current) owns
  retiring the host-import twins of these singletons — coordinate: this issue
  needs the per-function slot; #3236 needs the intrinsic chain host-free. Do
  not double-claim; if #3236 is picked up first, build on its branch
  (predecessor-stacking per CLAUDE.md).
- 3b. `%GeneratorFunction%` descriptors (F2, 12 of 17): install the
  constructor object with `name: "GeneratorFunction"`, `length: 1`,
  `prototype` → `%GeneratorFunction.prototype%` (non-writable per test
  `prototype/constructor.js`), `Symbol.toStringTag: "GeneratorFunction"`
  (configurable), extensibility, `has-instance` via the prototype chain.
- 3c. Non-constructor + restricted properties (F1/F3): `new g()` and
  `new gen.next` must throw TypeError; `g.caller`/`g.arguments` must be
  poisoned accessors. Brand checks on `next`/`throw`/`return` receivers
  overlap #1344 (in-progress) — check its state first.
- DEFER (state in the PR, do not attempt): dynamic
  `GeneratorFunction(...)` invocation tests (5: `invoked-as-function-*`,
  `invoked-as-constructor-no-arguments`, `instance-yield-expr-in-param`) —
  they require compiling function bodies from strings at runtime (eval-class,
  #1102/#1261 territory).

**Step 4 — Clusters A2+A3 (20): admission-gate widening.**
- Instrument first: add a temporary `.tmp/` probe that logs WHICH gate in
  `isNativeGeneratorCandidate` (line 2241) / `buildNativeGeneratorPlan`
  (line 440) refuses each A2/A3 test — the #680 message is one string for
  many gates; do not guess.
- Expected buckets: boxed-any carrier not selected for regexp/template/
  primitive yield operands (`generatorElemValType` line 379 — the #2864
  externref carrier exists, extend its admission); destructuring params
  (A2 — combine with cluster C's rehydration fix, #3386's pattern-param seam);
  rest params (also cluster E's `__call_fn_*` arity bug — fix the arity, then
  admit).

**Step 5 — Cluster D (8): scope the `yield`-identifier early error.**
- File: `src/compiler/early-errors/module-rules.ts:204-223`. Stop the
  enclosing-generator walk at the first non-arrow function boundary (a nested
  ordinary function/expression resets [Yield]; the fn-expr's own
  binding-identifier position follows the inner context). The `await` rule at
  line 228+ in the same file already implements the correct
  walk-to-function-boundary pattern — mirror it. Confirm the sloppy
  script-goal path (`yield-identifier-non-strict.js`) reaches this rule with
  `sourceFileIsModule === false`; if not, the bug is in the runner's
  script/module goal selection — fix the early-error rule's input, NOT the
  runner.

**Step 6 — Clusters C, G, E (19) — as capacity allows.**
- C: pattern-param rehydration into the frame (`storeSpills`/#3386 seam in
  `generators-native.ts`; the `(#3386)` comment near the frame constructor
  marks the spot) + GetIterator-failure TypeError for the `iter-get-err`
  quartet (belongs with step 2a's runtime GetIterator).
- G: generator-expression name binding immutability/TypeError — same
  mechanism as #2037/#1049 (fn-name destructuring defaults), applied to
  generator expressions.
- E: `__call_fn_0/1` call_ref arity for rest-param generators (compare
  against a working non-generator rest-param lowering); `local.tee` type
  mismatch on `statements/generators/yield-star-before-newline.js`.

**What NOT to do:**
- No new host imports without a standalone fallback (dual-mode rule); the
  runner fails any module emitting `env::*` imports in standalone.
- Never edit `tests/test262-runner.ts`, skip lists, or
  `scripts/*baseline*.json` to make tests "pass".
- New type queries go through `ctx.oracle` (`src/checker/oracle.ts`), never
  raw `ctx.checker.*` (oracle-ratchet gate).
- Do not `--no-verify`; run the ratchet gates chained before every commit
  (CLAUDE.md "Hooks and ratchet gates").
- Do not re-implement what #1691 (yield* throw/return), #1344 (receiver
  brand checks), or #3236 (intrinsic chain) already have in flight — check
  their claims (`node scripts/claim-issue.mjs --check <id>`) before starting
  those slices.

## Acceptance criteria

- All tests in `.tmp/es2015/wp-generators-current-fails.txt` (166 paths) pass
  via `npx tsx .tmp/run-standalone.mts --list …`, EXCEPT the explicitly
  deferred set: 4 quickjs-env tests (H — environment, pass wherever the
  quickjs eval artifact is built) and 5 dynamic-GeneratorFunction tests
  (step 3 DEFER list). Partial waves are mergeable per-cluster; each PR
  states its cluster and measured delta.
- Every test in `.tmp/es2015/wp-generators-passing-spotcheck.txt` passes
  (40/40 — today 15/40 due to cluster B; this criterion is the regression
  guard and step 1 alone must restore it).
- Source-ratchet gates pass (`check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`),
  including against CI's merge-preview base (`LOC_GATE_BASE`).
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`), and
  `tests/issue-4768-generator-call-boundary.test.ts` stays green after the
  step-1 reshape.

## Results (wave 1, 2026-08-28)

Measured on this branch's base (`7e2d98bd`) with
`npx tsx .tmp/run-standalone.mts --list …`, Node 22.22.2.

| List | Before | After |
|------|--------|-------|
| `wp-generators-current-fails.txt` (166) | 0 pass / 166 fail | **8 pass** / 158 fail |
| `wp-generators-passing-spotcheck.txt` (40) | 15 pass / 25 fail | **39 pass** / 1 fail |

The spotcheck's remaining failure is `yield-weak-binding.js`, a **negative
parse** test that times out at compile in this container **identically with and
without this change** (verified by reverting `src/compiler/early-errors/` and
re-running the single file) — a missing early error plus a slow-compile
artifact, not a regression here.

The headline number is the spotcheck: cluster B was a live head regression that
broke EVERY native-generator first resume on Node 22, well beyond this package.
Its yield inside the 166-file list is small (+2) because those tests have
independent second failures, exactly as Plan step 0 predicted.

### Clusters fixed

- **B — resume-trap regression (+2 in list, +24 in spotcheck).**
  `ensureNativeGeneratorResumeFunction` no longer emits a **result-typed**
  `try_table` (V8 12.4 runs `try_table (ref null $result)` as `unreachable`).
  The trampoline keeps its value-producing shape inside a plain
  `block (result R)`, spills to `resultLocal`, and the empty-blocktype try
  scaffold — the shape every other standalone EH site uses — wraps that.
  Branch depths inside the trampoline are unchanged relative to the new inner
  block. #5060's §27.5.3.4 close-on-abrupt intent is preserved;
  `tests/issue-4768-generator-call-boundary.test.ts` stays 12/12 green.
- **D — `yield`-identifier early error (+4).** New
  `isInYieldParamContext` (`predicates.ts`) replaces both the
  `module-rules.ts` walk and the `node-checks.ts` `isInsideGeneratorFunction`
  call for the `yield`-as-identifier rule. It stops at the first non-arrow
  function boundary (a nested ordinary function resets `[Yield]`) and treats a
  function's own BindingIdentifier correctly: a FunctionExpression name is
  always `[~Yield]`, a FunctionDeclaration name inherits the enclosing context.
- **§27.3.4 non-constructor generators (+2).** `new g()` on a generator
  function — literal `function*(){}`, a name in `ctx.generatorFunctions`, or an
  identifier whose oracle-resolved variable initializer is a generator function
  expression — now throws TypeError instead of silently constructing.

### Clusters skipped (with the reason, for wave 2)

- **A1 `yield*` delegation (38).** Widening `isGenericIterableDelegate` to
  admit-by-default was tried and REVERTED: it converts 8 CEs into wrong-answer
  FAILs and leaves 30 CEs untouched, because (a) most of the `star-rhs-iter-*`
  family puts `yield*` inside a try-region, which still hits the #3050 hard bail
  at line ~843, and (b) the existing iterable driver **rebuilds** the result as
  `{value, done:0}` instead of re-yielding the delegate's own result object, so
  `star-iterable.js` sees `done === false` where the spec requires the inner
  object's `done === undefined`. Wave 2 must fix the driver's result passthrough
  and the throw/return forwarding BEFORE touching the gate. Silent wrong codegen
  is worse than the clean #680 refusal.
- **F1/F2/F3 generator object model (~38).** Needs a per-function `.prototype`
  slot and a real `%GeneratorFunction%` object; `.prototype` reads currently
  return the shared `%GeneratorPrototype%` intrinsic. Note for wave 2:
  `Object.getPrototypeOf(function*(){}).constructor` already resolves today, so
  the work is descriptor/identity correctness, not a from-scratch install.
- **G — fn-name binding semantics (5).** NOT generator-specific: the plain
  `language/expressions/function/named-strict-error-reassign-fn-name-in-body.js`
  and `scope-name-var-open-strict.js` fail identically. Fix belongs with
  #2037/#1049 for all named function expressions.
- **C — dstr `[[] = init]` param rehydration (5)** and **E — rest-param
  `__call_fn_*` arity (3)**: generator-specific (`function/dstr/ary-ptrn-elem-
  ary-empty-init.js` passes), but inside the #3386 frame seam; not attempted.
- **H — quickjs env (4)** and the 5 dynamic-`GeneratorFunction` tests: excluded
  by the acceptance criteria.

Gates run bare and green: `check-loc-budget`, `check-func-budget`,
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`. The
`loc-budget-allow` / `func-budget-allow` lists above were extended for the
actual touched paths. Scoped vitest: all generator equivalence/issue suites
green (73 tests). `tests/issue-3632-eval-early-errors.test.ts` has 2 failures
that reproduce identically on clean HEAD (runtime-eval provider, pre-existing).

## References

- **#4768** (in-progress) — the issue PR #5060 was fixing; step 1 reshapes
  that fix. Audit trail: PR #5057 (`codex/audit-5044-regressions`).
- **#680 / #1665 / #2079 / #2571 / #2864 / #3050 / #3271 / #3386** — native
  generator state-machine lineage (candidacy, carriers, try-regions,
  pattern params).
- **#2170 / #2173 / #1691 (in_progress) / #3711 (blocked)** — `yield*`
  delegation slices; step 2 extends them.
- **#3236 (ready) / #1344 (in-progress) / #1516 / #1639 / #820j (done)** —
  generator prototype intrinsic chain, receiver brand checks, descriptors.
- **#2037 / #1049** — fn-name binding semantics pattern for cluster G.
- **#2961** — standalone host-import leak scan (the baseline's
  `host_import_leak` cluster; already resolved on head — 0 such errors in the
  current run).
- **#5139** — sibling class wave 1; independently flagged the cluster-B head
  regression.
