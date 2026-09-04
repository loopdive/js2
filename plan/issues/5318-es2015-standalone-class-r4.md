---
id: 5318
title: "ES2015 standalone class — r4: computed accessor names, definition semantics, restricted ids, subclass residue"
status: ready
sprint: current
created: 2026-09-04
updated: 2026-09-04
priority: high
horizon: l
feasibility: medium
model: opus
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: class
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5195, 5576, 5309, 5312, 4447, 3371, 4444]
loc-budget-allow:
  # 2026-09-04 r4 plan: computed accessor keys join the runtime-keyed member
  # collection; definition-time property attributes and the restricted-id /
  # this-before-super checks are new arms in the class lowering.
  - src/codegen/class-dynamic-keys.ts
  - src/codegen/class-bodies.ts
  - src/codegen/class-static-metadata.ts
  - src/codegen/class-heritage-check.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
---

## Problem

After #5195 r3 (PR #5576), the ES2015 standalone census has **176 non-pass
class rows**: 122 `fail`, 54 `compile_error`. 45 of the CEs and 13 of the
fails are generator rows (#2864, other team); 30 fails are
`subclass/builtin-objects/**` (`class D extends Date/Array/TypedArray/…`
— they need the runtime NewTarget carrier the reflect lane #3371 is building
this wave; NOT this lane). The remaining **79 fails** are this lane's, in four
families:

1. **Computed accessor names — 24 rows, `Expected SameValue(«undefined», «N»)`.**
   `get [expr]() {}` / `set [expr](v) {}` (instance and static, declaration and
   expression) whose key is an expression — `cpn-class-*-accessors-computed-
   property-name-from-{expression-logical-or, -logical-and, -arithmetic,
   -function-call, -await, …}` and `accessor-name-{inst,static}-computed-in`
   — read as `undefined`: the accessor pair is not installed under the
   runtime-computed key. #5195 r3-1 made class EXPRESSIONS collect
   runtime-keyed members like declarations; the collector
   (`class-dynamic-keys.ts`) evidently handles methods and fields but not
   the accessor pair, or only literal-shaped keys. r3-3 (assignment-shaped
   computed keys) was REVERTED after review — read that review note in #5195
   before touching the collector, and keep its decline.
2. **Definition semantics — 19 rows under `language/statements/class/definition`.**
   `accessors.js`, `getters-prop-desc.js`, `setters-prop-desc.js`,
   `methods.js`, `numeric-property-names.js`: "Cannot convert undefined or
   null to object" — `Object.getOwnPropertyDescriptor(C.prototype, name)`
   returns `undefined` for a prototype method/accessor, i.e. class members
   are not reified as own properties of `C.prototype` for the descriptor
   read (enumerable false, configurable true, writable true for methods).
   `fn-name-accessor-{get,set}.js`: the descriptor's `get`/`set` function
   object's `name` (`"get x"` / `"set x"`). `getters-restricted-ids.js` /
   `setters-restricted-ids.js`: static accessors named `eval` / `arguments`.
   `methods-restricted-properties.js`, `constructable-but-no-prototype.js`:
   methods are not constructors (`new C.prototype.m()` ⇒ TypeError) and have
   no `prototype`. `prototype-getter.js` / `prototype-setter.js`:
   `C.prototype` is non-writable (assignment in strict code ⇒ TypeError; a
   setter on Function.prototype is NOT invoked, `calls` stays 0).
   `this-access-restriction.js` / `-2.js` / `this-check-ordering.js`:
   `this` before `super()` in a derived constructor ⇒ ReferenceError, and
   after `super()` the instance is the one `super` produced. `basics.js`:
   `Object.getPrototypeOf(C.prototype) === Object.prototype` and
   `C.prototype.constructor === C`. `invalid-extends.js`: a runtime
   heritage that is not a constructor (`extends` of a value the compiler
   cannot see) ⇒ TypeError — #5195 r3-5 declined everything not provable;
   this row needs the RUNTIME `IsConstructor` check on the evaluated heritage
   (the reflect lane's #4661 machinery exists — reuse, and only throw where
   node throws: a plain function, a class, and a bound function are
   constructors; arrows, methods, generators and non-callables are not).
3. **Subclass residue — 7 rows** (`binding.js`, `builtins.js`,
   `class-definition-null-proto.js`, `class-definition-null-proto-contains-
   return-override.js`, `class-definition-evaluation-empty-constructor-heritage-
   present.js`, `default-constructor-2.js`, `derived-class-return-override-
   with-object.js`) and **misc — 14 rows**: `method*/dflt-params-arg-val-not-
   undefined.js` (×4, a default parameter must NOT apply when the argument is
   present and not undefined), `elements/syntax/valid/grammar-static-ctor-
   {meth,gen-meth,accessor-meth}-valid.js` (×6 — `static constructor` as a
   generator or accessor: r3-4 covered the plain method; the accessor and
   generator spellings still fail), `strict-mode/arguments-callee.js`,
   `arguments/{access,default-constructor}.js`, `name-binding/const.js` (the
   inner class binding is immutable: assignment ⇒ TypeError).
4. **`dstr` — 16 rows** (method-parameter destructuring) share #4447's
   machinery (done): claim them LAST, only if steps 1-3 are green, and only
   the shapes whose failure is class-specific (measure first).

### Rows

Computed accessor names (24):

- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-expression-logical-or.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-expression-logical-and.js`
- `test/language/expressions/class/accessor-name-static-computed-in.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-assignment-expression-bitwise-or.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-assignment-expression-bitwise-or.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-arrow-function-expression.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-async-arrow-function-expression.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-async-arrow-function-expression.js`
- `test/language/expressions/class/accessor-name-inst-computed-in.js`
- `test/language/statements/class/cpn-class-decl-computed-property-name-from-assignment-expression-assignment.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-expression-coalesce.js`
- `test/language/expressions/class/cpn-class-expr-computed-property-name-from-assignment-expression-assignment.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-function-expression.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-function-declaration.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-expression-logical-and.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-generator-function-declaration.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-expression-coalesce.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-expression-logical-or.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-arrow-function-expression.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-assignment-expression-assignment.js`
- `test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-function-expression.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-assignment-expression-assignment.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-function-declaration.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-generator-function-declaration.js`

Definition (19):

- `test/language/statements/class/definition/getters-restricted-ids.js`
- `test/language/statements/class/definition/methods-restricted-properties.js`
- `test/language/statements/class/definition/prototype-setter.js`
- `test/language/statements/class/definition/fn-name-accessor-set.js`
- `test/language/statements/class/definition/accessors.js`
- `test/language/statements/class/definition/this-access-restriction-2.js`
- `test/language/statements/class/definition/setters-restricted-ids.js`
- `test/language/statements/class/definition/constructable-but-no-prototype.js`
- `test/language/statements/class/definition/setters-prop-desc.js`
- `test/language/statements/class/definition/fn-name-accessor-get.js`
- `test/language/statements/class/definition/methods-gen-yield-as-yield-operand.js`
- `test/language/statements/class/definition/methods.js`
- `test/language/statements/class/definition/this-check-ordering.js`
- `test/language/statements/class/definition/getters-prop-desc.js`
- `test/language/statements/class/definition/prototype-getter.js`
- `test/language/statements/class/definition/this-access-restriction.js`
- `test/language/statements/class/definition/basics.js`
- `test/language/statements/class/definition/invalid-extends.js`
- `test/language/statements/class/definition/numeric-property-names.js`

Subclass residue (7):

- `test/language/statements/class/subclass/class-definition-null-proto-contains-return-override.js`
- `test/language/statements/class/subclass/binding.js`
- `test/language/statements/class/subclass/class-definition-evaluation-empty-constructor-heritage-present.js`
- `test/language/statements/class/subclass/default-constructor-2.js`
- `test/language/statements/class/subclass/builtins.js`
- `test/language/statements/class/subclass/class-definition-null-proto.js`
- `test/language/statements/class/subclass/derived-class-return-override-with-object.js`

Misc (14):

- `test/language/statements/class/method-static/dflt-params-arg-val-not-undefined.js`
- `test/language/expressions/class/elements/syntax/valid/grammar-static-ctor-meth-valid.js`
- `test/language/expressions/class/method-static/dflt-params-arg-val-not-undefined.js`
- `test/language/expressions/class/elements/syntax/valid/grammar-static-ctor-gen-meth-valid.js`
- `test/language/statements/class/elements/syntax/valid/grammar-static-ctor-gen-meth-valid.js`
- `test/language/statements/class/strict-mode/arguments-callee.js`
- `test/language/statements/class/method/dflt-params-arg-val-not-undefined.js`
- `test/language/statements/class/elements/syntax/valid/grammar-static-ctor-accessor-meth-valid.js`
- `test/language/statements/class/arguments/default-constructor.js`
- `test/language/statements/class/name-binding/const.js`
- `test/language/statements/class/elements/syntax/valid/grammar-static-ctor-meth-valid.js`
- `test/language/expressions/class/method/dflt-params-arg-val-not-undefined.js`
- `test/language/expressions/class/elements/syntax/valid/grammar-static-ctor-accessor-meth-valid.js`
- `test/language/statements/class/arguments/access.js`

dstr (16, last):

- `test/language/expressions/class/dstr/gen-meth-dflt-ary-ptrn-elem-ary-empty-init.js`
- `test/language/expressions/class/dstr/gen-meth-static-dflt-obj-ptrn-prop-ary.js`
- `test/language/statements/class/dstr/gen-meth-ary-ptrn-elem-ary-empty-init.js`
- `test/language/statements/class/dstr/meth-static-dflt-obj-ptrn-prop-ary.js`
- `test/language/expressions/class/dstr/gen-meth-dflt-obj-ptrn-prop-ary.js`
- `test/language/statements/class/dstr/gen-meth-static-dflt-ary-ptrn-elem-ary-empty-init.js`
- `test/language/expressions/class/dstr/gen-meth-static-ary-ptrn-elem-ary-empty-init.js`
- `test/language/expressions/class/dstr/gen-meth-ary-ptrn-elem-ary-empty-init.js`
- `test/language/statements/class/dstr/meth-dflt-obj-ptrn-prop-ary.js`
- `test/language/statements/class/dstr/gen-meth-dflt-ary-ptrn-elem-ary-empty-init.js`
- `test/language/statements/class/dstr/gen-meth-static-dflt-obj-ptrn-prop-ary.js`
- `test/language/expressions/class/dstr/meth-dflt-obj-ptrn-prop-ary.js`
- `test/language/expressions/class/dstr/meth-static-dflt-obj-ptrn-prop-ary.js`
- `test/language/statements/class/dstr/gen-meth-dflt-obj-ptrn-prop-ary.js`
- `test/language/statements/class/dstr/gen-meth-static-ary-ptrn-elem-ary-empty-init.js`
- `test/language/expressions/class/dstr/gen-meth-static-dflt-ary-ptrn-elem-ary-empty-init.js`

Gated, not claimed — builtin-objects subclassing (30, #3371 NewTarget carrier):

- `test/language/statements/class/subclass/builtin-objects/RegExp/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/NativeError/EvalError-message.js`
- `test/language/statements/class/subclass/builtin-objects/Function/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/NativeError/URIError-message.js`
- `test/language/statements/class/subclass/builtin-objects/Date/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/Error/message-property-assignment.js`
- `test/language/statements/class/subclass/builtin-objects/NativeError/TypeError-message.js`
- `test/language/statements/class/subclass/builtin-objects/Array/length.js`
- `test/language/statements/class/subclass/builtin-objects/GeneratorFunction/instance-length.js`
- `test/language/statements/class/subclass/builtin-objects/Number/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/NativeError/ReferenceError-message.js`
- `test/language/statements/class/subclass/builtin-objects/ArrayBuffer/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/RegExp/lastIndex.js`
- `test/language/statements/class/subclass/builtin-objects/Function/instance-name.js`
- `test/language/statements/class/subclass/builtin-objects/NativeError/RangeError-message.js`
- `test/language/statements/class/subclass/builtin-objects/Function/instance-length.js`
- `test/language/statements/class/subclass/builtin-objects/TypedArray/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/GeneratorFunction/super-must-be-called.js`
- `test/language/statements/class/subclass/builtin-objects/String/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/GeneratorFunction/instance-prototype.js`
- `test/language/statements/class/subclass/builtin-objects/String/length.js`
- `test/language/statements/class/subclass/builtin-objects/GeneratorFunction/instance-name.js`
- `test/language/statements/class/subclass/builtin-objects/Symbol/new-symbol-with-super-throws.js`
- `test/language/statements/class/subclass/builtin-objects/Boolean/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/Array/contructor-calls-super-multiple-arguments.js`
- `test/language/statements/class/subclass/builtin-objects/DataView/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/GeneratorFunction/regular-subclassing.js`
- `test/language/statements/class/subclass/builtin-objects/NativeError/SyntaxError-message.js`
- `test/language/statements/class/subclass/builtin-objects/Proxy/no-prototype-throws.js`
- `test/language/statements/class/subclass/builtin-objects/Promise/regular-subclassing.js`

## Implementation Plan — r4 (2026-09-04, Fable)

**Step 0 — inventory.** Isolate-run the 80 claimed rows on base and lane
trees; run the 783-row `class` control sweep from #5195 r3 (both
`language/statements/class/**` and `language/expressions/class/**` ES2015
rows) and keep the passing list. Read #5195's three review rounds (the
"provable predicate resolving by NAME" family) before writing any predicate.

**Step 1 — computed accessor names (24).** In `class-dynamic-keys.ts`,
extend the runtime-keyed member collection to `get`/`set` accessor pairs:
evaluate the key expression ONCE in definition order (`ToPropertyKey`),
then install (or merge into) the accessor descriptor on `C.prototype` /
`C` (static) with `enumerable: false, configurable: true`; a later member
with the same runtime key replaces the earlier one (spec: define, not
add). Keep the r3-3 decline for assignment-shaped keys. Node-parity matrix:
key from `||`, `&&`, `??`, arithmetic, a call, `in`, a string
concatenation, a symbol, and a numeric key; getter-only, setter-only, both;
instance and static; declaration and expression.

**Step 2 — definition semantics (19).** (a) Reify prototype/static members
as own properties visible to `Object.getOwnPropertyDescriptor`,
`Object.getOwnPropertyNames`, `hasOwnProperty` with the spec attributes
(methods/accessors: enumerable false, configurable true; methods writable
true) — measure how the r3 static-metadata reification (`class-static-
metadata.ts`) already answers `C.caller`/`C.arguments` and extend the same
mechanism to the descriptor read rather than adding a second reification.
(b) `C.prototype` attributes: writable false, enumerable false,
configurable false; strict assignment throws; no setter invoked. (c)
Accessor function `name` = `"get x"`/`"set x"`. (d) Methods are not
constructors and have no `prototype` (the reflect lane's `IsConstructor`
classifier must answer false for them — coordinate through the report, do
not fork the classifier). (e) `this` before `super()` ⇒ ReferenceError:
a per-constructor "this initialised" flag checked on every `this` read in a
DERIVED constructor body before the `super()` call site, with the flag set
by `super()`; `this-check-ordering.js` pins that the argument evaluation
of `super(...)` happens before the check. (f) `invalid-extends.js`: runtime
IsConstructor on the evaluated heritage — extend
`class-heritage-check.ts::emitStandaloneHeritageCheck` with a RUNTIME arm
for heritages the compiler cannot classify, throwing only when the
classifier says "not a constructor" at runtime (never on a static guess).

**Step 3 — subclass residue + misc (21).** Read each row; most are one-line
semantics: `default-constructor-2.js` (the implicit derived constructor
forwards ALL arguments — `...args`), `class-definition-null-proto*.js`
(`extends null`: `C.prototype`'s [[Prototype]] is null, `new C` throws
TypeError unless the constructor returns an object), `binding.js` (the
inner binding is visible in the heritage/body and immutable),
`dflt-params-arg-val-not-undefined` (default only when `undefined`),
`grammar-static-ctor-*-valid` (`static get constructor()`, `static *
constructor()` are ordinary statics — extend r3-4's `isStaticCtorMethod`
to accessors and generators, and the early-error twin in
`compiler/early-errors/module-rules.ts::isStaticCtorMethodMember`),
`arguments-callee.js` (`arguments.callee` in class code ⇒ TypeError),
`name-binding/const.js`.

**Step 4 — dstr (16, conditional).** Only the class-specific shapes.

**Order-preservation constraints.** Classes with no computed accessor keys,
no `extends` of an unclassifiable value and no `this`-before-`super`
compile to the same bytes as base on every target; the #5195, #5309 and
#5312 pins stay green unchanged. Every predicate that decides to THROW needs
the single-assignment / shadowing proof or a runtime check — never a name.

## Acceptance criteria

- 80 claimed rows `pass` (isolated, standalone) or given up with the
  mechanism; the 30 builtin-objects rows and 13 generator rows recorded as
  gated.
- Zero rows lost in the 783-row class sweep vs the base tree.
- `tests/issue-5318-r4-*.test.ts` per step with node-parity matrices;
  engine-relative where node 22/25 differ.
- Gates, typecheck, lint green.

## Lane protocol (applies to every step above)

- **Worktree only.** Work in the worktree the workflow gave you; branch from the
  merge-base you were spawned on and `git pull --no-rebase --no-edit origin main`
  before the first source edit. `git merge` is hook-blocked in the repo root;
  `git pull --no-rebase` is not. Link `node_modules` and `test262` DIRECTLY to
  `/home/user/js2/node_modules` and `$(readlink -f /home/user/js2/test262)` (no
  symlink chains through sibling worktrees). Copy
  `/home/user/js2/.test262-cache/quickjs*` into the worktree's `.test262-cache/`
  and run `node scripts/build-quickjs-eval-provider.mjs` there, or every
  eval-dependent row fails fast with "quickjs provider is not built" and hides
  both wins and regressions.
- **Measure, do not predict.** Every row you claim flips is run with
  `npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone` on BOTH
  a `git archive origin/main` base tree and the lane tree; the enclosing control
  corpus named in the plan is re-run the same way and every base-pass row must
  still pass. A `compile_timeout` under load is re-run alone before it counts.
  Name the artifact and the time for every number you write down.
- **The failure family to hunt for is "a working program now throws."** Every
  confirmed regression across the last four waves was a "provable" predicate
  resolving by NAME or by declaration shape without a single-assignment /
  shadowing proof. Decline to base unless the proof holds under reassignment,
  destructuring, loop heads, parameters, `eval`/`with` and shadowing — and
  never let a new arm change the answer of a program that worked on base.
- **Node is the oracle, but the engine differs.** CI runs node 25; this
  container runs node 22 (a node 25 lives at
  `/home/user/js2/.tmp/wrap/node25/cache/_npx/8758e404b5eed2f3/node_modules/node/bin`).
  A pin that asserts node's answer must probe the running engine, not assert a
  fixed value, when the two disagree (sloppy-function own `caller`/`arguments`
  is the known case).
- **Do not touch the other team's territory:** the generator carrier (#2864,
  every `__gen_*`/`__create_generator` row), the promise/microtask carrier
  (#2867), and built-in method reflection (#2175 — `length.js`/`name.js`/
  `prop-desc.js`/`not-a-constructor.js` rows and the
  "`Object.prototype.toString` / `Function.prototype.call` is not yet
  implemented in --target standalone" rows). Leave those rows out of your
  claims and your acceptance list; record them as gated.
- **Gates before every commit, chained:** `node scripts/check-loc-budget.mjs &&
  node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs
  && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, then
  again with `LOC_GATE_BASE=$(git rev-parse origin/main)`; plus
  `pnpm run -s check:speculative-rollback` (a raw `fctx.body.length = n`
  rollback outside `context/speculative.ts` fails CI — use
  `withSpeculativeCompile`/`probeCompiledType`), `check:stack-balance`,
  `check:codegen-fallbacks`, `check:any-box-sites`, TS7 typecheck
  (`node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`)
  and `pnpm run -s lint`. Growth grants go in THIS issue's frontmatter
  (`loc-budget-allow` / `func-budget-allow`) with a dated rationale; never edit
  `scripts/*-baseline.json`. New codegen type queries go through `ctx.oracle`.
- **Tests:** `tests/issue-<id>-r4-*.test.ts` pin every kept row through
  `runTest262File(file, "issue-<id>", 60_000, "standalone")` plus node-parity
  probes compiled with `compile(source, { target: "standalone", allowJs: true,
  skipSemanticDiagnostics: true })`, asserting `result.imports` is `[]`. Run
  them at the CI fork heap, single fork:
  `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 npx vitest run tests/issue-<id>*.test.ts
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
  --dangerouslyIgnoreUnhandledErrors`.
- **Commits:** author stays the repo's configured identity; subject ends with
  ` ✓`; `SKIP_SLOW_PRECOMMIT=1`; never `--no-verify`; trailers
  `Model: Claude Opus 5 Medium`, `Co-Authored-By: Claude Opus 5
  <noreply@anthropic.com>`. Commit each step separately with the measurement
  in the body. Do NOT push, open a PR, or enqueue — the integrator merges the
  lane branch, validates the combined tree and opens the PR.
- **Report** (your final message): the per-step row table (base → lane, kept /
  given up), the control-corpus result, gate status, the worktree path and head
  sha, and every residual with its mechanism.

