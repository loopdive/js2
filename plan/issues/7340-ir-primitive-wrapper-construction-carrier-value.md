---
id: 7340
title: "IR: `new String(x)` / `new Number(x)` / `new Boolean(x)` as a carrier value stored in a script var"
status: in-progress
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-11-12
updated: 2026-11-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7194]
related: [7341, 7295, 7273, 7280, 7335, 7144, 4208, 7106, 7337]
---

# #7340 — IR: primitive wrapper constructions as carrier values

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only": no function and no `<module-init>` falls back to
the direct AST compiler). Census of 2026-11-11 (main `7ce9bc8fbf`; no `src/`
change up to `44774688e1`): 8,591 files compile, 1,505 are IR-only, 7,086 are
blocked.

`new String(x)`, `new Number(x)` and `new Boolean(x)` refuse in
`phase1NewExpression` (`src/ir/select.ts`) as `expr-new-ctor-unknown`: the
three names are neither a local class nor a known extern class. The label is
on 610 blocked files, and 734 blocked files construct a wrapper in the test
body.

The IR already builds the object. `lowerPrimitiveWrapperConstruction`
(`src/ir/from-ast.ts`) calls the native `__new_String` / `__new_Number` /
`__new_Boolean` (#4208 S4). The admission is what is narrow:
`selectorPrimitiveWrapperConstruction` takes a wrapper only as a fresh operand
of a ToPrimitive operator (`+`, the numeric operators, a loose equality
against a number or boolean, unary `+` / `-`), and only with exactly one
argument of the wrapper's own primitive family.

Everything else refuses, in particular the shape the tests use most:

```js
var s = new String("abc");     // 40 of the 55 measured files store the wrapper in a script var
if (s + "d" !== "abcd") { … }
```

#7295 measured the constructor arm on 14 files of a stride-40 ledger and
stopped at 0. That probe kept the result typed `extern:Object`, so every later
use of the var refused. This plan types the stored wrapper as the dynamic
carrier, which the existing dynamic arms already serve.

## Measurements

Base: `origin/main` `44774688e1`, exported with `git archive` into a scratch
tree. Standalone, original harness,
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`. 2026-11-12.

### Population

A stub can only remove the refusals it addresses, so a file can become IR-only
only if every refusal label it carries on main belongs to a stubbed lever or
is a cascade of one (`call-graph-closure`, a user function "not in scope").
That holds for 873 of the 7,086 blocked files. All 873 were compiled; none is
IR-only on the base. The other 6,213 carry at least one label no stub here
touches (the `Object` statics of #7338 / #7339 first: 431 files have `Object`
as their only other label).

### Method

Each candidate construct is admitted without a correct lowering, the file is
recompiled, and it counts as freed when no unit is refused at selection.

- Source rewrites, in memory, into forms the IR already admits: a statement or
  expression IIFE and a function expression become hoisted function
  declarations; `delete o.p` becomes `assert._isSameValue(o, "p")` (operands
  boxed, boolean result); `var o = { k: v }` becomes `var o = {}; o.k = v`.
- Selector stubs in the scratch tree, switched by an environment variable:
  the refusal is skipped and from-ast answers a dynamic `undefined`
  placeholder (`new …`, a function declaration read as a value), skips the
  statement (`for…in`), or skips the declaration (array literal).
- `objlit` also makes legacy keep the test's script-var `{}` an open `$Object`
  (`ctx.objectHashConsumerVars`), which is what the IR's dynamic home needs.
- "strict" below = zero legacy units. The difference to "freed" is a unit the
  selector claimed and from-ast withdrew. `arr` and `forin` are freed only in
  that weaker sense: their stubs cannot lower the uses.

```bash
P=<scratchpad>/plan-next        # scripts/ and data/ of the measuring session
git archive origin/main | tar -x -C $P/tree         # + symlinks node_modules, test262 (read only)
python3 $P/scripts/patch.py $P/tree                  # env-gated stubs; patch2.py, patch3.py, p2bprep.py, p3prep.py add to them
python3 $P/scripts/ub.py $P/data/groups.json         # label groups per blocked file (census 2026-11-11)
python3 $P/scripts/mklist.py 3                       # the 873-file population, 3 shards
ROOT=$P/tree LIST=$P/data/list-$i.txt OUT=$P/data/out-$i.jsonl \
  JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1 \
  node --import tsx $P/scripts/stub.mts              # cwd = $P/tree; pass 1: each stub alone, all, minimal combinations
bash $P/scripts/run2.sh; bash $P/scripts/run3.sh     # pass 2 (new Object, new F, arrays), pass 3 (closures)
python3 $P/scripts/final.py [--strict]               # the table below
python3 $P/scripts/residfinal.py                     # what still blocks after every stub
```

### Yield of every candidate

Label count = blocked files carrying the lever's refusal label. Construct =
blocked files whose test body contains it (AST scan of all 7,086). The last
column adds the stubs in the order that frees most at each step.

| stub | label count | files with the construct | freed alone (strict) | in some minimal combination | cumulative, greedy order |
|---|---|---|---|---|---|
| `new String/Number/Boolean` (**this issue**) | 610 | 734 | **55** (53) | 65 | 55 |
| `new Object(…)` (#7341) | 132 | 146 | **45** (34) | 50 | 102 |
| array literal in a script var | 646 | 638 | 34 (0) | 40 | 142 |
| IIFE, statement or expression | 645 | 679 | 20 (17) | 20 | 162 |
| `new F()`, `F` a script var or function | 353 | 398 | 15 (14) | 17 | 177 |
| function expression as a value (callback, property value) | 234 | not scanned | 9 (7) | 41 | 189 |
| object literal in a script var | 460 | 2,017 | 7 (7) | 55 | 222 |
| function declaration read as a value | cascade label | 522 | 11 (9) | 36 | 255 |
| `for…in` receiver and module-init head | 368 | 373 | 7 (0) | 9 | 264 |
| `delete o.p` | 224 | 354 | 7 (6) | 8 | 272 |
| `var f = function () {}` as a declaration | 1,234 | 697 | 1 (1) | 2 | 274 |

All eleven stubs together free 274 files. The label counts overstate each
lever by a factor of 3 to over 1,000. Combinations that are needed together:
closure + object literal 25, function value + object literal 19, array +
wrapper 5.

### The 55 files of this lever, by what they need

Classified from the AST of the 55 freed files. S1 and S2 were then built for
real (next section).

| slice | files | constructions in them |
|---|---|---|
| S1: stored in a script var, argument is a literal of the wrapper's own family | 28 | `String` 12, `Number` 9, `Boolean` 7 |
| S2: stored in a script var, any other single argument or none | 11 | `new String(1)`, `new String()`, `new Number("1")`, an identifier |
| S2: ToPrimitive operand with another argument (`new String(1) + 1`) | 3 | |
| S3: operand of `!` or `typeof`, or a call argument | 6 | |
| S4: member read or method call on a fresh wrapper (`new Number(1).hasOwnProperty(…)`) | 7 | all `Number` |

How the 55 use the var that holds the wrapper (files): `+` 20, `!==` 11,
`typeof` 10, member read 10, `!=` 9, a condition 9, element read 7, `++` / `--`
8, `===` 3, `void` 2, call argument 1, member store 1.

### Prototype: S1 and S2 built for real

The stub proves routing only. To check the lowering and the run-time answers,
S1 and S2 were prototyped on a second clean export of main (116 added lines in
`select.ts` and `from-ast.ts`, kept as `$P/data/prototype.diff`; scratch
quality, not the structure planned below). Scope: the construction is the
whole initializer of, or the right side of a plain `=` to, a script var on
the dynamic home.

| step | wrapper files IR-only | pass (`run-test262-paths.mts --standalone`) |
|---|---|---|
| S1 as planned | 26 of 28 | 25 of 26 |
| S1 + the loose-equality rule of #7194 (below) | 26 | 26 of 26 |
| S1 + S2 | **37** | 37 of 37 |

- The two S1 files not gained (`expressions/void/S11.4.2_A4_T{1,2}`) are
  claimed and then withdrawn by an existing from-ast gap ("undefined-compare
  on f64 not in IR scope"). Not this lever.
- A seeded sample of 300 files that are IR-only on main stays IR-only (300 of
  300, 0 post-claim errors) and passes exactly as on main (298 / 298; the two
  others fail on both sides on the eval engine of the measuring box).

### The defect the prototype found: loose equality on a carrier

`built-ins/String/S15.5.2.1_A1_T3.js` (`__str = new String(""); __str == ""`)
is claimed and then fails. Probes on the prototype:

- `var s = new String("a"); s == "a"` answers `false`;
- `var n = new Number(0); n == 0` traps (`illegal cast in __str_to_number`,
  via `__extern_loose_eq`).

This is #7194 (carrier loose equality skips ToPrimitive on an object
operand), and it is not specific to wrappers. On main today, with no change:

```js
var o = {};
if (o == 1) throw new Test262Error("x");   // <module-init> is IR-claimed; RuntimeError: illegal cast
```

The prototype applied `__to_primitive(carrier, default)` to the carrier
operand of a loose equality whose other operand is a concrete primitive
(`tryLowerDynamicEq`). With that, the three wrapper probes, the three `{}`
probes (`o == 1`, `o == "[object Object]"`, `o == true`) and the test file
pass. Two wrappers compared with each other keep identity (`s == t` is false,
`s == s` true), because both operands are carriers and no ToPrimitive runs.

## Implementation Plan

### Mechanism

A wrapper construction outside a ToPrimitive operand is a **carrier value**:
the object `__new_<Kind>` returns, boxed untagged onto the dynamic carrier,
exactly as #7280 boxes the open `$Object` of `var o = {}`. Stored in a script
var on the dynamic home, every later use reads it through the dynamic arms
that serve any carrier. No new IR node, no new runtime function.

The three constructors are three rows of one table. A row is its name, its
own primitive family, its native constructor, the value of a missing
argument, and the carrier conversion for an argument of another family:

| row | own family | native | no argument | other argument |
|---|---|---|---|---|
| `String` | string | `__new_String(externref)` | `""` | `dyn.to_string` |
| `Number` | number | `__new_Number(f64)` | `+0` | `dyn.to_number` |
| `Boolean` | boolean | `__new_Boolean(f64)` | `false` | `dyn.truthy` |

No row has a branch the others lack.

### Result typing: one answer per position, the same on both sides

The last review failed a change on a selector that typed a result differently
from the builder. Here the position decides the type, and both sides ask the
same exported function for the position.

| position of `new W(a)` | admitted | selector's family | from-ast's value |
|---|---|---|---|
| operand of a ToPrimitive operator (today's arm) | unchanged, argument rule widened in S2 | `dynamic` | `extern:Object`, then `__to_primitive`, boxed |
| whole initializer of, or right side of a plain `=` to, an identifier that resolves to a script var on the dynamic home | S1 | the binding's, `dynamic` | the wrapper boxed with `emitBox(…, irDynamic())` |
| operand of `!` / `typeof`, argument of a call whose parameter is dynamic | S3 | `dynamic` | the same box |
| anything else | refused | | |

- The position is `wrapperConsumer(expr)`: syntax only, on the outermost
  parenthesized form. The store target is resolved by each side through the
  one module-binding resolver (`valueKind.kind === "dynamic"` in the selector
  is `type.kind === "dynamic"` in from-ast: the same fact, mapped by
  `resolveModuleBindingGlobal`, as #7287's review established).
- from-ast boxes because the position says so, not because a hint happened to
  be `dynamic`.

### Module placement

- **`src/ir/wrapper-construction.ts` (new)** owns the lever:
  - the table;
  - `wrapperConstruction(expr, isAmbient)`: is this `new` an ambient wrapper
    construction, with which row and which argument;
  - `wrapperConsumer(expr)`: the position;
  - `emitWrapperConstruction(builder, row, argument)`: conversion, native
    call, result `extern:Object`;
  - `emitToPrimitive(builder, value, hint)`: the `__to_primitive` call, for a
    fresh wrapper operand, the unary numeric route and #7194's rule.
- **`src/ir/analysis/operand-admissibility.ts`** gets the one new operand
  rule, `wrapperArgumentAdmissible(row, family)`: no argument, the row's own
  family, or a family `boxableIntoDynamic` accepts. The selector calls it over
  the family it proves, from-ast over the family it lowered (#7144's
  contract).
- **`src/ir/select.ts`**: one hook in `phase1NewExpression` and the existing
  wrapper hooks in the binary and unary arms, all asking the module.
- **`src/ir/from-ast.ts`**: one hook in `lowerNewExpression`, and
  `lowerBinary`'s existing wrapper operand calling the module.
- **`src/ir/integration.ts`**: nothing. The three natives are already
  registered when a body names them.

### What it reuses

- `__new_String` / `__new_Number` / `__new_Boolean` and `__to_primitive`
  (registered in `integration.ts` for #4208 S4).
- `emitDynToString`, `emitDynToNumber`, `emitDynTruthy`, `boxConcreteToDynamic`
  and `boxableIntoDynamic` for an argument of another family.
- The dynamic module home (`scriptVarHome`, #7132) and its store
  (`boxForDynamicModuleStorage`, `lowerIdentifierAssignment`).
- Every dynamic arm that reads a carrier binding. None is added.
- The capabilities `primitive-wrapper-to-primitive` and
  `native-dynamic-member-read` (`src/ir/backend/legality.ts`).

### Duplicates it removes

1. **Three recognizers of "ambient wrapper constructor"**:
   `selectorSeesAmbientWrapperConstructor` with
   `selectorPrimitiveWrapperConstruction` (`select.ts`),
   `primitiveWrapperConstructorName` (`from-ast.ts`), and the inline test in
   the call-graph `new` arm (`select.ts`, `buildLocalCallGraph`). All three
   become calls of `wrapperConstruction`.
2. **The lowering in the god-file.** `lowerPrimitiveWrapperConstruction` and
   `freshWrapperToDynamic` leave `from-ast.ts` for the module.
3. **Two inline spellings of the `__to_primitive` call** (hint constant, call,
   null check): `freshWrapperToDynamic` and the OrdinaryToPrimitive operand
   route of the unary numeric lowering (`from-ast.ts`, near line 14387). Both
   call the module's one emitter and keep their own continuation (the box,
   `__unbox_number`).

### Slices

Every slice is gated on the 873-file set and the 1,505 files that are IR-only
on main: the stated gain, **0 lost**, **0 post-claim errors on a gained
file**, **0 gc binary changes**, and unchanged pass / fail on every file whose
unit routing changed.

**S0: #7194 first.** Listed as `depends_on`. This issue does not re-plan it.
Input from the prototype for whoever takes it: the from-ast rule above (one
carrier operand, the other a concrete primitive) fixes the measured cases
without touching `__extern_loose_eq`, so it changes no JS-environment binary.
Two carrier operands stay as they are. If #7194 is not on main when S1 is
ready, S1 lands with the store refused for a var that has a loose-equality
use (`expr-new-wrapper-loose-equality`). That costs the files whose var is
compared with `==` / `!=` (9 of the 55 use `!=`).

**S1: the module, the store position, own-family argument. Gain: 26 files
(prototype, 26 of 26 pass).**

- Create the module and move duplicates 1 to 3 into it in this slice, not
  after it. The existing ToPrimitive-operand behaviour must not change (its
  tests are `tests/issue-4208-wrapper-loose-equality-ir.test.ts`,
  `tests/issue-4208-ordinary-to-primitive-ir.test.ts` and
  `tests/issue-7144-operand-admissibility.test.ts`).
- Admit a construction whose `wrapperConsumer` is the dynamic-home store and
  whose argument is of the row's own family.
- The call-graph `new` arm treats the admitted construction as a lowering,
  not a call edge.

**S2: any single argument, or none. Gain: +11 (37, prototype, 37 of 37
pass); +3 more expected in the ToPrimitive-operand position (stub).**

- `wrapperArgumentAdmissible` replaces the own-family test in both positions.
- Refused: a spread, two or more arguments, `null` / `undefined` /
  `void 0` (the IR has no dynamic `null`, #7287 review B3), and an argument
  the carrier cannot box (an object literal, an array, a function).

**S3: `!`, `typeof` and a dynamic call argument. Expected gain: +6 (stub,
not prototyped).**

- The construction is evaluated for its effects and boxed; `dyn.truthy` /
  `dyn.typeof` read it. Do not fold `!new Boolean(false)` to a constant
  without evaluating the argument.
- Drop S3 if it needs a consumer arm that does not already read a carrier.

**Not planned: a member read or method call on a fresh wrapper** (7 files,
all `new Number(…).hasOwnProperty(…)` / `.toFixed(…)`). The receiver class
is #7339's ("new-result", measured 0 there).

### Evaluation order

- The argument is evaluated once, then converted, then the native runs.
  `dyn.to_string` and `dyn.to_number` run user code for an object in the
  carrier and may throw: that happens at the construction, before the store,
  so a throwing conversion leaves the script var as it was.
- `new String()` is `""` and `new String(undefined)` is `"undefined"`;
  `new Number()` is `+0` and `new Number(undefined)` is `NaN`. The two forms
  are different rows of the argument rule, never merged.
- Each evaluation makes a new object. No hoisting out of a loop, no sharing
  between two constructions with equal arguments.
- A loose equality evaluates both operands, then ToPrimitives the carrier
  operand, then compares (§7.2.14 steps 10 to 12). That is #7194's.
- `String` must be the realm's: `isAmbientStringBinding` for `String`,
  `isAmbientBinding` for the other two, as today.

### Refusal at selection only

The plan function is total; from-ast treats a refused plan as an invariant
violation. Reasons:

- `expr-new-wrapper-position`: no admitted consumer.
- `expr-new-wrapper-argument`: spread, arity, or an argument family the rule
  refuses.
- `expr-new-wrapper-home`: the store target is not a script var on the
  dynamic home.
- `expr-wrapper-to-primitive-target` (existing): the lane lacks
  `primitive-wrapper-to-primitive`.
- `expr-wrapper-equality` (existing): unchanged.

`expr-new-ctor-unknown` no longer names `String`, `Number` or `Boolean`.

### JS environment

The store and S3 positions are admitted only on the raw standalone lane, the
one where #7280's dynamic-home carrier arms run (`irOpenObjectCarrierAvailable`
in `src/codegen/declarations/ir-open-object-binding.ts`).

- Two capabilities are asked by name: `primitive-wrapper-to-primitive` and
  `native-dynamic-member-read`. A String wrapper in a carrier is read through
  the native member read (`.length`, `[i]`), which WASI lacks (#7177).
- The native-first gc lane projects as standalone for some capabilities
  (`legality.ts`), so the two capabilities may not keep it out. S1 must show
  0 changed gc binaries. If they do not suffice, the lane fact is passed as
  its own selection option beside `isOpenObjectBinding`, not inferred from
  that option's presence (#7335 review, finding 5).
- The ToPrimitive-operand position keeps its present gate.
- No host import is added.

### Tests to add

`tests/issue-7340.test.ts`, standalone, each case asserting the result and
that the compile has no legacy unit:

- one row per constructor: `var w = new W(<own literal>)`, then `typeof w`,
  `w + ""` or `w + 1`, `w === w`, `w !== <primitive>`, `if (w)` (a
  `new Boolean(false)` and a `new Number(0)` are truthy);
- `var s = new String("abc"); s.length; s[1]`;
- `var n = new Number(1); n++; n` is the number 2;
- loose equality: `s == "abc"`, `n == 1`, `b == false`, `s != "x"`, two
  wrappers with equal values are not `==`, a wrapper is `==` itself;
- S2: `new String()`, `new String(1)`, `new Number("12")`, `new Number()`,
  `new Boolean(1)`, an argument read from a dynamic script var whose
  `toString` throws (the error surfaces, the target var stays `undefined`);
- a plain `=` store after `var w;`;
- refusals, each asserting the unit stays legacy with the stated reason and
  still passes: two arguments, a spread, `new String(null)`, a construction
  passed to a typed parameter, a shadowed `String`, a `let` binding in a
  function;
- a selector test that fails if a store-position construction is admitted on
  a lane without `native-dynamic-member-read`;
- the existing #4208 / #7144 wrapper rows unchanged.

### Acceptance criteria

Correctness:

- S1 gains the 26 prototype files and S2 the further 11, on the 873-file set.
  A shortfall is explained file by file.
- 0 files lost among the 1,505 files IR-only on main.
- 0 post-claim errors on a gained file.
- Every file whose unit routing changed passes or fails exactly as it does
  legacy-only (`scripts/run-test262-paths.mts --standalone`).
- JS-environment binaries byte-identical on the playground examples and on
  every third file of the 873.
- ES5 is a completed edition: no ES5 row may regress in the merge group.

Code quality:

- One recognizer of an ambient wrapper construction in `src/ir/`, one
  spelling of "ToPrimitive, then box", one table for the three constructors.
- `select.ts` and `from-ast.ts` each end with a net line change ≤ 0.
- The argument rule exists once, in `operand-admissibility.ts`, and both
  sides call it.
- The selector records no decision in a `WeakMap` or `WeakSet` for from-ast
  to read; both call the plan function.
- No loc or func budget grant. `check:dead-exports` clean.

## S1 — implementation notes (2026-11-13, branch `claude/7340-ir-primitive-wrappers`)

S2 and S3 are not started; the issue stays `in-progress`.

### What was built

- **`src/ir/wrapper-construction.ts`** owns the lever. It holds:
  - the three-row table;
  - the one recognizer `ambientWrapperRow` / `wrapperConstruction`;
  - the position, `wrapperConsumer`;
  - the store admission, `wrapperStoreRefusal`;
  - the lowering, `emitWrapperConstruction` / `boxWrapper`;
  - the one `__to_primitive` spelling, `emitToPrimitive`.
- **The argument rule** `wrapperArgumentAdmissible(own, family)` is in
  `analysis/operand-admissibility.ts`. The selector asks it over its proven
  family (`admissibleArgument`); from-ast asks it over the family it lowered.
- **Duplicates removed:**
  - select.ts's recognizer and operand rule now call the module;
  - from-ast's `primitiveWrapperConstructorName` is gone;
  - the lowering's argument conversion and native call moved to the module;
  - the unary numeric route and `freshWrapperToDynamic` share
    `emitToPrimitive`.
- **Sizes:** `select.ts` net 0 lines; `from-ast.ts` net −32. No LOC or
  function-budget grant.
- **The lane is its own selection option.** `dynamicHomeCarrierLane` is set
  in `irOpenObjectSelectionOption` beside `isOpenObjectBinding` (raw
  standalone only, #7335 finding 5), plus the two capabilities by name. The
  JS environment and WASI never admit the store.

### Deviations from the plan, and why

1. **The store also proves the var's uses.** Hard rule: every position a
   wrapper reaches is claimed and correct, or refused at select — never
   claimed and then withdrawn. The plan admitted the store and let every use
   take the dynamic arms. Measured on a 293-cell position matrix (4 rows ×
   73 positions, each against node), several arms withdraw after the claim
   or answer wrong.

   So `everyUseIsServed` refuses the store (`expr-new-wrapper-use`) unless
   every reference to the name, anywhere in the file, is on an allow-list:
   - a store into it;
   - a binary operand, except a loose comparison with `null`;
   - a prefix-operator or `typeof` operand;
   - a condition;
   - a named member read that is not called and whose value is not stored
     into a binding.

   Refused (each pinned in `tests/issue-7340.test.ts`):

   | use | reason |
   |---|---|
   | element read | `s[0]` of a String wrapper answers wrong |
   | `void w` | withdrawn: undefined-compare on f64 |
   | `w == null` | withdrawn: bare null |
   | `switch (w)` | withdrawn: switch discriminant |
   | `var n = w.length` | withdrawn: typed global initializer |
   | a method call, call argument, alias, template | hands the object on |
   | `for…in`, `in`, `instanceof`, `delete` | not served |

2. **The realm check is stricter for the store than for the old operand
   position.** The store requires `isUnshadowedLibBinding` (lib-only, nothing
   in the file declares the name, a parameter included). It also requires that
   no source write of the name exists (`String = f`), and no
   `eval` / `Function` / `with`.

   The ToPrimitive-operand position keeps main's checker-identity test, so no
   unit main lowers is lost. Main's operand path accepts a script's
   `function String` (the checker reports lib declarations only); that
   pre-existing gap is noted, not changed.
3. **Yield.** The 28 S1 files of the plan gain 19, not 26:
   - 7 `built-ins/String/15.5.5.5.2-*` files read `s[i]`. The element read is
     refused (wrong answer, above).
   - `void/S11.4.2_A4_T{1,2}` are refused (`void`). The plan also did not gain
     these two.
4. **No `expr-new-wrapper-position` arm.** The selector applies the lever only
   to a construction in store position (`storedWrapperConstruction`). Any
   other construction keeps main's arm, e.g. `expr-new-ctor-unknown` for an
   operand `new String()`. `tests/issue-7106-lever-sr.test.ts` pins that arm.
   A first cut refused those as `expr-new-wrapper-position`. They were still
   refused, but the arm name changed, and that test caught it.

### Measured (standalone unless named; base `origin/main` `64752e92aa`, 2026-11-13)

- **The 873-file population:**
  - 19 files become IR-only, 0 are lost, and there are 0 post-claim errors.
  - 20 files changed unit routing: the 19, plus 1 that gains a unit but not
    the whole file. All 20 pass on both trees
    (`run-test262-paths.mts --standalone`).
  - The 19:
    - `built-ins/String/S15.5.2.1_A1_T3`;
    - `grouping/S11.1.6_A3_T{1,2}`;
    - the eight postfix/prefix increment and decrement `A3_T{1,2}` files;
    - `statements/for/12.6.3_2-3-a-ii-{2,4,5,6,7,8,9,10}`.
- **IR-only on main:** a seeded sample of 500 of the 1,505 files
  (census 2026-11-11). Routing is identical, 497 IR-only on both trees, none
  lost.
- **Wrapper-free inputs:** unit routing is identical in all of them, 786 from
  the population and 431 of the sample.
- **Unrelated wrapper:** 150 wrapper-free files with an appended never-called
  `function __unrelated7340() { var q = new Number(1); return q; }`. Routing
  of every original unit equals main's.
- **JS environment (default target):** every third population file (291) is
  byte-identical.
- **Position matrix:** 4 rows × up to 73 positions = 293 cells, each against
  node.
  - On main, 0 are IR-claimed. On the branch, 133 are claimed and all 133
    pass, with 0 post-claim errors.
  - Claimed positions: arithmetic, relational and bitwise operands; `+`;
    `===` / `!==` / `==` / `!=` against a primitive, `undefined`, itself or
    another wrapper; unary `-` / `+`; `if (w)`; `typeof` / `.length` /
    `.constructor` / `.toString` / `.valueOf` reads compared strictly; a
    member store then read; `w++` / `w--` then compare; a top-level function
    reading the var; reassignment.
  - Every other position is refused at select.
  - 2 cells fail, `new String` under `switch`. They are legacy on both trees
    and fail on main too.

### Fold after #7212/#7214

- #7212's `producesCarrier` / `lowersToCarrier` and #7214's
  `emitOpenCarrierObject` / `admittedOpenCarrierHome` answer "is this a
  carrier value / home" for objects. `wrapperConsumer` +
  `wrapperStoreRefusal`'s home test are the wrapper's version: fold them into
  that definition once both land.
- #7214's refusals `expr-carrier-loose-null` and `switch-disc-carrier`, and
  its void rule, are the general form of this module's `isLooseNullTest`,
  `switch` and `void` exclusions. Once they refuse at select for any carrier,
  those exclusions become redundant and should go.

## Risks and unverified assumptions

- **gc byte-identity was not measured.** The prototype has no lane gate. See
  "JS environment".
- **Dynamic arms over a wrapper value.** The 37 prototype files pass, but they
  exercise only the arms those tests use. Not run on a wrapper: a relational
  compare, a compound assignment other than `++` / `--`, `in`, `for…in`, a
  member store, `instanceof`, passing the var to a legacy function. The test
  list above covers the first group; any arm that answers wrongly for a
  wrapper is fixed in its provider or the store is refused for a var with that
  use.
- **Inherited members.** `w.toString`, `w.valueOf`, `w.constructor` read
  through the dynamic member read answer `undefined` (#7304, #7177). Legacy
  types the var as the wrapper and answers correctly. No gained file reads
  one. If the A/B finds one, refuse the store for a var with a read of a key
  `%Object.prototype%` or the wrapper's prototype owns.
- **S3 and the three ToPrimitive-operand files of S2 are stub numbers.** Their
  from-ast side ran only with a placeholder.
- **Mixed files.** A legacy function that reads the var sees the object the IR
  built. It is the object legacy's own `__new_<Kind>` call builds, so the
  representation is the same; no mixed file was run.
- **#7337 (PRs #7199 / #7208, open)** changes how heterogeneous mutable
  binding values are preserved. A var first holding a wrapper and later a
  primitive (`n++`) goes through that code. Re-run the 37 after it lands.
- **Census age.** Labels are from main `7ce9bc8fbf`; `src/` is unchanged up to
  the base `44774688e1`. Main has moved since: #7209 and #7210 (merged
  2026-11-12) change `select.ts` for compound assignments on dynamic script
  vars and for local write identity. Eight gained files use `++` / `--` on the
  wrapper var. Re-run the 37 on the current main before starting.

## Not covered

- `new Object(…)`: #7341, which reuses this module for `new Object(<primitive>)`.
- A wrapper as a receiver of a method call, `instanceof`, and wrapper identity
  comparison of two fresh constructions (`expr-wrapper-equality`).
- The two-carrier case of #7194.
- Arrays, IIFEs, closures and object literals in script vars: measured above,
  each below 35 files alone.
