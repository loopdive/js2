---
id: 7352
title: "IR foundation: object literals are open objects; array literals share the typed vec slot"
status: ready
sprint: current
created: 2026-11-16
updated: 2026-11-16
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7349, 7350, 7353, 7335, 7280, 7338, 7339, 7292]
# 2026-11-19 (arrays slice A1, lane S13): src/ir/from-ast.ts +60 net. The array literal arm
# (`lowerOrdinaryArrayLiteral`) and the planned element read (`lowerPreparedArrayElementRead`)
# sit next to their O1 siblings and share two helpers factored out of O1's code in the same
# change (`ordinaryPropertyValue`, `ordinaryReadResult`), which removes their duplicate; moving
# them out would need `lowerExpr` and `LowerCtx` behind a host interface for two small arms.
# 2026-11-19 (A2 dynamic value, branch claude/7354-arrays-a2-dyn): src/ir/from-ast.ts +16 net. An array
# literal joins the object literal's carrier box arm (`boxConcreteToDynamic`), and the undefined-compare guard
# reads an element of a dynamic binding as the carrier (`isCarrierElementRead`, sharing `receiverBinding` with
# `isScriptVarVec`). Both sit in the scope-lookup helpers they extend; the member chain itself lives in
# src/ir/program/dynamic-member-*.ts.
# 2026-11-19 (A3 Array.isArray, branch claude/7354-arrays-isarray): src/ir/from-ast.ts +11 net. The resolver
# query `preparedArrayBrandTest` and the static-predicate host's `arrayBrandTest` (one `js.object.is-array` call),
# next to the host it extends; the arm itself lives in src/ir/static-predicates/lowering.ts.
loc-budget-allow:
  - src/ir/from-ast.ts
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

## Arrays on the Prepared path: Implementation Plan (2026-11-19)

Lane S13, branch `claude/7354-arrays` on `claude/7354-realm` (`e9e64e5d`). This is the array half of this
issue for the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`, standalone); the "A1" row of the slice
table above (`vec<f64>` homes in the ordinary pipeline) is a different, parked slice. Lane S3 holds the object
half (#7354 slice O).

### Measured on the base

- `function f(){ var a = [1, 2, 3]; return a[1] + a.length; }` and `var a = [1,2]; a[0]` both refuse with
  "resolver cannot register vec for array literal": the Prepared resolver offers no vec layout to from-ast.
- S9's stand-in census (main `ee3fcdd610`, PR #7308): array literals are the first gap of 456 positive ES5
  files, `script-var-home-array-literal` 257 and `array-literals` 198. Of the 198, 139 stop in module-init
  and 58 in the harness function `testWithIntlConstructors` (an array of strings); with the 257, about 400 of the
  456 need the script-level array (A2), not only the function-local one (A1). The stand-in `compareArray(actual, expected)` reads `actual.length` and `actual[i]` on dynamic
  parameters.
- The realm kernel has no Array object: its object layout is the final `$Object`
  (`createOpenObjectDeclaration`), its lookup admits "only an effectively final ordinary type; extensible roots
  need an authenticated heterogeneous own-property dispatcher" (`buildBuiltinFunctionLookup`). The realm already
  reserves the native vector layouts (`$Vec` carrier: length + backing array) and the vector grow/store helper
  supports a hole-global gap fill (`vector-grow-store.ts`).

### Representation (decided by the foundations rule)

**An array is an Array exotic object of the realm: `$Array`, a subtype of the realm's `$Object`, whose index
properties live in a dense element vector, the realm's own `$ObjVec` (length + externref store, already in every
realm as the argument vector); a hole is the realm's hole sentinel, a `$PropEntry`, which no ECMAScript value
is.** Named properties
(expandos) live in the inherited property map; `[[Prototype]]` is the realm's `%Array.prototype%`, an ordinary
object on Object.prototype created on first use like `objectPrototype`.

| | Array exotic object of the realm | typed vec slot (ordinary pipeline) |
| --- | --- | --- |
| index read, typed receiver | subtype test, bounds check, `array.get`, unbox (about 8 instructions) | `array.get` (about 3) |
| `.length` | `struct.get` of the vec length, box | `struct.get` |
| index write with growth | the existing grow/store helper | the same helper |
| holes `[1,,3]`, `a[5] = 1` | hole sentinel, distinct from `undefined` | `vec<f64>` cannot tell a hole from NaN without a sentinel per kind; `vec<string>` cannot |
| `compareArray(a, b)` on dynamic parameters | the object kind of the carrier (S3's O2) dispatches to it: no new carrier kind | a second object-like carrier kind, with its own row in every dynamic table (typeof, member get/set, `in`, ToPrimitive), and boxing at every dynamic use |
| expandos, `Array.isArray`, `Object.getOwnPropertyNames`, `arguments`, a RegExp `exec` result | inherited ordinary storage; one subtype test | each needs a further representation |

Costs are counted from the instruction sequences, not measured at run time. The typed vec is faster only while
the array never reaches a dynamic slot, and in the 456 files almost every array does (script `var`, harness
calls). A typed fast path, if ever measured to matter, is an element-kind specialisation of the same `$Array`,
not a second representation. Rejected therefore: the typed vec slot on this path.

### Target structure

- **Contracts** (`src/ir/runtime/ordinary-object-callables.ts`, `ORDINARY_OBJECT_RUNTIME_FEATURES`): three rows
  in the existing ordinary-object family, no new family:
  - `js.object.create-array(length: f64) -> externref` — ArrayCreate on `%Array.prototype%`;
  - `js.object.get-index(object, index: f64, receiver) -> externref` — [[Get]] with an array-index key;
  - `js.object.set-index(object, index: f64, value)` — [[Set]] with an array-index key (growth, holes).
  An index-keyed contract is how an index reaches the dense storage without a ToString round trip; on an
  ordinary object its body converts the index to its canonical string key and runs the string-keyed operation.
- **Layouts** (`native-object-layouts.ts`, `object-layouts.ts`): the realm reserves the `extensible` `$Object`
  root when the program uses an array contract, and one `$Array` subtype row in the same recipe (the pattern of
  the primitive-wrapper objects). A program without arrays keeps the final layout: its bytes do not change.
- **Kernel** (`native-builtin-functions.ts`): with `$Array` declared it owns two more globals,
  `%Array.prototype%` (an ordinary object on Object.prototype) and the hole sentinel, both allocated by its
  initializer, and accepts the extensible root because its lookup dispatches `$Array`.
- **Kernel lookup** (`builtin-function-prototype-bodies.ts`): the own-property step of `lookup` gains the
  heterogeneous dispatcher its comment asks for, one arm (`buildArrayOwnEntry`): an `$Array` answers `length`
  and canonical index keys (the kernel's existing `arrayIndex`) from the vector as a fresh data entry with the
  spec attributes, every other key from the ordinary map. `get`, `has` and every builtin that walks through
  `lookup` see arrays without their own arm. Built in A1, because `a.length` is `js.object.get`.
- **Bodies** (`src/runtime/wasmgc/values/array-exotic-bodies.ts`, new): the lookup arm, the initializer step,
  create, get-index and set-index; create reuses the ordinary object's field initialisers
  (`buildOrdinaryObjectCreateBody`), set-index stores through `buildVectorGrowStoreBody` with the hole-global gap
  fill, never a second grow loop.
- **Resources** (`native-source-objects.ts`): the three contracts are rows of its `ADAPTERS` table, served by
  the bodies above; the binding rows come from the existing `nativeSourceObjectResourceKey` /
  `planNativeSourceObjectSetup` (one binding row per callable, the shared `nativeCallAbiBindings`).
- **Front end.** The Prepared resolver (`src/frontend/builtins/prepare-ordinary-object-access.ts`) answers
  `preparedArrayLiteral(literal)` for every array literal it owns (the Prepared backend has no vec home for a
  literal) and plans typed element reads like O1's typed member reads; from-ast's `lowerArrayLiteral` takes one
  early arm to a new `lowerOrdinaryArrayLiteral` (create-array, then set-index per present element), and the
  element access / `length` lowering takes one arm onto get-index / `js.object.get(…, "length", …)`. No second
  literal lowering, no vec types on this path.
- **Dynamic value (A2, after S3's O2–O4).** An array is a value of S3's `object` carrier kind (`typeof` is
  `"object"`); `dyn.member_get` / `dyn.member_set` with a number key take the index contracts, with a string key
  the string-keyed ones; `Array.isArray` is the `$Array` subtype test (one intrinsic in the dynamic-value
  family). Rows go into S3's tables, coordinated with S3.

### Reused, and what duplicate goes

Reused: the realm's object layouts, storage, descriptor pack and kernel lookup; the native vector layout and its
grow/store helper; the source-object binding builder and reconciler; O1's typed-read plan and boundary boxes.
Removed: on the Prepared path an array literal no longer asks for a vec layout it cannot get (the
"resolver cannot register vec" refusals become either a lowering or a named refusal of a later slice).

### Slices

| slice | content | proving program | depends on |
| --- | --- | --- | --- |
| A1 | array literal in a function, typed index read, `.length` | `function f(){ var a = [1, 2, 3]; return a[1] + a.length; } if (f() !== 5) throw 1;` | realm (O1) |
| A2 | array in a script `var` / the dynamic carrier; index write with growth and holes; `length` write | `var a = [1,2]; if (a[0] !== 1) throw 1;`, `a[5] = 1; a.length === 6; a[3] === undefined` | S3 O2–O4 |
| A3 | the harness shapes: stand-in `compareArray(a, b)`, nested arrays, an array of strings, `Array.isArray`; the kernel's own-property arm | `compareArray([1, "a"], [1, "a"])` | A2, Str |

Not in A1–A3, refused by name at selection: `Array.prototype` methods (push, join, slice, indexOf, concat;
forEach / map / filter with a callback wait for lane S4's Fb); `new Array(n)` and `Array` as a value (lane S5,
#7350); spread elements; `for-in` over an array. After each slice S9's stand-in census re-runs on the two array
lists and this section records where the files stop next.

### A1 result (2026-11-19)

- Built as above. `function f(){ var a = [1, 2, 3]; return a[1] + a.length; } if (f() !== 5) throw 1;` validates
  and returns through the strict Prepared entry, standalone; with `!== 6` it throws; node agrees. Also `[]`,
  strings, nested arrays (`tests/issue-7352-a-arrays.test.ts`).
- The resolver plans a typed read only on a literal without elision or spread whose binding is only read as
  `a.length` or `a[i]` with a constant `i` inside it; get-index and set-index trap (named in their comments) on
  the receivers and keys A2 admits: a miss's prototype walk, a non-array receiver, a non-index number key.
- Refusals pinned by name: script `var` home, an array into a dynamic slot, an element store, a read outside the
  literal, a hole (unplanned `.length`), spread.
- Mutation checks: `length` answered as length + 1, and an element read one index off, each make the proving
  program throw.
- Ordinary pipeline: bytes identical on 111 files (playground examples, test262 `built-ins/Array` and
  `language/expressions` samples) × default and standalone, against `claude/7354-realm` `e9e64e5d`.
- Native async family units keep their logical-vector literals (`isPreparedArrayLiteral` defers to them).
- **Where the 455 files stop next** (S9's stand-in census, `scripts/ir-census/prepared-census.mts --harness
  stand-in`, on the two array lists, at `aecc802b`): none stops at an array literal any more; all 455 are still
  compile errors, now at

  | first gap | files | removed by |
  | --- | ---: | --- |
  | script `var` with an array/object initialiser has no typed storage ("module binding … has no exact typed storage", 259) or no dynamic carrier ("proven dynamic binding … has no supported carrier", 133) | 392 | A2 on S3's O2 home and object carrier kind |
  | `Array.prototype` method on the array: `forEach` 59 (all in `testWithIntlConstructors`), `every` 1, `filter` 1 | 61 | Array.prototype methods with callbacks, after lane S4's Fb |
  | property write on the array, a static predicate operand | 2 | A2 / S3 O3 |

### A2 rules (lead review of the plan, 2026-11-19)

1. **Sparse and huge indices never allocate.** `$Array` gets its own `length` field (a u32, held in an i32 read
   unsigned); the vector holds the dense prefix. An index write at `i` is dense when `i < vector length + 1024`
   (the density bound; growth doubles the store, as the shared helper does) and `i <= 2^31 - 2`; any other array
   index (up to 2^32 - 2) is an ordinary keyed property under its canonical index string, and `length` becomes
   `i + 1` when `i >= length` (ArrayDefineOwnProperty, §10.4.2.1). Reads look in the vector, then in the map (the
   kernel arm already falls back to `findOrdinary`). `a.length = n` is ArraySetLength (§10.4.2.4): a value whose
   ToUint32 differs from its ToNumber throws a real, catchable RangeError; shrinking cuts the vector and sets the
   length; shrinking an array that holds map indices at or above the new length is an uncatchable named abort
   (`unreachable`, its comment names it) until a slice deletes map indices. Never a wrong `length`, never an
   allocation of the index's size.
2. **One key classification per key type.** A string key is classified only by the kernel's `arrayIndex`
   (`buildStringExoticIndexDefinition`, shared with String exotic objects): `a["1"]` is index 1, `a["01"]` and
   `a["-0"]` are ordinary keys, `a["length"]` is the arm's `length`. A number key is classified only by
   `arrayIndexOf` in `array-exotic-bodies.ts` (CanonicalNumericIndexString of a number is the number:
   `a[1.0]` and `a[-0]` are index 1 and 0; `a[1.5]`, `a[-1]`, `a[2**32 - 1]` are ordinary keys and take the
   string-keyed path with ToString of the number). No other parser of array indices.
3. **"Bytes unchanged without arrays" is proven on realm programs too**: S3's O test programs compile to
   identical binaries on S3's head and on this branch. Measured 2026-11-19, `282eab42` (S3) vs `7c8ae510`: 32 non-array
   Prepared programs (the O, O2, Str2, T and X tests' programs, right and wrong answers, plus 3 refusals) have
   the same outcome on both; all 26 binaries are sha256-equal (20 of them realm-sized). Closures and `Number(v)`
   have no compiling program on either side yet, so they are not covered. Script `.tmp/bytes-realm-compare.mts`.
4. **The typed-read shortcut's precondition is checked by the compiler** (`onlyRead` in
   `prepare-ordinary-object-access.ts`: every reference of the binding is its declaration or a plain read;
   only a function's binding). The verdict of the review hunting this class in S3's object shortcut (#7312) is
   applied here when it lands.
5. **Kind.** An array is the carrier's `object` kind (`typeof` "object"); `Array.isArray` is a separate brand
   test (`ref.test $Array`), one intrinsic used where source calls it. Agreed with S3 on 2026-11-19 and built:
   `boxedKind` admits the object kind over a `js.object.create-array` value as over `create-default`
   (`dynamic-value-kinds.ts`), and an array literal makes a program unplain, "array ToPrimitive needs
   Array.prototype.join" (`source-plain-objects.ts`), until A3 brings `join`.

### A2 runtime result (2026-11-19)

Branch `claude/7354-arrays-a2-runtime` (`dcb364c2`), merged into `claude/7354-arrays` (`acb8acf4`).

- `$Array` has its own u32 `length`; `create-array` presizes at most 1024 slots. `array-index-bodies.ts`:
  get-index / set-index; `array-length-bodies.ts`: `js.object.set-length` (ArraySetLength), one new contract row.
- Rule 1 as written: a dense write through the grow/store helper below the density bound; any other index up to
  2^32 - 2 is `defineData` under its index string (from the existing String index-key body; the realm reserves its
  own physical copy of that function); reads walk vector, map, %Array.prototype%, Object.prototype; a non-array
  receiver of get-index takes the kernel's string-keyed get; a bad length throws a catchable RangeError.
- Rule 2 as written: strings through `arrayIndex`, numbers through `arrayIndexOf`.
- Named traps left: a non-index number key (1.5, -1, 2^32 - 1, NaN) on get-index / set-index (it needs ToString of
  a number, and the only formatter is program-level, `native-number-format.ts`, not reachable from the kernel);
  set-index / set-length on a non-array receiver (no `js.object.set` yet); set-length shrinking past a map index;
  get-index status 3 (not an object).
- Known imperfection: a map entry can sit under a dense slot after the vector grows over it; reads are right (the
  vector wins) but a later shrink past it aborts.
- Tests: 17 in `tests/issue-7352-a-arrays.test.ts` (8 body-level on a realm built from a typed-IR program naming the
  four contracts, `tests/helpers/native-array-realm.ts`). Mutation checks: 9 of 10 arms caught; the 2^31 - 2 limit
  cannot be reached without a 16 GB vector.
- Bytes: ordinary pipeline identical on 111 files × default/standalone vs `53357b3b`; the 32 non-array realm
  programs identical vs `53357b3b` (26 binaries sha-equal, 6 refusals).

### A2 census (2026-11-19, `e584e28d2a`, S9's stand-in census on the 455 array-list files)

No file passes yet; 130 moved to a new first gap (125 of A1's 133 "no supported carrier" script vars now have
their home), 325 did not.

| first gap | files | owner |
| --- | ---: | --- |
| script var passed to `Object.defineProperty` / `defineProperties`: "no exact typed storage: not-direct" (`arrObj` 141, `arr` 81, `obj` 27; 168 of them at the stand-in's propertyHelper-style line) | 252 | the Object statics on a dynamic home (lane S12); A2's home itself is not the blocker |
| ToPrimitive of an array ("array ToPrimitive needs Array.prototype.join"), from the stand-in's `1 / actual` in `sameValue` (the real `assert.js` has the same `1/a === 1/b`) | 97 | A3: Array.prototype.join / toString |
| `.forEach` on an array | 59 | Array.prototype methods with callbacks, after S4's Fb |
| `throw new Test262Error` | 17 | function values as constructors (slice C) |
| a RegExp in a script var | 9 | RegExp values (S12) |
| `Object` as a value | 8 | built-in globals (S5) |
| others (`const` homes 5, `str.match` 5, `instanceof Array`, closure annotations, direct eval) | 13 | various |

The real prelude's `var failures = []` (propertyHelper.js) has its home: `failures.length` and `failures[0] = 1`
inside a function pass; `failures.push(1)` refuses ("__ir_dyn_method_call_1 has no Prepared intrinsic"), so
Array.prototype.push is its next gap.

### A3 `Array.isArray` result (2026-11-19)

Branch `claude/7354-arrays-isarray` on `claude/7354-arrays` (`5c00016ed2`). Rule 5 as written: one contract row,
`js.object.is-array(value) -> boolean` in the ordinary-object family (`ordinary-object-callables.ts`, manifest), served
by the realm (`native-source-objects.ts` ROWS, `array: true`) with the body `any.convert_extern; ref.test $Array`
(`buildArrayIsArrayDefinition`, the existing `arrayTest`). No new lowering: the #7106 static-predicate arm
(`static-predicates/lowering.ts`) already owns `Array.isArray` on the unshadowed ambient `Array` and answers a
primitive `false` without a call; an `externref` or `dynamic` operand now calls the brand test where the resolver
answers `preparedArrayBrandTest` (the Prepared resolver, for every call it owns), and still demotes elsewhere. The
dynamic value's carrier is the externref the test reads, so no kind table is consulted: every non-`$Array` value,
boxed primitives and null included, fails `ref.test`.

- Proving programs (`tests/issue-7352-a-arrays.test.ts`, "A3"): an Array and an ordinary object in a script var,
  P's dynamic parameter holding an Array, a number, an object and null, a function-local literal; right answer
  returns, wrong throws, node agrees. `var A = Array;` stays refused ('identifier "Array" is not in scope', S5's).
- Mutation check: the test answering `$Object` instead of `$Array` fails the object and parameter programs.
- Bytes: ordinary pipeline identical on 111 files × default/standalone vs `5c00016ed2`; the 34 realm programs
  without `Array.isArray` (`.tmp/bytes-realm-compare.mts`) have the same outcome, 29 binaries sha-equal, 5 refusals.

### Acceptance

- Each slice's proving program validates and runs through the strict Prepared entry: the right answer returns,
  a wrong answer throws, node agrees. Tests in `tests/issue-7352-a-arrays.test.ts`, refusals pinned by name,
  a mutation check on each new arm.
- Ordinary-pipeline bytes identical on the 100-file sample, JS environment and standalone.
- Code quality: one representation of an array on this path; the three contracts are rows of the existing
  ordinary-object tables and adapters, not a parallel family; the hole and growth logic is the existing helper;
  no file or function over budget without a dated grant.

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
