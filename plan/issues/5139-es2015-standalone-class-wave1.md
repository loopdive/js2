---
id: 5139
title: "ES2015 standalone: class conformance wave 1"
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
  - src/codegen/class-bodies.ts
  - src/codegen/class-proto-object.ts
  - src/codegen/class-proto-accessors.ts
  - src/codegen/class-static-metadata.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/generators-native.ts
  - src/ir/try-table.ts
  - src/codegen/registry/error-types.ts
  - src/compiler/early-errors/duplicates.ts
  # 2026-08-28 (this issue, wave 1 implementation): the three sites below carry
  # small, unavoidable growth for clusters 0/1/2a/7.
  #  - node-checks.ts: the escaped-`let` early error needs the property-name
  #    exclusion list (IdentifierName permits escapes) at the rule itself.
  #  - typeof-delete.ts: `delete Array.prototype[Symbol.iterator]` is dispatched
  #    from the delete lowering; the arm is 6 lines plus its import.
  #  - index.ts: two one-line calls that root the override slot during the
  #    existing #1719 S1 pre-scan (single- and multi-source entry points).
  - src/compiler/early-errors/node-checks.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-08-28 (this issue, wave 1 implementation). Each grant is an arm added
  # at an existing decision point in a function that already owns that decision;
  # splitting them out would move the arm away from the state it reads.
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
  - src/codegen/destructuring-params.ts::destructureParamArray
  - src/codegen/typeof-delete.ts::compileDeleteExpression
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #5139 — ES2015 standalone: class conformance wave 1

## Problem

292 of the ES2015-bucket "class" work-package tests fail on the standalone
target (re-verified on head `86739f05`, 2026-08-28; 19 of the day-old
baseline's 311 already pass). Failures concentrate in seven root causes, five
of which cover 87% of the list. Additionally, **head carries a live standalone
generator regression** (PR #5060, merge `8896b73f`) that flips 13 of the 40
previously-passing spotcheck tests to `RuntimeError: unreachable in
__gen_resume_*` — the acceptance baseline is currently red on main itself.
Closing these clusters is a large step toward the 100% ES2015 standalone goal.

The loc-budget-allow grant above is deliberate: this change-set adds a dynamic
computed-key install path, an iterator-protocol destructuring lane, and
static-side own-property installs — measured growth in the listed files,
rationale dated 2026-08-28 (this issue).

**Target list**: `.tmp/es2015/wp-class-current-fails.txt` (292 paths, written
2026-08-28 from a full re-run on head; 270 FAIL + 22 COMPILE_ERROR).
**Probe**: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`
(or individual test262-relative paths as args). Split lists >150 lines.

## Current failure clusters

Counts are disjoint (each test counted once). Sample paths are
test262-relative under `language/`.

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| 0 | **REGRESSION: standalone gen-method resume traps** | 0 of 292, but 13/40 spotcheck tests + changes the failure mode of 23 others | `src/codegen/generators-native.ts` `ensureNativeGeneratorResumeFunction` (~L4419): PR #5060 (merge `8896b73f`, 2026-08-27) wrapped the whole resume trampoline in `buildTargetTaggedTry` for standalone/wasi; `src/ir/try-table.ts:buildStandardTryTable` then `bumpBranches(body, 2, false)` over the closed trampoline — result: `unreachable` trap on resume. Bisected: passes at `842ea5ca`, traps at `8896b73f`. | expressions/class/gen-method/dflt-params-arg-val-undefined.js · expressions/class/dstr/gen-meth-static-obj-ptrn-prop-ary-trailing-comma.js |
| 1 | **Runtime-computed class-member keys dropped** | 78 | `src/codegen/class-bodies.ts:resolveClassMemberName` (~L623) → `literals.ts:resolveComputedKeyExpression` (~L2677) is a *static* fold; a member whose computed key doesn't fold (`[x || 1]`, `[ID('d')]`, `[sym]`, `[yield]`) is **silently dropped** — reads return undefined/null. Object literals already have the runtime path (#2126, `literals.ts` ~L1140 `compileRuntimeComputedPropertyKey`); classes have none. Also covers accessor-name-* err tests (key evaluation must run at class-def time so ToPropertyKey / unresolvable-ref errors propagate). | statements/class/cpn-class-decl-accessors-computed-property-name-from-expression-logical-or.js · computed-property-names/class/method/string.js · statements/class/accessor-name-static/computed-err-to-prop-key.js |
| 2 | **Class-method param destructuring: iterator protocol + defaults** | 68 | `src/codegen/destructuring-params.ts`: (a) array patterns destructure by **index access**, never GetIterator — `Array.prototype[Symbol.iterator]` overrides ignored (got `z=3`, expected `42`) and `delete Array.prototype[Symbol.iterator]` doesn't throw TypeError (32 tests); (b) rest on exhausted iterator not a real array (`Array.isArray(x)` false, 8); (c) undefined through f64-typed pattern slots reads back 0/NaN (12); (d) whole-param default whose value is a binding initialized from `Object.defineProperty(...)`'s return compiles to null → "Cannot destructure 'null'" (8, verified by probe: same object via the original literal binding works); (e) nested `[[] = fn()]` element default not evaluated (8). | statements/class/dstr/meth-ary-ptrn-elem-id-iter-val-array-prototype.js · statements/class/dstr/meth-static-dflt-obj-ptrn-empty.js · statements/class/dstr/meth-dflt-ary-ptrn-rest-id-exhausted.js |
| 3 | **Native generator-method lowering gaps** | 34 | `src/codegen/generators-native.ts`: `*method(x = x)` self-ref default must throw ReferenceError (param TDZ, 8); `yield [...yield yield]` — yield-as-consumed-value shapes null-trap (8); falsy args (`false`, `''`, `0`) through f64 param slots corrupt values (4); plus 12 CE `sequential numeric yields` for `[yield]`-in-computed-key shapes (overlaps cluster 1's install machinery). | expressions/class/gen-method/dflt-params-ref-self.js · statements/class/gen-method/yield-spread-arr-multiple.js |
| 4 | **Class own-property surface — static side + `constructor`** | 36 | #3976 made `C.prototype` a real `$Object` (methods/accessors gOPD-visible — verified working) but **deliberately deferred the class object `C` itself** (blocked on `new-super.ts:emitDynamicNewFallback`'s `ref.test $ClassName` dispatch). Probe on head: `gOPD(C,'staticMethod')` → undefined, `C.prototype.hasOwnProperty('constructor')` → false. Also: parser rejects legal `static constructor()` ("A class may only have one constructor", `src/compiler/early-errors/duplicates.ts` counts statics), static `prototype` accessor → illegal cast, `.caller`/`.arguments` restricted-property probes. | statements/class/definition/methods.js · elements/syntax/valid/grammar-static-ctor-meth-valid.js · statements/class/definition/methods-restricted-properties.js |
| 5 | **Builtin subclassing** | 38 (5 env-only) | `src/codegen/standalone-subclass-ctors.ts` (#3972) makes builtin-parent instances **identity-only carriers** — no builtin behavior (`new SubMap().size`, `subRe.test()`, `subDate.getFullYear()` all fail). NativeError sub-cluster (7): `$Error_struct` (registry/error-types.ts) always answers `message` as own — spec wants own `message` **only when the ctor arg was present**, plus `Err.prototype.message` writes must be inheritable. 5 tests (Function subclassing etc.) fail only for the missing quickjs eval artifact in this container — env-dependent, see acceptance. | subclass/builtin-objects/NativeError/EvalError-message.js · subclass/builtin-objects/Map/regular-subclassing.js |
| 6 | **Default params in non-generator methods** | 20 | Same three defects as cluster 3 but in the plain method lane: self-ref TDZ ReferenceError missing (8), `arguments[i]` inside param defaults reads null (8, `params-dflt-meth-ref-arguments`), falsy args through f64 slots (4, `aFalse` reads back `0`). | statements/class/params-dflt-meth-ref-arguments.js · statements/class/method-static/dflt-params-arg-val-not-undefined.js |
| 7 | **Parser small fry** | 10 | `yield` as identifier reference inside decorator expressions rejected (6 CE, decorators are non-ES2015 — lowest priority); escaped-keyword method names `let()` rejected / `new()` miscompiles local.tee (4). | statements/class/decorator/syntax/valid/decorator-parenthesized-expr-identifier-reference-yield.js · statements/class/ident-name-method-def-let-escaped.js |
| — | Misc remainder | 8 | name-binding (3), `extends` arrow-function must TypeError (2), `arguments` in class scope (2), other (1). | statements/class/name-binding/basic.js |

## Implementation Plan

Ordered by yield; each step is independently landable. Re-run the probe on the
cluster's tests after each step. **Do NOT**: add host imports without a
standalone fallback (the runner fails any module emitting host imports —
`standaloneHostImportError`); edit `tests/test262-runner.ts`, any skip list, or
`scripts/*baseline*.json`; use raw `checker.getTypeAtLocation` (route type
queries through `ctx.oracle`, `src/checker/oracle.ts` — oracle-ratchet gate).

### Step 0 — Fix the #5060 resume-trampoline regression (mandatory first; restores the 13-red spotcheck baseline)

- Repro: `npx tsx .tmp/run-standalone.mts language/expressions/class/gen-method/dflt-params-arg-val-undefined.js` → `unreachable in __gen_resume___anonClass_0_method`. Bisected on first-parent merges: **passes at `842ea5ca`, traps at `8896b73f`** (PR #5060, "close state after abrupt iterator steps", the only src change is the ~23-line `buildTargetTaggedTry` wrapper in `ensureNativeGeneratorResumeFunction`, `generators-native.ts` ~L4419).
- The wrapped trampoline (`emitTrampoline`, ~L3232) is a *closed* `block{loop{...}}` instr list; `buildStandardTryTable` (`src/ir/try-table.ts:85`) runs `bumpBranches(body, handlerCount+1, false)` over it. Audit the interaction: `bumpBranches.walkChildren` does **not** adjust the `depth` fields of nested raw `try_table` `catches` (only legacy `catches[].body`), so any inner try region lowered to `try_table` inside the trampoline gets its catch target mis-aimed after the +2 shift of surrounding branches. Fix in `try-table.ts` (bump `TryTableCatch.depth` when it escapes) **or** in the wrapper (emit the trampoline already knowing it sits inside the try, so no post-hoc bump is needed). If a clean fix is >1 day, revert the wrapper and re-land with #4768's new test (`tests/issue-4768-generator-call-boundary.test.ts`) kept green — that test must pass either way.
- Validate: the 13 regressed spotcheck tests (all `gen-meth`/`gen-method` entries in `.tmp/es2015/wp-class-passing-spotcheck.txt`) pass again; the 23 `__gen_resume`-trap entries in the current-fails list revert to their pre-regression failure modes (they do NOT all pass — they then belong to clusters 2/3).

### Step 1 — Dynamic computed member keys (cluster 1, 78 tests)

- Collection phase (`class-bodies.ts`, where `resolveClassMemberName` returning
  undefined currently drops the member): instead record a per-class
  `dynamicMembers` list — `{node, kind: method|getter|setter, isStatic, keyExpr}`.
  Still compile the member body to a Wasm function exactly as named members are
  (synthesize a stable internal name, e.g. `__cmdyn$<class>$<ordinal>`, via
  `class-member-keys.ts` so funcMap keys can't collide).
- Install phase: extend `emitStandaloneClassProtoObject`
  (`class-proto-object.ts:161`) and `emitClassProtoAccessorInstalls`
  (`class-proto-accessors.ts:128`). For each dynamic member, at
  class-definition time (module init), **in source order interleaved with the
  static-key members** (test262 asserts definition order and side-effect
  order — see `computed-property-names/to-name-side-effects/class.js`):
  evaluate `keyExpr` with `compileRuntimeComputedPropertyKey` (`literals.ts`,
  the #2126 object-literal pattern — mimic that call site), apply ToPropertyKey
  (this is what makes the `accessor-name-*/computed-err-*` throw tests pass
  for free — the key expression and its coercion run eagerly and abrupt
  completions propagate), then define on the proto `$Object` (instance) or the
  class object (static) with §17 attributes — same define helper the static-key
  install already uses. Getter/setter pairs with the same runtime key must
  merge into one accessor property (`getter-duplicates.js` asserts
  last-definition-wins ordering).
- Symbol-valued keys (`basics/symbol.js`, `class/static/method-symbol.js`):
  the key local must carry the symbol identity through ToPropertyKey without
  stringifying — reuse whatever `symbol-native.ts` carriers the object-literal
  runtime-key path uses; if that path stringifies, fix it there (shared gain).
- Standalone only needs the `$Object` define route (no host import);
  the JS-host lane can keep `__extern_set`.

### Step 2 — Param-destructuring iterator protocol + defaults (cluster 2, 68 tests)

All in `src/codegen/destructuring-params.ts` (the class-method param lane; the
plain-function lane shares it — fixes ripple beyond this package).

- 2a (32 tests): array binding patterns must consult the tracked
  `Array.prototype[Symbol.iterator]` state. The mechanism exists — #1719/#1750:
  `array-proto-iterator-override-ast.ts`,
  `arrayIteratorOverrideGlobalIdx`/`tryEmitArrayProtoIteratorReadDrive`
  (`expressions/proto-override.ts`, already imported at
  `destructuring-params.ts:62-71`) — but the class-method param path takes the
  index-access fast lane unconditionally. Gate the fast lane on "no override
  recorded anywhere in the module" (the whole-source scan predicate #1750
  references); when an override or `delete` is recorded, drive the pattern via
  the iterator read-drive (mimic the for-of lane in
  `statements/for-of-destructuring.ts`, which honors it). The
  `iter-get-err-array-prototype` half is the same gate: a `delete`d/poisoned
  `@@iterator` must produce the GetIterator TypeError before any element read.
- 2b (8): rest element on an exhausted iterator must materialize a real empty
  array carrier (whatever `ensureNativeArrayFromIterN` returns), not null —
  `Array.isArray(x)` and `x.length === 0` are asserted.
- 2c (12): pattern-binding slots that can observe `undefined` must not be f64
  (undefined→0/NaN corruption; `obj-ptrn-prop-obj` expects `x === undefined`).
  Widen the slot to externref when the binding lacks a numeric type proof —
  `resolveBindingElementType` / `isUndefWidenedBindingElement`
  (`checker/type-mapper.ts`) are the existing predicates; mimic how #3386
  widened generator pattern spills.
- 2d (8): minimal repro (verified):
  `var o = Object.defineProperty({}, 'a', {get(){}}); class C { static m({} = o) {} } C.m()`
  throws "Cannot destructure 'null'", while the same object reached through its
  original literal binding works. The global initialized from
  `Object.defineProperty(...)`'s return value reads as null inside the
  param-default lane — trace where the default-initializer identifier is read
  (the global's declared type likely comes from the oracle as void, so the read
  lane picks an unwritten twin slot). Fix the binding's value-kind, not the
  destructure.
- 2e (8): nested-pattern element default (`[[] = fn()]`) must evaluate `fn()`
  when the iterator element is absent/undefined, and an empty pattern must not
  touch the iterator of its own default value (`iterCount === 0` asserted).

### Step 3 — Class own-property surface, static side (cluster 4, 36 tests)

- Do the deferred half of #3976: install static methods/accessors as own data/
  accessor properties of the class object. The blocker named in #3976 —
  `new-super.ts:emitDynamicNewFallback` `ref.test`s the class-object value
  against `$ClassName` struct types — must be reworked first: dispatch on the
  class object's identity (e.g. the `classObjectGlobals` singleton equality or
  a tag field) instead of its struct type, then the class object can carry an
  `$Object` own-property surface like the prototype does. Follow
  `class-proto-object.ts` as the template; `class-static-metadata.ts` and
  `builtin-static-gopd.ts` hold the current static-name bookkeeping.
- Install `constructor` on the prototype object (value = class object,
  writable/configurable, non-enumerable) in `emitStandaloneClassProtoObject` —
  flips the `grammar-static-ctor-*` hasOwnProperty asserts and
  `definition/constructor*.js`.
- Parser: `src/compiler/early-errors/duplicates.ts` — the one-constructor
  early error must count only **non-static** ClassElements named `constructor`
  (fixes the 2 CE `grammar-static-ctor-meth-valid` files); a static generator/
  accessor named `constructor` is likewise legal.
- Restricted properties (2): class-method function objects must not report own
  `caller`/`arguments` — check `function-poison-pill.ts` /
  `arguments-callee-poison.ts` (the forbidden-ext tests already pass, so the
  poison machinery exists; the gap is the own-property probe on strict
  methods).

### Step 4 — NativeError `message` own-property semantics (cluster 5's fixable slice, 7 tests + spillover)

- `src/codegen/registry/error-types.ts`: `$Error_struct.$message` is filled
  unconditionally. Spec (§19.5.6.1.1): own `message` exists **only if the ctor
  argument was not undefined**. Give the struct's property surface a presence
  distinction (null field + a presence answer in the `hasOwnProperty` /
  gOPD arms at ~L593 `fieldArm("message", 1)`), and make a missing own
  `message` fall back to the prototype chain so `Err.prototype.message = 'x'`
  (a prototype expando write on the error prototype carrier) is inherited.
- Do NOT attempt full builtin-behavior subclassing (Map/Date/RegExp/Array
  `regular-subclassing`, ~10 tests) in this wave — #3972 documents the
  identity-only-carrier design; behavioral subclass instances need a real
  builtin-slot carrier and belong in their own issue. Mark those tests
  expected-fail for this wave's accounting.

### Step 5 — Default-param fidelity in methods (clusters 6 + 3's default slice, ~28 tests)

- Falsy-arg corruption: a param with a default whose call-site arg can be
  `false`/`''`/`null` must not live in an f64 slot — same widening predicate
  as 2c, applied to the method param lane (and the generator emit-site param
  packing, `generators-native.ts` param fields).
- Param-scope TDZ: `m(x = x)` / `*m(x = x)` must throw ReferenceError. The
  compiler has TDZ machinery (#1177/#1205 — `plan/issues/1205-extend-tdz-flag-boxing-to.md`);
  extend the TDZ flag to param bindings referenced from their own (or an
  earlier) initializer. Static detection is enough for the ref-self family
  (the reference is lexically inside the parameter list).
- `arguments` inside param defaults (8): the arguments object is materialized
  for the body (`helpers/arguments-registration.ts`,
  `arguments-object-mop.ts`) but the default-initializer scope reads null —
  hoist the materialization before default evaluation for bodies whose params
  reference `arguments`.

### Step 6 — Generator yield-shape gaps (cluster 3 residual) — LAST, lowest certainty

- `yield` as a consumed value in nested positions (`yield [...yield yield]`,
  8 tests) needs the state machine to model yield-result values feeding
  arbitrary expressions; `[yield]`-in-computed-key (12 CE) additionally needs
  class-def-time evaluation inside an enclosing generator state. Both are
  extensions of the #2079 phase-2 planner (`generators-native.ts` docs at top
  list the exact constraint being hit). Scope to what fits; anything left
  stays a known residual with its CE message (never demote to a silent wrong
  answer).

### Explicitly out of scope

- Decorator `yield`-identifier parsing (6 CE — decorators are not ES2015).
- Behavioral builtin subclassing beyond the NativeError message slice (see
  Step 4).
- The 5 quickjs-artifact env failures (below).

## Acceptance criteria

- All tests in `.tmp/es2015/wp-class-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-class-current-fails.txt`,
  EXCEPT the documented residuals: the 5 quickjs-env tests
  (`subclass/builtin-objects/Function/*`, `class-definition-null-proto.js`,
  `definition/basics.js` — they fail here only for the missing
  `.test262-cache/quickjs-artifact` build, `scripts/quickjs-artifact/`; verify
  in CI or after building the artifact), the ~10 behavioral builtin
  `regular-subclassing` tests (Step 4 scope note), the 6 decorator CE tests,
  and whatever Step 6 documents as residual. Every non-residual cluster-0–5
  test passes.
- Every test in `.tmp/es2015/wp-class-passing-spotcheck.txt` passes —
  **note: 13 of these currently FAIL on head** (the Step-0 regression); after
  Step 0 the full 40 must be green.
- Ratchet gates pass (chained, before commit): `node scripts/check-loc-budget.mjs
  && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs
  && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`.
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.
- `tests/issue-4768-generator-call-boundary.test.ts` stays green through Step 0.

## References

- **#5060 / PR merge `8896b73f`** — introduced the Step-0 regression (its own
  goal, #4768 abrupt-step close, must be preserved). #5044/#5057 are the
  adjacent generator-boundary PRs/audit from the same day.
- **#2126** — object-literal runtime computed keys (the pattern Step 1 ports
  to classes); **#5108** — computed-only object key carrier (done, adjacent).
- **#1719 / #1750 / #1052** — Array.prototype iterator-override tracking and
  read-drive (Step 2a reuses; #1052 fixed the non-param lanes).
- **#3976 / #4455 / #4440 / #3479** — class own-property surface: prototype
  side done; #3976's "What is deliberately NOT in this slice" names the
  static-side blocker Step 3 removes.
- **#3972 / #2029 / #2620** — standalone builtin subclass ctors
  (identity-only carriers; Step 4's scope boundary).
- **#3386 / #3945** — generator pattern-param spill widening (Step 2c/5
  mimic); **#680 / #1665 / #2079 / #2895** — native generator state machine.
- **#1177 / #1205** — TDZ flag machinery (Step 5).
- **#2961** — standalone host-import leak guard (why no new host imports).
- **#1119 / #1049** — fn-name inference for class/function values (touches the
  `definition/fn-name-*` files in cluster 4's neighborhood).

## Results (wave 1 implementation, 2026-08-29)

Measured with `npx tsx .tmp/run-standalone.mts --list <chunk>` on the 292-path
target list, before and after, in this worktree (base `577ce9d6`).

| List | Before | After |
|---|---|---|
| `wp-class-current-fails.txt` (292) | 0 pass / 270 fail / 22 CE | **66 pass** / 206 fail / 20 CE |
| `wp-class-passing-spotcheck.txt` (40) | 27 pass / **13 fail** | **40 pass** |

### Fixed

- **Step 0 — the #5060 standalone generator regression (whole corpus, not just
  this list).** Every standalone/WASI generator resume trapped with
  `unreachable`, not only the 13 spotcheck rows: a bare `function* g(){ yield 1 }`
  reproduced it. Root cause is narrower than the plan's hypothesis: the wrapper
  passed `{kind:"val"}` as the try_table block type, and a VALUED `try_table`
  whose normal exit crosses the synthesized handler/join blocks traps on the
  fallthrough path. Every other tagged-try call site in the compiler is
  `{kind:"empty"}` — this wrapper was the only valued one, which is why the
  JS-host lane (legacy `try`) stayed green. Fix: spill the trampoline result
  into the existing `__gen_result` local inside an empty-typed try region and
  read it back after (`generators-native.ts`).
  The plan's separate finding is real and also fixed: `bumpBranches` never
  adjusted a raw `try_table`'s `catches[].depth` (a catch clause has a `depth`,
  not a `body`, so `walkChildren` cannot see it). That is live for a generator
  containing its own try/catch, which the re-wrap now nests (`ir/try-table.ts`).
- **Cluster 2a — `Array.prototype[@@iterator]` in method params (32).** Two
  independent defects. (i) The read-drive gate reads
  `arrayIteratorOverrideGlobalIdx(ctx)`, but the override slot is only rooted
  when the module-init assignment compiles — and a class method body compiles
  FIRST, so the gate read `undefined` and silently took the backing-store lane.
  The slot is now pre-rooted during the existing #1719 S1 pre-scan, making the
  gate order-independent (`expressions/proto-override.ts`, `codegen/index.ts`).
  (ii) `delete Array.prototype[Symbol.iterator]` had no compiled landing spot
  and was a silent no-op; it now raises a flag global that the array-pattern
  parameter lane checks, throwing the §7.4.2 TypeError before any element read
  (`typeof-delete.ts`, `destructuring-params.ts`).
- **Param-scope TDZ in class methods (16).** `m(x = x)` / `m(x = y, y)` must
  throw ReferenceError (§10.2.11). `function-body.ts` has done this since #2121;
  the class method lane read the still-zeroed local and returned silently. The
  detector moved to a shared dependency-free `param-tdz.ts` and the class method
  site grew the same arm.
- **`arguments` read from a parameter default (8).** Two ordering bugs:
  `needsImplicitArgumentsObject` scans only the BODY, so a method whose only
  `arguments` use is in a default got no object at all AND was not registered in
  `ctx.funcUsesArguments` (so callers never published the overflow args through
  `__extras_argv`). Both now consult the parameter defaults, and the object is
  materialized before the defaults run.
- **Empty object binding pattern with a default (8).** `method({} = obj)` threw
  "Cannot destructure 'null' or 'undefined'": the default was materialized under
  a `ref.test $Anon{}` whose false arm yields `ref.null`. An empty pattern binds
  nothing, so it no longer takes a struct hint.
- **Escaped `let` as a method name (2).** A property name is an IdentifierName,
  which permits `\u` escapes; the early error now excludes property-name
  positions (`compiler/early-errors/node-checks.ts`).

### Not attempted / skipped this pass

- **Cluster 1 — runtime-computed member keys (~66 remaining).** Needs a real
  dynamic install path (compile the member under a synthetic name, evaluate the
  key at class-definition time, define on the proto `$Object`), and its static
  half (`C[f()]`) additionally needs cluster 4's class-object `$Object`
  conversion, which is still blocked on `new-super.ts:emitDynamicNewFallback`'s
  `ref.test $ClassName` dispatch. Left whole rather than half-landed.
- **Cluster 4 — static-side own properties (36).** Same blocker.
- **Cluster 5 — behavioural builtin subclassing (38).** Out of scope by the
  plan; the NativeError `message` slice (7) was scoped but not landed: errors
  have no `hasOwnProperty` arm at all today, and `verifyProperty` probes by
  MUTATING, so a synthesized descriptor is not enough — the real fix is to store
  `message` in the `$props` bag when the ctor arg is present and give the struct
  field a presence distinction.
- **Falsy args through f64 param slots (8).** Needs the param slot to widen when
  its type came only from the default initializer; that changes class-method
  param typing broadly and was judged too risky for this pass.
- **Nested `[[] = fn()]` element default in a GENERATOR method (8).** The plain
  method lane already handles it; only the generator lane fails. Not isolated.
- **`yield [...yield]` shapes (8) and the 8 CE `sequential numeric yields`** —
  plan Step 6, explicitly lowest certainty.
- **`static constructor()` (2 CE)** — the one-constructor early error
  (`compiler/early-errors/module-rules.ts:checkDuplicateConstructors`) counts
  statics. Left alone deliberately: relaxing it only converts the CE into a
  FAIL, because the same two tests then assert `C.hasOwnProperty('constructor')`
  and `C.prototype.hasOwnProperty('constructor')` — cluster 4, still blocked.
- **Method named `new` (2)** — `new()` miscompiles to an invalid module
  (`local.tee expected ref, found f64`); a distinct codegen bug, not a parser one.
- 5 quickjs-artifact env failures and 6 decorator CE tests: documented residuals.

### Validation

- Spotcheck list: 40/40 (was 27/40 on head).
- `tests/equivalence/**` run in full, in batches of six files (the whole
  directory OOMs in this container — SIGKILL at ~20 files, documented in
  CLAUDE.md). Every failure was A/B-verified PRE-EXISTING by re-running it on a
  clean checkout of the same tree:
  `arguments-nested-and-loops` (1), `array-inline-return` (1),
  `delete-sentinel` (1), `logical-conditional-identity` (3),
  `misc-small-patterns` (1), `new-non-constructor` (2),
  `null-dereference-guards` (5), `optional-direct-closure-call` (2),
  `reflect-api` (1), `tdz-reference-error` (6), `yield-as-expression` (1).
  One file, `multi-file-compilation`, cannot be judged here at all: it OOMs the
  vitest worker (V8 heap limit) on a clean base too, even at
  `--max-old-space-size=6144`. Environmental, not a verdict.
- All five source-ratchet gates green (loc, func, coercion-sites,
  oracle-ratchet, dead-exports).
