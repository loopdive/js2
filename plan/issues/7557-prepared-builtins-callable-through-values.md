---
id: 7557
title: "Prepared path: built-in functions callable through values (call, apply, bind, push, join, statics)"
status: in-progress
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7352]
related: [7354, 7352]
assignee: "ttraenkler/ir-lane-a1"
---

# #7557 — Prepared path: built-in functions callable through values

Slice A1b of the Prepared whole-program IR path (#7354), after A1a's arrays (#7352). Branch `claude/7354-a1b`,
stacked on `claude/7354-a1` (c86f46cc81).

## Problem

On the Prepared path (`TEST262_COMPILER_PATH=ir`, `--target standalone`) a built-in called through a value reaches
the dispatcher's built-in arm, which is the run-time abort. `propertyHelper.js` binds `Function.prototype.call` to
built-ins in its module-init (`__join`, `__push`, …) and calls `Math.pow`, so every one of the 43 sample rows that
include it stops in module-init.

## Acceptance criteria

- The 43 propertyHelper rows get past module-init.
- `call`, `apply` and `bind` work on the held built-ins and on source functions.
- `Array.prototype.push`, `join` and `toString` work, and an array's ToPrimitive answers where `join` is held.
- The Object statics and `Math.pow` work as values; `getOwnPropertyNames` returns an array.
- Never a wrong value, never invalid Wasm, never an exception out of `compile()`; anything else refuses by name or
  aborts at run time.
- Ordinary-pipeline output stays byte-identical. Prelude cost stays within about 1 s and 15 KB.
- Code quality: one copy of each algorithm (see below), `from-ast.ts` does not grow, and the gates pass with
  `LOC_GATE_BASE=origin/main`.

## Implementation Plan

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

## Step 0 result (2026-11-27, A1a r2 head c86f46cc81; measurement only)

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

## A1b-1 progress (2026-11-27; WIP on `claude/7354-a1b`, not ready for review)

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

### Next session

1. `bind`: BoundFunctionCreate as a closure-root subtype holding target, `this` and a realm array of arguments, its
   `length` / `name` per §20.2.3.2 (a target whose `length` is an accessor aborts); a bound rung that prepends the bound
   arguments (the same count-picked dispatcher call as `call`); `new` of a bound function stays the abort.
2. `apply`: CreateListFromArrayLike of a realm array (any other array-like aborts; `null` / `undefined` is no
   arguments), then the same count-picked call.
3. `Array.prototype.join` / `push` (A1b-3; they need the `slot` / `loop` legalization helpers), `Math.pow`,
   `getOwnPropertyNames` (A1b-4), then A1c's `arguments.length`, which stops 26 of the 43 rows.
4. Re-run the 411-row sample through the real runner on the A1a head and on this head.
