---
id: 7561
title: "Prepared path: wrapper objects and reachable wrapper prototypes on main's realm model (W2's remainder)"
status: ready
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
depends_on: [7350]
related: [7350, 7354, 7352, 7557, 7560]
---

# #7561 — wrapper objects on main's realm model (W2's remainder)

## Problem

Two lanes built wrapper constructors on the Prepared path (`TEST262_COMPILER_PATH=ir`, standalone):

- **Main** has #7350 B3a and B3b-0: `String`, `Number`, `Boolean` are realm values with identity rows
  (`realmConstructorId`, `RealmFamily`, `HELD_FAMILIES`, `modelledRow`), the conversion calls, Number's five
  constants, and the complete catalog data for the three families (not held yet).
- **W2** (`origin/claude/7354-w2`, closed PR 7515) built the same constructors with another model (`familyRows`,
  `ProgramFamilies`, `dynamic-realm-constructors.ts`) and went further: wrapper objects, reachable prototypes,
  `valueOf` / `toString`, and `Object` as a value.

Owner decision 2026-11-27: main's model stays. W2 is reduced to what main lacks and rebuilt on main. Three slices are
stacked on W2 and move onto the result: A1a (`origin/claude/7354-a1`, #7352), A1b-1 (`origin/claude/7354-a1b`,
#7557), A1b-2 (`origin/claude/7354-a1b2`, #7560).

Measured 2026-11-27 with `git merge-tree --write-tree` against `origin/main` `99be816c6d`: W2 conflicts in 23 files;
A1a and A1b each in 26 (W2's 23 plus `dynamic-realm-calls.ts` and two test files).

## Behaviour: W2 against main today

"Verified" rows were compiled and run on main `99be816c6d` on 2026-11-27 (10 Prepared compiles, one process, each
program asserting node's answer). The other rows are from reading main's code and the #7350 result sections.

| # | W2 capability (its test `tests/issue-7354-w2-wrappers.test.ts`) | main today | how known |
| --- | --- | --- | --- |
| 1 | `typeof`, identity, `length`, `name` of `String` / `Number` / `Boolean` | works | verified |
| 2 | the same for `Object` (`var O = Object; typeof O`) | refuses: `identifier "Object" is not in scope` | verified |
| 3 | `X.prototype`, `X.prototype.constructor === X`, the descriptor of `prototype` | refuses by name: `String.prototype is not reachable on this path yet (#7350 B3bc)`; a run-time key aborts | verified (static); reading (run-time key) |
| 4 | `Number.MAX_VALUE`, `MIN_VALUE`, `NaN`, the infinities; the descriptor of `MAX_VALUE` | works | verified |
| 5 | `Number.EPSILON`, `MAX_SAFE_INTEGER` | refuses by name (`Number.EPSILON is not reachable …`); W2 answers | verified |
| 6 | `String(v)`, `Number(v)`, `Boolean(v)`, absent argument, `Number(null)`, an object operand through `valueOf` / `toString` | works, `String(object)` included | verified (two programs) |
| 7 | `new String(v)` / `new Number(v)` / `new Boolean(v)`: `typeof`, truthiness, `valueOf()`, `toString()` | refuses: `new String (a wrapper object; #7350 B3bc)` | verified |
| 8 | a wrapper's ToPrimitive (`+`, arithmetic, `String(w)`, `Number(w)`) | refuses (row 7's wall) | reading |
| 9 | a String wrapper's own `length` and index keys, their attributes, redefining an index | refuses (row 7's wall) | reading |
| 10 | `Object(v)`, `new Object(v)`, `new Object()` | refuses | verified |
| 11 | `"a" instanceof String` (a primitive) | works (false) | verified |
| 12 | `w instanceof X`, `X.prototype.isPrototypeOf(w)`, `String instanceof Object` | refuses (rows 2, 3, 7) | reading |
| 13 | `Object.prototype.toString.call(w)` tags, `w.constructor` | refuses (row 7's wall) | reading |
| 14 | a wrong receiver of `valueOf` / `toString` is a catchable TypeError | refuses (needs row 3) | reading |
| 15 | a wrapper as an ordinary object: own properties, `defineProperty`, `===`; an own `valueOf` override | refuses (row 7's wall) | reading |
| 16 | writes to a wrapper prototype, read back through a wrapper and through a primitive | refuses (row 3) | verified (`String.prototype.foo = 3`) |
| 17 | a function body sees the program's families (`function f(x){ return x.message; }` with an error built at top level) | works for the Error family; the wrapper programs refuse | verified (error); reading (wrappers) |
| 18 | `typeof String.fromCharCode`, `typeof Object.keys` | W2 aborts at run time; main refuses by name (stricter, sound) | reading |
| 19 | `var C = String; new C("a")` | run-time abort on both (the dispatcher's built-in arm) | reading |
| 20 | `new Number(255).toString(16)` | W2 aborts; main refuses at `new Number` | reading |
| 21 | `var String;` | refuses by name on both | reading |
| 22 | `new Number(1) == 1` | refuses on both (main at `new Number`, before loose equality) | reading |

No row is a wrong value on main. Every W2 capability main lacks is a refusal or an abort there.

## The delta, and where each item goes in main's model

Three items. Items 1 and 3 are what #7350 already plans as B3b-1 and B3b-2 (reviewed twice, PRV-B3 and PRV-B3bc);
item 2 is outside #7350's B3 ("`Object(v)` / `new Object(v)`: not here"). **This plan does not write a second design
for item 1: #7350's "Slice B3bc" and "Target structure" sections stay the specification.** What this issue adds is
the donor map from W2 and the deviations listed below.

### Item 1 — wrapper objects and reachable wrapper prototypes (this issue)

Behaviour rows 3, 7, 8, 9 (`length` only), 12 (without `Object`), 13, 14, 15, 16, 20.

| layer | module in main's model | extends | from W2 | size (estimate) |
| --- | --- | --- | --- | --- |
| contract | `src/runtime/contracts/native-realm-catalog.ts` | `wrapperRows`; `modelledRow` models the prototype rows; the constructor rows stay identity rows and gain `prototype` in their `identityOnly` list; `NATIVE_MEMBERS` gains `valueOf` / `toString` of the three; ids appended to `NATIVE_VALUE_INTRINSICS` | rewritten: W2's `familyRows` / `Family` is not taken, main's rows already hold the data | 60 |
| contract | `src/ir/runtime/ordinary-object-callables.ts`, `runtime/contracts/manifest.ts` | `js.object.create-wrapper(value, selector)`, `js.object.wrapper-data(object, selector)` beside `js.object.create-error` | unchanged from W2 (the same two rows, review r1) | 10 |
| runtime body | `src/runtime/wasmgc/values/primitive-wrapper-bodies.ts` | thisXValue beside the existing allocation and payload read | W2's `buildWrapperDataDefinition` and its `SLOT` table move here; W2's `realm-wrapper-bodies.ts` is not added as a file | 130 |
| runtime body | `string-create-body.ts`, `realm-family-bodies.ts` | a row with `primitiveData` is allocated as a wrapper, a String one by StringCreate | W2's change to `realm-family-bodies.ts` (number values, wrapper allocation) carries over where main lacks it; W2's stored index properties (`stringOwnProperties`) are **not** taken (#7350 decided: no materialised indices) | 40 |
| backend | `src/backend/wasmgc/resources/native-realm-wrappers.ts` (W2's file), `native-realm.ts`, `native-builtin-functions.ts`, `native-source-objects.ts` | the existing owners `native-primitive-wrapper-layouts.ts` / `-storage.ts` become live, reserved only where a wrapper family is held; the extensible `$Object` root only then | W2's `native-realm-wrappers.ts` composes those owners already: carried, minus its string-index part; its `native-builtin-functions.ts` extensible check (`wrapperSubtypes`) carried | 250 |
| IR keys | `src/ir/program/builtin-prototype-keys.ts` | the selector tables beside `WRAPPER_CONVERSIONS`; `NUMBER_PROTOTYPE` / `STRING_PROTOTYPE` read from the catalog | W2's `WRAPPER_DATA` / `WRAPPER_OF_PRIMITIVE` carried; its `wrapperConstructorSelector` family lookups are replaced by `realmConstructorId` | 50 |
| IR recogniser | `src/ir/program/dynamic-realm-calls.ts` | `realmConstructorOf` generalises to the one recogniser that also answers `%X.prototype%` | rewritten on main's function; W2's `realmConstructorOf` in `dynamic-realm-constructors.ts` is not taken | 30 |
| IR construction | `src/ir/program/dynamic-wrapper-constructors.ts` | `new X(v)`: `WRAPPER_CONVERSIONS`' conversion, then `create-wrapper`; the `gap` goes | W2's construct arm of `dynamic-realm-constructors.ts` re-expressed over `WRAPPER_CONVERSIONS` (W2's `CONVERSION` table is the duplicate that is dropped) | 30 |
| IR methods | `src/ir/program/dynamic-prototype-methods.ts`, `ordinary-to-primitive.ts`, `dynamic-value-chains.ts` | one realm-method-by-identity table for P1's call expansion and OrdinaryToPrimitive; the `errorToString` hook and P1's `toString` special case become rows of it | W2's `dynamic-builtin-methods.ts` (`identityTest`, `wrapperMethodTest`, `builtinMethodChain`) is that table: carried, placed in `dynamic-prototype-methods.ts` or kept as its own module, one of the two | 150 |
| IR tag | `src/ir/program/dynamic-object-tag.ts` (W2's file) | the `dyn.object_tag` arm of `dynamic-value-legalization.ts` moves out; a wrapper's tag by its payload kind | carried; its `b.families.*` reads become `holdsFamily(program, …)` | 80 |
| IR member access | `src/ir/program/dynamic-member-access.ts` | the primitive read arm of a held kind (deviation 1 below) | W2's read arm carried; its `unheldStaticKeys` is replaced by main's `identityOnlyKeyRefusal` | 80 |
| IR holds | `src/ir/program/native-realm-requirements.ts`, `dynamic-value-kinds.ts` | the wrapper row of `HELD_FAMILIES` (members, the two contracts, the per-member pin and the whole-family trigger of #7350 condition 2); `holdsFamily` | rewritten: W2's `heldFamilyMembers` and `ProgramFamilies` are not taken | 90 |
| tests | `tests/issue-7561-wrappers.test.ts` | W2's `VALUES`, `WRITES` and `FUNCTION_BODIES` programs, minus `Object` and the index rows | carried | 220 |

About 1,000 source lines and 220 test lines. No change to `src/ir/from-ast.ts` and none under `src/codegen/`.

**Deviations from #7350's B3b-1** (each needs the owner's yes; see "Open questions"):

1. **A primitive's member read goes through the held prototype in this slice**, as W2 does
   (`js.object.get(%X.prototype%, key, primitive)`), instead of B3b-1's interim refusal. Reason: `assert.js`'s
   `compareArray.format` reads `String` as a value, so every program with the harness prelude holds the String family
   (W2 result, "Cost"); an interim abort on every dynamic string member read would then sit in every test262 row.
   A primitive's member *write* stays B3b-1's refusal or abort; #7350 B3b-2 replaces it with step 2.b.
2. **The constructor rows stay identity rows.** They gain `prototype` only. Statics (`String.fromCharCode`,
   `Number.isNaN` as values, `Number.EPSILON`) keep refusing by name and trapping on a run-time key. Reason: a
   complete constructor row makes `var N = Number; N.isNaN = f; Number.isNaN(1)` answer the folded built-in, a wrong
   value, until #7350's escape rule (its slice 1) lands. So `modelledRow`, `identityOnlyKeyRefusal` and the kernel
   mark stay; #7350 retires them after the escape rule. Row 5 stays a refusal.
3. `Number.prototype.toString(radix)` and `%RangeError%` holding stay with #7350 (row 20 becomes an abort or a
   refusal by name, as on W2).

**Not taken from W2, with the reason:**

- Stored String index properties: main's decision is #3518's exotic arm (#7350 B3c). Until then a constant index
  key, and an own-key enumeration, on a String wrapper are the interim aborts #7350 names. `length` is an own data
  property from StringCreate.
- W2 holds only `valueOf` / `toString` and treats every other prototype member as unheld. A key computed at run time
  then misses: `var k = "index" + "Of"; String.prototype.hasOwnProperty(k)` would answer false (from reading W2's
  holding rule; PRV-B3bc finding B1 describes the same hole). The implementer runs this program on the W2 head first.
  Main's model closes it with the per-member pin and the whole-family trigger, which this slice implements.
- `programObjects.constructors` (a set of ids): main's `realmFamilies` is the same fact.

### Item 2 — `Object` as a realm value (second issue, new id)

Behaviour rows 2, 10, 12 (`Object` parts), and `Object.prototype` as a value.

| layer | module | extends | from W2 | size |
| --- | --- | --- | --- | --- |
| contract | `native-realm-catalog.ts` | `%Object%` and `%Object.prototype%` appended to `NATIVE_VALUE_INTRINSICS`; `%Object%` becomes an identity row (`length`, `name`, `prototype`) | W2 appended the same ids | 20 |
| IR keys | `builtin-prototype-keys.ts` | a third `constructors("object", ["Object"])` row of `REALM_CONSTRUCTORS`; no new table | rewritten | 15 |
| IR construction | `dynamic-wrapper-constructors.ts` | `Object(v)` / `new Object(v)`: the kind chain (nullish → a new object, object or function → itself, primitive → `create-wrapper`) | W2's Object arm carried | 60 |
| IR member access | `dynamic-member-access.ts` | a primitive of a kind whose family is not held reads through `%Object.prototype%` once the program can obtain it | W2's `obtainsPrototypes` rule, expressed as `holdsFamily(program, "object")` | 40 |
| IR holds / walk | `native-realm-requirements.ts`, `source-plain-objects.ts` | the `object` row of `HELD_FAMILIES`; `familyRead` skips the call forms the front end folds | W2's `realm-constructor-forms.ts` predicates carried where main has no equal one | 60 |
| tests | `tests/issue-<id>-object-value.test.ts` | W2's rows 2, 10, 12 | carried | 100 |

About 200 source lines. Statics as values (`Object.keys` read as a value) are **not** in it: they need the escape
rule first, and A1b (#7557) brings them with its built-in caller.

### Item 3 — a primitive's member write (step 2.b)

#7350 B3b-2, unchanged, in the #7350 lane: the optional `primitiveReceivers` operand of
`buildSourceObjectSetDefinition`. W2 has no code for it (it aborts where the key is found). No new id here.

## What A1a and A1b take from W2, and its equal in main's model

Read from `git diff origin/claude/7354-w2...origin/claude/7354-a1 -- src` (2,694 diff lines) and
`git diff origin/claude/7354-a1...origin/claude/7354-a1b -- src` (1,806 diff lines).

| used by | W2 symbol | equal in main's model | move |
| --- | --- | --- | --- |
| A1a | `familyRows(ARRAY_FAMILY)`, `Family` | an `arrayRows` builder beside `errorRows` / `wrapperRows`, same helpers | rewrite the catalog hunk (about 70 lines) |
| A1a, A1b | `ProgramFamilies` (`families.errors`, `.wrappers`, `.arrays`, `.prototypes`, `.methodNames`), 13 + 19 changed lines | `holdsFamily(program, family)` with `"array"` a new `RealmFamily` | mechanical rename per site |
| A1a | `program.objects.constructors` (`constructors.add(ARRAY_ID)`) | `realmFamilies.add("array")` in `programObjects` | mechanical |
| A1a, A1b | `dynamic-realm-constructors.ts` (`dynamicRealmConstruction`, `arrayLiteral`, the `%Object%` / `ARRAY_ID` list) | `realmConstructorOf` in `dynamic-realm-calls.ts`; a `dynamic-array-constructors.ts` beside the Error and wrapper ones | rewrite (the file does not exist on main) |
| A1a | `dynamic-object-tag.ts` | the same file, from item 1 | applies as is |
| A1a | `WRAPPER_DATA`, `WRAPPER_OF_PRIMITIVE` in `builtin-prototype-keys.ts` | the same names, from item 1 | applies as is |
| A1a | the extensible `$Object` root | item 1 (declared where a wrapper family is held; A1a adds "or the array family") | one condition |
| A1a | `unheldWrapperPrototypeKeys`, `heldFamilyMembers` | `modelledRow` and the `HELD_FAMILIES` row | rewrite (about 30 lines) |
| A1a | `holdsErrors` | `holdsFamily(program, "error")` | mechanical |
| A1b | `identityTest`, `wrapperMethodTest`, `builtinMethodChain`, `BuiltinMethodBuilders` | the realm-method-by-identity table of item 1 (W2's code, carried) | applies as is if item 1 keeps the names |
| A1b | `functionChainAnswer`, `%Object.prototype%`, `%Function%` as values | main's `functionChainAnswer`; item 2 for `%Object.prototype%`; `%Function%` is A1b's own | A1b's hunks re-applied |
| A1b | Object statics read as values (`Object.defineProperty` at `propertyHelper.js` L28–30) | **gap**: needs complete `%Object%` rows and the escape rule (#7350 slice 1) | named dependency |

**Method.** A merge is not realistic: 26 conflicting files, and after the delta lands A1a's hunks on W2-only files
(`dynamic-realm-constructors.ts`, the `ProgramFamilies` sites) have no base at all. Each slice is a new branch from
the delta head:

- files A1a adds or changes outside W2's ground are taken unchanged with `git checkout origin/claude/7354-a1 -- <path>`:
  `realm-array-bodies.ts`, `native-realm-arrays.ts`, `prepared-array-literal.ts`, `descriptor-word.ts`, the
  descriptor bodies, `static-predicates/*`, `native-realm-literals.ts`, and its three test files;
- the hunks in the 23 source files W2 also changed (of the 36 A1a touches) are re-implemented against main's symbols, by the table above;
- the old branches stay as the reference until each replacement is merged.

**Order.** #7561 (item 1) → item 2 → A1a re-based (#7352) → A1b-1 (#7557) → A1b-2 (#7560). A1a needs only item 1,
so item 2 and A1a can run side by side. A1b-1 needs item 2 and #7350's escape rule.

## Slices

| # | issue | content | size |
| --- | --- | --- | --- |
| 1 | **#7561** | item 1: wrapper objects, the three prototypes, `valueOf` / `toString`, tags, a primitive's read through a held prototype | about 1,000 source lines |
| 2 | new id (1 needed) | item 2: `Object` as a realm value | about 200 source lines |
| 3 | #7352 (exists) | A1a on the new base | A1a's size; 23 source files re-implemented, 13 taken unchanged |
| 4 | #7557 (exists) | A1b-1 on the new base | as today |
| 5 | #7560 (exists) | A1b-2 | as today |

One new id (`node scripts/claim-issue.mjs --allocate`). If the review finds slice 1 too large, it splits into
"kernel, contracts and construction" and "methods by identity, ToPrimitive, tags, primitive read", which needs a
second new id; the first half then keeps `new X` behind an abort for every use of the wrapper's value.

## Acceptance criteria

### Slice 1 (#7561)

Correctness:

1. These programs agree with node on the Prepared path, at module level and inside a function, each also asserted
   with a wrong answer that must fail: W2's `VALUES` rows for wrappers (rows 7, 8, 12, 13, 14, 15 of the table,
   without `Object`), its three `WRITES` rows, and its `FUNCTION_BODIES` rows; plus from #7350's list:
   `new Number(1) !== new Number(1)`, `var n = new Number(NaN); n === n`, `typeof Number.prototype`,
   `Number.prototype.toString()` "0", `String.prototype.length` 0, `Boolean.prototype.valueOf()` false,
   `new String("abc").length` 3 with its descriptor, `new Number(1) + 1` in a program with no source function,
   `var w = new Number(2); w.valueOf = function () { return {}; }; w + 1` "21", and
   `var k = "index" + "Of"; String.prototype.hasOwnProperty(k)` true.
2. Five of the function-body programs also pass through the real harness prelude (`assert.js`, `sta.js`).
3. What stays out refuses by name or aborts, and never answers: a String wrapper's index key and own-key
   enumeration; a primitive's member write where the kind's family is held; `toString` with a radix; a static of a
   constructor; a constructor called through a variable; loose equality with a wrapper.
4. Never a wrong value, a trap where JavaScript throws a catchable error, invalid Wasm, or an exception out of
   `compile()`.
5. Ordinary-pipeline output is byte-identical (`prove-emit-identity`), and `check:prepared-bytes` shows no changed
   row among programs that hold no wrapper family.
6. `src/ir/from-ast.ts` does not grow. No `loc-budget-allow` or `func-budget-allow`.

Code quality (CLAUDE.md, "IR path: code quality comes first"):

7. One family table (`REALM_CONSTRUCTORS`), one held-family table (`HELD_FAMILIES`), one catalog builder per family
   in `errorRows`' shape, one recogniser, one conversion table (`WRAPPER_CONVERSIONS`), one realm-method-by-identity
   table used by P1's call and by ToPrimitive.
8. None of W2's parallel names exists after the slice: `familyRows`, `ProgramFamilies`, `heldFamilyMembers`,
   `dynamic-realm-constructors.ts`, `realm-wrapper-bodies.ts`, a second `CONVERSION` table.
9. The `errorToString` hook, P1's `toString` special case, and the hand lists `NUMBER_PROTOTYPE` /
   `STRING_PROTOTYPE` are removed in this slice.
10. Any new `src/` file is classified in `scripts/compiler-boundaries.json` in the same commit.
11. A fresh-context adversarial review, given the diff and this plan, with its verdict in the PR body.

### Slice 2 (`Object`)

1. Node agreement, with a wrong twin each: rows 2, 10 and the `Object` parts of row 12; `Object.prototype.foo = 1;
   (5).foo` 1; `Object(o) === o`; `typeof Object(null)`.
2. `var O = Object; O.keys = function () { return 1; }; Object.keys({})` never answers the built-in's result (it
   aborts or refuses, as an identity row does).
3. Criteria 4, 5, 6, 10, 11 of slice 1.
4. Code quality: `Object` is a row of `REALM_CONSTRUCTORS` and `HELD_FAMILIES`, not a special case beside them;
   `Object(primitive)` calls slice 1's `create-wrapper`, with no second wrapper path.

## Overlap with the #7350 lane's next steps

Read from `plan/issues/7350-ir-builtin-globals-foundation.md` on main and `origin/claude/7350-b3b1` (`bd1ef2b05b`,
plan text only, no code yet).

| #7350 step | state | overlap |
| --- | --- | --- |
| slice 1, expando fix and the escape rule | planned, own PR | none in code. Slice 2 here and A1b depend on it for complete constructor rows |
| **B3b-1**, wrappers, ToPrimitive, holding | planned; branch `claude/7350-b3b1` exists | **the same work as slice 1 of this issue.** Exactly one lane may build it |
| B3b-1 first step: `String.prototype[@@iterator]` row, the `requires` nit | planned (review RV7504) | must be done before `%String.prototype%` is held, so it is part of slice 1 here if this lane builds it |
| B3b-2, a primitive's [[Get]] / [[Set]] | planned | slice 1 takes the read half (deviation 1); the write half stays there |
| B3c, String exotic, sloppy `this` of a primitive | planned | none; slice 1 leaves the interim aborts B3c removes |
| B3d, String / Number method algorithms | not planned yet | none |
| B2b (`claude/7350-b2b`), the global object | unmerged | its global `String` / `Number` / `Boolean` / `Object` properties must read `js.object.intrinsic` once these are values |
| `Object(v)` / `new Object(v)` | explicitly outside B3 | slice 2 here; no overlap |

## Open questions for the owner

1. **Who builds B3b-1?** Slice 1 here and #7350's B3b-1 are one piece of work. Proposal: this lane builds it under
   #7561 from W2's code, to #7350's specification; the #7350 lane closes `claude/7350-b3b1` and continues with the
   escape rule, B3b-2's write half, B3c and B3d.
2. Deviation 1: may slice 1 take a primitive's read through the held prototype (half of B3b-2), because the harness
   holds the String family in every row?
3. Deviation 2: may the constructor rows stay identity rows until the escape rule lands, so that slice 1 does not
   wait for #7350's slice 1?
4. W2 answered a String wrapper's index keys; on main's model they abort until B3c. Is that loss accepted for the
   A1 stack? (Not checked: whether any A1a or A1b test reads a String wrapper's index.)
5. A1b reads Object statics as values. Does the escape rule land first, or does A1b's re-base carry it?

## Not verified

- W2's behaviour was read from its test file and result sections; nothing was run on the W2 head.
- Rows marked "reading" in the behaviour table.
- The sizes are estimates from W2's diff (`+2,475 / −503` over 50 files for all of W2).
- The computed-key miss on the W2 head (item 1, "Not taken from W2").
