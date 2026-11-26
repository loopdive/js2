---
id: 7350
title: "IR foundation: built-in globals as values — one admission on the realm"
status: ready
sprint: current
created: 2026-11-15
updated: 2026-11-16
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7349]
related: [7349, 7352, 7353, 7343, 7189, 7127, 7294, 7106, 7342]
---

# #7350 — IR foundation: built-in globals as values

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only"). Direction since 2026-11-15 (`CLAUDE.md`, "IR
migration: foundations first"): build the mechanisms many files need.

A built-in global used as a value (`Object`, `String`, `Math`, `Function`,
`parseInt`, …, and their `prototype` objects and members) is the second such
mechanism, after function values (#7349). The IR admits such values through
four separate allowlists in `src/shared/ambient-intrinsics.ts`, each measured
for one issue (#7106 opaque values, #7189 static method values, #7127
prototype method values, #7294 prototype members and descriptor support).
Anything outside them is refused as `expr-ident-not-in-scope`.

All four allowlists already sit on one fact: a built-in global is a property
of the realm object, read with `dyn.member_get(global_object, name)`. The
legacy compiler's bare read shares that identity.

## Measured

Standalone, 2026-11-15, main `ed17563bc2`, with QuickJS and the Temporal
provider built locally. Research record: session scratch
`globfound/research.md` (not in the repository; the tables that matter are
copied here).

**Inventory**, re-compiled on current main: 1,837 ES5 test262 files have a
built-in-name refusal in the test body; 1,832 are still blocked.

| name | files | | position | files |
| --- | ---: | --- | --- | ---: |
| `Function` | 997 (899 only via `propertyHelper.js`) | | `X.prototype.m` as a value | 410 |
| `Object` | 334 | | `X.m(…)` call | 238 |
| `String` | 188 | | `X.prototype.m(…)` call | 86 |
| `Number` | 118 | | `X.prototype` as a value | 82 |
| `Math` | 71 | | `X` as an argument | 76 |
| `RegExp` | 61 | | `X.m` as a value | 73 |
| `JSON` | 54 | | `.call` / `.apply` / `.bind` on a built-in method | 59 (+905 harness) |
| `Array` | 52 | | write `X.m = v` | 50 |
| global functions | about 35 each | | `===` operand | 36 |

- In 272 files this family is the only refusal family.
- `typeof X`, `instanceof X` and `new X` never appear in these rows; they are
  folded today.

**Prototype run on the 272 files** (a throwaway patch: every built-in name
admitted and lowered as a realm read; not merged):

| step | files |
| --- | ---: |
| every unit claimed | 201 |
| compile with zero legacy units | 151 |
| keep their passing verdict | 94 |

All 151 pass on main, where they compile as legacy. The 57 that then answer
wrongly show what the standalone runtime lacks:

| gap | files |
| --- | ---: |
| static methods with no dynamic implementation (`JSON.parse`, `Object.isFrozen`, …) | 21 |
| `[[Prototype]]` links of constructor and prototype objects not set | 12 |
| prototype members not seeded | 12 |
| callability wrong | 4 |
| `Object.getPrototypeOf(primitive)` through the dynamic call | 3 |
| `constructor` back-links | 2 |
| constructor expandos not seen | 2 |
| other | 1 |

Of the 272, 50 claim every unit and then fail after the claim (an `assert`
argument typed dynamic 18, operand families 18, other 14), and 71 stay
refused at selection, mostly `expr-object-static-operand` (39), for example
`Object.isExtensible(Math)`.

**`propertyHelper.js`**: with globals admitted the harness stops at
`var verifyPrimordialProperty = verifyProperty` (#7349 S1a) and at
parameter-carrier refusals. Globals alone free none of the files that include
it. Corrected 2026-11-16 by a measurement on main `8045884222`: 905 ES5 files
include the harness; with this issue's G1 + G4, #7349 S1a, #7353 (parameter
carriers) and #7352 (object literals as open objects) all in place, 151 of
them become IR-only, and the other 748 have refusals of their own.

**Legacy answers wrongly today** on: a built-in called or constructed through
a variable (`var S = String; S(5)` traps), `Object.keys` called as a value,
`Function.prototype` identity of function objects, `Math.constructor`,
`parseInt.length`, and reassigning or deleting a global. Per the direction,
those answers are not preserved.

## Implementation Plan

### Target structure

- **One admission.** A read of a built-in global is admitted when the name
  binds to the library declaration, nothing in the source declares it, and
  the realm is pristine for that name (not written, deleted or shadowed in
  the file; the write scanner that #7339 extended already owns that fact).
  It replaces the four allowlists. The admission lives in one module under
  `src/ir/` that the selector and from-ast both ask.
- **One value.** The value is the realm property: a dynamic-carrier object
  with its own identity, its `prototype` and its members. Every access the
  compiler cannot resolve statically is an ordinary dynamic access on that
  object.
- **Static folds stay, as the optimisation.** `Math.max(…)`, `typeof X`,
  `x instanceof X`, `new X(…)` and the rest keep their direct lowering, used
  only when the receiver is a pristine intrinsic. One predicate answers
  "pristine intrinsic" for the folds and for the admission.
- **Calls and construction through a value** use #7349's single call path
  (`__apply_closure`); this issue adds callable and constructible carriers
  for the built-in constructors, no second call mechanism.
- **Runtime completeness is part of the work.** The prototype graph
  (`[[Prototype]]` links, `constructor` back-links, seeded members,
  callability) is completed in the standalone runtime through the demand
  seeding #7294 introduced, so a value read sees a spec-shaped object.
- **What duplicates it removes.** The four allowlists and their per-issue
  admission functions; the position lists that say where an opaque value may
  appear.

### Slices

Yields are **measured on the 272 only-family files with the throwaway
prototype** (files that end IR-only and still pass). They are upper bounds
for those files; each slice re-measures on current main before it starts.

| slice | content | cumulative files | depends on |
| --- | --- | ---: | --- |
| G1 | the one admission; a bare built-in value in every position (argument, operand, stored, returned) | 22 | |
| G1b | Object-statics operands may be built-ins (`Object.isExtensible(Math)`) | estimate 15 to 20 more | #7338 rows |
| G2 | complete prototype graph and member values (`X.prototype`, `X.prototype.m`, `X.m` as values) | 64 | |
| G3 | member calls: the fold first, the dynamic call where the runtime implements it; refuse the rest | at least 85 | |
| G4 | `.call` / `.apply` / `.bind` on built-in methods | 94 | #7349 S7 |
| G5 | calls and `new` through a built-in value | probes only | #7349 S1a, S6 |
| G6 | realm writes and deletes (`X.m = v`, `delete X.m`) with the folds gated on them | probes only | |

The `propertyHelper.js` harness needs G4 together with #7349 S1a, #7353 and
#7352; that combination frees 151 files (measured 2026-11-16), not the 899
an earlier version of this plan implied.

### Hazards to prove per slice

1. **The provider-owned `%Function%`.** PR #7231 was parked by the merge
   queue because a rule about `Function.prototype` moved 127 Temporal tests
   onto the runtime-eval route. Those tests run only with the Temporal
   provider that CI links. Verdicts are measured with that provider built
   locally, across all editions.
2. **Mixed files.** A legacy unit folds an access (`Math.max`) while an IR
   unit in the same file writes the realm (`Math.max = f`). The pristine
   predicate must be a whole-file fact, asked by both.
3. **Members the runtime never seeded.** A dynamic read of an unseeded member
   answers `undefined` silently. Each slice lists the members it relies on
   and proves them with probes against node.
4. **Refusing at select drags IR callers to legacy.** Measure units newly
   legacy on a wide control set.

### Constraints

- Standalone only; no new host imports; JS-environment output
  byte-identical.
- No test verdict regresses in any edition; no unit that main lowers on IR
  is lost; refuse at select, never claim and then withdraw.
- No selector-side copy of from-ast rules; the admission module is asked by
  both.
- No budget grant for `select.ts` or `from-ast.ts` beyond a dated, justified
  one; removing the four allowlists should shrink them.

## Acceptance criteria

Per slice:

1. Census on the 1,837 carrier files and 500 IR-only control files: files
   gained, files lost 0, units newly legacy 0, new compile errors 0,
   post-claim errors not increased.
2. Verdicts of every routing-changed file, across all editions, with QuickJS
   and the Temporal provider: no pass to fail.
3. A probe matrix against node for the slice's positions and names, at
   module level and inside a function: nothing claimed answers differently.
4. JS-environment output byte-identical on the routing-changed files and on
   200 others.

Code quality:

5. After G2 the four allowlists are gone; one admission and one pristine
   predicate remain.
6. No second call mechanism beside #7349's.
7. A fresh-context adversarial review per slice records its verdict in the
   PR body.

## Slice B2c-1 plan — `parseFloat` / `parseInt` bodies move to the native runtime (2026-11-19)

Lead decision 2026-11-19: before B2b's realm rows can bind the native implementations, move the pure body
builders out of codegen into `src/runtime/wasmgc/values/`, one PR per surface, bytes identical. Inventory of
the surfaces (codegen vs runtime, standalone): the Object constructor and the primitive wrappers already have
realm builders (`object-constructor-body.ts`, `to-object-body.ts`, `primitive-wrapper-bodies.ts`; the legacy
`__new_Number/String/Boolean` store a different representation, so there is nothing to move); `isNaN` /
`isFinite` are single inline operations; the Error constructor body is already shared (`error-bodies.ts`);
Math's transcendental functions are self-hosted from `src/stdlib/math.ts`. `parseFloat` and `parseInt` are the
first surface with real bodies still in codegen.

**Target structure.** `src/runtime/wasmgc/values/parse-number-bodies.ts`, beside `string-number-bodies.ts` and
`decimal-scale-bodies.ts`, which `__str_to_number` already uses: `buildParseFloatDefinition` and
`buildParseIntDefinition`, each `(bindings) → { locals, body }`. Bindings: the native string types, the decimal
power table (`DecimalPowerResources`, parseFloat only) and the argument prologue (`flatString(argLocal)`: the
instructions that leave a flat native string, which codegen supplies with its finalize-filled ToString arm).
`src/codegen/parse-number-native.ts` keeps only what touches the module: the function type, the handle, the
`funcMap` row, the pow10 global and the prologue's pending ToString arm.

**What it removes.** (Corrected after review RV7323b.) The parseFloat digit loops duplicated
`buildDecimalMantissa` (`string-number-bodies.ts`, `__str_to_number`'s) except for local indices and a 4-instruction
`mant = 0; sawDigit = 0` init: they are one exported builder now, taking a locals record, with the init left to
the caller; its dead `strDataTypeIdx` parameter goes. The move itself makes the two bodies bindable by the realm
without a second implementation.

**Acceptance.** Bytes identical on every test262 file whose source names `parseInt` or `parseFloat`, on the
default, standalone and linear targets (measured with a scratch hashing script; review RV7323b asked not to
commit a third byte-identity tool beside `prove-emit-identity.mjs` and `byte-diff-corpus.mts`, and to count
rows that fail on both trees separately from identical binaries);
`parse-number-native.ts` shrinks; the new file joins the `native-runtime` layer. Quality: the builders read
no context, only their bindings.

**B2c-1 measured (2026-11-19, main `89e4748241`).** A scratch hashing script over the 216 test262
files whose source names `parseInt` / `parseFloat` plus a 103-file random control sample (317 files, 925
rows): 0 rows differ. Binaries compared: 291 default and 291 standalone (13 files compile on neither tree, 13
are runner skips). The linear target compiles none of these harness-wrapped files on either tree (the linear
backend has no `try` / `catch`), and nothing under `src/codegen-linear/` imports the moved code, so linear is
unaffected by construction. `buildParseFloatDefinition` stays under the 300-line budget by calling the shared
`buildDecimalMantissa`; the codegen side has an `emitParseFloat` beside `emitParseInt` and `emitStrToNumber`.
`tests/issue-1663.test.ts` (1 row) and `tests/issue-6969-parse-number-tostring.test.ts` (8 parseFloat rows)
fail identically on main `89e4748241`; `issue-2654` and `parseint-edge` pass.

## Implementation Plan — B3: String, Number and Boolean as realm values (2026-11-26)

`String`, `Number` and `Boolean` as realm values on the Prepared path (`TEST262_COMPILER_PATH=ir`, standalone): the
constructors and their prototypes as objects of the realm, `new X(v)` as a wrapper object, and the prototype methods
the sample reaches. Same shape as #7354 G1's Error family. Out of scope (another session): `Math`, arrays, property
descriptors, `with`, the global object.

### Measured (2026-11-26, main `bb9123f6a3`)

Tool: `scripts/ir-census/prepared-census.mts --harness real --jobs 3` (the runner's assembly, standalone, negatives
skipped). The 411-row list `l420.txt` of #7354 is not in the repository or on this box, so two lists were measured
instead. Scratch files are under `.tmp/b3/` of the B3 worktree (not committed).

- **Sample.** The first 420 files of `es5-files.mts` (seed 7106): 399 positive; 59 pass, 33 fail, 307 compile errors.
  First stops on the three names: 40 (the lead's 411-row census found about 50).
- **All carriers.** Every ES5 file whose source names `String`, `Number` or `Boolean`: 1,977 files. 1,068 of them stop
  first on one of the three names.

| first stop | sample (399) | all carriers (1,977) |
| --- | ---: | ---: |
| `unknown class "String"` (`new String`) | 6 | 281 |
| `identifier "Number" is not in scope` | 5 | 221 |
| `identifier "String" is not in scope` | 9 | 206 |
| `unknown class "Number"` | 11 | 174 |
| `unknown class "Boolean"` | 7 | 172 |
| `identifier "Boolean" is not in scope` | 2 | 14 |
| total | 40 | 1,068 |

**What those files use**, by a regex classifier over the test body (`.tmp/b3/classify.mjs`; each file counted once,
in the first matching row from the bottom up):

| bucket | needs | sample | all |
| --- | --- | ---: | ---: |
| A | `Number.MAX_VALUE`-style constants, `Number(v)` / `String(v)` calls only | 1 | 109 |
| B | `new X(v)` used through operators, `===`, truthiness, as a descriptor or key; `valueOf` / `toString` | 16 | 399 |
| C | constructors, prototypes or methods as values: identity, `hasOwnProperty`, descriptors, writes to `X.prototype` | 10 | 219 |
| D | String / Number method algorithms (`String.prototype.trim` in 54 files, mostly through `.call`; case conversion, `substring`, `indexOf`, `concat`, `fromCharCode`) | 7 | 195 |
| E | arrays, `split`, RegExp (out of scope) | 6 | 133 |
| — | other (`Number` / `String` own-property tests) | 0 | 13 |

**What stands behind the stop** (a throwaway source rewrite in a scratch tree, not a prototype of the design):

- A, constants replaced by their literals: 92 of 109 pass. Of the 17 others, 10 meet loose / mixed equality
  (`Phase 1 requires matching operand types for '=='`) and 6 the `Number(v)` gap below.
- B, a random 100 of 399 with `new X(v)` replaced by `v`: 66 pass, 7 fail, 27 compile errors (9 of them are the
  rewrite's own artefact: a property write on what is now a primitive; 3 `delete`, 3 loose `==`, 3 `Object`). An
  upper bound for B3b and B3c together: a wrapper still needs ToPrimitive through `valueOf` / `toString`.

**Probes** (real harness, Prepared path): `String(5)` passes; `Number("3")` compiles in the front end but fails at
setup (`intrinsic callable js.number.from-value needs runtime function materialization`: the catalog's remaining
"public Number(value) provider"; 30 first stops in the carriers); `Boolean(1)` has no plan (`direct call to "Boolean"
has no exact AST-site plan`); `typeof String` and `Number.MAX_VALUE` stop at "not in scope"; `(5).toString()` refuses
(`method call .toString(...) on f64 not in slice 4`); `"abc".length` is the run-time abort.

**Uses beyond the stop in the 40 sample files**: `new X(v)` / `new X` / `new X()` (24 files); wrappers through
`/ << >> >>> -= ++ <=` (ToNumber through `valueOf`) and through `===`, `?:`, `&&` (identity, truthiness); a wrapper as a
descriptor object (`Object.defineProperty(o, "p", boolObj)` reads `writable` inherited from `Boolean.prototype`) and
as a key (`Object.getOwnPropertyDescriptor(o, new Boolean(true))`, ToPropertyKey through `toString`); own writes on a
wrapper (`descObj.value = "Number"`); `Number.NaN`, `Number.POSITIVE_INFINITY`, `Number.NEGATIVE_INFINITY`,
`Number.MAX_VALUE`, `Number.MIN_VALUE`; `Number.prototype.toString` / `.toExponential` and `(new Number()).toString`
identity; `Object.getOwnPropertyDescriptor(Boolean.prototype, "toString")` and `(String.prototype, "split")`;
`String.prototype.<m>.hasOwnProperty("length")` and `delete String.prototype.<m>.length`;
`String.prototype.localeCompare.prototype`; writes `Boolean.prototype.writable = true`, `String.prototype.set = f`,
`Number.prototype.substring = String.prototype.substring`; calls `indexOf`, `substring`, `concat`, `toLowerCase`,
`split` on wrappers or primitives; `String.prototype.trim.call(v)`. Not seen in the sample: `typeof X`,
`instanceof X`, `Boolean(v)`. Across all carriers also `Number.prototype.toString(radix)` on Number.prototype itself
(44 files, answer `"0"`: Number.prototype has [[NumberData]] +0).

### What exists on main (read)

- **G1's Error family** (#7354): catalog rows with `heldWith` (`native-realm-catalog.ts` `errorRows`), the selector list
  `NATIVE_VALUE_INTRINSICS` read by `js.object.intrinsic`; the kernel's family objects and seeding
  (`realm-family-bodies.ts` `realmFamilyAllocation` / `realmFamilySeed`; `native-realm-families.ts` `familyObjects` /
  `familyProperties`, which throws on a number-valued property); creation `buildErrorCreateDefinition`; the read
  `identifier-read.ts` `realmIntrinsicRead` (asks `errorConstructorId` and `isPristineBuiltinGlobal`); construction at
  the call or construct site (`dynamic-error-constructors.ts` `errorConstructorOf` / `dynamicErrorConstruction`,
  called from two arms of `dynamic-value-legalization.ts`); Error.prototype.toString by identity in ToPrimitive
  (`ordinary-to-primitive.ts`, the `errorToString` hook built in `dynamic-value-chains.ts`); what a realm holds
  (`native-realm-requirements.ts` `heldErrorConstructors`, `heldCatalogRows`); `source-plain-objects.ts` `namesErrors`.
- **P1's prototype methods**: `dynamic-prototype-methods.ts` (`o.m(v)`: F2's [[Get]] then the dispatcher's call,
  replaced by the built-in's algorithm when the value read is the realm's function object; else the call as it was).
- **F2's call**: one `js.closure.call:N(receiver, callee, …args)`; the dispatcher calls source closures, throws its
  TypeError for a non-callable, and aborts for a built-in. `.call` / `.apply` are not on this path: Function.prototype
  keys refuse by name (`FUNCTION_REACHABLE_KEYS`), apart from the intercepted `Object.prototype.toString.call(v)`.
- **Wrapper storage, #3518, wired nowhere**: `primitive-wrapper-layouts.ts` (`$StringObject` etc.: a final subtype of
  `$Object` with an immutable `[[XData]]` field 6), `realm-object-layouts.ts` `createRealmPrimitiveWrapperDeclaration`,
  `primitive-wrapper-bodies.ts` (allocation with an explicit prototype; payload read), `to-object-body.ts`,
  `string-exotic-bodies.ts`; backend owners `native-primitive-wrapper-layouts.ts` and
  `native-primitive-wrapper-storage.ts`. No `src` file imports the two owners; only #3518 tests do.
- **Legacy standalone wrappers** (`object-runtime.ts` `__new_Number` / `__new_String` / `__new_Boolean`): a null-proto
  `$Object` with a hidden `WRAPPER_PRIMITIVE_KEY` entry, read by `to-primitive-wrapper-bodies.ts`. A hidden key and no
  prototype; not reused (B2c-1 reached the same conclusion).
- **Conversion calls** (`prepare-number-conversion.ts` `prepareConversionResolvers`, Prepared only; the ordinary
  pipeline calls `prepareNumberConversionResolver` from `integration.ts`): `String(v)` holds while no source declares
  `String`; `Number(v)` is dropped by any value read of `Number`; no `Boolean` plan. `lowerPreparedNumberCall`
  (from-ast) sends a dynamic operand to `emitDynToNumber` but a native string to `js.number.from-value`, which the
  Prepared lane cannot materialize.
- **The prototype premise (M1, C1)**: no Prepared program obtains a built-in prototype, so a primitive's member read
  answers from `BUILTIN_REACHABLE_KEYS` (own or `undefined`, or a refusal by name) and a primitive's member write never
  meets a setter (`dynamic-member-access.ts`). `tests/issue-7354-m-prototype-premise.test.ts` pins
  `String.prototype`, `Number.prototype` and `Boolean.prototype` as refusals. `builtin-prototype-keys.ts` keeps
  `NUMBER_PROTOTYPE` and `STRING_PROTOTYPE` as hand lists "because the wrapper prototypes are not in the catalog yet".

### Target structure

**Representation** (the IR's own choice; nothing mirrors legacy):

- A wrapper is an ordinary realm object of #3518's typed layout `$XObject`: [[Prototype]] `%X.prototype%`,
  the payload in the immutable `[[XData]]` field. Every kernel operation is already total over `$Object`, so get,
  set, has, define and the key walk need no new arm. Its kind is the `object` kind (as G1's error): `typeof` "object",
  ToBoolean true, `===` identity.
- A String wrapper's own `length` (StringCreate defines it as a real property) and its index properties are defined
  at creation, non-writable and non-configurable (indices enumerable). The kernel then answers String exotic
  [[GetOwnProperty]], [[DefineOwnProperty]] and [[Delete]] with no exotic arm. Sample need is small (8 carrier files
  read a String wrapper's `length` or an index), but without it a read of `w[0]` would answer `undefined`.
- `%String.prototype%`, `%Number.prototype%`, `%Boolean.prototype%` are themselves wrappers with "", +0 and false
  (§22.1.3, §21.1.3, §20.3.3): allocated by the wrapper allocation, not `createWithPrototype`. `String.prototype` has
  own `length` 0.
- Number's constants are number data properties of `%Number%` {!w, !e, !c}. Because they are read-only and
  non-configurable, `Number.MAX_VALUE` on a pristine `Number` folds to the catalog's value in the front end.

**Modules** (runtime contract → runtime body → backend → IR, as G1):

| layer | module | change |
| --- | --- | --- |
| contract | `src/runtime/contracts/native-realm-catalog.ts` | `wrapperRows(name)` beside `errorRows`: constructor (length 1, constructible, own `prototype` {!w,!e,!c}, Number's five constants), prototype (`constructor`, the spec's methods, a `primitiveData` field), one row per method; `NATIVE_WRAPPER_CONSTRUCTORS`; `NATIVE_MEMBERS` gains `valueOf` / `toString` of the three prototypes; the new ids are appended to `NATIVE_VALUE_INTRINSICS` (G1's selectors keep their numbers) |
| runtime body | `src/runtime/wasmgc/values/realm-wrapper-bodies.ts` (new, beside `realm-family-bodies.ts`) | `buildWrapperCreateDefinition` (allocation from `primitive-wrapper-bodies.ts`, then String's `length` and indices through the kernel's `defineDataBody`), `buildWrapperDataDefinition` (thisXValue: the payload of a wrapper of that kind, else the realm's TypeError) |
| runtime body | `realm-family-bodies.ts` | `RealmFamilyProperty` takes a number value; an object row with primitive data is allocated as a wrapper |
| backend | `src/backend/wasmgc/program/native-realm-families.ts`, `native-realm.ts`, `resources/native-builtin-functions.ts` | number properties and wrapper prototypes pass through; `errorCreateOperands` becomes one family-create operand builder for both creations; `native-primitive-wrapper-layouts.ts` / `-storage.ts` become live owners, reserved only for the kinds the realm holds |
| contracts | `src/ir/runtime/ordinary-object-callables.ts` | `js.object.create-wrapper(value, selector)`, `js.object.wrapper-data(object, selector)`; `dyn.object_tag`'s wrapper test is a `ref.test` of the layout, beside `is-error` |
| IR keys | `src/ir/program/builtin-prototype-keys.ts` | `realmConstructorId` (Error family and the three) replaces `errorConstructorId`; `NUMBER_PROTOTYPE` / `STRING_PROTOTYPE` become `realmStringKeys("%Number.prototype%")` etc.; `nativeConstantStatic(parent, name)` reads a constant off the catalog |
| IR holds | `src/ir/program/native-realm-requirements.ts` | `heldErrorConstructors` becomes `heldFamilies`: one table (family → member ids, contracts, extra trigger: a bound catch payload for Error) |
| IR read | `src/ir/identifier-read.ts`, `src/ir/source-plain-objects.ts`, `dynamic-value-kinds.ts` | `realmIntrinsicRead` asks `realmConstructorId`; `namesErrors` becomes `realmFamilies` (a set), `holdsErrors` a per-family question; the object kind is admitted where any family is held |
| IR construction | `src/ir/program/dynamic-wrapper-constructors.ts` (new, sibling of `dynamic-error-constructors.ts`) | `new X(v)`: ToString / ToNumber / ToBoolean of `v` (absent: "", +0, false), then `create-wrapper`; `X(v)` through the realm value: the conversion alone. The recognition moves to `dynamic-realm-calls.ts` `realmConstructorOf` (one function answering family and selector), so the legalization's construct arm and dispatched-call arm switch once |
| IR methods | `dynamic-prototype-methods.ts`, `ordinary-to-primitive.ts`, `dynamic-value-chains.ts` | `RealmMethod` becomes a table of (name, catalog id, algorithm); the `toString`-only-with-errors special case and the `errorToString` hook become one "realm method by identity" list, used by the call expansion and by ToPrimitive |
| IR member access | `dynamic-member-access.ts` | where the family of a primitive kind is held, that kind's read is the realm's [[Get]] on `%X.prototype%` with the primitive as receiver, and its write OrdinarySet there (a setter on the prototype runs); unchanged where it is not held |
| front end | `prepare-number-conversion.ts`, `from-ast.ts`, `realm-static-call.ts` | `Boolean` joins `ambientConversionCalls`' names (ToBoolean, `dyn.truthy`); the Prepared `Number` plan is pristine like `String` (the change on the unmerged `claude/7350-string-call`, `e50febcb71`, extended to `Number`); `lowerPreparedNumberCall` boxes a non-dynamic operand and takes `emitDynToNumber` on the Prepared lane; the constant fold `Number.<constant>` sits beside the static call form in `realm-static-call.ts` |

### Reuse, and the duplicates it removes

- **Reuses**: G1's catalog shape, family allocation and seeding, `heldWith`, `js.object.intrinsic`, the pristine
  predicate (`builtin-global-binding.ts`); P1's identity-tested call expansion; F2's call ABI and dispatcher (a held
  method without an algorithm, called through a value, is the dispatcher's built-in abort); C2's `dyn.construct` and
  `dyn.instanceof` (`x instanceof String` walks the wrapper's chain; a primitive answers false); the legalization's
  existing ToString (`stringOf`), ToNumber (`toNumber`), ToBoolean (`js.value.to_boolean`) and number formatter
  (radix formatting for `Number.prototype.toString(r)`); #3518's wrapper layouts, storage owners and bodies.
- **Removes**: the two hand lists in `builtin-prototype-keys.ts` (the catalog is the list); the `errorToString`
  single-purpose hook and P1's `name === "toString" && errors` special case (one table); `heldErrorConstructors`'
  Error-only shape; `namesErrors` as a boolean; the Prepared `Number(v)` route to `js.number.from-value` (one ToNumber
  for `+v` and `Number(v)`). Makes #3518's wrapper owners live instead of test-only.
- **Does not add**: a second object layout, a hidden-key wrapper, a second call mechanism, or a selector-side copy of
  the read rules.

### Behaviour in scope

- `String`, `Number`, `Boolean` read as values where pristine: `typeof X` "function"; `X.name`, `X.length` (1);
  `X.prototype` (!w, !e, !c); `X.prototype.constructor === X`; identity across reads; passed, stored, compared.
- `Number.MAX_VALUE`, `MIN_VALUE`, `NaN`, `POSITIVE_INFINITY`, `NEGATIVE_INFINITY`: folded where `Number` is pristine,
  the realm property otherwise (same value).
- `String(v)` (unchanged), `Number(v)` (now total on the Prepared lane), `Boolean(v)` (new), as direct calls.
- `new String(v)`, `new Number(v)`, `new Boolean(v)`, without argument and without parentheses: a wrapper; a second
  argument is evaluated and ignored.
- Wrapper as a value: `typeof` "object", truthy, `===` identity, `instanceof X` true, `Object.prototype.toString`
  `[object String]` etc., own property reads and writes, as a descriptor object or property key.
- ToPrimitive of a wrapper through the realm's `valueOf` / `toString`, recognised by identity, so a program override
  (`Number.prototype.valueOf = f`) is seen.
- Calls by identity (P1's expansion): `valueOf()` and `toString()` of the three on a wrapper, on a primitive, and on
  the prototype itself (`Number.prototype.toString(16)` is "0"); Number's `toString(radix)` for radix 2–36.
- Every other method of the three prototypes is a function object (real `name`, `length`, [[Prototype]]
  `%Function.prototype%`, no `prototype`) whose own properties can be read, written and deleted, so identity,
  descriptor and `hasOwnProperty("length")` tests run.
- Writes to `X.prototype` and reads of what they wrote, from objects, wrappers and primitives.

**Not in scope, and what happens instead** (the lead's standing rule: never a wrong answer; a statically visible
unsupported surface refuses by name at compile time, anything else is the uncatchable `unreachable`):

- A call of a method without an algorithm (`indexOf`, `substring`, `trim`, `fromCharCode`, …) in P1's `o.m(…)` shape:
  refuses by name (`String.prototype.indexOf has no Prepared algorithm`). Through any other value: the dispatcher's
  built-in abort.
- `.call` / `.apply` / `.bind` on a built-in method: unchanged (refused by name through `FUNCTION_REACHABLE_KEYS`);
  #7350 G4 / #7349 S7.
- Loose `==` / `!=` with a wrapper: stays the existing refusal (`dyn.eq (loose)`).
- ES2015+ members (`Number.isNaN`, `Number.EPSILON`, `String.raw`, `String.prototype.at`, …): catalog rows held as
  function objects or values where the spec gives them; their calls refuse by name like any other method.
- `Object(v)` / `new Object(v)` (ToObject of a primitive, 40 `new Object` and 14 `Object(v)` first stops in the carriers): not here; it can reuse
  `create-wrapper` later.
- A shadowed, assigned or `var`-declared `String` / `Number` / `Boolean`: not pristine; the existing rules
  (`scriptVarOfRealmGlobal` picks the three up through `REALM_GLOBAL_NAMES`).

### Slices

Each re-measures on current main before it starts (census on the 1,068 stop files and the 420 sample, base and head).

| slice | content | yield on the 1,068 carriers | sample |
| --- | --- | --- | ---: |
| B3a | catalog rows, constructors and prototypes as realm values (identity, `typeof`, `name`, `length`, `prototype`, `constructor`), Number's constants and their fold, `Number(v)` total, `Boolean(v)` | measured upper bound 92 of A's 109; at most 98 with the `Number(v)` fix (6 rows stop at its gap) | 1 |
| B3b | `new X(v)` wrappers, String's own `length` / indices, wrapper kind rows (`object_tag`), the primitive member read / write through a held prototype | needs B3c to show: ToPrimitive goes through `valueOf` | — |
| B3c | `valueOf` / `toString` by identity in ToPrimitive and as calls; the remaining methods as function objects | B3b + B3c: estimate 260 of B's 399 (66 of a random 100 with wrappers rewritten to primitives) plus part of C's 219 (not measured) | estimate 10–20 |
| B3d | String / Number method algorithms (bodies move from `src/codegen/string-ops.ts` to the native runtime first, as B2c-1), `.call` on them with G4 | D's 195, plus 56 `method call .trim(...) on string` first stops on primitives | own plan |

B3b and B3c may land as one PR if B3b alone gains no file; the review decides.

### Acceptance criteria

Correctness:

1. Census (real harness) on the 1,068 stop files and on the 420 sample, base vs head: files gained per slice, files
   lost 0, new crashes 0. Named rows that must pass after each slice:
   - B3a: `language/expressions/division/S11.5.2_A4_T1.1.js` (`Number.NaN`, the infinities),
     `language/expressions/modulus/S11.5.3_A4_T3.js` (both pass in the rewrite).
   - B3b + B3c: `language/expressions/division/S11.5.2_A3_T1.1.js` (Boolean wrapper ToNumber) and
     `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-40.js` (wrapper as key), both pass in the rewrite;
     `language/expressions/conditional/S11.12_A4_T2.js` (identity; the rewrite cannot show it: `NaN !== NaN`). To
     confirm on the branch before they become criteria (C bucket, no rewrite possible):
     `built-ins/Number/S15.7.5_A1_T02.js` (`(new Number()).toString === Number.prototype.toString`),
     `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-85.js` (descriptor of `Boolean.prototype.toString`),
     `built-ins/Number/prototype/toString/S15.7.4.2_A2_T14.js` (Number.prototype's +0).
   Each gained row gets a mutated twin (flip one expected value) that must fail in the same run.
2. A probe matrix against node, each with a wrong twin, at module level and inside a function: the three names in
   every value position; `new X(v)` over undefined, null, numbers, strings, Booleans, an object with `valueOf` /
   `toString`; ToPrimitive with an overridden `X.prototype.valueOf`; writes to `X.prototype` read through a primitive
   and through a wrapper; an accessor defined on `String.prototype` with a primitive write (`"a".x = 1`); a shadowed
   and an assigned name. Nothing claimed answers differently from node; refusals and aborts are by name or
   `unreachable`, never a wrong value.

No regression:

3. No test262 verdict regresses in any edition; the per-edition ratchet holds (ES5 is `completed`). Locally: the
   census on every ES5 file whose routing changes (the 1,977 carriers) plus 500 others, base vs head; CI's merge group
   is the gate.
4. JS-environment and ordinary-pipeline output byte-identical: the change touches no `src/codegen/` and no
   `integration.ts` path; checked with `prove-emit-identity.mjs` on the 1,977 carriers × default and standalone.
5. Prepared bytes: `check:prepared-bytes` (804 rows) identical for every program that names none of the three and
   creates no wrapper (selectors are appended; literals follow the held rows). Rows that change are listed, each run
   on base and head with the same outcome.
6. Pins that move are listed in the PR: the three `m-prototype-premise` refusals become value tests (each onward route,
   `String.prototype.__proto__` and the methods' `.call`, still aborts or refuses); `t2-typeof-standard-globals`;
   `issue-7354-str2-to-string`'s "String not in scope" pin.

Code quality:

7. One catalog shape (`wrapperRows` next to `errorRows`, same helpers); one family recognition
   (`realmConstructorOf`), one held-family table, one realm-method-by-identity table; sibling modules
   (`dynamic-wrapper-constructors.ts`, `realm-wrapper-bodies.ts`) in the shape of their Error siblings.
8. The removals above are in the diff (hand lists, the `errorToString` hook, the Error-only held set, the
   `js.number.from-value` Prepared route).
9. No `loc-budget-allow` or `func-budget-allow`: `from-ast.ts` (over the 1,500-line threshold) ends at or below its
   base; `dynamic-value-legalization.ts`, `dynamic-value-chains.ts` and `realm-family-bodies.ts` do not grow past the
   new modules' share. Gates run bare before each commit.
10. A fresh-context adversarial review per slice, given the diff and this plan, asked to prove the quality goal was
    not met; its verdict is in the PR body.

### Risks and open questions for the plan review

1. **The prototype premise ends for three kinds.** Today a primitive's member read and write are answered without the
   realm because no program can change `String.prototype` (M1, C1). With the family held, both go through the realm
   prototype, including a setter or getter a program defines there. Programs that never name the family keep the old
   arms and bytes. Proof: the probe matrix's primitive rows; the kernel's [[Get]] / [[Set]] must accept a primitive
   receiver (to verify: today every receiver is an object).
2. **The prototypes are wrappers.** `Object.prototype.toString.call(String.prototype)` is `[object String]`,
   `String.prototype.length` 0, `Number.prototype.valueOf()` 0. The family allocation needs the wrapper path for these
   three objects only.
3. **Does the #3518 wrapper layout fit the live realm's `$Object`?** The storage owner requires the realm-object
   layouts with realm state (`requireCompletedNativeRealmObjectLayouts`); the live kernel allocates through
   `native-object-storage.ts`. If they differ, the wrapper is declared against the live object type and the unused
   realm-state variant is deleted, not duplicated.
4. **String indices materialized at creation.** Equivalent to the exotic object only if the kernel orders own keys as
   OrdinaryOwnPropertyKeys does (integer keys ascending first). To verify; a large string costs one property per code
   unit. The alternative is the exotic own-property arm of `string-exotic-bodies.ts` inside the kernel's own lookup.
5. **Byte size and compile time.** A held String family carries about 50 method function objects (every member, so a
   dynamic key read never answers `undefined` for a member that exists). Measure bytes and compile time on the
   prelude + one `new String` row before and after; hold per member only if the cost is large and the soundness
   argument holds.
6. **Session B.** The global object (B2b) must hold the same function objects (`globalThis.String === String`); its
   realm property for the three names reads `js.object.intrinsic`. The unmerged `claude/7350-string-call` change to
   the `String(v)` plan belongs to this slice now; coordinate so it lands once.
7. **G1's shape**: `familyProperties` throws on number values and `realmFamilyAllocation` knows only
   `createWithPrototype`; both are generalised, not forked. `NATIVE_VALUE_INTRINSICS` is positional: append only.
8. **`Number(v)` on the Prepared lane**: the string-operand route changes from an unmaterializable provider to the
   legalized ToNumber. No program that compiles today changes; the 30 carriers that stop at setup get past it.
9. **Measurement caveats**: the sample is not the lead's 411 rows; buckets are from regexes; the B upper bound replaces
   wrappers by primitives, which hides wrapper-only differences (`typeof`, identity) and adds artefacts (9 rows).
