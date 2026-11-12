---
id: 7341
title: "IR: `new Object()` in a script var is the open `$Object` carrier that `{}` already is"
status: in-progress
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-11-12
updated: 2026-11-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7340, 7280, 7194, 7335, 7128, 7295, 7273, 7304, 7106]
---

# #7341 — IR: `new Object()` as the open-object carrier

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only"). Census of 2026-11-11 (main `7ce9bc8fbf`; no
`src/` change up to `44774688e1`): 8,591 files compile, 1,505 are IR-only,
7,086 are blocked.

`new Object()` refuses twice in `src/ir/select.ts`:

- the call graph marks it an external call (`buildLocalCallGraph`, "Unknown
  constructor → external"), reported as `external-call(new Object)`;
- `phase1NewExpression` refuses it as `expr-new-ctor-unknown`: `Object` is
  neither a local class nor a known extern class.

132 blocked files carry the label and 146 construct `new Object(…)` in the
test body.

The same value spelled `{}` is admitted. #7280 S1 takes a script
`var o = {}` whose `__mod_o` slot is the dynamic carrier
(`isDynamicHomeOpenCarrier`), builds legacy's open `$Object` with
`__new_plain_object`, and lets every use read the var through the ordinary
dynamic arms. Legacy builds `new Object()` with the same call
(`emitObjectCoercion`, `src/codegen/expressions/calls-guards.ts`), and it
never widens such a var into a struct, which it does for `var o = {}` followed
by `o.p = 1`. So the `new Object()` spelling is the easier of the two for the
IR, and the only one refused.

```js
var object = new Object();     // 34 of the 45 measured files store it in a script var
object.prop = -1;
if (-object.prop !== 1) { … }
```

#7295 looked at this in passing and stopped at "needs a ToObject lowering".
That is true for `new Object(v)`, not for the form without an argument.

## Measurements

Base: `origin/main` `44774688e1`. Method, population (873 files, every blocked
ES5 file whose labels all belong to a stubbed lever), commands and the yield
table of all eleven candidates are in #7340, "Measurements". The rows that
matter here:

| stub | label count | files with the construct | freed alone (strict) | cumulative, greedy order |
|---|---|---|---|---|
| `new String/Number/Boolean` (#7340) | 610 | 734 | 55 (53) | 55 |
| `new Object(…)` (**this issue**) | 132 | 146 | **45** (34) | 102 |
| array literal in a script var | 646 | 638 | 34 (0) | 142 |

The stub admitted `new Object(…)` everywhere and answered a dynamic
`undefined` placeholder. "strict" = zero legacy units; the other 11 are
claimed at selection and withdrawn by from-ast, all on an equality operand.

### The 45 files, by what they need

| slice | files | shape |
|---|---|---|
| S1: no argument, the whole initializer of a script var | 23 | `var o = new Object();` |
| S2: one argument, initializer of a script var | 11 | `new Object(bool)`, `new Object(num)`, `new Object("" + 1)`, `new Object(1, 2, 3)` |
| S3: no argument, operand of `===` / `!==` / `==` / `!=` | 10 | `null === new Object()`, `new Object() != Number.NaN` |
| S3: no argument, receiver of a member read | 1 | `(new Object()).newProperty` |

How the 34 files with a stored object use the var (files): member read 33,
member store 23, `typeof` 11, call argument 9, `==` 9, `===` 1.

### Prototype: S1 and S2 built for real

Built on a second clean export of main, together with #7340's prototype
(`$P/data/prototype.diff`; scratch quality). Scope: the construction is the
whole initializer of, or the right side of a plain `=` to, a script var on
the dynamic home.

| step | files IR-only | pass (`run-test262-paths.mts --standalone`) |
|---|---|---|
| S1 | **23** of 23 | 23 of 23 |
| S1 + S2 (`new Object(<a var or literal of a primitive family>)`) | **28** | 28 of 28 |

- With `isOpenObjectBinding(decl)` added as a condition for the form without
  an argument, all 28 stay IR-only. Legacy's predicate answers `true` for a
  `new Object()` initializer, so #7280's declaration test applies unchanged.
- The six S2 files not gained: `new Object("" + 1)` and
  `new Object((1 === 1) && !(false))` (the selector cannot name the
  argument's family), three with extra arguments (`new Object(1, 2, 3)`), one
  withdrawn by an unrelated from-ast gap (an empty array literal inside the
  argument).
- `built-ins/Object/S15.2.2.1_A4_T1.js` reads `n_obj.constructor` on a
  Boolean wrapper built by `new Object(bool)` and passes.
- A seeded sample of 300 files that are IR-only on main stays IR-only and
  passes as on main (see #7340).

## Implementation Plan

### Mechanism

`new Object()` with no argument, where `Object` is the realm's, is the empty
object literal in another spelling. It takes #7280's admission and #7128's
lowering unchanged:

- **admission**: the one initializer test, `isDynamicHomeOpenCarrier`
  (script `var`, `__mod_` slot on the dynamic carrier, legacy keeps the
  binding open, every `in` of the unit has an own-only key);
- **lowering**: `__new_plain_object`, boxed onto the carrier because the slot
  is the carrier (`emitNewPlainObject`, the two lines of `lowerObjectLiteral`'s
  open-carrier arm);
- **uses**: the dynamic arms that already read a `{}` carrier. None is added.

The legacy object is the same one: both paths call `__new_plain_object`, so a
legacy unit and an IR unit that share the var agree on its store.

### Result typing

| position of `new Object()` | admitted | selector's family | from-ast's value |
|---|---|---|---|
| whole initializer of a script var on the dynamic home (`isDynamicHomeOpenCarrier`) | S1 | the binding's, `dynamic` | `__new_plain_object`, boxed `irDynamic()` |
| operand of an equality (S3) | S3 | `dynamic` (it joins `selectorCarrierValue`) | the same box |
| anything else | refused | | |

from-ast boxes because the position is one of the two rows, the rule #7340
uses, not because a hint happened to be `dynamic`.

### Module placement

- **`src/ir/empty-object-literal.ts`** already owns "an empty object value
  and the binding it initializes". It gains `emptyObjectExpression(expr,
  isAmbient)`: `{}`, or `new Object()` with no argument and an ambient
  `Object`. `emptyObjectLiteralBinding` takes that expression instead of a
  literal.
- **`src/ir/open-object-carrier.ts`** owns the lowering. The open-carrier arm
  of `lowerObjectLiteral` (`emitNewPlainObject`, then the box) becomes one
  exported emitter that both spellings call.
- **`src/ir/select.ts`**: `isDynamicHomeOpenCarrier` accepts the widened
  expression type. `phase1NewExpression` and the call-graph `new` arm each
  get one hook that asks `emptyObjectExpression`.
- **`src/ir/from-ast.ts`**: one hook in `lowerNewExpression`.
- **S2 only**: `new Object(v)` is a row of #7340's
  `src/ir/wrapper-construction.ts`, see below.
- `src/ir/object-statics.ts` and the own-property rows (#7338, #7339) are not
  touched.

### What it reuses

- `isDynamicHomeOpenCarrier`, `isDynamicHomeOpenCarrierDeclaration` and
  `unitInKeysAreOwnOnly` (#7280 S1), unchanged in what they test.
- `irOpenObjectBinding` (`src/codegen/declarations/ir-open-object-binding.ts`),
  legacy's answer, measured `true` for the 28 files.
- `emitNewPlainObject` and the carrier box.
- The ambient-binding test the selector and from-ast already have
  (`selectorSeesAmbientBinding`, `resolver.isAmbientBinding`).
- S2: #7340's table and `emitWrapperConstruction`.

### Duplicates it removes

1. **The open-carrier lowering written twice.** Without this plan the `new`
   arm would repeat `lowerObjectLiteral`'s two lines. They become one emitter
   in `open-object-carrier.ts` with two callers.
2. **Two spellings, one recognizer.** `emptyObjectExpression` is the only
   place that says what an empty object value is. `isPhase1ObjectLiteral`'s
   `properties.length === 0` test and the new `new` hook both call it.
3. **The call-graph arm.** The `new` branch of `buildLocalCallGraph` already
   lists five "this construction is a lowering, not a call edge" cases, each
   repeating the argument walk. The hook is added as a sixth entry of one
   predicate list with a single walk, not as a sixth copy.

### Slices

Gates for every slice, on the 873-file set and the 1,505 files IR-only on
main: the stated gain, **0 lost**, **0 post-claim errors on a gained file**,
**0 gc binary changes**, unchanged pass / fail on every file whose routing
changed.

**S1: no argument, script-var initializer. Gain: 23 files (prototype, 23 of
23 pass).**

- Depends on nothing that is not on main: #7280 S1 landed
  `isDynamicHomeOpenCarrier`. It can start before #7340.
- The declaration form only (`var o = new Object();`), as for `{}`. A later
  `o = new Object()` is not admitted: #7280 has no such arm for `{}` either
  and no measured file needs it.
- Function-local `var o = new Object()` (#7128's local open carrier and
  #4471's inert arm) is not in this slice. No measured file needs it.
- Duplicates 1 to 3 are removed in this slice.

**S2: one primitive argument. Gain: +5 (28, prototype, 28 of 28 pass).**

- Requires #7340 S1 on main (its module and table).
- `new Object(v)` is ToObject(v). The argument's proven family picks the row:
  string, number or boolean builds that wrapper through #7340's emitter. The
  store position and the box are #7340's.
- `new Object(undefined)`, `new Object(null)` and `new Object(void 0)` with a
  literal argument are the form without an argument.
- Refused (`expr-new-object-argument`): an argument whose family is
  `dynamic`, a reference, or unknown. ToObject of such a value needs a
  run-time dispatch, and legacy has it only inline (`emitObjectCoercion`).
  Extracting it into a callable helper is a legacy change of its own, not
  planned here.
- Possible follow-up inside S2, +3 each, not prototyped: an argument
  expression whose family the selector can prove with a wider rule
  (`"" + 1`, a boolean expression), and extra arguments evaluated in order
  and discarded (`new Object(1, 2, 3)`).

**S3: a fresh `new Object()` as an equality operand. Expected gain: +10
(stub, claimed only, not prototyped).**

- The operand is typed the carrier on both sides. A strict equality against
  a primitive is `dyn.eq` strict; against `null` / `undefined` it is the
  existing tag fold; a loose equality needs #7194 (ToPrimitive of the
  object).
- The stub's from-ast withdrew these with "Phase 1 requires matching operand
  types", so the equality lowering must take the boxed operand. If that needs
  more than typing the operand as a carrier, drop S3 and record why.
- The one member-read file (`(new Object()).newProperty`) is not planned.

### Evaluation order

- No argument: nothing to order. Each evaluation makes a new object; never
  hoist the call or share it between two constructions.
- S2: the argument is evaluated once, then the wrapper is built. ToObject of
  a primitive runs no user code.
- The script var's slot is written after the construction, as for `{}`.
- `Object` must be the realm's: an unshadowed ambient binding, and `Object`
  not in the unit's scope.

### Refusal at selection only

from-ast treats a construction the selector did not admit as an invariant
violation. Reasons:

- `expr-new-object-home`: not the initializer of a script var that
  `isDynamicHomeOpenCarrier` accepts (not on the dynamic home, legacy does
  not keep it open, or an `in` of the unit may reach an inherited key).
- `expr-new-object-argument`: an argument S2 does not take, a spread, or
  more than one argument.
- `expr-new-object-position`: any other position (before S3: every equality
  operand).

`expr-new-ctor-unknown` and `external-call(new …)` no longer name `Object`
for an admitted construction.

### JS environment

`isDynamicHomeOpenCarrierDeclaration` requires the `isOpenObjectBinding`
selection option, which only the raw standalone lane supplies
(`irOpenObjectSelectionOption`). gc declines, as it does for `{}` (#7335's
A/B found no changed gc binary). No host import is added.

### Tests to add

`tests/issue-7341.test.ts`, standalone, each case asserting the result and
that the compile has no legacy unit:

- `var o = new Object(); o.p = 1; o.p`, a missing key reads `undefined`,
  `typeof o`, `if (o)`;
- two constructions are distinct objects (`o !== q`), one is itself;
- the var read and written from a top-level function;
- a legacy unit and the IR sharing the var: a function with a construct the
  IR refuses reads `o.p` written by `<module-init>`;
- S2: `new Object(true)`, `new Object(1)`, `new Object("a")` from a script
  var and from a literal, each with `typeof`, `==` against the primitive and
  `!==` against it; `new Object(null)` is a plain object;
- refusals, each asserting the unit stays legacy with the stated reason and
  still passes: a shadowed `Object`, `new Object(x)` with `x` a dynamic
  var, a spread, an `in` with a computed key in the unit, a `let` binding in
  a function, a construction passed straight to a call;
- the existing `tests/issue-7280-module-init-empty-object-carrier.test.ts`
  and `tests/issue-7335-dynamic-home-open-object.test.ts` unchanged.

### Acceptance criteria

Correctness:

- S1 gains the 23 prototype files and S2 the further 5 on the 873-file set. A
  shortfall is explained file by file.
- 0 files lost among the 1,505 files IR-only on main.
- 0 post-claim errors on a gained file.
- Every file whose unit routing changed passes or fails exactly as it does
  legacy-only.
- gc binaries byte-identical on the playground examples and on every third
  file of the 873.
- ES5 is a completed edition: no ES5 row may regress in the merge group.

Code quality:

- One recognizer of an empty object value and one open-carrier emitter in
  `src/ir/`; `lowerObjectLiteral` and the `new` hook call the same emitter.
- No second admission test for the binding: `isDynamicHomeOpenCarrier` is the
  only one, for both spellings.
- The call-graph `new` branch ends with fewer argument-walk copies than it
  has today.
- `select.ts` and `from-ast.ts` each end with a net line change ≤ 0.
- No loc or func budget grant. `check:dead-exports` clean.

## Risks and unverified assumptions

- **Same soundness envelope as `{}`.** #7280 admits the initializer with any
  use of the var, and #7335's review listed what that leaves open: a read of
  an inherited member answers `undefined` (#7304), and a loose equality
  against a number or boolean traps on main today (#7194:
  `var o = {}; if (o == 1) …` is IR-claimed and traps). This plan adds no new
  class of wrong answer, but more files reach those arms. The 28 prototype
  files pass, nine of them with `==` on the var. If the A/B finds a file that
  passes legacy-only and fails here, refuse the initializer for a var with
  that use, for both spellings.
- **gc byte-identity was not measured.** It rests on `isOpenObjectBinding`
  being absent off the standalone lane, as for `{}`.
- **S3 is a stub number.** Its from-ast side was not built.
- **`o = new Object()` after the declaration and function-local bindings were
  not measured** beyond the stub's all-positions count; they are left out.
- **Mixed files** (a legacy function reading the var) were not run. The
  object is the one legacy builds.
- **Census age.** Labels are from main `7ce9bc8fbf`; `src/` is unchanged up to
  the base `44774688e1`. Main has moved since (#7209, #7210, both in
  `select.ts`). Re-run the 28 on the current main before starting.

## Not covered

- Primitive wrappers: #7340.
- `new F()` for a script var or function `F` (15 files alone), arrays in
  script vars (34, routing only), IIFEs (20), object literals with
  properties (7 alone, 55 in combination with function values): measured in
  #7340, each its own lever.
- `Object(v)` called without `new`.
- A run-time ToObject helper shared by legacy and the IR.

## S1 implementation (2026-11-12)

S1 is done on branch `claude/7341-ir-new-object`; S2 and S3 remain.

What changed:

- `empty-object-literal.ts`: `isEmptyObjectExpression(expr, isAmbient)` is the
  one recognizer. It answers `{}`, and `new Object()` / `new Object` on the
  realm's `Object`. `isPhase1ObjectLiteral`'s empty test, `phase1NewObject` and
  the call-graph `new` arm all call it.
- `open-object-carrier.ts`: `emitOpenCarrierObject(builder, onDynamicCarrier)`
  replaces the two inline lines of `lowerObjectLiteral`. The `new` hook in
  `lowerNewExpression` is its second caller, always boxed, because the only
  position S1 admits is a dynamic-home slot.
- `select.ts`: `phase1NewObject` names the three refusals
  (`expr-new-object-argument`, `-position`, `-home`) and otherwise asks
  `isDynamicHomeOpenCarrier`, unchanged apart from taking either spelling. The
  admitted set is now `admittedEmptyObjectIsOpenCarrier`.
- `buildLocalCallGraph`: the five "a construction is a lowering, not a call
  edge" cases plus the new one are one predicate, `isLoweredConstruction`,
  with a single argument walk (five walk copies before, one after).
- `select.ts` net line change 0, `from-ast.ts` −1; no loc or func grant.

Not done: `dynamic-home-open-object.ts` (#7335's define and own-property arms)
still recognizes only the `{}` spelling. A `new Object()` var with
`Object.defineProperty(o, …)` or `o.hasOwnProperty(k)` stays legacy, refused
at select. No measured file needs it.

### Deviation: two consumer gaps refused at select

`var o = {}` is admitted only while legacy keeps the binding open, and legacy
widens it into a struct as soon as the program stores `o.p = v`. Legacy never
widens a `new Object()` var, so S1 reaches consumers the `{}` spelling reaches
only through an element store (`o["p"] = 1`). Two of these were claimed by the
selector and then withdrawn by from-ast on main. Both are now refused at
select, for both spellings:

| shape | main | now |
|---|---|---|
| `o.p++`, `o.p += 1`, `o["p"]++` on a dynamic script var | from-ast: "compound property/element write on dynamic" | `member-compound-carrier-receiver` (`isPhase1MutableMemberTarget`) |
| `o == null`, `null != o`, `o.p != null` | from-ast: "bare 'null' in non-reference context" | `expr-carrier-loose-null` |

The second refusal asks the shared `nullComparisonFolds(op, "dynamic")`, the
same predicate `tryFoldNullCompare` consults. A strict `o === null` still
folds and is still claimed. `nullComparedOperand` moved from
`select-planned-closure-operands.ts` into `analysis/operand-admissibility.ts`,
next to `nullComparisonFolds`, so both selector arms share it.
`readsScriptVarCarrier` says which operands from-ast reads as the carrier: a
dynamic script var, or a member read off one. A follow-up could lower the
loose case instead (a Null-or-Undefined tag test). It was not done here,
because widening `nullComparisonFolds` also admits it in planned closures,
which would change the JS environment's binaries.

One sibling test row changed: #7335's "parenthesized loose equality"
(`(o) == null` on a `{}` carrier) is now refused by the loose-null arm before
the own-property probe. It is still refused at select and still matches
legacy; only the expected detail changed.

Still open, as planned (#7194): `o == 1` on the carrier is claimed and traps.
This is the same for `{}` on main. No measured file reaches it.

### Measurements

Base: `origin/main` `d9dd218bbf`, exported into the scratchpad. Head: this
branch. Census tool: `scratchpad/os7338/census.mts`, standalone, with
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`.

- Population: the 873-file set plus the seeded 300-file IR-only sample, 1,173
  files.
- Result: **23 gained** (exactly the 23 S1 prototype files), **0 lost**,
  **0 post-claim errors** on both trees, no compile-error difference.
- 298 of the 300 sample files are IR-only on both trees. Routing changed in
  23 files, the gained ones.
- Verdicts (`scripts/run-test262-paths.mts --standalone`, the 23 gained files
  plus the 300-file sample) are identical on both trees: 321 pass, 2 fail. All
  23 gained files pass. The 2 failures are eval tests
  (`language/line-terminators/S7.3_A7_T5.js`, `_T6.js`) that need the QuickJS
  provider, which is not built in this container.
- JS environment (default target), byte-identical: 363 of 363 binaries match.
  The inputs were the 13 playground examples, every third file of the 873,
  the 45 `new Object` files and the 30 sources of
  `tests/issue-7341-new-object-open-carrier.test.ts`.
