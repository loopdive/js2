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
