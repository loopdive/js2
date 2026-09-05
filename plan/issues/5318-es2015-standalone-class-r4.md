---
id: 5318
title: "ES2015 standalone class — r4: computed accessor names, definition semantics, restricted ids, subclass residue"
status: in-progress
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
  # 2026-09-05 r5 step 2: object-literal accessors whose ComputedPropertyName is
  # only known at evaluation time. The install itself was put in a NEW subsystem
  # module (src/codegen/objlit-dynamic-accessors.ts), which is what the gate
  # asks for; what remains in literals.ts is the call site plus generalizing the
  # two capture scans (#2128 / #3051) from paired accessors to every accessor in
  # the literal, so a dynamic half's captured locals share the same ref cells as
  # its siblings. Measured +25 LOC after the extraction (was +77 before it).
  - src/codegen/literals.ts
func-budget-allow:
  # 2026-09-05 r5 step 2, same change: +20 lines in the accessor walk of
  # compileObjectLiteralWithAccessors — the `propName === undefined` arm that
  # delegates to objlit-dynamic-accessors.ts, and the flattened capture scans.
  - src/codegen/literals.ts::compileObjectLiteralWithAccessors
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


## Implementation Plan — r5 / round 2 (2026-09-05, Fable lane; Opus-medium implements)

Scope: restore the nested-class static-accessor installs the round-1
compiled-body gate over-declines (see "Review round 1 — reviewer verdict, and
the round-2 residual" above), then the object-literal computed-key residuals
that share r4's evaluated-key install mechanism.

1. **Tri-state gate with a hardened syntactic fallback** —
   `src/codegen/class-static-sidecar.ts::staticAccessorHalfIsReceiverFree`
   becomes `readsThis === false || (readsThis === undefined &&
   syntacticallyReceiverFree(half))`, where `readsThis =
   compiledBodyReadsThis(ctx, funcIdx)` (src/codegen/closures/method-
   trampolines.ts) and `syntacticallyReceiverFree` is the HARDENED walker
   round 1 measured and discarded: it descends into nested class-likes and
   nested function-likes' computed names, parameter defaults and computed
   keys; it counts `this`, `super`, `arguments`, `eval`, `new.target` anywhere
   in that subtree as receiver-reading; anything `genBodyReferencesThis` skips
   but `methodBodyReadsThis` would flag counts as receiver-reading. A `true`
   compiled answer always wins (decline). Never a trap: before shipping,
   compile every nested-class shape you can write (`this` in a nested arrow /
   default parameter / computed key of a nested member / via `arguments` / in
   a nested class's static block, field, method / `super.x` / `eval`) and
   confirm that once the enclosing function has finished compiling
   `compiledBodyReadsThis` agrees with the walker; a disagreement in the
   unsafe direction (walker says free, compiled body reads local 0) is a bug
   in the walker to fix, not a shape to admit.
2. **Object-literal computed keys that share the class mechanism** — from
   the census, language/computed-property-names/{object/accessor/getter,
   setter, getter-super, setter-super, object/method/super, object/method/
   number (illegal cast), object/method/symbol, basics/symbol, class/method/
   symbol, class/method/string, class/static/method-symbol-order,
   to-name-side-effects/class}.js. Inventory each row's mechanism on the
   checkout first (probe + node). Implement ONLY the rows whose fix is the
   evaluated-key install r4 built for classes (`class-proto-accessors.ts`
   pattern: symbol / numeric / runtime-string keys installed under their
   evaluated key, accessor pairs merged, install order = source order);
   record every other row (super in object-literal methods belongs to the
   super lane; the `illegal cast` needs its cast named) with its mechanism.

Measurement protocol: base = `git archive origin/main`; node 22 oracle, node 25
for changed test files; harness `.claude/worktrees/.../.tmp/r1/multi.mts`
pattern (recreate as `.tmp/w5/5318/multi.mts` if the old worktree is gone);
probes h3/h4/g1/d1 from the round-1 residual are one-liners above — recreate
them. Rebuild the compiler bundle AND `node scripts/build-quickjs-eval-provider.mjs`
after the last src edit before any test262 run.

Acceptance: (a) h3 probeH = 23, h4 all six placements = node, g1 probeFnMixed
= 23, d1 probeHoist = 23, t1.js stays base's -1 with no trap; (b) the 783-row
class control (list from the r4 section; regenerate from the census tsv if the
old list is gone) is ≤ 246 non-pass with ZERO rows lost against origin/main
(set-diff of non-pass paths; timeouts re-run alone at COMPILER_POOL_SIZE=1);
(c) tests/issue-5318-r4-computed-accessor-keys.test.ts gains pins for h3, h4
(six placements), g1, d1, t1 and the trap-safety matrix, all with
`result.imports` [] on standalone; (d) wasi and host byte-identical to
origin/main on the reviewer's b1/b2/c1/d1/a1/h1 shapes; (e) all gates green
bare and with `LOC_GATE_BASE=origin/main`; grants in this frontmatter.

## 2026-09-04 r4 implementation (Opus)

Worktree `/home/user/js2/.claude/worktrees/wf_a9776683-b00-3`, branch
`worktree-wf_a9776683-b00-3`, spawned at `f9bf876899`, `git pull --no-rebase`
of `origin/main` = `46c12b01d6` merged in after Step 1. Base tree for every A/B
is `git archive origin/main` (`46c12b01d6`) unpacked in `.tmp/base`, with its
own compiler + runtime bundles and its own quickjs eval adapter. All row runs
are `npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`,
`COMPILER_POOL_SIZE=2`.

### Step 0 — inventory (2026-09-05 02:10–02:17 UTC)

The 64 claimed non-`dstr` rows on the base tree: **0 pass, 64 fail**, zero
compile errors. That matches the plan's census, so the plan's row list is the
one measured here.

### Step 1 — computed accessor names (committed)

Diagnosis first, because the plan's guess ("the collector handles methods and
fields but not the accessor pair") is not what the probes found. The collector
(`class-dynamic-keys.ts::classMemberComputedKeyIsRuntime`) has covered
`get`/`set` since #5195. Two DIFFERENT defects downstream of it made every row
in the family read `undefined`:

1. **The pair erases itself.** A runtime-keyed `get [k]` and `set [k]` register
   under two different synthetic names (`__cmdyn$0`, `__cmdyn$1`) — the
   collector cannot know at compile time that the two key expressions evaluate
   to one property key. `emitClassProtoAccessorInstalls` then issued two
   `__defineProperty_accessor` calls with the same runtime key under the legacy
   flag word, whose documented meaning is "both halves specified", so the
   trailing `set` blanked the `get`. The runtime already implements the
   §10.1.6.3 merge behind bits 8/9; a dynamic half now sets only its own bit.
   A folding key keeps the legacy encoding — its two halves are ONE entry, so
   replace-both is already correct and those modules are byte-identical.
2. **Static accessors were never installed.** `class-static-sidecar.ts`
   collected static METHODS only; its module header recorded the reason
   (an installed half takes the class STRUCT as `this` while
   `__call_accessor_get` hands it the sidecar `$Object`, and that cast traps).
   They are installed now, gated on a SYNTACTIC predicate: the half's body
   never mentions `this` or `super` in its own receiver scope
   (`genBodyReferencesThis`). A half that reads the receiver is still declined
   and keeps base's missing-property answer — a wrong answer, not a new throw.
   The predicate is syntactic, not a read of the compiled body, because the
   sidecar is emitted at ClassDefinitionEvaluation, possibly before that body
   exists, where an empty instruction list would read as "receiver-free".

**Measured 2026-09-05 02:43–02:50 UTC**, 64 claimed rows, lane vs the `.tmp/base`
tree: **0 → 18 pass**, no row moved the other way. The 18 are 9
`cpn-class-expr-accessors-*` and 9 `cpn-class-decl-accessors-*`. Three rows
reported `compilation timeout` under four-lane load and were re-run alone.

Pins: `tests/issue-5318-r4-computed-accessor-keys.test.ts` — the 18 rows
through `runTest262File(..., "standalone")`, an 11-probe node-parity matrix
(get-only / set-only / pair / static get / static pair, plus keys from `+`,
`??` and a call), the folded-key order-preservation control, and the
receiver-reading static accessor that must still decline. Every standalone
control asserts `result.imports` is `[]`.

### Control corpus — 783-row class sweep

Same corpus #5195 r3 used: the non-recursive rows of
`language/{statements,expressions}/class`, plus
`statements/class/{definition,subclass}` and `expressions/super` — 783 rows,
isolated, standalone.

| | non-pass |
|---|---|
| base (`.tmp/base`, `46c12b01d6`) | 271 |
| this lane | **246** |

**25 rows flip non-pass → pass, ZERO rows move the other way, and no row that
passes on base changes status.** 24 of the 25 are the `cpn-class-*-accessors-*`
family this step fixed — 18 the plan claimed plus **6 the plan did not list**
(`-assignment-expression-coalesce`, `-assignment-expression-logical-or` and
`-await-expression`, in both the decl and expr lanes). The 25th,
`subclass/builtin-objects/Function/super-must-be-called.js`, is a #3371-gated
row and is not this step's; it is reported as a bonus, not a claim.

Two measurement caveats, both resolved rather than assumed:

- 246 rows of the first lane sweep returned `error` with `ENOENT` — the shared
  `test262` checkout was momentarily mid-checkout under another lane. They were
  re-run afterwards and their real statuses folded in.
- 19 rows (16 `private-*-multiple-evaluations-of-class-*`, plus
  `definition/{methods-restricted-properties,basics}.js` and
  `subclass/class-definition-null-proto.js`) reported `compile_error:
  compilation timeout` under four-lane load. Re-run alone on an idle box they
  are **`fail` on BOTH trees, 19/19** — load artifacts, not status changes.

### Gates (merged tree, `origin/main` = `46c12b01d6` merged in)

`check-loc-budget` · `check-func-budget` (both bare AND with
`LOC_GATE_BASE=46c12b01d6`: "no unallowed growth in 2 changed src files, net
+167 LOC") · `check-coercion-sites` · `check:oracle-ratchet` ·
`check:dead-exports` · `check:speculative-rollback` · `check:stack-balance` ·
`check:codegen-fallbacks` · `check:any-box-sites` · TS7 `--noEmit` ·
`lint` — all exit 0. `tests/issue-5318-r4-computed-accessor-keys.test.ts`:
32/32 at the CI fork heap, single fork, under BOTH node 22 (local) and node 25
(CI's version).

No growth grant was needed: the two touched files are already on this issue's
`loc-budget-allow`-adjacent surface and the gate reported no unallowed growth,
so nothing was added to the frontmatter.

### Given up this pass, with the mechanism

- **`c[k] = v` never reaches an installed setter.** The class prototype/sidecar
  lookup arm is prepended into `__extern_get` / `__extern_get_idx` only
  (`class-proto-lookup.ts::fillClassProtoLookupArm`); there is no
  `__extern_set` twin, so a write through a runtime-keyed setter is silently
  dropped. Base behaves the same way — this step neither fixed nor broke it —
  and it is exactly why `accessor-name-inst-computed-in.js` and
  `accessor-name-static-computed-in.js` still fail: both assert through
  `C.prototype.<key> = …`. Pinned as `RESIDUAL:` cases in the test file.
- **The four `-computed-property-name-from-assignment-expression-assignment`
  rows** are the r3-3 shape #5195's review reverted. The decline is kept.
- **Every `definition/*` descriptor row** (`accessors.js`,
  `getters-prop-desc.js`, `setters-prop-desc.js`, `methods.js`,
  `numeric-property-names.js`, `getters-restricted-ids.js`,
  `setters-restricted-ids.js`) and the six `grammar-static-ctor-*-valid` rows
  need the same thing: an own-property surface on the CLASS OBJECT
  (`gOPD(C, 'staticX')`, `C.hasOwnProperty('constructor')`). The static sidecar
  is built only for a class that has a static member with a RUNTIME key, and
  widening it to every class with statics additionally needs the reflective
  natives redirected, not just `__extern_get` — that is #5195 cluster B, and it
  is a bigger piece than this pass could take safely.
- **`dflt-params-arg-val-not-undefined` (4 rows)** is not a default-parameter
  bug. The method's parameters take their wasm type from the default
  expression (`aFalse = falseCount += 1` ⇒ f64), so the call
  `C.prototype.method(false, '', NaN, 0, null, obj)` coerces `false` to `0`
  before the body sees it. Fixing it means widening a parameter whose default
  and call sites disagree to the any-channel — a value-representation change,
  not a class change.
- **`this-access-restriction*.js` / `this-check-ordering.js`,
  `name-binding/const.js`, `strict-mode/arguments-callee.js`** all require
  ADDING a throw. The lane rule is that a predicate may only throw where it
  holds under reassignment, shadowing, destructuring, parameters and `eval`;
  none of these was measured to that standard this pass, so none was started.
- **`arguments/{access,default-constructor}.js`, `default-constructor-2.js`**
  need the implicit derived constructor to forward ALL arguments
  (`args.length` reads 0 where node reads 3). That is the constructor ABI, and
  it is shared with the #3371 NewTarget work; left to that lane.
- **Gated, not claimed:** the 30 `subclass/builtin-objects/**` rows (#3371),
  the generator rows (#2864) and the 16 `dstr` rows (step 4 was conditional on
  steps 1-3 being green).

### Review round 1 (2026-09-05)

Opus fix round in `/home/user/js2/.claude/worktrees/wf_05fc6ce9-91e-2`, branch
`worktree-wf_05fc6ce9-91e-2`, the lane branch merged in fast-forward. Same A/B
trees as the r4 pass: `base` = `.tmp/rev5318/base` (`origin/main` 46c12b01d6),
`lane` = the lane worktree, `fix` = this one. Every probe below was run on all
three with `node` (v25.9.0) as the oracle; the harness is
`.tmp/r1/multi.mts` (a three-tree version of the reviewer's `multi.mts`).

Three findings were reported, all standalone-only. Two are FIXED, one is
RECORDED with its repro. `wasi` and the JS-host lane are untouched — nothing
outside `ctx.standalone`'s sidecar path changed.

#### Finding 1 (high) — §15.7.14 declaration order: FIXED

Reported as an ordering defect. It is TWO defects, and the ordering one alone
does not fix it — measured, not assumed:

1. **Order.** `emitClassStaticSidecar` emitted every `collectStaticMethods`
   entry, then every `collectStaticAccessors` entry, discarding `decl.members`
   order. Replaced by ONE pass building an ordered `StaticSidecarEntry[]`, with
   methods and accessor entries interleaved: a later member under the same
   FOLDED key replaces the earlier one in place (matching
   `OrdinaryDefineOwnProperty`, which does not move an existing key), and the
   two halves of one accessor merge into a single entry. A RUNTIME key cannot
   be deduplicated at compile time at all — its registered name is a synthetic
   `__cmdyn$<n>` and only ClassDefinitionEvaluation knows which collide — so
   for those the emitted install ORDER is the entire mechanism.
2. **The install was a silent no-op.** With the order corrected, `t2.js`
   still answered 11. The static method's flag word (`METHOD_FLAGS = 0x01|0x04`)
   omits bit 7, `HOST_HAS_VALUE`. §10.1.6.3 step 6 reads a descriptor with
   neither `[[Value]]` nor `[[Writable]]` as GENERIC, and
   `object-runtime-descriptors.ts`'s `keepAccessor` arm then updates the
   attributes and leaves the accessor's halves LIVE. So the method install
   never replaced anything, in EITHER order. `METHOD_FLAGS` now carries bit 7.
   The prototype installs (`class-proto-object.ts`) keep the old constant and
   are byte-identical: they only ever define a fresh key, where the bit is not
   read.

Measured (`probeP3`, node = 9):

| probe | node | base | lane | fix |
|---|---|---|---|---|
| `t2.js` accessor-then-method | 9 | 9 | **11** | **9** |
| `t7` method-then-accessor (node 11) | 11 | 9 | 11 | **11** |
| `m2.js probeP3` | 2 | 2 | **11** | **2** |
| `m2.js probeP9` | 2 | -1 | -1 | **2** |
| distinct keys `k`/`m` both reachable | 11/9 | -1/9 | 11/9 | 11/9 |

#### Finding 2 (high) — a nested class hid a receiver read: FIXED

`staticAccessorHalfIsReceiverFree` used `genBodyReferencesThis`, which stops
descending at `ts.isClassLike`. `static get [k]() { class X { static f = this; }
return 6; }` therefore read as receiver-free, the half was installed, and the
call trapped uncatchably ("dereferencing a null pointer") where base had merely
answered `undefined` — strictly worse than the missing property it was meant to
fix.

Two candidate fixes were both implemented and measured:

- A **conservative syntactic walker** (descend into nested classes; count a
  nested function-like's computed name). It fixes the trap, but it also
  DECLINES halves that are genuinely receiver-free — measured on `m5.js`, it
  turned `probeA7`-shaped correct answers into missing properties.
- **The compiled body**, which is what shipped: `compiledBodyReadsThis` (a new
  tri-state export of the `local.get 0` scan `closures/method-trampolines.ts`
  already runs for its own trampolines). The half's funcMap body is already
  filled when the sidecar is emitted — verified, it answers `false`, not
  `undefined`, for the whole `cpn-class-*-accessors-*` family — so this is
  available AND cannot be wrong by construction. `undefined` (no defined
  function, or a minted-but-EMPTY body) is a decline; an empty instruction list
  must never read as "receiver-free", which is the hazard the original header
  named as the reason to stay syntactic.

Measured on `m5.js` and `t1.js` (node / base / lane / fix):

| probe | node | base | lane | fix |
|---|---|---|---|---|
| `t1.js probeC2` (nested class `this`) | 6 | -1 | **TRAP** | **-1** |
| `t1.js probeCatch` (is the trap catchable?) | 6 | undefined | **TRAP** | **undefined** |
| `m5 probeA2` (same shape) | 6 | -1 | **TRAP** | **-1** |
| `m5 probeA4` (`typeof this`) | 2 | -1 | -1 | **2** |
| `m5 probeA1/A6/A7` | 5/7/7 | -1 | 5/7/7 | 5/7/7 |
| `m5 probeA3/A5` (arrow `this`, `super.f`) | 2/3 | -1 | -1 | -1 |

`t1` answers base's `-1` and no longer throws, which is the pin the review
asked for. It is a WRONG answer (node says 6) — closing it needs the per-half
dummy-receiver trampoline the module header already names, not a predicate
change. `probeA4` is a bonus: the compiled-body gate installs a half the
syntactic one declined, and it agrees with node.

**Cost of the gate, pinned:** it over-declines one measured shape. A half
containing an object literal whose computed key only COMPARES `this`
(`{ [this === undefined ? "a" : "b"]() {} }`) emits a `local.get 0` that never
dereferences, so installing it was safe and the lane answered node's 6; the fix
answers `-1`. The gate cannot tell a comparing read from a dereferencing one,
and a dereferencing one is an uncatchable trap, so the decline is the deliberate
direction. Pinned as `OVER-DECLINE` in the test file so the cost is visible if
the gate is ever refined.

#### Finding 3 (low) — a static FIELD does not shadow the sidecar: RECORDED

Not fixed, and the declaration-order pass cannot reach it. Static fields keep
the `staticProps` global lowering and never enter the sidecar; mirroring a
mutable slot there would give it two sources of truth, which is the module's
standing exclusion. §15.7.14 runs static field initializers AFTER every method
and accessor is installed, so node answers the FIELD in BOTH orders:

| probe (`m3.js`) | node | base | lane | fix |
|---|---|---|---|---|
| `probeQ1` accessor-then-field | 7 | -1 | 11 | 11 |
| `probeQ2` field-then-accessor | 7 | -1 | 11 | 11 |

Base answers `undefined`, the lane and the fix answer the accessor — all three
are wrong, and this is not a regression against a working program. Closing it
means widening the sidecar to static fields (with an ordering rule that puts
every field after every method and accessor, regardless of source position) and
resolving the mutable-slot duplication. Recorded in the module header and
pinned in the test file with the node answer alongside.

#### Also found, RECORDED not fixed — the prototype twin of finding 1

`class G { get [k]() { return 2; } [k]() { return 1; } }` — a prototype method
textually after a same-key accessor — answers the accessor where node answers
the method. Same two causes: `class-proto-object.ts` installs methods first and
accessors second (its own #4455 note), and its method flag word omits bit 7 for
the same reason. It is **base-equal**: on `m13.js probeG2` base, lane and fix
all answer 2 where node answers 1, so the r4 work neither caused nor changed it.

The first pin written for this asserted 2 and FAILED — the isolated one-class
shape reaches NEITHER member on base or on this tree, so the ordering never gets
a chance to be wrong there. `m13.js`, which puts four such classes in one
module, is where the members ARE reached and the ordering shows. The pin now
records the measured isolated answer with that distinction written next to it;
fixing the ordering needs its own control sweep and is not this round's.

Also base-equal and unchanged: `m4 probeN2`/`probeZ` (a `[x + 2]` key and its
side effect), `m2 probeP7` (a nested class expression's static accessor),
`m5 probeA3`/`probeA5` (an arrow-captured `this`, `super.f` in a static
accessor), and `m13 probeG1`.

#### Rows and controls

- **`tests/issue-5318-r4-computed-accessor-keys.test.ts`: 45/45**, single fork
  at `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, under BOTH node 22 (local) and node
  25 (CI's version). The file grew from 32 to 45 tests: the three findings plus
  the two residuals above, each with its node oracle.
- **r3 pins: 225/225** — `tests/issue-5195-es2015-class-r2.test.ts`,
  `issue-5195-r3-heritage-check`, `issue-5195-r3-restricted-properties`,
  `issue-5195-r3-review`, `issue-5309-child-field-shadows-parent-method`,
  `issue-5312-uninitialised-field-reads-undefined`.
- **The 24-row `cpn` list: 18 pass / 6 fail**, unchanged from the r4 pass. The
  6 are the four `-assignment-expression-assignment` rows whose decline #5195's
  review set, plus the two `accessor-name-{inst,static}-computed-in` rows that
  need an `__extern_set` class arm.
- **The 783-row class control, re-run whole on this tree: 246 non-pass** —
  identical to the lane's 246, against base's 271. **Zero rows worse than the
  lane and zero worse than base**; the 25 rows the r4 pass flipped are all still
  flipped.

  Two rows read as regressions in the raw sweep (`cptn-decl.js`, which base
  passes, and `subclass/builtin-objects/Function/super-must-be-called.js`, the
  r4 pass's #3371-gated bonus). Both are an INFRASTRUCTURE artifact, diagnosed
  and re-measured rather than assumed: the quickjs eval adapter is cached under
  a key derived from `compiler-bundle.mjs`, and this session built the bundle
  BEFORE editing `src/`, so every runtime-eval row in the sweep hit "the quickjs
  provider is not built" for the new key. 40 rows carried that error. Rebuilding
  the provider and re-running all 40 alone: exactly those 2 pass, and the other
  38 are non-pass on the lane and on base too, so nothing else was masked.
  **Rebuild the eval provider AFTER the last `src/` edit, not before** — the
  bundle key moves with the source.
- **Reviewer matrices `m4`, `m13`, `m2`, `m5`, `t1`, `t2`, `m3`** re-run on
  base / lane / fix / node: every probe is lane-or-better. `m4` and `m13` are
  byte-for-byte the lane's answers; `m2`, `m5`, `t1`, `t2` and `m3` improve as
  tabled above; nothing regressed against the lane.

#### Gates

`check-loc-budget` · `check-func-budget` (both bare AND with
`LOC_GATE_BASE=b08dd4589c`, `origin/main` at the time of the run: "no unallowed
growth in 30 changed src files, net -657 LOC") · `check-coercion-sites` ·
`check:oracle-ratchet` ·
`check:dead-exports` · `check:speculative-rollback` · `check:stack-balance` ·
`check:codegen-fallbacks` · `check:any-box-sites` · TS7 `--noEmit` · `lint` —
all exit 0, each run bare with its status read directly. No growth grant needed.

### Review round 1 — reviewer verdict, and the round-2 residual (2026-09-05, Fable)

A single Opus reviewer attacked the round-1 commit (415184a693) against the
pre-fix lane, base and node. The declaration-order pass and the `HOST_HAS_VALUE`
bit checked out: bit 7 is read only on the existing-key arm of the descriptor
runtime, a fresh key's descriptor is unchanged from base, and every collision
probe (method↔field both orders, runtime↔folded keys, split getter/setter halves
with a method between, setter-only pairs) answers node. `wasi` and the JS-host
target are byte-identical to the lane on six class programs. Pins 45/45 and the
r3 pins 225/225 on node 22 and node 25.

**One real regression against the LANE (not against main) — left in, recorded
here for round 2.** The compiled-body gate `compiledBodyReadsThis` answers
`undefined` when the half's funcMap body is still empty, and it is empty for
every class nested inside a function, arrow or method, because
`emitClassStaticSidecar` runs at ClassDefinitionEvaluation while the enclosing
function is still being compiled. So every runtime-keyed static *accessor* on a
nested class is silently declined (the method half still installs). Minimal
repro, standalone:

```js
let x = 0;
export function probeH() {
  class H { static get [x || "k"]() { return 23; } }
  const v = H[x || "k"]; return v === undefined ? -1 : v;
}
// node 23 · base -1 · r4 lane 23 · round 1 -1
```

Six placements of the same getter: top-level class and top-level if-block class
keep the lane's answer; class inside an arrow / a function declaration / a
static method / the probe function itself all revert to base's `-1`. The fix
tree's binaries for those programs are sha256-identical to BASE — the sidecar
disappears rather than degrading. Not a regression versus `main` (base answers
`-1` too), no throw, no diagnostic, and the 783-row control is unchanged at 246
non-pass, which is why it ships; but it gives back part of what r4 bought.

**Round 2 (not done — wind-down).** Make the gate
`readsThis === false || (readsThis === undefined && syntacticallyReceiverFree(half))`,
where the syntactic walker is the HARDENED one round 1 measured and discarded
(descends into nested class-likes; counts `this` in a nested function-like's
computed name, in parameter defaults and computed keys; anything
`genBodyReferencesThis` skips but `methodBodyReadsThis` would flag counts as
receiver-reading). That keeps t1.js (nested class whose static field initializer
reads `this`) at base's `-1` with no trap, and restores the nested-class installs.
Before shipping it, measure the walker against every nested-class shape
(`this` in a nested arrow, in a default parameter, in a computed key of a nested
member, via `arguments`, in a nested class's static block / field / method,
`super.x`, `eval`) and confirm `compiledBodyReadsThis` agrees once the enclosing
function has finished compiling — a disagreement in the unsafe direction is a
decline, never an install. Pin h3/h4/g1/d1-style shapes in
`tests/issue-5318-r4-computed-accessor-keys.test.ts` (today every class in that
file is lexically top-level, which is why the suite did not catch this). A
round-2 agent was dispatched twice on 2026-09-05 and did not finish: the first
launch died with a container restart, the second was stopped at wind-down; its
worktree `wf_28a520bf-7c3-1` holds only the merge commit.
