# What stands behind the IR selector (2026-11-13)

The ES5 census records only the **first** selector refusal of each legacy
unit. Planning from those labels has repeatedly overstated what a lever frees:

- the IIFE label is the sole blocker on 179 files, but its stub measured about 20 gains;
- `propertyHelper.js` was credited with 631 files, but its own blockers alone free 12, or 229 with #7338/#7339 (#7342 S0).

This measurement forces the selector to admit what it refused and records
where each unit then really ends:

- it **builds** (the refusal was an over-refusal);
- it fails in **from-ast or later** after the claim (a real missing lowering);
- it **crashes the compile** (an invariant the refusal protected);
- it **stays refused**, by a check the stub does not force.

## Population and sample

- **Source:** census `es5-map-1111/per-file.jsonl`, main `7ce9bc8fbf`. 9,174 rows; 7,086 compile and are blocked (not IR-only).
- **Excluded:** 554 blocked files that carry a dynamic-code label: `external-call(eval)`, `expr-global-eval-statement`, `expr-ident-not-in-scope(eval)`, `with-*`, `external-call(Function)`. Population: **6,532**.
- **Sample:** **600 files**, seeded shuffle (mulberry32, seed 7343).
  - No top-level directory pair may exceed 25 % of the sample. `built-ins/Object` hit the cap at 150.
  - Next largest: `language/expressions` 110, `annexB/language` 62, `built-ins/String` 58, `built-ins/Function` 42, `language/statements` 41.
- **Measured on:** main `84ed5e6e5f`, `--target standalone`, original harness.
  - Settings: `JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`.
  - Tool: the #7338 census script, extended with `WebAssembly.validate`.
  - Of the 600, **8** are already IR-only on this main.

## Method: what the permissive stub did

A local, uncommitted, env-gated stub (`JS2WASM_S0_PERMISSIVE=1`) in
`src/ir/select.ts` and `src/ir/select-identity.ts`:

1. `shapeNo` (and so `capabilityNo`) returns `true` instead of `false`. It still records its label, first-wins. Every instrumented refusal arm in the Phase-1 shape walk therefore admits its subtree.
2. The dynamic-use scan's verdict is ignored, so `dynamicUsesAreMoveOnly` failing no longer returns `param-type-not-resolvable`.
3. `resolveParamType` and `resolveReturnType` answer `dynamic` where they answered `null`. This covers `param-type-unresolved`, the `param-dynamic-carrier-diverges-from-legacy` decline and `return-type-unresolved`.
4. External-call and `call-graph-closure` demotion is skipped in both selectors, including `<module-init>`'s gate 2.

Not forced, so a unit refused by them stays legacy ("not forced" below):

- selector arms that return a reason without `shapeNo` (`async-function`, `param-shape-rejected`, destructuring patterns, and so on);
- the runtime-eval late-preparation boundary (`late-preparation-unsupported`);
- the build-stage parity checks: a forced unit can still be withdrawn post-claim (`function typeIdx parity mismatch … keeping legacy body`).

### What this cannot tell

- **Forcing interacts.** A forced unit can break a later unit, and a crash hides every other unit of the file. 120 of 600 files crash; the other units of those files are unmeasured.
- **An `[IR-FALLBACK]` crash means an invariant fired, not that a lowering is missing.** The largest class, 81 files, is `module-init: declaration '·' no longer resolves to the direct top-level binding selected for this unit`. That is the module-binding plan disagreeing with a forced claim: it measures the stub, not the product. It is listed separately (Table B2), not as a work item.
- **"Built" means the unit compiled and the module validated** (no module failed validation). Verdict correctness was checked only for the files that became fully IR-only (Table C).
- **The census sees each unit's first error only.** A unit that fails at one from-ast site may fail again at the next once that is fixed. The same caveat as #7342 S0: one layer deeper than the selector label, not the full chain.
- **The census is two days older than the measured main.** Labels in Table A are re-measured on `84ed5e6e5f`, not taken from the census file.

## Results

Units in the 600 baseline files that were legacy: **1,443**. Under the permissive selector:

| outcome | units |
| --- | --- |
| built | 119 (8 %) |
| post-claim error (from-ast / build) | 630 (44 %) |
| compile crash (an `[IR-FALLBACK]` invariant), owning unit | 120 (8 %) |
| unmeasured (another unit of the file crashed) | 8 |
| not forced (still refused) | 566 (39 %) |

### Table A: per original first-refusal label (top 40 by units)

"built", "post-claim", "crash" and "not forced" are unit counts. The last column gives the three most common outcomes for the units that did not build. Error messages are normalised: identifiers become `·`, numbers become `N`; an identifier that is "not in scope" is kept as `‹name›`.

| first-refusal label | units | built | post-claim | crash | not forced | top classes |
| --- | --- | --- | --- | --- | --- | --- |
| `expr-ident-not-in-scope` | 259 | 0 | 111 | 3 | 145 | not forced: late-preparation-unsupported (108); not forced: body-shape-rejected (37); from-ast: identifier ‹Object› is not in scope (35) |
| `param-dynamic-carrier-diverges-from-legacy` | 148 | 0 | 137 | 0 | 11 | from-ast: proven dynamic binding '·' initializer has no supported carrier (48); from-ast: identifier ‹verifyPrimordialCallableProperty› is not in scope (48); function typeIdx parity mismatch: IR=N, legacy=N — keeping legacy body (41) |
| `expr-new-ctor-unknown` | 87 | 0 | 39 | 11 | 37 | not forced: late-preparation-unsupported (36); from-ast: proven dynamic binding '·' initializer has no supported carrier (19); crash: module-init: declaration '·' no longer resolves to the direct top-level binding selected for this unit [IR-FALLBACK] (11) |
| `expr-logical-value-family` | 82 | 0 | 51 | 0 | 31 | from-ast: identifier ‹verifyProperty› is not in scope (48); not forced: late-preparation-unsupported (31); from-ast: operator '·' requires bool operands (1) |
| `vardecl-module-storage-unrepresentable` | 67 | 0 | 0 | 64 | 3 | crash: module-init: declaration '·' no longer resolves to the direct top-level binding selected for this unit [IR-FALLBACK] (60); (file crashed in another unit) (4); not forced: body-shape-rejected (2) |
| `formatIdentityFreeValue rejected by IR selection (external-call)` | 64 | 36 | 0 | 0 | 28 | not forced: late-preparation-unsupported (28) |
| `formatSimpleValue rejected by IR selection (external-call)` | 64 | 36 | 0 | 0 | 28 | not forced: late-preparation-unsupported (28) |
| `expr-binary-operand-families` | 58 | 0 | 56 | 0 | 2 | from-ast: empty array '·' escapes before its element type is closed (48); from-ast: closure must have a return type annotation (6); not forced: late-preparation-unsupported (2) |
| `the source observes a current function's legacy caller activation` | 58 | 0 | 0 | 0 | 58 | not forced: late-preparation-unsupported (58) |
| `param-type-unresolved(·)` | 48 | 0 | 48 | 0 | 0 | unsupported TypeNode kind JSDocTypeLiteral (48) |
| `expr-object-define-property-target` | 38 | 1 | 11 | 26 | 0 | crash: from-ast: Object.defineProperty is not a certified open-carrier define [IR-FALLBACK] (21); crash: from-ast: internal capability violation — binary operator '·' is capability-deferred (see src/ir/capability.ts) yet reached the builder post (4); from-ast: module-init unit contains a nested var declaration (3) |
| `vardecl-let-closure` | 38 | 0 | 15 | 1 | 22 | not forced: late-preparation-unsupported (21); from-ast: module-level closure binding '·' not in module-init Slice N scope (12); crash: module-init: declaration '·' no longer resolves to the direct top-level binding selected for this unit [IR-FALLBACK] (1) |
| `the linked runtime-eval callable carrier is still owned by the direct frontend (eval-visible-binding)` | 35 | 0 | 0 | 0 | 35 | not forced: late-preparation-unsupported (35) |
| `expr-call-callee-nonident` | 28 | 0 | 17 | 0 | 11 | from-ast: only direct calls supported in Phase N (15); not forced: body-shape-rejected (7); not forced: late-preparation-unsupported (4) |
| `return-type-unresolved(lattice=dynamic)` | 28 | 0 | 0 | 0 | 28 | not forced: late-preparation-unsupported (28) |
| `body-exprstmt-other(expr-call-callee-nonident)` | 26 | 0 | 12 | 0 | 14 | not forced: late-preparation-unsupported (14); from-ast: only direct calls supported in Phase N (12) |
| `move-only[dyn]` | 24 | 24 | 0 | 0 | 0 |  |
| `vardecl-module-binding-alias` | 22 | 0 | 0 | 0 | 22 | not forced: late-preparation-unsupported (22) |
| `unattributed-arm:helper-internal` | 18 | 0 | 0 | 4 | 14 | not forced: body-shape-rejected (14); (file crashed in another unit) (4) |
| `closure-return-type` | 13 | 0 | 7 | 0 | 6 | not forced: late-preparation-unsupported (6); from-ast: direct call to "·" has no exact AST-site plan__closure_4 (3); from-ast: closure params must have annotations (2) |
| `compound-dynamic-module-operand` | 12 | 0 | 12 | 0 | 0 | from-ast: compound assign RHS has no numeric carrier (got string) (7); from-ast: compound assign RHS has no numeric carrier (got i32) (3); from-ast: direct call to "·" has no exact AST-site plan (2) |
| `move-only[stmt]` | 10 | 0 | 0 | 0 | 10 | not forced: late-preparation-unsupported (10) |
| `body-exprstmt-other(expr-ident-not-in-scope)` | 10 | 1 | 9 | 0 | 0 | from-ast: identifier ‹y› is not in scope (5); from-ast: identifier ‹x› is not in scope (4) |
| `objectlit-ordinary-to-primitive-method` | 9 | 0 | 9 | 0 | 0 | from-ast: closure must have a return type annotation (9) |
| `vardecl-init-expr` | 9 | 0 | 8 | 1 | 0 | from-ast: '·' reference outside an instance method body (6); from-ast: direct call to "·" has no exact AST-site plan__closure_4 (1); from-ast: compound assign to undeclared identifier "·" (1) |
| `expr-module-extern-consumer` | 9 | 5 | 3 | 1 | 0 | crash: module-init: declaration '·' no longer resolves to the direct top-level binding selected for this unit [IR-FALLBACK] (1); from-ast: bare '·' in non-reference context (f64) is not supported (1); from-ast: method call .match(...) on string not in slice N (1) |
| `expr-regexp-literal` | 9 | 0 | 5 | 4 | 0 | from-ast: proven dynamic binding '·' initializer has no supported carrier (5); crash: from-ast: internal capability violation — extern property read .source is capability-deferred (see src/ir/capability.ts) yet reached the bui (2); crash: module-init: declaration '·' no longer resolves to the direct top-level binding selected for this unit [IR-FALLBACK] (2) |
| `the linked runtime-eval callable carrier is still owned by the direct frontend (boundary-closure)` | 7 | 0 | 0 | 0 | 7 | not forced: late-preparation-unsupported (7) |
| `unattributed-arm` | 7 | 0 | 0 | 0 | 7 | not forced: body-shape-rejected (7) |
| `expr-new-regexp-target` | 7 | 0 | 6 | 0 | 1 | from-ast: proven dynamic binding '·' initializer has no supported carrier (4); from-ast: '·' operands not provably both-number or string-concatenable (string/unprovable) — the unboxed numeric-add / string-concat fast pa (2); not forced: late-preparation-unsupported (1) |
| `<module-init> rejected by IR selection (call-graph-closure)` | 7 | 5 | 2 | 0 | 0 | from-ast: direct call to "·" has no exact AST-site plan__closure_4 (1); from-ast: direct call to "·" has no exact AST-site plan (1) |
| `objectlit-empty` | 6 | 1 | 3 | 0 | 2 | from-ast: proven dynamic binding '·' initializer has no supported carrier (2); not forced: body-shape-rejected (2); from-ast: String() of object{} operand is deferred (1) |
| `expr-function-invocation-method` | 6 | 0 | 5 | 0 | 1 | from-ast: identifier ‹f› is not in scope (3); not forced: function-invocation-method-unsupported (1); from-ast: identifier ‹foo› is not in scope (1) |
| `body-unhandled-stmt` | 5 | 0 | 5 | 0 | 0 | from-ast: unsupported body statement FunctionDeclaration (3); from-ast: unsupported body statement EmptyStatement (2) |
| `move-only[concrete]` | 4 | 2 | 2 | 0 | 0 | from-ast: arg N of call to __consolePrintHandle__ is dynamic, expected string (2) |
| `objectlit-property-kind` | 4 | 0 | 4 | 0 | 0 | from-ast: direct call to "·" has no exact AST-site plan__closure_4 (2); value requires one non-constructible callable signature or a supported primitive (1); ambiguous or unsupported value type (1) |
| `f rejected by IR selection (call-graph-closure)` | 4 | 0 | 3 | 0 | 1 | from-ast: direct call to "·" has no exact AST-site plan (3); not forced: late-preparation-unsupported (1) |
| `expr-wrapper-equality` | 4 | 0 | 0 | 4 | 0 | crash: from-ast: fresh-wrapper identity [IR-FALLBACK] (4) |
| `body-if-cond` | 4 | 0 | 4 | 0 | 0 | from-ast: assignment to undeclared identifier "·" (2); from-ast: '·' operands not provably both-number or string-concatenable (number/unprovable) — the unboxed numeric-add / string-concat fast pa (1); from-ast: String.fromCharCode argument is not numeric (1) |
| `expr-regexp-method-target` | 4 | 0 | 4 | 0 | 0 | from-ast: closure must have a return type annotation (3); from-ast: standalone RegExp method subject is not a proven string (1) |


Reading Table A:

- **Pure over-refusals.** Every forced unit built:
  - `move-only[dyn]`, 24 / 24. The dynamic-use scan refuses reads from-ast lowers (see also #7342 S0).
  - `<module-init>`'s `call-graph-closure`, 5 / 7.
  - The harness helpers' `external-call` (`formatSimpleValue`, `formatIdentityFreeValue`), 36 / 64; the other 28 sit behind the runtime-eval boundary.
- **Labels that are honest gaps.** Every forced unit failed in from-ast:
  - `param-dynamic-carrier-diverges-from-legacy` (137 / 148);
  - `expr-binary-operand-families` (56 / 58, almost all `propertyHelper.js`'s empty `failures` array);
  - `param-type-unresolved` (48 / 48, the `JSDocTypeLiteral` of #7342);
  - `compound-dynamic-module-operand`, `objectlit-ordinary-to-primitive-method`, `body-if-cond` and the RegExp rows.
- **`expr-ident-not-in-scope` (259 units) is mostly not a selector question.**
  - 108 of its units sit behind `late-preparation-unsupported`, the runtime-eval boundary, which the stub does not force.
  - 37 stay refused by an unforced arm.
  - Of the 111 forced, from-ast fails on the same identifier (`Object`, `Number`, `Math`, `String`, `JSON`, …): the ambient global has no IR value lowering.
- **`vardecl-module-storage-unrepresentable` (67) is the crash class.** Forcing the declaration breaks the module-binding plan (Table B2), so the real lowering behind it is still unmeasured.

### Table B: build-error classes ranked by files freed

Column 2 counts files where this class is the **only** remaining blocker: every other legacy unit of the file built. Column 3 counts all files carrying the class. Crashed files are excluded from column 2 (their other units are unmeasured) and listed in B2.

| class | files where it is the only blocker | files carrying it |
| --- | --- | --- |
| not forced: late-preparation-unsupported | 67 | 87 |
| from-ast: identifier ‹Object› is not in scope | 34 | 36 |
| from-ast: proven dynamic binding '·' initializer has no supported carrier | 31 | 80 |
| from-ast: only direct calls supported in Phase N | 26 | 28 |
| from-ast: closure must have a return type annotation | 20 | 22 |
| from-ast: module-init unit contains a nested var declaration | 16 | 16 |
| from-ast: module-level closure binding '·' not in module-init Slice N scope | 14 | 14 |
| from-ast: identifier ‹Number› is not in scope | 13 | 13 |
| not forced: body-shape-rejected | 10 | 69 |
| from-ast: direct call to "·" has no exact AST-site plan | 8 | 15 |
| from-ast: compound assign RHS has no numeric carrier (got string) | 7 | 7 |
| from-ast: unknown class "·" | 6 | 6 |
| from-ast: identifier ‹y› is not in scope | 6 | 6 |
| from-ast: identifier ‹x› is not in scope | 6 | 6 |
| from-ast: identifier ‹Math› is not in scope | 5 | 5 |
| from-ast: identifier ‹f› is not in scope__closure_8 | 5 | 5 |
| from-ast: identifier ‹String› is not in scope | 5 | 5 |
| from-ast: identifier ‹JSON› is not in scope | 4 | 4 |
| from-ast: '·' operands not provably both-number or string-concatenable (string/unprovable) — the unboxed numeric-add / string-concat fast pa | 4 | 4 |
| from-ast: identifier ‹f› is not in scope | 3 | 6 |
| from-ast: identifier ‹foo› is not in scope | 3 | 4 |
| from-ast: module binding '·' initializer is dynamic but its global is i32 | 3 | 3 |
| from-ast: bare '·' in non-reference context (f64) is not supported | 3 | 3 |
| from-ast: new Object(...) has N args, max N | 3 | 3 |
| from-ast: unsupported body statement FunctionDeclaration | 3 | 3 |
| from-ast: compound assign RHS has no numeric carrier (got i32) | 3 | 3 |
| from-ast: identifier ‹arguments› is not in scope | 2 | 4 |
| from-ast: delete has no IR lowering | 2 | 2 |
| from-ast: Phase N requires matching operand types for '·' | 2 | 2 |
| from-ast: isNaN operand N is dynamic | 2 | 2 |

Reading Table B, in plan order:

1. **The runtime-eval boundary** (`late-preparation-unsupported`): sole blocker in 67 files, present in 87.
   - The stub cannot force it.
   - These files carry no eval/with label in the census; their units are withdrawn because a function observes its legacy caller activation (`fn.caller` / `arguments`) or a binding is eval-visible.
   - It is the largest single item. It is a frontend-ownership question, not a missing lowering.
2. **Ambient globals as values** (`identifier ‹Object›/‹Number›/‹Math›/‹String›/‹JSON› is not in scope`): together sole blocker in 61 files. #7338 covers `Object` (34 files here).
3. **`proven dynamic binding '·' initializer has no supported carrier`**: sole blocker in 31 files, present in 80. This is the S4 signature question of #7342 seen from the build side.
4. **Calls through a value** (`only direct calls supported`, `direct call to "·" has no exact AST-site plan`, `identifier ‹f›/‹foo›` for function values): about 45 files sole.
5. **Closures** (`closure must have a return type annotation`, `module-level closure binding … not in module-init Slice N scope`, `closure params must have annotations`): 34 files sole.
6. **`module-init unit contains a nested var declaration`**: 16 files sole. A `var` inside a block at script level.

### Table B2: compile crashes (forced invariants, not work items)

| crash class | files |
| --- | --- |
| `module-init: declaration '·' no longer resolves to the direct top-level binding selected for this unit` | 81 |
| `Object.defineProperty is not a certified open-carrier define` | 22 |
| `fresh-wrapper identity` | 4 |
| `internal capability violation — binary/prefix operator '·' is capability-deferred … yet reached the builder post-claim` | 7 |
| `internal capability violation — extern property read .source …` | 2 |
| `'·' reference outside an instance method body` (`__FACTORY`, `FACTORY`) | 3 |
| `identifier · is not in scope in callbackfn` | 1 |

All 120 compile errors are thrown as `[IR-FALLBACK]` codegen errors, not demoted to legacy. Two consequences:

- the refusal that the stub removed was protecting exactly that invariant;
- under forcing, the product cannot demote these after the claim.

### Table C: files that become fully IR-only

| | files |
| --- | --- |
| fully IR-only under the permissive selector (no legacy unit, no post-claim error, module validates) | **23** |
| of which already IR-only on main | 8 |
| **new** (selector-only work upper bound) | **15** (2.5 % of the sample) |
| verdict compared (`scripts/run-test262-paths.mts --standalone`, main vs permissive), all 23 | 23 |
| same verdict | 22 |
| different verdict | 1: `built-ins/Object/defineProperty/15.2.3.6-1-1.js`, pass → fail ("Expected a TypeError … no exception was thrown") |

So making the selector more permissive, with nothing else, frees at most **15 of 600** sampled blocked files. One of them silently changes behaviour: `Object.defineProperty(undefined, …)` no longer throws. Everything else behind the labels is real lowering work (Table B) or the runtime-eval boundary.

### Side data (scratch, not committed)

Under `scratchpad/behind-selector/`:

- `sample600.txt`;
- `base.jsonl` / `perm.jsonl` (per-file outcomes);
- `tables.md` (full Tables A and B, every row);
- `examples-top10.txt` (10 example files per top-10 Table B class);
- `fully-ir.txt`;
- `verdict-base.txt` / `verdict-perm.txt`;
- `analyze.mjs` (the classification).
