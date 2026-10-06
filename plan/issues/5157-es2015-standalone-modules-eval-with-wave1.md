---
id: 5157
title: "ES2015 standalone: modules-eval-with conformance wave 1"
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
  # 2026-10-04 naming leaf: default-export metadata and unsafe name-fold decline only.
  - src/codegen/function-instance-meta.ts
  - src/codegen/property-access-dispatch.ts
  - src/runtime.ts
  - src/codegen/with-scope.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/module-namespace-value.ts
  - src/codegen/json-codec-native.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/eval-early-errors.ts
  - src/codegen/expressions/eval-inline.ts
  - src/interp/eval-environment.ts
  - src/codegen/generators-native.ts
  - src/codegen/generators-native-consumer.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/function-body.ts
func-budget-allow:
  - src/codegen/function-instance-meta.ts::fnInstanceNameOf
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
  - src/codegen/expressions/eval-inline.ts::tryStaticEvalInline
---

# #5157 — ES2015 standalone: modules-eval-with conformance wave 1

loc-budget-allow rationale (2026-08-28): this wave adds a dynamic `with`
Object Environment Record, module-namespace exotic-object MOP arms, JSON codec
replacer/proxy/symbol arms, eval early-error rules, interpreter
GlobalDeclarationInstantiation checks, and generator module-binding routing —
all measured growth in the files listed above, granted for this change-set.

## Problem

84 ES2015-bucket test262 tests in the modules / eval / `with` / global-code /
JSON work package fail on the **standalone** target (pure Wasm, zero host
imports — the runner fails any module that emits `env::*`). Re-verified on
head 2026-08-28 with `.tmp/run-standalone.mts`: **81 still fail** (16
compile_error, 65 fail), 3 now pass. These are blocking the 100% ES2015
standalone goal; the clusters below cover all 81. Target list (authoritative,
regenerated today): `.tmp/es2015/wp-modules-eval-with-current-fails.txt`.

## Current failure clusters

Ordered by count descending. "CE" = compile_error.

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| A | `with` dynamic env: @@unscopables + proxy env | 15 (3 CE) | `src/codegen/with-scope.ts` Tier-1 static shape only; Tier-2 dynamic path is host-only (`withHasBindingImport` returns `__extern_has`, refused by the #1472 standalone gate); no per-lookup `Get(@@unscopables)`; SetMutableBinding through a proxy env hits the #2046 `Reflect.set`-receiver CE | `language/statements/with/binding-blocked-by-unscopables.js`, `language/statements/with/get-binding-value-idref-with-proxy-env.js`, `language/statements/with/set-mutable-binding-idref-with-proxy-env.js` (CE) |
| B | Module namespace exotic object | 15 (1 CE) | `src/codegen/module-namespace-value.ts:tryEmitCompiledModuleNamespaceObject` declines unless **every** export is an immutable top-level function decl → `ns` identifier falls to global lookup → runtime `ReferenceError: ns is not defined`; the object it does build is a plain object (no exotic MOP: no @@toStringTag, wrong descriptors, delete/set/defineProperty/preventExtensions all wrong) | `language/module-code/namespace/Symbol.toStringTag.js`, `language/module-code/namespace/internals/set.js`, `language/module-code/namespace/internals/delete-exported-init.js` |
| C | JSON.stringify/parse dynamic values | 13 (10 CE) | `src/codegen/expressions/call-namespace-static.ts:~2462` replacer gate accepts only syntactic array literals / provably-callable → everything else falls to the #1599 refusal CE; `src/codegen/json-codec-native.ts:__json_stringify_value` reads `$Object` fields directly (no MOP dispatch → proxies serialize as `null`, no revoked-proxy TypeError) and has no symbol arm (`JSON.stringify(sym)` → `"null"`, spec: `undefined`) | `built-ins/JSON/stringify/replacer-wrong-type.js` (CE), `built-ins/JSON/stringify/value-array-proxy.js` (CE), `built-ins/JSON/stringify/value-symbol.js` |
| D | eval code early errors: `new.target` / `super` | 13 | `src/codegen/expressions/eval-early-errors.ts:foldedEvalEarlyError` has **no** NewTarget/SuperProperty rule (§15.1.1: SyntaxError unless direct eval inside non-arrow function code / method with [[HomeObject]]), so `eval('new.target;')` at global splices and evaluates instead of throwing; the positive case (`super.x` in direct eval inside a method, `super-prop-method`) mis-resolves after `Object.setPrototypeOf` | `language/eval-code/direct/new.target.js`, `language/eval-code/direct/super-prop-method.js`, `language/eval-code/indirect/new.target.js` |
| E | GlobalDeclarationInstantiation via `$262.evalScript` | 9 | `src/interp/eval-environment.ts` (#2928 interpreter, entered via `eval-inline.ts:emitStandaloneGlobalScriptEvalRuntime`): runtime-declared global `var`/function bindings miss §9.1.1.4.17/18 attributes (`configurable: false` — compare compile-time twin `src/codegen/global-var-bindings.ts`), no CanDeclareGlobalVar/Function checks, no HasRestrictedGlobalProperty SyntaxError, global `const` writes don't TypeError; several throw raw `[object WebAssembly.Exception]` that `assert.throws` can't brand-match | `language/global-code/script-decl-var.js`, `language/global-code/script-decl-lex-restricted-global.js`, `language/global-code/decl-lex.js` |
| F | Generators reached through module bindings | 8 (2 CE) | Import-aliased / default-export-expression generator calls bypass the native-generator instantiation path → returned value fails the brand check at `src/codegen/generators-native-consumer.ts:338` ("requires that 'this' be a Generator"); anonymous `export default function* () {}` never registers with `nativeGeneratorInfoForDecl` (keyed by name) → #680 CE at `src/codegen/function-body.ts:733` even for an empty body; `instn-uniq-env-rec.js` traps `unreachable` in `__gen_resume_sixth` | `language/module-code/instn-named-bndng-gen.js`, `language/module-code/eval-export-dflt-expr-gen-named.js`, `language/module-code/eval-export-dflt-gen-anon-semi.js` (CE) |
| G | eval statement-list completion values | 4 | Array/RegExp literals evaluated as an eval completion value (after a `class` decl) come back with `Object.getPrototypeOf(result) === null` — the `eval-inline.ts` completion-value boxing loses prototype linkage (compare `src/codegen/array-object-proto.ts` for the normal path) | `language/statementList/eval-class-array-literal.js`, `language/statementList/eval-class-regexp-literal.js` |
| H | Reference get/put on primitive bases | 4 | Accessors installed on `Symbol.prototype`/`Number.prototype` etc. are not consulted when the base is a primitive (`Symbol().test262` → `null` instead of running the getter with primitive `this`); `-realm` variants additionally need `$262.createRealm` | `language/types/reference/get-value-prop-base-primitive.js`, `language/types/reference/put-value-prop-base-primitive.js` |

A+B+C+D+E = 65/81 = 80% investigated to root cause; F likewise. Cluster B's
one CE (`own-property-keys-sort.js`) is a distinct parse defect: escaped
identifier exports (`export { x as μ }`) die in the TS parser with
"Keyword must not contain escaped characters".

## Implementation Plan

Work the clusters in table order (count descending) so partial completion
maximizes yield. Re-run the probe per cluster:
`npx tsx .tmp/run-standalone.mts --list <cluster-subset>`.

### A. `with` dynamic Object Environment Record — standalone Tier-2 (15)

1. In `src/codegen/with-scope.ts`, replace the standalone refusal seam
   (`withHasBindingImport` → `__extern_has`, deliberately refused by #1472)
   with a real Wasm-native HasBinding helper: emit a defined function
   `__with_has_binding_native(env, key) -> i32` that performs §9.1.1.2.1 —
   `HasProperty(env, key)` via the existing native MOP entry (`__extern_has`
   arm machinery in `src/codegen/object-runtime.ts`, which already dispatches
   proxies through `__proxy_call_has` from `src/codegen/object-runtime-proxy.ts`
   #3265), then, when true, `Get(env, @@unscopables)` and, if that is an
   object, `ToBoolean(Get(blockList, key))`. **The @@unscopables Get must run
   on every lookup** (the `*-binding-deleted-in-get-unscopables` tests count
   getter invocations and mutate the env inside the getter) — do not cache it
   at `with`-entry.
2. GetBindingValue / SetMutableBinding: re-run HasProperty at each access; a
   vanished binding falls through to the outer scope (sloppy) or throws a
   native ReferenceError (strict) — the `-strict-mode` twins assert exactly
   this. Route the write through the MOP set entry (`__extern_set` arm) with
   the **env object as receiver**, which is what the two #2046 CE tests need;
   coordinate with #2046 (in-progress) rather than re-implementing
   receiver-threading — if #2046's native `Reflect.set` receiver lands first,
   reuse its helper.
3. Abrupt completions: a throwing @@unscopables getter (`unscopables-get-err`,
   `unscopables-prop-get-err`) must propagate as a catchable JS exception —
   use the branded-throw helpers (`emitThrowJsError` pattern in
   `src/codegen/expressions/helpers.ts`), never a bare `unreachable`/raw exn.
4. `unscopables-inc-dec.js` (CE at the #1387 gate): once 1-2 exist, retire the
   #1387 diagnostic for this shape by routing identifier ++/-- inside `with`
   through the same get/set pair.
   Existing context: #1387 (Tier-1), #2663 (Tier-2, in-progress — check the
   claim ref before starting; if #2663's lane is active, this cluster belongs
   to them and this issue only covers the standalone seam), #3025, #4206,
   #4231, #4500.

### B. Module namespace exotic object (15)

1. In `src/codegen/module-namespace-value.ts:tryEmitCompiledModuleNamespaceObject`,
   drop the "every export is an immutable function" precondition. For mutable
   exports (`export var local1`), publish **live-binding accessors**: the
   module global holding the export is the cell; emit per-export getter
   closures reading the wasm global (pattern: `emitCachedFuncClosureAccess`
   already used in this file for function exports; accessor installation
   pattern: `__define_property`-with-getter as used by
   `src/codegen/builtin-ctor-own-props.ts` / the #4491 descriptor machinery in
   `src/codegen/global-var-bindings.ts`).
2. Make the object a namespace **exotic**: brand it (new brand global, the
   pattern of `array-carrier-brand.ts`/`builtin-prototype-brand.ts`) and add
   brand arms to the native MOP drivers in `src/codegen/object-runtime.ts`:
   [[Set]] → return false (TypeError in strict callers), [[Delete]] on an
   exported name → TypeError via `Reflect.deleteProperty`/`delete` (true only
   for non-exported), [[DefineOwnProperty]] per §9.4.6.12,
   [[PreventExtensions]] → true, [[IsExtensible]] → false, [[OwnPropertyKeys]]
   → exported names in code-unit sort order then @@toStringTag,
   [[GetOwnProperty]] → `{writable:true, enumerable:true, configurable:false}`
   for string keys, `{writable:false, enumerable:false, configurable:false}`
   for @@toStringTag = `"Module"`.
3. @@toStringTag: seed the branded object with the symbol-keyed constant
   (symbol-keyed property plumbing exists — see @@unscopables handling in
   `literals.ts` `@@`-prefixed field names).
4. `own-property-keys-sort.js` (CE): separate small fix — the escaped-
   identifier export (`export { x as μ }`) trips the TS scanner. Detect
   and pre-normalize escaped identifiers in export clauses in the ambient
   parse (`src/codegen/ambient-parse-import.ts`) or skip-list-free error
   recovery; do NOT fork the parser. If this proves deep, split it out — it is
   1 test.
   Existing context: #3494 (blocked, dynamic-import namespace records — do not
   duplicate its module-graph work; this issue covers only same-compilation
   `import * as ns from '<self>'`).

### C. JSON native codec: replacer / proxy / symbol (13)

1. Replacer gate (`src/codegen/expressions/call-namespace-static.ts` ~2462):
   accept **any** second argument. Compile it to externref and let the codec
   classify at runtime inside `__json_stringify_root_replacer`
   (`src/codegen/json-codec-native.ts`): IsCallable → function replacer,
   IsArray (through the existing native `Array.isArray` brand test) → build
   the PropertyList allowlist at runtime (ToString/number/String-object
   elements per §25.5.4 step 4.b.iii), anything else → ignore (compact path).
   This alone clears `replacer-wrong-type`, `replacer-array-wrong-type`, and
   converts the remaining replacer-array CE tests into runnable tests.
2. Proxy values: in `__json_stringify_value`'s object arm, route property
   enumeration and reads through the MOP entries (`__extern_get` /
   ownKeys-equivalent) instead of raw `$Object` field walks, so
   `__proxy_call_*` dispatch (object-runtime-proxy.ts) fires and a revoked
   proxy surfaces its TypeError (`value-object-proxy`, `value-array-proxy`,
   `*-revoked`). Array-proxy length comes from `Get(proxy, "length")`.
3. Symbols: add a symbol-brand arm → unserializable sentinel: `undefined` at
   the root, skipped in objects, `null` in arrays (`value-symbol`).
4. Abrupt getter completions (`value-array-abrupt`, `replacer-array-abrupt`):
   the MOP-routed reads from step 2 make thrown getter errors propagate; make
   sure the codec does not swallow them into `null`.
5. `JSON.parse(true)` etc. (`text-non-string-primitive`, CE `__get_builtin`):
   in the parse arm, ToString non-string primitives at compile time when the
   static type is known, else runtime `__tostring` before `__json_parse_text`.
   Existing context: #1599, #2166 (both done — this is their residual), #3725
   (keep the refusal STICKY for shapes still unsupported).

### D. eval early errors: NewTarget / SuperProperty / SuperCall (13)

1. Extend `foldedEvalEarlyError` (`src/codegen/expressions/eval-early-errors.ts`)
   with the §15.1.1 Contains rules. It needs caller context — thread two flags
   from the call site in `eval-inline.ts:tryStaticEvalInline` (which already
   computes strictness from `expr`): `inFunctionCode` (direct eval whose call
   site sits in non-arrow function code) and `hasSuperPropertyHome` /
   `hasSuperCallHome` (call site inside a method / derived constructor —
   walk `expr` parents for MethodDeclaration/constructor, the same walk
   `isStrictContext` does). Rules: eval source Contains `new.target` and NOT
   (direct ∧ inFunctionCode) → SyntaxError; Contains SuperProperty and NOT
   (direct ∧ home method) → SyntaxError; Contains SuperCall and NOT (direct ∧
   derived ctor) → SyntaxError. Indirect eval NEVER admits any of them
   (`indirect/new.target.js`, `indirect/super-prop.js`). Emit via the existing
   `emitThrowJsError(ctx, fctx, "SyntaxError", …)` seam — the tests catch and
   check `caught.constructor === SyntaxError`.
2. `global-code/new.target-arrow.js`: `new.target` in a global-scope arrow is
   a Script early error — compile must reject before evaluating ("This
   statement should not be evaluated" means we ran it). Add the same Contains
   check to top-level arrow bodies at Script goal (site:
   the meta-property lowering in `src/codegen/expressions/` — grep
   `MetaProperty` — currently defaults to undefined).
3. Positive case `super-prop-method.js`: the splice must resolve `super.x`
   against the *live* [[HomeObject]] prototype (the test mutates it with
   `Object.setPrototypeOf` between calls). Verify the spliced super lowering
   uses the runtime proto walk, not a compile-time snapshot; fix in the splice
   super path if snapshotted.
4. `indirect/lex-env-heritage.js` and `indirect/realm.js` ride the #2928
   interpreter (indirect eval env semantics); fix there only if cheap,
   otherwise note as #2928 residue.
   Existing context: #1163 (splice), #2928/#2929 (in-progress — the
   interpreter lane; coordinate, do not fork the interpreter), #2960, #1073.

### E. Interpreter GlobalDeclarationInstantiation (9)

All reach the #2928 interpreter via `$262.evalScript` /
`emitStandaloneGlobalScriptEvalRuntime`. Fix in
`src/interp/eval-environment.ts` (GlobalDeclarationInstantiation is already
partially there, ~L765):
1. CreateGlobalVarBinding / CreateGlobalFunctionBinding: define the realm
   property with `{writable:true, enumerable:true, configurable:false}` —
   mirror the compile-time twin `src/codegen/global-var-bindings.ts` (#4491
   T4), which documents the exact descriptor bit layout for
   `__defineProperty_value` (`script-decl-var`, `script-decl-func`).
2. CanDeclareGlobalVar/Function preflight: existing non-configurable,
   non-writable-or-non-enumerable property → TypeError
   (`script-decl-func-err-non-configurable`); non-extensible global without
   the own property → TypeError (`script-decl-lex` currently throws the RAW
   "not extensible" error at the wrong step — lexical bindings must NOT touch
   the global object at all).
3. HasRestrictedGlobalProperty: `let undefined`/`NaN`/`Infinity` at global →
   SyntaxError (`script-decl-lex-restricted-global`, `decl-lex-restricted-global`).
4. Lexical/var collision checks both directions → SyntaxError
   (`script-decl-var-collision`, `block-decl-strict`).
5. Global `const` assignment → TypeError (`decl-lex`).
6. Brand every one of these throws as a proper JS error object the compiled
   `assert.throws` can match — the two `[object WebAssembly.Exception]`
   failures are unbranded raw exns escaping the interpreter boundary.

### F. Generators through module bindings (8)

1. Import-aliased calls (`import { g as g2 }`; `g2()`): in the identifier-call
   path of `src/codegen/expressions/calls.ts`, resolve the callee through the
   alias to its declaration (`ctx.oracle.valueDeclarationOf` +
   aliased-symbol walk, the same dance `module-namespace-value.ts:
   namespaceFunctionExports` does) BEFORE generic closure-call lowering, so an
   aliased generator takes the exact same native-generator instantiation path
   as a direct `g()` call and returns a branded generator
   (`instn-named-bndng-gen`, `instn-iee-bndng-gen`,
   `instn-named-bndng-dflt-gen-named`).
2. Default-exported generator *expressions*
   (`export default (function* gName() {...})`): register the function
   expression with the native-generator scanner
   (`src/codegen/generators-native-ast-scan.ts`) so its call sites get the
   branded path (`eval-export-dflt-expr-gen-anon/-named`; the `-named` test
   also asserts `g.name === 'gName'`).
3. Anonymous `export default function* () {}` CE: `nativeGeneratorInfoForDecl`
   (`src/codegen/function-body.ts:726`) is name-keyed and misses unnamed
   decls; key registration by declaration node (the #3505 decl-aware lookup
   already exists — extend it to synthesize the `*default*` name)
   (`eval-export-dflt-gen-anon-semi`, `instn-named-bndng-dflt-gen-anon`).
4. `instn-uniq-env-rec.js`: `unreachable` trap in `__gen_resume_sixth` —
   reproduce with 6+ generator declarations in one module; likely a state-
   machine index collision in `src/codegen/generators-native.ts`. Diagnose
   before patching.
   Existing context: #680 (native generator scope), #1665, #3505.

### G + H (tail, 8 tests — take only if the wave has budget left)

- G: fix the eval completion-value boxing in `eval-inline.ts` to preserve
  Array.prototype / RegExp-proto linkage (`src/codegen/array-object-proto.ts`
  has the linkage helper).
- H: route property get/put on primitive bases through the boxed-prototype
  accessor lookup (`src/codegen/boxed-proto-valueof.ts` and
  `builtin-proto-member-override.ts` show the prototype-borrow pattern); the
  `-realm` twins additionally need `$262.createRealm` and may be deferred with
  a note.

### What NOT to do

- **No new host imports without a standalone fallback** — the runner fails any
  module emitting `env::*` (`standaloneHostImportError`). Everything above is
  pure-Wasm; host-mode fast paths are optional extras.
- **Never edit** `tests/test262-runner.ts` skip lists, `scripts/*baseline*.json`
  (main is its sole writer), or `HANGING_TESTS`.
- New codegen needing type info goes through `ctx.oracle`
  (`src/checker/oracle.ts`) — raw `checker.getTypeAtLocation` trips the
  oracle-ratchet gate. Note the existing raw-checker call in the replacer gate
  (call-namespace-static.ts `getCallSignatures`) predates the gate; do not add
  new ones.
- Do not fork in-flight lanes: #2928 (interpreter), #2663 (`with` Tier-2),
  #2046 (Reflect receiver) are claimed/in-progress — run
  `node scripts/pre-dispatch-gate.mjs 5157` and check the claim ref before
  starting clusters A/D/E; coordinate or narrow scope to the standalone seams.
- Keep the #3725 sticky-refusal discipline: a shape the codec still cannot
  serialize must refuse loudly at compile time, never compile to a trapping
  module.

## Acceptance criteria

- All 81 tests in `.tmp/es2015/wp-modules-eval-with-current-fails.txt` pass
  via `npx tsx .tmp/run-standalone.mts --list …` (partial completion:
  clusters land in table order, each cluster's tests pass before moving on).
- Every test in `.tmp/es2015/wp-modules-eval-with-passing-spotcheck.txt`
  (40 currently-passing neighbors) still passes.
- Ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`.
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## Results (wave 1, 2026-08-28)

Target list `.tmp/es2015/wp-modules-eval-with-current-fails.txt`:
**81 failing before → 75 failing after** (16 compile_error / 59 fail; **+6 pass**).
Spotcheck `.tmp/es2015/wp-modules-eval-with-passing-spotcheck.txt`: **37 pass /
3 fail, unchanged** — the 3 (`module-code/early-export-unresolvable.js`,
`module-code/early-strict-mode.js`, `namespace/internals/has-property-str-not-found.js`)
already failed at the branch point, so the guard baseline is 37, not 40.

### Cluster D — eval early errors (landed, 6/13)

`src/codegen/expressions/eval-early-errors.ts` gained the §15.1.1 `Contains`
rules for NewTarget / SuperProperty / SuperCall, plus `evalCallerCapabilities`,
which classifies the *call site* (the fact the eval source cannot know) and is
threaded from `eval-inline.ts:tryStaticEvalInline`. `Contains` is modelled
correctly: it does not descend into ordinary function forms or class bodies, but
does descend into arrow functions.

Now passing: `eval-code/direct/{new.target, new.target-arrow, super-prop,
super-prop-arrow}.js`, `eval-code/indirect/{new.target, super-prop}.js`.

Still failing in D, with root causes established:

- `direct/super-prop-dot-no-home.js`, `direct/super-prop-expr-no-home.js` — the
  SyntaxError IS now thrown, but `caught.constructor` reads **null** whenever the
  read happens inside a function body (it is correct at global scope). Reproduced
  independently of this issue's subject: any error caught inside a function loses
  its `.constructor` back-pointer on the dynamic read path. Pre-existing, general,
  and worth its own issue — see Follow-ups.
- `direct/new.target-fn.js`, `direct/super-prop-method.js` — the POSITIVE cases.
  They need the spliced `new.target` / `super` to resolve against the caller's
  live [[NewTarget]] / [[HomeObject]], which the splice does not yet carry.
- `global-code/new.target-arrow.js` — Script-goal early error, not eval. Hooking
  the rule into the `MetaProperty` lowering in `expressions.ts` was tried and
  **does not fire**: the offending arrow is never called, so its body is never
  compiled and the meta-property expression is never visited. The check has to
  live in a whole-SourceFile prescan (the `scanForNewTarget` pass is the natural
  host), not in expression lowering. Backed out rather than shipped inert.
- `indirect/lex-env-heritage.js`, `indirect/realm.js` — #2928 residue.

### Clusters attempted and deliberately NOT landed

- **E (interpreter GlobalDeclarationInstantiation, 9 tests) — the plan's premise
  is stale.** `$262.evalScript` does NOT reach `src/interp` on this head: the
  runner reports `runtime-eval tier: QUICKJS … DEFAULT engine (#4242)`, so these
  tests run on the QuickJS adapter. A complete, spec-correct `src/interp` fix
  (D=false `configurable` for CreateGlobalVar/FunctionBinding §9.1.1.4.17/18 plus
  HasRestrictedGlobalProperty §9.1.1.4.14) was written and measured: **zero
  change** to all 9 tests. It could not be validated on the interpreter engine
  either (`JS2WASM_EVAL_ENGINE=interpreter` fails to instantiate — the
  interpreter provider artifact is not built in this container), so it was
  reverted rather than shipped unexercised. Cluster E must be re-scoped onto the
  QuickJS adapter's global-object bridge.
- **C (JSON) — reverted to preserve the #3725 sticky refusal.** Accepting a
  provably non-callable, non-Array replacer (§25.5.2 step 4 ignores it) turned
  `replacer-wrong-type.js` from compile_error into a *wrong-answer* fail, because
  the underlying compact path is itself broken: `JSON.stringify({key: [1]})`
  already returns `"null"` in standalone with **no replacer at all**. Converting
  a loud refusal into a silent wrong answer for zero test gain is the exact
  failure mode #3725 exists to prevent, so the change was backed out. Fix the
  nested-array-in-object codec bug first; the replacer gate then becomes a
  one-line follow-on.

### Follow-ups (not started)

1. **`JSON.stringify({key: [1]})` returns `"null"` in standalone.** Silent wrong
   answer on the plain compact path, no replacer involved. This is the blocker
   under most of cluster C, not the replacer gate.
2. **`err.constructor` is null when the read site is inside a function.** Correct
   at global scope. Blocks 2 cluster-D tests and plausibly a much wider set of
   `assert.throws` shapes.
3. **Cluster E re-scope**: move the GlobalDeclarationInstantiation attributes
   (`configurable: false`, HasRestrictedGlobalProperty, CanDeclareGlobal*
   preflight, global-`const` TypeError) onto the QuickJS runtime-eval adapter.
4. **Cluster A / B / F / G / H untouched** — A (`with` Tier-2, 15) and B (module
   namespace exotic object, 15) are each a full wave; F's diagnosis is
   unfinished (probe files placed outside `test262/test` compile under a
   different category and trap spuriously — do not trust out-of-tree generator
   probes); G rides the QuickJS completion-value boundary, not `eval-inline`
   boxing.

## References

- `with`: #1387, #2663 (in-progress), #3025, #4206, #4231, #4409, #4500
- Reflect receiver: #2046 (in-progress)
- JSON: #1599, #2166, #3725
- eval: #1163, #1164, #2928/#2929 (in-progress), #2960, #1073, #1066
- Global object: #4205, #4489, #4491 (T4), #4394
- Generators: #680, #1665, #3505
- Modules: #3494 (blocked), #1074
- Standalone gates: #1472, #2961 (host-import detection)

## 2026-10-04 — F naming-only follow-up: default-export function names

### Bounded scope and dispatch state

This continues **5157 “ES2015 standalone: modules-eval-with conformance wave 1”**
without closing the issue or reassigning its other clusters. It cross-references
the residuals of **6834 “Test262: route entry-only default and named self-imports
through the module graph”**; that runner repair and its measured gains remain
unchanged. No new issue number, graph/fixture change, generator implementation,
IR change, import-assignment repair, or source outside the two files below is
part of this leaf.

Implementation base: fetched upstream
`32a6ee7016b5fb5ea04bc36810ddf0e8c7411c50`, independently matched by one-shot
server read (session 35421, exit 0). Historical wave commit
`c39bb667c5a28752d8b3517ad0e3f099b0f9d112` is an ancestor; it does not implement
this residual. The PR-number merge hit `fda3d27e` is not issue completion.
The planner's checkout remains 247f and has no production edits; both proposed
files are byte-identical from diagnostic base b8c9 through 247f to 32a6.

Fresh maintained pre-dispatch session 88163 exits 1/STOP. Do not call it CLEAR:
it finds PR6246 and references in 3522, 4444, 5271 and 6651. It also reads
stale `origin/main` and the repository alias, so its “no issue on main” is
superseded by the actual upstream in-review MD and positive repository query
`loopdive/js2`. Fresh leaf read session 49065 exits 0/UNASSIGNED for
`5157:default-export-function-name`. No claim was attempted by this planner.

One-shot live PR search returns only **6246, “fix(eval): stage arguments before
runtime snapshot”**, branch `codex/5157-eval-spread-arguments`. Its exact files
were read successfully: eval-argument-list, eval-inline, runtime-eval-provider,
compiler-boundaries JSON, its fixture, and this issue MD. Neither naming source
file is present. There IS a documentation overlap: preserve its 803-line issue
addition during transfer/merge; never replace this issue with an old full copy.

Server and maintained reader agree on registry tip
`2828e241b2c8cb914e23615ec15d1785f125dcf2`. Raw parent 5157 is reserved with
empty assignee, write `9887-btq1t3c2`; only existing sibling is
`5157-eval-spread-arguments`, held by `ttraenkler/codex-eval-spread-arguments`,
write `98610-cb9vslru`. The proposed naming leaf is absent. Root must claim it
without force for `ttraenkler/es2015_module_names_sol`, intended branch
`codex/5157-default-export-function-name`, and verify the raw effect before GO.
This paragraph records preclaim observations, not a current assignment.

Root subsequently accepted the narrow overlap adjudication and performed the
maintained claim: session 95968 terminal exit 0, server/raw registry tip
`9b7755124b0a953148a7177bfa70073c88a036e9`. Leaf record
`5157-default-export-function-name` has actor
`ttraenkler/es2015_module_names_sol`, branch
`codex/5157-default-export-function-name`, claimed `2026-10-04T14:41:50Z`,
write `30533-ooi66w2x`. No foreign record was borrowed or changed. This is
root's raw-effect verification. Separate implementation checkout
`.codex-worktrees/5157-default-export-function-name-sol` is ready at32a6
(creation session64706 terminal exit 0). Source-work GO still follows root's
read of this full plan; heavy execution remains separately leased.

Overlap adjudication proposed to root:

- 3522's citation expressly says the 5157/5158 plans were unrelated and did not
  touch its classes/closures compile-once surface. No IR rewrite is proposed.
- 5271 references earlier waves, eval and class declaration naming; current
  own-arguments-iterator work edits different files/functions. Preserve it.
- 4444/6651 are umbrella and historical F-family tracking, not proof that the
  precise two name producers are dispatched. 6651 remains positively held by
  `ttraenkler/project-thread-yhj9pp`, write `11530-bzpj3qae`.
- 2864's positive foreign claim (`ttraenkler/fable-es2015`, write
  `5230-tknq0syo`) owns physical generator carrier/protocol work. The observed
  failures below occur after successful generator value assertions, at static
  name constants. No generator factory/resume/carrier file is in this leaf.
- 6834's old implementation record remains held; do not borrow/release it.
  Its residual source attribution is evidence, not assignment of this leaf.

The human confirmed parallel IR does not touch our code; exact two-file source
assignment and the above gate adjudication still belong to root's dispatch.
Any genuine same-function overlap discovered later stops implementation.

### Original evidence and first-loss attribution

Frozen canonical run `20261003-212238` at247f records both originals FAIL,
`reached_test: false`, `[object WebAssembly.Exception]`. Keep those canonical
fields; richer earlier diagnostic assertions are not replacement verdicts.
The full run is 11,476 PASS / 286 FAIL / 16 compile errors of frozen11,778;
this plan does not update that census. JSONL SHA256:
`a97734704658c8b040bfa53650f8d47ef50c79fbf59b1e45202ad987fd5389c6`.

- `test/language/module-code/eval-export-dflt-expr-gen-anon.js`: generator
  value24601 assertion precedes `g.name === "default"`; observed name is `g`.
- `test/language/module-code/instn-named-bndng-dflt-gen-named.js`: hoisted
  generator value23 assertion precedes `g.name === "gName"`; observed name
  is `default`.

Retained b8c9 attribution lives read-only at
`.codex-worktrees/6834-module-residual-attribution/.tmp/6834-residual/`.
`attribution.md` SHA256
`8a07d1fd2c37cb4addce0fcb04180e3e7b23f62729206cbf216605756724b06b`;
`wat-receipts.json` SHA256
`51bff6f2623fea639905effa7c36c25ad619b9454e68b1ac401bb966380b3714`.
Original anonymous-expression WAT291842–291848 passes constants `g` versus
`default` to the assertion; named-declaration WAT290147–290153 passes
`default` versus `gName`. Tiny import-free probes separately reproduce these
wrong answers. No fresh32a6 execution has occurred for this planning task.

`property-access-dispatch.ts::tryLengthAndNameReads` name branch3241+ reads
the callable type symbol at3320, clears the `__function` artefact, then falls
back to the receiver identifier at3336+. The exported declaration/value name
is not that type symbol or import alias. This is the proven first emitted
wrong answer for both original assertions, not a generator state-machine loss.

`function-instance-meta.ts::fnInstanceNameOf` (415+) is a second required
production seam: named declarations/expressions already preserve their source
name, but anonymous default declarations and ExportAssignment initializers
lack default naming. A fold-only decline may expose empty reflective metadata.
Earlier probes did not measure all reflective forms; that obligation is open.

### Semantics and exact two-file implementation

ES2015 [export evaluation §15.2.3.11](https://262.ecma-international.org/6.0/#sec-exports-runtime-semantics-evaluation)
assigns default naming to anonymous function definitions, not arbitrary exported
values. [Generator instantiation §14.4.12](https://262.ecma-international.org/6.0/#sec-generator-function-definitions-runtime-semantics-instantiatefunctionobject)
preserves an explicit binding name and names anonymous default declarations
`default`. [SetFunctionName §9.2.11](https://262.ecma-international.org/6.0/#sec-setfunctionname)
defines a nonwritable, nonenumerable, configurable own name. These primary
algorithms were fetched/read for this plan.

1. **`src/codegen/function-instance-meta.ts::fnInstanceNameOf` only:** keep
   explicit-name and synthesized-eval precedence. Add the exact anonymous
   default-function declaration case and the anonymous function-expression/
   arrow initializer directly belonging to a non-export-equals ExportAssignment.
   Reuse the existing parentheses-only parent walk. Do not walk through comma,
   call, assignment or identifier wrappers or rename an already named value.
   Do not broaden class/member semantics or add another module producer.
2. **`src/codegen/property-access-dispatch.ts::tryLengthAndNameReads` only:**
   stop publishing checker/import spelling as a value's observable name.
   Prefer declining the module-import name fold to the existing ordinary read,
   identified by actual import declaration identity, before string emission.
   Existing `ctx.oracle.valueDeclarationOf` and `ctx.importBindingTargets`
   are available read-only precedents; never mutate alias registries or make
   a text-name-based special case. If retaining any exact fold, prove both the
   source function identity and absence of observable name overrides/effects;
   an import being immutable does NOT make its function object's name immutable.
   Preserve normal receiver evaluation, current binding value and runtime
   descriptor/getter behavior. Unknown aliases must not be guessed as default.

Existing runtime read must be exercised before accepting the decline. If an
escaping alias still hits a bad fold or metadata cannot be consumed without
another production seam, report the exact blocker; do not weaken cases or
silently extend scope. Namespace keys, import-write TypeErrors, generator
carriers, source-unit identity, parser and IR work remain outside this repair.

Reader/mutator audit within the two-file boundary: fnInstanceNameOf feeds
fnInstanceMetaOf→fnMetaSlot→prepare/materialize metadata. Closure consumers are
arrow-phases, funcref-as-closure and method-trampolines. Runtime observers are
function-instance-meta-arms and function-instance-props (ordinary get, own
descriptor, own names, hasOwnProperty). class-static-metadata is another direct
reader and must retain existing class behavior. Descriptor redefine/delete
and property getters must override initial metadata through existing machinery.
No new shared structure, context field, metadata layout or function identity
registry is proposed. None of these reader files is authorized for editing.

The frontmatter allowances added here are this leaf's own finite semantic
growth in the two functions, not use of eval's allowances. Small pure predicate
factoring inside these files is permitted only to express this same guard;
no unrelated refactor. Proposed new fixture, absent at planning check:
`tests/issue-5157-default-export-function-name.test.ts`, for root to assign
separately. Recommend GPT-6.1 Sol High in an isolated implementation worktree.

### Acceptance and removal-controlled measurement

- [ ] Root accepts overlap adjudication, verifies its new leaf claim raw, assigns
  the two source functions and new fixture, transfers this append-only patch
  while preserving PR6246's pending documentation, then issues source-work GO.
- [ ] Obtain the serialized heavy lease before baseline/build/test execution.
  Fresh own compiler/runtime bundles on32a6; pinned provider fingerprints and
  maintained provider canary. No donor build/cache substitution.
- [ ] Matched maintained four-original baseline/candidate/removal set: both
  failing originals above plus
  `test/language/module-code/eval-export-dflt-expr-gen-named.js` and
  `test/language/module-code/instn-named-bndng-dflt-gen-anon.js` (frozen PASS,
  reached_test true). Keep complete original bytes, graph identity, original
  harness, honest oracle14/auto and the frozen11,778 membership. Require exact
  v2 identities/callback settlement, zero exclusions and terminal audit.
- [ ] Runtime fixture verifies declaration/expression named precedence;
  anonymous generator/function/arrow default forms; nested parentheses versus
  comma, call and identifier exports; multiple aliases/re-exports and escaped
  values; callable results, identity and initialization count unchanged.
- [ ] Dot, bracket and Object.getOwnPropertyDescriptor reads agree, including
  own descriptor attributes. Redefine/delete name and accessor overrides are
  respected with exact getter/evaluation counts and thrown exception identity.
  Include local named/anonymous functions, lexical shadows, named classes and
  existing synthesized-eval name as positive non-module controls. Never count
  both sides being undefined or a skipped read as success.
- [ ] Existing focused function-name/length and relevant module tests remain
  passing across applicable standalone/host/WASI lanes; no newly introduced
  host failure is waived. Diagnose pre-existing failures with matched evidence.
- [ ] Inspect original physical imports. Prior full original binaries contain
  four approved js2wasm:runtime-eval functions (apply-interpreted, indirect,
  script and direct eval), not an empty import list. Preserve existing policy
  and pinned canary; zero forbidden imports, no added host seam or late import
  shift workaround. Keep canonical reached_test unchanged as a reporting rule.
- [ ] Remove only this leaf in an isolated matched source copy and rebuild:
  recover fresh baseline name failures with both positive originals unchanged.
  Restore and rerun the shipped candidate, with any instrumentation removed.
  Record exact hashes, source/provider immutability and before/after rows.
- [ ] Report only measured original gains. No predicted +2, whole5157 closure,
  6834 gain recount, or revised full-census claim. Root owns publication and
  release of this leaf on completion/standdown; foreign claims remain untouched.

Planning acceptance is a saved source-backed handoff, not implementation or
runtime acceptance. All execution boxes remain open pending root dispatch.

### 2026-10-04 naming leaf implementation and measured handoff

This appendix records only `5157-default-export-function-name`, on isolated
branch `codex/5157-default-export-function-name`, base
`32a6ee7016b5fb5ea04bc36810ddf0e8c7411c50`. The umbrella remains open/in-review;
IR/carrier work and other claims are separate. Root adjudicated the exact two
functions before dispatch, verified the leaf claim in authoritative registry
commit `9b7755124b0a953148a7177bfa70073c88a036e9` (terminal 0), and retained
publication/release ownership. No foreign claim was changed. Preserve the
pending PR6246 shared-document addition during later integration.

Implementation is 14 added lines in `fnInstanceNameOf`, 42 added lines in
`property-access-dispatch.ts` (including the bounded local helper), and the new
44-case fixture. No runtime, generator, IR, runner, corpus, configuration or
semantic-provider source changed.

- Anonymous default function/generator declarations and directly exported
  anonymous function/arrow expressions receive `default` metadata. Explicit
  source names win. Only parentheses are transparent for export-expression
  naming; comma, call, identifier and assignment exports retain their actual
  values' existing names. Synthesized Function-constructor `anonymous` stays
  ahead of this inference.
- Imported callable name reads decline the checker-spelling fold on standalone
  and use the existing current-value property path. Immutable import bindings
  do not freeze a function object's own configurable name. The local helper
  follows initializer/import declaration identity with a visited-declaration
  Set, repeatedly unwraps property/element receivers at each alias step, and
  recognizes escaped default-definition identity. It mutates no shared map.
- Root approved the standalone boundary because the existing metadata carrier
  is standalone-only. Existing gc/host and WASI name routes are preserved;
  metadata/carrier expansion is outside this leaf. The callable-signature
  condition excludes imported classes from the new decline. This is not a
  changed expectation or a fixture/corpus waiver.

Reader/mutator audit: the producer feeds `fnInstanceMetaOf`, slot preparation
and materialization, arrow phases, funcref-as-closure and method trampolines.
Existing runtime function-instance metadata/property arms consume the name for
Get, own descriptors, own keys and hasOwn; class-static metadata also reads the
producer but the new producer cases are function-only. Existing Define/Delete
and accessor machinery remains the authority for overrides. No additional
metadata cache, interning key, runtime carrier or mutation writer was added.
Independent source review found no actionable issue, confirming termination,
explicit-name precedence and class/host boundaries.

#### Scope refinements and limits (not completeness claims)

The unchanged broad diagnostic retains correct expected values in all three
lanes. Its 79 cases are 13 producer cases plus 22 runtime cases per lane:
baseline 17P/62F, candidate 35P/44F, with zero oldP-to-F. The breakdown is
producer 8-to-13P/13; gc 3-to-3P/22; standalone 5-to-18P/22; WASI 1-to-1P/22.
This diagnostic was measured before the final callable-class guard and repeated
alias receiver unwrapping. Later shipped-source class and focused controls
verify those changes; the earlier 79-case result is not relabeled as a fresh
final-source run. Retained immutable diagnostic source SHA256 is
`1bd1c778917520cfc1f559ba705a0e73c5bd927b949e8fb81b871f1f72cc0f65`.

Three typed mutation variants still generate invalid Wasm on both sides:
combined redefinition/deletion/getter/effects, initialization-time redefinition,
and a getter returning a string. The unchanged sources and actual failures are
retained in `fixture-base-8.json` / `fixture-candidate-8.json` and their logs.
The validator reports a reference where i32 is required (refs 40/41); these
are not passing cases and were not removed from an original manifest. The
tracked fixture instead tests supported evolving-any observations (`let
observer; observer = fn`) for redefinition, deletion, descriptors and exact
getter/evaluation counts. Those observations are a different path and were
already baseline passes; they do not prove the typed mutation defect repaired.
The separate typed imported getter throwing an object *does* move from fail
to pass with exact object identity and one receiver/getter evaluation. Typed
escapes that lose both binding and default-definition provenance are not
universally covered by this bounded predicate.

Named-default generator namespace identity is a separate existing carrier
failure: independent baseline and candidate probes, with no preceding name
checks, both return 90 against unchanged expected 1, source SHA256
`dd7299328567fc5d96f74104e26d8e782890dacafe1cd3fbd305d83373125855`, and
identical binary SHA256
`a7f40483ced8c00bf9e1e0eb0218f3d466b28fcd5da87b1cb6d2206378b09340`.
Both probes compile successfully with no imports; execution receipts/WAT are
retained. Clean named-generator alias/re-export/namespace *name* reads are
tested independently and pass, without unrelated descriptor mutation masking
the fold. Generator carrier repair remains separate (including #2864).

Independent imported-class probes use the same correct expectations on both
sides: regular named exported class and anonymous default class pass in all
three lanes (6P); named default class still returns 90, expected 1, in all
three lanes (3F). All nine compile, and baseline/candidate binaries are
identical per case. `class-baseline.json` / `class-candidate.json` retain the
sources/hashes; named-class diagnostics are not shipped as permanently failing
new regression tests or represented as class completion.

#### Original attribution, frozen denominator and provenance

Own scratch directory: `.tmp/5157-names-32a6`. Each arm has `launch.mjs`
preflight/log/exit, `audit.mjs` audit, exact source fingerprints, JSONL and v2
completion receipt. The maintained runner is unchanged. Canonical Node is
v24.19.0; worker 512MiB, fork parent 1024MiB and provider prebuilder 3072MiB;
one worker/pool, exact single shard, standalone/auto, oracle 14/honest, history
publication disabled. All builds/execs used the root's serialized heavy lease.
Existing canonical dependencies were symlinked, not installed. The inherited
Acorn LFS artifact dirt is unrelated and not staged; maintained status probing
hits its existing LFS permission error then correctly builds in this own
worktree. No shared Git configuration was changed.

Five-original manifest SHA256:
`8ee61130c6983699d81df5cf52e8d4c9b8931c21e91727a69de50b0cb7f99c6f`.
Every original body is unchanged against canonical Test262
`b363f29d3c43c626dc852744ad64a0b48a003693`. The two targets are
`eval-export-dflt-expr-gen-anon.js` and
`instn-named-bndng-dflt-gen-named.js`; controls are
`eval-export-dflt-expr-gen-named.js`,
`instn-named-bndng-dflt-gen-anon.js`, and `Math/sign/length.js`.

- Fresh original baseline `20261004-165157`: terminal 0, 3P/2F of 5. Both
  targets fail with `[object WebAssembly.Exception]`, reached_test false;
  controls pass/reached true. Initial 7619-file graph stayed unchanged.
- Exact shipped candidate `20261004-172653`: terminal 0, 5P/0F of 5, all
  reached true. JSONL SHA256
  `33b9fd1778987ab6cade2e2f578e95e0126fd3ff1fffe48cc55507e66198e65e`;
  v2 completion SHA256
  `888d2fd21047eeb168e5d6fdc7aff961e55e2231906ba7050649255a17961673`.
- Removal `20261004-173716`: only the two production changes reverted;
  unchanged final fixture retained. Terminal 0, exact 3P/2F and original
  reached/error values recovered. JSONL SHA256
  `ef1d45df22310e9acbb850b60a0d43fe95c9ffec1d501d9b4efae019227f0398`;
  v2 completion SHA256
  `2909985361d747d1ec129222852f2424c5eae801633b5b9eb61a588f74471c46`.
- Restoration `20261004-173838`: exact shipped sources restored, terminal 0,
  5P/0F, all reached true. JSONL SHA256
  `a2c5df546cdba0e5cb73b2a051cd5a6313d976eeec01589cd866add56774cd90`;
  v2 completion SHA256
  `844ed7ca0d011a24e3b6b8af9945c83d44f4068d67af974cda041d4d1acdf338`.

All candidate/removal/restored arms fingerprint 7620 source/input files,
unchanged during each arm. Each v2 receipt has exactly five registered tests,
rows, canonical verdicts and started/settled callbacks, all settled, zero
official/proposal exclusions. No original assertion, reached-test rule,
oracle, provider policy or manifest was weakened. Removal/restoration proves
two *measured original gains*, separate from fixture gains. The frozen full
11778 census remains 11476P/286F/16CE; no full recount or completion inferred.

Final production SHA256: `function-instance-meta.ts`
`d764d022ae8922839ec39f7ea38a7cfc46ec72faf1190e85e340b6b3898c39a7`;
`property-access-dispatch.ts`
`432c8fb973fa1cc26edad8b260c09b89b74355c86125b31079d97cb19f0cb758`.
Removal recovered exact base hashes `6e41de6649258f47e13897c52846bd8ad854833d002b6c47d478e1b3e8a3f300`
and `4f8077a97d7f7d1e91ea05ce1642d51afc2b9977c773e9cb8078551fdcdc3bba`.
Final fixture SHA256:
`201f8c39080e64e87b9c7030100267137b740b3c87c713715d43aa06f7fb4c98`.

Baseline/removal compiler bundle SHA256
`6a2dd8ab2b4cf6d4316065e23d520f95215bb2779fc99de05c355bc2b84828cf`,
runtime `3e82a345bf6801b87824fe5791773571e22d5da072eb3a847a02a2e1f1421331`;
shipped/restored compiler
`196ac7aaee014fb6cb255879c6b90806d252e51a328743995c7767b92276f176`,
runtime `9b8cc22eb81999b8307cbbf85f78c3e7750c82f38b601790fa397e3a0145afbf`.
Every arm freshly rebuilt its own provider with a cache MISS and passing
canary. Removal key `01c0c9572eaea8c2` canary 2112ms; restored key
`ade0a4e5df7990d3` canary 2094ms. Own cached adapters were recoverably retained
outside own cache before rebuilding, never deleting shared canonical artifacts.
Their actual byte-identical Wasm SHA256 is
`fa105724f9d2379e2ffe420e3bf3df925f3108a422039a94a67db2a407ee4c54`.
Pinned QuickJS lib SHA256
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`, ABI
`0aab187dade1dfc988d5054bc54b4b04f2ad14dae0fb897b4b660b5d8bb028a9`,
build-info `4c50336591f72414a9798a997277641725e4dd484d6c547c6cf8c2c6093b0178`
are verified identical in canonical and own artifacts before/after each arm.

Retained `physical-candidate-shipped.json`, `physical-removed.json` and
`physical-restored.json` compile all four untouched originals with their real
harness/source graph and own corresponding bundles. Every binary imports
exactly the existing four approved `js2wasm:runtime-eval` functions
(`__runtime_apply_interpreted`, `__runtime_indirect_eval`,
`__runtime_script_eval`, `__runtime_direct_eval`). No env imports, added host
seam, new import policy or carrier-index workaround.

Final fixture removal measured 25P/19F of 44, neighboring #4437 19/19P,
using identical fixture and correct expectations. Shipped candidate measured
44/44P and #4437 19/19P. Fixture gains are not Test262 census gains. Final
restored-source focused run terminal 0: 44/44 naming fixture, 19/19 #4437,
24/24 #4436 and 12/12 equivalence/function-name-length (99/99 overall), plus
separate descriptor-accessor-name #6651-b18 7/7, terminal 0. The first final
multi-file command contained an incorrect descriptor filename, which Vitest
did not select; the separate correctly named run supplies the actual seven
descriptor results, not an assumed combined 106-case result. Restored fixture
JSON SHA256 `103be3c1c690d0eb8cddb4930edf5c8863d35ea2c106a90d2171800b0eea6d47`,
removal fixture JSON `66d8b594c502b49b4faf51c35ebf8fd5abbfa0feaffa93482ac0c34c0ed019c8`.

Final LOC, function, coercion and oracle ratchets exit 0 on this exact source.
LOC grants are +14/+42; function grants +14/+9, helper below ceiling; no new
checker or coercion vocabulary. Prettier check on both sources, new fixture
and this document exits 0. Preservation-contract dead-exports command exits
0: core nodes 12/12, core types 10/10 and preservation witnesses 6/6. Its
separate strict modeled closure remains OPEN/FAIL because of existing
nonliteral imports in `src/optimize.ts` and
`src/runtime/platform-capability-adapter.ts`; no retirement/deletion
certification or whole-graph success is asserted.

Acceptance adjudication: this standalone naming leaf is ready for root's
publication review, with two causally attributed original gains, independent
new-name acceptance and retained old positives. The umbrella, typed mutation
validator defects, generator namespace identity and named-default class naming
remain unresolved, explicitly not waived or counted as completed. Existing
umbrella status/PR attribution is preserved. Publication and claim release
still require root GO and normal hooks; no commit/push/PR performed yet.

## 2026-10-04 P1 inactive Script producer implementation record

This leaf is assigned by root to `ttraenkler/script_plan_p1_sol` (GPT-6.1 Sol,
high effort) in the new isolated worktree
`.codex-worktrees/5157-script-plan-producer-p1-sol`, branch
`codex/5157-script-plan-producer-p1`, exact base
`fdb116928b5861fd628abfde95da5e3deb91f689`. Claim
`5157:script-plan-producer-p1` was acquired and verified by effect on
upstream/issue-assignments, actual exit0; no foreign claim was taken.

Root's exact source grant covers new private producer wrappers/registry and
cleanup helpers in `qjs_shim.c`, plus the two hooks immediately before existing
`JS_FreeContext(ctx)` and `JS_FreeRuntime(rt)`, releasing ONLY newly introduced
plan resources. It includes the pinned quickjs.c/h patch and manifest,
deterministic build patch/provenance section, additive ABI capability
extraction, provider cache-key/metadata private verifier and acquisition
validation callsites, dedicated producer fixture/new tests and artifact README.
It grants no existing membrane/identity/direct EDI, box/refcount/allocator,
linker/encoding/IR behavior or consumer activation. Any need to change those
existing behaviors is a stop and owner handoff.

The complete reviewed producer plan (all600 lines816–1415) was read from
`.codex-worktrees/5157-script-producer-plan-astra/plan/issues/5157-es2015-standalone-modules-eval-with-wave1.md`,
full MD SHA256
`1847393a798b4e950ea417ac3bbc581039e3745c00f3e52ded782843e09f75f8`.
The existing815-line prefix here is preserved. The pending PR6246 corrective
appendix must survive later integration; this leaf does not edit its owned
compiler sources. P2/P3/P4, the original43 diagnostic cases and17 compiled
controls remain open. Frozen full census remains11476P/286F/16CE of11778;
no original-gain credit or Script conformance completion follows from P1.

### Action-tied ownership and source receipts

Fresh live leaf read: UNASSIGNED, exit0, upstream book. Fresh active claims
read:1033, exit0. Existing4245 membrane,4647 receiver,4308 EDI and4540/4542/4544
allocator/lifetime/emission contracts remain held; the exact additive grant
above does not release them. Initial sandbox DNS reads returned UNKNOWN
(exit6), never clearance; network-enabled fresh reads succeeded afterwards.

Full paginated REST inventories completed for17 open upstream PRs,1399 paths;
each PR's count equaled its unique path count:
6474/6,6468/402,6436/4,6435/4,6383/4,6341/102,6288/11,6246/6,6234/3,
6206/17,6195/4,5942/9,5911/10,5883/302,5784/93,5753/294,5748/128.
Zero matches for `scripts/quickjs-artifact/*`,
`scripts/quickjs-eval-provider.mjs`, `scripts/build-quickjs-eval-provider.mjs`
and `tests/issue-5157-script-plan-artifact.test.ts`. PR6246 alone matched this
shared MD; its actual patch was read. This point-in-time path scan is not
whole-issue CLEAR or proof of absence of unpublished peer work.

Read-only native donor remained clean at
`954dc53628e36891f93c359aa60895c2ae3dac6b`; quickjs.c SHA256
`05b6158c96c2d0fd2ceb1090307d7e6a9659c5d286382d64d2fbb7da94f92766`,
quickjs.h SHA256
`686bd55ccdd5e2195a4920d790e4c324473ce54385d49debcfb2c618ff2a7cbc`.
It is never edited, rebuilt or reset. Worktree creation produced an unrelated
apparent LFS dirty `website/public/acorn/acorn.wasm` in a filter-disabled
status read; it remains untouched and excluded from this leaf.

### Frozen pre-execution contracts and implementation sequence

`scripts/quickjs-artifact/probe/script-plan-contract.mjs` freezes22 original
Q1 source bytes/projections and20 added cases, all status NOT_RUN. Full raw
records retain decoded names, duplicate/order/kind/origin independently of
the effective Q1 projection. Every source has a deterministic SHA256.
The seven separate allocation rows freeze failure/recovery, pending InternalError,
no publication/body effects, balanced private resources and unrelated-plan
usability; the seventh must unwind a populated capture. Shipped42 results and
test-build7 results will have separate artifact hashes and denominators.

Implementation will copy pinned c/h to this worktree's own staging, add origin
at the Annex B producer, capture root records before native lowering, then
publish only after compile success. Nine private shim exports enforce context,
monotonic ID, READY/RUNNING/CONSUMED and preallocated owned result-cell rules.
Native atoms/code and shim nodes/buffers follow existing allocation contracts.
Reproducible build checks exact pin/preimage/patch/postimage hashes before
compilation. Capability verification reads actual Wasm exports/signatures and
version; required0 preserves valid old-artifact loading, required1 is private
producer-only. Adapter externs/source and Script routing stay unchanged.

Root reviews frozen contracts and the patch/source/provenance snapshot before
granting the serialized build lease. No builds, heavy tests, runtime runs,
commits, pushes or PR publication have occurred at this checkpoint.

### Reviewed source snapshot and hermetic gate receipt

All22 original Q1 source bytes, strictness/error expectations and effective
projections were compared directly to the retained immutable manifest:22/22
exact, with42 native and7 allocation rows frozen NOT_RUN. Canonical Node
`/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`
reportedv24.19.0. Frozen contract SHA256
`45bf6cf1bf2f6eb9ca0a68561a022c0fb3e9bf55c5f8c74403cb2ef398c6ae38`.
The source-order/kind expectations were not revised from runtime observations.
Before native execution, runtime cleanup operations were clarified to preserve
QuickJS's existing all-contexts-before-runtime precondition; the nonempty private
backstop is a separately identified test-build observation. Stale-context tests
use a new valid context, never a freed context pointer.

The current native patch SHA256 is
`dd547932d244f7c0f8da28a383fc51d40339acd64df3b7432acc702799c8ffde`;
actual postimage c SHA256
`5a7f33e3eb5daa6d3ba8f6ef1c2fe74e7de5f657f3e819eefe996fdc723c22db`,
h SHA256
`aed890483f6a66dfd1f07914023696aa263a56f3becfafcfee83a6de02e67ba6`.
Manifest SHA256
`8e4929fb7da3d59dcb84ec8878262f5985d3b053a8f2dad7ff26643a3b68e844`.
Maintained source validator read two exact preimages and two exact postimages;
`git apply --check` against own preimage copies exits0. These are source-only
receipts, not a built artifact, runtime pass or native compile result.

Root reviewed source/ownership, cleanup sequencing and provenance requirements.
Private test counters cover headers, record arrays, compiled values, source
buffers, nodes, returned cells and all held atom references, including filename.
The test-only cell release observer calls existing `qjs_free_value` unchanged;
node-only counts are not reported as cell balance. Production has no counters,
fault exports or extra release API. Normal general engine allocation counts are
recorded as diagnostics, not misrepresented as total private resource balance.

Root authorized only the frozen hermetic test at this point. Actual command:
canonical Node24 + Vitest,1024MB, one fork, exact
`tests/issue-5157-script-plan-artifact.test.ts`, verbose and JSON reporters.
Terminal chunk`6abef0`, exit0: **24 passed /24 registered /0 failed**.
All24 assertion rows were read back from
`.tmp/script-plan-v1/hermetic-results.json`, SHA256
`9892c090b87257e69e448350fda360d7d95ededa5012ab33751f48a1566e30f0`;
terminal log `.tmp/script-plan-v1/hermetic-terminal.log`, SHA256
`5ab652337e13eaba2d3f00d7cff1afb5797ca067a75a057625b647ce2dc89f1a`.
This uses MOCK Wasm and metadata only. Compatibility proves identical adapter
source generation and valid version0/1 gates, not actual old/new native artifact
canaries. No native42/7 result or original gain is inferred from24/24.

Cheap Node syntax checks and shell syntax exit0. The provider's entire
adapter-source/consumer suffix is byte-identical to exact base, independently
compared via actual source bytes. Existing LLVM18.1.8 tools are available under
`/opt/homebrew/opt/llvm@18/bin`; no install/configuration was performed. Complete
producer harness is ready for root review. Native build lease, all42/7 execution,
real provider canaries, normal repository gates and publication remain pending.

### Pre-native instrumentation repair and shipped build-only lease

Before any native fixture execution, root identified three harness gaps. The
harness now rejects every strictness scalar except exact0/1; preserves the raw
descriptor snapshot and separately retains a native closure containing the real
descriptor values/getters/setters, comparing SameValue (including NaN) after
compile; and reports a separately named identified-test-build normal context
cleanup diagnostic with two READY and one CONSUMED plan. That diagnostic calls
normal `qjs_free_context` with a nonempty registry, observes every private counter
return to the unrelated survivor's exact baseline, then verifies/reclaims that
survivor. It is distinct from the private nonempty runtime-backstop diagnostic.
Both diagnostics remain outside the seven allocation-row denominator. All42/7
semantic expectations and contract SHA25645bf6cf1 remain unchanged. Owned retained
comparison closures are released before context destruction, including failures.
Harness SHA2564b6f5e4a9e061f9f69c1adbd208a6566af81bb5b5128758c0075257e1ad0114d;
canonical Node24 syntax check exits0. Native fixture execution is still NOT_RUN.

Root granted a serialized **build-only shipped artifact** lease, not42/7 or
provider-canary execution. New exclusive staging is
`.tmp/script-plan-shipped-build.VN6rny/work`, output sibling `artifact`, full
terminal `build-terminal.log`. Actual live handle26731, start chunkeffc1b.
Frozen before-input receipt `inputs-before.sha256` covers patch, manifest, shim,
build script, patch helper, ABI extractor, capability verifier, acquisition
validators and native c/h postimages. Canonical Node24.19.0 is selected by a
process-only PATH; Node heap1024MB, existing LLVM18.1.8, CMake4.4.3, JOBS1,
OPT-O2, wasm32-wasip1 and shipped testmode0. Exact existing compiler/linker flags
remain unchanged. The builder process scrubs inherited Git directory/worktree,
index, object, alternate and config overrides before source checkout. Both native
and wasi-libc pinned revisions and builtins URL are explicitly supplied. No donor,
canonical artifact cache, default runtime, installed tool or repository config is
changed. Terminal outcome and before/after hashes must be read before claiming
build success; changing a frozen input invalidates acceptance without auto-retry.

Build handle26731 reached actual terminal chunk678d7b, exit0. Source-only,
compile/link/extraction and capability/provenance verification succeeded; **no
native42/7 acceptance or provider canary has run**. The full terminal has one
wasi-libc CMake author warning about GNUInstallDirs/default architecture; no
native compile/link warning or error. Before/after input receipts compare equal,
both SHA25679d3b0ab34f4e0ddf336dff2f6c8989407cfd88bd922b1f0dea39bb873a20f67.
Actual staged c/h match the frozen postimages, and actual git HEADs match both
explicit pins. Exact source/tool/flag receipts are generated in build-info; no
generated metadata is hand edited. The portable private verifier read actual
nine export signatures/version1 and accepted all recorded source/provenance
hashes, with testBuildfalse and no production fault exports (chunk59881e exit0).

Actual outputs under `.tmp/script-plan-shipped-build.VN6rny`:

- `artifact/libquickjs.wasm`:1026899 bytes, SHA25695333826e7c8c8ed7398203891db713dc44368c86a24dae6fe6da7d3004fa36c.
- `artifact/qjs-abi.json`:SHA2564247f2ff4f03420b939692533177ddd485fbcb058a9377ecc33344ce1697f21b.
- `artifact/build-info.json`:SHA2562c50c717880785eb37744fd9ba4fffabc70daea9ceaea8155c0c7f3aec495e56.
- `build-terminal.log`:SHA25677a7c5ef627c5f5a4e30cee17eb52fdd7bd2960bad9892d7d724685bb2520df6.
- `verification-terminal.log`:SHA256e3b5af7ac01f0e53a218637e0ec4ddff941a2e9656a543b97966e96e0500807c.

Full build command from this exact own worktree (after pwd/branch confirmation):

```sh
set -o pipefail
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR \
  -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_PREFIX \
  -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS \
  PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/opt/llvm@18/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  NODE_OPTIONS=--max-old-space-size=1024 \
  QUICKJS_NG_REF=954dc53628e36891f93c359aa60895c2ae3dac6b \
  WASI_LIBC_REF=8d8348ec24253d0638a693b8af82445c13d92d32 \
  BUILTINS_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34-rc.1/libclang_rt-34.0-rc.1.tar.gz \
  TARGET_TRIPLE=wasm32-wasip1 OPT=-O2 \
  CC=/opt/homebrew/opt/llvm@18/bin/clang \
  AR=/opt/homebrew/opt/llvm@18/bin/llvm-ar \
  RANLIB=/opt/homebrew/opt/llvm@18/bin/llvm-ranlib \
  NM=/opt/homebrew/opt/llvm@18/bin/llvm-nm JOBS=1 JS2WASM_SCRIPT_PLAN_TEST_BUILD=0 \
  WORK=/Users/thomas/Code/js2/.codex-worktrees/5157-script-plan-producer-p1-sol/.tmp/script-plan-shipped-build.VN6rny/work \
  OUT_DIR=/Users/thomas/Code/js2/.codex-worktrees/5157-script-plan-producer-p1-sol/.tmp/script-plan-shipped-build.VN6rny/artifact \
  bash scripts/quickjs-artifact/build.sh 2>&1 | tee .tmp/script-plan-shipped-build.VN6rny/build-terminal.log
```

The serialized heavy lease ended on that terminal. Test-build compilation,
all42/7/native diagnostic runs and real old/new adapter canaries await separate
root GO. Original questions2/3/4,43-case diagnostic and17 compiled-control reruns
remain explicitly open; no IR/consumer activation or Script conformance gain.

The final pre-execution harness snapshot additionally records/asserts actual
READY/READY/CONSUMED state scalars `[0,0,2]` for both separately named test-build
cleanup diagnostics and includes explicit released/after-teardown private-counter
observations in their JSON receipts. Current378-line harness SHA256
1361ea95be5303dd7842e98f529d2d940b592adec3a53c7253a04209b2bcbd31;
Node24 syntax check exits0. These are JS fixture-only instrumentation changes,
not frozen build-input changes or revised semantic expectations.

### Superseding shipped42 execution and first test-build failure

Root reviewed the final frozen harness and granted only finite shipped42. Actual
canonical Node24.19.0,1024MB command from this worktree:

```sh
set -o pipefail
NODE_OPTIONS=--max-old-space-size=1024 /Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/quickjs-artifact/probe/script-plan.mjs --shipped \
  .tmp/script-plan-shipped-build.VN6rny/artifact \
  .tmp/script-plan-shipped-build.VN6rny/shipped42-results.json \
  2>&1 | tee .tmp/script-plan-shipped-build.VN6rny/shipped42-terminal.log
```

Actual terminal chunk1c0481, exit0 in initial call (no yielded live handle):
**42 passed /42 registered /0 failed**. Every actual row was read back, including
all22 original Q1 source hashes/effective projections and raw duplicate order,
kind/origin, exact strictness and three original SyntaxError brands. All42 report
compileDescriptorIdentity true and zero compile body effects. Function/throw
identity, consume-once, source reuse, foreign/stale/index and normal teardown
assertions passed. WASI stdout/stderr captures are empty. Production general
allocation counts remain diagnostics, not claims of private-resource balance.

`shipped42-results.json` SHA25666f7d8d16742b43908e5470817fa2ecba2cdaf51935203d4fd5111aa0b246eac;
`shipped42-terminal.log` SHA25665033911e5d0ae36c850c1cdacb831de004cb1b1027fff3137c0a457da2bfd7f.
Before/after13 source/artifact/ABI/provenance inputs compare equal, both receipt
SHA2566bd4de19fd1c5aa5f2cdc4a9d592529bb30ed91f9d9fc1787e015ad1376e5629.
Root independently reread all42 rows and terminal. Earlier NOT_RUN statements
above are historical checkpoints: current shipped42 is PASS; separate allocation7
and both identified-test-build cleanup diagnostics remain NOT_RUN.

Root then granted separate fresh testmode1 BUILD-ONLY, staging
`.tmp/script-plan-test-build.nETflu/work`, sibling output `artifact`, same exact
command/tools/pins/Git-override scrub as shipped build except paths and explicit
JS2WASM_SCRIPT_PLAN_TEST_BUILD1. Actual handle77294, start chunk10c65f, final
chunk51771c **exit1**. Native core compiled; the test shim compilation found a
test-only C symbol collision: shim static observation array
`qjs_script_plan_test_cells[1024]` and test-hook function of the same C name.
No linked artifact, ABI, build-info or native7 receipt was produced. Failed full
terminal SHA256587f0659eb7a882886399cbdb0326a7e9af0f42372717fcd9a49ab98f3abf1d8.
Before/after13 inputs compare equal, both
SHA256d72abc11b838d06ae1dac660181f1cd66d2e370128655eece7abc8b4d9c7dbdc.
Actual terminal, not absence in a process list, released that build lease.

Root reviewed and authorized exactly one diagnosed repair: test-hooks getter C
name becomes `qjs_script_plan_test_cell_count` with explicit
`__attribute__((export_name("qjs_script_plan_test_cells"), used))`. Its exported
Wasm name/i32 signature and return body are unchanged; no other hook, shim,
patch, allocator, release or production behavior changes. Repaired test-hooks
SHA256eac59afd88b10340a5fd07165ba665819c65e6fde60fd019f5bd11a0f5746023.
Existing LLVM18 wasm-target/testmacro syntax-only check using the own failed-build
sysroot/pinned headers exits0 (chunkf5df3a), writes no object/artifact. Root
independently verified the exact repaired line and unchanged shim/patch hashes,
then granted another NEW exclusive test BUILD-ONLY; no automatic retry, cleanup,
staging reuse or native7/canary execution is authorized by that repair.

### Frozen later matched old/new canary contract (planning only)

The maintained canary constants and complete sources were read directly from
`scripts/quickjs-eval-provider.mjs:4326` onward, and compile/import/link behavior
from `scripts/build-quickjs-eval-provider.mjs:249`. Preserve all11 readings per
artifact, across four separately fresh-realm modules, without selective filters:

- Broad8: evalNumberProbe42, engineIdentityProbe7, stringRoundTripProbe151,
  newFunctionProbe42, errorFidelityProbe111, strictDirectProbe42,
  membraneProbe4321, outwardProbe6543. Exact maintained source SHA256
  8ce393dac801b9707f2159f8644e17c1b2115e54d7ab14cadc93763df23e1526.
- Direct1: sloppyDirectProbe42; source SHA256
  383406b3c5001924d7e38c869eab307d468513d9d88bd86fbf3b79d3ee596fa6.
- Function parity1: functionParityProbe11; source SHA256
  6a9f4568f57e535fd26af3ffafb44492de4335191807463d687a6ca9e60bcbf4.
- State parity1: stateParityProbe52; source SHA256
  48014e044ec07a4502a1addf33d9496a004dafcdafb4dc6dd3a066a73544feec.

Retain full maintained source bytes, dynamic joinSource anti-folding, exact
expectation `why` strings and no rewording/truncation. Adapter compile options are
experimentalIRfalse, fileNamequickjs-eval-adapter.ts, skipSemanticDiagnosticstrue,
targetstandalone, externNativeTypestrue, externImportModulejs2wasm:qjs,
importMemory{module:js2wasm:qjs,min:256}. User canary compiles inherit those options
but explicitly set externNativeTypesfalse, externImportModuleundefined and
importMemoryundefined. Exact maintained fileNames are quickjs-eval-canary.ts,
quickjs-eval-direct-canary.ts, quickjs-eval-function-parity-canary.ts and
quickjs-eval-state-parity-canary.ts. Only direct/state add
inferModuleStrictArgumentsfalse; broad/function preserve default module strictness.

Use exactly one matched own source compiler for both artifact arms, never the
dirty-primary historical compiler bundle. Own worktree has no compiler bundle;
the maintained `loadProviderCompiler` may select own src/index.ts under tsx.
Maintained compiler-input identity (no TEST262_BUNDLE_HASH override) is
72b16e064b646934, exact unchanged base src tree. This is an input identity, NOT an
already-built compiler-bundle SHA; concrete loader origin/input/bundle receipts
and matched adapter/canary binary hashes must be frozen under later build GO.
Four identical user binaries may be compiled once with that matched compiler and
instantiated against each artifact in fresh realms; no implicit canonical cache
publication or rebuild. Each user module must actually import js2wasm:runtime-eval.
Adapter imports ONLY js2wasm:qjs with names from unchanged maintained
QUICKJS_ADAPTER_EXTERNS plus memory; native artifact imports ONLY WASI. Verify
existing structural exports and provider namespace's five maintained entries,
including unchanged __runtime_script_eval; do not activate private plan externs.
Use maintained instantiateRuntimeEvalNamespace fresh for every canary module and
call _start before every exported reading. Keep every actual old/new failure and
error distinct; no candidate pass loss against matched old artifact, no foreign
membrane/identity/EDI repair to make canaries pass.

Read-only version0 donor identified independently by root:
`/Users/thomas/Code/js2/.codex-worktrees/6651-es2015-full-verification-6466/.test262-cache/quickjs-artifact-2e2d7736713beeda`.
It matches the primary cache copy read here: binary SHA256
073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45,
ABI0aab187dade1dfc988d5054bc54b4b04f2ad14dae0fb897b4b660b5d8bb028a9,
build-info4c50336591f72414a9798a997277641725e4dd484d6c547c6cf8c2c6093b0178.
Copy immutable bytes to new own canary staging and verify all hashes before later
execution; never write/compile/cache at donor. Actual export metadata confirms
version0; new shipped artifact remains95333826. Both have exact native/wasi/
builtins pins, but old native compiler Ubuntu18.1.3 versus new HomebrewLLVM18.1.8
is a recorded provenance difference, not erased or claimed identical. Actual
generated old/new adapter SOURCE is byte-identical SHA256
de224ca0ef34cda4679c1311a741fc042e50bf79e0140515a5ac1365b359b111.
That source-only check is not adapter compilation/runtime acceptance. Full11
old/new canary execution remains NOT_RUN until distinct root lease. Original43
diagnostics/17 compiled controls and the full frozen census remain open, with no
producer-only credit or Script activation inferred from shipped42.

### Superseding repaired test artifact and all7 actual native receipts

Root authorized the diagnosed repair's NEW exclusive build at
`.tmp/script-plan-test-build-repaired.1t2Ofg/work`, sibling `artifact`; same full
shipped command/pins/tools/flags/Git scrub above, replacing only WORK/OUT_DIR and
setting JS2WASM_SCRIPT_PLAN_TEST_BUILD1. Actual handle43454, start850d45, terminal
b16383 **exit0**. Before/after13 frozen inputs compare equal, both
SHA2563e10822b21e57a3de658bd8f21ac5136b6b770a5cb645bba1bd325f8c6c3b529;
native/wasi actual HEADs match exact pins. Repaired test artifact1028868 bytes,
SHA2566cfa0d0a3d4766da926e12830f511659a262e58b6c6a3edbb2a5c4e4f0732b46;
ABI4247f2ff4f03420b939692533177ddd485fbcb058a9377ecc33344ce1697f21b;
build-info8f394879acb1255ef4cf569dc64a8e5c2b7291b3633dd9f2af110a7e67f0efbb;
full terminal522b8b688dbd490e99377a4861b9e43c7bb979dabf9f6e151d2ef091759c79af.
Private actualbinary/capability/source/provenance verification exits0, nine
required signatures/version1 plus eleven preserved test-hook export names;
testBuildtrue and repaired-hook SHAeac59afd are verified. Default production
reader positively rejects this test-only artifact. Verification terminal
SHA25642d7db663ef5414786c7fe83ff9fb1cdde3205aa706270f388993ef7c911482d.
Root independently read actual exports/build-info and frozen inputs before runtime.

Root then granted finite allocation7 plus separately reported normal context and
runtime-backstop diagnostics on this exact test artifact. Actual command:

```sh
set -o pipefail
NODE_OPTIONS=--max-old-space-size=1024 /Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  scripts/quickjs-artifact/probe/script-plan.mjs --faults \
  .tmp/script-plan-test-build-repaired.1t2Ofg/artifact \
  .tmp/script-plan-test-build-repaired.1t2Ofg/fault7-results.json \
  2>&1 | tee .tmp/script-plan-test-build-repaired.1t2Ofg/fault7-terminal.log
```

Actual terminal6423c2, exit0 in initial call/no yielded handle: **7 passed /7
registered /0 failed**, separate normal-context cleanup PASS, separate private
runtime backstop PASS. Every actual full row and both diagnostics were read back
(1c1993). The seven identities are native-plan-header, native-record-array,
source-buffer-staging, shim-registry-node, owned-name-result-cell, eval-result-cell
and post-capture-compilation. Each preserves pending InternalError, exact
descriptor identity, no body publication/effect, unrelated plan and exact private
before/after-failure counters. Cell failures assert READY0; recovered execution
asserts CONSUMED2, exact function identity/result11 and body1. Every row's released
and afterTeardown observations are all0 for nodes/buffers/plans/atoms/arrays/
compiled/cells, including held filename atoms. General engine counts remain
separate diagnostics; they are not interpreted as exact private balance.

Both separately named cleanup diagnostics record actual `[0,0,2]` states,
before{nodes4,plans4,atoms11,arrays3,compiled3,buffers0,cells0} reducing exactly to
unrelated baseline{nodes1,plans1,atoms2,arrays1,compiled1,buffers0,cells0}, then
released/afterTeardown all0. Normal-context diagnostic calls normal teardown with
nonempty owner registry; runtime backstop calls its identified private hook while
contexts live, then normal contexts-before-runtime destruction. These are two
additional diagnostics, not an inflated allocation denominator. WASI captures
empty. No source/expectation edits, native42 rerun, retries or cache publication.

`fault7-results.json` SHA256efa5afeb42fd640befac2f554a8ff967205d9474adc0d4dd95ae8c43b7c1217c;
terminal2339d3f54eab5604dfca4f02637f3a387e3b002e32c77a355f9cb8afc1abd8f2;
before/after14 frozen inputs compare equal, both
a9d3f117f23414f7948ea235f8890823f807a0f3c12f0576b83c509c7844e8d6.
Root independently reread all seven full rows, diagnostics and terminal and
accepted the bounded native42/fault7 evidence. Current native status supersedes
historical NOT_RUN checkpoints; full original43/17 and integration remain open.

### Reviewed canary harness and complete pre-execution input freeze

The isolated `probe/script-plan-canaries.mjs` preserves all11 readings per arm
even after earlier comparisons fail; failures remain FAIL, not skipped credit.
It requires own source-loader origin exactly `src/index.ts (tsx)`, refuses any
bundle file/caller-asserted bundle hash and records no bundle bytes used. Maintained
capability probe and import proof are retained. One byte-identical adapter binary
and four user binaries are shared across old/new arms, with separately fresh
namespace per module/artifact, actual _start required/called and exports/imports,
tool versions, sources/options/compiler/adapter/user/artifact hashes recorded.
It reads every regular src file plus lockfile and relevant maintained production
scripts for a full SHA256 before/after freeze, independently of memoized short
cache identity. Root reviewed initial201 lines and requested stricter staged
artifact ABI/build-info pins. The exact correction asserts old/new binary PLUS
the frozen ABI/build-info hashes and realpath/lstat rejects donor-backed symlink
directories/files. A read-only exported productionInputs helper enables a full
preflight receipt without invoking compile/canary main. Current212-line harness
SHA256da8b10ff295f69a9d7bf0c8290dfc43c3d89fda04b70d31b0928ed722bdf1139;
canonical Node24 syntax exits0. Cheap tool receipt resolution confirms installed
tsx4.23.1, TypeScript5.9.3, Binaryen132.0.0; no install/change/compile/runtime.

Actual immutable ordinary old/new artifact file copies are staged at new own
`.tmp/script-plan-canary-pair.JdZSoZ/{old,new}`. Old is copied from root's read-only
6651 donor, new from own shipped95333826; all six byte hashes match frozen pins.
Generated `artifacts-before.sha256` receipt
a6f2b90270dcd9df77a76d865571fc6a3600aaa2f4f35fe82ee75851e9aff46d.
`production-inputs-preflight.json` reads all1836 files and records whole input
SHA2566e78979425828fca435b7ce540b51ea1c209b71ece0268c82c98bff32a2b05a0,
maintained compiler identity72b16e064b646934; JSON file SHA256
cc0436f1017a7233cb36b43a200ba85f0084797fd0fee9c2bd2b3cb400c666a6.
No compile/canary executed. Matched11x2 awaits root review and a separate finite
heavy lease; no compiler/adapter/Script routing/membrane behavior change implied.

### Actual first matched canary attempt: initialization fixture failure

Root reviewed final da8b10ff harness, fixed old/new six hashes and independently
verified every1836 input hash/no missing actual src file, then granted finite
matched11x2 with canonical Node24/1024 and --importtsx. Actual child command:

```sh
node --import tsx scripts/quickjs-artifact/probe/script-plan-canaries.mjs \
  .tmp/script-plan-canary-pair.JdZSoZ/old \
  .tmp/script-plan-canary-pair.JdZSoZ/new \
  .tmp/script-plan-canary-pair.JdZSoZ/results
```

A canonical Node process launcher scrubbed every inherited TEST262_,JS2WASM_,
QUICKJS_,VITEST_,BINARYEN_,TS2WASM_,CODEGEN_,COMPILER_,TSX_,GIT_ override and
NODE_PATH/NODE_OPTIONS, then explicitly supplied canonical PATH/1024MB. Actual
removed names were only GIT_PAGER,NODE_OPTIONS; recorded in dedicated terminal.
Handle69435/startbd1ae6 reached actual terminal090166 **exit1**. No source edits,
expectation change, retries, native builds, canonical caches or donor writes.

Capability probe PASS: module SHA2569e898a716d12e4acda03af330221e721428f15010c6404462e7486be2094a257,
actual only js2wasm:qjs memory/probe_ext imports. Matched own loader origin
`src/index.ts (tsx)`, no bundle bytes used. Adapter compile PASS/587319bytes,
SHA256fa105724f9d2379e2ffe420e3bf3df925f3108a422039a94a67db2a407ee4c54,
actual imports/exports recorded. All four user compiles PASS/errors empty, same
binaries used both arms:

- Broad:701b3158d8e43a8ef6eb8ae081d0df1ce1bda8b410a5afc14cbdfaa94cd3e10d,530745bytes.
- Direct:8c8604cd7b27989d31788aaf69ce60fab5f73d9fd8fcbb1aa4d03f6fed1c2085,481291bytes.
- Function:c9d09231f7c4a9db9015a3d98844ce61c245ae5fba48b6aded28d53be814c734,762126bytes.
- State:d656725d947781d31dbf64526f703f6604ed92b7ea4284c06ff4356c9661be96,477034bytes.

Both old and new arms retain all11 FAIL rows (22 total), **0/11 measured PASS
each**. All eight instantiated realms have the five required provider functions,
but all failed the fixture's added hard requirement for an exported user `_start`
before exported readings. All22 actual readings are null, not zero or skipped
credit. This is NOT compatibility acceptance or evidence of a native regression;
the noPassLoss boolean is vacuous when no baseline readings pass. Actual module
instantiation did occur and may execute native Wasm start code; do not describe
this failed reading attempt as proving body nonexecution.

Full JSON `.tmp/script-plan-canary-pair.JdZSoZ/results/results.json` SHA256
fa6e212f3464d09276dbac221e13b474b4d4893141a075f7b7fee8abca332247;
terminal6af5ba3e3caab1103985768c0a8bd753d741ea5db77f9f853d3bf6f2db7909e0.
All1836 production inputs before/after and independent post-read match full
SHA2566e78979425828fca435b7ce540b51ea1c209b71ece0268c82c98bff32a2b05a0.
Six staged artifact hashes before/after compare equal. Independent after-input
JSON equals preflight, bothcc0436f1017a7233cb36b43a200ba85f0084797fd0fee9c2bd2b3cb400c666a6.
Every row/realm/module error was read back; original failed receipts are retained.

Static diagnosis (no retry): actual four emitted binaries have native section8
start functions734/706/843/704 respectively and NO `_start` export. Complete
primary declaration-init source `src/codegen/declarations.ts:6570`–6724 was read:
non-WASI default publishes Wasm startFuncIdx and runs module initialization once
on instantiation; WASI uses a separate _start export, and both would double init.
Maintained verifyQuickjsProvider uses optional `_start?.()`. Proposed correction
is isolated fixture initialization instrumentation: assert exactly one actual
startup mechanism, record automatic start-section execution after successful
instantiation OR require/call exported _start, reject both/neither. All eleven
expected readings, exact sources/options and actual provider-import proofs stay
unchanged. This needs root review/new finite lease; no automatic repair/rerun.
Native42/fault7 evidence stays accepted, full43/17/global integration remain open.

Root independently reread all four actual section8 indices and complete native
startup producer, then authorized only the diagnosed fixture repair. The repaired
canary harness decodes actual section8 with header/bounds/u32 checks, records its
function index in each module proof and requires native-start XOR callable _start.
Successful WebAssembly.Instance records nativeStartCompleted and never calls
_start when a native start exists; the alternate export-only path calls _start
once and records startCalled. Both/neither fail closed. No compiler/artifact,
source/options/readings/import proof is changed. Failed22 receipt above remains
immutable; no compatibility pass or native regression is inferred from it.
Current246-line harness SHA256
3a1467752854cc533c9a43d4ee98c1bd99ab261a65c5128b362b1ab56ca639a3;
Node24 syntax exits0. New full1836-file preflight production hash
eb657affde47e92b3591f4ddef056a741682749c4942ddf256f0670f513214ee,
unchanged matched source-compiler identity72b16e064b646934. New independent receipt
`production-inputs-repaired-preflight.json` file SHA256
c5caaa17cd8b7bbf889cb1cc023566a863790fed8ab23cfdfaf7e708b451451c.
Only canary fixture source changed; native/provenance files and both staged
artifact arms remain unchanged. No corrected canary runtime yet; renewed finite
lease requires root review of this exact source/input snapshot.

### Actual corrected matched canary result: old11/new11 PASS

Root fully reviewed corrected startup mechanism/source3a146775 and independently
verified new1836-file input receipt eb657aff, then granted a renewed finite11x2
lease. Actual canonical Node24/1024 --importtsx child command is the first canary
command above with ONLY output replaced by
`.tmp/script-plan-canary-pair.JdZSoZ/repaired-results`. Identical programmatic
environment scrub/prefixes and canonical PATH; actual removed inherited names
only GIT_PAGER/NODE_OPTIONS. Old failed output is never overwritten.
Actual handle68521/start38798b reached terminal7c3301 **exit0**: **old11/11 PASS,
new11/11 PASS, all22/22 readings measured**, no pass loss. Each arm actual values
are42,7,151,42,111,42,4321,6543,42,11,52 in exact frozen order; all expectation
sources/options/why strings remain unchanged. Every actual row was read back.

Capability/adapter/all four user compiles PASS; matched own source loader
`src/index.ts (tsx)`, no compiler bundle bytes used. Capability9e898a71,
adapterfa105724 and four user binaries701b3158/8c8604cd/c9d09231/d656725d are
byte-identical to the preceding attempt, showing only the observation fixture's
startup recognition changed. All eight actual realms record wasm-start-section,
nativeStartCompletedtrue, explicit startCalledfalse; native indices734/706/843/704
respectively in EACH old/new arm. Exactly one native startup completed during
successful instantiation; no _start double call. Actual user provider imports,
adapter/native imports/exports and five callable namespace entries are recorded.

Full JSON `repaired-results/results.json` SHA256
b85e2842353d2221ccff125a0080056c62484397c3991631a7f76ea2a9827aa2;
`repaired-canary-terminal.log` SHA256
cd4797d0e77bd635450d50b416d14db5bed16a44a42674e03dad3eda28f48b9a.
All1836 production inputs before/after and independent after read match full
eb657affde47e92b3591f4ddef056a741682749c4942ddf256f0670f513214ee;
preflight/after JSON files compare equal, both
c5caaa17cd8b7bbf889cb1cc023566a863790fed8ab23cfdfaf7e708b451451c.
Six staged artifact bytes before/after compare equal. Actual terminal ends the
heavy lease. Native42/fault7 and matched11x2 are bounded inactive-producer evidence,
not original43/17 completion or any census/conformance gain. Full global integration
and questions2/3/4 stay open, no IR/adapter extern/consumer activation.

Publication remains unperformed. Read-only hook inspection confirmed maintained
lint-staged formats *.ts/*.js/*.mjs and *.json before lint; hooks must not be
bypassed. Any required mechanical formatter changes to maintained provenance
source must be reviewed/frozen before final-current-input acceptance. Current
historical receipts are preserved, never reassigned to changed source hashes or
hand-edited generated metadata. Coordinate next format/check/build/gate leases
with root before commit/push/PR; no such mutation has occurred at this checkpoint.

### Final-source mechanical formatting and read-only gate checkpoint

Root reviewed the exact scoped formatter/linter failures, authorized only the
seven reported owned-file Prettier rewrites and the plain-object negative test's
`Reflect.deleteProperty(hidden.abi, "capabilities")` replacement. Actual formatter
chunk2cacab exit0. No C, native patch, shell, manifest, unrelated file or semantic
expectation was formatted/changed. Scoped nine-file Prettier check2a0bd3 exit0;
Biome lint449b7c exit0 (its maintained configuration checks the one TS file and
ignores these MJS/JSON files; this is not nine-file Biome coverage).

Full cooked native42/allocation7/artifact contract JSON before/after cmp0, both
SHA256d0d1cd4276bfdff138c71f655bf3585a81845b6aeba83f211463f2675387ac40.
Generated adapter source before/after cmp0, both
de224ca0ef34cda4679c1311a741fc042e50bf79e0140515a5ac1365b359b111.
The complete thirteen-source inventory is
`.tmp/script-plan-final-gates/formatted-source-inputs.sha256`, receipt SHA256
42e5a7806577098c77484d2e23d102f237de604d26d0bc95edcfbcb722a7696d.
Current formatted hashes: provider9a20b49a0eca5ab0e8c3f0307e1241aad88298b13972999a129c1db9460a48fd;
extractorf17a12bb0f24f496eca005086d4bed75589019e2ef935039784280ae9fd07830;
patch helper3a9e654d2fd2e0901b8611732bbe51ef4897d4fa800ef24abab730e1c1c2470a;
contractaf5cd72123a3294fb785f67ee0e08878838b645a1228bfce62c1493b2e7e9628;
native probecd97c847a8a36983083ff1d9839f98951d605dde34f6d0ad061fd4d93b683267;
canary26d534d68fa236e617d30e2baf149ed3ea72ea3f489c976ea0595a07046169ff;
testeb314b16ba46ab96532cbccea702ea19360b67955a406ed72d19673a3d6f2fff.
The native shim/patch/C/H, build shell, test-hook C, manifest and acquisition
builder hashes remain unchanged. Artifact-affecting formatted inputs are the
patch helper (recorded source digest/cache identity), ABI extractor and private
verifier. Historical artifacts and all preceding accepted runtime receipts stay
historical: their generated provenance must not be hand-edited to fit new helper
hashes. Fresh maintained builds are required for final-current-input acceptance.

Actual serial canonical Node24/1024 read-only cheap gates all exit0:
type7 final7ad836; cycles final1e9331; flat9a2765; inventory finala54d10;
LOCfbfe7b; functions456f4e; docs d4e477; issue-index finalb936be;
issue-retirement214eb3. Inventory reports inventoryValidtrue/errors[], but
architectureCompletefalse and graphCompletefalse: no architecture-completeness
claim. Issue-index --check reports zero issue-file updates and would refresh
three existing index files; this read-only command returns0 and no index rewrite
was authorized/performed. Retirement ledger reports50 rows/37 IR-owned/4
retirement-ready/2 source-anchored. LOC/function checks report no unallowed growth
against their maintained upstream comparison; own compiler src remains unchanged.
Logs are retained under `.tmp/script-plan-final-gates/`: type7 SHA256e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855;
cyclesf08daba3a7208849946afedbafe74ea9eaa022c74df5627437b9d1563f958bfa;
flat056920d5bb76044e93d9d190f18334de4fcc85f812471c185014cc036b4f4ada;
inventory929c4a0f7aee798d6b8593105a28b992f4c916e18b4975a94f5253da544c0a76;
LOC1c9247679096d240f8afa57d08fee3ecf43938f2cac761e73e39a6bb9210b7c0;
functions38889628f27c2a5ed03668034557e143054608b50d3dc7742f703b7eee34934f;
docs8a5aee03981b6e03a36d744f1adf98632e3a28303695c59c757c844c3fdb8c53;
issue-indexdcc2de3bc1cae87bde7c843cec86084fdcc0972a2306ef94c4e68f1d32bf537d;
retirementc2544edc9a2b93ea8e2de3e1465d95d916d09aeeb711522373fefaa7921c5b10.

Root independently reviewed formatted helper/provider and verified preservation
and all thirteen hashes, then granted finite final-source MOCK24 followed by a
fresh shipped BUILD-ONLY, exclusive own WORK/OUT, exact pins/tools/JOBS1. No native
runtime, fault artifact or canary execution is authorized by this checkpoint;
stop at shipped terminal for root inspection. No source edits during that lease.
Original43/17/census/integration stay open; publication remains unperformed.

Final-source hermetic command uses canonical Node24/1024, Vitest3.2.4 one fork,
exact `tests/issue-5157-script-plan-artifact.test.ts`, verbose+JSON reporters,
output under `.tmp/script-plan-final-gates`. Actual terminalccf85b exit0; all24
registered assertion rows read back in b8ddf6:24/24 PASS,0failed. JSON SHA256
ee253ac262f2ca09ada23b8f9edf69bdb2dc322c48a1796574e629a5e875e6f5;
terminal4e9f6505de979c4db275335abc47b3d26ce0014e419eb427d5fbb6acac98c62c.
This remains MOCK-only evidence, not native/adapter execution. All thirteen
formatted source hashes verified unchanged after this finite test. Fresh final
shipped build staging is exclusively own
`.tmp/script-plan-final-shipped-build.BGGcUS/{work,artifact}`, no existing staging
or cache reuse. Its controls equal the first shipped command above with only
these WORK/OUT/log paths changed; actual native runtime awaits later root GO.

## 2026-10-04 Astra P2 proposal: consume the native Script plan in the real realm

### Status, immutable inputs, and limits

This is a docs-only architecture proposal, not source GO, capability activation,
or a completed Script fix. Planner owns only this appendix in
`.codex-worktrees/5157-script-plan-p2-plan`, branch
`codex/5157-script-plan-p2-plan`, base
`fdb116928b5861fd628abfde95da5e3deb91f689`. Its original815 lines are preserved.
Root must transfer only the appendix, preserving newer P1, PR6246 and other
MD5157 history. No source, artifact, fixture, claim, provider, or peer WT changed.

Read completely: P1 implementation MD in
`.codex-worktrees/5157-script-plan-producer-p1-sol` through line1385, including
the newly arrived corrected canary result; earlier Astra producer MD in
`.codex-worktrees/5157-script-producer-plan-astra`, all1415 lines (its first815
are byte-identical to the already-read prefix). P1 donor MD at this read is
SHA256 `90fba66e7f26ad3fa3207c3518bcc5668e8c917bef98130efd78932af6b8a707`.
Earlier full producer plan is
`1847393a798b4e950ea417ac3bbc581039e3745c00f3e52ded782843e09f75f8`.

P1 evidence now comprises shipped42 native cases, seven distinct allocation
fault cases, two separate cleanup diagnostics, and corrected old11/new11
compatibility readings, all passing their respective contracts. Corrected
canary JSON is `b85e2842353d2221ccff125a0080056c62484397c3991631a7f76ea2a9827aa2`.
The preceding missing-`_start` attempt remains an observation failure, not a
native regression. These denominators do not replace the original43/17 gate.
P1 production adapter/externs remain unactivated; no original gain follows.

The unchanged four-question manifest and all17 original bodies were read from
`.codex-worktrees/5157-script-declaration-experiment-sol/.tmp/5157-script-declaration-experiment/`:

- `manifest.json`: `4b5e8b9d76b34df45667fb2c1b509a85ce0f301156a2b622be391f37d49a0afb`.
- `original-bodies.json`: `ccd88ee0120376cf0b1b1ad68b8a74bfc19b4025f1c35e162a777414f145f8be`.
- 43 diagnostics: 22 Q1, 11 Q2, 6 Q3, 4 Q4; 17 compiled controls: 8 frozen global-code,
  3ordinary indirect-eval,6AnnexB. Preserve every source, expectation, variant,
  and historical-row membership. P1's raw declaration records and the original
  Q1 effective-name projection are separate views, not conflicting oracles.

The two frozen descriptor failures are `script-decl-var.js` and
`script-decl-func.js`, first failing at a new binding's configurable flag.
Their later existing-property/nonextensible assertions still matter. Their six
frozen neighbors already passed; no claim of two new gains until matched full
original executions. Later-edition AnnexB metadata in the frozen controls is
not permission to change the corpus or reinterpret expected results.

### Actual producer and consumer seams

Line references below are to the read-only P1 WT unless explicitly qualified.
The native file is its staged, patched
`.tmp/script-plan-shipped-build.VN6rny/work/quickjs-ng/quickjs.c`.

1. `scripts/quickjs-artifact/qjs_shim.c:330–435`: v1 compile creates an owned,
   context-checked plan; eval reserves its result cell before entering code,
   moves READY to RUNNING, consumes into `JS_EvalGlobalScriptPlan`, and finishes
   CONSUMED on normal/throw. At native38455 that function calls `JS_EvalFunction`
   with the retained compiled value. It has NO declaration-application callback,
   admission mask, pre-body publication event, or lexical-cell reader.
2. Native38226 `js_capture_global_script_plan` copies name/kind/origin and private
   function-pool provenance before `js_create_function`. Native35135–35174
   `resolve_variables` emits checks before creation;35325 invokes
   `instantiate_hoisted_definitions` on root body-scope entry. That function,
   34913–35049, emits actual `fclosure`/`define_func`, `define_var`, then frees
   `global_vars`. Runtime18864–18901 dispatches those operations. At18533,
   `OP_fclosure` calls `js_closure` with the live frame, pool value and var_refs.
   This is the real function producer; a source string or pool number is not a
   published callable.
3. Native11696 `JS_CheckDefineGlobalVar` and11738 `JS_DefineGlobalVar` inspect
   ordinary `ctx->global_obj` / `global_var_obj` fields directly.11771
   `JS_DefineGlobalFunction` preserves compatible nonconfigurable attributes.
   11792/11860/11915 native Get/Set/Delete distinguish lexical uninitialized and
   immutable state. Their behavior cannot be reproduced by a value snapshot.
4. Native37897–37913 `js_parse_function_decl2` records an AnnexB extra-var and
   emits a separate block-time `dup; scope_put_var` copy. Suppressing only a
   metadata row or only its hoist leaves that later copy alive. The raw extra-var
   row's pool index is not a sufficient body-site identity.
5. `scripts/quickjs-eval-provider.mjs:3106–3176::qjsEvaluateGlobalScript` currently
   pushes values before planning, uses source/scratch probes, calls shared
   `qjsCreateEdiBindings` (2967, assignment creates D=true), then reparses with
   `qjs_eval`. Function/value pullback and lexical snapshots occur only afterward.
   `__runtime_script_eval:3242` is the existing public ingress; non-string input
   returns unchanged. Keep that ingress and the user-module import ABI stable.
6. `qjsPushGlobals`,2490 `qjsPushGlobalLexicalCells`,2516 pull and2560
   `qjsPullGlobals` carry values, not a complete global environment.2980
   `qjsReadGlobalLexicalValue` evaluates helper source;2987 persist converts
   failure/refusal to undefined and stores value snapshots. None is a TDZ,
   const, prior-var, descriptor, or deletion-authority implementation.
7. At1485 `qjsPublish` collapses inward wrappers and reuses `qjsFindBoxIndex` before
   allocating a function carrier;1400ff `qjsToQuickjs` reuses retained handles.
   Use those identity mechanisms, without cloning their registries or silently
   ignoring refusal. They are shared4245/4647 protocols, not private P2 property.
8. At1263/1283/1299/1307 `__membrane_get/set/has/delete` and1326 `__membrane_call`
   can enter caller code. Call has no Script-global synchronization around its
   `__runtime_eval_apply_callable` edge. Get and Set can invoke accessors/proxies
   too; wrapping only Call cannot establish Q3 correctness.
9. `qjs_shim.c:852::qjs_mb_exotic_gopd` uses has+Get and fabricates W/E/C=true;
   `qjs_mb_exotic_define` refuses reflective definition; ownKeys is absent.
   Therefore substituting the existing membrane wrapper as `ctx->global_obj`
   is rejected: both its descriptor contract and native raw-field assumptions
   are wrong. No automatic global-object replacement or membrane rewrite.

### Chosen architecture and the first finite prerequisite

Choose one real native realm and one retained compiled Script, with a private,
plan-bound native instantiation operation and descriptor-faithful boundary
synchronization. Do not choose scratch functions, a second evaluation, regex
names, post-body C=false repair, or a fake global object. Native code remains
the executor and real lexical/function producer; the caller's actual global
object and declaration provenance govern cross-heap admission.

The next implementable prerequisite is an INACTIVE private v2 execution mode
proving exact instantiation events and AnnexB masking on the retained program.
It is not an adapter-only fix and cannot claim Q2/Q3 completion. Preserve v1
compile/eval behavior and its42/7/cleanup gates unchanged. Add a separate
capability/version for the new contract; do not silently redefine v1 semantics.
The following native changes require explicit new clearance beyond P1's grant.

N1. Extend only private plan compilation with a root-only marker and stable
record ordinals. The plan owns records, decisions and compiled root. Its child
functions are ordinary functions, not independently marked Script roots. Each
AnnexB block-copy producer gets its precise occurrence ordinal while parsing;
ordinary explicit var/function declarations remain distinct even for the same
name. No source-position heuristic, name-only suppression, bytecode decoder,
or external numeric pool ABI.

N2. For ONLY this private root mode, replace the ordinary global check/hoist
emission with one native plan-instantiation operation at the same body-scope
boundary. Proposed native opcode `script_plan_instantiate` has stack effect0→0;
it is a pinned QuickJS patch, not a repo IR opcode or generic call-lowering
change. Normal root locals/scope initialization must remain in place. The
private operation validates active root-bytecode identity, context, generation
and immutable decision vector, then performs the checks/creation sequence
below. Use the same live-frame `js_closure` mechanism as `OP_fclosure` for each
selected hoisted function. Preserve generator/function kind, name, length,
prototype and closure environment. Never call `JS_EvalFunction` twice.

N3. Replace only marked AnnexB global-copy sites in this private mode with a
conditional native operation keyed to that occurrence. Its stack contract must
preserve the lexical block function whether the extra global copy is enabled
or suppressed (the existing dup/copy leaves the original function on stack).
The admission bit controls BOTH extra binding creation and block-time copy.
Do not suppress ordinary same-name stores or mutate nested ordinary eval rules.
Carry IDs through native variable/label resolution; no post-hoc byte patching.

N4. Private native/shim hook operations are finite: query declaration admission
against a realm token; announce newly created lexical cells; publish an owned
reference to each actual hoisted function; announce committed var provenance;
read/write lexical binding state without evaluating helper source. Transport
names as decoded length-delimited strings, not C-string identifier fragments.
Define every result as success/semantic abrupt/transport failure, never0=>allow
or refusal=>undefined. Hooks are Wasm-to-Wasm private callbacks, no host JS.
Function values borrow during callbacks or transfer explicit duplicate handles;
the ownership table must say which. Reserve completion transport before effects.

N5. Plan state becomes READY→RUNNING→CONSUMED, including instantiation/body
throws; a failed pre-entry allocation leaves READY and no events. Admission
decisions are bound to this entry, not reusable across realm mutation. Nested
entry uses a stack of independent frames; a global mutable current-plan slot
without save/restore is prohibited. Freeing a RUNNING plan remains invalid.
Releasing the consumed plan must not release published functions or persistent
realm lexical cells. Preserve P1 context/runtime cleanup isolation.

This selects a concrete native route, but opcode/emission permission has NOT
been granted. If that exact private emission change is withheld, report N2/N3
blocked; do not substitute a helper-source prologue or promise adapter-only
success. Native frame/pool/ordinal correspondence must be proved in a finite
event fixture before requesting adapter activation.

Private ABI scope must also include the native opcode table and every native
decoder/optimizer/stack-size pass that reads that table; no hard-coded numbering
assumption may shift old programs unnoticed. Root-only admission happens ONCE
at N2, before creation. A preliminary adapter pass may prepare transport but
must not repeat observable admission queries and cache their answers across
effects. The immutable mask is the result of that entry's completed admission,
not a decision made during compilation. Ordinary non-Script roots retain their
existing checks and hoist emission byte-for-byte where the patch permits.

### Admission, ledger, descriptors and AnnexB decisions

Use a private realm record keyed by caller global-object identity plus native
context generation. No user-visible name or global spelling is a realm key.
`qjsEnsureContext:2196` currently returns one context; switching callers while
retaining its lexical state is not realm isolation. Initially require verified
same-realm binding; multi-realm attachment needs separate context/owner work,
not clearing/reusing the singleton. Registry teardown precedes context release.

Ledger entries distinguish source-declared var/function, ordinary eval-created
deletable binding, AnnexB extra binding, mutable lexical, immutable lexical,
initialized/uninitialized, and externally existing object property. Assignment
alone must not manufacture a var declaration. A successful bare `var Array;`
must be recorded even though value and descriptor do not change. Body failure
does not remove successfully instantiated declarations. Successful deletion
updates the corresponding deletable declaration state; failed deletion does not.

Before any value seeding or user body, obtain actual own descriptors and
extensibility through the caller's real MOP. Do not Get property values for
admission; accessors must remain uninvoked. Check lexical conflicts first,
select last same-name hoisted function in native declaration order, check all
selected functions, then ordinary vars before creating bindings. Preserve
abrupt completions and observable order; proxy operations cannot be replaced
by an unordered snapshot or blanket rollback transaction. Ordinary admission
failure must leave the earlier-var/Q2-failure-atomicity witness absent.

Creation contracts come directly from the frozen originals/Q2 expectations:
bare var preserves an existing own property's value and attributes; inherited
only is not own and requires extensibility to create new undefined W/E=true,
C=false. A selected function replaces an absent/configurable property with its
REAL function, W/E=true,C=false; a compatible nonconfigurable data property
updates value only. Nonconfigurable accessor or incompatible data rejects.
Create lexical bindings uninitialized and outside the global object; initialize
only when the original body does. Strict Script still creates nondeletable vars.

Normative cross-check: [ES2015 GlobalDeclarationInstantiation](https://262.ecma-international.org/6.0/#sec-globaldeclarationinstantiation)
places declaration validation/instantiation before Script body execution and
selects the last duplicate function. Its ordinary-global no-abrupt-after-checks
note does not authorize rolling back observable Proxy effects. The frozen
AnnexB controls carry later-edition section metadata; retain their exact oracle
rather than applying a historical-edition shortcut to change expected results.

AnnexB origin1 is a parser fact, NOT unconditional admission. Decide candidate
extra-var applicability against existing lexical/restricted-global state and
the applicable CanDeclareGlobalVar contract, preserving explicit var conflicts.
Keep original six AnnexB controls and add fresh-name/deletability, existing
configurable/nonenumerable, lexical collision, nonextensible-absent, repeated
block, skipped block, strict block, escaped name and same-name explicit-var
controls. Pin expected descriptors/provenance before implementation. In
particular, do not blanket force C=false on every origin1 row: existing-property
preservation and the selected AnnexB rule must be represented separately from
ordinary Script-var D=false and ordinary indirect-eval D=true.

### Missing caller facts and live Q3 integration — held, not assumed present

Actual producer available for initial caller names:
`src/codegen/index.ts:4146::recordSourceGlobalEnvironment` already records
`globalObjectVarBindings`, `globalLexicalBindings`, and separate implicit globals.
`src/codegen/expressions/runtime-eval-provider.ts:213::runtimeEvalGlobalBindingNames`
merges vars, functions and intrinsics; that MERGED list cannot be exported as
declaration provenance. `emitRuntimeEvalGlobalBindingPushBody:313` publishes
lexicals as alternating name/value-cell, and485 knows `isScriptBinding` for
descriptor stamping. There is no complete kind/TDZ/provenance contract in that
existing carrier. Reading property nonconfigurability is not a replacement.

Propose a new private declaration-metadata sidecar assembled from existing
compiler declaration facts, with separate source-Script vs module/eval origin,
lexical kind and actual initialization state. Do not change the existing cell
ABI or add guessed ctx fields. Exact lexical-kind/TDZ producer selection is a
STOP until the owner identifies its maintained authoritative binding metadata;
the current name/value pair does not contain it. This is a precise missing
producer, not permission to recover names by parsing source in the adapter.
For P2-created declarations, native plan records and native lexical cells supply
those facts directly; earlier caller declarations still require ingress.

`src/codegen/global-environment.ts:471::emitRuntimeEvalGlobalLexicalReadOrFallback`
currently does has/Get on the dynamic lexical map then unwraps the stored
value. Its consumers must see native TDZ, const enforcement, live object and
function identity, and nondeletability; mapping TDZ to undefined is invalid.
A private accessor-backed lexical sidecar can reuse its Get path, provided
actual getter exceptions/identity work through the existing bridge. Writes and
delete must also resolve that binding, not fall back to the global object.
`emitRuntimeEvalBindingRead/Delete`, `emitGlobalEnvironmentDelete`, and
assignment's `tryEmitAmbientIdentifierGlobalWriteFromLocal` are reader/writer
interfaces to adjudicate separately, not cleared source edits in this proposal.
No generic global-read rewrite, shared-cell ABI expansion or IR change is granted.

For object-record values choose descriptor-faithful boundary synchronization,
not replacing native global_obj. A private Script realm frame records which
heap currently owns observable state. Before native entry transfer caller
descriptors/values/prototype/extensibility without invoking getters; before ANY
native→compiled code edge transfer native changes, then after normal OR abrupt
callback return transfer caller changes before native resumes. Diff against
last synchronized descriptors to avoid illegal redundant writes to readonly
properties. Accessors retain actual getter/setter handles and identity. No
enumeration+Get snapshot, no silent skipped property, no copying private marker
properties or replacing intrinsic singleton identities. Native and caller
globalThis must map to one observable realm identity, not a newly exposed box.

Proposed private shim descriptor operations use native `JS_GetOwnProperty`,
definition/deletion and extensibility primitives with explicit result/ownership
records. These are not existing qjs_mb_exotic_gopd, qjs_set_prop_str, or
qjsBoxKeySpec. Verify prototype/own-key ordering and symbol keys; if the required
descriptor/realm identity operation crosses a held protocol, stop for its
specific carve-out rather than dropping that case. Synchronization is an
implementation proposal requiring proof, not a claim all descriptor operations
are already available to the adapter.

Two strict integration decisions remain open, with explicit stop witnesses.
First, bulk descriptor synchronization of a Proxy global can itself add traps
that GDI would not perform. It is NOT certified by the ordinary-global fixed
matrix; do not claim exotic-global completeness or add an observable full scan
as its implementation. That requires owner-approved live descriptor operations.
Second, private sidecars cannot first be installed as new properties after the
caller prevents extensions. The private ledger belongs outside user properties;
any compiler-visible capability/lexical lookup anchor must be reserved by its
real bootstrap producer before user code, or use an existing authenticated
private ingress. Identify that exact hook before the nonextensible controls.
No replacing globalThis, fabricating a writable carrier, or relaxing descriptors.

Publication must happen inside native instantiation before first body statement:
the native function produced from this frame is passed through existing
canonical `qjsToGc`/`qjsPublish` and defined on caller global with the admitted
descriptor. Publish lexical presence/TDZ before callbacks too. Q3's callback
receives exactly the function installed in that descriptor; retained identity
survives second/third Script entries and body throws. No undefined placeholder
function, second parse, scratch callable or source-level wrapper is permitted.

Live edge coverage includes membrane Call AND getters/setters/proxy probes that
can invoke compiled code, plus later calls of retained interpreted functions
through `__runtime_apply_interpreted`. The Script realm remains associated after
plan consumption. Use a reentrant frame stack; nested Script must not overwrite
outer qjsEdiNames/qjsPushedNames, exception/refusal state or last-sync baseline.
Save an actual thrown value before any synchronizing API can overwrite pending
native exception state; restore/propagate it after required writeback. A Wasm
trap or opaque failure is not a successful semantic throw. Tests must establish
callback mutation visibility even when callback or subsequent body throws.

Keep `qjsEvaluate` ordinary eval, shared `qjsCreateEdiBindings`, direct-eval
activation cells, Function construction, receiver conversion and membrane
ownership unchanged unless an exact separate grant is obtained. Q4's ordinary
eval D=true is not implemented by calling the Script D=false path. Reuse of
identity helpers does not authorize editing their cache/refcount behavior.

### Ownership requests and source-scope gates

P1's recorded fresh ownership scan is1033 active claims; its17 paginated PR
inventories reconcile1399 paths, with no then-open quickjs-artifact/provider
path match and PR6246 positively sharing this MD. This is retained evidence,
NOT a new freshness/absence claim. Root explicitly keeps4308 EDI,4245 membrane,
4647 receiver,4540 allocator/heap,4542 lifetime and4544 native emission held.
Read their scope records; `done` prose in4308 does not release its raw claim.
No GH polling or ledger mutation was performed for this documentation task.

Proposed execution leaves, not assignments:

- `5157:script-plan-native-instantiation`: new private version/mode, exact native
  N1–N5 hunks in a new pinned patch layered after P1, its shim-only exports,
  deterministic provenance/ABI verifier and finite native event fixture.
  Request explicit permission for `resolve_variables`,
  `instantiate_hoisted_definitions`, marked `js_parse_function_decl2` AnnexB
  emission, native private opcode definition/dispatch and live-frame closure
  reuse. P1 authorized none of these changes. No ordinary opcode semantics,
  repo backend/IR, allocator, tier-elision or shared box/free rewrite.
- `5157:script-global-admission`: additive private Script realm/ledger/descriptor
  helpers in provider generation and ONLY `qjsEvaluateGlobalScript` replacement;
  private shim descriptor/lexical APIs.4308 must clear the distinction from its
  EDI/global-binding lifetime and ordinary-eval provenance, before activation.
- `5157:script-global-live-boundaries`:4245/4647 permission for exact pre/post
  hooks around `__membrane_*` callable edges and retained-function entry, plus
  canonical global identity reuse. No receiver algorithm, membrane registry,
  allocator/refcount redesign or exception swallowing is implied.
- Caller metadata/lexical read/write/delete ingress is a separately held
  prerequisite, with exact producer identification required before source GO.
  Existing compiler files and initializers overlap positive owner protocols;
  unrelated-machine IR clearance does not clear these functions.

Owner questions are concrete: may private plan roots replace their own native
GDI prologue and marked AnnexB copies; who supplies canonical initial caller
declaration/TDZ facts; may Script frames synchronize full descriptors at ALL
cross-heap edges; and who owns correct normal/abrupt reentry/error transport?
PR6246 argument staging/6774 routing are separate. Do not modify their sources
or transfer this appendix over their newer MD paragraphs.

### Finite verification and stop conditions before production

1. Root reads this full appendix and approves exact scope/ownership. First freeze
   a supplementary source/expectation manifest; this document creates no tests.
   Native prerequisite additions cover event ordering with zero body effects,
   duplicate-last function identity, generator metadata, rejected-later-function
   no earlier publication, TDZ/const, AnnexB creation-and-copy masking, nested
   entry, consumed/stale/foreign handles and every new allocation cleanup path.
   Pin actual native patch/header/opcode/ABI hashes; keep shipped/test-artifact
   separation and old v1 controls. A changed opcode path needs unchanged ordinary
   compile/eval witnesses, not just a v2-only green fixture.
2. Implementers stop after the first complete private native prerequisite pass
   and report exact events/results. This is no automatic adapter/consumer GO.
   No unproved metadata source or held callback seam may be filled with a
   best-effort snapshot. Root reviews event/frame/ordinal evidence first.
3. Once all integration grants exist, run original43 diagnostic contracts
   unchanged with genuine provider/native ingress;22Q1 remain native plan
   projections,11Q2 actual descriptors/admission,6Q3 live function/identity/
   mutation/throw/marker checks,4Q4 runtime-assembled ordinary eval/Function.
   Supplement same-realm second/third entries, prior `var Array` vs ordinary
   assignment, deletion provenance, const write/TDZ after aborted body, escaped
   names, inherited getter not invoked by declaration, getter callback and
   reentrant mutation, exact this/globalThis identity, and descriptor order.
   Baseline every supplement; no unsupported case relabelled expected-pass.
4. Run the unchanged17 compiled originals through their maintained harness,
   including flags/includes and original bodies, same pinned corpus/oracle.
   Separately rerun P1 old/new11 compatibility and relevant existing membrane/
   receiver controls. Remove the new consumer routing in an attribution arm:
   descriptor failures should return without losing old controls. Do not mix
   native fixture passes into original counts or rewrite stale raw results.
5. Every arm records source/native/artifact/adapter/compiler/bundle hashes,
   actual import/export link map, canonical runtime and terminal result; valid
   section8 startup is not an absent `_start` failure or a second initialization.
   No unexpected host imports, harness repairs, dependency refreshes or cache
   reuse can stand in for measured execution. Cheap architecture/type/format/
   ownership gates remain required; no ratchet waiver. Heavy work requires the
   root lease, currently not this planner's.

Terminal acceptance remains full Q2/Q3/Q4 plus unchanged43/17 and preservation,
not a native producer checkbox or two descriptor examples. Missing caller
metadata, blocked native emission hooks or incomplete abrupt synchronization
are specific unresolved prerequisites. No production source authorization,
new original gain, activation or publication is asserted by this appendix.

### Final-source shipped build terminal and P2 documentation transfer

Root approved P2 documentation transfer only. Main agent read all405 original
appendix lines816–1220 directly (8801c6/968efe), donor fullMD SHA256
ed02b2ed6563459ddd6e330565194c9f1608338b6e28c31f0ed4405abf6900c7.
Only those exact bytes were appended via apply_patch, preserving all newer P1
history; copied appendix SHA256b8bc33b6a147f24386ae27e174d3c61ac1becd61c6a8056abb4ea20e1d2300dc
matches donor. This does not authorize N1–N5/native emission or any activation.

Fresh final shipped build actual handle60542/start339a0b reached terminal9da10c
**exit0**, exclusive `.tmp/script-plan-final-shipped-build.BGGcUS`.
Exact command/control values are recorded above; no inherited Git-directory/
index/worktree/config overrides, no source changes, donor writes, cache reuse,
restart or compiler/config install. Actual quickjs HEAD954dc53628e36891f93c359aa60895c2ae3dac6b
and wasi HEAD8d8348ec24253d0638a693b8af82445c13d92d32; patched C/H hashes equal
the approved5a7f33e3/aed89048 postimages. All thirteen actual before/after source
digests compare equal, both receipt SHA256
42e5a7806577098c77484d2e23d102f237de604d26d0bc95edcfbcb722a7696d.
Artifact binary95333826e7c8c8ed7398203891db713dc44368c86a24dae6fe6da7d3004fa36c
and ABI4247f2ff4f03420b939692533177ddd485fbcb058a9377ecc33344ce1697f21b
are byte-identical to historical shipped output. Newly generated build-info
SHA256c970d9db70077ade6277b6f6cb44fc110951b7ebc3c240d3abd5845c3db3876e
correctly records formatted helper3a9e654d and exclusive actual flags/paths.
Build terminal SHA2562044be95f65c362ee58a998e618c4ac8e7ef12c78a9a352f10a3bf1bd5411150.

Initial read-only verification command8f11d9 passed readQuickjsArtifact version1
but its redundant assertion mistakenly passed an object instead of positional1;
the command exited1 with unsupported-required-version. This is a CLI invocation
error, not native/provenance failure, and its original log is preserved SHA256
0c9aac997fed5507e12824138e449037bca564d5993ff5e1e09de980a3f9d9fc.
Corrected read-only invocation68d520 uses assertQuickjsScriptPlanCapability(a,1),
exit0: actual nine exports/signatures/version1, no test exports, WASI-only imports,
full current source/provenance validation. Corrected terminal SHA256
0504f15b40232fdb2b4526d78cfadafd57e49447a4b1ac305cd40410abf856b9.
No rebuilt/retried native command or source repair was performed. Build lease
ended on its actual terminal; final runtime remains unrun pending root review.

Root reports upstream main advanced to1787b1af4a2f010f51ca1f45fc68fa540bfa4673,
two commits ahead with only six benchmark/mirrored-website JSON paths. No merge
occurred during this frozen build. Await reviewed exact path comparison before
normal own-WT fetch/merge; preserve all producer source inputs and historical
receipts. Publication remains unperformed, original43/17/integration stay open.

### Final formatted shipped42 and normal upstream integration

Root inspected final build/provenance and granted finite shipped42 on current
probe cd97c847/contractaf5cd721 only. Actual command equals recorded shipped
probe command with final BGGcUS artifact/receipt paths. Terminala9e12c exit0,
no yielded live handle:42/42 PASS. All42 full actual rows were read in compact
c169be (earlier verbose read8faf4a was truncated). Three syntax-error rows retain
SyntaxError/strictnull; all42 compile descriptor identity true and bodyEffect0;
raw duplicate/kind/origin/strict records and22 effective Q1 projections match.
Consume-once/actual identity/throw/source-buffer reuse and valid ordinary cleanup
contracts all pass. JSON SHA256
4abef3e5b1792aefe2fa353eb3d3c3b6dcbc312676045d4208782981e5ceae9a;
terminal e332608f0949c57770c1a262b06bcc0bdf3e99b883c98537eb072f6aa94dc251.
All sixteen actual source/artifact input hashes before/after cmp0, receipt
71f8acc77b321bcc75558acb9ee73e898880245a07a4299bbae67da068a62633.
No final fault7/cleanup diagnostics or matched canaries are implied by shipped42.

After that actual terminal, root supplied its complete six-path compare and
authorized normal integration. Own pwd/branch and Thomas identity rechecked,
MERGE_HEAD absent. Actual fetch handle64532/startf2819e/finalfc29b8 exit0 fetched
exact1787b1af4a2f010f51ca1f45fc68fa540bfa4673, two commits ahead. Actual diff
contains ONLY benchmarks/results/{npm-compat-history.json,npm-compat-perf.json,
npm-compat.json} and website/public/benchmarks/results with the same three JSONs.
Normal `git merge --ff-only upstream/main` succeeded; no force/reset/stash,
primary/source/donor mutation or hook bypass. All thirteen frozen producer source
hashes verify unchanged after merge. No compiler/provider/workflow source changed.
Own HEAD is now1787b1af; all task edits/unrelated Acorn smudge preserved unstaged.
Native build+42 remain exact-source evidence on integrated tree; normal final
publication gates still required. Proposed canary reference update is only the
new shipped build-info literal2c50c717→c970d9db, not applied until root review;
source/expected readings/binary/ABI gates must stay intact. No publication yet.

### Final-source test artifact build terminal

Root approved exactly one canary build-info literal update to actual final
shipped c970d9db; no other canary change. Scoped Prettier/syntax88fb03 exit0,
no formatter rewrite needed. Canary SHA256
5e28933069c0940cf0026a93e9e0b9a894d445027068dc9e9627a175b56f1b35;
all other twelve source hashes unchanged. New integrated thirteen-source
inventory receipt `.tmp/script-plan-final-gates/integrated-source-inputs.sha256`
SHA2565d924535b71d1f36caf451e5147bfe24aaed7936d06520ff0cd99fab06d83e22.

Root granted fresh TESTBUILDONLY after successful normal main integration.
Actual handle7674/start1a577a/terminald4f0da **exit0**, exclusive own
`.tmp/script-plan-final-test-build.wxsHfL/{work,artifact}`. Exact first shipped
command controls apply with only these exclusive paths and testmode1 changed;
existing LLVM18.1.8/CMake/Node24/1024/JOBS1, same pins and Git override scrub.
No donor/cache/staging reuse, source edits, restart, install or config mutation.
Actual quickjs/wasi HEADs954dc53/8d8348ec and C/H postimages5a7f33e3/aed89048
match; all thirteen actual before/after source hashes compare equal to5d924535.
Read-only diff --check and source verification c8db2d exit0 during build.

Final test binary SHA256
6cfa0d0a3d4766da926e12830f511659a262e58b6c6a3edbb2a5c4e4f0732b46;
ABI4247f2ff4f03420b939692533177ddd485fbcb058a9377ecc33344ce1697f21b,
both byte-identical to historical repaired test output. Fresh generated build-info
585ecfe8ca4d82cf52ac0fd8337e48dd75601edf79ddc8a49826d9a7764964c2,
records current helper3a9e654d/test-hookeac59afd/testBuildtrue and actual exclusive
flag paths. Build terminal SHA256
b3f026310793342f8154f345b7f7e9d70ff62fccdde0d4b77bc8029631dc8537.

Actual final verification8c7f97 exit0: actual nine private plain-C signatures and
version1, eleven test functions including exportedqjs_script_plan_test_cells,
no internalcell_countexport, WASI-only imports. Source/provenance/test-hook
digest/compiler testmode and current metadata validation pass. Default production
reader positively rejects it as test-only. Complete verification terminal SHA256
8527b09bd796bf710285882987dd938fc599c822de5636a7014c7d52abd66394.
Heavy build lease ended on actual terminal; final fault7/two cleanup diagnostics
remain unrun until root artifact review/new finite GO. Original43/17/integration
stay open, no production activation or publication.

### Final-source allocation7 and two separate cleanup diagnostics

Root read final test artifact's full provenance/exports/production rejection,
then granted finite current fault7 plus unchanged two separate diagnostics.
Actual canonical Node24/1024 probe --faults uses final wxsHfL artifact and own
new `fault7-results.json`/`fault7-terminal.log`. Terminal99d4a2 **exit0**, no
yielded live handle:7/7 PASS, both separate diagnostics PASS. All seven complete
expected+actual rows and both diagnostic objects read directly in9ff0d8 without
truncation. Native-plan-header, native-record-array, source-buffer-staging,
shim-registry-node, owned-name-result-cell, eval-result-cell and
post-capture-compilation remain distinct frozen identities/sites1–7.

Every row retains actual InternalError, descriptor identitytrue, exact private
baseline after failure, unchanged READY on cell failure assertions and successful
recovery/consume semantics. Released and afterTeardown counters all zero for
nodes/buffers/plans/held-atoms/arrays/compiled/cells; held atoms include filename.
General engine allocation counts remain diagnostic, not a total-memory balance
claim. Test-only-nonempty-normal-context-cleanup separately measures normal shim
context teardown, with twoREADY+oneCONSUMED states[0,0,2]. Private-runtime-backstop
separately invokes the identified test hook, never invalid JS_FreeRuntime on live
contexts. Each starts4nodes/4plans/11atoms/3arrays/3compiled/0buffers/0cells,
preserves unrelated1node/1plan/2atoms/1array/1compiled after target cleanup, then
released+normal teardown all seven counters0. Diagnostics do not enlarge7.

Full JSON SHA256
f6ad4f1aa52932abf00ac9238bbc5fb638810c090eb1b3dc4f8a4731d343b8e1;
terminal202f11f06314e203b76262b2fecbbf12170c841a5c21715d9131724bb95b0e07.
All sixteen actual source/artifact inputs before/after compare equal, receipt
72e22dd1de91bb9a84503f7ee67f1fdf3914cfd26513b7cfd839e57d5580f58c.
This current formatted/integrated snapshot has shipped42/native allocation7
plus two diagnostic passes; final current matched22 canaries remain unrun.
Runtime lease ended at actual terminal and is released for Map baseline tests.
No further native/canary compile/build job until new root GO. Low-cost preparation
only; original43/17/census/global integration remain open, no publication yet.

### Final matched canary source-only preflight and publication preparation

Root accepted final7/two diagnostics and assigned heavy lease to Map baseline;
only source-only compatibility preparation and low-cost PR preparation here.
New exclusive own `.tmp/script-plan-final-canary-pair.00tgYo/{old,new}` holds
copies of six immutable bytes: old from own JdZSoZ staging, new from final
BGGcUS shipped output. No donor write or metadata edit. Old exact binary/ABI/
build-info07374280/0aab187d/4c503365; new95333826/4247f2ff/c970d9db. Both three-file
arms verify the full already-recorded SHA256 pins. Old native compiler18.1.3 vs
new18.1.8 caveat remains, matched own user/adapter compiler identity unchanged.
Current canary5e289330 preserves all four maintained source hashes/options,
fresh four realms per artifact and fixed eleven readings42,7,151,42,111,42,4321,
6543,42,11,52. Nothing compiled or executed at this preparation checkpoint.

Actual read-only productionInputs preflight38e784 includes all1836 inputs,
all1824 actual src files; full hash
fd5a4f0ee89fc1a358423ac55c3074a180b68bcbaf899c5e59f36ad391c765bf.
JSON `.tmp/script-plan-final-canary-pair.00tgYo/production-inputs-preflight.json`
SHA256f859ef0eac9681571f40c93e850237a5005a2643030ed22cee89843bfa9bf48c;
maintained source-compiler identity72b16e064b646934, no bundle bytes used. All
thirteen producer source digests verify stable. Renewed runtime needs root GO,
new exclusive results, environment override scrub and full input/artifact
before/after receipts; do not overwrite prior failed or accepted historical arms.

Exact fifteen intended commit paths are listed in
`.tmp/script-plan-final-gates/owned-paths.txt`: seven tracked task files,
three pinned-patch files, four dedicated producer probe files and one new test.
Unrelated Acorn smudge, .tmp receipts, native staging/generated binaries and all
donors are excluded. Thomas user.name/user.email verified again in4dfc5a.
Draft PR body follows maintained Description/CLA template with unchecked CLA
(agent does not accept on user's behalf), distinguishes MOCK/native/diagnostic/
historical-current receipts and leaves original43/17/global work open.
Draft `.tmp/script-plan-final-gates/pr-body-draft.md` SHA256
604cd234904b93811f405970cf749cde8fd5406167fd0d3fbeb928d567b394c6.
No commit/push/PR yet. Normal hooks remain required: precommit scoped
lint-staged Prettier+Biome and unconditional LOC/function budgets (sanctioned
SKIP_SLOW_PRECOMMIT applies only slow changed-root/oracle); prepush type/lint,
changed formatting, oracle/coercion ratchets, numeric-local IR regression,
conformance check and committed-tree/working-tree issue integrity. No bypass,
ratchet waiver, mid-freeze source rewrite or ownership takeover is authorized.

### Final integrated matched compatibility terminal:22/22 PASS

After Map baseline's actual terminal, root granted finite final matched11old+
11new on exact canary5e289/current1836fd5a/immutable00tgYo pair. Canonical Node24
launcher uses --importtsx child,1024MB and the previously recorded complete
override-prefix scrub; actual removed names onlyGIT_PAGER/NODE_OPTIONS.
New exclusive00tgYo/results; no native build, cache publication, donor mutation,
bundle/flag override, source edit, retry or expectation adjustment.
Actual handle97816/start286c60 reached terminal10c394 **exit0**:
old11/11 PASS,new11/11 PASS, all22 readings measured, no pass loss. Compact
5db631 read ALL22 expected/actual rows and ALL8 initialization witnesses without
truncation (prior pretty read11b520 truncated, not substituted as full proof).
Each arm actual values42,7,151,42,111,42,4321,6543,42,11,52, unchanged why/options.
Every actual realm uses native Wasm start indices734/706/843/704 respectively,
nativeStartCompletedtrue/startCalledfalse; no double initialization.

Complete actual capability/adapter/artifact/user import/export maps, tool/options
and all four compile results read56f239 without truncation. Source loader is
src/index.ts(tsx), bundleBytesUsedfalse, compiler72b16e064b646934. Capability
9e898a716d12e4acda03af330221e721428f15010c6404462e7486be2094a257,
adapterfa105724f9d2379e2ffe420e3bf3df925f3108a422039a94a67db2a407ee4c54,
four users701b3158/8c8604cd/c9d09231/d656725d are byte-identical to the earlier
matched compiler's outputs. Adapter SOURCEde224ca0 and actual only maintained
externs stay unchanged; no private plan export appears in adapter imports.
All five provider namespace entries callable in each fresh realm. Old native
compiler18.1.3 vs new18.1.8 provenance caveat remains explicitly recorded.

Full JSON `.tmp/script-plan-final-canary-pair.00tgYo/results/results.json`
SHA256f09bf2aa9f3428962785db8cb55bbca78e08c3151ca6764003dd5e8c77622af5;
terminaladaddc6ec74bede3ab33d0f07383e426fc86bcf9af1e29a9b85546fbc2cd54eb.
All1836 production inputs before/after and independent post-read equal
fd5a4f0ee89fc1a358423ac55c3074a180b68bcbaf899c5e59f36ad391c765bf;
preflight/after JSONcmp0, bothf859ef0eac9681571f40c93e850237a5005a2643030ed22cee89843bfa9bf48c.
Six staged artifact bytes before/aftercmp0, receipt
73daea2b15d30787e6cab3a1449a0042a6192668ab799efd82d6bee25005a47f.
All thirteen integrated producer source hashes still match. Heavy lease ended
at actual terminal; STOP before commit/publication pending root full evidence
review. Current finite P1 acceptance42/7+2diagnostics+22compatibility and MOCK24
does not complete original43/17, activate Script routing or improve census.

Read-only publication claim preflight before canary launch: exact leaf --check
actual2481/b39134 exit3 positively identifies OWN ttraenkler/script_plan_p1_sol,
not a foreign collision or UNKNOWN/clearance. Log SHA256
82ad1983d18d10839cf0a84ae0dc799ee2618002529e08796ca007e5ccaaeb07.
Complete maintained upstream --list --json actual83618/467964 exit0,1035 active
claims; raw JSON SHA256c18f9ed553450e367cc551802535b682e0ae8def4d5ef203899803038d489007.
Own leaf/branch unchanged;4245/4308/4647/4540/4542/4544 and foreign5157 slices
remain held and preserved. No claim write/release/takeover. Upstream full PR
path/actual-match refresh still required before publication; no stale CLEAR.

### Actual publication path refresh: known shared-document collision retained

Complete read-only GitHub REST pagination/detail reconciliation actual6070/
ec5e86 exit0 captured2026-10-04T21:01:38.216Z:17 open upstream PRs/1424paths,
every per-PR file count equals unique count AND actual detail.changed_files.
Counts6475/31,6468/402,6436/4,6435/4,6383/4,6341/102,6288/11,6246/6,
6234/3,6206/17,6195/4,5942/9,5911/10,5883/302,5784/93,5753/294,5748/128.
All pages/detail metadata and matching full raw diff are retained under
`.tmp/script-plan-final-gates/pr-paths`; no100-file UI cap or omitted-page
absence inference. No producer/provider/probe/test source match. ONLY known
positive sharedMD5157 match is6246 at actualhead49e6fe14795de20020c2c68901cf184ef308a325.
Actual matching MD patch all826 lines read in807406/23bbff/16bb4b; prior pretty
JSON print truncated and is not substituted as a full patch review.
Inventory SHA256f27d4764ff1b0245d36b5d76f88da30d27a367e576c5394392798444aa4a5343;
full6246.diffac94c985ceb1734a090bc8ffe24fbdf08bdbaece24f83bd33c2e875fe16edf3c;
terminal20de1002f09c4bf61b93b05c32b005806b8544fc82d1d446bae85a5b3d680a43.

This is narrow source collision evidence, NOT whole-issue CLEAR. Foreign6246
edits its update date/ClusterG correction and appends eval-spread/evaluator
history after the original400-line section. Own base815 includes landed naming
history403–815; own newerP1/P2 remains intact. No foreign content was overwritten,
reverted or automatically copied. Any later shared-document merge resolution
must preserve BOTH naming/P1/P2 and complete6246 history. Root was informed of
the positive conflict; existing compiler/eval/identity/allocator protocol claims
remain held. Commit/publication await root acceptance and normal gates.

### Publication staging diagnostic: unified-diff context prefix is patch data

Root accepted final current canary evidence and authorized exact fifteen owned
paths/normal publication hooks. Actual staging3cf643 includes those fifteen only;
its cached whitespace check exits2 on native patch asset lines28/156/222/256.
All four are exactly single ASCII space: the unified-diff blank CONTEXT prefix,
not trailing whitespace in a native added line. Earlier unstaged checks did not
inspect this then-untracked asset; they are not retroactive cached-check passes.
No commit/push occurred on discovery. Root independently verified the exact
four bytes/surrounding hunks (3bb631) and retained actual failed cached check.
Stripping required prefixes would corrupt the frozen patch; no patch/provenance,
global whitespace policy, hook configuration or source expectation was changed.

Actual read-only apply-check8188a4 passes against own pristine preimage directory;
all thirteen source hashes still verify. Root approved representation diagnosis
and continuing NORMAL hooks unchanged, not claiming cachedcheck0. The remaining
fourteen paths' explicit cached whitespace check passes; any additional defect
or actual normal hook refusal must stop publication for its precise repair.
No ignore rule, whitespace waiver or hook bypass is added. Actual built native
postimages and maintained patch-source checks remain authoritative acceptance.
Thomas identity verified, core.hooksPath.husky; commit.gpgsign is unset, so normal
commit is unsigned without override. Final source/native/artifact freezes remain
unchanged; only this explanatory documentation is appended before restaging.

Read-only explicit maintained source-check first e59f80 exited1 because this
CLI passed a manifest object instead of the upstreamCommit string (and spelled
the image argument as a field name). This invocation error is retained, not
native source damage. Corrected invocation uses exact maintained signature
checkScriptPlanSource(dir,p.manifest.upstreamCommit,"preimage"|"postimage",p);
both own pristine preimage and final-test native postimage checks pass with
unchanged patch/schema/pin/digests. No source or expectation repair is involved.

### Actual first normal commit refusal and message-only repair

Normal commit handle61246/start4d04f1/terminal89e59c exits1, no commit created.
Maintained lint-staged automatic backup/tasks/cleanup completed; Prettier, Biome,
LOC/function budgets passed. All thirteen source hashes still verify idempotent.
commit-msg blocks the missing required `Model:` trailer: model/effort was present
only in message prose. Actual hook read completely (80lines186b2c); exact repair
adds `Model: Codex GPT-6.1 Sol High`, retaining Thomas author/committer and Codex
coauthor. No production/source/expectation/config/hook change.

The first invocation also mistakenly set sanctioned SKIP_SLOW_PRECOMMIT=1 despite
root's latest NOskips requirement; thus its changed-root/oracle slow tier did NOT
run and no full-gate claim follows from the passed fast tier. Root corrected this
and authorized a message-only NORMAL retry with ALL skip variables UNSET and
the complete slow tier. No push/publication may precede that actual full result.
No manual stash/reset/cleanup was used: reported backup was lint-staged's normal
unchanged implementation. Source/artifact acceptance snapshots remain stable.

### Actual full normal publication gates and P1 pull request

The message-only corrected normal commit handle58575/start586af3/terminal1375bc
exits0 and creates17fd13bcc798705f0cd364a5d83445d4686f1d80. All skip/HUSKY
variables were removed (none inherited); canonicalNode24/1024 and the existing
package tools were used with Corepack network acquisition disabled. Full normal
Prettier/Biome/LOC/function gates, changed-root MOCK24 and oracle slow tier pass.
Commit terminal SHA256f2f0feb8febca25619eb2501bf62931f5c0181493118488dba486c7157cbe0a5.
Thomas Tränkler is both author and committer; actual trailers are
`Model: Codex GPT-6.1 Sol High` and `Co-authored-by: Codex <codex@openai.com>`.
All fifteen owned paths and no generated artifact/unrelated path are committed.
Actual979870 verifies all thirteen working and committed-source digests; extra
committed issue integrity34779/cd07fc passes4742/4742. Unrelated Acorn bytes
remain unchanged and were not staged. No source expectation/provenance repair,
manual stash/reset, signing override or hook/config modification was needed.

Normal fork push handle59722/startff9c41/terminal666fff exits0 without skips or
HUSKY bypass. Full typecheck/lint, changed-file format check, oracle/coercion
ratchets, numeric-local parity18/18 and issue integrity pass. Full push terminal
SHA256575ac2a6d5853204a01dbc3952e76fe4523770542f80f904863ad7e72a6d194d.
Actual remote verification22861/a874e0/77d2dd exits0: own fork branch is exactly
17fd13bcc798705f0cd364a5d83445d4686f1d80 and upstream main remains
1787b1af4a2f010f51ca1f45fc68fa540bfa4673. All thirteen source receipts still
match and working status is clean before this documentation-only checkpoint.
The intrinsic unified-diff context-space cached-check exit2 remains historical;
normal hooks passed without stripping patch data or adding a whitespace waiver.

Non-draft P1 PR https://github.com/loopdive/js2/pull/6476 created by normal
gh create51532/f93e43 exit0 and attached to the Codex task. One-shot actual
view/API89889/d9dba2/fe7563 verifies OPEN, head17fd13bcc798705f0cd364a5d83445d4686f1d80
in ttraenkler/js2, base1787b1af4a2f010f51ca1f45fc68fa540bfa4673/main in
loopdive/js2, fifteen changed files/one commit, mergeable=true, merge-state
blocked and no review decision. Initial CI/quality/native artifact/CLA checks
are in progress; baseline admission and relevance detection succeeded. Initial
sharded provider/census jobs were skipped, not measured conformance evidence.
No queue change, foreign PR takeover or CLA acceptance was performed. CLA box
remains unchecked. Submitted body SHA256
7f714a6373a8a186ffc31704128560861035e65ec2449f5a9c152278aea28fee
records actual normal-gate passes and the known6246 document-history overlap.

Current finite P1 acceptance remains shipped42/42, fault7/7 plus two separately
reported cleanup diagnostics, MOCK24/24 and matched old11/new11 compatibility,
with the frozen source/artifact receipts above. Producer is INACTIVE; original
43 diagnostics/17 compiled controls, P2/native-instantiation and consumer
integration/census remain open. Root accepted publication and released heavy
lease at actual push terminal; this append is source-only until a later normal
documentation commit/push lease. No extra runtime/build/watch was started.
