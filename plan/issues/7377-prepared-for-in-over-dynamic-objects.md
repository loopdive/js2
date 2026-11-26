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
# 2026-11-26 (implementation): growth the plan's "no growth grants" did not foresee, each reason below.
# - src/ir/from-ast.ts +132: the for-in lowering's head, receiver and liveness arms (`forInHead`, `forInReceiver`), the
#   identifier-write split (`identifierWriteTarget` / `storeIdentifierWrite`, which assignment and the for-in head
#   share) and the module-init model read (`moduleInitScriptVarModel`). They sit beside the lowering they extend and use
#   from-ast's private context (`LowerCtx`, `lowerExpr`, the scope); a module of their own would import from-ast and
#   close an import cycle.
# - src/ir/module-bindings.ts +23: the required script-var model threaded through the resolver's declaration helpers
#   (one parameter line each); no logic moves.
# - src/codegen/index.ts +2, src/ir/integration.ts +2, src/ir/program-source.ts +2, src/ir/select.ts +2: the model at
#   each call site of a required parameter (the model has no default by design). The four functions below grow by one
#   row; each is a pre-existing god-function whose split is outside this slice.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/module-bindings.ts
  - src/codegen/index.ts
  - src/ir/integration.ts
  - src/ir/program-source.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/codegen/index.ts::generateModule
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
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

## Implementation Plan (revision 2, after PRV-O5's PLAN BLOCKER on ebbfa8680d)

Reviewer points are cited as R1–R9.

### Scope

- **In scope: script-level for-in.** That covers a `var` head (`for (var k in o)`) and an identifier head
  (`var k; for (k in o)`), over a dynamic receiver. All 21 sample rows are this shape.
- **Function-level for-in on the Prepared path stays refused, by name** (R4).
  - The Prepared path does not hoist function `var`s today. Measured on main: `function f(){ for (var i = 0; i < 2;
    i++) {} return i; }` and `function f(){ if (true) { var x = 1; } return x; }` both get the U abort body.
  - So there is no declared binding for a function head to write. A loop-private slot would be a wrong answer without
    the ordinary selector's gates.
  - `lowerForInStatement` refuses "for-in head in a function: function `var` hoisting is not modelled on the Prepared
    path". The function keeps its abort body, as today, but the refusal now has a name. The slice that hoists
    function vars lifts it.
- **Not in scope:**
  - member heads (`for (o.p in x)`) and destructuring heads (refused by name, R3);
  - `let`/`const` heads;
  - `with` (Session B's).

### Gate: Prepared-only admission, ordinary and legacy output unchanged by construction (R2)

`isModuleInitVarList` (`src/shared/var-declaration-lists.ts`) keeps its current answers. Its callers today:

- legacy: `isHoistedScriptVar` → `registerModuleGlobal` / Program ABI observation (`src/codegen/module-global-registration.ts:195`);
- the ordinary selector: `select.ts`;
- ordinary integration: `integration.ts`, through `moduleInitBindings`;
- the shared IR modules.

Not one of them changes.

- A for-in head becomes a script var only under an explicit **script-var model** argument. It has two values:
  - `"statement-and-for-heads"`: today's predicate, verbatim;
  - `"with-for-in-heads"`: adds a script-level for-in head that has one identifier declaration and no initializer.
- The model is a **required** parameter of `isModuleInitVarList` and `isModuleInitGlobalDeclaration`, and of the IR
  entry points that reach them (`moduleInitBindings`, the module resolver factory in `module-bindings.ts`,
  `buildIrModuleInitPlan`). A default could let a caller miss it silently, so there is none.
- **The gate itself:**
  - Every legacy, ordinary-selector and ordinary-integration call site passes `"statement-and-for-heads"`, so its
    answers are today's by construction.
  - The Prepared producer passes `"with-for-in-heads"`: `program-source.ts`, its module resolver and init plan,
    `source-dynamic-provenance.ts`. So does the resolver capability the producer installs for from-ast
    (`scriptVarModel()` on the `nativeDynamicLane` resolver of `source-dynamic-contracts.ts`).
  - from-ast's `moduleInitContainsNestedVar` and `lowerVarDecl` read the model from `cx.resolver`. An absent
    capability means the ordinary model.
- **Proof obligation, as a unit test:** both models answer the same on every declaration list that is not a for-in
  head, and the ordinary model answers `false` on a for-in head.
- **Bytes:** `check:prepared-bytes` (804 programs) and the 13 playground examples × default/standalone are compared
  against main as a confirmation, not as the argument.

### Enumeration runtime

**Plan type.** `dynamicForInPlan()` (`src/ir/from-ast.ts`) returns four `IrFuncRef`s `{ keys, len, get, has }`.

- `integration.ts` returns `irRuntimeFuncRef` of today's four symbols: byte-identical.
- The Prepared resolver returns `irIntrinsicFuncRef` of three new contracts, plus `js.object.has`.

**The walk (R1).** A new module `src/runtime/wasmgc/values/own-key-walk-bodies.ts` (native-runtime in
`scripts/compiler-boundaries.json`) holds one instruction builder: for each own key of an object, in the order of the
kernel's `ownKeys`, it yields **every** key with its enumerable bit, Symbols included.

- `ownKeys` is `buildBuiltinFunctionOwnKeys` (`builtin-function-property-bodies.ts`). Its order is the ordinary
  [[OwnPropertyKeys]]: array indices ascending through the kernel's `keyBefore`, then strings in insertion order,
  then Symbols (R9).
- The enumerable bit is `ownDescriptor`'s attribute word `& 2`.
- `buildDescriptorsDefineDefinition`'s inline `collect` (`object-static-bodies.ts`) moves onto it **unchanged in
  meaning**: Symbol-keyed descriptors stay included. This is the duplicate removed. A Symbol-keyed
  `Object.defineProperties` pin is added; it is refused today if `Symbol` cannot be named on the path, and then the
  pin is the walk's unit test on a kernel fixture.

**List accessors (R7).** The walk, descriptors-define and the new rows use one accessor set: the realm's argument
vector (`src/runtime/wasmgc/values/argument-vector-bodies.ts`, which owns `new` and `push`).

- It gains `argumentVectorLength` and `argumentVectorElement` instruction builders.
- descriptors-define's local `vector`/`element` closures are deleted in favour of them.
- No second list accessor exists.

**`js.object.for-in-keys(object) → vector`.** EnumerateObjectProperties as a snapshot, in the same module.

- **Receiver** (R6, fail-closed):
  - `undefined`/`null` → the empty vector (§14.7.5.6 step 6.b);
  - a carrier the kernel's `ownKeys` serves (the realm object struct, `bag`'s cast) → walked;
  - **every other carrier** → `unreachable`, under the O2b abort comment convention: number, boolean, string, an
    unknown carrier.
  - Never an empty list for a primitive. That removes the pristine-prototype argument for `for (k in 5)`, which
    nothing on the path enforces.
  - Strings: `string-own-keys-body.ts` / `string-exotic-bodies.ts` serve String **wrapper** objects. A string
    primitive needs ToObject first, which the path cannot do ("unknown class String" is its own wall), so the
    abort is needed.
  - Arrays, functions and `arguments`: walked exactly when they are kernel-served realm objects, aborted otherwise.
    A test pins which ones the path can produce today, so the decision is made by the carrier, not by a list.
- **Chain:** from the receiver to a null prototype, through the kernel's prototype field.
- **Per key:**
  - Symbols are skipped (§14.7.5.9: string keys only).
  - A key already in `seen` is skipped. `seen` gets every string key, enumerable or not, so a non-enumerable own key
    hides an inherited enumerable one.
  - Comparison uses the kernel's `sameValue`.
- **Added during iteration** (R9): keys added after the snapshot are not visited. The spec allows either; this is
  pinned.

**Rows** in `ROWS` (`native-source-objects.ts`):

- `js.object.for-in-keys`;
- `js.object.key-list-length`, `js.object.key-list-get`: adapters over the two argument-vector builders.

The contracts are declared in `ordinary-object-callables.ts` and the manifest. The #3518 contract pins move by three.

### The lowering (`lowerForInStatement`, one lowering for both pipelines)

**Head shapes, in order, before anything is emitted (R3):**

- **A `var` list:** unchanged.
- **An identifier expression** (new arm): its binding is resolved like an assignment target.
- **Any other expression** (`o.p`, a pattern): an `IrUnsupportedError`, "for-in head is not an identifier". It is
  never the plain `Error` "init shape drift": with a Prepared plan present, that was a compiler crash.

The ordinary selector never admits a non-declaration head, so its output does not move.

**Head write: one mechanism for a resolved binding (R4).** `lowerIdentifierAssignment` splits into:

- resolving the write target: scope slot, module binding (`resolveModuleBinding`), ref cell or object member;
- a core that stores a lowered value into it.

The assignment's rhs becomes a callback that lowers into the target's type. A for-in head whose name resolves to a
binding (a script var, or an identifier head) writes the key through that core. Reads after the loop, body writes and
closures then see the binding itself.

**Which head gets which write:**

- The loop-private slot stays only where the head resolves to no binding. That is the ordinary pipeline, where the
  selector refuses a head already in scope (`forin-head-shadow`) and every module-init head (`forin-head-module-var`).
  Its bytes are unchanged.
- On the Prepared path an unresolved head is the function-level case, refused by name above.

**Order (R5).** The binding write moves inside the live branch, after `has`. A key deleted mid-loop then never
reaches `k`, and node keeps the previous key. The ordinary slot write stays where it is, to keep its bytes; it is
unobservable there.

**Dynamic home.** The script-var home classifier (`module-binding-script-var-home.ts`) and the provenance
(`source-dynamic-provenance.ts`) count a for-in head as a write of a dynamic value (a key string). So the head binding
gets the dynamic home, and body reads compose as dynamic.

### Legacy (R8)

Legacy standalone's `__object_keys_forin` (`src/codegen/object-runtime-enumeration.ts`) already implements
EnumerateObjectProperties. It cannot be reused: it reads codegen's own object layout, not the realm kernel's object
struct and property map.

Retiring it, once the ordinary standalone lane enumerates realm objects, is
[#7466](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7466-retire-legacy-standalone-forin-helpers), filed in
this PR.

### Nit carried from RV7415

In `src/runtime/wasmgc/values/source-object-bodies.ts`, the `SourceObjectSetOperands` alias moves above its function's
JSDoc.

### Acceptance

**Correctness**, in a new `tests/issue-7354-o5-for-in.test.ts` (the O2 harness: the right answer returns, a wrong
answer throws, node agrees). Run programs:

- **Order.** `for (var k in o)` visits keys in [[OwnPropertyKeys]] order, integer keys ascending first.
- **Identifier head.** `var k; for (k in o)`. The key is read after the loop and by a function.
- **Wrong twins (R4).** Read after the loop, a body write to `k`, and a closure over `k`. Each must equal node.
- **Non-enumerable.** A property from `Object.defineProperty` is skipped.
- **Prototype chain.** In an `Object.create(proto)` chain, an inherited enumerable key is visited, and one hidden by
  a non-enumerable own key is not.
- **Nullish receivers.** `null` and `undefined` run no iteration.
- **Delete (R5).** `delete` of the last key during the loop, then `k` read after it, equals node. If `delete` is
  refused on the path, this is a named pin.
- **Added keys (R9).** A key added during iteration is not visited.

Pins:

- runtime aborts for number, boolean and string receivers;
- named refusals for:
  - a member head;
  - a destructuring head;
  - a function-level for-in;
- a Symbol key is never visited (a kernel-fixture unit test, if `Symbol` cannot be named on the path);
- the script-var model proof (see the gate);
- the descriptors-define Symbol pin (R1);
- every refusal pin the change moves.

Also:

- the O, O1–O4, P1, U and #3518 contract suites pass;
- the byte confirmation in the gate section;
- the 411 sample: no lost row, the before/after tally and the 21 rows' new first walls go in the PR.

**Mutations**, run and reported:

- drop the enumerable test;
- drop `seen` (no shadowing);
- stop the chain at the receiver;
- write the head before liveness;
- the script head writes a private slot;
- the primitive arm returns the empty vector;
- the walk skips Symbols (must fail the descriptors-define pin).

**Code quality:**

- one for-in lowering;
- one own-key walk, shared with descriptors-define;
- one argument-vector accessor set;
- one identifier-write core, shared by assignment and the for-in head;
- the script-var model is one required parameter, not a forked predicate;
- no new legalization arm;
- no growth grants;
- import-cycles, ir-layering and the boundaries inventory keep their counts.

A fresh-context adversarial review (diff + this plan) runs before `hold` is released, and its verdict goes in the PR
body.

## Implementation notes (2026-11-26, branch `claude/7354-o5-impl` from 46ae062ad4)

Built as revision 2 describes, with these deviations, each measured or ordered:

- **The model is never defaulted (lead order of 2026-11-26, replacing PRV-O5's N1).** Every resolver that lowers a
  module-init unit names its model: the ordinary integration `"statement-and-for-heads"`, the Prepared producer
  `"with-for-in-heads"`. from-ast reads it through `moduleInitScriptVarModel`, which refuses the unit by name
  ("module-init resolver names no script-var model") when a resolver has none. No other resolver lowers a module-init
  unit (the linear one does not).
- **The Prepared capability is on every Prepared lane, not only `nativeDynamicLane`'s resolver.** The producer uses
  `"with-for-in-heads"` on every lane, so its from-ast resolver (`program-source-units.ts`) must say so on every lane;
  on the native lane alone, the refusal above would hit every module-init of the other lanes. A for-in there still
  refuses ("dynamic for-in runtime is unavailable"): only the native lane has the realm contracts.
- **Liveness is typed as the contract's Boolean** (`IR_BOOL`) on both pipelines: the Prepared ABI join compares the
  call's type with the declaration exactly. The brand is structural; ordinary bytes are unchanged (below).
- **A concrete receiver is boxed (`forInReceiver`).** Measured: `var x = 5; for (var k in x) {}` reached the old
  invariant ("for-in receiver lost dynamic carrier"), a compiler crash, because no selector stands in front of the
  Prepared lowering. A boxable primitive now reaches the snapshot, which aborts; anything else refuses by name.
- **An identifier head that names a binding other than a script var** (a block `let`, a `with` field) refuses by name
  ("is not a script var"): the identifier-write core then only ever stores a key into a module global.
- **Dynamic home: no code beyond the model.** `identifierWritesOf` already lists a for-in head as a `key` write, which
  the provenance counts as possibly dynamic (`storesCarry`); the classifier only needed the model to see the head's
  declaration (`moduleBindingDeclarations`).
- **A third accessor, `argumentVectorEach`:** the loop the walk, the snapshot's `seen` test and descriptors-define's
  apply pass share, beside `argumentVectorLength` / `argumentVectorElement`.
- **descriptors-define's body changes order, not meaning:** the walk owns its `ownKeys` call, so the record vector is
  created before it instead of after. `newVector` only allocates.
- **N3.** A script-level `for (k in o)` without a declaration refuses ("assignment to undeclared identifier"). A
  function's for-in refuses by the function message whatever its head, `var k; for (k in o)` included (the named
  refusal, not a write of the declared local).

Pins moved: #7372 "a for-in head var" (now stops at the array receiver: "resolver cannot register vec for array
literal"), F0 "for-in over the global object" (now `this`), T "a dynamic for-in head" (now the function message), and
the #3518 contract table (three rows).

### Measured (2026-11-26)

- **Tests:** `tests/issue-7354-o5-for-in.test.ts` 22/22. The `tests/issue-7354-*` files (str2c-dynamic-add skipped), the
  #3518 contract and provider files, #7372, #7106 lever S and propertyHelper, #3520 class identity, #3797, #3518
  startup and #3523: 2,555 of 2,557 pass. The two failures fail identically on the base 46ae062ad4 (#3523 "detects the
  legacy all-statics-before-statements reordering", #7354 O "refuses what the later steps build").
- **Mutations**, each caught: no enumerable test (2 tests fail), no `seen` (2), chain stopped at the receiver (3), the
  binding written before `has` (1, the code-order pin), a `var` head kept in the private slot (3), an empty list for a
  primitive (4), a walk that skips Symbols (2, the fixture's walk pin among them).
- **Ordinary bytes:** the 13 playground examples × default and standalone, 26/26 identical to 46ae062ad4.
- **Prepared bytes:** `scripts/prepared-byte-identity.mts`, 804/804 rows identical to 46ae062ad4. No row calls
  `Object.defineProperties`, so descriptors-define's reordered body is not in that set.
- **Equivalence gate** (`node scripts/equivalence-gate.mjs`, the whole directory): no new regression; 4,849 passing,
  the 20 failures all in its baseline (2 baseline failures pass, not banked).
- **411-row sample** (`TEST262_COMPILER_PATH=ir`, standalone; base = main bb9123f6a3, 83 pass): 91 pass, 0 lost, 8
  gained (`Object/defineProperty` 15.2.3.6-3-46, -3-51, -3-67, -4-46, -4-355, -4-424, -4-509 and
  `Object/defineProperties` 15.2.3.7-5-b-14). Of the 26 rows that stopped at the nested-var refusal, the 20 for-in rows
  moved: 8 pass, 12 stop at a later wall (a built-in global or class not in scope yet, `this` at script level, or an
  inferred `string[]`). The 6 left there are `with` rows: the 5 the Problem section counts and S13.2.2_A19_T8, a
  `var` inside `with` that the 21 above counted as for-in.
