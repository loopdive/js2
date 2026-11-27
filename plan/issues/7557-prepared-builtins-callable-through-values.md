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
