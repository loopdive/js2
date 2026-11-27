---
id: 7562
title: "Prepared IR path: the `arguments` object (length, indexed reads) and Math.pow"
status: in-progress
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: []
related: [7354, 7350]
---

# #7562 — Prepared IR path: the `arguments` object and Math.pow

## Problem

Measured on main (merge-queue ES5 IR run, `781ef2e4ee`): 1979 pass / 762 fail /
6276 compile error / 12 other of 9029 ES5 tests on the Prepared path. About 900
ES5 tests include `harness/propertyHelper.js`. Of the 43 such rows in the
411-row sample, 26 stop at compile time at `arguments.length`
(`verifyProperty` asserts `arguments.length > 2`) and 8 at `Math.pow`.

On main, the Prepared path:

- lowers `arguments.length` in a function declaration to `dyn.arguments_length`
  (from-ast, #7106 S1e) and a caller's under-arity count to `dyn.publish_argc`,
  but its dynamic-value legalization has no arm for either, so the function
  becomes a run-time abort body;
- refuses `Math.pow(x, y)` and `x ** y`: the `math.pow` intrinsic's provider is
  self-hosted (`selfhost.math.pow`, `Math_pow` in `src/stdlib/math.ts`) and the
  Prepared physical plan has no materialization for self-hosted providers.

## Implementation Plan

### How the callee learns its argument count (one protocol, the existing one)

The Prepared native dispatcher (`js.closure.call:N`, `js.closure.apply-vector`,
`src/runtime/wasmgc/values/closure-method-body.ts` and
`closure-invocation-bodies.ts`) already keeps legacy's count protocol: before it
enters a source closure it installs `__argc` (the filled formal count) and
`__extra_args` (the arguments beyond the formals), and its boundary restores
both afterwards. These globals live in the invocation pack
(`src/backend/wasmgc/resources/native-invocation.ts`). No new argument vector,
no extra parameter.

- **Callee half.** `dyn.arguments_length` legalizes to a call of a new
  invocation callable `js.closure.arguments-length` (beside
  `js.closure.receiver`, `src/ir/core/closure-invocation-callables.ts`): read
  `__argc` and `__extra_args`, clear both, return `argc + extras.length`. Its
  body is legacy's `__ir_arguments_length` body (`src/codegen/ir-arguments-length.ts`),
  moved into a pure builder in `src/runtime/wasmgc/values/` that legacy calls
  too (legacy bytes identical). The one difference is the unknown-caller
  marker `-1`: legacy answers the formal count; Prepared aborts, because on
  this path every entry into a reading function publishes its count first, so
  `-1` there means a path this slice did not prove.
- **Caller half.** `dyn.publish_argc` legalizes to `js.closure.publish-argc`
  (count as an i32 operand): `__argc = count`, `__extra_args = null`. Clearing
  the extras matters on this path: a dispatched non-reading callee runs with the
  dispatcher's count and extras still installed, so a direct call from it to a
  reader must replace both.
- **Every direct call to a reader publishes on the Prepared path** (from-ast's
  `planUnderArityDirectCall`, extended to exact arity when the unit is
  `unselected`). The ordinary pipeline keeps publishing only under-arity calls
  (byte identity). Over-arity direct calls stay refused, as on main.
- Requirements and reservations: `NativeInvocationRequirements` gains the two
  use kinds beside `receiver`; the pack reserves and fills the two functions
  only when a use exists. A function that never names `arguments` and its
  callers pay nothing. A program without any source closure has no invocation
  pack, so a reader there refuses at compile time (the plan cannot reserve the
  callable) — never a wrong value.

Legalization arms sit in `src/ir/program/dynamic-function-operations.ts`, beside
`dynamicCurrentThis` (the other read of the dispatcher's invocation state).

### Math.pow

Reuse the self-hosted `Math_pow` body (and its callees `Math_exp`, `Math_log`)
— no second pow. Where and how the Prepared plan materializes self-hosted
providers is decided after step 1 is in, from what the ordinary pipeline's
`stdlib-selfhost.ts` driver can share without an IR→codegen edge; the result
section records it and which other `Math.*` functions the same mechanism frees.

### Out of scope / refused

`arguments[i]` writes, sloppy parameter aliasing, `arguments.callee`, assigning
`arguments.length`, passing `arguments` as a value: refused or aborted (the
result section names which). Function expressions and arrows reading
`arguments`: unchanged (refused, as on main).

### Acceptance criteria

Correctness:

1. `arguments.length` agrees with node for fewer, equal and more arguments than
   formals on direct calls (fewer, equal), calls through values and method
   calls (all three); recursion; 0 and 20 arguments; strict and sloppy; a
   dispatched non-reader calling a reader directly; each with a wrong twin.
2. Shadowed `arguments` (parameter, `var`), nested functions, top-level script
   and dead code naming `arguments` refuse, abort or agree — never a wrong
   value, trap where JS throws, invalid Wasm or a `compile()` exception.
3. `Math.pow` / `**` exact per ES5 §15.8.2.13 on the listed special cases.
4. Ordinary pipeline output byte-identical on ~30 programs.

Code quality:

5. One count protocol (the dispatcher's), one count body shared with legacy,
   the new arms beside their siblings in the same shape; `src/ir/from-ast.ts`
   does not grow; no new IR→runtime or IR→codegen import edges.

## Progress (2026-11-27, step 1 done; steps 2–4 open)

### Built (step 1, `arguments.length`)

As planned: `js.closure.arguments-length` / `js.closure.publish-argc` in the
invocation pack (`native-invocation.ts`), declared in
`src/ir/runtime/closure-invocation-callables.ts` (one signature table, the
program validation enforces it), required in
`native-invocation-requirements.ts`, legalized in
`dynamic-function-operations.ts` (`argumentsCount`). The count body is
`buildArgumentsCountBody` (`closure-invocation-bodies.ts`), now also legacy's
`__ir_arguments_length` body. from-ast: one condition in
`planUnderArityDirectCall` (line count unchanged).

Example: `function f(a, b) { return arguments.length; } var g = f;
g() + ',' + g(1, 2, 3) + ',' + f(1)` gives `0,3,1` as node does.

### Refused / aborted

- Over-arity direct call (`f(1, 2)` on one formal): refused, as on main.
- A reader in a program with no function value: refused (no invocation pack,
  so the plan cannot reserve the count callables).
- Getter `arguments`: refused. Function-expression and arrow `arguments`,
  `typeof arguments`, `arguments[i]`: run-time abort.

### Measured

- Probes vs node (wrong twin each): 16 right, 0 wrong, 0 invalid, 0 compile
  exceptions; the rest refuse or abort as listed. Two mutations (publish not
  clearing the extras; no exact-arity publication) each turn the
  dispatched-caller probe wrong and fail the test.
- Ordinary pipeline: 86 compiles (30 programs × standalone/gc/wasi, including
  legacy `__ir_arguments_length` users) byte-identical before/after.
- Prepared, programs not naming `arguments`: byte-identical, compile time
  unchanged.
- propertyHelper rows (47 in the 419-row lists): on main all stop before
  `arguments.length` — 43 at `identifier "Array" is not in scope`, 4 at
  `direct call to "Function"`. With `Array`/`Function` stubbed in the harness,
  the next stop is `identifier "Object" is not in scope` (16 of 20 checked) or
  `Function` (4). So this slice moves no row on main by itself; it pays off once
  the lane's built-in branches land.
- 411-row sample: not run (1-min load 7–13 during the session, rule is < 3).

### Next session

1. Step 4, Math.pow: provide self-hosted providers (`Math_pow`, `Math_exp`,
   `Math_log`, from `src/stdlib/math.ts`) on the Prepared plan. The precedent
   is the number-formatter support batch
   (`src/frontend/builtins/prepare-number-format.ts` →
   `IrRuntimeSupport` → `program-physical-plan.ts` formatter arm): build each
   body with `buildSelfHostedIrBody` and add a runtime-support batch kind
   rather than a second pow. `missingIntrinsicMaterialization` is where
   `math.pow` is refused today. The same batch frees every `self-hosted`
   provider in `src/ir/runtime/manifest.ts` (exp, log, log2, log10, sin, cos,
   tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh, cbrt,
   expm1, log1p, round, sign) and `x ** y`.
2. Step 2, `arguments[i]` and `typeof arguments`: needs the entry read to keep
   the extras vector (a second result of the count call or a sibling
   callable), formals all dynamic, and a refusal when a parameter is assigned.
3. Over-arity direct calls to readers: publish the extras (a vector operand to
   `js.closure.publish-argc`).
