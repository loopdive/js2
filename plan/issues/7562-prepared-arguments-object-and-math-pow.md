---
id: 7562
title: "Prepared IR path: `arguments.length`"
status: done
completed: 2026-11-27
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

# #7562 — Prepared IR path: `arguments.length`

## Problem

Measured on main (merge-queue ES5 IR run, `781ef2e4ee`): 1979 pass / 762 fail /
6276 compile error / 12 other of 9029 ES5 tests on the Prepared path. About 900
ES5 tests include `harness/propertyHelper.js`. Of the 43 such rows in the
411-row sample, 26 stop at compile time at `arguments.length`
(`verifyProperty` asserts `arguments.length > 2`). Math.pow: Out of scope → #7564.

On main, the Prepared path:

- lowers `arguments.length` in a function declaration to `dyn.arguments_length`
  (from-ast, #7106 S1e) and a caller's under-arity count to `dyn.publish_argc`,
  but its dynamic-value legalization has no arm for either, so the function
  becomes a run-time abort body.

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
  `planDirectCallArgumentCount`, extended to exact arity when the unit is
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
3. Ordinary pipeline output byte-identical on ~30 programs.

Code quality:

4. One count protocol (the dispatcher's), one count body shared with legacy,
   the new arms beside their siblings in the same shape; `src/ir/from-ast.ts`
   does not grow; no new IR→runtime or IR→codegen import edges.

## Result (2026-11-27)

### Built

As planned: `js.closure.arguments-length` / `js.closure.publish-argc` in the
invocation pack (`native-invocation.ts`), declared in
`src/ir/runtime/closure-invocation-callables.ts` (one signature table, the
program validation enforces it), required in
`native-invocation-requirements.ts`, legalized in
`dynamic-function-operations.ts` (`argumentsCount`). The count body is
`buildArgumentsCountBody` (`closure-invocation-bodies.ts`), now also legacy's
`__ir_arguments_length` body. from-ast: one condition in
`planDirectCallArgumentCount` (line count unchanged).

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

### Review r1 (2026-11-27)

- Blocking, fixed: `var arguments;` lowered as a block-local `undefined`
  (`k(1,2,3)` threw where node gives 3; `typeof` wrong), and an initialized
  `var arguments` in a block read after it gave the count where node gives
  `undefined`. Rule: a non-arrow function's implicit `arguments` is one of its
  bindings (§10.2.11 step 27 starts a `var arguments` as the arguments object),
  so `isRepeatedVarBinding` (`function-local-var.ts`) counts it and every
  `var arguments` there is a repeated var: the body aborts. Covers
  no-initializer, initializer, nested block, for-head, read-before (hoisting),
  function expressions. Arrows, `let`, `catch (arguments)` and a parameter keep
  their own binding.
- One predicate, `readsOwnArgumentsObject` (`select.ts`), for the entry read
  and a direct call's publication; `function p(arguments) { return arguments }`
  called directly now returns its argument (was the count read's `unreachable`).
- `planUnderArityDirectCall` → `planDirectCallArgumentCount`.
- Ordinary pipeline: 12 compiles (6 programs × gc/standalone) identical except
  `function p(arguments)` on standalone, which loses its dead `__argc` entry
  read (legacy's `needsImplicitArgumentsObject` reads nothing there either).
  Prepared output identical on 3 programs without `arguments`.

### Review r2 (2026-11-27)

- Blocking, fixed: an inner non-arrow function read an OUTER binding named
  `arguments` (`function p(arguments){ var q = function(b){ return
  arguments.length } … }` gave "undefined", with an outer `let arguments =
  'abcde'` gave "5"; node "1" both). The `arguments.length` arm skipped itself
  on `cx.scope.has("arguments")`, and a closure inherits the outer scope.
- The fix is one scope-correct resolution instead of name tests in three
  places. `argumentsObjectOwner(reference)` (`src/ir/analysis/ast-scope.ts`,
  beside `resolvesToSourceBinding`) walks out from an `arguments` reference:
  the first non-arrow function owns it unless a nearer scope declares the name
  (a block's `let`/`const`/class/function declaration, a loop head's, a catch
  binding, a parameter incl. destructured, an arrow's `var`). A function's own
  `var arguments` does not end the walk (it starts as the object).
  `ownArgumentsObjectUse(fn)` summarises it: `none`, `length` (only
  `arguments.length` reads) or `other` (the value, an index, a write, `var
  arguments`, a read inside `with`); property names, object keys and labels
  are not references. Consumers: the entry read and a direct call's
  publication (`!== "none"`), the `arguments.length` lowering and the Prepared
  abort for `other` (`src/ir/arguments-object.ts`, new), and the selector's
  `phase1ArgumentsLengthRead`. Gone: `functionBodyReferencesArguments`,
  `readsOwnArgumentsObject`, the `cx.scope.has("arguments")` test, and r1's
  `arguments` entry in `isRepeatedVarBinding` (reverted: the `var arguments`
  abort is now the Prepared `other` rule, so the ordinary pipeline keeps its
  merge-base handling).
- `src/ir/from-ast.ts`: 17396 → 17381 lines.
- Probes vs node (wrong twin each): the two blocking programs, the same with
  a nested declaration, through a value, as a method, with `new`, three
  levels deep, a `let arguments` block with an arrow, an arrow over a
  parameter `arguments`, `eval("var arguments = 1")`, `with`, `arguments = 5`,
  an inner write of the outer `arguments.length`: all end at the run-time
  abort, none wrong. `a.arguments`, `{arguments: 1}` and a label `arguments`
  agree with node and no longer take the count at entry: their Prepared code
  is identical to an `argumentz` control (only the string pool differs, since
  the runtime already holds the literal "arguments"). `function p({arguments})`
  refuses. Prepared bytes identical to the merge base on 3 programs without
  `arguments`.
- Ordinary pipeline, 14 programs × standalone/gc/wasi against the merge base
  (`a27936f5b2`): 11 programs identical, including r1's
  `function v(a){ var arguments = 4; return arguments }` (difference (b) is
  gone). Three differ, every result equal before, after and in node: a formal
  named `arguments` (`p(4)`: 4/4/4) and the property-name users `a.arguments`
  (3/3/3) and `{arguments: 1}` (3/3/3). All three drop a dead
  `__ir_arguments_length` entry read, since none reads an arguments object.
  Re-measured after merging main (head vs merge base `1051faa835`): the same
  three differ with the same hashes and results; the other 11 are identical.
- After the merge: typecheck exit 0; the gates chain passes against the merge
  base. With `LOC_GATE_BASE` at `origin/main` (`b78ea8d439`) only the LOC gate
  fails, on `src/codegen/native-strings.ts` (2208 > 2205), a file this branch
  does not touch: main shrank it after the merge.
- Test file: 27 rows, exit 0.

### Next (follow-up issues)

1. `arguments[i]` and `typeof arguments`: needs the entry read to keep
   the extras vector (a second result of the count call or a sibling
   callable), formals all dynamic, and a refusal when a parameter is assigned.
2. Over-arity direct calls to readers: publish the extras (a vector operand to
   `js.closure.publish-argc`).
3. A `var arguments` that keeps the arguments object (today: abort).
