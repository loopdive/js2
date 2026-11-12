---
id: 7339
title: "IR: `x.hasOwnProperty(k)` / `x.propertyIsEnumerable(k)` on any dynamic module binding, as rows of the object-statics table"
status: ready
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
depends_on: [7338]
related: [7335, 7280, 7128, 7190, 7106]
---

# #7339 — IR: own-property method calls on dynamic module bindings

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only": no function or module-init falls back to the
direct AST compiler). Census of 2026-11-11 (main `7ce9bc8fbf`): 8,591 files
compile, 1,505 are IR-only. #7338 S1+S2 adds 38.

`x.hasOwnProperty(k)` on a script `var` is the fourth most frequent refusal
label: `expr-module-scalar-method(.hasOwnProperty)`, 702 files on main, about
709 on the #7338 head. 1,036 blocked files contain an own-property call in the
test body.

### Why the call refuses today (`src/ir/select.ts`, member-call arm)

The lowering exists: `dyn.own_property` calls the native `__hasOwnProperty` /
`__propertyIsEnumerable` (#7106 S1g). Only the admission is narrow.
`admitDynamicHomeOwnPropertyCall` (#7335, `src/ir/dynamic-home-open-object.ts`)
admits the call when the receiver is an identifier naming a script
`var o = {}` whose **every** reference passes an allow-list (`isServedUse`).
The list has no entry for:

- an operand of `Object.getOwnPropertyDescriptor(o, k)` or of a
  `defineProperty` whose descriptor is not a literal (#7338 did not widen the
  list, see its "Differences from the plan" item 6);
- any receiver that is not `var o = {}`: the result of `Object.create(…)` or
  `Object.getOwnPropertyDescriptor(…)` held in a script var
  (`desc.hasOwnProperty("value")`), a built-in constructor
  (`Number.hasOwnProperty("MAX_VALUE")`).

Everything else falls to `expressionTouchesScalarModuleBinding` and is refused
as `expr-module-scalar-method`.

The allow-list exists for one reason: the native test ignores an own
`hasOwnProperty` a program installed, so the call is only correct when no
object can carry one. #7335 proves that per binding. This issue proves it per
file, which covers every receiver at once.

## Measurements

Base: the #7338 head `0ee4c49855` (main `44774688e1` merged in), extracted
with `git archive` into a scratch tree. Standalone, original harness,
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`. 2026-11-12.

Population: all 1,392 blocked files (main census) whose test body has an
own-property call (1,036) or that carry
`vardecl-module-storage-unrepresentable[object-literal]` (402). Not a sample.
None of them is IR-only on the base.

Method (stub): the construct is rewritten in memory on the assembled source
into a form the IR already admits, the file is recompiled, and it counts as
gained only with zero legacy units.

- `own`: `R.hasOwnProperty(K)` / `R.propertyIsEnumerable(K)` becomes
  `(assert._isSameValue(R, K) === true)`: both operands cross as boxed dynamic
  values, the result is a boolean. That is what `dyn.own_property` does.
- `lit`: a top-level `var o = { k: v, … }` in the test body becomes
  `var o = {}; o.k = v; …`.

```bash
# scratch tree: git archive 0ee4c49855 src tests scripts package.json tsconfig.json | tar x
#               + symlinks node_modules, test262 (read only)
python3 mklist.py                                  # population, 3 shards, seed 7341
ROOT=$TREE LIST=list-$i.txt OUT=out-$i.jsonl \
  JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1 \
  node --import tsx hop.mts                        # cwd = $TREE, i = 0..2
python3 agg.py                                     # yield, receiver classes, set cover
ROOT=$TREE LIST=gained-own.txt OUT=uses-gained.jsonl node --import tsx uses.mts
python3 screens.py uses-gained.jsonl               # cost of the trust screens
```

### Yield: label count against files gained

| lever | label count (files) | files with the construct | files that become IR-only |
|---|---|---|---|
| own-property method call (`own`) | 702 | 1,036 | **68** (6.6 %) |
| object literal in a script var (`lit`) | 402 | 420 | 46 |
| both stubs in one file | | 74 | 0 beyond the two above |
| `harness:propertyHelper.js` (#7190) | 673 | | not stubbed; 0 sole in the 968 below |
| `expr-ident-not-in-scope(Function)` | 997 | | not stubbed; 899 of the 997 include propertyHelper |

The label overstates this lever tenfold. The two stubs are disjoint: 114 files
in total. No stub compile failed and none hit a post-claim error.

A first run with a stub that answered a dynamic value instead of a boolean
gained 0 and produced post-claim errors (`arg 0 of call to assert is dynamic,
expected i32`). The result type is part of the measurement.

### The 68, by receiver

Every one of the 68 calls `hasOwnProperty` with a string-literal key, at the
top level of the script.

| receiver | files gained | files with that receiver |
|---|---|---|
| script `var o = {}` | 38 | 414 |
| script var holding `Object.create(…)` | 12 | 184 |
| script var holding `Object.getOwnPropertyDescriptor(…)` | 8 | 86 |
| built-in global (`Number` 6, `String`, `Error`, `Object`) | 9 | 35 |
| member expression (`a.b`) | 1 | 97 |
| script array | 0 | 76 |
| `propertyIsEnumerable` (any receiver) | 0 | 36 |
| call inside a function | 0 | 4 |

How the 67 receiver bindings are otherwise used (why #7335's allow-list
refuses them): operand of `Object.defineProperty` 37, of
`Object.getOwnPropertyDescriptor` 25, member read 45, member store 8.

### What still blocks the other 968 files after the stub

By file count; `sole` = the only reason left. The last column is a greedy set
cover: files freed when that reason is removed after the ones above it. It is
read from labels, so it is an upper bound for each step.

| files | sole | reason | owner | freed at that step |
|---|---|---|---|---|
| 535 | 80 | `expr-object-static-descriptor` (accessor or non-literal descriptor) | #7338 S3/S4 | 80 |
| 246 | 0 | `vardecl-let-closure` (`var f = function () {…}`) | separate | 57 |
| 136 | 22 | `delete o.p` as a statement | separate | 60 |
| 92 | 39 | `forin-receiver-not-dynamic-externref` | separate | 55 |
| 82 | 0 | `expr-new-module-binding-callee` (`new Con()`) | separate | 42 |
| 86 | 21 | `expr-object-static-operand` (array, function or struct operand) | #7338 S3 | 27 |
| 46 | 1 | `vardecl-module-storage-unrepresentable[object-literal]` | separate (below) | 25 |
| 50 | 0 | `vardecl-module-storage-unrepresentable[empty-array]` | separate | 23 |
| 31 | 23 | `delete o.p` in value position | with the delete lever | 23 |
| 104 | 1 | `expr-ident-not-in-scope(Function)` | #7190 | |
| 97 | 0 | `harness:propertyHelper.js` | #7190 | |

Reasons per still-blocked file: one 289, two 266, three 248, four 105, five or
more 60.

### Related levers: same issue or not

- **Object literal in a script var: separate.** The stub gains 46, all with
  constant values, 44 of them in `built-ins/Object/getOwnPropertyDescriptor`.
  But the stub overstates it: legacy decides the storage of a script var, and
  it widens `var o = {}; o.p = 1` into a closed struct, which the IR then
  refuses (`objectlit-empty`, 301 files after the stub). The real lever is
  agreeing with legacy on that storage, a different mechanism from this one.
  File it on its own and measure with a stub that models the struct.
- **propertyHelper harness: separate, #7190** (in progress, another owner). It
  is never the sole blocker here.
- **`Function` global: not a lever of its own.** 899 of its 997 files get the
  label from the propertyHelper include, so it resolves with #7190. The other
  98 use `Function.prototype.<m>` in the test body (27 sole).

## Implementation Plan

### Mechanism

`hasOwnProperty` and `propertyIsEnumerable` become two rows of #7338's table in
`src/ir/object-statics.ts`. A row of this kind is spelled
`<receiver>.<name>(key)` instead of `Object.<name>(…)`; the receiver is its
first operand. Everything else is the table's: operands cross as carriers,
the first operand is tested at run time, one native call, refusal at
selection.

| row | spelling | operands | first operand | answer |
|---|---|---|---|---|
| `hasOwnProperty` | `R.hasOwnProperty(k)` | receiver, key | coercible (not `undefined` / `null`) | boolean, `dyn.own_property` |
| `propertyIsEnumerable` | `R.propertyIsEnumerable(k)` | receiver, key | coercible | boolean, `dyn.own_property` |

The two rows differ only by name. No row gets a branch the other lacks.

The per-binding allow-list is replaced by one fact about the source,
`ownPropertyTestsArePristine(file)`: no object in the program can carry a
member named like the row other than the realm's own. It holds when all of:

1. The method name appears only as the name of a plain member read (today's
   `methodIsOnlyRead`: no string literal, no object-literal key, no store,
   delete or define of it).
2. No member is installed under a name the source does not spell: no store
   through `x[e]` and no `Object.defineProperty(x, e, …)` where `e` is not a
   constant (a string or number literal, a signed number, `true`, `false`,
   `null`, the global `undefined` / `NaN` / `Infinity`).
3. `Object.prototype` is not patched (`sourceMayPatchPrototype(file, "Object")`),
   there is no reflective route (`sourceNamesReflectiveRoute`), and no dynamic
   code may run (the realm's `dynamicCodeMayRun`).
4. No object without `%Object.prototype%` on its chain and no exotic receiver
   can exist: the source does not name `Proxy`, `JSON` or `fromEntries`, and
   every `Object.create` has an object literal, `X.prototype`, a `new`
   expression or a function as its first operand.

Item 2 is what the allow-list existed for (`g(o, "has" + "Own…")` needs a
computed store somewhere in the source). Item 4 is a deny-list, which is
acceptable here because the set of built-ins that create keys from data is
fixed and standalone has no host objects.

Measured cost of the fact: all 68 gained files pass it, and all 41 files that
are IR-only today with an own-property call pass it (so none is lost when the
allow-list goes). With "literal" instead of "constant" in item 2, 11 of the 68
fail (`Object.defineProperty(obj, undefined, {})` and siblings).

### Module placement

- **Selection**: `src/ir/object-statics.ts` owns the two rows and matches
  both spellings in `objectStaticCallPlan`. The fact lives in
  `src/ir/object-integrity.ts` beside `objectStaticsArePristine`, computed in
  the same `sourceIntegrityFacts` walk (one scan of the source, not two).
  `select.ts` keeps its one hook for the table.
- **Lowering**: `emitObjectStaticCall` in `src/ir/open-object-carrier.ts`
  answers a test row with `builder.emitDynOwnProperty` after the row's
  first-operand guard. `from-ast.ts` keeps its one hook
  (`tryLowerObjectStaticCall`).
- **Integration**: nothing new. `dyn.own_property` and its two providers are
  already registered (`integration.ts`, `emitOwnPropertyTest`).

### What it reuses

- The table, `objectStaticCallPlan`, `ObjectStaticCall`, and the refusal
  codes `expr-object-static-<shape|arity|untrusted>` and
  `expr-object-static-operand`.
- `lowerCarrierOperand` for both operands, `emitThrowTypeErrorIfNullish` for
  the receiver, `dyn.own_property` for the call. No new IR node, no new
  runtime code, no host import.
- `sourceIntegrityFacts`, `sourceMayPatchPrototype`,
  `sourceNamesReflectiveRoute`, `sourceWritesMemberNamed`.
- The capability `native-own-property-test`, which #7335's arm already asks.

### Duplicates it removes

1. **#7335's own-property arm.** `ownPropertyMethod`, `isReference`,
   `everyUseIsServed`, `isServedUse`, `ownPropertyCallMethod` and
   `methodIsOnlyRead` in `dynamic-home-open-object.ts` have no other user
   after #7338 and are deleted (about 150 of its 197 lines).
   `writerKnowsItsStrictness` is the one export that stays.
2. **The selector's side channel.** `admittedOwnPropertyCalls`,
   `admitDynamicHomeOwnPropertyCall`, `dynamicHomeOwnPropertyMethod`,
   `admittedOwnPropertyCallMethod` and `DYNAMIC_HOME_QUERY` in `select.ts`,
   and `lowerOwnPropertyMethodCall` in `from-ast.ts`. The selector records a
   decision in a `WeakMap` for from-ast to read; both now read the plan, the
   #7276 / #7338 pattern.
3. **The uncurried alias's own copy of the row.** `UNCURRIED` and
   `UncurriedObjectAliasMethod` in `uncurried-object-alias.ts`
   (`__hasOwnProperty(o, k)`) read the row's name, arity and capability from
   the table, as `STORED_STATICS` already does for its two `Object` rows. The
   literal union `"hasOwnProperty" | "propertyIsEnumerable"` repeated in
   `builder.ts`, `integration.ts`, `nodes.ts` and `lower-generic.ts` becomes
   one exported type.

### Slices

Both slices are gated on the 1,392-file set plus the 41 IR-only files, with
the same gates as #7338: the stated gain, **0 lost**, **0 post-claim errors**,
**0 gc binary changes**, and unchanged pass/fail on every file whose unit
routing changed.

**S1: the two rows, the fact, receiver = a value already on the dynamic
carrier. Expected gain: 58 files.**

- Receiver: an identifier resolving to a dynamic module binding or a dynamic
  parameter, or a table call's result. That is the operand predicate
  `isPhase1ObjectStatic` already applies, without the "boxable concrete" arm:
  a receiver the IR types as an array, a string, a number or a struct is
  refused as `expr-object-static-operand`.
- Key: any Phase-1 value, crossed as a carrier.
- Exactly one argument, no spread, no optional chain.
- Delete duplicates 1, 2 and 3 in this slice, not after it.
- Covers script `var o = {}` (38), `Object.create` results (12) and
  `Object.getOwnPropertyDescriptor` results (8).

**S2: built-in constructors as receivers. Expected gain: +9 (67).**

- `Number.hasOwnProperty("MAX_VALUE")` and siblings: the receiver is an
  ambient constructor read as a value.
- Before admitting, verify per constructor that `__hasOwnProperty` answers
  for that built-in's own properties as legacy's by-name lowering does
  (`call-receiver-method.ts`, the `hasOwnProperty` arm). A constructor whose
  answer differs stays refused.
- If the receiver cannot cross as a carrier without new code, drop S2 and
  record why. It is 9 files.

Not planned, because the stub gains nothing there: array receivers (76 files),
`propertyIsEnumerable`-only work beyond the shared row (36 files), calls
inside functions (4 files), `new X()` receivers. The one member-expression
file is not worth an arm.

### Evaluation order

- `R.hasOwnProperty(k)` reads the method from `R` before it evaluates `k`, so
  a nullish receiver throws before the key runs. Order: lower the receiver,
  emit the nullish guard, lower the key, call. The statics evaluate every
  operand before their guard. The row states which (`guard: "after-first"`
  against `"after-operands"`), and `emitObjectStaticCall` takes operand
  thunks, as it already takes definition thunks.
- The native applies ToPropertyKey to the key, then tests the receiver, the
  spec's order (§20.1.3.2 steps 1 and 2).
- The guard is not optional: the natives answer `false` for a nullish
  receiver (`src/codegen/object-proto-has-own-property.ts`), and a script var
  on the dynamic slot can be `undefined`.

### Refusal at selection only

The plan is total. Reasons: `expr-object-static-shape` (spread, optional
chain), `-arity` (not one argument), `-untrusted` (the fact fails or dynamic
code may run), `expr-object-static-operand` (the receiver or key is no
carrier). from-ast treats a refused plan as an invariant violation, as it
does for the statics. `expr-module-scalar-method(.hasOwnProperty)` and
`expr-array-method-not-lowerable(.hasOwnProperty)` no longer occur; other
methods keep both labels.

### JS environment

The rows are admitted only with `native-own-property-test`, which a JS
environment does not have. There the plan answers `undefined` for the method
spelling and the existing arms run unchanged. No host import is added.

### Tests to add

`tests/issue-7339.test.ts`, standalone, each case asserting both the result
and that the compile has no legacy unit:

- `var o = {}; Object.defineProperty(o, "p", { value: 1 });` then
  `Object.getOwnPropertyDescriptor(o, "p")` and `o.hasOwnProperty("p")`
  (the allow-list refused this);
- `var d = Object.getOwnPropertyDescriptor(o, "p"); d.hasOwnProperty("value")`;
- `var n = Object.create({}, { p: { value: 1 } }); n.hasOwnProperty("p")`;
- `propertyIsEnumerable` true and false on the same shapes;
- an inherited key answers `false`;
- `var u; u.hasOwnProperty(f())` throws a TypeError and `f` does not run;
- refusals, each asserting the unit stays legacy with the stated code and
  still passes: a source that stores `o.hasOwnProperty = f`; one with
  `x[k] = v` for a non-constant `k`; one with `"hasOwnProperty"` as a string;
  an array receiver; two arguments;
- a selector test that fails if an own-property call is admitted while the
  fact is false.

### Acceptance criteria

Correctness:

- S1 gains at least 50 of the 58 predicted files on the 1,392-file set
  (#7338's stub predicted 59 and the real change gained 38 with 33 in common,
  so a shortfall is explained file by file, not waved through); S2 its 9 or
  a recorded reason.
- 0 files lost among the 41 IR-only files with an own-property call and on a
  seeded 300-file sample of the whole ES5 set.
- 0 post-claim errors on the set.
- Every file whose unit routing changed passes or fails exactly as it does
  legacy-only (`scripts/run-test262-paths.mts --standalone`).
- JS-environment binaries byte-identical on the playground examples and every
  third file of the set.
- ES5 is a completed edition: no ES5 row may regress in the merge group.

Code quality:

- `select.ts` and `from-ast.ts` each hold one hook for the table and end with
  a net line change ≤ 0.
- `dynamic-home-open-object.ts` loses its own-property arm entirely; no
  export of it is left unreferenced (`check:dead-exports`).
- One definition of the two method names in `src/ir/`.
- The fact is computed in the existing `sourceIntegrityFacts` walk; no second
  walk of the source for the same question.
- No loc or func budget grant.

## Risks and unverified assumptions

- **The stub is an estimate.** It crosses operands through a function-object
  member call and compares the answer with `true`. It does not run the trust
  fact; that was checked separately on the test bodies (68 of 68 pass), not on
  the assembled source. The default harness has no computed store, but the
  fact must be confirmed on assembled sources in S1.
- **propertyHelper will fail item 2** (`obj[name] = newValue` in
  `isWritable`). No gained file includes it, and its includers are blocked by
  #7190 anyway. When #7190 lands, item 2 needs a per-function refinement or
  those files stay refused here.
- **`__hasOwnProperty` on non-`$Object` receivers** (a descriptor object
  returned by the runtime, a built-in constructor) is assumed to answer as
  legacy's by-name call does. Legacy calls the same native for the same
  receivers, so a difference would already be a legacy bug, but it was not
  run.
- **Base.** Everything is measured on the #7338 head. On main without #7338
  the gain is smaller, since most gained files also call a table static.

## Not covered

- Object literals, arrays and closures in script vars, `delete`, `for-in`
  receivers, `new` on a script var: their own levers, ranked above.
- The propertyHelper harness and the `Function` label: #7190.
- `Object.prototype.hasOwnProperty.call(o, k)` in a test body.
- A general dynamic method call that looks the method up at run time. It
  would need no proof, but the native member read does not reach an open
  `$Object`'s implicit `%Object.prototype%` (the key screen in
  `isServedUse`; #7304 is the same gap for `in`).
