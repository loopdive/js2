---
id: 7377
title: "#7354 O5: for-in over dynamic objects on the Prepared path, module-level heads included"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, backend, runtime
goal: ir-full-coverage
depends_on: [7354]
related: [7354, 3518, 2952, 2964]
origin: "2026-11-19 #7354 slice O plan (O5, id reserved by ttraenkler/c-lead); assigned 2026-11-26 by the lead"
---

# #7377: for-in over dynamic objects on the Prepared path

## Problem

Measured on main bb9123f6a3 (2026-11-26), strict Prepared entry, standalone:

| Program | Result |
|---|---|
| `var o = {a:1,b:2}; var s = ""; for (var k in o) s += k; …` (script level) | refused: `module-init unit contains a nested var declaration` |
| `var o = {a:1}; var k; for (k in o) {} …` (script level, no `var` head) | refused: `dynamic for-in runtime is unavailable in <module-init>` |
| `function f(){ var o = {a:1,b:2}; … for (var k in o) … }` | compiles; `f` gets the #7354 U abort body (`unreachable`), for the same `unavailable` refusal |

There are two causes:

1. **No enumeration runtime.** `lowerForInStatement` (`src/ir/from-ast.ts`) asks the resolver for
   `dynamicForInPlan()`. Only the ordinary pipeline's resolver (`src/ir/integration.ts`) supplies it. Its plan is four
   legacy runtime symbols: `__object_keys_forin`, `__extern_length`, `__extern_get_idx` and `__extern_has`. The
   Prepared resolver (`src/ir/source-dynamic-contracts.ts`) supplies none.
2. **The head is not a script var.** `isModuleInitVarList` (`src/shared/var-declaration-lists.ts`) models `var`
   statements and `for (;;)` heads anywhere in script code, but excludes for-in and for-of heads. So
   `moduleInitContainsNestedVar` refuses every script-level `for (var k in o)`.

On the 411-row ES5 sample (main bb9123f6a3, 83 pass), 26 rows stop at the nested-var refusal:

- 21 are `for (var p in o)` over objects built with `{…}`, `Object.defineProperty`, `Object.defineProperties` or
  `Object.create`. These are this issue's.
- 5 are `with` (Session B's).

## Implementation Plan

### What exists, and what this reuses

- **The lowering.** The ordinary pipeline already has the right loop shape in `lowerForInStatement`: a key snapshot,
  its length, the key at an index, and a per-visit liveness check (#2952 / #2964). This plan keeps that one lowering.
  It does not add a second for-in lowering.
- **The realm kernel** (#3518):
  - `ownKeys` returns a realm vector of keys in [[OwnPropertyKeys]] order, Symbols included;
  - `ownDescriptor` gives the attribute word (enumerable = 2);
  - `sameValue` compares keys.
- **The existing own-enumerable walk.** `buildDescriptorsDefineDefinition` (`src/runtime/wasmgc/values/
  object-static-bodies.ts`, its `collect` step) is ObjectDefineProperties step 3. It walks `ownKeys` and keeps a key
  when its `ownDescriptor` word has the enumerable bit. That is the "own enumerable keys" walk, inlined in one body.
- **Liveness.** `js.object.has` (HasProperty, an existing row) is the per-visit check.
- **Contract calls.** These reuse the O pattern: `irIntrinsicFuncRef(feature)`, plus a row in `ROWS`
  (`src/backend/wasmgc/resources/native-source-objects.ts`) and a declaration in
  `src/ir/runtime/ordinary-object-callables.ts` and the manifest.

### Is there an own-enumerable-keys realm row on main?

No. The rows are `create-*`, `define-*`, `get`, `set`, `has`, `has-own`, `own-descriptor`, `descriptor(s)-define`,
`inherits`, `intrinsic`, `is-error`, `error-to-string` and `init-function`.

### Why for-in and Object.keys share a walk, not one row

for-in is EnumerateObjectProperties (§14.7.5.9). Object.keys and JSON.stringify are EnumerableOwnProperties (§7.3.23).
They differ in two ways:

- for-in walks the prototype chain;
- for-in skips a key that an earlier object on the chain already had, **even a non-enumerable one** (a
  non-enumerable own `x` hides an enumerable `x` on the prototype).

So a row that returns only enumerable own keys cannot build for-in, and a for-in row is not Object.keys.

The shared unit is one runtime walk: "for each own string key of `object`, in order, with its enumerable bit". It
lives in one new runtime module, and three bodies use it:

1. **`js.object.for-in-keys(object) → keys`** (new row, this issue): the EnumerateObjectProperties snapshot.
   - A nullish receiver gives an empty list. That is the for-in early exit (§14.7.5.6, step 6.b).
   - For an object, each object on the chain runs the walk, from the receiver to a null prototype. A key goes into a
     `seen` list once. It goes into the result only when it was not yet seen and is enumerable.
   - A primitive receiver gives an empty list for numbers and booleans: ToObject's wrapper and its prototypes hold no
     enumerable string keys while the prototypes are pristine, the O precondition. A string receiver (index keys)
     aborts with `unreachable`, under the O2b comment convention, until a string slice owns it. Implementation checks
     which carriers the kernel serves and pins each choice in a test.
2. **descriptors-define** (existing): its `collect` step moves onto the same walk. **This is the duplicate the plan
   removes.**
3. **Object.keys / JSON.stringify** (later, not built here): their row is the walk over one object, with no chain and
   no `seen` list. It is named `js.object.own-enumerable-string-keys` when a lane admits one of them. A row with no
   caller would be a speculative abstraction, so this issue does not add it.

If the reviewer prefers the literal "one row", the alternative is one row `js.object.enumerable-string-keys(object,
walkChain)` with an `i32` flag. I recommend against it: today the flag has one value, which is a dead parameter.

### Target structure

| Concern | Module | Change |
|---|---|---|
| Own-string-key walk with enumerable bit | `src/runtime/wasmgc/values/enumerable-keys-bodies.ts` (new, native-runtime in `scripts/compiler-boundaries.json`) | the walk, plus `buildForInKeysDefinition`; the key list's length and indexed read, if the vector has no such functions yet |
| descriptors-define | `object-static-bodies.ts` | `collect` uses the walk |
| Served rows | `native-source-objects.ts` `ROWS` | `js.object.for-in-keys`, and `js.object.key-list-length` / `js.object.key-list-get` (bindings if the realm vector already has those functions, adapters otherwise) |
| Contracts | `ordinary-object-callables.ts`, `contracts/manifest.ts` | the three features. The #3518 contract pins (`CONTRACTS`, the "pins all N identifiers" count) move with them |
| Plan type | `from-ast.ts` `dynamicForInPlan` | returns four `IrFuncRef`s instead of four symbol strings, so each resolver names its own targets |
| Ordinary resolver | `integration.ts` | returns `irRuntimeFuncRef` of the same four symbols. Byte-identical |
| Prepared resolver | `source-dynamic-contracts.ts` (the `nativeDynamicLane` resolver block) | `dynamicForInPlan` = the three new contracts, plus `js.object.has` |
| Script-level head | `var-declaration-lists.ts` `isModuleInitVarList` | admits a for-in head: one declaration, an identifier, no initializer |
| Head write | `lowerForInStatement` | when the head list is modelled (`cx.moduleBindings` and `isModuleInitVarList`), each visit writes the key to the script var through the same write `lowerVarDecl` uses, instead of a loop-private slot; body reads resolve through ordinary scope. Function-level heads keep today's slot |
| Nit from RV7415 | `source-object-bodies.ts` | move the `SourceObjectSetOperands` alias above its JSDoc'd function |

There is no new legalization arm. The four calls are contract calls on the externref carrier, which the for-in
lowering already emits.

The function-level case on the Prepared path (today an abort body) comes with item "Prepared resolver" at no extra
cost.

### Risks to check in implementation

- **The modelled-list predicate is shared with the ordinary pipeline** (`integration.ts` → `module-init-vars.ts`).
  Admitting for-in heads may let the ordinary IR claim a script-level for-in it refuses today. The acceptance needs
  identical ordinary bytes. If they move, I report the measurement and the reviewer decides; I do not fork the
  predicate silently.
- **The key carrier.** On the Prepared path, the realm's key strings must read as the dynamic value's string kind
  (`asType: dynamic`, `dynamicCarrierIsExternref`). A run test checks `k === "a"` and `s += k`.

### Acceptance

**Correctness**, in a new `tests/issue-7354-o5-for-in.test.ts` (the O2 run harness: the right answer returns, a wrong
answer throws, node agrees). Run programs:

- script-level `for (var k in o)`: keys in insertion order, numeric keys first ([[OwnPropertyKeys]]);
- a script-level `var k; for (k in o)`, and the key read after the loop and by a function;
- a non-enumerable property from `Object.defineProperty` is skipped;
- an `Object.create(proto)` chain: an inherited enumerable key is visited, and one hidden by a non-enumerable own key
  is not;
- `null` and `undefined` receivers run no iteration;
- a function-level for-in (the abort body today);
- `delete` of a later key during the loop skips it, if `delete` compiles on this path. Otherwise this becomes a named
  pin.

Pins:

- a string receiver: the runtime abort;
- each refusal the change moves.

Also:

- The O, O1–O4, P1, U and #3518 contract suites pass.
- `check:prepared-bytes` (804 programs) and the 13 playground examples (default and standalone) are byte-identical
  against main.
- The 411 sample has no lost row. Its before/after tally is in the PR. The 21 for-in rows' new first walls are
  reported (an estimate, not a yield claim, until measured).

**Mutations**, run and reported:

- drop the enumerable test;
- drop the `seen` list (no shadowing);
- stop the chain at the receiver;
- the script-level head writes a private slot.

**Code quality:**

- one for-in lowering for both pipelines;
- one own-key walk, shared by descriptors-define and for-in-keys;
- no new legalization arm and no second key predicate;
- no growth grants;
- import-cycles, ir-layering and the boundaries inventory keep their counts.

A fresh-context adversarial review (diff + this plan) runs before `hold` is released, and its verdict goes in the PR
body.
