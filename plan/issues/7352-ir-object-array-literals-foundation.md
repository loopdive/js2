---
id: 7352
title: "IR foundation: object literals are open objects; array literals share the typed vec slot"
status: in-progress
sprint: current
created: 2026-11-16
updated: 2026-11-27
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7349, 7350, 7353, 7335, 7280, 7338, 7339, 7292]
---

# #7352 — IR foundation: object and array literals

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only"). Direction since 2026-11-15 (`CLAUDE.md`, "IR
migration: foundations first"). This is the third foundation, after function
values (#7349) and built-in globals (#7350).

On standalone the legacy compiler stores `var o = { a: 1 }` in a closed-struct
slot and switches to the open object only when the object later gets
expandos, accessors or computed keys. It stores arrays in typed vec slots.
The IR has no binding for either slot, so it refuses the declaration
(`vardecl-module-storage-unrepresentable`). The IR's own closed struct cannot
reach a dynamic consumer at all: `Object.keys(o)` is refused, and
`o.hasOwnProperty("a")` is claimed and then withdrawn on main.

The only literal the IR can hold as an open object is `{}` (#7335), with the
Object statics table (#7338) and the own-property rows (#7339) acting on it.

## Measured

Standalone, 2026-11-16, main `8045884222`. Research record: session scratch
`objfound/research.md` (not in the repository; the tables that matter are
copied here).

**Inventory** (2026-11-14 census rows, confirmed by recompiling a 387-file
sample): 1,704 blocked ES5 files carry an object- or array-literal refusal.
In 109 it is the only refusal family; all 109 are still blocked.

| module `var` initialiser | files | only family |
| --- | ---: | ---: |
| `[]` | 357 | 10 |
| data-only object | 322 | 10 |
| array of primitives | 191 | 20 |
| object with function values | 159 | 33 |
| numeric keys | 26 | 1 |
| array with holes | 20 | 2 |

In expression position: `{ toString / valueOf }` objects 93 files (11 only
family), `{}` as an argument 65 (9), getters and setters 53 (8), an object
literal of module values 83.

**How the objects are used** (2026-11-15 tally of 492 module-level
object-literal bindings): 378 are passed as an argument to a built-in
(`String(o)`, `Object.*(o, …)`, `Array.prototype.x.call(o)`). A closed struct
that only static code can read is the wrong representation for them.

**What works across the boundary today:** the native runtime reads a legacy
struct handed to an IR unit (`__extern_get`, `__object_keys` cover every
registered struct type; boxing keeps identity).

**Ceiling** (throwaway tree: this family's refusals, and reads of
literal-initialised variables, admitted at selection) on the 109 only-family
files:

| outcome | files |
| --- | ---: |
| claim every unit | 3 |
| pass selection; fail only because the variable has no binding (the missing home) | 65 |
| pass selection; from-ast then withdraws (operand types 6, function-valued properties 6, dynamic initialiser 2, empty-array hint 1) | 15 |
| still refused at selection (element store 7, callable or ambiguous value type 8, borrow or predicate receivers 6, other 5) | 26 |

On the 194 `propertyHelper.js` files whose first own refusal is this family
(the harness itself stays refused): 81 are left with only the harness's own
refusals; 77 next stop at `Object.defineProperty(obj, "foo", desc)` with
`desc` held in a variable; 15 at function values; 21 other.

Also found: `var o = { a: 1 }; o.b = 2` is claimed and then withdrawn on main
("proven dynamic binding 'o' initializer has no supported carrier").

## Implementation Plan

### Target structure

Two representations, each with one owner, and no shape that the IR has to
copy from legacy.

- **Objects are built open from the start.** On standalone, a script `var`
  initialised with an object literal gets the dynamic home, for legacy and IR
  alike. Legacy's widening pre-pass (the one that widens when it sees
  expandos) widens every such literal. The slot is then `externref`, which
  the existing dynamic home already binds: no new binding kind. The IR builds
  the object with the `{}` carrier and the own-property write path that
  exist.
  - Rejected alternative: the IR binds legacy's closed struct and boxes it at
    each dynamic use. It is sound, but the IR would have to reproduce
    legacy's struct shape for every literal, which is a copy of legacy's
    shape inference.
  - Cost, accepted: a hash lookup where legacy had a struct field read, and
    no static `Object.keys` / `hasOwnProperty` fold for these bindings.
  - Side effect: legacy's struct-typed parameter refinement disappears for
    these values, which removes one of the parity mismatches #7353 describes.
- **Arrays keep legacy's typed vec slot, as a binding kind.** The string-vec
  home (#7292, `src/ir/module-binding-vec.ts`) is extended to number vecs and
  "any" vecs. The slot's element type is the whole contract and
  `scriptVarHome` already reports it, so nothing is mirrored. `[]` followed
  by pushes takes its element type from the slot. The IR boxes the vec at a
  dynamic use.
- **What it reuses.** The dynamic home, the open-object carrier, the
  own-property write path, the Object statics table, the vec home.
- **What duplicates it removes.** The closed-struct special cases for script
  `var` object literals on standalone, in legacy and in the IR's refusals;
  the `string`-only restriction of the vec home.

### Slices

"Estimate" means not measured; each slice re-measures on current main before
it starts and reports compiled results.

| slice | content | yield | depends on |
| --- | --- | --- | --- |
| O1 | data-only module-level object literals, open on both sides | estimate 10 to 20 only-family files | |
| A1 | `vec<f64>` and `vec<any>` homes; `[]` typed from the slot | estimate about 30 only-family files | |
| O2 | open literals in any value position (argument, operand, return, property value) | 9 only-family files | O1 |
| O3 | a descriptor held in a variable, in the Object statics table | 77 `propertyHelper.js` files reach "harness only" | O1 |
| O4 | function-valued properties (`toString`, `valueOf`, methods) | 33 + 11 only-family files | #7349 S1b |
| O5 | getters and setters | 8 only-family files | #7349 S1b |

O1 + A1 + O2 have a measured ceiling of 68 of the 109 only-family files.
O1 + O3 bring 158 of the 194 `propertyHelper.js` files down to "harness
only"; they pay out when #7350 G4, #7349 S1a and #7353 have also landed.

### Hazards to prove per slice

1. **Changing what legacy stores changes legacy verdicts.** O1 touches every
   standalone program with a script `var` object literal, in every edition.
   Measure verdicts across all editions for every file whose standalone
   binary changes, with QuickJS and the Temporal provider built locally. No
   pass to fail.
2. **Legacy fast paths lose their precondition.** List each legacy fold that
   assumed the closed struct (`Object.keys`, `hasOwnProperty`, `for-in`,
   `in`, descriptor reads, `String(o)` with `toString`) and prove with probes
   against node that the open path answers the same.
3. **Performance.** Report the size and a timing of the playground benchmarks
   that use object literals in script variables, before and after. A
   regression is reported, not hidden; the JS environment is unaffected.
4. **Property order and numeric keys.** An open object must enumerate in
   specification order (integer keys ascending, then insertion order). Probe
   it.
5. **Refusing at select drags IR callers to legacy.** Measure units newly
   legacy on a wide control set.

### Constraints

- Standalone only; no new host imports; JS-environment output
  byte-identical.
- No test verdict regresses in any edition; no unit that main lowers on IR
  is lost; refuse at select, never claim and then withdraw.
- No copy of legacy's struct shape inference in the IR.
- No budget grant for `select.ts` or `from-ast.ts` beyond a dated, justified
  one.

## Acceptance criteria

Per slice:

1. Census on the 1,704 carrier files and 500 IR-only control files: files
   gained, files lost 0, units newly legacy 0, new compile errors 0,
   post-claim errors not increased.
2. Verdicts across all editions for every file whose standalone binary
   changes: no pass to fail.
3. A probe matrix against node for the slice's shapes and consumers, at
   module level and inside a function: nothing claimed answers differently,
   and nothing legacy answered correctly is now wrong.
4. JS-environment output byte-identical on the changed files and on 200
   others.

Code quality:

5. One home decision per literal kind, asked by legacy and IR; no
   closed-struct agreement check left for script `var` object literals on
   standalone.
6. The vec home is one module for all element kinds.
7. A fresh-context adversarial review per slice records its verdict in the
   PR body.

## Re-build on #7561 (2026-11-27)

Arrays as realm values on the Prepared path were built once as slice A1a (`origin/claude/7354-a1` `c86f46cc81`, on
the closed W2 stack; review rounds r1 and r2 in #7354's file on that branch). W2's family model was not taken; main's
realm model with #7561 (`origin/claude/7561-wrappers` `10273019db`) is the base. This section plans the
re-implementation there. It is not a port: the old branch is a donor, file by file, and is never merged
(`git merge-tree` against main: 26 conflicting files).

For this path the criteria of this section replace the "Census" criteria above (#7380 bans census rows, receipts
and hash / count / text pins).

### A1a's own diff, classified against the new base

`git diff origin/claude/7354-w2...origin/claude/7354-a1 -- src scripts`: 37 files, +1,418 / −197. Each file's diff
was tried with `git apply --check` on the #7561 head; "applies" means textually, not that it type-checks.

**(a) Carries over unchanged: 16 files, +810 / −33.**

| file | lines | note |
| --- | --- | --- |
| `src/runtime/wasmgc/values/realm-array-bodies.ts` (new) | +456 | ArrayCreate, `array-define` (§10.4.2.1), ArraySetLength (§10.4.2.4) |
| `src/backend/wasmgc/resources/native-realm-arrays.ts` (new) | +96 | the reservations; imports only main's symbols |
| `src/shared/contracts/descriptor-word.ts` (new) | +30 | `DESCRIPTOR_WORD`, `FULL_DATA_DESCRIPTOR` |
| `src/ir/prepared-array-literal.ts` (new) | +40 | needs `ARRAY_LITERAL_HELPER` from class (b) |
| `ordinary-object-descriptor-common.ts`, `-definitions.ts` | +87 / −8 | `ORDINARY_OBJECT_DESCRIPTOR_ENCODING` gains `errorData`, `arrayExotic`; `ifArrayBrand`; the define hook's two callers |
| `source-object-bodies.ts` | +28 / −4 | OrdinarySet's array arm (`throw` 0) |
| `object-layouts.ts` | +10 | `OBJECT_FIELD`, `PROP_ENTRY_FIELD` |
| `builtin-function-bodies.ts` | +5 / −5 | flags by name |
| `native-realm-literals.ts` | +16 / −5 | only held members' keys become literals |
| `native-object-descriptors.ts`, `prepare-ordinary-object-access.ts`, `manifest.ts` | +11 / −5 | contract rows |
| `static-predicates/lowering.ts`, `selection.ts` | +21 / −5 | `realmHolds` without a default |
| `ordinary-to-primitive.ts` | +10 / −1 | the brand test first (`isArray`, `answer.unsupported`); re-check against #7561's rewrite of this file |

**(b) Carries over with mechanical renames: 16 files, +246 / −112.**

| file | lines | rename |
| --- | --- | --- |
| `dynamic-value-kinds.ts`, `dynamic-value-chains.ts`, `dynamic-value-legalization.ts`, `dynamic-prototype-methods.ts`, `dynamic-object-tag.ts` | +94 / −34 | `ProgramFamilies` (`families.arrays`, `.errors`, `.prototypes`) → `holdsFamily(program, "array")`; `holdsErrors` → `holdsFamily(program, "error")` |
| `source-plain-objects.ts` | +3 / −1 | `objects.constructors.add(ARRAY_ID)` → `realmFamilies.add("array")` (what `constructorRead` already does for a new family row) |
| `dynamic-realm-calls.ts` | +12 | `ARRAY_LITERAL_HELPER`, `isArrayLiteralCall`: as is |
| `function-object-lowering.ts`, `from-ast.ts` | +35 / −42 | the literal arm and `realmStatics(resolver)`; from-ast must end at or below its base (17,396 lines) |
| `native-realm.ts`, `native-realm-families.ts`, `native-source-objects.ts`, `native-builtin-function-requests.ts` | +34 / −7 | the extensible `$Object` root "where a wrapper family is held" gains "or the array family"; `js.object.create-array`, `js.object.has-brand` rows |
| `ordinary-object-callables.ts` | +6 / −2 | the two contract rows |
| `realm-family-bodies.ts` | +37 / −25 | `markObjectFlag`, `%Array.prototype%` allocated as an array; re-applied on #7561's version |
| `scripts/compiler-boundaries.json` | +25 / −1 | regenerated, not applied |

**(c) Rewritten: 5 files, +362 / −52.**

| file | lines | what is written instead |
| --- | --- | --- |
| `native-realm-catalog.ts` | +74 / −2 | `familyRows(ARRAY_FAMILY)` → an `arrayRows()` builder in `wrapperRows`' shape (constructor, prototype with `array: true` and `length` 0, one row per static and method, each `heldWith` itself); `%Array%` an identity row with `isArray` and `prototype` |
| `builtin-prototype-keys.ts` | +33 / −20 | `constructors("array", ["Array"])`; W2's `ARRAY_ID` lists go |
| `dynamic-realm-constructors.ts` (absent on the base) | +65 / −1 | `realmConstructorOf` stays in `dynamic-realm-calls.ts`; a new sibling `dynamic-array-constructors.ts` holds `arrayOf` (the one ArrayCreate-then-CreateDataProperty helper), `Array(…)` / `new Array(…)` and the literal's legalization |
| `native-realm-requirements.ts` | +13 / −3 | an `array` row of `HELD_FAMILIES`; the per-member pin of #7561 over the array prototype (`unheldWrapperPrototypeKeys` / `heldFamilyMembers` are not taken) |
| `dynamic-member-access.ts` | +177 / −26 | `computedAccess` (the computed-key subset arrays need) on #7561's `memberAccess`; W2's `unheldStaticKeys` → `identityOnlyKeyRefusal`. The other lane builds computed keys on object literals and `in`: one of the two lanes owns the computed-key arm, to be agreed before this file is touched |

Tests: `tests/issue-7354-a1-arrays.test.ts`, `-array-values.test.ts`, `-array-limits.test.ts` (437 lines) carry over
as programs; their refusal texts are re-read on the new base. The 18 other test files A1a touched are re-derived
from failures, not applied.

### Requirements carried from A1a's reviews

1. **No ToPrimitive through a user-written `Object.prototype.toString` (r2, a wrong value).** OrdinaryToPrimitive
   tests the array brand first and aborts before reading `toString` or `valueOf`, whatever the chain holds, until
   `Array.prototype.toString` and `join` exist. Test: `Object.prototype.toString = function () { return "z"; };
   String([1, 2])` aborts; so do concatenation, a template, unary `+`, `Number()`, `<`, a computed key `o[[1]]` and
   `new Error([1, 2])`. With #7574 the root is obtainable, so more programs reach this row than on A1a.
2. **No compile-time exception for a for-of over an array (r1, the blocker).** The literal is a dynamic value at its
   source, not a raw externref a function local keeps. The consumer sweep of r1 (30 consumers × function-local
   array, script array, literal operand) is re-run: each cell answers, aborts or refuses; none throws out of
   `compile()`.
3. **The literal is carried as operands of one helper symbol (r2).** `__ir_array_literal` with the length (f64), then
   each present element's index key and value. No length or index in the symbol text, no parser.
4. One descriptor-word table (`descriptor-word.ts`); no `191` literal. One brand dispatch (`ifArrayBrand`), one flag
   mark, one `asOrdinaryObject` (r1 quality points 2–4).
5. `js.object.has-brand(o, REALM_BRAND)` replaces `js.object.is-error`; one body for both brands.
6. `staticPredicatePlan`'s `realmHolds` has no default (r1 point 5).
7. Every write path into an array goes through `array-define` (A1a's table of eight paths); kernel seeding bypasses
   it only for `%Array.prototype%`'s own `length`.

### The first array PR (#7352)

`propertyHelper.js` needs, in its order: `Array.isArray` as a value (line 27), `Array.prototype.join` and `push` as
values (lines 31–32), then inside `verifyProperty` an array literal, `failures.length` and `names[i]` (lines 80–93).
A1a's diff is about 1,600 changed source lines, above the ~1,000 guideline, so it is two PRs:

| PR | issue | content | changed source lines |
| --- | --- | --- | --- |
| A | **#7352** | the realm side (class (a)'s runtime, backend and shared files; the catalog; the contracts) and the smallest IR that reaches it: `Array` as a value, `Array.prototype`, `Array(…)` / `new Array(…)`, `Array.isArray`, `length` read and write, constant index keys (`a[0]`, `a["0"]`), "[object Array]", `instanceof Array`, ToPrimitive's abort | about 1,150, of which 622 are the four new files taken unchanged |
| B | new id | the array literal (`prepared-array-literal.ts`, the from-ast arm, `arrayOf` shared with PR A), computed index keys (`a[i]`), the consumer sweep | about 450 |

If the owner prefers one PR of about 1,600 lines (the #7561 precedent was 1,460), A and B merge under #7352 and no
id is needed.

Held, not built: `Array.prototype.join` and `push` (and every other prototype method) are rows the realm holds by
#7561's pin rule, so `Array.prototype.join` is a function value with the right identity, `length` and `name`, which
`Function.prototype.call.bind` can take once #7557 and #7560 exist. Calling one through the dispatcher is the
run-time abort, as for every held built-in today.

Out of PR A and B: every Array.prototype method body; `Array.from` / `of`; spread; destructuring; for-of's iterator
(a for-of over an array aborts or refuses, never throws at compile time); a `length` value that is a string or an
object; `delete a[i]`; a dense element store.

Acceptance, PR A and B:

1. A1a's 152 probes and r1's consumer sweep agree with node or abort / refuse as recorded there, each agreement with
   a wrong twin; 0 wrong, 0 invalid Wasm, 0 exceptions out of `compile()`.
2. The seven requirements above, each with a test row.
3. `var A = Array; A.isArray = f; Array.isArray([])` never answers the built-in (the identity row; `isArray` is
   called by identity, not folded).
4. Ordinary-pipeline output byte-identical; Prepared output byte-identical for programs that hold no array family;
   `src/ir/from-ast.ts` does not grow; no new IR to runtime import edge (budget 10).
5. The prelude (`assert.js` + `sta.js` + one assertion; `compareArray.format` names `Array`) is measured before and
   after: bar 15 KB and 1 s, as on A1a (+7.5 KB there). The pin rule's cost with a computed key (all 38 prototype
   methods held) is measured on one `propertyHelper.js` program and reported.
6. Code quality: `arrayRows` in `wrapperRows`' shape; `array` a row of `REALM_CONSTRUCTORS` and `HELD_FAMILIES`; one
   pin function for wrapper, object and array prototypes; none of W2's names (`familyRows`, `ProgramFamilies`,
   `dynamic-realm-constructors.ts`, `unheldFamilyPrototypeKeys`) exists afterwards; new modules classified in
   `scripts/compiler-boundaries.json`; a fresh-context adversarial review with its verdict in the PR body.

### The order after it

1. **`Function` as a value and `Function.prototype.call` (#7557).** Base: #7561 + #7574 + PR A. Mined from
   `origin/claude/7354-a1b` `affccb6fe4`: `realm-builtin-caller.ts` (the lifted caller function),
   `builtin-caller-bodies.ts`, `dynamic-builtin-call.ts` (the identity ladder), the `BuiltinCall` interface over
   P1's algorithms, `%Function%` in `REALM_CONSTRUCTORS`. About 1,800 diff lines on the old branch, so two PRs: the
   caller route with the already-held methods through values (a detached `hasOwnProperty`), then `Function` and
   `call`; one new id. Review findings to carry: `new` of a held built-in method must throw (use the other lane's
   `NativeRealmIntrinsic.constructible`, drop A1b's own IsConstructor check); Function.prototype's own properties
   must give one answer to [[Get]], has-own and descriptor queries (the pin rule, or `is-partial`: #7574's open
   question 2); the nine old tests that asserted aborts are re-derived. Agreed regression from the other lane:
   `S15.5.3.2_A3_T2` (save `String.fromCharCode`, delete the property, call the saved reference), plus replacement
   of the property and reassignment of the variable to a non-callable value.
2. **`bind` and `apply` (#7560).** Base: #7557. Not mined for code (the old branch `claude/7354-a1b2` is local
   only); the plan text is #7557's "Next session" list: BoundFunctionCreate as a closure-root subtype holding
   target, `this` and a realm array of arguments, `length` / `name` per §20.2.3.2 (a target whose `length` is an
   accessor aborts), a bound rung that prepends the bound arguments; `apply` with CreateListFromArrayLike of a realm
   array (any other array-like aborts). About 500 lines. After it lines 31–34 of `propertyHelper.js` run.
3. **`Array.prototype.join`, `push`, `toString` bodies (new id).** Base: #7560 and PR B. From #7557's plan, "New
   algorithms": the legalization builders gain a `slot` and a `loop` (no legalization writes a loop today; this is
   new shared builder code and is sized first). `join` gives an array its ToPrimitive, which removes requirement
   1's abort. About 500 lines. Finding to carry: requirement 1 stays true for an array whose `toString` the program
   overrides (the override is called, not the built-in).
4. **`Object` statics as values (#7574's slice 2, new id)** can land anywhere after #7574; its caller rung needs
   #7557.
5. **`Object.getOwnPropertyNames` and `keys` (#7574's slice 3, new id).** Base: PR A and slice 2. The kernel's
   own-key walk into a realm array. It makes the pin rule's "whole family" trigger apply to these two contracts
   (they list non-enumerable keys). About 300 lines.

Not in this order and not owned here: `Math.pow` (line 35), `arguments.length` (`dyn.publish_argc`), `delete`,
for-in, the JSDoc flow rule, `JSON`.

New ids for this plan: PR B, #7557's second half, the join / push bodies; with #7574's two, five in all.
