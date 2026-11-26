---
id: 7489
title: "Prepared path: a function's `caller`, and Function.prototype.call / apply / bind"
status: in-progress
created: 2026-11-26
updated: 2026-11-26
priority: high
feasibility: medium
reasoning_effort: high
horizon: m
sprint: current
goal: ir-full-coverage
parent: 7354
related: [7354]
---

# Prepared path: a function's `caller`, and Function.prototype.call / apply / bind

## Problem

On the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`) a member read of
`caller`, `call`, `apply` or `bind` on a function value refuses
(`dynamic-member-access.ts`, "needs Function.prototype's properties"), so the
function holding it becomes an abort body and the test traps.

Lane S9's census (2026-11-26) counts 70 files; re-measured on main `c3b7be66`
with `.tmp/pcensus.mts` (the census plus each trap's abort row):

| abort reason (read on a function) | files |
|---|---:|
| `caller` | 38 |
| `apply` | 12 |
| `call` | 10 |
| `bind` | 10 |
| write `caller` (G1's by-name refusal) | 2 |

All 72 are `built-ins/Function/15.3.5.4_2-*gs`, `15.3.5-*gs` and
`language/statements/function/13.2-*`. Every call site has no argument past
`this`: `f.call(o)`, `f.apply()`, `f.apply(null)`, `f.bind(o)()`.

## What JavaScript answers

- **`f.caller`, strict / arrow / method / built-in `f`.** No own `caller`, so
  [[Get]] reaches Function.prototype's accessor, whose getter is
  %ThrowTypeError% (§10.2.4 AddRestrictedFunctionProperties): TypeError. A
  write calls the same thrower as setter: TypeError in sloppy and strict code.
- **`f.caller`, sloppy plain function.** Implementation-defined (the `caller`
  test262 feature); §17.1 forbids only a strict function as the value. V8 has
  an own non-writable, non-enumerable, non-configurable data property whose
  value is `null`, or the active sloppy caller.
- **`f.call(t, …a)`** calls `f` with `this` = `t`. **`f.apply(t, x)`**: `x`
  absent, `undefined` or `null` is no arguments; a primitive is a TypeError
  (CreateListFromArrayLike); an object is its array-like list.
- **`f.bind(t, …a)`** is a bound function exotic object (§10.4.1).

Checked per file: an own `caller` that is always `null` gives every one of the
72 tests its expected verdict (the `x.caller || x.caller.throwTypeError` tests
all expect the TypeError; the plain reads expect no throw). The difference from
node, `null` where V8 returns a sloppy caller, is the implementation-defined
part; no test in the corpus compares a `caller` read with a function.

### Where an always-`null` `caller` differs from node

It differs in one case only: the read runs while a **sloppy** function is the
active caller (V8 answers that function; this plan answers `null`). The value
there is implementation-defined, so `null` is a conforming answer, but it is
not node's. Checked on the corpus (main `c3b7be66`):

- No test262 file compares a `caller` read with a function (`sameValue`,
  `===`, `==`); the forbidden-extension tests only require it not to be a
  strict function (`notSameValue`), which `null` meets.
- In the 72 cluster files the case occurs (e.g. `15.3.5.4_2-87gs`: sloppy `f`
  calls `gNonStrict`), and each such test only requires that the read does not
  throw; verdict unaffected.

Whether this case can be refused by name instead: not at select. The caller of
a function value is a run-time fact (calls through dynamic values, `call`,
`apply`), so a sound refusal would have to refuse every `caller` read of a
function that some sloppy function might call, which is every sloppy-callee
read in the cluster. The plan therefore takes `null` and asks the reviewer to
confirm; if the reviewer rejects it, slice A shrinks to the strict half
(TypeError arms, 17 + 1 files) and the sloppy read keeps its by-name refusal.

## Claim

`claim-issue.mjs 7489 ttraenkler/c-lead --branch claude/s20-fn-members`: OK on
`origin/issue-assignments`.

## Implementation Plan

Three slices, one PR each, in this order. Each keeps JS-environment and
ordinary-pipeline bytes identical: every change is on the Prepared native
dynamic lane (`createsFunctionObjects`) or in Prepared-only legalization.

### Slice A: `caller` reads and writes (yield ceiling 38 + 2)

1. **Own `caller` on a sloppy plain function** — `js.object.init-function`.
   - `src/ir/function-object-lowering.ts` `emitFunctionObjectInit`: the fourth
     operand becomes a flags word: bit 0 constructor (today's Boolean), bit 1
     "sloppy plain function" (a declaration or expression whose code is not
     strict).
   - Strictness comes from the existing `irFunctionCodeStrictness`
     (`src/codegen/ir-dynamic-construct.ts`), widened from
     `FunctionDeclaration | SourceFile` to the function-like nodes, through
     the resolver seam the IR already calls. No second strictness predicate.
   - `src/runtime/wasmgc/values/source-function-object-bodies.ts`: with bit 1,
     define `caller` = `null` with descriptor word 0 (non-writable,
     non-enumerable, non-configurable), next to the `prototype` define, using
     the same `define` helper.
   - `src/ir/runtime/ordinary-object-callables.ts`: the declaration's fourth
     parameter type, BOOLEAN → FLAGS.
2. **The function arm of a read or write of an accessor key of
   Function.prototype** — `src/ir/program/dynamic-member-access.ts`.
   - The read's `missing` stops naming `caller` (it no longer needs anything
     the realm lacks). `arguments` stays refused by name: its V8 value is the
     live arguments object (Session B), and no own property is installed for it.
   - The `function` arm of both accesses, for a key in
     `FUNCTION_PROTOTYPE_ACCESSOR_KEYS`: `js.object.has` → the own property
     (get, or the write's existing `putValue`), else the %ThrowTypeError%
     TypeError. This is the object arm's has-then-branch shape with the
     accessor's known answer in place of the abort: one helper,
     `accessorOrOwn(key)`, used by both `Access` records.
   - `builtin-prototype-keys.ts`: `FUNCTION_REACHABLE_KEYS` drops `caller`;
     the write's `missing` drops the Function.prototype accessor branch for
     `caller` (G1's refusal stays for `arguments`).
3. **Tests** (`tests/issue-7489-function-caller.test.ts`), each failing on
   main: a sloppy function's `caller` is `null` and own, non-writable,
   non-enumerable, non-configurable; a strict function's read and write throw
   TypeError (sloppy and strict writer); an arrow's and a method's read throw;
   `hasOwnProperty("caller")` agrees with the read; `f.arguments` still
   refuses by name; a JS-environment and an ordinary-pipeline compile of the
   same source are byte-identical to main.

### Slice B: `Function.prototype.call` and `apply` (yield ceiling +10, +12)

The P1 shape (`dynamic-prototype-methods.ts`), extended rather than copied.

1. **Catalog** — `src/runtime/contracts/native-realm-catalog.ts`:
   `NATIVE_MEMBERS["Function.prototype"] = ["apply", "call"]`, and the two
   ids join `NATIVE_VALUE_INTRINSICS`, so the realm's Function.prototype holds
   them as built-in function objects (the seeding P1 uses for
   Object.prototype).
2. **One "populated prototype" rule** — `builtin-prototype-keys.ts`:
   `UNPOPULATED_OBJECT_PROTOTYPE_KEYS` and `FUNCTION_REACHABLE_KEYS` become
   one `unpopulated(parent)` helper over the catalog's native members.
   `native-realm-requirements.ts`: `METHOD_IDS` / `readsPrototypeMethod`
   cover both prototypes from the same table instead of the
   `NATIVE_OBJECT_PROTOTYPE_METHODS` slice.
3. **The call** — `dynamic-prototype-methods.ts`: `RealmMethod` gains
   `Function.prototype.call` / `.apply`; `prototypeMethodOfCall` recognises
   them from the same table. The algorithm, when the value read is the
   realm's built-in (the existing `strict_eq` branch):
   - `call`: the dispatcher call `js.closure.call:<n>` with
     `[thisArg ?? undefined, receiver, …rest]` — the call
     `dynamicConstruct` already writes. IsCallable is the dispatcher's own
     TypeError for a non-closure; a built-in receiver
     (`hasOwnProperty.call(o, k)`) is the dispatcher's run-time abort, as
     today for any built-in called through a value.
   - `apply`: no `argArray` → the 0-argument call. Otherwise a kind chain on
     `argArray`: `undefined` / `null` → the 0-argument call; a primitive →
     TypeError "CreateListFromArrayLike called on non-object"; an object or
     function → the run-time abort (array-likes belong to Session B's arrays).
4. **Tests**: `f.call(o)` / `f.apply(o)` bind `this`; `f.call(o, 1, 2)` passes
   arguments; `f.apply(o, 1)` throws TypeError; `f.apply(o, [1])` aborts
   (pinned as the expected limit); an own `call` property and a user
   `Function.prototype.call` read are not the built-in and take the
   dispatcher; detached `var c = f.call; c()` aborts, never a wrong value.

### Slice C: `bind` (yield ceiling +10)

Plan written after A and B land, with a measured run: a bound function is a
function value the dispatcher must call (its target, `this` and leading
arguments), so it needs a value representation, not a call-site shape. The
cluster's sites are all `f.bind(t)()`, but writing that shape alone would be a
per-site special case, which this plan does not take.

### Reuse and duplicates removed

- Reuses: `js.object.init-function` and its `define` helper; the object arm's
  has-then-branch; `typeErrorThen`; P1's built-in identity branch; the
  dispatcher call `dynamicConstruct` writes; `irFunctionCodeStrictness`.
- Removes: the two parallel "unpopulated keys" sets in
  `builtin-prototype-keys.ts` (one helper over the catalog), and the
  Object.prototype-only `METHOD_IDS` slice in `native-realm-requirements.ts`.

### Acceptance

- Correctness: each slice's pin tests fail on main and pass; the Prepared
  census of the 72 files passes at least the measured count, reported with the
  main sha; no file in the 552-file candidate set (`.caller|.apply|.call|.bind`
  in ES5) moves from pass to fail.
- Bytes: JS-environment and ordinary-pipeline output byte-identical to main on
  the equivalence corpus sample the earlier #7354 slices used.
- Quality: no new module; each arm sits beside its siblings in the same
  shape; no function over its budget without a grant the review accepts; the
  two duplicates above are gone; adversarial review verdict in the PR body.

## Measurement

`c3b7be66`, `.tmp/pcensus.mts` (scripts/ir-census/prepared-census.mts plus the
trap's abort row and every abort row of the program), 552 ES5 files that use
`.caller|.apply|.call|.bind`: 1 pass, 142 fail, 409 compile error. Of the 72
cluster files, those whose only non-harness aborts are this cluster's (an
estimate of the ceiling, not a measured pass count): `caller` only 38,
`call`+`caller` 8, `call` 2, `apply`+`caller` 8, `apply` 4, `bind`+`caller` 8,
`bind` 2, write `caller` 2.
