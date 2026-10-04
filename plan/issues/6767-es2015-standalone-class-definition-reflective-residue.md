---
id: 6767
title: "ES2015 standalone class definition — reflective residue: static-member descriptors, `getPrototypeOf(C.prototype)`, heritage `prototype` validation, restricted-id static accessors"
status: ready
sprint: current
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6651, 5318, 5195, 4770, 5350, 5269]
loc-budget-allow:
  # 2026-09-30 (#6767 plan): static-member descriptor synthesis at the gOPD
  # literal-key fold, the base-class prototype link, two heritage proofs,
  # and the restricted-id static accessor dispatch. Wiring only in the
  # listed files; any helper longer than ~40 lines goes in the NEW leaf
  # `src/codegen/class-static-descriptor.ts`.
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/class-static-descriptor.ts
  - src/codegen/class-proto-object.ts
  - src/codegen/class-heritage-check.ts
  - src/codegen/class-static-metadata.ts
  - src/codegen/object-runtime-prototype.ts
  - scripts/compiler-boundaries.json
  # 2026-09-30 (#6767 implementation): ONE import line. The call-site
  # parameter inference must withdraw its `$C` narrowing for a
  # `<Class>.prototype` argument (the standalone prototype is an `$Object`,
  # never a `$C`) — the predicate lives in class-proto-object.ts; the
  # consuming condition is edited in place (line-neutral).
  - src/codegen/declarations/param-return-inference.ts
---

## Problem

`language/statements/class/definition/**` still has 18 non-pass rows on
standalone (2026-09-29 22:47 UTC baseline). #5318 (class r4/r5, claimed
2026-09-04, no activity since 2026-09-06) listed them and gave the cluster
up as "the reflective own-property surface on the class object … needs the
reflective natives redirected" (#5195 cluster B) plus "every row that would
require ADDING a throw". This issue takes the definition cluster over from
#5318 — its claim is stale (26 days) and its worktree is gone; #5318 keeps
the computed-property-name work it actually did.

Measured on `origin/main` @ `eb57f327`, standalone:

| probe | program | main | node |
| --- | --- | --- | --- |
| p11 | `class C { method(){} static staticMethod(){} get x(){} static get sx(){} }` — `gOPD(C,'staticMethod') === undefined` (1) / is a function descriptor (2); `gOPD(C,'sx') === undefined` (4); `getPrototypeOf(C.prototype) === Object.prototype` (8); `getPrototypeOf(C) === Function.prototype` (16); `getOwnPropertyNames(C)` has `staticMethod` (32) and `prototype` (64); `C.hasOwnProperty('staticMethod')` (128) | **229** (=1+4+32+64+128) | 250 (=2+8+16+32+64+128) |
| p12 | `class Class { method(){} get accessor(){} set accessor(x){} 1(){return 7} get eval(){return 1} static get eval(){return 3} }` — no `caller`/`arguments` own props on `instance.method` (1); `gOPD(Class.prototype,'accessor').get.name === 'get accessor'` (2) / `.set.name` (4); `gOPD(Class.prototype,'1').value() === 7` (8); `Class.eval === 3` (16); `new Class().eval === 1` (32); `gOPD(Class,'eval') !== undefined` (64); `class D extends (function(){}).bind() {}` throws TypeError (128); `class E extends 7 {}` throws TypeError (256) | **303** (=1+2+4+8+32+256) | 511 |

So: `Object.getOwnPropertyDescriptor(C, <static method or accessor>)`
answers `undefined` although `getOwnPropertyNames` and `hasOwnProperty` see
the key; a static accessor named `eval` resolves to the INSTANCE accessor;
a base class's `C.prototype` does not report `Object.prototype` as its
prototype and `C` does not report `Function.prototype`; a heritage that is
a constructor WITHOUT a `prototype` property (a bound function) does not
throw at definition time.

### Rows (standalone non-pass; all under `language/statements/class/definition/`)

Step 1 (descriptors) — `methods.js`, `accessors.js`, `getters-prop-desc.js`,
`setters-prop-desc.js`, `numeric-property-names.js` (all fail with
"Cannot convert undefined or null to object" at the first `gOPD(C, …)`),
`getters-restricted-ids.js`, `setters-restricted-ids.js`.

Step 2 (prototype links) — `basics.js`.

Step 3 (heritage) — `constructable-but-no-prototype.js`,
`prototype-setter.js`, `invalid-extends.js`.

Step 4 (function-object restricted properties) —
`methods-restricted-properties.js` (`instance.method.caller` must throw a
TypeError — %ThrowTypeError%), `fn-name-accessor-get.js`,
`fn-name-accessor-set.js` (trap at `:855-856` — measure).

Recorded only — need a `this`-before-`super()` runtime flag the compiler
does not have (#5350 round-3 g5/n3): `this-access-restriction.js`,
`this-access-restriction-2.js`, `this-check-ordering.js`,
`side-effects-in-extends.js` (IR support-unit CE), `prototype-getter.js`.

Row list: `.tmp/6767/rows.txt` (paths relative to `test262/test/`).

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

### Step 0 — base copies and the before-state

`mkdir -p .tmp/6767 && git archive origin/main src | tar -x -C .tmp/6767/base-src`;
write p11/p12 to `.tmp/6767/p11.js`, `p12.js` with the probe runner from
#6766's Step 0; run `rows.txt` on the unmodified tree
(`flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts .tmp/6767/rows.txt --isolate --standalone > .tmp/6767/rows-base.log`).

### Step 1 — `gOPD(C, <static member>)` synthesises the descriptor at the fold

`src/codegen/expressions/call-builtin-static.ts:3320-3380` is the
`Object.getOwnPropertyDescriptor` literal-key fold for a class receiver. When
`hasClassStaticMethod(ctx, classIdentity, propLiteral)` or
`ctx.staticAccessorSet.has(`${classIdentity}_${propLiteral}`)` holds it
deliberately skips the fast-path `undefined` and "lets the dynamic fallback
handle the method case via the host import" — on standalone that fallback
is the native `__getOwnPropertyDescriptor`, which has no arm for the class
object carrier, so the answer is `undefined`.

Fix at the fold, mirroring the #4770 arm right below it (`classOwnKey &&
!classIntrinsicOverridden` → `__create_descriptor`):

- static METHOD: emit the method VALUE the way `C.staticMethod` as a value
  compiles today (find the emitter: grep `classStaticMethodNames` in
  `src/codegen/expressions/property-access*.ts` / `class-static-*.ts`; the
  `Object.getOwnPropertyNames(C)` path at `call-builtin-static.ts:3686`
  proves the metadata is there), then
  `__create_descriptor(value, FLAG_WRITABLE | FLAG_CONFIGURABLE)` (flags in
  `object-runtime-descriptors.ts`; §15.7.x: writable, non-enumerable,
  configurable).
- static ACCESSOR: `__create_accessor_descriptor(get, set, FLAG_CONFIGURABLE)`
  (or the existing accessor-descriptor native — grep `__create_descriptor`
  siblings in `object-runtime-descriptors.ts:2990-3020`); the getter/setter
  closure values are the halves `class-static-sidecar.ts` already
  materialises (`staticAccessorHalfIsReceiverFree` at `:172` names how a
  half is fetched).
- numeric static keys (`static 1(){}`) go through the same fold when
  `propLiteral` is the canonical numeric string; verify with
  `numeric-property-names.js`.
- The DYNAMIC-key form `gOPD(C, k)` stays as it is (record it) unless the
  static sidecar already carries a runtime-keyed table — then add the arm to
  `__getOwnPropertyDescriptor` via `fillClassProtoLookupArm`'s sibling
  (`class-proto-lookup.ts:221`), which is the #5195 Step 1.7 idiom.
- `getters-restricted-ids.js` / `setters-restricted-ids.js`: `C.eval`
  answers the INSTANCE accessor's value. `class-static-metadata.ts:289
  restrictedPropertyReceiverIsClass` / `:341 classObjectRestrictedProperty`
  special-case `eval`/`arguments` on a class receiver; a declared static
  accessor of that name must win over the restriction — find the read
  site that consults them and let a declared static accessor take
  precedence.

### Step 2 — a base class links `Object.prototype`; `C` links `Function.prototype`

`class-proto-object.ts:243-260` links `D.prototype.[[Prototype]]` only when
the parent is a class with a prototype `$Object`. A BASE class's prototype
`$Object` keeps `$proto = null`, and `__getPrototypeOf`
(`object-runtime-prototype.ts:513-591`) answers `%Object.prototype%` for a
null `$proto` only through `objectProtoSingletonIdx` — p11 shows that answer
is still not `Object.prototype` for `C.prototype`. Measure first
(`.tmp/6767/q1.js`: `Object.getPrototypeOf(C.prototype) === Object.prototype`,
`Object.getPrototypeOf(C.prototype) === null`, `typeof
Object.getPrototypeOf(C.prototype)`) to learn WHICH object comes back —
likely the prototype read goes through `fnctorGetPrototypeArm`
(`object-runtime-prototype.ts:147`) rather than the `$Object` arm. Then
either link the singleton at class-definition time (the #5350 residual
"needs `D.prototype.[[Prototype]] === Object.prototype`,
`class-proto-object.ts:243-260`") or make the arm answer the singleton.
`Object.getPrototypeOf(C) === Function.prototype` is the same question for
the class object itself (the `%Function.prototype%` carrier the `Function`
brand owns — grep `FUNCTION_PROTO_SINGLETON` / `fillFunctionProtoSingleton`).

### Step 3 — heritage `prototype` validation, compile-time proof only

`src/codegen/class-heritage-check.ts` is COMPILE-TIME PROOF ONLY by design
(its header, review F1 of #5195 r3): never add a runtime arm. Extend
`heritagePrototypeIsProvablyInvalid` (`:290`) with the shapes the rows use:

- `(<function expression or declaration>).bind(…)` — BoundFunctionCreate
  (§10.4.1.3) never creates a `prototype` property, so `Get(superclass,
  "prototype")` is `undefined` → TypeError. Provable when the receiver of
  `.bind` is a function literal, or an identifier whose unique, never-written
  declaration is a function (reuse `bindingIsUniqueAndNeverWritten` and the
  alias-chain walk of `heritageIsProvablyNotConstructor`).
  `constructable-but-no-prototype.js` (`var Base = function() {}.bind();`).
- `prototype-setter.js`: same `Base`, then `Object.defineProperty(Base,
  'prototype', { set })` — a setter-only accessor still reads `undefined`,
  so the same proof applies as long as no statement between the declaration
  and the class can install a GETTER; the simplest sound rule: a
  `defineProperty(Base, 'prototype', <literal without a get/value key>)` on
  that binding keeps the proof, anything else declines.
- `invalid-extends.js`: read the test; add its shape only if it is provable
  the same way, otherwise record it.

The thrown message is the existing one at `:362`. Order: the heritage
expression's side effects run before the throw (§15.7.14 step 5.a–f) —
`prototype-setter.js` asserts the Test262Error from the SETTER is NOT what
escapes (a read never invokes a setter).

### Step 4 — function-object restricted properties (measure first)

Run the three rows; name the first failing assertion. For
`methods-restricted-properties.js` the expected failure is
`assert.throws(TypeError, () => instance.method.caller)` — strict function
objects expose `caller`/`arguments` through %ThrowTypeError% (§10.2.4,
AddRestrictedFunctionProperties applies to %Function.prototype%, not to the
method): the read must reach the `Function.prototype` accessor and throw.
Fix only if the throw can be emitted where the fold already knows the
receiver is a class method value; otherwise record with the mechanism.

### Step 5 — pins, controls, gates, record

- Pin suite `tests/issue-6767-class-definition-reflective.test.ts`: p11
  → 250 and p12 → 511 (or the per-bit sub-assertions, one `it` per
  mechanism, each marked "RED on base"), plus two guards (a plain class
  `gOPD(C.prototype,'method')`, and `class D extends B {}` with a class
  parent — must answer the same on both trees).
- Control (0 pass → non-pass, per-path set diff): every currently-passing
  ES2015 standalone row under `language/statements/class/**` and
  `language/expressions/class/**` (~1,000 rows; #5318 ran a 783-row sweep
  as `Control corpus`, reuse its list if it is in
  `plan/agent-context/`), run once at the end on the merged tree under the
  lock.
- Gates: the chain in #6766 Step 5, identical.
- Record: append `### 2026-09-30 — #6767 implementation (Opus)` to THIS
  file (rows before/after, mechanisms of residuals, pins' base verdict,
  control diff, gates), plus a one-paragraph pointer in
  `plan/issues/5318-es2015-standalone-class-r4.md` ("definition cluster
  moved to #6767") and in
  `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`.

## Acceptance criteria

- Step 1 rows (7) and step 2 row pass on standalone, `--isolate`, on the
  branch with `origin/main` merged in; step 3 rows pass or are recorded
  with the exact declined shape; step 4 measured.
- p11 = 250 and p12 ≥ 447 (=511 − 64 if the dynamic-key gOPD form is
  recorded rather than built) on the branch; the pin file is red on base.
- 0 pass → non-pass across the class control; no new runtime arm in
  `class-heritage-check.ts`.
- All gates green; growth grants in this file's frontmatter only.

## Lane protocol

Same as #6766's (worktree under `/home/user/js2/.claude/worktrees/issue-6767`,
branch `issue-6767-class-definition-reflective`; symlink `node_modules` and
`test262`; `flock /tmp/claude-0/t262.lock` around every runner; push early to
`origin`, no PR; commit subject ends ` ✓`, author Thomas Tränkler, committer
Claude, trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
`Claude-Session: https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`,
`Model: Claude Opus 5.5 High`; never `--no-verify`; no `git stash`).

### 2026-09-30 — #6767 implementation (Opus)

Branch `issue-6767-class-definition-reflective` (worktree
`.claude/worktrees/agent-a25b3b3e08cd4c39a`), base `eb57f327`, `origin/main`
`60824ac4` merged in before the final measurements. Base tree for every A/B:
`.tmp/6767/base-src` = `git archive eb57f327 src`; none of the lane's 11 src
files changed on main between the two, so swapping them in IS merged-main.

#### Rows (standalone, `--isolate`, `.tmp/6767/rows.txt`)

| row | base | branch | step |
| --- | --- | --- | --- |
| `methods.js` | fail | **pass** | 1 |
| `accessors.js` | fail | **pass** | 1 |
| `getters-prop-desc.js` | fail | **pass** | 1 |
| `setters-prop-desc.js` | fail | **pass** | 1 |
| `numeric-property-names.js` | fail | **pass** | 1 |
| `getters-restricted-ids.js` | fail | fail | 1 — residual R1 |
| `setters-restricted-ids.js` | pass | pass | 1 (already passing: both setters have the same body) |
| `basics.js` | fail | **pass** | 2 |
| `constructable-but-no-prototype.js` | fail | **pass** | 3 |
| `prototype-setter.js` | fail | **pass** | 3 |
| `invalid-extends.js` | fail | **pass** | 3 |
| `methods-restricted-properties.js` | fail | fail | 4 — residual R2 |
| `fn-name-accessor-get.js` / `-set.js` | fail | fail | 4 — residual R1 (+ R3) |
| `this-access-restriction{,-2}.js`, `this-check-ordering.js`, `side-effects-in-extends.js` (CE), `prototype-getter.js` | non-pass | non-pass | recorded only (#5350) |

**1 → 10 pass of 19** (`.tmp/6767/rows-base.log` + `basics-base.log` →
`rows-final.log`). Probes: **p11 229 → 250**, **p12 303 → 495** (511 minus
bit 16, residual R1).

#### What each step needed — where the plan's model was wrong, measured

- **Step 1 is three defects, not one.** (a) The class object's reflective
  answer: the rows ask through a HELPER (`assertMethodDescriptor(object,
  name)`, `verifyProperty`), i.e. a runtime receiver AND key, so the plan's
  literal-key fold could only ever fix p11. New leaf
  `class-static-descriptor.ts`: a lazily built per-class view `$Object` of
  the declared statics (the sidecar emitter in a `"reflective-view"` mode that
  keeps receiver-reading accessor halves) plus identity-guarded arms. The fold
  change in `call-builtin-static.ts` is one line (static ACCESSOR keys route
  to the native instead of folding to `undefined`). (b) Every one of these
  rows ALSO failed on its first `C.prototype` assertion: call-site parameter
  inference agreed on `$C` for `object` from `C.prototype` (checker type `C`)
  and `C` (the class object is a `$C` struct, #3976), so the prototype
  `$Object` arrived as `ref.null $C` → "Cannot convert undefined or null to
  object". `param-return-inference.ts` now withdraws the narrowing for a
  `<Class>.prototype` argument (the #5151 `$NativeProto` twin; predicate in
  `class-proto-object.ts`). (c) `numeric-property-names.js` then failed on
  `assert.sameValue(C[4](), …)`: `compileTailDispatch`'s element-access
  INSTANCE and STRUCT arms matched the static method `C_4` through the class
  symbol and pushed the class object as a hidden receiver the static function
  does not take. At statement level the stack fixer drops it; as a call
  ARGUMENT it shifted the operands (standalone: "called value is not a
  function"; the pin's shape produced an INVALID module on base). Both arms
  now yield to the static arm (`class-member-keys.ts::
  elementCallTargetsStaticMethod`, the static arm's own claim condition).
- **The view has to answer the whole MOP, not only reflection.** The first cut
  (gOPD + hasOwn arms only) regressed `tests/issue-5318-r4-computed-accessor-
  keys.test.ts` (`P[x || "k"]` → -1, base 9): the #5195 lookup arms delegate a
  class-object key to the static sidecar only when `__hasOwnProperty` says it
  is NOT own. So the view also answers `__extern_get` (via
  `__reflect_get_receiver`, the class object as receiver), `__extern_has`, and
  a declared setter in `__extern_set`; and a class with a RUNTIME-keyed static
  gets no view (only the sidecar's install order resolves a runtime key landing
  on a folded one). Arms in: `__getOwnPropertyDescriptor`, `__hasOwnProperty`,
  `__object_hasOwn`, `__extern_has`, `__extern_get`, `__extern_set`; a
  `delete C[k]` tombstone (#4098 substrate) falls through, which is what
  `verifyProperty`'s `isConfigurable` needs.
- **Step 2**: the `__getPrototypeOf` path was never wrong — the plan's
  `fnctorGetPrototypeArm` suspicion did not apply. Two compile-time FOLDS in
  `call-builtin-static.ts` were: `C.prototype` → `null` ("Object.prototype not
  modeled") and the class OBJECT → the class-INSTANCE arm → `C.prototype`.
  Measured through an untyped parameter the runtime already answers
  `%Object.prototype%` / `%Function.prototype%` (`.tmp/6767/q2.js`), so the ES5
  early hook routes a BASE class's two operand shapes to that runtime lowering
  (`object-get-prototype-of.ts`); no link was added at class definition.
- **Step 3**: compile-time proof only, no runtime arm (the header's F1 rule
  holds). `<plain function literal>.bind(…)` (direct, or a unique never-written
  `var` alias whose only other references are `extends` operands or
  `Object.defineProperty(alias, "prototype", {…no get/value…})`) → step
  5.g.ii "does not have valid prototype property undefined";
  `Math.<anything>` while every use of `Math` in the file is a member READ →
  step 5.f "not a constructor". Both rest on the intrinsics being unmodified
  (`Function.prototype.bind`, no `prototype` on %Function.prototype% /
  %Object.prototype%), the same assumption the #6651 C5 `%Proxy%` arm makes.
- **Step 4** (measured, nothing built): see R2 / R1 / R3.

#### Residuals, with their mechanisms

- **R1 — a static accessor with the same name as an INSTANCE accessor shares
  its function slot.** `class-bodies.ts` registers both as
  `${C}_get_${name}` and skips the second (#1983 guard; the body loop's
  "other kind owns the slot"), so `C.eval` runs the instance getter
  (`getters-restricted-ids.js`; p12 bit 16; the plan's
  `classObjectRestrictedProperty` hypothesis does not apply — that is
  `caller`/`arguments` only, and the defect is not `eval`-specific:
  `get foo(){return 1} static get foo(){return 3}` answers 1 too). In
  `fn-name-accessor-{get,set}.js` it also keeps the INSTANCE `get id` off the
  prototype `$Object` (`gOPD(A.prototype, 'id')` → undefined at 855:10).
  Fixing it means a distinct static key through registration, body compile,
  the typed static read/write/compound/update sites and the sidecar/view —
  three god-files outside this issue's grant. Pinned (`RESIDUAL` test).
- **R2 — `instance.method.caller` does not throw** (`methods-restricted-
  properties.js`). Strict function objects inherit the %ThrowTypeError%
  `caller`/`arguments` accessors from %Function.prototype% (§10.2.4); the
  standalone closure carrier has no such accessor, and 8 of the 12
  assertions read them off `gOPD(...).get/.set` VALUES, so a fold at the typed
  `instance.method` site cannot close the row. Needs the accessor on the
  %Function.prototype% carrier (or a strict-closure arm in `__extern_get` /
  `__extern_set`).
- **R3 — runtime-keyed statics get no view** (`static get [sym]()` in
  `fn-name-accessor-*`): by design, see above; they keep base's `undefined`.
- **R4 — `Object.getPrototypeOf(D)` for a DERIVED class object** answers
  `D.prototype` (the fold) and the runtime answers neither the parent nor
  `%Function.prototype%` (`.tmp/6767/q3.js`); step 2 is base-class-only.
  Pinned. Not a row of this cluster.
- Observed on both trees, not this issue's: `C.sm === C.sm` is false (the typed
  static-method read materializes a fresh closure per site, so
  `gOPD(C,'sm').value === C.sm` cannot hold); `var p = C.prototype` at module
  scope types `p` as `$C` and nulls it (the slot twin of the parameter fix — a
  wider type-mapping change); `D.hasOwnProperty('s')` folds `true` for an
  INHERITED static; a dynamic read of an inherited static on a class that
  declares its own statics answers `undefined`.

#### Pins — `tests/issue-6767-class-definition-reflective.test.ts`

12 cases, 12 green on the branch. **Base verdict** (the 11 src files swapped
to `eb57f327`): all 8 step cases RED — p11 229, p12 303, helper descriptors
811, bound hasOwn + delete 28, dynamic read/write/`in` 2, `C[4]()` as an
argument an invalid module ("f64.add expected type f64, found local.tee of
type externref"), base-class prototypes 0, heritage 0; the 2 guards and the
2 RESIDUAL pins green on both trees.

#### Related suites (branch vs base, both measured)

`tests/issue-{4455,4770-class-name-descriptor,5151-map-size-descriptor,5195-es2015-class-r2,5195-r3-heritage-check,5195-r3-restricted-properties,5195-r3-review,5318-r4-computed-accessor-keys,5318-r5-objlit-computed-accessor-keys,5383-class-value-dynamic-call}`:
6 failures on both trees, the same 6 (none new).
`tests/issue-{1472-es5-getprototypeof,3037-cs1c-getprototypeof-carrier,4098-error-expando,4194-*,4616,5169,5325,5347,6457,6464,6609,6617,6625,6651-c-class-expando-mop,6651-c5-builtin-subclass}`:
4 failures on both trees, the same 4. The 9 class files under
`tests/equivalence/` pass. The one change that is not standalone-gated (the
`compileTailDispatch` element-call yield) was probed on the host lane too:
`.tmp/6767/p27.js` answers 220 on base and 0 (all five shapes right) on the
branch.

#### Control — 0 pass → non-pass attributable to the branch

Population: every ES2015 row under `language/{statements,expressions}/class/**`
that is `pass` in the 2026-09-29 22:47 standalone baseline
(`.test262-cache/test262-standalone-current.jsonl`, edition by
`scripts/generate-editions.ts::classifyEdition`) — **2203 rows**
(`.tmp/6767/control.txt`, built by `.tmp/6767/control.mts`). Run on the
merged tree, each row in a fresh child (`scripts/run-test262-paths.mts`
`JS2WASM_ROW_ONE` mode, 3 at a time, `.tmp/6767/prun.mts`), in chunks under
`flock /tmp/claude-0/t262.lock`.

**2201 pass, 2 fail.** The two —
`definition/methods-gen-yield-star-after-newline.js` and
`definition/methods-gen-yield-weak-binding.js` (parse-phase negatives,
"This statement should not be evaluated") — fail identically with the 11 src
files swapped back to `eb57f327` (`.tmp/6767/ctl-fails-base.log`): the
compiler accepts both sources on both trees, so they are an in-process-runner
vs sharded-worker scoring difference on the baseline, not a regression of
this change-set.

#### Gates (bare, chained, exit code read directly)

`check-loc-budget` (grants: this file, incl. the one added line for
`param-return-inference.ts`), `check-func-budget` (no function grew: the
edits inside `compileBuiltinStaticCall`, `compileTailDispatch` and
`inferParamTypeFromCallSites` are line-neutral), `check-coercion-sites`,
`check:oracle-ratchet` (+0), `check:dead-exports` — exit 0; loc/func also
exit 0 with `LOC_GATE_BASE=c72cb7be` (main after the merged `60824ac4`
advanced; its new commits touch none of this lane's files); `check-compiler-boundaries
--mode inventory` exit 0 (the new leaf classified next to its siblings in
`scripts/compiler-boundaries.json`); `check:host-import-policy` exit 0;
`npm run typecheck` exit 0.

### 2026-10-02 — residuals R1 / R4 moved to #6772 (pointer)

R4 (`Object.getPrototypeOf(D)` for a derived class) is fixed by #6772 S6 and
R1 (a static accessor sharing an instance accessor's function slot) by #6772
S12; both RESIDUAL pins in `tests/issue-6767-class-definition-reflective.test.ts`
now assert node's answer (p12 511, `C.eval` 3). R2 (%ThrowTypeError%
`caller`/`arguments` on method values) is #6772's optional S13, not
attempted. R3 (the runtime-keyed static view) is still open: it is the first
failing assertion of `fn-name-accessor-{get,set}.js` — `gOPD(A, 'id').get`
is undefined because A also declares symbol-keyed static accessors.
