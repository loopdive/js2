---
id: 7557
title: "Prepared path: built-ins callable through values, `Function` as a realm value, `Function.prototype.call`"
status: done
sprint: current
created: 2026-11-27
updated: 2026-11-28
completed: 2026-11-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7580]
related: [7354, 7352, 7561, 7574, 7580, 7560, 7489, 7562]
assignee: "ttraenkler/ir-lane-a1"
---

# #7557 — Prepared path: built-ins callable through values, `Function`, `Function.prototype.call`

## Problem

Every test262 program that includes `harness/propertyHelper.js` (about 900 ES5 tests) stops at its line 31:

```js
var __join = Function.prototype.call.bind(Array.prototype.join);
```

with `identifier "Function" is not in scope`. On the Prepared path a built-in reached through a value (held in a
variable, stored under another name, or reached by `call`) is the dispatcher's built-in arm, the run-time abort, except
where #7352 / #7580 test `Array.isArray` and the `Object` statics at a call that is detached or names them. `bind` is
the next slice (#7560); after this one the line stops at `bind`.

## Re-build on #7580 (2026-11-27)

Branch `claude/7557-function-call`, base `claude/7580-object-statics` 565b217792. A re-build on the realm model of
#7561 / #7352 / #7574 / #7580, not a port of the old branch below (whose family model is gone).

### Implementation Plan

**One call route for a built-in reached through a value: the realm's built-in caller.** Where the program can create a
source function (so a dispatcher exists) and may hold a callable built-in, module-init lifts one derived function
`(callee, this, args)` and installs its closure in the realm. The dispatcher's built-in arm (today `unreachable`) calls
it with the built-in, the call's `this` and a vector of its arguments. Its body is ONE identity ladder over the
built-ins the realm may hold, each rung the same algorithm a folded call writes. So the identity dispatch is one shared
function body, never inlined per call site (#7580 measured 197 KB / 50 s for that). Without a dispatcher, a call
through a value is the same ladder at the site, then the run-time abort.

| layer | module | change | reuses |
| --- | --- | --- | --- |
| contract | `native-realm-catalog.ts` | `%Function%` as an identity row held with itself (`length`, `name`, `prototype`); `NATIVE_PROTOTYPE_METHODS` (mined from PR 7480): one table of the prototype methods held by name, `Object.prototype`'s P1 methods and `Function.prototype.call`; `%Function%`, `%Function.prototype%` and `call` appended to `NATIVE_VALUE_INTRINSICS` | `identityOnly`, `heldWith`, `realmMethodId` |
| realm holds | `native-realm-requirements.ts` | the positional `METHOD_IDS` becomes the table's ids (a prototype's methods held where a key names one); the Function family (`%Function%` read) | `HELD_FAMILIES` |
| backend | `native-realm.ts`, `native-realm-families.ts`, `native-source-objects.ts` | %Function.prototype% is the bootstrap entry (never a second one); it is seeded with its held members (`call`, `constructor`) by the root's filter, now shared; `js.object.intrinsic` answers it | `familyObjects`' root filter |
| keys | `builtin-prototype-keys.ts` | the `function` family (`Function`), `FUNCTION_CALL_ID`, the Function.prototype keys a function's read may now reach | `REALM_CONSTRUCTORS` |
| caller plumbing | `realm-builtin-caller.ts` (new), `module-init-chunk-lowering.ts`, `closure-invocation-callables.ts` (core, runtime), `native-invocation-requirements.ts`, `native-invocation.ts`, `builtin-caller-bodies.ts` (new), `closure-method-body.ts` | mined from the old branch nearly unchanged: the lifted caller, its install, the argument reads, the dispatcher's built-in arm | F1b's lifted-unit provenance, the dispatcher's method call |
| ladder | `dynamic-builtin-call.ts` (new) | the caller's body: `call` (Call(this, thisArg, …args), count-picked dispatcher call), `Function.prototype` (undefined), then the held built-ins' tests | `builtinMethodChain`, `identityTest` |
| one test list | `dynamic-prototype-methods.ts` | `heldBuiltinTests(call, callee)`: the identity tests of every held built-in a value may be (P1 methods, conversions, `Array.isArray`, the statics), over a `BuiltinCall` (`receiver`, `argument(i)`); the ladder and a dispatcher-less call site use it; the name-gated `reads` arms of `Array.isArray` and #7580 fold into it | P1's / #7352's / #7580's algorithms |
| front end | `realm-static-call.ts`, `source-plain-objects.ts`, `source-dynamic-contracts.ts` | `Function` read as the realm's (`realmReceiverRead`, no second position test); whether the caller exists | `realmReceiverRead`, `programObjects` |
| operations | `dynamic-function-operations.ts`, `dynamic-member-access.ts`, `dynamic-builtin-methods.ts` | `instanceof Function` (a function's chain holds %Function.prototype% but its own), `Function.prototype` read, `call` / `constructor` read through the realm's [[Get]], an own-property query of %Function.prototype% with a key it lacks aborts (review r1); `new` of a held non-constructor throws (review r1, via the catalog's `constructible`) | `functionChainAnswer`, `unlessUnheldOwnKey` |

**Duplicates removed.** The name-gated identity arms of `Array.isArray` (#7352) and the statics (#7580) in
`dynamicPrototypeMethodCall` become the one held-built-in test list; the positional `METHOD_IDS` slice becomes the
table; the root's seeded-member filter serves Function.prototype too.

**Composition with main** (arrives with the re-merged stack): PR 7449 (#7489 slice A, `f.caller`) rewrites
`familyProperties` around `entryOf` (a bootstrap entry named by its behavior) and seeds Function.prototype's entry
from the catalog. The merge touches `native-realm.ts` / `native-realm-families.ts` where this slice seeds
Function.prototype: keep main's `entryOf` form; this slice's filter is the same rule. PR 7533 (`arguments.length`,
#7562) gives a callee its actual count: the caller's `call` rung passes the arguments it read, so the count protocol
applies unchanged at the dispatcher's method call.

**Not in this slice** (each keeps refusing or aborting): `bind`, `apply` (#7560); `Function(…)` / `new Function(…)`
(dynamic code, the eval lane); `Function.prototype.toString`; `arguments` beyond the base; the bodies of
`Array.prototype` methods (`join` / `push` are held values; `Array.prototype.join.call(a)` reaches the method by
identity and aborts).

**Code-quality criterion.** One route (the caller) and one held-built-in test list; no name-gated second arm; no second
position test; the caller's plumbing in its own modules; `src/ir/from-ast.ts` does not grow (17,393); IR→runtime import
edges stay at 10; every new `src/` file in `scripts/compiler-boundaries.json`.

**Acceptance.** Node agreement with wrong twins for the cases of the brief; refusals/aborts for the out-of-scope ones;
never a wrong value, invalid Wasm or exception out of `compile()`; propertyHelper's line 31 stops at `bind`; programs
that hold no callable built-in byte-identical to the base; prelude ≤ +8 KB and ≤ +0.7 s; ordinary pipeline identical.

### Result (2026-11-28)

**The one route.** `dynamicBuiltinCall` (`src/ir/program/dynamic-builtin-call.ts`) is the body of the realm's built-in
caller: the `call` rung, then `heldBuiltinRungs` (`dynamic-prototype-methods.ts`), the one list of identity tests of
every built-in a value may be. The dispatcher's built-in arm (`closure-method-body.ts`, before: `unreachable`) calls it
with the callee, the call's `this` and an argument vector. A method call `o.m(v)` tests the rungs named `m` at its
site; a detached call tests the rungs that read no `this` (`Array.isArray`, the statics) at its site, because only the
site knows its constant arguments (the key a query of the root pins); everything else reaches the caller. The
name-gated arms of `Array.isArray` (#7352) and of the statics (#7580) in `dynamicPrototypeMethodCall` are gone: both
are rows of the list. Without a source function no dispatcher exists and the site tests every rung, then aborts.

**What works** (each agrees with node, with a wrong twin that throws; `tests/issue-7557-function-call.test.ts`):

- `Function`: `typeof`, identity, `Function.prototype` (held, `typeof` "function", called through a value it answers
  `undefined`), `.constructor`, `.length`, `.name`; `instanceof Function` for source functions, closures, held
  built-ins and `Function.prototype` itself (false); writes to `Function.prototype` and the root seen through functions.
- `f.call(thisArg, …args)`: source functions and closures (none, fewer, more arguments than parameters), strict
  callees see `thisArg` as passed, `call` held as a value, `call` of `call`, a function's own `call`, an object's own
  `call` method, a non-callable receiver (TypeError, after the arguments are evaluated).
- Built-ins through `call` and under another name: `Object.prototype.hasOwnProperty.call(o, k)` (any `this`),
  `Object.prototype.toString.call(v)` held as a value, the wrappers' and `Error.prototype`'s conversion methods (their
  TypeError for a wrong receiver), `Array.isArray.call(…)`, a static through `call` or passed on,
  `({ f: Object.defineProperty }).f(o, k, d)`, `o.myValueOf = Number.prototype.valueOf`, `n.isA = Array.isArray`.
- A replaced `Function.prototype.call` (direct, through an alias, a parameter, `defineProperty`) is the program's: the
  call goes by identity. The folded `Object.prototype.toString.call(v)` goes by identity too (`dynamicObjectTag`,
  `throughRealmCall`): it reads `call` through [[Get]] off the method the root holds, or, where no program value is
  that method, off Function.prototype, and answers the tag only where that `call` is the realm's; any other is the
  run-time abort. No source rule decides it.
- `new` of a held built-in without [[Construct]] throws the TypeError (`heldNonConstructors`; review r1).

**What refuses or aborts** (each is a row of the test file):

| case | outcome |
| --- | --- |
| `Function(…)`, `new Function(…)` | refuses (dynamic code, the eval lane) |
| `f.apply`, `f.bind` read off a function; `Function.prototype(…)` by name | refuses |
| `Function.prototype.call.bind(…)` (propertyHelper.js line 31); `Function.prototype.toString` | run-time abort |
| a sloppy callee given `undefined`, `null` or a primitive as `this` | run-time abort (no global object value, no boxing on this base) |
| more than three arguments after `thisArg` | run-time abort |
| `Array.prototype.join.call(a)` (a held value without a body) | run-time abort |
| an own-property query of the root or `Function.prototype` through `call` (its key is not a constant in the caller), or of a key the realm does not seed (`Function.prototype.hasOwnProperty("toString")`) | run-time abort |
| a call through a value in a program without a source function, where the callee is none of the held built-ins (`call` included) | run-time abort |
| `.call` on a local the front end types as a closure (`function run() { var f = function () {}; f.call(o); }`), on a number or string literal, `Function.x = v`, `delete Function.prototype.call`, a computed-key write | refuses (front-end limits of the base, unchanged) |

**Review r1 findings carried.**

- `new` of a built-in: `heldNonConstructors` + `dynamicConstruct`; test "new of a held built-in that has no
  [[Construct]]", P1's "a method as a constructor".
- `Function.prototype`'s own properties: seeded with the function values the realm holds (`heldMemberProperties`); a
  key the realm lacks aborts (`unlessUnheldOwnKey`, `FUNCTION_PROTOTYPE_UNHELD_KEYS`); probes `hasOwnProperty("call")`
  true, `("qq")` false, `("toString")` abort.
- The stale tests: P1's detached calls and its constructor row now assert node; F1 / F1b read `apply` where they read
  `call`; M1 and T2 drop `Function`; #7352's and #7580's "moved under another name" abort rows are node agreements here.

**Cost.** The caller exists only where a source function exists and the realm may hold a callable built-in the program
can call through a value: it names a realm constructor, spells `call`, or spells a held prototype method other than as
the `m` of `x.m(…)` (`ProgramObjects.methodValues`). `js.object.intrinsic` answers `Function.prototype` only where the
realm seeds it. Eight Prepared programs, base → head: seven byte-identical; the `assert.js` + `sta.js` prelude (it
spells `call`) 90,125 → 94,213 B (+4,088), median compile of 3, base and head interleaved at load 4–5: 7.96 s →
8.22 s.

**Measured** (base 565b217792 → head).

- propertyHelper.js's four lines (31–34), each alone: base refuses (`identifier "Function" is not in scope`); head
  compiles and stops at the run-time abort at `bind`; without `bind` the same lines agree with node. The 12
  `Object/defineProperty` tests that include the harness: base all stop at `Function`; head none does (6
  `dyn.publish_argc` (#7562), 2 `null` under an f64 hint, 2 empty-array escapes, 1 `Math.pow`, 1 `JSON`).
- Probes against node in a fresh realm, first session: 93 (49 right with failing twins, 18 refused, 26 aborted). Second
  session (2026-11-28, on the fixed-statics base), 97 new adversarial ones on the final head: 33 right with failing
  twins, 33 refused, 31 aborted, 0 wrong, 0 invalid, 0 exceptions out of `compile()`; one was wrong before the fix
  below.
- test262 (base 49995cc518 → final head): `built-ins/Function/prototype/call/` (47 files) 0 → 9 pass; a 40-file
  sample of `built-ins/Function/` 0 → 0 pass (6 more compile and abort); the 87-row sample 19 → 21 pass. No pass lost; every failure on head is the
  run-time abort.
- Ordinary pipeline: 48 binaries (24 programs, two targets) byte-identical.
- `src/ir/from-ast.ts` 17,393 → 17,388 lines. Source diff: 27 files, +966 / −195. No split.
- Mined from `claude/7354-a1b`: `realm-builtin-caller.ts` (43 lines) and `builtin-caller-bodies.ts` (114) unchanged,
  `dynamic-builtin-call.ts` (101 lines, 25 rewritten); `NATIVE_PROTOTYPE_METHODS` from PR 7480. The rest is new on the
  #7561 method-by-identity model.

**Re-based on the fixed statics (2026-11-28, base 49995cc518).** The base deleted its source rule `replacedStatics`:
the kernel aborts every write to `%Object%` (`NativeRealmIntrinsic.fixed`), so a folded `Object.m(…)` needs no proof.
The merge left no use of a deleted function. This slice's own source rule, `ProgramObjects.replacesCall` (it decided
whether the folded object tag might meet a replaced `call`), had a hole of the kind the base's rule had:

```js
var v = {}, k = "ca";
Object.defineProperty(Object.prototype.toString, k + "ll", { value: function () { return "X"; } });
Object.prototype.toString.call(v); // node: "X"; the fold answered "[object Object]" (also on the base)
```

The rule is deleted; the fold reads `call` by identity (above). `fixed` is not the mechanism for `call`: it fixes a
whole bag, and Function.prototype must stay writable (`Function.prototype.x = 1; f.x`), as must every method's own
properties; the lookup of `call` also passes two objects (the method, then Function.prototype), so one flag cannot
pin it. A read through [[Get]] and one identity test cost less than a per-key flag in three kernel paths, and they
see every route. Two things the change brought out:

- Reading the method off the root in a program that cannot obtain the root made the realm hold
  `Object.prototype.toString` there, and `String({})` then met a built-in the dispatcher cannot call (M2's "D35:
  assert.js's formatSimpleValue" aborted). Where no value is the method, the fold reads Function.prototype's `call`.
- An unread value `if` whose arms only answer or abort was dropped by dead-code elimination, because the abort's
  effect facet is pure: `Function.prototype.call = g; Object.prototype.toString.call(v);` ran on without calling `g`.
  `isSideEffecting` (`src/ir/analysis/effects.ts`) now keeps an instruction whose buffers hold the abort. It applies
  to every legalized chain of the lane, not only this one.

**Not done here.** `bind`, `apply` (#7560). A member access on a closure-typed local (`f.call` inside a function whose
`f` is a local function expression) still refuses in the front end; it stops 2 of the 47 `call` files and is the next
blocker for `call` inside test functions.

## Old branch `claude/7354-a1b` (affccb6fe4): problem, plan, results, review r1

Kept as the record the re-build carries its findings from; its family model is gone.

### Problem

On the Prepared path (`TEST262_COMPILER_PATH=ir`, `--target standalone`) a built-in called through a value reaches
the dispatcher's built-in arm, which is the run-time abort. `propertyHelper.js` binds `Function.prototype.call` to
built-ins in its module-init (`__join`, `__push`, …) and calls `Math.pow`, so every one of the 43 sample rows that
include it stops in module-init.

### Acceptance criteria

- The 43 propertyHelper rows get past module-init.
- `call`, `apply` and `bind` work on the held built-ins and on source functions.
- `Array.prototype.push`, `join` and `toString` work, and an array's ToPrimitive answers where `join` is held.
- The Object statics and `Math.pow` work as values; `getOwnPropertyNames` returns an array.
- Never a wrong value, never invalid Wasm, never an exception out of `compile()`; anything else refuses by name or
  aborts at run time.
- Ordinary-pipeline output stays byte-identical. Prelude cost stays within about 1 s and 15 KB.
- Code quality: one copy of each algorithm (see below), `from-ast.ts` does not grow, and the gates pass with
  `LOC_GATE_BASE=origin/main`.

### Implementation Plan

Built-ins called through values, so propertyHelper.js's module-init runs (A1 plan items 2–4). This is P2 ("V1/P2"
in the P1 notes): the dispatcher's built-in arm stops being the run-time abort.

### What module-init needs (A1 plan's table, items 2–4; to be re-measured on the A1a r2 head first)

- `Function.prototype.call.bind(m)` four times (L31–34): a bound built-in, later called through a script var
  (`__join(a, ",")`, `__push(a, v)`, …).
- `Math.pow(2, 32)` (L35).
- `Object.defineProperty` / `getOwnPropertyDescriptor` / `getOwnPropertyNames` read as values (L28–30), and
  `getOwnPropertyNames`'s result read as an array (`names.length`, `names[i]`).
- `Array.prototype.join` / `push` read as values (L31–32); `join` also gives an array its ToPrimitive.

### Mechanism: one program-side built-in caller

- **The problem.** A built-in called through a value reaches the dispatcher (`closure-method-body.ts`), a runtime
  body. Its algorithm needs the program: ToString / ToNumber / ToPrimitive can call source closures, and P1 / G1 /
  W2 / O1 already wrote those algorithms on the legalization side (`stringOf`, `toNumber`, `dynamic-*-methods.ts`).
- **Chosen.** One IR function `realm-builtin-call(callee, this, args) -> carrier`, synthesized once per program when
  a dispatcher exists and the realm holds a built-in that can be called as a value. `args` is an A1a realm array.
  The dispatcher's built-in arm (today `unreachable` under `builtinRootTypeIdx`) builds that array from its arity
  arguments plus the extras vector and calls the function through a reserved handle.
- **The function is an identity ladder over the held built-ins**, in this order:
  1. a bound function: its target, its bound `this`, and its bound arguments followed by `args`; then again;
  2. `%Function.prototype.call%`: callee = `this`, `this` = `args[0]`, `args` = the rest; then again;
  3. `%Function.prototype.apply%`: the same, with CreateListFromArrayLike(`args[1]`) (an A1a array; any other
     array-like aborts);
  4. `%Function.prototype.bind%`: BoundFunctionCreate;
  5. the held methods: Array.prototype `push` / `join` / `toString`, the Object.prototype methods, Error.prototype
     `toString`, the wrappers' `valueOf` / `toString`, the Object statics, `Math.pow`;
  6. a source closure: the dispatcher's call with that `this` (a bound source function lands here);
  7. anything else: the run-time abort.
  "Then again" is a tail call of the function itself. A bound chain is finite, so it terminates.
- **Rejected: the ladder as a runtime body with callbacks into the program for each conversion.** Every algorithm
  would exist twice (call site and kernel), against the IR quality rule.

### Reuse, not copies

- P1 / G1 / W2 / O1's algorithms read `instr.args` directly. They move behind one `BuiltinArguments` interface
  (`receiver`, `argument(i)`): the call-site form reads the call's values, the value-call form reads
  `args[i]` through `js.object.get`. `dynamicPrototypeMethodCall` and `dynamicObjectStatic` become thin call-site
  adapters over the same functions.
- `wrapperMethodTest`, `identityTest` and `builtinMethodChain` (`dynamic-builtin-methods.ts`) build the ladder's
  rungs; step 5 is `builtinMethodChain` over the held ids.

### New algorithms

- `Array.prototype.join` (§23.1.3.18): LengthOfArrayLike (ToLength(ToNumber(Get(O, "length"))), the program's
  `toNumber`), the separator (`,` by default, else ToString), then each element: `undefined` / `null` → "",
  any other value → ToString (the program's `stringOf`). This needs a loop in a legalization buffer.
- `Array.prototype.push` (§23.1.3.23): LengthOfArrayLike, Set(O, ToString(len + i), item, true) for each item, then
  Set(O, "length", len + n, true). Above 2^53 − 1: the TypeError.
- `Array.prototype.toString` (§23.1.3.36): Get(array, "join"), called if callable, else
  %Object.prototype.toString%. Where `join` is held, an array's ToPrimitive answers instead of A1a's abort.
- BoundFunctionCreate (§10.4.1.3): a kernel function object holding its target, `this` and arguments (a realm
  array); `length` and `name` per §20.2.3.2 steps 4–9. A target whose `length` is an accessor aborts.
- `Math.pow`: ToNumber of both arguments (the program's), then Number::exponentiate through the existing physical
  provider ("math.pow needs callable provider materialization" is the stop today).
- `getOwnPropertyNames`: the kernel's own-key walk into an A1a array.

### Steps

- **A1b-0, measure (no code).**
  - Re-run the 43 propertyHelper rows on the A1a r1 head and record each one's first stop.
  - Find how a synthesized function gets a callable a runtime body can call. Candidate precedent: the
    `synthetic-support` / `compiler-unit:` units (`compiler-timer-shim-preparation.ts`).
  - Check whether a legalization buffer can hold a loop (join, push, apply). If it cannot, record the cost of the
    alternative before choosing one.
- **A1b-1**: the caller, plus `call` and `apply`, plus the already-held methods through values. Detached P1 calls
  (`var h = o.hasOwnProperty; h(k)`) then answer instead of aborting.
- **A1b-2**: `bind`.
- **A1b-3**: `push`, `join`, `toString`.
- **A1b-4**: the Object statics as values, `getOwnPropertyNames`'s array, and `Math.pow`.
- Each step: ≥ 30 new probes against node with twins, the 152 A1a probes again, the consumer sweep,
  ordinary-pipeline bytes, prelude size and time, and the gates (with `LOC_GATE_BASE=origin/main`).

### Refuses / aborts (each sound)

- `apply` with an array-like that is not a realm array.
- A built-in not on the ladder, called through a value: the abort, as today.
- A bound function's target with an accessor `length`.
- `new` of a bound function, or of a built-in that is not a constructor: as today (C2's rules), until a step
  covers it.

### Placement and quality criterion

- The ladder goes in one module: `src/ir/program/dynamic-builtin-call.ts`.
- The array methods go in `dynamic-array-methods.ts`, beside `dynamic-prototype-methods.ts`.
- The bound function goes in a kernel body module beside `realm-array-bodies.ts`.
- The synthesized unit is wired where the program's units are made.
- No algorithm exists twice. Every argument read goes through `BuiltinArguments`. No raw flag or descriptor word
  (A1a r1's tables). `from-ast.ts` must not grow.
- Expected result: all 43 rows get past module-init. About 1 passes until A1c (`arguments.length`, the JSDoc
  flow rule) and L0c (computed keys) land.
- Cost bars as in A1a: about 1 s and 15 KB for the prelude. The caller exists only where a dispatcher exists and
  a built-in is held as a value.

### Step 0 result (2026-11-27, A1a r2 head c86f46cc81; measurement only)

- **The 43 rows, real `propertyHelper.js`** (each test with its `includes`, plus `assert.js` and `sta.js`;
  refuse-mode compile): 42 refuse at `identifier "Function" is not in scope in <module-init>` (L31,
  `Function.prototype.call.bind`), and 1 at `identifier "globalThis"` (the test's own code). `Array` no longer
  stops any row: A1a lifted item 1, as planned. So every one of the 42 needs `Function` and
  `Function.prototype.call` / `bind` before anything else.
- **How the caller becomes callable.** The Prepared program has no runtime body that calls a program function by a
  static handle. The dispatcher calls program code only through values: a closure struct's funcref, matched by the
  source-closure entries. And no unit is made without a source node: the `synthetic-support` / `compiler-unit:`
  units belong to the ordinary pipeline (`compiler-timer-shim-preparation.ts`). The candidate is the shape the
  lowering already has: a unit's **lifted** functions (`lowered.lifted` with `liftedUnitProvenance`,
  `program-source-units.ts`), which are closures with dispatcher entries. The caller would be one lifted function
  of module-init, whose closure module-init stores in a realm global. The built-in arm reads that global and calls
  it through the ordinary dispatch. A1b-1 starts by proving that a legalization can add one lifted function with
  valid provenance; if it cannot, the fallback is a reserved program callable, which is new consumer plumbing.
- **Loops.** The IR has `while.loop` / `for.loop` (state in function slots; SSA values are buffer-local). No
  legalization writes a loop or allocates a slot today. `join`, `push` and `apply` need both, so the legalization
  builders gain a `slot` (fresh function slot) and a `loop` builder. That is new shared builder code, sized in A1b-3.
- **Order changes.** `Function` (the global, `Function.prototype` and its `call` / `apply` / `bind`) comes first in
  A1b-1, because every row stops there.

### A1b-1 progress (2026-11-27; WIP on `claude/7354-a1b`, not ready for review)

### Built: the caller route (proved)

- **Front end** (`src/ir/realm-builtin-caller.ts`): where closures are function objects and some function value
  exists (`realmBuiltinCaller`, `source-dynamic-contracts.ts`), the module-init prologue lifts one derived function
  `(callee, this, args)`, recorded like F1b's declaration trampolines (`recordLiftedUnitProvenance`). Its closure is
  installed through `js.closure.install-builtin-caller`. Its body is one helper call, `__ir_realm_builtin_call`.
- **Runtime** (`builtin-caller-bodies.ts`, `native-invocation.ts`): the invocation pack reserves the caller's global,
  the install, the argument reads (`js.closure.argument`, `argument-count`) and method 3. The dispatcher's built-in
  arm calls the installed caller through method 3, with the built-in, the receiver and an `$ObjVec` of the call's
  arguments. Without a caller, the arm and its bytes are as before.
- **Legalization** (`dynamic-builtin-call.ts`): the helper becomes an identity ladder over the realm methods the
  program may hold (`realmMethodsNamed`). The P1/G1/W2/A1 algorithms now take one `BuiltinCall` (`receiver`,
  `receiverKinds`, `detached`, `argument(i)`): the call site and the caller share them. A detached `this` that is
  `undefined` / `null` throws ToObject's TypeError; Error.prototype.toString on a non-object throws its TypeError.
- **Proof** (probes against node, wrong twins throw): a detached `hasOwnProperty`, `propertyIsEnumerable`,
  `Error.prototype.toString`, `Number.prototype.valueOf` and `String.prototype.toString` with an `undefined` `this`
  throw a TypeError; `Array.isArray` read as a value answers; `isPrototypeOf(1)` answers false. The 152 A1a probes are
  unchanged (145 OK, 4 abort, 3 refused, 0 wrong). Ordinary pipeline: 32/32 binaries identical.
- **Cost:** prelude 103,439 → 110,121 B (+6.7 KB). The prelude has function values, so it gets the caller. Holding
  the P1 methods (the ladder's identity tests) and method 3 are most of it.

### Prelude cost recovered (A1b-1 step 1)

- **Identity without holding.** `identityTest` asks `js.object.is-intrinsic(value, selector)`: SameValue with the
  built-in the selector names where the realm holds it, `false` for any other selector (a function object the realm
  does not hold is no program value). Only `js.object.intrinsic` reads still make the realm hold a method.
- **Rungs only where reachable.** The caller's Object.prototype rungs exist only where the source spells one of
  their names (`ProgramObjects.methodNames`, `families.methodNames`). Elsewhere a detached call of one is the
  run-time abort, as before the caller. The caller body was 74 KB of WAT text in the prelude, almost all of it these
  rungs' ToPropertyKey conversions.
- `from-ast.ts` no longer grows: the module-init resolver members moved to `ModuleInitResolver`
  (`module-init-chunk-lowering.ts`), which `IrFromAstResolver` extends (17,311 → 17,306 lines).
- **Measured** (prelude + `assert.sameValue(1, 1);`, 3 compiles each, same session): A1a head c86f46cc81 103,374 B,
  8.69 s median; caller route a16d62829e 110,121 B, 10.63 s; now 104,982 B (+1.6 KB over A1a), 8.76 s.
- Probes: the 152 A1a probes unchanged (145 OK, 4 abort, 3 refused, 0 wrong); the 13 A1b-1 probes unchanged; 10 new
  (override of `Object.prototype.hasOwnProperty` honoured, a folded key aborts, methods stored on objects and called
  as `o.f(…)`): 7 OK with failing twins, 3 abort. Ordinary pipeline 32/32 identical.

### `Function` in scope, `Function.prototype.call` (A1b-1 step 2)

- **`Function`** reads the realm's %Function% (`realmConstructorId`; catalog `implementation: "native"`: held as a
  value; `Function(…)` and `new Function(…)` are the built-in arm's run-time abort).
- **Function.prototype's methods.** `call`, `apply` and `bind` are appended to `NATIVE_VALUE_INTRINSICS`; the realm
  holds them as a group where a constant key names one or the IR reads one (`METHOD_GROUPS`,
  `native-realm-requirements.ts`; the Object.prototype group now also counts any constant-key use, not only a
  [[Get]]). %Function.prototype%'s bootstrap entry seeds its held data properties on its bag
  (`functionPrototypeProperties`); a function's reads of those keys go through the realm's [[Get]], so a write to
  Function.prototype (or to its `call`) is the program's. Entries are `object-prototype-method` only for the
  Object.prototype methods; every other entry is `native` (its holder lists it).
- **Chains.** Where the program names `Function`, `functionChainAnswer` answers `true` for %Function.prototype% on every
  function's chain but its own (`Function.prototype instanceof Function` is false).
- **`call` rung** (`dynamic-builtin-call.ts`): Call(`this`, thisArg, args) is the dispatcher's method call of the
  caller's `this` with `args[0]` and up to three arguments after it, picked by the vector's length; more is the
  run-time abort. A built-in `this` reaches the caller again (`Function.prototype.call.call(h, o, k)`), a value that is
  not callable is the dispatcher's TypeError, and a throw in the callee stays catchable. Chosen over a new
  `apply-arguments` runtime: no new consumer plumbing, and the dispatcher's own receiver rules apply (a sloppy callee
  with an `undefined` or primitive thisArg is its run-time abort, as for a detached call).
- **Rungs by spelled name.** `ProgramObjects.methodNames`: the realm's prototype-method names the source spells; the
  caller has a rung only for those (and reads four arguments only where `call` is spelled).

### Measured (head 4c22a5e9d3)

- Prelude + `assert.sameValue(1, 1);` (3 compiles, same session, load ~3): A1a 103,374 B (9.19–13.72 s, median
  10.29 s); head 107,463 B (+4.1 KB; median 10.63 s). The prelude spells `call`, so it carries the `call` rung.
- The 43 propertyHelper rows (real harness, refuse-mode compile): none stops at `Function` any more (base: 42). First
  stops now: 26 `arguments.length` (`dyn.publish_argc`, A1c), 8 `Math.pow` (needs callable provider
  materialization), 2 `null` under an f64 hint, 1 each `Date`, `RegExp` (×2), `globalThis`, a closure return type,
  `this` outside a method, a dynamic value into String. No row reaches run time, so `bind` (still the abort) is not
  yet what stops one.
- Probes against node: 14 `Function` probes (11 OK with failing twins, 2 abort: `new Function`, a read of
  `Function.prototype.constructor`; 1 refused: `'call' in g` (`__extern_has`)), 15 `call` probes (12 OK with failing
  twins, 3 abort: more than three arguments, a sloppy callee with an `undefined` / primitive thisArg). The 152 A1a
  probes unchanged (145 / 4 / 3), the 13 + 10 A1b-1 probes unchanged. 0 wrong, 0 invalid, 0 exceptions.
- Ordinary pipeline: 32/32 binaries identical. `tests/issue-7557-builtins-through-values.test.ts`: 15 node agreements
  with wrong twins, 3 aborts.
- The 411-row sample was not re-run in this session (its row lists were not found in this worktree).

### Review r1 (fixed on head after f240b11786)

- **`new` of a held built-in method ran its [[Call]].** `dynamicConstruct` now asks `js.object.is-non-constructor`
  (SameValue against the held built-ins whose catalog row is not constructible) once at the construct entry: a
  method, Function.prototype or its `call` / `apply` throws IsConstructor's TypeError. A built-in constructor through
  a value still reaches the built-in caller, which has no rung for one: the run-time abort.
- **Function.prototype's own properties had two answers.** The kernel seeds Function.prototype's held methods in its
  bag, so a held `call` is own to every query. A key the catalog gives an object but the realm does not seed
  (Object.prototype's `toString`, an unheld `call`, Array.prototype's `push`) was a silent `false` / `undefined`
  (also on the base). Now `hasOwnProperty`, `propertyIsEnumerable` and `getOwnPropertyDescriptor` ask
  `js.object.is-partial` on a miss and abort where the object is one the realm holds without all its catalog
  properties (`ownMiss`, `dynamic-object-statics.ts`). The realm's `has-own` stays the bag's answer: the object tag
  asks it whether the program wrote `Object.prototype.toString`. Cost: any miss on such an object aborts, also a key
  the catalog does not give it (`Function.prototype.hasOwnProperty('qq')`).
- **Tests.** P1's detached-call rows assert node (the method's TypeError); its constructor row asserts the TypeError.
  F1's and F1b's Function.prototype refusal rows read `toString`, since `call` is the realm's.
- **Non-blocking.** The invocation requirements check operand counts and results against the one `SIGNATURES` table;
  `METHOD_NAMES` is gone (the caller's rungs come from the spelled names); the `%Function.prototype%` special case is
  the entry's `aliases`; the built-in caller's argument reads are one optional pair (no `argumentCount!`);
  `js.object.intrinsic` and `is-partial` share one map of the realm's objects. Kept: one `!` on the caller's method
  lookup, which the requirements guarantee.
- **Measured.** 20 probes agree with node with failing wrong twins (`new` of every kind of held built-in and of user
  functions; own queries on Function.prototype / Object.prototype / Array.prototype for seeded and written keys), 9
  abort, 2 refuse (`new Array.isArray(…)`, `new Function.prototype()`: direct names), 0 wrong. Ordinary pipeline
  32/32 identical with `claude/7354-a1`. Prelude + `assert.sameValue(1, 1);`: 107,786 B (A1a 103,374 B; f240b11786
  107,463 B).

### Next session

1. `bind`: BoundFunctionCreate as a closure-root subtype holding target, `this` and a realm array of arguments, its
   `length` / `name` per §20.2.3.2 (a target whose `length` is an accessor aborts); a bound rung that prepends the bound
   arguments (the same count-picked dispatcher call as `call`); `new` of a bound function stays the abort.
2. `apply`: CreateListFromArrayLike of a realm array (any other array-like aborts; `null` / `undefined` is no
   arguments), then the same count-picked call.
3. `Array.prototype.join` / `push` (A1b-3; they need the `slot` / `loop` legalization helpers), `Math.pow`,
   `getOwnPropertyNames` (A1b-4), then A1c's `arguments.length`, which stops 26 of the 43 rows.
4. Re-run the 411-row sample through the real runner on the A1a head and on this head.
