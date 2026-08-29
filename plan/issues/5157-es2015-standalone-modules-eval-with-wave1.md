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
