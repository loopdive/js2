---
id: 7471
title: "Prepared path: `delete obj.prop` on an ordinary object"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7354, 7372, 3518]
---

# #7471 — Prepared path: `delete obj.prop` on an ordinary object

## Problem

On the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`, strict entry
`src/test262/test262-prepared-entry.ts`, standalone wasmgc), every `delete` refuses with
`ir/from-ast: delete has no IR lowering`. A refusal in module-init refuses the whole program; one inside a function
makes it an abort body (#7354 U).

## Measured

Main `6694a8b83` (2026-11-26), the shared 411-row sample (`plan/samples/7354-o411.txt` on `claude/7354-o411-sample`),
real harness. Six rows stop first at `delete has no IR lowering`:

| row | `delete` form | owner |
| --- | --- | --- |
| `built-ins/Object/create/15.2.3.5-4-121.js` | `delete newObj.prop` (from `Object.create({}, {prop: descObj})`) | **this issue** |
| `built-ins/Object/defineProperties/15.2.3.7-5-b-59.js` | `delete obj.prop` (from `Object.defineProperties`) | **this issue** |
| `built-ins/Object/defineProperty/15.2.3.6-3-124.js` | `delete obj.property` (from `Object.defineProperty`) | **this issue** |
| `language/statements/variable/S12.2_A2.js` | `delete(__variable)`, a declared script var, and `delete(this["__variable"])` | this issue: the identifier part; `this[…]` is Session B's |
| `built-ins/NaN/S15.1.1.1_A3_T2.js` | `delete NaN` (a global-object property) | Session B (global object) |
| `language/expressions/compound-assignment/S11.13.2_A5.2_T2.js` | `delete this.x` inside `with` | Session B (`with`, `this`) |

No row deletes an array element. Array elements are Session B's and stay out of scope.

Probes through the strict entry on the same main, each refused today:

- `var o = {}; o.p = 1; if (delete o.p !== true) throw 1; if (o.p !== undefined) throw 2;` refuses.
- `var v = 1; if (delete v) throw 1;` refuses.
- `function f() { var w = 2; return delete w; }` makes `f` an abort body.

Expected yield on the sample: the three Object rows reach their `delete` and run past it. Their next stops are
measured after slice 1. S12.2_A2 still stops at `this["__variable"]`, so it does not pass here. The yield number in
the PR comes from S3's runner command (the README on `claude/7354-o411-sample`), base vs head.

## Implementation Plan

### What exists, to reuse

- **[[Delete]] is already in the native kernel.** `buildBuiltinFunctionDeleteOwn`
  (`src/runtime/wasmgc/values/builtin-function-property-bodies.ts`) is the `deleteOwn` role of the realm kernel,
  `(externref, externref) -> i32` (`src/backend/wasmgc/resources/native-builtin-functions.ts`). It is reserved and
  filled for every realm, and it serves an ordinary `$Object` and a function object through `bag`, the receiver set
  `js.object.has-own` serves. It is OrdinaryDelete:
  - an absent key answers 1;
  - a `sealed` object or a non-configurable entry (`$PropEntry.flags` configurable bit) answers 0;
  - otherwise it tombstones the entry and answers 1.

  Nothing exposes it to the Prepared path: no `js.object.*` contract binds it, and only a kernel test calls it.
- **The front-end arm exists.** `lowerDynamicDelete` (`src/ir/from-ast.ts`) lowers `delete <recv>.p` /
  `delete <recv>[k]` over a dynamic receiver to a call of the helper the resolver names (`dynamicDeleteSymbol`). The
  ordinary pipeline answers with its legacy wrapper (`src/ir/integration.ts`); the Prepared resolver answers nothing
  today. The statement form `delete o.p;` already takes `lowerDroppedDelete`.
- **The Prepared member operations have a template.**
  - `dyn.member_get` and `dyn.member_set` are legalized per receiver kind (`src/ir/program/dynamic-member-access.ts`,
    `MEMBER_ACCESS_ARM`): nullish raises TypeError, object/function makes a realm call (`realmCall`,
    `src/ir/program/dynamic-realm-calls.ts`, e.g. `js.object.set`), a primitive gets its wrapper's answer.
  - A strict failure is a `branch` plus `typeErrorThen`.
  - `js.object.has-own` (commit 2405b593d) is the template for adding an ordinary-object contract.

### Target structure (no new algorithm, no second lowering)

**Slice 1: a member of an ordinary object.**

1. **Contract + physical row.**
   - `js.object.delete` joins `ORDINARY_OBJECT_RUNTIME_FEATURES` / `_PROVIDER_IDS`
     (`src/ir/runtime/contracts/manifest.ts`).
   - Its signature `[EXTERNAL, EXTERNAL] -> [BOOLEAN]` goes in `DECLARATIONS`
     (`src/ir/runtime/ordinary-object-callables.ts`).
   - Its physical row in `ROWS` (`src/backend/wasmgc/resources/native-source-objects.ts`) binds the kernel's
     `deleteOwn`, the way the other bound rows do.
   - The physical plan (`planNativeSourceObjectSetup`, the realm reservation) picks the feature up from
     `objectUses`; nothing else changes there.
2. **Legalization arm, next to its siblings in `dynamic-member-access.ts`:** `dynamicMemberDelete`, the same per-kind
   chain as `dynamicMemberRead` / `dynamicMemberWrite`, built from `MEMBER_ACCESS_ARM`:
   - nullish receiver: TypeError;
   - object / function: `realmCall("js.object.delete", [recv, key])`; in strict code, a `false` answer becomes
     `typeErrorThen` (§13.5.1.2 step 5.d);
   - number / boolean: `true` (a primitive's wrapper has no own property of a constant non-index key; the same
     reasoning `has-own` uses);
   - string: refused by name, because `length` and the indices need the String exotic, as `has-own` refuses them.
   - Keys: constant keys through the existing `constantKey`. A computed key is refused by name in this slice, as
     `dyn.member_get` does today.
3. **From-ast seam.**
   - The Prepared resolver answers `dynamicDeleteSymbol` with a front-end helper name the legalization recognizes,
     on the precedent of `__ir_object_static:` and `__ir_realm_intrinsic:`. That is one name; strictness comes from
     `cx.functionCodeStrict`, as `dyn.member_set` takes it.
   - `lowerDynamicDelete` boxes a raw-externref receiver (`isRawExternrefReceiver`) the way reads and writes do. Its
     `null` return for a non-dynamic receiver stays.
   - The legalization's `call` arm dispatches the helper to `dynamicMemberDelete` before its "no declaration" gap.

**Slice 2: `delete <declared binding>`** (a `var`, function or parameter binding; sloppy code only, since strict
code makes it a SyntaxError the checker already reports).

- §13.5.1.2 steps 3–4: a resolvable reference to a declarative or object-environment `var` binding answers `false`
  (the binding is non-configurable), and the operand is not evaluated.
- One arm in from-ast's delete dispatch. The operand is an identifier that resolves to a binding the function or
  script declares (`cx.scope`, `cx.moduleBindings`, the resolver's module binding). The arm answers the constant
  `false`.
- An unresolved name (`delete x` of an undeclared global) and `delete NaN` stay refused by name: they need the global
  object (Session B, #7372 slice 3 route B).
- The ordinary selector refuses every non-member `delete` (`expr-delete-no-ir-lowering`), so the ordinary pipeline
  never reaches the new arm and its bytes do not move.

### What is removed or kept single

- No second [[Delete]]: the kernel's `deleteOwn` is the only algorithm.
- One front-end arm (`lowerDynamicDelete`) serves both pipelines; only the helper behind it differs, as for reads and
  writes.
- The legalization arm is a sibling of `dynamicMemberRead` / `dynamicMemberWrite`: same file, same per-kind table,
  same helper calls, no new module.

### Tests and checks

- `tests/issue-7471-prepared-delete.test.ts`, run through the strict entry, each program run with node's answer and
  with a wrong one:
  - a configurable data property removed (`true`, and the property reads `undefined` after);
  - an absent key (`true`);
  - a non-configurable property (`false`, and the value stays) in sloppy code;
  - the same in strict code (a TypeError, caught);
  - the three Object row shapes: `Object.create` with a descriptor object, `Object.defineProperties`,
    `Object.defineProperty`;
  - a `delete` in a function and at script level;
  - the statement and value forms;
  - slice 2: `delete v` of a script `var`, a local, a parameter and a function name (all `false`, the binding keeps
    its value).
- Named refusals pinned:
  - a string receiver;
  - a computed key;
  - `delete x` of an undeclared name;
  - `delete NaN`;
  - `delete this.x`.
- Pins updated: `tests/issue-7354-m-refusals.test.ts` (the delete refusal row), and the contract tables
  `tests/issue-3518-ordinary-object-callable-contracts.test.ts` and
  `tests/issue-3518-ordinary-object-runtime-providers.test.ts`.
- Ordinary-pipeline bytes identical, JS environment and standalone: a sample of test262 files with `delete` plus the
  existing 250-file sample.
- Mutation check: one mutant each for the per-kind arms, the strict TypeError branch, the contract's row binding and
  the identifier arm.
- Yield: the 411-row sample through S3's runner command, base vs head, every changed row named.
- Gates: the CLAUDE.md set, including `LOC_GATE_BASE=$(git rev-parse origin/main)`.

### Code-quality acceptance

- No new module.
- The contract is a table row plus a declaration plus a physical row binding an existing kernel function.
- The legalization arm has the shape of its two siblings.
- The from-ast change is the resolver answer plus the receiver boxing that reads and writes already do.
- No growth grant is expected. If `from-ast.ts` grows (slice 2's identifier arm), a dated grant will explain why the
  arm sits beside the other `delete` arms.
