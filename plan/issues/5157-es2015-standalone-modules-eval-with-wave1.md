---
id: 5157
title: "ES2015 standalone: modules-eval-with conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-09-28
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

> **Historical diagnosis corrected (2026-09-28):** Cluster G's table entry is
> retained as the original triage record, not as the current causal claim. A
> `class` declaration makes this eval source take the separately compiled
> QuickJS provider rather than the inline splice; see the corrective handoff
> below and the recorded #5271 X4 routing.

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

## 2026-09-28 narrow continuation: eval spread-argument evaluation

Claim `5157:eval-spread-arguments` is verified upstream for
`ttraenkler/codex-eval-spread-arguments`, branch
`codex/5157-eval-spread-arguments`, based on freshly fetched main
`1032526dc12302034e558934b60363348e80b8bd`. The previous landed RegExp branch
is preserved; its clean worktree is reused. The read-only issue check found
no live parent owner; a complete one-shot scan of 14 open PRs found no
overlap in `expressions/eval-inline.ts` or
`expressions/runtime-eval-provider.ts`. Those files are unchanged since the
`45ce4a8e` audit. This claims only the named slice, not the broad wave.

### Evidence and implementation plan

Frozen census index 27 fails unchanged
`test/language/expressions/call/eval-spread-empty-trailing.js`: its final
`nextCount` assertion observes zero instead of one; the preceding local and
global `x` assertions pass. Receipt JSONL SHA-256:
`37345bd261c4baed979361a43a717c9e9565b2fc302c0e734bfd737a644dbdbe`.
This is historical baseline evidence, not yet a current-source reproduction.
`eval-inline.ts` compiles and drops extra argument expressions; generic
SpreadElement compilation unwraps the operand without running its iterator.
Runtime-eval extra-argument loops need the same semantic audit. Merely
declining inline eval is not a repair.

1. Establish an unchanged-original current baseline with passing direct-eval
   lexical-scope and ordinary nonspread argument controls. Retain complete
   maintained-runner receipts and the exact source/provider/corpus identity.
2. Reuse existing iterator/argument-list primitives to perform eval's complete
   ArgumentListEvaluation before execution: preserve callee/argument order,
   evaluate each once, expand spreads, retain the first resulting value, and
   evaluate/discard later values only after their required side effects.
   Preserve direct-eval lexical scope and ordinary non-string eval behavior.
3. Keep new semantics in a focused helper if needed, with minimal wiring in
   the two owned eval files. Audit static/direct/runtime/indirect consumers.
   Do not widen generic expression, iterator, IR, bridge, or runtime code
   without a new ownership check. No hard-coded original shape or test name.
4. Add focused controls for empty/nonempty trailing spreads, leading spread
   and zero resulting arguments, multiple argument ordering, single iterator
   acquisition/evaluation, noniterable and abrupt iterator/getter failures,
   skipped eval execution after argument failure, and shadowed/nonintrinsic
   eval. Follow the iterator protocol's actual abrupt-completion semantics;
   do not invent IteratorClose where the specification does not require it.
5. Compare the unchanged original and relevant neighboring originals on
   baseline/candidate, with complete receipts and no exclusions. Run focused
   eval neighbors and normal gates. Publish one ready upstream PR for the
   completed slice, or draft only if acceptance remains genuinely unfinished.

The broad #5157 wave remains in review. Historical budget allowances do not
grant arbitrary new growth; request a precise justified allowance only if a
normal gate requires it. The implementation must coordinate the sole heavy
test/build lease with root; other-machine IR changes remain protected.

### Current-source maintained-runner baseline (2026-09-28)

The exact seven-file manifest was run on this continuation's unmodified source
through the maintained one-shard Test262 runner (standalone target, QuickJS
eval tier, one worker; no exclusions). It is a current-source reproduction,
not the historical census evidence above:

- source commit: `1032526dc12302034e558934b60363348e80b8bd`; source tree:
  `8a5482d7bb3a411333e7314da99f4770ebe46d7d`;
- exact manifest:
  `benchmarks/results/test262-standalone-exact-manifest-20260928-092756.txt`
  (SHA-256 `0b2242befd25167100edb84ad1d4ece1eb761a4e1054b782e0a2c172a87a837e`);
- complete JSONL receipt:
  `benchmarks/results/test262-standalone-results-20260928-092756.jsonl`
  (SHA-256 `8ca3f545a8c67bfe6d1e20c6fadc0f8f8b5338fb2e63fb5c9ddf914c3be14769`),
  with report
  `benchmarks/results/test262-standalone-report-20260928-092756.json`
  (SHA-256 `8205fcb394ad1f841408455e682c64b3bbcf0030a673bc7ce27ad7d6894d4948`);
- the retained maintained-runner terminal log was
  `/tmp/test262-vitest-run.log` (SHA-256
  `3b118c5f0440cd2bd31573a91fbf85138639b8f26b346eb126ebda40d57edbf6`).
  It records a fresh compiler/runtime bundle build, adapter cache MISS,
  adapter compilation, and canary verification rather than reuse of a stale
  provider artifact;
- fresh compiler bundle SHA-256:
  `3be400279eb53978471526fff515a3d886300932bf6c81da7d2a4cba3c57d7cc`;
  runtime bundle SHA-256:
  `462296a4366ad4d70f6acfc5d1db876f6dd6ecc431a810f48b63ce84bffa8709`;
  QuickJS adapter key `ac848c5ba005512d`, artifact key
  `e9f8d30bc347dbc5`, and adapter SHA-256
  `9aeb629d4eda26359e5e30ae8803e41740cd6527cb53d0a8f0f09a436fd8f328`.

Result: **3 pass / 4 fail**. The four official spread cases all fail:
`eval-spread.js`, `eval-spread-empty-leading.js`, `eval-spread-empty.js`, and
`eval-spread-empty-trailing.js` (the original trailing case is exactly
`Expected SameValue(0,1)`). The controls pass: `eval-first-arg.js`,
`eval-no-args.js`, and direct lexical-scope
`eval-code/direct/var-env-var-non-strict.js`. This establishes both the full
spread regression surface and a clean direct-eval/nonspread control set before
the implementation below is measured.

### Intermediate candidate evidence; semantic audit still open

Two maintained-runner candidate attempts are retained rather than overwritten:

- `20260928-093715` records the first helper shape. It preserved all three
  controls but converted the four spread assertions into compiler
  stack-balance errors. The cause was a value carried into an empty-typed
  branch; the repair captures that value in a local before selecting the first
  expanded argument. Its JSONL/report/completion files remain alongside the
  later run for review.
- `20260928-093831` is a complete provisional green run of the same exact
  seven-file manifest: **7 pass / 7 registered / 0 exclusions**. JSONL SHA-256
  `88301b4c431ff067044cb4790a4a0203e0d07cf8e3befae4291af0d0ab9b0643`;
  completion-marker SHA-256
  `e5eb0e08b11977ec9b812faf39fd76bfb6139e01e8874711b4ecf2a2ed0b1e75`;
  manifest SHA-256 unchanged
  `0b2242befd25167100edb84ad1d4ece1eb761a4e1054b782e0a2c172a87a837e`.
  This is intermediate evidence only, not final acceptance after the audit
  below.

The first implementation reused `buildSpreadArgList`, but its intentional
two-phase design captures a vec's backing storage and reads individual values
only from a later `emitStores` phase. A following argument can therefore
mutate the source between spread iteration and first-value selection. Its
compatibility materializer also is not by itself proof that a custom
`Symbol.iterator` on a native carrier is observed. Eval needs the stricter
per-argument `ArgumentListEvaluation` timing, so the candidate is being
reworked in the eval-owned helper to use the existing strict native
GetIterator/IteratorNext provider and capture each expanded value before the
next syntactic argument. The helper must preflight that provider and every
runtime-eval carrier before it emits user argument effects; otherwise a
decline could cause a fallback to evaluate them twice.

Final focused controls must cover the original four paths plus a mutable spread
source followed by a mutation argument (`['x=1']`, then `args[0] = 'x=2'`;
eval must execute `x=1`), the indirect/global counterpart, custom iterator
override, empty expansion, and abrupt/noniterable no-eval behavior. Do not
widen the generic spread builder unless separate ownership is granted.

### Focused semantic audit: provider representation boundary (not accepted)

The eval-owned streaming helper is deliberately not final acceptance yet. Its
first focused split receipt is
`/private/tmp/5157-focused-split-direct-20260928-1000.log` (SHA-256
`9766cd98581754a06f487b4afa0e1a5519c256ac91d341453b519c1c0c411085`),
run on the uncommitted candidate at source commit
`1032526dc12302034e558934b60363348e80b8bd` with one Vitest worker and the
QuickJS eval tier:

```text
VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
JS2WASM_EVAL_ENGINE=quickjs pnpm exec vitest run \
  tests/issue-5157-eval-spread-arguments.test.ts --maxWorkers=1 --minWorkers=1
```

It records five passing controls and one intentionally retained failure:

- source-order snapshot (`args = ['x = 1']`, then a later argument changes
  `args[0]`) passes;
- direct lexical eval, non-string first value, and empty custom iterator all
  pass when their spread source has been bound to a local first;
- the indirect and global-Script runtime routes pass their source-order
  controls;
- the original combined strict-protocol probe returns **23** in Wasm. Its raw
  Node v22.23.2 isolated-VM spelling historically returned **7**, but that is a
  V8 direct-eval-with-spread defect and is retained only as a diagnostic. Root
  independently reran both fresh VM forms in terminal chunk `b483b8` (exit 0,
  no compiler lease): the narrowly adapted oracle returns the spec value
  **15**. The prior unsplit receipt (terminal chunk `33ba3b`, before the
  writable receipt was redirected to `/private/tmp`) also preserves the direct
  literal failures below.

The persistent focused fixture is
`tests/issue-5157-eval-spread-arguments.test.ts`. Its
`ORIGINAL_GROUPED_PROTOCOL_PROBE_BODY` retains the literal original calls
(`eval(...doneWithoutValue)`, `eval(...abrupt, ...)`, `eval(...nonIterable,
...)`, and `eval(...array)`) as executable candidate coverage. The sole
oracle adaptation in `ORIGINAL_GROUPED_PROTOCOL_ADAPTED_ORACLE_BODY` is:

```js
const expandedOverrideArgs = [...array];
eval(expandedOverrideArgs[0]);
```

It deliberately leaves the later ordinary `nonIntrinsic.eval(...["ordinary
call"])` spread unchanged. Under [ECMAScript 2023
ArgumentListEvaluation](https://tc39.es/ecma262/2023/multipage/ecmascript-language-expressions.html#sec-function-calls-runtime-semantics-evaluation), direct eval first evaluates the
complete argument list and then uses its first result. Therefore bits 1, 2, 4,
and 8 must be true; the later ordinary call observes the overridden iterator
and does not add bit 16. The acceptance value is **15**. The test asserts only
the adapted oracle and Wasm result; it does not pin the historical raw-Node 7
result, so a future host repair will not turn the test into a false failure.

Splitting made two representation gaps concrete rather than allowing a green
test to hide them:

1. `eval(...['lexical = 7'])` and `eval(...[marker], ...)` throw an opaque
   Wasm exception, whereas identical values first bound to local arrays pass.
   `expressions/extern.ts` documents why: an inline static array literal lowers
   to a tuple struct, not a `vecTypeMap` vector (`extern.ts:1069-1086`). The
   strict provider admits canonical/vec-family carriers and only the empty
   tuple, so a non-empty tuple falls to its non-iterable path.
2. A local array's runtime `Array.prototype[Symbol.iterator]` replacement is
   ignored. `__iterator_strict` routes canonical and vec-family arrays through
   its early VEC arm before it reaches the strict object-method branch
   (`iterator-native.ts:3850+`, especially the arm ordering around 4430+).
   The original combined probe therefore exposes a generic spread/iterator
   discrepancy too: after the override, ordinary `nonIntrinsic.eval(...array)`
   follows a different path from the isolated VM reference. This probe is
   retained as a diagnostic, not relabelled as expected behavior.

Node's native direct-eval-with-spread special case is itself not an oracle for
the direct controls (on this Node it leaves `eval(...['x = 1'])` unevaluated),
so the direct outcomes are specified by the Test262 ArgumentListEvaluation
requirements; the isolated VM is still used for the indirect/global and
generic-spread diagnostics. A tuple-field shortcut in the eval helper would
make the first gap appear green but would silently violate the second required
`@@iterator` behavior, so it was not added. No final Test262 candidate receipt
may be claimed from the earlier provisional 7/7 run.

### Provider ownership/dependency audit and held repair decision

The strict provider prerequisite is outside this slice's owned files:

- `src/codegen/iterator-native.ts::ensureNativeStrictSpreadRuntime` registers
  `__iterator_strict` and `__iterator_next_strict`; its late fill is
  `fillNativeIteratorLateArms`, which calls `buildIteratorBody` with strict
  arms. `buildIteratorBody` takes canonical/vec-family arms before strict
  object-method dispatch, so compiled arrays skip a captured
  `Array.prototype[Symbol.iterator]` method. `buildEmptyTupleFamilyArms` admits
  only zero-field tuple structs, leaving non-empty static tuple literals on the
  non-iterable path.
- `src/codegen/literals.ts::compileTupleLiteral` creates those static tuple
  carriers; `src/codegen/expressions/spread-arguments-call.ts::tupleStructFields`
  is the existing structural decoder. `expressions/extern.ts:1070-1090`
  records the same non-empty-tuple distinction. Decoding tuple fields here is
  not safe: it bypasses GetIterator when Array's prototype iterator is
  overridden.
- The completed CPR precedent is #1749:
  `src/codegen/expressions/proto-override.ts::arrayIteratorOverrideGlobalIdx`
  and `emitArrayProtoIteratorDrive`, rooted by
  `reserveArrayProtoIteratorOverrideGlobals` and the
  `sourceOverridesArrayIterator` scan in `src/codegen/index.ts`. #1749 uses
  that drive from `literals.ts` for array-literal spread. It provides a narrow
  candidate route for a future eval-owned Array/tuple branch, but its returned
  iterator is normalized through compatibility `__iterator` /
  `__iterator_next`, not the strict provider ABI. Whether that bridge preserves
  all strict malformed-iterator behavior must be decided and proved before it
  is reused here.

Repository-local ownership evidence: #5131 is `status: done`, PR 5272, and
listed `iterator-native.ts`/`literals.ts` among its files; it explicitly says
static array-literal prototype overrides are out of scope. #1749 is also
`status: done` and is the completed CPR consumer precedent. The live team audit
found no current strict-provider owner. The parent one-shot scan of 14 open PRs
only established no overlap in the two eval wiring files; local historical refs
are not evidence of a currently open provider PR, and no GitHub polling was
performed. Any generic strict-provider change therefore needs a fresh explicit
claim and scope grant.

An action-tied exact path scan of the currently open PRs and upstream assignment
registry was then performed before considering such a grant. It found:

- PR [#5753](https://github.com/loopdive/js2/pull/5753)
  (`ttraenkler:codex/1058-typescript-standalone`) changes both
  `src/codegen/iterator-native.ts` and `src/codegen/literals.ts`; #1058 is
  currently unassigned, but the open PR remains a concrete merge-conflict
  surface.
- PR [#6235](https://github.com/loopdive/js2/pull/6235)
  (`loopdive:claude/es6-6651-a7-gen-self-binding`) changes
  `src/codegen/literals.ts`; #6651 is actively claimed by
  `ttraenkler/project-thread-yhj9pp`.
- PR [#5784](https://github.com/loopdive/js2/pull/5784)
  (`loopdive:codex/4376-deno-realm-main-sync`) changes
  `src/codegen/literals.ts`; #4376 has no active lock (last status released).
  No open PR in that scan changes
  `src/codegen/expressions/proto-override.ts`.

The upstream assignment check also confirms that
`5157:eval-spread-arguments` remains claimed by
`ttraenkler/codex-eval-spread-arguments`; #5131 has no active claim (last
status done), and #1749 is unassigned. Consequently neither the generic
provider nor `literals.ts` is safe to modify from this continuation without
root coordination despite the completed historical issues.

### Read-only generic GetMethod integration audit (2026-09-28)

**Result: there is no existing eval-owned route that gives full Array
GetMethod/IteratorNext semantics.** This audit made no source edits and ran no
compiler or test process.

The strict provider already has a correct dynamic path for `$Object` and Proxy
carriers: `iterator-native.ts::buildIteratorBody`'s `strictObjArm` reads
`@@iterator` through `__extern_get` and invokes the result through
`__apply_closure` with the original receiver. That is the path to retain for
ordinary objects and proxies. It cannot serve compiled arrays, however: the
same function first takes the canonical vec arm and then
`buildVecFamilyArms(..., true)` before it reaches `strictObjArm`. The vec arm
reads/snapshots backing storage and returns a `$IterRec`, so it neither gets an
own/prototype iterator property nor preserves a user iterator's protocol.

There is a tempting but incomplete vec property primitive:
`vec-props.ts::VEC_PROP_GET` (`__vec_prop_get`). It reads an actual vec's own
bag and, on a miss, calls the receiver-aware prototype-companion lookup; a
future caller could pass that same vec as `this` to `__apply_closure`. It is not
a complete GetMethod solution for this issue:

1. `assignment.ts` intercepts recognized
   `Array.prototype[Symbol.iterator] = function ...` writes through
   `maybeCaptureArrayProtoOverride`, which stores the closure only in
   `ctx.protoOverrides`. It deliberately does not write the normal native
   prototype companion, so `__vec_prop_get` cannot observe the captured
   override at all.
2. Its inherited companion lookup is demand-gated by the proto-index store and
   native-prototype seeder. Even the default Array `@@iterator` value is not a
   universally available generic read. When the reflective Array iterator body
   is available, `array-proto-iterator-value.ts` explicitly materializes a
   snapshot vec, which is not a proof of live ArrayIterator behavior under
   mutation.
3. It only recognizes vec carriers. Non-empty inline array literals are
   `__tuple_*` structs: `spread-arg-list.ts` decodes their fields statically,
   while `buildEmptyTupleFamilyArms` admits only zero-field tuples. A tuple has
   no vec bag/prototype carrier that this helper can query, so converting it at
   the eval observation point would lose the source array's property identity.

The existing CPR drive is similarly useful evidence but not a shortcut.
`proto-override.ts::emitArrayProtoIteratorDrive` correctly converts the actual
vec/tuple reference and calls its captured closure with that value as `this`.
Its public result has already been passed through compatibility `__iterator`,
though, and is intended for compatibility `__iterator_next`. Replacing only
the later step with `__iterator_next_strict` does not repair the earlier
compatibility normalization; calling `__iterator_strict` on the raw iterator
would incorrectly perform GetIterator a second time. The raw driver is private
and the public CPR path covers only the narrow captured Array-prototype form,
not own overrides, arbitrary prototype writes, or proxies.

Accordingly, a full repair needs protected ownership rather than an eval-only
workaround:

1. `src/codegen/iterator-native.ts` needs a strict raw-iterator record adopter
   (or equivalent strict Array GetMethod branch) which accepts the result of
   the single `@@iterator` call and validates `next` / IteratorResult without
   invoking GetIterator again.
2. `src/codegen/expressions/proto-override.ts` needs a raw/strict CPR export
   that exposes the existing receiver-preserving driver before compatibility
   normalization, so the captured Array-prototype override can enter that
   adopter exactly once.
3. `src/codegen/literals.ts` (or another representation owner) must make a
   non-empty array literal observable through the same property-capable
   representation before iteration; static tuple field expansion is not a
   valid substitute. This must preserve aliases and leave the existing
   `$Object`/Proxy strict path untouched.

`iterator-native.ts` and `literals.ts` overlap open PR #5753 (and
`literals.ts` also overlaps #6235/#5784); `proto-override.ts` had no overlap in
the completed action-tied scan. The held repair therefore remains blocked on a
new explicit cross-file scope/ownership decision. The literal-array and
override controls stay executable expected failures, and the provisional
seven-row Test262 green receipt remains intermediate evidence only: no heavy
run, provider edit, commit, or PR is authorized from this resumable handoff
state.

### Corrective handoff: class-eval completion values (2026-09-28)

The historical Cluster G table and plan wording above are retained for triage
history but are not the current diagnosis. `eval('class C {}/1/;')` cannot use
the inline eval splice: `allNodesInlineSupported` rejects `ClassDeclaration`
in `eval-inline.ts` (the eligibility gate at lines 1250-1252 and class
rejection at lines 1487-1508). It therefore runs through the separately
compiled QuickJS runtime-eval provider. This is not an `eval-inline.ts`
completion-register or boxing repair.

The focused read-only trace refines the RegExp half of the failure. The
provider result remains usable as a dynamic native carrier: the linked
cross-provider controls in `tests/issue-4654.test.ts` cover `instanceof
RegExp`, `source`, `test`, and identity, while
`identifiers.ts` recognizes a dynamic RegExp through its `ref.test
$__StandaloneRegExp` dispatch. The failure then reaches the generic
`__getPrototypeOf` ladder in
`object-runtime-prototype.ts::buildObjectPrototypeHelpers`. Its current arms
cover `$Object`, fnctors, Array, and boundary values, but not a standalone
RegExp; it consequently returns `null` for this carrier. This is an exposed
generic dynamic-prototype gap, not proof that the provider lost the RegExp
reference itself.

A future, separately owned RegExp arm would need to preserve the caller realm
and use existing integration points rather than fabricate a prototype:

1. identify the dynamic value with
   `regexp-standalone.ts::ensureStandaloneRegExpStruct`;
2. install/use the caller-owned RegExp native-prototype glue through
   `regexp-standalone.ts::ensureRegExpNativeProtoGlue` and
   `native-proto.ts::buildLazyNativeProtoGetInstrs`; and
3. retain `object-get-prototype-of.ts` as the existing generic ingress, with
   `builtin-value-read.ts::tryEnsureNativeProtoBrand` as the related native
   prototype-brand dispatch.

**Historical base-103 full-row status (not a current-main claim).** The same
dynamic RegExp receiver's `.flags` surface was an explicit
`tests/issue-4654.test.ts` residual/invalid-module case, and
`eval-class-regexp-literal.js` checks `flags` after its prototype assertion. At
that revision, a `__getPrototypeOf` arm alone therefore could not label the
row green. The Array siblings still need the broader adapter/membrane
reification route; a RegExp-only branch is not a four-row Cluster G repair.

The existing #5271 X4 routing is retained: all four
`statementList/eval-class-{array-literal,array-literal-with-item,regexp-literal,regexp-literal-flags}.js`
rows stay assigned to the QuickJS/eval-engine bridge (Lane A #4242/#2928).
The refined RegExp trace above narrows one observable dynamic-prototype
failure within that route; it does not move the complete cluster back to an
eval-inline owner.

Action-tied ownership check, performed without edits or a heavy run:

- active assignment registry entry #4245 is `in-progress` for
  `ttraenkler/opus-membrane` on `issue-4245-membrane-slice1`, the adjacent
  QuickJS outward-membrane lane;
- open PR #5748 changes the precise RegExp integration file
  `src/codegen/regexp-standalone.ts`;
- open PRs #5784, #6237, and #6242 change the prospective repair site
  `src/codegen/object-runtime-prototype.ts`; and
- open PR #5753 changes the related generic ingress/brand-dispatch files
  `src/codegen/expressions/object-get-prototype-of.ts` and
  `src/codegen/builtin-value-read.ts`.

The one-shot changed-file scan found those positive overlaps; no absence claim
is made for `native-proto.ts` from paginated PR file lists. Thus this remains a
resumable ownership handoff, not authorization to modify generic prototype or
RegExp code. No production file was changed and no compiler/test process was
started for this audit.

### Source-currency amendment: landed RegExp B10 (2026-09-28)

The preceding RegExp diagnosis was made at
`1032526dc12302034e558934b60363348e80b8bd` and is historical after upstream
advanced to `cb50f21b90b90dd8400be9ae8da1f44e74dd9300`. In particular, landed
B10 commit `fc823b5de3255b2b01a6aee2ab2ce77dc31692db` adds the exact native
RegExp dynamic-prototype route that the historical handoff identified:

- `regexp-untyped-receiver.ts::unshiftGetPrototypeOfArm` recognizes
  `$NativeRegExp` and returns the lazy caller-owned `%RegExp.prototype%`;
- the same demand-gated integration supplies untyped method reads, while
  `regexp-proto-to-string.ts` supplies the generic
  `RegExp.prototype.toString` body; and
- the B10 source and plan cover all six
  `statementList/eval-{block,class,fn}-regexp-literal{,-flags}` controls.

Consequently the base-103 `.flags` observation above must not be read as a
current residual or as evidence that current main still fails the original
class-eval RegExp row. Fresh maintained-runner evidence on a current-source
integration is required before either a pass or a remaining failure is
attributed. The #5271 X4 ownership route remains appropriate for the Array
siblings and for any adapter behavior not covered by B10.

### Draft checkpoint state: eval spread remains unmergeable (2026-09-28)

The current branch still has the eval-spread helper checkpoint, but it is not a
completed fix. The matched, complete maintained-runner receipt was taken on
the dirty branch rooted at `1032526dc12302034e558934b60363348e80b8bd`, before
the upstream B10 integration:

- exact manifest SHA-256:
  `0b2242befd25167100edb84ad1d4ece1eb761a4e1054b782e0a2c172a87a837e`;
- complete 7-shard JSONL:
  `benchmarks/results/test262-standalone-results-20260928-104305.jsonl`
  (SHA-256 `28f5fc03ee2fb74d2247789de8cb691553b199419d5daae81eb013b050efbed8`);
- report:
  `benchmarks/results/test262-standalone-report-20260928-104305.json`
  (SHA-256 `8a0a0a786009be59305053f01034ff02136bf5b7d821bedb996b5e400e9989e5`);
- result: **3 pass / 4 fail / 7 registered / 0 exclusions**. The three
  retained controls are `eval-first-arg.js`, `eval-no-args.js`, and direct
  `var-env-var-non-strict.js`. The four original spread rows remain executable
  failures: `eval-spread.js` (`Expected SameValue(0,3)`),
  `eval-spread-empty-leading.js` (`Expected SameValue(0,1)`),
  `eval-spread-empty.js` (strict rerun, `Expected SameValue(0,1)`), and
  `eval-spread-empty-trailing.js` (`Expected SameValue(0,1)`).

This is not stale-bundle behavior. The runner rebuilt the compiler bundle from
the dirty source before the receipt (bundle SHA-256
`20bbaad344a6ec28629e64ab2f1be3ec06a03996763dd646952ba1a3b6c6a118`), which
contains `buildEvalSpreadArgumentList`, all three eval argument-list call
sites, and both strict iterator calls. The original direct calls are inside
functions, and standalone `tryStaticEvalInline` declines their
`SpreadElement`s, so they route to the direct runtime provider.

The zero final `nextCount` values are not evidence that `next()` was never
called. The likely owned wiring defect is a stale global snapshot:
`emitStandaloneDirectEvalRuntime` currently emits
`emitRuntimeEvalGlobalBindingSeed` before `buildEvalSpreadArgumentList`.
That seed performs the real `__runtime_eval_push_globals` call. A top-level
`nextCount` can then change during the AOT iterator callback, but
`emitRuntimeEvalResultUnwrap` immediately calls `__runtime_eval_pull_globals`
after eval returns and restores the provider's earlier zero. The local `x`
assertions can still pass because they use the direct-eval binding cells rather
than that script-global mirror.

The next owned repair must reserve the runtime global-sync helpers before any
argument expression (to preserve index/preflight safety), stage every direct
argument list including its spread iteration, then publish/activate the global
snapshot immediately before `PerformEval`. It must not move that publication
past the provider call or retry a failed argument. The indirect and global
Script **spread** paths already build their list before their seed; the
`Function` route documents and follows the same post-coercion seed order. This
draft does not claim that all runtime-eval routes share the direct ordering
defect, and it makes no protected iterator/provider changes.

Focused QuickJS checkpoint session `87595` is retained separately: **5 pass /
4 fail**. The two inline non-empty tuple controls throw opaque Wasm exceptions,
the `Array.prototype[Symbol.iterator]` override returns `0` instead of `1`,
and the grouped strict-protocol probe returns `23` rather than the
spec-adapted `15`. Those failures remain live executable diagnostics; they are
neither skipped nor relabelled as accepted behavior. A draft PR may expose this
checkpoint for review, but it must remain DRAFT/unmergeable until the direct
snapshot-order repair has a complete current-source cohort and the retained
strict iterator failures have an explicitly owned resolution.

### Global-snapshot staging implementation (awaiting fresh measurement)

The owned direct, indirect, and global-Script eval routes now separate setup
from execution. Each calls `prepareRuntimeEvalArgumentPhase` before any user
argument is emitted. That shared phase reserves both the global-sync helpers
and the provider-active global, along with their imports and callable
artifacts, and applies the existing late-index discipline. It does **not**
invoke the observable push helper at preflight time.

For ordinary arguments, each route stages the first source value in an
`externref` local (including the `compileExpression(...) === null` →
`undefined` case), evaluates/drops every trailing expression, then emits
`emitRuntimeEvalGlobalBindingSeed` and reads that staged source immediately
before building the provider call. Spread routes receive their first staged
value from `buildEvalSpreadArgumentList` and use the same seed boundary. Thus
§13.3.8.1 `ArgumentListEvaluation` completes before the provider snapshot is
published and before `PerformEval`; an abrupt argument completion neither
activates the provider nor pulls an obsolete snapshot. This repairs the
top-level direct-call routing through `emitStandaloneIndirectEvalRuntime` as
well as the function-scoped direct-provider route. The separately implemented
`Function` coercion path already follows post-user-effect seed order and is
unchanged.

`tests/issue-5157-eval-spread-arguments.test.ts` now also compiles literal
Script records (no synthetic `export`, explicit Script goal, deferred
initializer) to match the original Test262 global-binding shape. The added
controls cover: the exact top-level-`var`/dynamically assigned callback shape
of `eval-spread.js`; a retained nonempty-tuple ordinary-source diagnostic; a
separate function-returned source for the top-level global-Script route; an
IIFE control for the direct-provider route; an iterator whose expanded source
performs nested direct eval; and a throwing spread iterator that must suppress
its trailing argument and `PerformEval`. They are source-only additions at
this point: the historical receipts above remain the before evidence, and no
new pass/fail claim is made until a freshly built, complete maintained-runner
cohort and focused execution finish under the current source.

### Fresh candidate verification: owned snapshot-order repair (2026-09-28)

This candidate was freshly rebuilt from the dirty #5157 source at base commit
`1032526dc12302034e558934b60363348e80b8bd`; it is candidate-branch evidence,
not a claim about newer upstream main. The content-current build recorded:

- compiler bundle SHA-256
  `e93deb0651b6446c78dd5b06d458dbc648689358229360f29c1f4c6704e24859`;
- runtime bundle SHA-256
  `416d0c6d7d5fbf94b141cc8f7437f8dffa06faf292b9547ac788ff3182f58ba4`;
- QuickJS artifact cache hit `2e2d7736713beeda` (artifact
  `e9f8d30bc347…`), followed by an **adapter cache miss** and canary-verified
  adapter build `345fa1d4eabfdd3e` from the compiler bundle above (615,702
  bytes); and
- source SHA-256s: `eval-inline.ts`
  `b38729c359d993a85d9162734cb232b7a3e33bf8e6d9822f66777179b75ec7b6`,
  `runtime-eval-provider.ts`
  `9556b2c55fd2c74d747e52d85d5040da9114d60a84a2aff40df6a9cc02360d1e`,
  `eval-argument-list.ts`
  `87e8d7205292fb6794ab378bcf20afc9375ebfdf5dca85243a73c0c9b09b70ae`,
  and the focused fixture
  `e093194757bef62cfd26b99273397d7ad40191d579d03a0d0e86e86c04435360`.

The maintained runner then rebuilt the worktree again and ran the exact
seven-original manifest with a single dynamic shard
(`TEST262_CHUNK_INDEX=0`, `TEST262_CHUNK_TOTAL=1`), standalone target, and
QuickJS provider. Run `20260928-112151` completed **7 registered / 7 pass / 0
fail / 0 exclusions**. It validated the original and copied manifest (both
SHA-256 `0b2242befd25167100edb84ad1d4ece1eb761a4e1054b782e0a2c172a87a837e`)
and emitted one durable completion record:

- JSONL `benchmarks/results/test262-standalone-results-20260928-112151.jsonl`
  SHA-256 `53893a482da9d106029a21ef8eafda0e78cef245df4c7fd7b1defe38eb9e2701`;
- completion
  `benchmarks/results/test262-standalone-results-20260928-112151.shard-1-of-1.complete.json`
  SHA-256 `9bc24bb7f7928d38ff4b1ea16c3497632737035f8d5d91bfb4e0aae9bc27f9a5`;
  and
- report `benchmarks/results/test262-standalone-report-20260928-112151.json`
  SHA-256 `fb99bbdfdaef0c36b404117a09de0a6337de9ac92628dfbdfbf612b2515349b5`.

The dedicated focused command was rerun with one worker and QuickJS; its
terminal receipt is
`.tmp/5157-focused-final-refactor-20260928-1123.log` (SHA-256
`cb0455b77ffc38f2630e0839e05d3fb28463bd8d05e59435fd7e9d19d5ca6d59`).
It reports **11 pass / 4 fail / 15 registered** with no skipped or softened
controls. The repaired owned controls pass: source snapshot timing, bound
direct lexical/non-string/empty cases, the exact Script-global Test262 shape,
ordinary top-level global-Script and function-scoped direct trailing writes,
nested direct eval, abrupt ordering, and indirect/global spread routing. The
previously ambiguous nonempty-array-source ordinary control now also passes;
it remains executable, showing that source construction is not required to
explain the historical stale-global result.

The four failing focused controls remain **unaccepted generic diagnostics**:

1. inline nonempty tuple literal lexical spread throws an opaque Wasm
   exception;
2. inline nonempty tuple literal non-string spread throws the same opaque
   exception;
3. an `Array.prototype[Symbol.iterator]` override is ignored (actual `0`,
   specified `1`); and
4. the grouped strict-protocol probe returns `23`, not its spec-adapted
   expected `15`.

Those controls intentionally continue to assert the specified result rather
than using a skip, expected-failure decorator, or weakened oracle. Therefore
the focused invocation exits nonzero and this checkpoint is suitable only for
a **draft, unmergeable** PR. The owned eval ordering defect is repaired and
the original seven conformance rows are green, but the protected
tuple/iterator-provider work remains required before this can be called a
complete eval-spread fix. This checkpoint also remains anchored to base
`1032526dc12302034e558934b60363348e80b8bd`; safe integration of newer
upstream main is pending and is not implied by these candidate receipts.

### PR #6246 compiler-boundary inventory repair (2026-09-28)

The draft PR's `quality` job reached its compiler-boundaries inventory gate
after lint, formatting, and typechecking had succeeded. It then failed only
because the new `src/codegen/expressions/eval-argument-list.ts` module was not
listed in `scripts/compiler-boundaries.json` (one unclassified module and two
unclassified import targets). The policy record now classifies that actual
AST/context-driven eval lowering module alongside `eval-inline.ts` and
`runtime-eval-provider.ts`: it remains `unmigrated` in the
`mixed-needs-split` layer, with the existing `backend-wasmgc` destination and
`3518-coordinator` ownership. This inventories the new module without
weakening the gate or changing its migration status. It does not alter the
four explicitly retained generic spread diagnostics or make the draft ready.

The exact CI-equivalent local inventory command,
`node --max-old-space-size=2048 scripts/check-compiler-boundaries.mjs --mode
inventory --base HEAD^`, exited 0 with
`inventory-valid-architecture-incomplete`, no inventory errors, and policy
SHA-256 `d15e1c13e64d31a30d8fb50b0533a86455fe47ee83396497c25e576a74bea557`.

### Retained four-red handoff and strict vec-family audit (2026-09-28)

The draft remains intentionally unfinished.  Its four executable focused
diagnostics are retained without a skip, expected-failure decorator, or oracle
relaxation:

1. `DIRECT_LITERAL_LEXICAL_BODY` in
   `tests/issue-5157-eval-spread-arguments.test.ts` must produce `7`, but a
   non-empty inline tuple literal spread currently throws an opaque Wasm
   exception.
2. `DIRECT_LITERAL_NONSTRING_BODY` must preserve its first expanded marker
   identity (`1`), but the same non-empty tuple representation currently
   throws.
3. `STRICT_ARRAY_OVERRIDE_BODY` must produce `1` after replacing
   `Array.prototype[Symbol.iterator]`; the compiled result remains `0`.
4. `ORIGINAL_GROUPED_PROTOCOL_PROBE_BODY` must equal the spec-adapted isolated
   realm oracle's `15`; the compiled result remains `23`.

These are four controls but only two remaining generic seams.  The first two
are one **non-empty tuple admission/representation** gap.  The latter two are
one **strict vec-family Array GetMethod** gap: the grouped result is `23 =
1 + 2 + 4 + 16`, so it already preserves done-without-value, abrupt exact
sentinel, and non-iterable behavior, but misses the overridden-iterator bit
`8` and incorrectly leaves the ordinary-spread bit `16`.  It is a composite
regression control, not a third provider root cause.  The precise retained
source controls are `DIRECT_LITERAL_LEXICAL_BODY`,
`DIRECT_LITERAL_NONSTRING_BODY`, `STRICT_ARRAY_OVERRIDE_BODY`, and
`ORIGINAL_GROUPED_PROTOCOL_PROBE_BODY`; the last control continues to use
`ORIGINAL_GROUPED_PROTOCOL_ADAPTED_ORACLE_BODY` only to avoid pinning Node's
known direct-eval-with-spread behavior.

A fresh local, read-only hunk audit was limited to
`src/codegen/iterator-native.ts`; it did not edit source or run a compiler:

- The historical strict-provider owner is
  `plan/issues/5131-es2015-strict-spread-iterator.md` (status `done`, PR 5272).
  Its implementation owns `ensureNativeStrictSpreadRuntime`,
  `fillNativeIteratorLateArms`, `buildIteratorBody`, and
  `buildIteratorNextBody`, including the strict arms that this residual
  exercises.
- The still-in-progress #6484 plan retains broad iterator-runtime ownership,
  but its documented open residuals are TypedArray detachment and post-delete
  behavior, not the Array prototype-iterator override.  Its completed S4
  branch is `codex/6484-iterator-residual-20260920a`; this audit found no
  current #6484 hunk at the strict vec-family route.
- The locally fetched head for the previously noted open PR #5753,
  `fork/codex/1058-typescript-standalone` at
  `11b39957841119c75b9703b8bad0cdcecf80f226`, has exactly one
  `iterator-native.ts` hunk relative to merge base `4418cd851087`: a comment
  change in `fillAnyIterNext` at historical line 1966.  It does **not** overlap
  the current strict-family assembly at lines 2936-2942, strict object
  GetMethod arm at 4112-4189, vec-family arms at 4550-4688, or empty-tuple
  arms at 4705-4735.  The same one-line hunk appears on the local
  `codex/5753-resume-20260922` checkpoint.  This is hunk evidence from the
  fetched refs, not a claim that a remote PR was polled.

The narrow `iterator-native.ts` hunk is therefore not blocked by that #5753
change, but no independently correct provider-only repair is available.  The
early strict vec arm snapshots backing storage before `strictObjArm` can do
GetMethod, while a captured `Array.prototype[Symbol.iterator]` write lives in
`ctx.protoOverrides`, not in a vec property bag.  An iterator-native-only
reorder or vec property lookup would still miss the captured override and
would not preserve the user iterator's `this`, single GetIterator call, or
strict `next`/IteratorResult validation.  A strict raw-iterator adopter could
live in `iterator-native.ts`, but it needs a receiver-preserving raw hand-off
from `proto-override.ts`; non-empty tuple literals additionally require their
representation owner.  Do not substitute compatibility `__iterator` after an
override call, and do not decode tuple fields as an eval-only shortcut.

Accordingly, a future repair needs an explicit cross-file claim for the raw
override hand-off, strict adopter, and tuple observation path.  The four red
controls remain the acceptance boundary until then; this audit authorizes no
provider implementation, test relabeling, or publication change.

### 2026-10-02 evaluator-contract checkpoint plan

Required quality run `36967435041`, job `110714119093`, at PR head
`e6493c36025ab9f93dab7d5e57389b80896f6ebc` selected the interpreter
engine but reported the **REFUSAL** provider tier. Its 15-control run yielded
one pass and fourteen `undefined` failures. This does not establish
fourteen argument-spread defects: that provider deliberately refuses dynamic
code. The retained QuickJS/native-tier result remains eleven passes and the
four executable semantic diagnostics above.

Root owns only this record and `tests/issue-5157-eval-spread-arguments.test.ts`
for the following test-instrument checkpoint; the #6739 implementation owner
continues separately in the strict iterator worktree.

1. Add an explicit positive evaluator preflight to both compiler-execution
   helpers only when the compiled module actually imports runtime eval. Static
   eval that compiles away must retain its provider-free execution. Admit an
   available full interpreter or linked QuickJS tier; reject
   `refusal` and `none` with their exact selection provenance before pretending
   to measure compiled argument-spread semantics.
2. Do not change the caller's engine environment, build a hidden provider,
   skip/remove any test, soften an expected value, or alter any compiler path.
   Clear the test262 provider memo before a successful fixture selection and
   after the suite so another fixture's cached selection cannot leak into it.
3. Validate a fresh QuickJS run with all fifteen registered controls and the
   same retained four reds. Separately run the refusal-only configuration as a
   negative instrument control: the compiler-execution helpers must report
   unavailable semantics explicitly, not `undefined` result mismatches. That
   run is an infrastructure non-result, not conformance data or Test262 credit.
4. Keep the PR draft until the numeric-array/tuple semantics and the CI
   evaluator contract actually pass. A clearer failing gate is not a repair of
   either the compiler semantics or CI provider configuration.

The unchanged 11,778-path standalone completion target remains unverified.

#### Evaluator-preflight validation and checkpoint handoff

Root implemented only the two-helper positive preflight and provider-memo
cleanup. All fifteen test bodies and expected values remain intact. A compiled
module without `js2wasm:runtime-eval` imports retains provider-free execution;
modules that actually import it require an available executable provider. The
fixture does not override engine settings, install/build providers, skip
controls, or change production code. An unavailable tier fails the affected
control with explicit selection provenance rather than an `undefined` result.

The initial QuickJS attempt (session 88933) found a missing adapter and is an
infrastructure non-result, not fifteen regressions. The first bundle build
(49507) was denied a write by the sandbox; its authorized retry succeeded.
`--require-cache` then correctly rejected the absent current-key adapter. Root
used the normal builder with the existing verified QuickJS core (no dependency
install or cold core build). Compiler bundle hash is `788f9986cdc5b39c`,
adapter key `a181430990de94b9`; the 542,373-byte adapter passed the builder's
linked canaries. Core SHA256 remains
`e9f8d30bc347dbc56f31b3389f7696eb6dedc9f05ea729781fc412f09a3e6b17`.

Fresh QuickJS session **97920** terminates exit 1 with **11 pass / 4 fail of
15**, zero pending, fifteen unique registered verdicts, one test file. These
are the same retained inline-literal lexical/non-string, numeric Array override,
and grouped protocol diagnostics. They are not hidden or relabelled. The log
announces the actual linked QuickJS tier and current adapter key before running
the controls. JSON SHA256:
`deb765dec26da3dc0f8b2a64890a36ed43f05f17902b04d7ab39d4bbf164f1f9`.

The explicit refusal-only negative (session **20458**) also terminates exit 1,
with **15 failed framework controls / 15 unique verdicts / zero pending**.
Every failure contains the new executable-provider diagnostic and exact
`REFUSAL` provenance; none is a measured argument-spread result. Root verified
this across all fifteen JSON rows, not just a sample. The normal refusal builder
created/canary-verified key `403d5e36f96e9acf`, so the negative does not depend
on a missing-cache substitute. JSON SHA256:
`50ecf2214b38585153720a64e07d4ed79028ae97ba7f6ad80a89d063eec12821`.
Do not call this negative a semantic regression or count it as conformance.

All logs, JSON reports, and provider-build records are retained under
`/private/tmp/js2-5157-evaluator-preflight.lJUx9Z/`. The measured fixture hashes
to `30bb030190588126aca1a8dbe3d4bdd52ef86e422b17da727ee004ca2927afba`.
Current-source TypeScript 7 validation (session **10395**, Node 24, 4 GiB)
passes. No original-Test262 or full-suite improvement is claimed. The next
implementation must finish the numeric-array/tuple semantics and supply an
executable evaluator in CI; this checkpoint deliberately leaves those gates
red and the PR unready.
