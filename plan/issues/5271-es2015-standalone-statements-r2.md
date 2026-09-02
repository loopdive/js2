---
id: 5271
title: "ES2015 standalone: statements + language semantics — r2 residual pass (68 rows)"
status: ready
sprint: current
created: 2026-09-02
updated: 2026-09-02
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5154, 5158, 5157, 4444]
# 2026-09-02 (fable-es6 planning pass): every step below adds a spec arm to an
# existing lowering — a declaration-identity gate where a name-keyed one lets a
# block `let` alias its module-level twin, a native `__with_has_binding` beside
# the host one, a for-in head TDZ range, a bounded generator drain, an
# `arguments` @@iterator seed, a class-binding live global, a `$Symbol` arm in
# the primitive-base reference walk. Growth, not refactor; granted for this
# change-set only. New mechanisms go in NEW files (named per step), the listed
# god-files grow by wiring. `total` covers the net delta of the whole wave.
loc-budget-allow:
  - total
  - src/codegen/statements/loops.ts
  - src/codegen/statements/shared.ts
  - src/codegen/statements/variables.ts
  - src/codegen/statements/destructuring.ts
  - src/codegen/statements/tdz.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/closures.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/closures/funcref-as-closure.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/expressions/eval-early-errors.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/identifier-assignment.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/with-scope.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/function-body.ts
  - src/codegen/arguments-callee.ts
  - src/codegen/function-instance-meta.ts
  - src/codegen/annexb-cancel.ts
  - src/codegen/declarations.ts
  - src/codegen/js-errors.ts
  - src/codegen/literals.ts
  - src/codegen/index.ts
  - src/ir/with-environment.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForStatement
  - src/codegen/statements/loops.ts::compileForInStatement
  - src/codegen/statements/shared.ts::saveBlockScopedShadowsForNames
  - src/codegen/statements/shared.ts::restoreBlockScopedShadows
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/closures.ts::promoteAccessorCapturesToGlobals
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/identifiers.ts::analyzeTdzAccess
  - src/codegen/with-scope.ts::emitDynamicWithGet
  - src/codegen/with-scope.ts::emitDynamicWithSet
  - src/codegen/destructuring-params.ts::destructureParamArray
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/typeof-delete.ts::compileTypeofExpression
---

# #5271 — ES2015 standalone: statements + language semantics, r2 residual pass

Growth-allowance rationale (2026-09-02, planning pass): see the frontmatter
comment. The two genuinely new pieces are asked to live in new modules —
`src/codegen/with-has-binding-native.ts` (step 2, the §9.1.1.2.1 HasBinding
native) and `src/codegen/forin-key-destructure.ts` (step 3, the key-string
destructuring arm) — so the listed god-files only grow by wiring.

## Problem

After wave 1 (#5154 lang-semantics, #5158 misc-statements, #5157
modules/eval/with — all three `in-review`, their landed slices are on HEAD)
**84 ES2015-bucket rows in the "statements + language semantics" cluster
still fail in `--target standalone`**: `language/statements/{for,for-in,let,
const,try,with,variable,function}/**`, `global-code/`, `eval-code/`,
`statementList/`, `arguments-object/`, `rest-parameters/`, `block-scope/`,
`destructuring/binding/`, `types/reference/`. Baseline:
`loopdive/js2wasm-baselines` standalone lane at compiler sha `d39779cb`
(2026-09-01, umbrella #4444 "2026-09-01 evening dispatch census"), an ancestor
of HEAD `a07f65319f`.

**Re-verified on HEAD 2026-09-02** with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/statements_misc-paths.txt --standalone`
(in-process; two full passes plus a 3-row solo re-run, all on a 4-core box at
1-min load 10–19 shared with four other agents): **0 pass · 77 fail · 7
compile_error — nothing to drop.** Of the 7 CEs, 4 are real (`for/head-lhs-let`
TS-parser, 2× the #2046 `Reflect.set` receiver refusal, `with/unscopables-inc-dec`
#1387 selector) and 3 are `compilation timeout` rows
(`global-code/script-decl-{func,var}`, `types/reference/get-value-prop-base-primitive-realm`)
that timed out in all three runs including alone at 17–31 s/compile — the
baseline records real assertion verdicts for them, so they are slow `$262`
compiles under load, not hangs; all three are out of scope below. Every other
row's HEAD signature matches the baseline except `global-code/script-decl-{func-err-non-configurable,lex-restricted-global}`,
which now surface the raw `[object WebAssembly.Exception]` the #5157-E note
describes (the QuickJS runtime-eval tier IS present in this container:
`runtime-eval tier: QUICKJS … DEFAULT engine (#4242)`).

Root causes were re-derived with 27 minimal probes
(`plan/agent-context/es2015-suspend-2026-09-01/probes/probes5271/`, generator
`make-probes.sh.txt`; 25 fail / 2 pass on HEAD — the two passes are the
FALSIFIED hypotheses: an unresolvable name in a plain nested function DOES throw
ReferenceError (p22), and a user-thrown `SyntaxError` DOES keep `.constructor`
inside a function (p05)).

The `rest` singleton list (18 rows) contributed **nothing** here: its 14
expression-shaped rows stay with #5270 (which already owns every other `tco-*`
row, so the TCO theme stays whole), `annexB/…/regexp/identity-escape` is #5198,
and the two statement-shaped Annex B rows (`annexB/language/statements/labeled/function-declaration`,
`annexB/language/function-code/function-redeclaration-switch`) are #2200's,
which holds a live claim (`ttraenkler/dev-1769`) — listed as owned, not adopted.

16 rows are owned elsewhere (see "Out of scope"); **68 rows are in scope**,
partitioned into the clusters below. Row lists (all `test/`-stripped):
`plan/agent-context/es2015-suspend-2026-09-01/lists/stmt-head.txt` (the 68),
`stmt-controls.txt` (20 passing neighbours), one `stmt-cl-<X>.txt` per cluster
(`stmt-cl-A.txt` … `stmt-cl-J.txt`, `-A2`, `-A3`, `-D5`, `-X1` … `-X5`).

## Clusters (HEAD 2026-09-02; counts partition the 84 exactly)

| # | Cluster | Count | Root cause (file:function) | Sample tests (`language/…`) |
|---|---------|------:|----------------------------|--------------|
| A | Module-level lexical shadowing: a block/for-head/catch-block `let` with the same spelling as a top-level binding aliases it | 6 | Three name-keyed seams. (i) `statements/loops.ts:415-416 compileForStatement`: `blockScopedInsideFunction = !isVar && fctx.name !== "__module_init"` — in `__module_init` a `let` head takes `ctx.moduleGlobals.get(name)` and WRITES the top-level `let x` global (probe p01: `x === 'inside'` after the loop). A for-head `let` is never registered as a module global (`declarations.ts:3925-3940` walks top-level VariableStatements only), so the arm only ever fires on a same-spelled outer binding — i.e. only on the bug. (ii) `statements/shared.ts:175 saveBlockScopedShadowsForNames` hides a block name ONLY when `fctx.localMap` already holds it; at module init the outer binding is a GLOBAL, nothing is saved, the block's fresh local (`variables.ts:1349 bindsModuleGlobal` = false → `allocLocal`) is never removed by `restoreBlockScopedShadows`, and a later top-level write goes to the global (`identifier-assignment.ts:197` chunked-init `durableModuleGlobalIdx`) while reads keep hitting the dead local (p02: `x === null` after the catch). (iii) `closures.ts:953/1031 promoteAccessorCapturesToGlobals` skips a capture whenever `ctx.moduleGlobals.has(cap.name)` — spelling, not declaration; the declaration-aware twin already exists in `closures/arrow-phases.ts:702 planClosureCaptures` (`referencedBindingDeclaration` L321 + `isDirectRuntimeModuleVariableBinding` L353). | `statements/for/scope-head-lex-open.js`, `statements/try/scope-catch-block-lex-close.js`, `statements/let/syntax/let-outer-inner-let-bindings.js` |
| A2 | Per-iteration copy is created after the first test, not before | 1 | `loops.ts:583-586`: C₀ is boxed at loop entry and the fresh cell is minted only at the iteration boundary; §14.7.4.3 ForBodyEvaluation step 2 runs CreatePerIterationEnvironment BEFORE the first test, so a closure built in the head initializer must keep C₀ while `x = 'inside'` in the test mutates C₁ (p19). | `statements/for/scope-body-lex-open.js` |
| A3 | Indirect-eval splice at module init reads the block shadow | 1 | `expressions/eval-inline.ts:637 foldedIndirectEvalReadsCallerBinding` returns `false` for `__module_init`, so the literal `(0,eval)('x;')` splice compiles `x` in the module-init frame — where cluster A's block local shadows the global (p18: `'inside'`). Indirect eval must resolve `x` in the global environment. | `eval-code/indirect/lex-env-heritage.js` |
| B | let/const TDZ: hidden slot, hoisted-function capture, top-level const | 6 | (B1, 2) `x; let x;` inside a block throws nothing (p03 function lane, p27 module lane): `saveBlockScopedShadowsForNames` (shared.ts:206-207) deletes the pre-hoisted localMap entry (`index.ts:14112 walkStmtForLetConst` + `needsTdzFlag` L13690 did allocate slot + flag), so the pre-declaration read misses localMap in `identifiers.ts:1152-1175` and never reaches `analyzeTdzAccess` (L431) → no `emitStaticTdzThrow` (L724). (B2, 3) a hoisted `function f(){ return x + 1 }` in the same block as `let x`: the #2814 slot reuse (`variables.ts:2051-2105`) keeps the VALUE slot shared but the TDZ FLAG is not boxed into the hoisted function (#1177 `boxedTdzFlags` attach sites `closures/funcref-as-closure.ts:306`, `call-identifier.ts:3213`), so `f()` reads the default. (B3, 1) top-level `const x = 1` read from a hoisted function: the module TDZ flag is retained by `computeElidableTopLevelTdzNames` (identifiers.ts:634 → "check" for a FunctionDeclaration access) yet `f()` throws nothing (p04) — the read never reaches `emitModuleTdzReadCheck` (identifiers.ts:1436); check whether the numeric `const` is constant-folded before the module-global arm. | `statements/let/block-local-use-before-initialization-in-prior-statement.js`, `statements/let/block-local-closure-get-before-initialization.js`, `statements/const/global-closure-get-before-initialization.js` |
| C | for-in lexical head: TDZ over the receiver, key-string binding patterns, member targets | 10 | (C1, 5) `analyzeTdzAccess` (identifiers.ts:431) measures TDZ by text position, so a read of the head name inside the RECEIVER (`for (let x in { x })`, textually after the head declaration) answers "skip" and the #2705 TDZ env installed at `loops.ts:4027-4080` is never consulted (p15); the closure form (`probeExpr = function(){ typeof x; }`) is boxed with flag 0 (L4040-4062) but `typeof-delete.ts:1726 compileTypeofExpression` answers without the TDZ check (p16). (C2, 6) a binding-pattern head hands the enumerated key STRING to `statements/destructuring.ts:1045 compileExternrefArrayDestructuringDecl` (loops.ts:4146-4165), which has no `$AnyString` arm — elements bind `null` and defaults never fire (p07 `x === null`; p17 `probeDecl` stays undefined; `scope-body-{lex-close,var-none}` then call `null`). (C3, 1) `for (x.y in obj)` writes through `__extern_set` (`loops.ts:3357 emitForInMemberTargetWrite`) but `var x = {}` is a CLOSED struct literal whose `x.y` read is a static field miss → `undefined` (p08). | `statements/for-in/head-let-bound-names-fordecl-tdz.js`, `statements/for-in/head-let-destructuring.js`, `statements/for-in/head-lhs-member.js` |
| D | `with` Object Environment Record in standalone: no @@unscopables, no per-step HasProperty, static callees, `var` inside `with` | 14 | Standalone dynamic `with` (`with-scope.ts:418 compileDynamicWithStatement`) gates on `withHasBindingImport` (L55) = the native `__extern_has` (`object-runtime.ts:4644`, Proxy-guarded at `object-runtime-proxy.ts:1841`), i.e. HasProperty only: #2663 Slice 4 (`__with_has_binding`, the §9.1.1.2.1 predicate with the @@unscopables filter) is host-mode only. So: `Get(env, @@unscopables)` never runs (p06 `x === 1`; `*-in-get-unscopables` count 0; `unscopables-*-get-err` never throw); `emitDynamicWithGet` (L504) has no GetBindingValue step-2 re-check and `emitDynamicWithSet` (L722) no SetMutableBinding step-2 `stillExists` → the `-strict-mode` twins never throw ReferenceError and the sloppy twins write a deleted binding back; a bare CALLEE (`Object()`) inside `with` resolves statically in the call lowering without `resolveWithBinding` (L116) → the Proxy `has`/`get` traps never fire (`Actual []`); `var x = rhs` inside `with` (`statements/variables.ts` never consults `fctx.withScopes`) writes the hoisted var instead of resolving the Reference BEFORE the RHS through the env (p24: `obj.test262id === 1`), and the keyed-destructuring row shows the same for a `var { [k]: t = d } = src` pattern (only the two `binding::` entries the RHS produced). | `statements/with/binding-blocked-by-unscopables.js`, `statements/with/get-binding-value-call-with-proxy-env.js`, `statements/variable/binding-resolution.js` |
| D5 | `with` body containing an accessor literal | 1 (CE) | `src/ir/with-environment.ts:214 selectWithEnvironmentClosures` refuses the OUTER `with` because the inner `with`'s target literal carries `get [Symbol.unscopables]()` (L259 "class or method capture"). The getter body legitimately resolves free names (`flag`, `unscopablesGetterCalled`) through the outer object environment, so admitting it needs the #4206 environment-capture contract for accessor bodies — deferred, see step 2. | `statements/with/unscopables-inc-dec.js` |
| E | Elision-only array pattern drains the generator | 6 | `statements/destructuring.ts:1171` (decl lane, reached from `compileArrayDestructuring` L1074 and from the for-head at `loops.ts:~430`) calls `emitNativeGeneratorToVec` (`generators-native-consumer.ts:1462`) WITHOUT its `stepLimit`, so `let [,] = g()` resumes past the first `yield` (p10: `second === 1`). The param lane already bounds the drain with `patternIteratorStepCount` (`destructuring-params.ts:284`, used at L1790-1830). #5154 A-1d / #5158 B.4 — unblocked now that the `__gen_resume` trap (#5141) is gone. | `statements/let/dstr/ary-ptrn-elision.js`, `statements/for/dstr/const-ary-ptrn-elision.js` |
| F | `arguments` object + rest parameters | 7 | (F1, 2) no own `@@iterator` data property on the arguments vec — only `callee` is seeded (`arguments-callee.ts:93/163/217`, the #4243 `__defineProperty_value` seed). (F2, 1) `function-body.ts:611-624` builds the arguments vec AFTER the default-parameter blocks (L540-575), so `x = arguments[2]` derefs null (p21) even though `needsImplicitArgumentsObject` (`helpers/body-uses-arguments.ts:30`, #5139) already counts default initializers. (F3, 2) a body binding named `arguments` (`function arguments(){}` / `let arguments`) collides with the `allocLocal(fctx, "arguments")` slot (L624): with parameter expressions present FunctionDeclarationInstantiation steps 15-22 still create the object for the parameter scope, so `x = args = arguments` must see it (p26 `typeof args === "undefined"`; the `-lex` twin traps `illegal cast`). (F4, 1) `(a, b, ...c) => c` called with zero surplus returns `null` (p20) — #5158 measured the identical assertions pass with the second rest arrow removed, so it is cross-arrow `__extras_argv` state (`closures.ts`, `expressions/calls-closures.ts`), not the empty materialization. (F5, 1) class `constructor(...a)` + `super(1,2,3)`: `arguments.length` is 1, not 3 — the ctor prologue (`expressions/new-super.ts`) sizes `arguments` from the fixed params, not the `__argc`/extras carrier. | `arguments-object/mapped/Symbol.iterator.js`, `statements/function/params-dflt-ref-arguments.js`, `rest-parameters/arrow-function.js` |
| G | Declaration-lane residue: const for-head, NamedEvaluation for class expressions, param destructuring lanes | 7 | (G1, 1) `loops.ts:355-356` deletes the head name from `fctx.constBindings` and, unlike the for-of lanes (L1182, L1602), never re-adds it for a `const` head → `emitConstIdentifierUpdateGuard` (`identifier-assignment.ts:116`, called from `unary-updates.ts:1473`) never fires for `i++` (p14). (G2, 3) `let/const/var cls = class {}`: `fnInstanceNameOf` (`function-instance-meta.ts`, extended by #5146 cluster E for assignment forms) is not applied on the declaration lane `variables.ts:1483 tryCompileClassExpressionBindingValue` — `name` must be `{value:'cls', writable:false, enumerable:false, configurable:true}` and a named class / a static `name()` must NOT be renamed (p25). (G3, 3) param-mode lanes in `destructuring-params.ts:1677 destructureParamArray`: nested `[x, y, z] = [4,5,6]` inside an object-pattern default binds `y` as `NaN` (f64 lane; the decl lane got externref widening in #5154 A-1a), nested `[[...x] = values]` with `f([])` derefs null in the rest branch (~L2406-2504), and `dflt-params-arg-val-not-undefined` (untyped f64 param coerces `false` → `0` before the undefined check) is #5154 L(a)'s call-site-driven lane widening — high blast radius, last. | `statements/const/syntax/const-invalid-assignment-next-expression-for.js`, `statements/let/fn-name-class.js`, `statements/function/dstr/dflt-obj-ptrn-prop-ary.js` |
| H | Script-goal semantics: class binding immutable, strict block functions leak, restricted global names | 3 | `class C {}; C = 5` reads back the class (p09): `index.ts:9627 directlyReassignedClassDeclarations` records the reassignment only to keep static-prop cells away; the binding itself has no live slot (the reassigned-FUNCTION twin gets one at `index.ts:9596-9622 liveFuncBindingGlobals`). Strict-mode `{ function f(){} }` leaks `f` (p12): `annexb-cancel.ts:423` records the unbound-read site only for strict SWITCH-case functions (`strictSwitchFunction`), not strict BLOCK functions. `let undefined;` at Script top level compiles and runs (p28): no HasRestrictedGlobalProperty check anywhere (`src/interp/eval-environment.ts` has one for the interpreter tier only). | `global-code/decl-lex.js`, `global-code/block-decl-strict.js`, `global-code/decl-lex-restricted-global.js` |
| I | Property reference on a primitive base | 2 | GET: `1..x` and `true.x` walk `Number.prototype`/`Boolean.prototype` (p23 passes those) but a `$Symbol` carrier receiver has no arm in `__extern_get` (`object-runtime.ts:2244`) → `Symbol().test262 === null`. PUT: `__extern_set` (`object-runtime.ts:3227`, "no-op on non-object") never walks the wrapper prototype for a primitive receiver, so a Proxy `set` trap installed on `Number.prototype`'s chain never fires (`numberCount === 0`); §10.1.9.2 OrdinarySetWithOwnDescriptor with a primitive Receiver must reach the inherited setter/trap and answer `false` for a data property (no own-property creation). | `types/reference/get-value-prop-base-primitive.js`, `types/reference/put-value-prop-base-primitive.js` |
| J | Direct-eval seams that stay in the compiled module (reachable; not the QuickJS bridge) | 4 | (J1, 2) `super-prop-{dot,expr}-no-home`: the SyntaxError IS thrown by the #5157-D `Contains` rule (`expressions/eval-early-errors.ts` → `emitThrowJsError(…,"SyntaxError")`, `js-errors.ts:103`) but `caught.constructor` reads `null` — the MINTED instance, not a user-constructed one (p05 passes), loses its prototype link when the throw site is inside a function; 5-line repro first. (J2, 1) `super-prop-method`: the positive `eval('super.test262;')` splice snapshots the home object's prototype — after `Object.setPrototypeOf(o, …)` the second call must read `262` (#5157 D.3). (J3, 1) `outermost-binding-…`: a nested function that CONTAINS a direct `eval` reads an unbound `xx` as `undefined` instead of throwing (p22, the same shape without `eval`, passes) — the direct-eval activation lane (`identifiers.ts:946-960 directEvalActivationBindingNames`) demotes unresolvable reads; `eval('xx')` must throw the same ReferenceError. | `eval-code/direct/super-prop-dot-no-home.js`, `eval-code/direct/super-prop-method.js`, `block-scope/leave/outermost-binding-updated-in-catch-block-nested-block-let-declaration-unseen-outside-of-block.js` |

In-scope total: 68. Sum check: A6 + A2 1 + A3 1 + B6 + C10 + D14 + D5 1 + E6 +
F7 + G7 + H3 + I2 + J4 = 68; out of scope 16 (below); 68 + 16 = 84.

### Out of scope (owned elsewhere) — 16 rows, listed so nobody re-derives them

| # | Rows | Owner / reason |
|---|------|----------------|
| X1 | `eval-code/indirect/realm.js`, `types/reference/{get,put}-value-prop-base-primitive-realm.js` | `$262.createRealm` rows — realm/eval-engine lane (the runner's `$262` shim, `tests/test262-runner.ts:2324`, has no second realm). `get-…-realm` is one of the 3 timeout rows. |
| X2 | `statements/with/set-mutable-binding-idref-with-proxy-env.js`, `…-idref-compound-assign-with-proxy-env.js` | #2046 (in-progress) — the standalone `Reflect.set` receiver refusal is the CE; their `with` half is step 2's D3 and flips for free once #2046 lands. Do not re-implement receiver threading here. |
| X3 | `statements/for/head-lhs-let.js` | `for (let; ;)` with `let` as an IdentifierReference — TypeScript's parser rejects it ("Variable declaration expected"); wont-fix without a parser fork. |
| X4 | 4 × `statementList/eval-class-{array-literal,array-literal-with-item,regexp-literal,regexp-literal-flags}.js` | `eval('class C {}[];')` runs on the QuickJS runtime-eval tier (the inline splice refuses class declarations, `eval-inline.ts:1461`); the completion value crosses the adapter boundary as a null-prototype object. Reachable in standalone, but the fix is the eval-engine bridge — Lane A (#4242 / #2928), per #5157 "G rides the QuickJS completion-value boundary". |
| X5 | 6 × `global-code/script-decl-{var,func,lex,var-collision,lex-restricted-global,func-err-non-configurable}.js` | `$262.evalScript` → the QuickJS adapter's global-object bridge: GlobalDeclarationInstantiation descriptors (`configurable:false`), CanDeclareGlobal* TypeErrors, HasRestrictedGlobalProperty SyntaxError, lexical bindings must NOT become global-object properties (`script-decl-lex` fails "Cannot define property, object is not extensible" because the bridge defines them), and two rows escape as an unbranded `[object WebAssembly.Exception]`. #5157-E measured that `src/interp` is not on this path; re-scoped to Lane A (#4242). `script-decl-{func,var}` are the other two timeout rows. |

Other owned areas confirmed absent from this list: generators (#680/#2864 —
cluster E needs no generator change), RegExp (#5198), module code (#4759),
`Reflect.construct` NewTarget (#3371), class (#5195 — F5 touches the ctor
prologue only; check `git log origin/main --grep=5195` first), Proxy internals
(#5196 — D uses the existing `has`/`get` guards only), for-of/iterators
(#5267), Array/Object built-ins (#5268 — F1 depends on its step 10-M),
other built-ins (#5269), expressions (#5270).

## Implementation Plan

Ordered by yield per unit of risk; every step is independently shippable (one
PR per step or per pair). After each step re-run that step's sub-list AND
`lists/stmt-controls.txt` (20 rows, all pass on HEAD — verified 2026-09-02 in
the same run as the 84; 26 candidates were run, all green, 20 kept). Probe:
`npx tsx scripts/run-test262-paths.mts <list> --standalone` (in-process; none
of the 84 poisons the realm; under load the ~15 s compile budget times out
`$262`-heavy rows, so re-run a row alone before calling anything a hang).
Copy the lists back with `cp plan/agent-context/es2015-suspend-2026-09-01/lists/stmt-* .tmp/es2015/`
and prefix `test/` when the runner needs it. Type queries go through
`ctx.oracle` (`src/checker/oracle.ts`); raw `ctx.checker` trips the oracle
ratchet.

### Step 1 — Elision-only patterns step once (cluster E; 6 rows; `stmt-cl-E.txt`)

In `statements/destructuring.ts:1152-1171` pass
`patternIteratorStepCount(pattern.elements)` (import from
`destructuring-params.ts:284`) as the `stepLimit` argument of
`emitNativeGeneratorToVec(ctx, fctx, genInfo, resultType, genVecTypeIdx,
genArrTypeIdx, true, stepLimit)` (`generators-native-consumer.ts:1462`), and
keep the unbounded drain when the count is `-1` (rest element) — exactly the
guard the param lane applies at `destructuring-params.ts:1790-1830`. The three
`for/dstr/*-ary-ptrn-elision` rows reach the same site through
`compileArrayDestructuring` (L1074) from the for-head at `loops.ts:~430`.
Edge: `patternIteratorStepCount` counts elisions and identifiers alike (one
IteratorStep each), which is §8.6.2 — `let [,] = g()` resumes exactly once and
`second` stays 0. Verify with probe p10 before the list.

### Step 2 — Module-level lexical shadowing (clusters A + A2 + A3; 8 rows; `stmt-cl-A.txt` + `-A2` + `-A3`)

1. **For-head at module init** (`loops.ts:415-416`): a `let`/`const` head never
   binds a module global — drop the `__module_init` exception so
   `moduleGlobalIdx` is `undefined` for every lexical head (keep it for `var`).
   The #3343 note kept the exception for top-level counters; the controls
   `statements/for/12.6.3_2-3-a-ii-1.js` and `let/cptn-value.js` guard that
   nothing depended on it. p01 is the 4-line acceptance test.
2. **Block exit must forget block-fresh locals** (`shared.ts:175
   saveBlockScopedShadowsForNames` / `restoreBlockScopedShadows`): record EVERY
   block name, and at restore DELETE the `localMap` / `tdzFlagLocals` /
   `boxedCaptures` / `constBindings` entries of names that had no saved outer
   entry (today only saved names are restored). This is what makes a catch-block
   / try-block / bare-block `let` at module init stop shadowing the global
   after the block (p02), and it is the precondition for A3.
3. **Closure capture by declaration, not spelling** (`closures.ts:953` and
   `:1031` in `promoteAccessorCapturesToGlobals`): replace
   `ctx.moduleGlobals.has(cap.name)` with the declaration-identity gate the
   arrow/function-expression lane already uses —
   `isDirectRuntimeModuleVariableBinding(referencedBindingDeclaration(ctx, closure, name))`
   (`closures/arrow-phases.ts:353` / `:321`; export them). A closure that
   captures a block-local `x` whose spelling is also a top-level binding then
   boxes the local (`scope-catch-block-lex-open` `probeBlock`, `scope-head-lex-*`
   head probes); a closure that really references the top-level binding keeps
   reading the global (`probeBefore`). Do the same audit on `planClosureCaptures`'
   #1177 rescan-by-name (`arrow-phases.ts:677-690`): when the block's own
   pre-hoisted slot exists, prefer it over a same-spelled outer slot.
4. **A2** (`loops.ts:583-586`): when `perIterCells` is non-empty, mint C₁ =
   `struct.new(C₀.value)` and re-aim `boxedLocal` to it IMMEDIATELY after the
   head declarators are compiled and BEFORE the condition — CreatePerIterationEnvironment
   at ForBodyEvaluation step 2. Closures built in the head keep C₀ (p19), the
   test/body/increment see C₁, and the existing iteration-boundary copy is
   unchanged.
5. **A3** (`eval-inline.ts:637 foldedIndirectEvalReadsCallerBinding`): in
   `__module_init`, answer `true` (refuse the fold → the standalone
   `emitStandaloneIndirectEvalRuntime` route, L1989, resolves globally) when a
   referenced name is currently a block-local shadow, i.e.
   `fctx.localMap.has(name) && ctx.moduleGlobals.has(name)` while the local is
   not the #3546 `moduleBindingShadowLocals` twin of the global. After 2. the
   condition is exact.

Edge cases: nested `for (let x…)` loops with the same name (the existing
`savedForScope`/`savedForBoxedCaptures` restore at loop exit stays); a
top-level `for (let x…)` with NO outer `x` must keep working unchanged (it
already allocates a local); `var` inside a block still binds the global.

### Step 3 — `with` Object Environment Record, standalone Tier-2 (cluster D; 14 rows; `stmt-cl-D.txt`; D5 deferred)

New module `src/codegen/with-has-binding-native.ts` registering the defined
function `__with_has_binding(env: externref, key: externref) -> i32`
(reserve-then-fill via `registerNative`, like `__extern_has` at
`object-runtime.ts:4644`), and `withHasBindingImport` (`with-scope.ts:55`)
returns it in standalone instead of `__extern_has`.

1. **D1 HasBinding §9.1.1.2.1** — body: `if (!__extern_has(env,key)) return 0;
   unsc = __extern_get(env, <@@unscopables key>); if (unsc is an object)
   return !__is_truthy(__extern_get(unsc, key)); return 1`. Both natives carry
   the Proxy front-guards (`object-runtime-proxy.ts:1841` for `has`, the `get`
   guard beside it), so a Proxy env logs `has:x, get:Symbol(Symbol.unscopables)`
   in spec order and a throwing `@@unscopables` getter propagates (no catch —
   `unscopables-get-err`, `unscopables-prop-get-err`). The symbol key is the
   interned well-known `@@unscopables` carrier the way `property-access.ts:182`
   / `builtin-value-read.ts` spell it (see #2663 L349-356). Never cache the
   result across lookups — the `*-in-get-unscopables` rows count getter calls
   and mutate `env` inside the getter. Rows: `binding-blocked-by-unscopables`,
   `get-binding-value-idref-with-proxy-env`, `unscopables-{get,prop-get}-err`,
   plus the sloppy half of the four `*-binding-deleted-*` rows.
2. **D2 GetBindingValue / SetMutableBinding step 2** — `emitDynamicWithGet`
   (`with-scope.ts:504`): after HasBinding, re-run `__extern_has(env,key)`; false
   → sloppy `undefined` / strict ReferenceError (`emitThrowReferenceError`,
   `js-errors.ts:119`). `emitDynamicWithSet` (L722): same `stillExists`
   re-check before `__extern_set`; strict → ReferenceError. Strictness is the
   CALLER's (the `-strict-mode` rows put the reference inside a strict
   function nested in the `with` body). Rows: the 4 `*-binding-deleted-*`
   `-strict-mode` twins + `set-mutable-binding-binding-deleted-with-typed-array-in-proto-chain`
   (sloppy: the deleted `NaN` binding must NOT be recreated on `env`, the write
   falls through to the outer/global `NaN` — a `__extern_set` on the vanished
   binding would recreate it).
3. **D3 call-position identifiers** (`has-binding-call-with-proxy-env`,
   `get-binding-value-call-with-proxy-env`): the identifier-call lowering
   (`expressions/call-identifier.ts` / `calls.ts` — the arm that folds `Object()`
   to the builtin) resolves the callee statically; when `fctx.withScopes` is
   non-empty run `resolveWithBinding(fctx, name)` (`with-scope.ts:116`) first
   and, on a dynamic hit, compile the callee through `emitDynamicWithGet` +
   the externref-callee call path (`this` = the env object per §13.3.6.2 step
   6.a — `withBaseObject`). The expected logs are exactly the D1/D2 sequences.
4. **D4 declarations inside `with`** (`statements/variable/binding-resolution`,
   `destructuring/binding/keyed-…-with-bindings`): `compileVariableStatement`
   (`statements/variables.ts`) must, for a `var` with initializer inside a
   dynamic `with`, capture HasBinding BEFORE the RHS (`emitCaptureWithHasBinding`,
   `with-scope.ts:688`) and write through `emitDynamicWithSet` — §14.3.2.1
   `var x = e` is `PutValue(ResolveBinding(x), e)` with the Reference resolved
   first (p24 shows the write landing on the hoisted var). For the
   destructuring row route every identifier the pattern references (`sourceKey`,
   `varTarget`, `defaultValue`, and the RHS `source`) through the same
   `resolveWithBinding` gate in source order, and evaluate the computed key's
   ToString between `binding::sourceKey` and `binding::varTarget` as the
   expected log says.
5. **D5 deferred** (`unscopables-inc-dec`, CE): `selectWithEnvironmentClosures`
   (`src/ir/with-environment.ts:214`) refuses accessor bodies in the body
   (L259). Admitting them means extending the #4206 environment-capture
   contract to method/accessor bodies — a #2663 slice, not this wave. Leave the
   loud refusal (never demote to a wrong answer); note the row in the PR.

### Step 4 — for-in lexical head (cluster C; 10 rows; `stmt-cl-C.txt`)

1. **C1 TDZ over the receiver** — `analyzeTdzAccess` (`identifiers.ts:431`):
   when `decl`'s declaration list is the `initializer` of a `ForInStatement` /
   `ForOfStatement` and the access lies inside that statement's `expression`,
   answer "throw" for a direct read and "check" for a closure read (§14.7.5.6
   step 2: the head's TDZ env spans the receiver). The #2705 env at
   `loops.ts:4027-4080` already holds the flag at 0 for the closure case — the
   missing half is the `typeof` lane: `typeof-delete.ts:1726
   compileTypeofExpression` must apply the same `tdzFlagLocals`/`boxedTdzFlags`
   check as a value read before answering (a TDZ `typeof x` throws, §13.5.3
   step 2 does not protect it). Rows: `head-{let,const}-bound-names-fordecl-tdz`,
   `scope-head-lex-open`, `scope-head-lex-close`, `scope-body-lex-open`.
2. **C2 key-string binding patterns** — new module
   `src/codegen/forin-key-destructure.ts`: a `$AnyString` arm for the head
   pattern write at `loops.ts:4146-4165` — iterate the key's code units
   (`iterator-native.ts:2181` has the `$AnyString` per-code-point arm to reuse
   for the rest element; a plain index read for positional elements), bind
   `undefined` past the end so DEFAULTS fire (`probeDecl` in
   `scope-head-lex-close`/`scope-body-lex-open`/`scope-body-lex-close`/`scope-body-var-none`),
   and for a `var [x, x]` pattern write the SAME slot twice so the last
   element wins (`head-var-bound-names-dup` → `'b'`). Object patterns
   (`for (let {length} in obj)`) go through the existing object lane with the
   string boxed. Rows: those 4 + `head-let-destructuring` +
   `head-var-bound-names-dup`.
3. **C3 member target** (`head-lhs-member`): `emitForInMemberTargetWrite`
   (`loops.ts:3357`) writes correctly; the base `var x = {}` must be an OPEN
   object so the later `x.y` read is dynamic — add "is the base of a for-in
   member target" to the syntactic open-carrier predicate beside
   `literals.ts:1665 computedOnlyArithmeticLiteralNeedsHostCarrier` (the #5108
   / #5149-F pattern; the #4275 `hasAddedDefineProp` route in `object-ops.ts`
   is the same idea for `defineProperty`).

### Step 5 — TDZ: hidden slot, hoisted capture, top-level const (cluster B; 6 rows; `stmt-cl-B.txt`)

1. **B1** — in `compileIdentifierCore`'s localMap-miss path (`identifiers.ts:938`,
   before the module-global arm at L1432): when `ctx.oracle.valueDeclarationOf(id)`
   is a `let`/`const` declaration of THIS function whose slot was hidden by
   `saveBlockScopedShadows`, apply `analyzeTdzAccess` — "throw" →
   `emitStaticTdzThrow` (L724), "check" → find the pre-hoisted slot/flag by name
   in `fctx.locals` (the #1177 rescan `arrow-phases.ts:677-690` does exactly
   this for closures) and `emitLocalTdzCheck`. Probes p03 (function) and p27
   (module init) are the acceptance tests; the module lane is the same code
   once step 2.2 stops leaking block locals.
2. **B2** — a hoisted `FunctionDeclaration` capturing a block `let`: the #2814
   reuse (`variables.ts:2051-2105`) already re-registers the pre-hoisted VALUE
   slot; also box the TDZ FLAG into the hoisted function the way arrow/function
   expressions do (#1177 attach sites `closures/funcref-as-closure.ts:306`,
   `expressions/call-identifier.ts:3213`), so `f()` before `let x` reads flag 0
   and throws, and the `-set-` twin's write throws too (`emitPutValueTargetGuard`,
   `identifier-assignment.ts:~175`, already orders TDZ before const).
3. **B3** — `global-closure-get-before-initialization`: reduce with p04. The
   module flag exists (`computeElidableTopLevelTdzNames`, `identifiers.ts:634`,
   keeps it for a FunctionDeclaration access); find why `f`'s read of `x` skips
   `emitModuleTdzReadCheck` (L1436) — most likely a numeric-literal `const`
   fold ahead of the module-global arm; gate that fold on
   `analyzeTdzAccess(...) === "skip"`.

### Step 6 — `arguments` object + rest parameters (cluster F; 7 rows; `stmt-cl-F.txt`)

1. **F2** (`params-dflt-ref-arguments`): in `function-body.ts` move the
   arguments-vec construction (L611-624) ahead of the default-parameter blocks
   (L540-575) whenever `needsImplicitArgumentsObject` is true because a default
   initializer references `arguments` (`helpers/body-uses-arguments.ts:30`, the
   #5139 arm); the vec is built from the raw incoming params so ordering is
   free. Mirror in `closures.ts:2984` for lifted expressions.
2. **F3** (`arguments-with-arguments-{fn,lex}`): when a body-level binding is
   named `arguments` (`bindingNameBindsArguments` covers params only —
   `body-uses-arguments.ts:10`) AND a parameter expression references
   `arguments`, materialize the vec into a PRIVATE slot for the parameter scope
   (`__args_param_scope`), compile the defaults against it, then let the body's
   own `arguments` binding (the hoisted `function arguments(){}` / `let
   arguments`) shadow it — FunctionDeclarationInstantiation steps 15-22 with
   `hasParameterExpressions = true`. Without parameter expressions keep the
   existing "no object" rule.
3. **F1** (`arguments-object/{mapped,unmapped}/Symbol.iterator`): seed
   `@@iterator` beside `callee` in `arguments-callee.ts` (`seedArgumentsCallee`
   L93 / `seedDeclarationArgumentsCallee` L163 / `seedLiftedClosureArgumentsCallee`
   L217) through the same `__defineProperty_value` with `{writable:true,
   enumerable:false, configurable:true}` and the `$Symbol` well-known-symbol key
   (the #3537 expando bag stores symbol keys — #5268 cluster D). The VALUE must
   be the `%Array.prototype.values%` singleton (`verifyProperty` compares with
   `[][Symbol.iterator]`); `values` is not yet a callable VALUE in standalone
   (#5268 step 10-M, `array-object-proto.ts:904` refusal) — if #5268-M has not
   landed, ship the descriptor with the same identity `[][Symbol.iterator]`
   currently answers and say so in the PR; the rows then flip with #5268.
4. **F4** (`rest-parameters/arrow-function`): reduce with p20 minus its last
   two lines (#5158: the identical `fn()` assertions pass without the second
   rest arrow) — the shared `__extras_argv` state between two rest arrows in
   one module (`closures.ts`, `expressions/calls-closures.ts`); a zero-surplus
   call must materialize an empty `$Vec`, never `ref.null`.
5. **F5** (`rest-parameters/with-new-target`): the class-constructor prologue
   (`expressions/new-super.ts`) sizes `arguments` from the declared params —
   route it through the `__argc`/extras carrier the plain-function prologue
   uses. Class lane overlap: check #5195 first; if it has touched the ctor
   prologue, rebase on it.

### Step 7 — Declaration-lane residue (cluster G; 7 rows; `stmt-cl-G.txt`)

- **G1** (`const-invalid-assignment-next-expression-for`): after the head
  declarator loop in `compileForStatement` add
  `fctx.constBindings.add(name)` when `stmt.initializer.flags & NodeFlags.Const`
  (the for-of lanes do it at `loops.ts:1182` / `:1602`); L920-923 already
  restores the outer state at loop exit. `i++` then hits
  `emitConstIdentifierUpdateGuard` (`identifier-assignment.ts:116`).
- **G2** (`{let,const,variable}/fn-name-class`): apply NamedEvaluation on the
  declaration lane — `tryCompileClassExpressionBindingValue`
  (`variables.ts:1483`) → `fnInstanceNameOf` (`function-instance-meta.ts`,
  #5146 cluster E) with the binding name; own `name` descriptor
  `{writable:false, enumerable:false, configurable:true}`; skip when the class
  expression is named (`class x {}`) or declares a static `name` member.
- **G3** (`function/dstr/dflt-obj-ptrn-prop-ary`, `…/ary-ptrn-elem-ary-rest-init`,
  `function/dflt-params-arg-val-not-undefined`): in `destructureParamArray`
  (`destructuring-params.ts:1677`) param mode, apply the decl-lane
  `undefined` widening from #5154 A-1a (`resolveBindingElementType` → externref
  for a binding whose element can be absent) so `y` binds `undefined`, not
  `NaN`; make the nested `[...x] = values` default in the rest branch
  (~L2406-2504) reach the rest materialization with a real `$Vec` (null deref
  today). `dflt-params-arg-val-not-undefined` is #5154 L(a) (call-site-driven
  parameter lane widening, wide blast radius): attempt only after everything
  else is green, else defer with a note.

### Step 8 — Script-goal semantics (cluster H; 3 rows; `stmt-cl-H.txt`)

- `decl-lex.js`: give every class declaration in
  `directlyReassignedClassDeclarations` (`index.ts:9627`) a live externref
  module global, seeded with the class object at declaration time, exactly as
  `liveFuncBindingGlobals` does for reassigned functions (`index.ts:9596-9622`);
  route bare reads/writes of that binding through it (`identifiers.ts` module
  global arm L1432 / `identifier-assignment.ts:197`). `let`/`const` halves of
  the row already pass.
- `block-decl-strict.js`: in `annexb-cancel.ts:400-440` extend the
  `strictSwitchFunction` site recording to strict BLOCK functions
  (`isStrictContext(node) && ts.isBlock(node.parent)`), so a read outside the
  block hits `emitAnnexBUnboundReferenceError` (`identifiers.ts:1060-1100`).
  Sloppy blocks keep B.3.3.
- `decl-lex-restricted-global.js`: HasRestrictedGlobalProperty for Script goal —
  where `tdzLetConstNames` is collected (`declarations.ts:3925-3940`), if a
  top-level `let`/`const`/`class` binds `undefined`, `NaN` or `Infinity`,
  emit `emitThrowJsError(ctx, fctx, "SyntaxError", …)` (`js-errors.ts:103`)
  as the FIRST instruction of `__module_init`. The runner accepts a runtime
  throw for `phase: runtime` (`tests/test262-runner.ts:4589
  originalNegativeMatches`), NOT a compile diagnostic — do not add it to
  `src/compiler/early-errors/`.

### Step 9 — Property references on a primitive base (cluster I; 2 rows; `stmt-cl-I.txt`)

- GET: add a `$Symbol` carrier arm to `__extern_get` (`object-runtime.ts:2244`)
  that continues the walk at `Symbol.prototype` (the `$NativeProto` the
  `Symbol.prototype.x = …` write lands on — #5269 cluster B1 owns the
  wrapper/prototype identity; this arm only READS through it).
- PUT: in `__extern_set` (`object-runtime.ts:3227`) route a primitive
  receiver (boxed number / string / boolean / `$Symbol`) to
  `__extern_set_decide` (L3272) with the wrapper prototype as the starting
  layer and the PRIMITIVE as `origRecv`, so an inherited setter or Proxy `set`
  trap runs with the primitive `this`; a data property or a miss answers
  `false` (no own property is created on a primitive, §10.1.9.2 step 2.c.i).

### Step 10 — Direct-eval seams (cluster J; 4 rows; `stmt-cl-J.txt`)

- **J1**: repro `function f(){ try { eval('super.x;') } catch (e) { return
  e.constructor === SyntaxError } }`; the minted instance
  (`buildThrowJsErrorInstrs`, `js-errors.ts`) must carry the same
  `SyntaxError.prototype` link a `new SyntaxError()` gets (p05 passes) — fix
  the prototype seed for the in-function throw site.
- **J2** (`super-prop-method`): the spliced `super.x` must walk the LIVE
  [[HomeObject]] prototype at each call (#5157 D.3), not a compile-time
  snapshot.
- **J3** (`outermost-binding-…`): in the direct-eval activation lane
  (`identifiers.ts:946-960`) an unresolvable name must still throw
  ReferenceError (the non-eval lane does, p22), and the spliced `eval('xx')`
  must resolve `xx` through the same scope chain — the sibling-block `let xx`
  is out of scope there.

## What NOT to do

- **No new `env::*` host imports and no allowlist edits** — the runner fails
  any standalone module that emits one (`standaloneHostImportError`,
  `tests/test262-runner.ts:3700`; the #5272 leak check is on main). Step 3's
  HasBinding is a DEFINED function; never make standalone import
  `__with_has_binding`.
- Never edit `tests/test262-runner.ts`, any skip list, `HANGING_TESTS`, or
  `scripts/*-baseline.json` / `scripts/ir-fallback-baseline.json`.
- Never `--no-verify`; run the five ratchet gates before every commit
  (Acceptance below), chained with `&&`, never piped.
- Do not touch the owned areas in "Out of scope": no `$262.createRealm`
  plumbing, no `Reflect.set` receiver threading (#2046), no QuickJS adapter /
  bridge work (X4/X5 — Lane A), no parser fork for `let` as an identifier.
- Do not fix cluster D by caching `@@unscopables` at `with` entry or by
  re-evaluating the RHS — the Reference is resolved once, before the RHS, and
  `@@unscopables` is read on EVERY lookup.
- Do not "fix" cluster A by keying captures on spelling in the other direction
  (always boxing) — declaration identity only; keep the top-level
  `for (let i…)` and the #3343 recursion case byte-identical (controls).
- `ctx.oracle` over raw `ctx.checker.*` (oracle-ratchet gate); every new arm
  builder is a factory — never share an `Instr[]` between two arms (#5188
  followUp 4); reserve-then-fill for any new native (`registerNative` /
  `definedFuncAt`); `ensureLateImport` + `flushLateImportShifts` before baking
  a funcIdx into a body.
- Do not hand-pick issue ids for follow-ups; `claim-issue.mjs --allocate`.

## Acceptance criteria

Expected flips per step (a step is accepted when its sub-list is green except
rows explicitly deferred in the PR body with the reason):

| Step | Sub-list | Expected flips |
|------|----------|---------------:|
| 1 | `stmt-cl-E.txt` | 6 |
| 2 | `stmt-cl-A.txt` + `-A2` + `-A3` | 8 |
| 3 | `stmt-cl-D.txt` (D5 deferred) | 14 (12 if the `-strict-mode` twins need more than step D2) |
| 4 | `stmt-cl-C.txt` | 10 |
| 5 | `stmt-cl-B.txt` | 6 |
| 6 | `stmt-cl-F.txt` | 5–7 (F1 2 may wait on #5268-M) |
| 7 | `stmt-cl-G.txt` | 6 (7 with G3's lane widening) |
| 8 | `stmt-cl-H.txt` | 3 |
| 9 | `stmt-cl-I.txt` | 2 |
| 10 | `stmt-cl-J.txt` | 3–4 |
| **total** | `stmt-head.txt` (68) | **wave target ≥ 48 (~70 %); floor 28 = steps 1 + 2 + 3(D1–D2) + 4; every not-done row named with its reason** |

- **Controls**: all 20 rows in `stmt-controls.txt` still pass after every step
  (verified 20/20 on HEAD 2026-09-02; a regression here is a regression, not
  drift). Re-run the FULL 84-row `statements_misc-paths.txt` once at the end;
  the 16 out-of-scope rows must keep their current signature (no CE →
  wrong-answer demotion, D5 stays a loud refusal).
- **Probes**: p01/p02/p19/p18 (step 2), p06/p24 (step 3), p07/p08/p15/p16/p17
  (step 4), p03/p04/p27 (step 5), p11/p20/p21/p26 (step 6), p10 (step 1),
  p14/p25 (step 7), p09/p12/p28 (step 8), p23 (step 9) flip with their step
  (copy `probes/probes5271/*.js.txt` into `test262/test/language/probe-5271/`
  without the suffix, or run `make-probes.sh.txt` as a shell script).
- **Pins**: `tests/issue-5271-<step>.test.ts` per landed step, shaped like
  `tests/issue-4492-builtin-as-value.test.ts` (compile with
  `{ target: "standalone" }`, assert `result.imports` is empty, run through the
  `__stdout_*` channel); each pin verified to FAIL on the pre-change tree
  (file-copy A/B, per CLAUDE.md).
- **Gates** (run bare, never piped, before every commit; also with
  `LOC_GATE_BASE=$(git rev-parse upstream/main)` to simulate CI's merge
  preview):
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`
- **Equivalence**: `pnpm run test:equivalence:gate` green (and
  `npm test -- tests/equivalence.test.ts`).
- Results section appended to this file per landed step (before/after counts
  from the probe, deferred rows with reasons), status → `done` in the last
  implementation PR (self-merge path).

## References

- #5154 (in-review) — lang-semantics wave 1: its clusters C (TDZ + module-init
  block scoping), C2(b) (for-in lexical head), I (arguments), L (default-param
  lanes), M (fn-name) are steps 5, 4, 6, 7 here; its A-1a decl-lane widening is
  the model for G3; A-1d is step 1.
- #5158 (in-review) — misc-statements wave 1: cluster E (for-head / catch
  closure capture) is step 2; F (arguments / rest — the cross-arrow `fn()`
  measurement) is step 6; its Step 8 cheap list carried the keyed-destructuring
  row (step 3 D4 here).
- #5157 (in-review) — modules/eval/with wave 1: cluster A (`with` Tier-2
  standalone seam) is step 3; D's landed `Contains` rules are why J1 is now a
  prototype-link defect; E's "re-scope onto the QuickJS adapter" and G's
  "rides the QuickJS completion-value boundary" are X5 / X4; H is step 9.
- #2663 (in-progress, no live claim) — `with` Tier-2 design; Slice 4
  (`@@unscopables` HasBinding) is host-only on HEAD, step 3 D1 is its standalone
  twin. #1387 (done) Tier-1; #4206 environment-capture contract (D5 needs it
  for accessors). #2046 (in-progress) — X2.
- #2705 (done) — for-in head TDZ env / Slice B outer-binding snapshot
  (`loops.ts:3767`, `:4027`); #5109 (done) per-iteration for-in cells; #1453
  per-iteration for cells (A2 site); #3343 — the `__module_init` for-head
  exception step 2.1 removes; #3546 — module-init shadow locals (A3 gate).
- #1177 (done) — closure-captured TDZ flags (B2 attach sites); #2814 —
  block-let slot reuse for hoisted-function captures (B2); #5221 —
  two-pass `hoistLetConstWithTdz`.
- #4243 (done) — `arguments.callee` seed (F1 site); #5139 — default-initializer
  `arguments` scan (F2); #3537 / #3251 — vec expando bag / overlay (symbol key
  storage for F1).
- #5146 (in-review) — NamedEvaluation for assignment forms (G2 twin) and the
  PutValue TDZ-then-const guard (B2 write half); #4491 T4 — global-var
  descriptor twin of X5.
- #5268 step 10-M (`values` as a callable value — F1 dependency); #5269
  cluster B1 (Symbol wrapper / prototype identity — step 9 boundary); #5195
  (class ctor prologue — F5 overlap); #4242 / #2928 — runtime-eval tier (X4,
  X5); #5272 (done) — runner leak check that makes every local pass honest.
- #4444 — ES2015 standalone closeout umbrella ("2026-09-01 evening dispatch
  census": this cluster's 84 rows).
