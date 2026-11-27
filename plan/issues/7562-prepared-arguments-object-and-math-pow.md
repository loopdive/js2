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
