---
id: 7471
title: "Prepared path: `delete obj.prop` on an ordinary object"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7354, 7372, 3518]
# 2026-11-26 (slices 1 and 2): src/ir/from-ast.ts grows by the delete dispatch's second arm,
# `lowerReferencelessDelete` (a name answers `false` unevaluated, any other non-reference operand `true`), plus
# the Prepared-gated receiver boxing and the resolver hook it reads. The arm sits beside `lowerDynamicDelete` because
# both are answers of the one `delete` dispatch in `lowerExpr` and read from-ast's scope (`classifyIdentifierRead`,
# `cx.scope`), which no other module owns. src/ir/integration.ts +2: the delete helper names now come from the shared
# leaf `src/shared/contracts/dynamic-delete-helper.ts` (one import of three names that prettier wraps).
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
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

**Measured yield (2026-11-26, base `41f0654e8`, `scripts/ir-census/prepared-census.mts --harness real` on
copies).** With the `delete` line removed and the post-delete assert flipped to the no-delete answer, all three Object
rows pass. With only the `delete` line removed, all three fail at run time (the assert), not at compile time. So
`delete` is their only gap. Expected: **+3 passing rows**, an estimate until slice 1 runs on the o411 sample with S3's
runner. S12.2_A2 still stops at `this["__variable"]` (Session B), so slice 2 adds no sample row; it is taken because
`delete <binding>` is in the same dispatch and costs one arm.

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
2. **Strictness: two helper names; each pipeline keeps its own rule (PRV-7471 B1, option b).**
   - The legacy names `__ir_dyn_delete_strict` / `__ir_dyn_delete_sloppy` (`irDynamicDeleteHelperName`) move from
     `src/codegen/ir-dynamic-delete.ts` to a leaf module under `src/ir/` that both pipelines import, so
     `src/ir/program/` takes no `codegen` import. The legacy wrapper keeps its body.
   - The Prepared resolver answers `irDynamicDeleteHelperName(isStrictContext(site, inferModuleStrictArguments))`.
     That is the rule `preparedCodeStrictness` applies (`src/compiler/prepared-code-strictness.ts`), the one
     `dyn.member_set`'s `sloppy` comes from, so a write and a delete in one program follow the same strictness.
   - It is not `irDeleteSiteIsStrict`. That function uses `isStrictContext`'s default `inferModuleStrict = true`, so the
     test262 wrapper's synthetic `export` would make a sloppy row strict, and a sloppy delete of a non-configurable
     property would throw instead of answering `false`.
   - The ordinary resolver keeps `irDeleteSiteIsStrict` unchanged, so its bytes do not move. Making legacy honour
     the option would change legacy verdicts and needs its own reviewed change.
   - No new IR op: the call already carries the receiver and the key, and the name carries the strictness.
3. **Legalization arm, plugged into `Access` (PRV-7471 B1).**
   - `memberAccess` and `constantKey` now take a `MemberSite` instead of `MemberGet | MemberSet`: the instruction (for
     `abort` / `kindChain`), `recv`, `key`, and the label a computed-key refusal names. The get and set arms pass their
     instruction's fields; the delete arm passes the call's two arguments.
   - `dynamicMemberDelete(b, site, strict)` sits beside `dynamicMemberRead` / `dynamicMemberWrite` and builds one
     `Access`:
     - `operation`: `member delete '<key>'`; `resultType`: the boolean.
     - `nullishMessage`: V8's "Cannot convert undefined or null to object".
     - `unread`: the constant `false`.
     - `object` / `function`: `realmCall("js.object.delete", [recv, key])`. In strict code a `false` answer branches
       to `throwTypeError` ("Cannot delete property '<key>' of <kind>"), the `putValue` shape.
     - `primitive`: number / boolean answer `true` for every key (their wrappers have no own properties). A string
       answers `true` except for `length` and the indices.
     - `missing` (PRV-7471 point 5): a string's `length` / index key needs "its own length and index properties", the
       read arm's own wording. Every other key is answered. So a key refuses at compile time only when every kind the
       receiver may hold is refused, and aborts at run time when only some are.
   - The legalization's `call` arm dispatches the two names to `dynamicMemberDelete` before its "no declaration" gap.
4. **Receiver boxing stays out of the ordinary pipeline (PRV-7471 B3).**
   - `lowerDynamicDelete` is unchanged: a receiver that is not already dynamic still returns `null` (demotes).
   - The Prepared lane's receivers reach the delete as the carrier anyway: the three rows' receivers are `var`s holding
     an object, which the Prepared path stores in the carrier.
   - If a probe shows a raw-externref receiver on the Prepared lane, the boxing is gated on the Prepared resolver's
     answer (a resolver flag the ordinary resolver never sets), not added to the shared path.
   - The byte check covers standalone as well as the JS environment and wasi.

**Slice 2: `delete <declared binding>`** (sloppy code only; strict code is a SyntaxError).

- §13.5.1.2 steps 3–4: a resolvable reference to a declarative-environment binding answers `false` and is not
  evaluated.
- One arm in from-ast's delete dispatch. After unwrapping **parentheses only**, the operand is an identifier that
  resolves to a `var`, function, parameter or lexical binding the function or script declares (`cx.scope`,
  `cx.moduleBindings`, the resolver's module binding). The arm answers the constant `false`.
- **`with` (PRV-7471 B2).** A name that resolves to a `withField` entry is an object-environment binding, whose
  [[Delete]] can answer `true` and remove the property. The arm refuses it by name
  (`delete of a with-scope binding`). Test: `with ({x: 1}) { delete x }` refuses; its node twin answers `true`.
- `arguments` answers `false` when it resolves to the function's binding; otherwise it refuses by name. A named
  function expression's own name answers `false`.
- `delete (0, x)` is not an identifier operand, so it evaluates `x` and answers `true` (§13.5.1.2 step 2).
- An unresolved name (`delete x` of an undeclared global) and `delete NaN` stay refused by name: they need the global
  object (Session B, #7372 slice 3 route B).
- The ordinary selector refuses every non-member `delete` (`expr-delete-no-ir-lowering`), so the ordinary pipeline
  never reaches the new arm.

### What is removed or kept single

- No second [[Delete]]: the kernel's `deleteOwn` is the only algorithm.
- One front-end arm (`lowerDynamicDelete`) serves both pipelines; only the helper behind it differs, as for reads and
  writes.
- The legalization arm is a sibling of `dynamicMemberRead` / `dynamicMemberWrite`: same file, same per-kind table,
  same helper calls, no new module.

### Tests and checks

- `tests/issue-7471-prepared-delete.test.ts`, run through the strict entry. Each program runs with node's answer and
  with a wrong one. Cases:
  - a configurable data property removed (`true`, and it reads `undefined` after);
  - an absent key and an inherited key (`true`, the prototype untouched);
  - a non-configurable property: `false` with the value kept in sloppy code, a caught TypeError in strict code;
  - a sloppy script-goal program (`inferModuleStrictArguments: false`) whose delete of a non-configurable property
    answers `false`, the TypeError being its wrong twin (PRV-7471 B1);
  - a frozen object (PRV-7471 point 7): `deleteOwn` checks `sealed` and the configurable bit. The test shows that
    `Object.freeze` leaves the entry non-configurable or sets `sealed`. If neither holds, the kernel also tests
    `OBJ_FLAG_FROZEN` (one condition, beside `sealed`);
  - an accessor property deleted without its getter being called;
  - `delete o.a.b`, with the receiver evaluated once;
  - function receivers (PRV-7471 point 6): `delete f.length` and `delete f.name` are `true`, and the read then answers
    `0` / `""` from Function.prototype; `delete f.prototype` is `false` (descriptor 0xb9), and a TypeError in strict
    code;
  - primitive receivers: `delete (1).x` and `delete true.x` are `true`; `delete "ab".x` is `true`;
  - the three Object row shapes, a `delete` in a function and at script level, and the statement and value forms;
  - slice 2: a script `var`, a local, a parameter, a function name, `arguments`, a named function expression's own
    name (all `false`, the binding keeps its value), and `delete (0, x)` (`true`).
- A strict-mode negative through the Prepared entry (PRV-7471 point 8): `"use strict"; var v; delete v;` must fail as
  an early SyntaxError (checker code 1102).
- Named refusals pinned:
  - `delete "ab".length` and `delete "ab"[0]`;
  - a computed key;
  - a `with`-scope binding;
  - `delete x` of an undeclared name;
  - `delete NaN`;
  - `delete this.x`.
- Pins updated: `tests/issue-7354-m-refusals.test.ts` (the delete refusal row), and the contract tables
  `tests/issue-3518-ordinary-object-callable-contracts.test.ts` and
  `tests/issue-3518-ordinary-object-runtime-providers.test.ts`.
- Ordinary-pipeline bytes identical on the JS environment, standalone and wasi: `scripts/byte-diff-corpus.mts`,
  plus every test262 file containing `delete` on standalone.
- Mutation check: one mutant each for:
  - the per-kind arms;
  - the strict TypeError branch;
  - the helper-name dispatch (strict ↔ sloppy);
  - the Prepared resolver's strictness swapped to `irDeleteSiteIsStrict` (the B1 test must fail);
  - the contract's row binding;
  - the identifier arm's `withField` refusal.
- Yield: the o411 sample through S3's runner command, base vs head, every changed row named. Expected +3.
- Gates: the CLAUDE.md set, including `LOC_GATE_BASE=$(git rev-parse origin/main)`.

### Code-quality acceptance

- No new module.
- The contract is a table row plus a declaration plus a physical row binding an existing kernel function.
- The legalization arm is a third `Access` passed to the one `memberAccess` chain (now over a `MemberSite`), not a
  copy of it.
- The delete helper names live once, in an `src/ir/` leaf module both pipelines import; each pipeline applies its own
  strictness rule, the Prepared one shared with `dyn.member_set`.
- The from-ast change is the resolver answer plus the receiver boxing that reads and writes already do.
- No growth grant is expected. If `from-ast.ts` grows (slice 2's identifier arm), a dated grant will explain why the
  arm sits beside the other `delete` arms.

## Implementation notes (2026-11-26, slices 1 and 2)

What landed, and where it departs from the plan:

- **Helper names.** The leaf is `src/shared/contracts/dynamic-delete-helper.ts`, beside `dynamic-add-helper.ts` and
  `in-operator-helper.ts`, not under `src/ir/`: those leaves are where a name both codegen and the IR read lives, since
  codegen imports nothing from the IR. `codegen/ir-dynamic-delete.ts` keeps its body and its strictness rule
  (`irDeleteSiteIsStrict`); only the names moved.
- **Strictness (B1).** The Prepared resolver asks the compiler's own `preparedCodeStrictness`, now typed over any
  `ts.Node` (a node stands for the code that encloses it), so a write and a delete follow one rule. Unknown strictness
  is strict, as `dyn.member_set`'s `sloppy` is. `inferModuleStrictArguments` only matters for a module-flagged
  source, so the B1 test uses `export {};` with no top-level `var` (the Prepared path stores no module-goal var).
- **Legalization.** `memberAccess` / `constantKey` take a `MemberSite`; `dynamicMemberDelete` is a third `Access`.
  The run-time abort of an access is now the abort into a fresh value and then the access's unread answer (the shape
  `functionChainAnswer` already used), so a Boolean-typed chain can abort. Reads and writes answer the same way
  (their unread answer is `undefined`). `BOOLEAN` and a constant-Boolean builder moved into
  `dynamic-value-chains.ts`, folding the two private copies in `dynamic-function-operations.ts` and
  `dynamic-prototype-methods.ts`. The string `length` / index rule is one helper (`stringOwnKey`) for read and delete.
- **`caller` / `arguments` of a function.** V8 gives a sloppy function own non-configurable `caller` and `arguments`
  (`delete f.caller` is `false` in node), the specification does not (the realm answers `true`). Where a value may be
  a function the delete of either refuses by name, as G1 does for V8's error keys. Not in the plan.
- **Receiver boxing (B3).** A probe showed a function-local object reaching the delete as the raw externref. The
  boxing is gated on a Prepared-only resolver answer, `dynamicDeleteBoxesExternref`; the ordinary resolver never sets
  it, and its selector admits only dynamic parameters as receivers.
- **Slice 2.** `lowerReferencelessDelete` sits before `lowerDynamicDelete` in the one dispatch. It unwraps the
  transparent wrappers (`skipOuterExpressions`: parentheses and TS type wrappers, which JavaScript does not have).
  `arguments` is not a scope binding on this path, so the arm names it: an unshadowed `arguments` inside a non-arrow
  function is that function's binding. Such a function aborts today at its argument count (`dyn.arguments_length`),
  which the test pins. `undefined` and `Infinity` refuse with `NaN` (global-object properties, Session B).
- **Not testable today.**
  - `Object.freeze` is not a native static on this path, so the frozen-object case cannot be written.
  - A `with` scope binding never reaches the arm: an object literal lowers as a realm object here, and
    `lowerWithStatement` only binds a closed `object`. The refusal stays (B2), and the test pins today's earlier stop.
  - A string-only receiver cannot be had in a `var` (its kinds include `undefined`), so `delete s.length` / `s["0"]`
    are pinned as run-time aborts, not compile-time refusals.
  - A literal primitive receiver (`delete (1).x`) is a typed `f64`, not a dynamic value, and still demotes; the
    primitive arms are tested through a dynamic parameter.
- **Pins moved.** `tests/issue-7354-m-refusals.test.ts`: the delete row is now a computed-key delete (the constant key
  runs). `tests/issue-7354-h2-script-binding-routes.test.ts`: the `delete` route left the refuse-or-abort table, since a
  delete of a declared script binding writes nothing; its eight rows are node agreement now. The #3518 contract table
  has the `js.object.delete` row; the provider table iterates the manifest and needed no edit.
- **Mutants** (`tests/issue-7471-prepared-delete.test.ts`, each restored after): primitive arm `true`→`false` 1 test
  fails; object arm answering `true` 11; strict branch dropped 3; helper-name dispatch swapped 5; Prepared resolver
  swapped to `isStrictContext(site)` (`irDeleteSiteIsStrict`'s rule) 1 (the B1 test); row bound to `hasOwn` 13; the
  identifier arm answering `true` 6; the comma arm answering `false` 1; `arguments` not recognised 1. The `withField`
  refusal mutant fails nothing: unreachable today (see above).
- **Yield** (`scripts/ir-census/prepared-census.mts --harness real`, base `41f0654e8` vs this branch): the three
  Object rows go from `delete has no IR lowering` to `pass`. `S12.2_A2` now stops at `this["__variable"]` (`'this'
  reference outside an instance method body`), `S15.1.1.1_A3_T2` at `delete of "NaN", which only the global object
  holds`, `S11.13.2_A5.2_T2` at `with target/body outside the closed-object IR slice`: all Session B's.
