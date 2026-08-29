---
id: 5149
title: "ES2015 standalone: object-literal conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-29
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
related: [5141, 1719, 3949, 4688, 4616, 680, 2864, 3236, 1344, 5139]
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/function-instance-meta.ts
  - src/codegen/closures.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/carrier-bag-delete.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/global-environment.ts
  - src/stdlib/object-runtime.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/function-instance-meta-methods.ts
func-budget-allow:
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
---

# #5149 — ES2015 standalone: object-literal conformance wave 1

Growth allowance rationale (2026-08-28): this change-set adds native
(standalone) arms for object-literal `__proto__` evaluation, super-in-method
calls/accessors, symbol-keyed SetFunctionName, method-property delete, and
shorthand ReferenceError throws — all in the files listed above. Expected
growth is spread across those files; none of it is speculative.

## Problem

86 ES2015-bucket test262 tests under `language/expressions/object/` failed on
the **standalone** target (pure Wasm, zero host imports) at the 2026-08-27
baseline; re-verified on head 2026-08-28 (`86739f05`): **80 still fail, 6 now
pass**. The failures are object-literal semantics gaps — `__proto__` literal
evaluation, `super` in object methods, SetFunctionName for symbol keys, method
property descriptors/delete, method `this`-binding, plus a large block of
generator-method failures whose machinery root causes live in sibling issue
#5141. Closing them is a direct requirement of the 100% ES2015 standalone
goal.

Target list (authoritative, re-verified on head, one path per line):
`.tmp/es2015/wp-object-literal-current-fails.txt` (80 paths). Per-test
current errors: re-run `npx tsx .tmp/run-standalone.mts --list <file>`.

**Head regression note (measured 2026-08-28):** the previously-passing
spotcheck list `.tmp/es2015/wp-object-literal-passing-spotcheck.txt` reads
**26/40 on head** — all 14 new failures are the `unreachable in
__gen_resume_* at source L310` trap that #5141 cluster B bisected to PR #5060
(result-typed `try_table` in `src/codegen/generators-native.ts:4419-4438`,
traps on Node 22's V8). That regression also accounts for 15 of this
package's 80 fails. It is #5141 Step 1; do not duplicate the fix here — but
nothing in this issue is acceptable while it stands.

## Current failure clusters

80 fails on head, clustered by root cause, count descending. A test carrying
two defects is counted once, in the cluster that currently masks the other.

| Cluster | Count | Root cause (file:function) | Sample tests |
|---|---|---|---|
| A. Generator machinery in object methods | 30 | Owned by **#5141**: (a) 15 runtime traps = PR #5060 result-typed `try_table` regression (`generators-native.ts:4419` `ensureNativeGeneratorResumeFunction`, #5141 Step 1); (b) 8 CEs = #680 admission gates (`isNativeGeneratorCandidate` ~L2241 rejects `yield` inside computed property names; `generator-prop-name-yield-expr.js` recurses to stack overflow in the literal computed-name path) + `yield`-as-identifier early-error over-reach (`src/compiler/early-errors/module-rules.ts:204-223`, #5141 cluster D); (c) yield-without-RHS / non-numeric yield values answer 0/NaN instead of undefined (#5141 A3 boxed-any carrier); (d) `generator-invoke-ctor` (not-a-constructor, #5141 F3), `generator-prototype-prop` (per-function `.prototype` slot, #5141 F1/#3236), `concise-generator` (`obj.g()` returns non-generator when native lowering bails for a *method* — objlit-specific residual, this issue) | `method-definition/yield-as-expression-without-rhs.js`, `method-definition/generator-invoke-fn-strict.js`, `dstr/gen-meth-ary-ptrn-elem-ary-rest-init.js`, `concise-generator.js` |
| B. SetFunctionName + method property descriptors | 13 | (a) `src/codegen/function-instance-meta.ts:256` `fnInstanceNameOf` answers `""` for ALL computed keys — a statically-known `Symbol('desc')` binding must answer `"[desc]"` (probe: id-keyed name descriptor is fully correct `id/false/false/true`; symbol-keyed answers `""`); (b) `src/codegen/property-access-dispatch.ts:2861` static `.name` fold infers the property key for covered forms — `xId: (0, function(){})` reads back `'xId'`, violating IsAnonymousFunctionDefinition (the identifier lane has the #1049 rule; the property lane does not); (c) `delete obj.method` returns true but the property REMAINS (probed on head) → `verifyProperty` configurable check fails — `__delete_property` arms (`src/codegen/carrier-bag-delete.ts`) don't cover the method-carrying literal representation; (d) `fn-name-accessor-get/set` crash "Cannot access property on null or undefined" reading descriptor `.get`/`.set` of symbol-keyed accessors (`object-runtime-descriptors.ts` accessor read-back); (e) class-valued props need own `name` (overlaps #5139) | `fn-name-fn.js`, `fn-name-cover.js`, `method-definition/name-property-desc.js`, `fn-name-accessor-get.js` |
| D. Method-param array destructuring must use the real iterator protocol | 11 | **#1719 (in-progress, another lane)** — array destructuring indexes the array directly, ignoring a deleted/overridden `Array.prototype[Symbol.iterator]`; 4 `iter-get-err-array-prototype` tests need GetIterator failure → TypeError before body entry; the `gen-meth-*` members additionally sit behind #5141 C (frame rehydration drops pattern args). Do NOT parallel-implement | `dstr/meth-ary-init-iter-get-err-array-prototype.js`, `dstr/meth-ary-ptrn-elem-id-iter-val-array-prototype.js`, `dstr/meth-dflt-obj-ptrn-empty.js` |
| F. this-binding, computed-name coercion, scope/ReferenceError misc | 11 | (a) extracted method called bare: `this` is `null`-extern, must be undefined sentinel (strict) / global object (sloppy) — same class as done #1702/#1636s1, objlit-method lane missed; (b) computed keys: `{[null]: v}` then `o[null]` answers undefined (ToPropertyKey coercion of null/bool/number keys in the literal build + read, `literals.ts` computed-key arm), `[x=1]` assignment-expression key not evaluated (side-effect count 0); (c) shorthand `{ notDefined }` of an unbound identifier returns undefined instead of throwing ReferenceError — throw machinery exists (`global-environment.ts:399,697` `emitThrowReferenceError`), the shorthand/property-initializer read lane bypasses it; (d) 4 eval/with-dependent scope tests (direct `eval` in method bodies/params, `with`+unscopables) — wire `fctx.directEvalBindingNames` for objlit method bodies (see `function-body.ts` usage); if infeasible, leave last | `method-definition/name-invoke-fn-strict.js`, `cpn-obj-lit-computed-property-name-from-null.js`, `not-defined.js`, `scope-meth-body-lex-distinct.js` |
| C. `super` in object-literal methods and accessors | 7 | `src/codegen/expressions/new-super.ts`: property READS have the #4688 native path (`compileStandaloneObjectLiteralSuperPropertyRead`, L977) but (a) super method CALLS fall to `compileSuperMethodCallCore` L848's `evalArgsAndDefault` → returns null (`method.js`); (b) accessor bodies never get the `[[HomeObject]]` capture — `homeObjectLocal` is threaded in `literals.ts:1387-1393` for methods only, `compileObjectLiteralWithAccessors` (L894) doesn't wire it (`getter/setter-super-prop.js`); (c) the #4688 read path answers null for builtins inherited from `Object.prototype` (`super.toString` must be the `Object.prototype.toString` function value, `name-super-prop-body/param.js`); generator members additionally behind cluster A | `method.js`, `getter-super-prop.js`, `method-definition/name-super-prop-body.js` |
| E. `__proto__` in object literals (§B.3.1 / PropertyDefinitionEvaluation) | 5 | Probed on head: colon-form `{__proto__: p}` defines an OWN data property and leaves [[Prototype]] = `Object.prototype` (must call [[SetPrototypeOf]] iff value is Object or Null, define nothing); `objectLiteralForcesHostPath` (`literals.ts:1658`) already routes it to the open-object path, but `compileObjectLiteralAsExternref` (L436) then emits a plain `__extern_set` for it (L515-560 named-data loop); separately, computed `{["__proto__"]: obj}` in an any-typed slot yields `getPrototypeOf` = null — the computed-key literal carrier is built without seeding [[Prototype]] = `Object.prototype` | `__proto__-value-obj.js`, `__proto__-value-null.js`, `computed-__proto__.js` |
| G. Method param defaults + `arguments` in defaults | 3 | `arguments[i]` referenced inside param-default expressions crashes ("Cannot access property on null or undefined"): the arguments object is seeded after defaults run (`function-body.ts` `emitArgumentsVecBody` ordering); `meth-dflt-params-arg-val-not-undefined.js` triggers the default for `false` (undefined-check is falsy-shaped, or bool→f64 0 collision). Related in-progress: **#3949** (objlit method defaults, host lane) — coordinate | `method-definition/params-dflt-meth-ref-arguments.js`, `method-definition/meth-dflt-params-arg-val-not-undefined.js` |

Counts: A 30 + B 13 + D 11 + F 11 + C 7 + E 5 + G 3 = 80.

## Implementation Plan

Ordered for maximum yield by THIS issue's implementer. Cluster A and D are
owned elsewhere (#5141, #1719): verify/coordinate, do not re-implement.
General constraints for every step: standalone-native implementation only (a
JS-host fast path is optional, a new host import without a standalone
fallback is forbidden); any new type query goes through `ctx.oracle`
(`src/checker/oracle.ts`), never `ctx.checker.getTypeAtLocation` (the
oracle-ratchet gate rejects it); mimic the cited neighboring
already-passing implementations.

**Step 0 — preconditions (do first, no code).**
Confirm #5141 Step 1 (revert/fix of the PR #5060 result-typed `try_table`
hunk, `generators-native.ts:4419-4438`) has landed on main; if not, message
the lead — it is a one-hunk fix un-breaking ~40 tests across packages and
must land first, in whichever lane owns #5141. Then re-run
`npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-object-literal-current-fails.txt`
and re-baseline: the 15 cluster-A traps and the 14 spotcheck regressions
should clear. Everything below is measured against that re-baseline.

**Step 1 — cluster B (13 tests): SetFunctionName + descriptors.**
1a. In `fnInstanceNameOf` (`function-instance-meta.ts:256`): for a computed
    key whose expression statically resolves to a symbol binding with a
    literal description (`resolveComputedKeyExpression` in `literals.ts`
    already does this resolution for key identity — reuse it, do not
    re-derive), answer `"[" + description + "]"`; `Symbol()` with no
    description answers `""` (already correct by accident — add a test
    locking it). Ensure the same value reaches whatever stamps the
    descriptor sidecar the probe showed working for identifier keys.
1b. In the static `.name` fold (`property-access-dispatch.ts:2861`): apply
    the IsAnonymousFunctionDefinition rule to property-sourced function
    values — a comma/covered initializer (`xId: (0, function(){})`) must NOT
    fold to the key text. The identifier lane's #1049 logic in the same
    function is the pattern; port its parenthesized-only walk.
1c. Fix `delete` of method-valued literal properties: reproduce with
    `.tmp` probe `{ method(){} }` → `delete obj.method` → `hasOwnProperty`
    still true. Find which representation that literal takes (closed struct
    with closure-method dispatch vs open `$Object`) and either route
    MOP-observed method literals to the open path or add the closure-prop
    arm to `__delete_property` (`carrier-bag-delete.ts`; the arms pattern is
    documented there). `verifyProperty`'s delete→recheck→restore cycle is
    the acceptance harness — restore must also work (`__defineProperty_value`
    re-adding the method).
1d. Accessor descriptor read-back for symbol-keyed accessors: fix the crash
    in `fn-name-accessor-get/set` (descriptor `.get`/`.set` slot access on
    null) in `object-runtime-descriptors.ts` (`__getOwnPropertyDescriptor`
    accessor arm), then stamp getter/setter names `"get <key>"` /
    `"set <key>"` (§10.2.9 prefix joins with a space — the exact rule is
    already documented in `bound-fn-meta.ts:212`).
1e. `fn-name-class.js` needs class values to expose own `name` — check
    #5139 (class wave 1) before implementing; if it covers class `name`
    descriptors, leave this test to it and say so in the PR.

**Step 2 — cluster F, non-eval part (7 of 11 tests).**
2a. this-binding (2): when an object-literal method is invoked as a bare
    function, the `__current_this` carrier must observe undefined (strict
    body) / the global object (sloppy). #1702 fixed exactly this for
    function-expression direct calls — find its call-site seeding and apply
    to the objlit-method closure invoke path (`closure-call-fast.ts` /
    `calls-closures.ts`). The undefined sentinel is
    `canonicalUndefinedExternInstrs` (`any-helpers.ts`); do not emit
    `ref.null.extern` for it.
2b. Computed-key ToPropertyKey (3): in the literal build (`literals.ts`
    computed-key arm) and the element read, coerce null/undefined/boolean/
    number keys per ToPropertyKey ("null", "true", "2", …) — there is an
    existing key-normalization helper on the element-access read path
    (`element-access-member-names.ts` / `dyn-read.ts`) — reuse, don't fork.
    Also ensure the computed key expression is evaluated exactly once even
    when its value is statically foldable
    (`cpn-...-assignment-expression-assignment.js` counts side effects).
2c. Shorthand ReferenceError (2): make the shorthand/property-initializer
    identifier read of an unbound name route through the same
    `emitThrowReferenceError` throw path used by ordinary unbound reads
    (`global-environment.ts:697` documents the pattern:
    `else throw ReferenceError("<name> is not defined")`).
    `not-defined.js` and `prop-def-id-get-error.js` are the acceptance
    pair.

**Step 3 — cluster C (7 tests): super in object methods.**
3a. Super method CALLS: in `compileSuperMethodCallCore`
    (`new-super.ts:848`), before the `evalArgsAndDefault` fallback, add the
    standalone objlit arm mirroring #4688's read path
    (`compileStandaloneObjectLiteralSuperPropertyRead`, same file L977):
    `__getPrototypeOf(homeObject)` → `__reflect_get_receiver(proto, name,
    this)` → invoke the resulting closure value via the existing dynamic
    closure-call machinery (`__closure_method_call`, `closure-props.ts:983`)
    with call-time `this`. Bail (keep the old fallback) when
    `SUPER_HOME_OBJECT_CAPTURE_NAME` (`closures.ts:175`) is absent.
3b. Accessors: thread `homeObjectLocal` into
    `compileObjectLiteralWithAccessors` (`literals.ts:894`) the same way
    the method path does at `literals.ts:1387-1393`, so getter/setter
    bodies containing `super` get the synthetic capture
    (`closures.ts:3211-3219` is the capture-injection site).
3c. Builtin super reads: `super.toString` must answer the actual
    `Object.prototype.toString` function value — extend the #4688 read (or
    `__reflect_get_receiver`) to fall through to the native builtin-proto
    method table when the `$Object` chain misses
    (`native-proto-method-call.ts` / `object-proto-tostring-native.ts` hold
    the existing builtin lookup patterns).
3d. `generator-super-prop-*` re-measure after Step 0; whatever still fails
    is 3a/3b applied to the generator resume function's body (the capture
    must survive the state-machine spill — `storeSpills` in
    `generators-native.ts`).

**Step 4 — cluster E (5 tests): `__proto__` literal semantics.**
In `compileObjectLiteralAsExternref` (`literals.ts:436`, named-data loop
L515-560): when the property is a non-computed, non-shorthand
PropertyAssignment whose key text is `"__proto__"` (the exact predicate
already exists in `objectLiteralForcesHostPath`, L1664-1675 — extract and
share it), do NOT `__extern_set`. Instead evaluate the value and call the
native prototype-set helper (`object-runtime-prototype.ts` — the same
helper `Object.setPrototypeOf` uses) iff the value is an Object or null;
otherwise drop it silently (§B.3.1: no own property, no error, non-object
non-null values ignored — `__proto__-value-non-object.js` checks
undefined/number/string/boolean/symbol one by one). Duplicate colon-form
`__proto__` is allowed in this path (the early error is only for two
colon-forms in strict code — `__proto__-duplicate-computed.js` mixes forms
and must NOT error). Separately: find where an any-consumed literal with a
computed key builds its carrier (same file, the accessor/host route) and
seed [[Prototype]] = `Object.prototype` — probe
`var obj; obj = { ['__proto__']: {} }` currently answers
`getPrototypeOf(obj) === null`.

**Step 5 — cluster G (3 tests): defaults + `arguments`.**
Read #3949 first (in-progress, host lane, same feature). For standalone:
seed the arguments carrier before param-default evaluation in
`function-body.ts` (`emitArgumentsVecBody` currently runs after), and make
the default-trigger test compare against the undefined sentinel, not
falsiness (`aFalse = false` must NOT trigger the default). If #3949's PR
already restructures default emission, rebase on it rather than moving the
same code twice.

**Step 6 — clusters A and D residuals (verify-only here).**
After #5141 and #1719 land their steps, re-run the full list. Fix only
objlit-specific residuals in this issue: `concise-generator.js` (an
object-literal generator METHOD whose native lowering bails must still
return a generator object, not a bare value — the bail path in
`function-body.ts:715-737` reports/CEs for decls but methods silently
mis-lower), and `generator-prop-name-yield-expr.js` (stack overflow
compiling `*[yield]() {}` — add a recursion guard in the literal
computed-name resolution so it CEs cleanly or compiles, never overflows).

**What NOT to do**
- No new host imports without a standalone fallback (the runner fails any
  module emitting host imports — `standaloneHostImportError`).
- Never edit `tests/test262-runner.ts`, skip lists, or
  `scripts/*baseline*.json` (main is the baselines' sole writer).
- No raw `ctx.checker` type queries in new codegen — `ctx.oracle` only
  (oracle-ratchet gate; grant `oracle-ratchet-allow:` only for genuine
  wasm-lowering `ValType` questions).
- Do not parallel-implement #5141 (generator machinery), #1719 (destructuring
  iterator protocol), or #3949 (param defaults) — reference, coordinate,
  rebase.
- Do not regress the js-host lane: every change here is standalone-arm or
  shared-semantics; run the equivalence suite before every push.

## Acceptance criteria

- All tests in `.tmp/es2015/wp-object-literal-current-fails.txt` (80 paths,
  re-verified on head 2026-08-28) pass via
  `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-object-literal-current-fails.txt`.
  Cluster A (30) and D (11) members are expected to clear via #5141/#1719 —
  if those issues have not landed by this issue's completion, report the
  residual split explicitly (this issue's own clusters B/C/E/F/G — 39 tests
  — must pass regardless).
- Every test in `.tmp/es2015/wp-object-literal-passing-spotcheck.txt` passes
  (40/40; currently 26/40 on head solely due to the #5060 regression —
  see Step 0).
- Source-ratchet gates pass, chained before commit:
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs
  && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet
  && npm run -s check:dead-exports`.
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`).

## References

- **#5141** — ES2015 standalone generators wave 1 (sibling work package):
  owns cluster A's machinery — the #5060 resume-trap regression (its Step 1),
  #680 admission gates, yield-identifier early errors, generator function
  object model. Hard precondition for this issue's cluster A and the
  spotcheck baseline.
- **#1719** — array destructuring must use the (possibly overridden)
  Array iterator (in-progress, senior-dev-led): owns cluster D.
- **#3949** — objlit method param defaults, host lane (in-progress):
  cluster G sibling.
- **#4688** — standalone object-literal `super` property READ: the pattern
  cluster C extends to calls/accessors/builtins.
- **#4616** — host-lane SetFunctionName sidecar stamp (`closures.ts:3478`):
  the host twin of cluster B's standalone gap.
- **#680 / #2079 / #2864** — native generator lowering lineage.
- **#3236** — standalone generator prototype intrinsic chain
  (`generator-prototype-prop.js`).
- **#1344** — generator prototype receiver checks (in-progress).
- **#5139** — ES2015 standalone class wave 1 (class own-`name` overlap,
  Step 1e).
- **#1702 / #1636s1** (done) — strict-`this` direct-call fixes: the pattern
  for Step 2a.

## Results (wave 1, 2026-08-29)

Measured with `npx tsx .tmp/run-standalone.mts --list
.tmp/es2015/wp-object-literal-current-fails.txt` (80 paths) on this branch's
base and again after the change.

| | before | after |
|---|---|---|
| pass | 9 | 22 |
| fail | 67 | 54 |
| compile error | 4 | 4 |

**+13 passing, 0 lost.** The `#5060` resume trap named in the head-regression
note had already landed on this base — the 15 cluster-A traps were gone before
this work started, which is why the "before" column reads 9 rather than the
issue's 0. The 40-file passing spotcheck reads **36/40 both before and after**;
the 4 failures are the same four `dstr/*-obj-ptrn-*` destructuring tests in
both runs (#1719's lane), untouched here.

### What landed

- **Cluster B — method/function `name` metadata (10 tests).**
  - `mintClosureStructTypes` (`closures/arrow-phases.ts`) now consults the
    MEMBER walk before `fnMetaSlot`. `fnInstanceMetaOf` accepts a
    `MethodDeclaration` and answers `""` for it, so the old
    `fnMetaSlot ?? member` order published that empty name and never reached
    the walk that knows the property key. Measured: `o = { id() {} }` had
    `o.id.name === "id"` (static fold) but
    `Object.getOwnPropertyDescriptor(o.id, "name").value === ""` — one function
    with two answers.
  - New `symbolComputedKeyFunctionName` (`function-instance-meta.ts`) resolves
    a symbol-keyed property to §10.2.9's `"[description]"` (and `""` for a
    description-less `Symbol()`), wired into both the function-value lane
    (`fnInstanceNameOf`) and the member lane (`memberNameOf`). Purely
    syntactic and conservative: two declarations of the name, any later
    assignment, or a non-literal description all decline.
  - The static `.name` fold no longer publishes TypeScript's internal
    `__computed` placeholder for a symbol-keyed member — it falls through to
    the runtime read, which now carries the right name.
  - The same fold no longer folds the property key for a COVERED initializer:
    `o = { xId: (0, function () {}) }` keeps `name === ""` (the #1049 rule the
    identifier lane already had).
- **Cluster F — shorthand ReferenceError (2 tests).** `identifierValueSymbol`
  stopped falling back to `getSymbolAtLocation` when the shorthand's VALUE is
  unresolvable. That fallback returned the shorthand's own PROPERTY symbol —
  always present — so `({ notDefined })` silently built
  `{ notDefined: undefined }` instead of throwing.
- **Cluster F — computed-key carrier (3 tests).** The #5108 open-carrier gate
  required a `+ - * /` binary key. The defect is not about arithmetic:
  `let x = 1; ({ [x]: '2' })` and `({ [null]: null })` fold to the same
  statically-known key through the same index-signature-only type, and the
  dynamic read (`o[x]`, `o[String(x)]`) missed the closed struct. Any
  statically resolvable non-`@@` computed key now gets the open carrier.

### Not done — residual, with what each needs

- **Cluster A (generators) / D (destructuring iterator)** — owned by #5141 /
  #1719, verify-only here as planned. Two of D's members
  (`meth-ary-init-iter-get-err-array-prototype` and siblings) already pass on
  this base.
- **Cluster E (`__proto__`, 5 tests) — blocked on a prerequisite this issue
  did not own.** All five need an ordinary object's [[Prototype]] to BE
  `Object.prototype`. Measured on this base: `__new_plain_object`
  (`object-runtime.ts`) stores `$proto = null`, so `var o; o = { a: 1 };
  Object.getPrototypeOf(o)` answers `null` — a plain literal with no
  `__proto__` in it at all. Seeding that (or teaching `__getPrototypeOf` to
  distinguish "default proto" from an explicit `Object.create(null)`) is a
  runtime-representation change with reach far past object literals, so the
  §B.3.1 colon-form arm was NOT written on top of it: it would have shipped a
  half-answer. Note the declaration form `var o = { a: 1 }` passes only
  because BOTH sides read `null` there.
- **Cluster F this-binding (4 tests).** `{ method() {} }.method()` observes
  `this === null`, not the strict `undefined` / sloppy global object. Narrowed
  by measurement: the same shape with a function-VALUED property
  (`{ m: function () {} }.m()`) is already correct, and so is a bare function
  expression — only METHOD SHORTHAND is wrong, so the receiver is being lost
  in the method lowering (trampoline / struct-method path), not in the
  `this` ladder, which already has the #1702/#4190 split.
- **Cluster B `delete` (2 tests).** `delete o.method` returns `true` and
  leaves the property present (`hasOwnProperty` still true), so
  `verifyProperty`'s configurable cycle fails. Reproduced standalone in three
  lines; the struct-field delete arm in `typeof-delete.ts` and the open-object
  `__delete_property` disagree about which carrier holds the method.
- **Cluster B symbol-keyed ACCESSORS (2 tests).** `get [sym]() {}` is dropped
  entirely: `resolveAccessorPropName` declines a runtime-computed key and the
  accessor pre-pass `continue`s, so
  `Object.getOwnPropertyDescriptor(o, sym)` is null and the test crashes
  reading `.get`. Needs a runtime-keyed accessor arm, not a name fix.
- **Cluster C (`super`), G (defaults + `arguments`)** — not started.
