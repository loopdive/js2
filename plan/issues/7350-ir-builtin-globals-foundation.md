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

## Implementation Plan — B3: String, Number and Boolean as realm values (2026-11-26, revised after PRV-B3)

`String`, `Number` and `Boolean` as realm values on the Prepared path (`TEST262_COMPILER_PATH=ir`, standalone). Two
slices: **B3a** makes the three constructors values and serves Number's constants and the conversion calls; the
prototypes stay unreachable. **B3bc** makes the prototypes reachable as wrapper objects, adds `new X(v)`, and moves a
primitive's member read and write onto the held prototype. Same shape as #7354 G1's Error family. Out of scope
(another session): `Math`, arrays, property descriptors, `with`, the global object.

Revised 2026-11-26 after the plan review PRV-B3 (blocker on `51b37eebf7`); the changelog is at the end of this section.

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
  (`Phase 1 requires matching operand types for '=='`) and 6 the `Number(v)` gap below. Bucket A reads no prototype
  and holds no constructor as a value, so B3a's yield does not depend on the prototypes (blocker 1+2 re-check).
- B, a random 100 of 399 with `new X(v)` replaced by `v`: 66 pass, 7 fail, 27 compile errors (9 of them are the
  rewrite's own artefact: a property write on what is now a primitive; 3 `delete`, 3 loose `==`, 3 `Object`). An
  upper bound for B3bc: a wrapper still needs ToPrimitive through `valueOf` / `toString`.

**Probes** (real harness, Prepared path): `String(5)`, `String()` and `Number()` pass; `Number("3")` compiles in the
front end but fails at setup (`intrinsic callable js.number.from-value needs runtime function materialization`: the
catalog's remaining "public Number(value) provider"; 30 first stops in the carriers); `Boolean(1)` has no plan
(`direct call to "Boolean" has no exact AST-site plan`); `typeof String`, `Number.MAX_VALUE` and
`var x = Number.MAX_VALUE` stop at "not in scope"; `(5).toString()` refuses (`method call .toString(...) on f64 not in
slice 4`); `"abc".length` is the run-time abort.

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

**Key lists** (blocker 8): `NUMBER_PROTOTYPE` / `STRING_PROTOTYPE` (`builtin-prototype-keys.ts`) diffed against node
22's `Object.getOwnPropertyNames(Number.prototype)` / `(String.prototype)`, each united with Object.prototype's keys as
`BUILTIN_REACHABLE_KEYS` unites them: no difference either way (String's `length` included). The catalog rows are
written from the specification, so the derived sets must equal these.

**Member counts** (node 22): String.prototype 50 methods and 3 statics (`fromCharCode`, `fromCodePoint`, `raw`);
Number.prototype 6 methods and 6 statics (`Number.parseFloat` and `Number.parseInt` are the global functions' objects);
Boolean.prototype 2 methods.

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
  **An Error constructor's `prototype`** is a real own data property {!w, !e, !c} whose value is the family's prototype
  object, seeded in the initializer: G1 has no unreachable prototype, so B3a cannot copy it for `prototype`.
- **B2b's identity mark** (unmerged, `claude/7350-b2b` `23d952425f`, commit `8049075930`): an object flag
  `BUILTIN_IDENTITY_ONLY_FLAG` (0x100) on a kernel entry's bag; the kernel lookup's status 4 is "a miss among an
  identity-only object's own properties", which the caller turns into the trap (`identityOnlyMiss` in
  `builtin-function-prototype-bodies.ts`). B2b's rule: an unsupported member is never a catchable error or
  `undefined`; a statically visible one refuses by name, a dynamic one traps.
- **P1's prototype methods**: `dynamic-prototype-methods.ts` (`o.m(v)`: F2's [[Get]] then the dispatcher's call,
  replaced by the built-in's algorithm when the value read is the realm's function object; else the call as it was).
- **F2's call**: one `js.closure.call:N(receiver, callee, …args)`; the dispatcher calls source closures, throws its
  TypeError for a non-callable, and aborts for a built-in. `.call` / `.apply` are not on this path: Function.prototype
  keys refuse by name (`FUNCTION_REACHABLE_KEYS`), apart from the intercepted `Object.prototype.toString.call(v)`.
- **C2's `this`** (`dynamic-function-operations.ts` `dynamicCurrentThis`): strict code takes the receiver as is;
  sloppy code takes an object as is and aborts on `undefined`, `null` or a primitive (C2-D3). No ToObject of `this`
  exists on this path.
- **The kernel's OrdinarySet** (`source-object-bodies.ts`, `js.object.set(object, key, value, receiver)`): an inherited
  writable data property or a miss is CreateDataProperty on the receiver. It assumes an object receiver; it has no
  §10.1.9.2 step 2.b test.
- **The live object layout is final.** `native-realm.ts` declares the realm's objects with `{ key }` only, so
  `native-object-layouts.ts` emits the final `$Object` (`createOpenObjectDeclaration`); the subtype-ready root
  (`createExtensibleOpenObjectDeclaration`) is behind the `extensible: true` opt-in, which nothing sets. The program
  layer never declares the realm-state layouts (`declareNativeRealmObjectLayouts` has no caller in
  `src/backend/wasmgc/program/`), so every live `realmState` field is absent.
- **Wrapper storage, #3518, wired nowhere**: `primitive-wrapper-layouts.ts` (`$StringObject` etc.: a final subtype of
  `$Object` with an immutable `[[XData]]` field 6), `primitive-wrapper-bodies.ts` (allocation with an explicit
  prototype; payload read), `string-create-body.ts` (`buildStringCreateDefinition`: own `length`, indices virtual),
  `to-object-body.ts`; backend owners `native-primitive-wrapper-layouts.ts`, `native-primitive-wrapper-storage.ts` and
  `native-string-create.ts`, which no `src` file imports. Their realm-state branch uses
  `realm-object-layouts.ts` `createRealmPrimitiveWrapperDeclaration`; `REALM_WRAPPER_STATE_FIELD` has no reader
  anywhere in `src`, `tests` or `scripts`.
- **The String exotic, #3518, half wired**: `string-exotic-bodies.ts` (array-index parse, the virtual own descriptor,
  and `buildStringExoticOwnDescriptorDefinition`, "virtual first, then the ordinary find", usable at every cursor of a
  prototype walk; a `$StringObject` is told apart by `ref.test` of its layout), `string-exotic-define-body.ts` and
  `string-own-keys-body.ts` (`buildStringOwnKeysDefinition`: indices, then strings, then symbols). The LIVE descriptor
  owner `native-object-descriptors.ts` already takes an optional `stringOwn` selection
  (`native-string-descriptor-selection.ts`) and then builds its define bodies in `string-exotic` mode; nothing
  supplies one. The composition of the String-aware find into the realm's lookup exists only in the test-only
  `native-mixed-object-access.ts`.
- **Legacy standalone wrappers** (`object-runtime.ts` `__new_Number` / `__new_String` / `__new_Boolean`): a null-proto
  `$Object` with a hidden `WRAPPER_PRIMITIVE_KEY` entry, read by `to-primitive-wrapper-bodies.ts`. A hidden key and no
  prototype; not reused (B2c-1 reached the same conclusion).
- **Conversion calls** (`prepare-number-conversion.ts` `prepareConversionResolvers`, Prepared only; the ordinary
  pipeline calls `prepareNumberConversionResolver` from `integration.ts`): `String(v)` holds while no source declares
  `String`; `Number(v)` is dropped by any value read of `Number`; no `Boolean` plan. `lowerPreparedNumberCall`
  (from-ast) sends a dynamic operand to `emitDynToNumber` but a native string to `js.number.from-value`, which the
  Prepared lane cannot materialize. The branch `claude/7350-string-call` (on origin at
  `b05ac3987041aa2bad4ba892cb0dca3c6b1003a3`; feature commit `e50febcb71`, "the String(v) call plan asks the pristine
  realm binding") makes the `String` plan ask G1's pristine test; it is not merged.
- **The prototype premise (M1, C1)**: no Prepared program obtains a built-in prototype, so a primitive's member read
  answers from `BUILTIN_REACHABLE_KEYS` (own or `undefined`, or a refusal by name) and a primitive's member write never
  meets a setter (`dynamic-member-access.ts`). `tests/issue-7354-m-prototype-premise.test.ts` pins
  `String.prototype`, `Number.prototype` and `Boolean.prototype` as refusals. `builtin-prototype-keys.ts` keeps
  `NUMBER_PROTOTYPE` and `STRING_PROTOTYPE` as hand lists "because the wrapper prototypes are not in the catalog yet".

### When a family is held (pay for what you use)

A wrapper family `X` is held, and its catalog rows enter the realm, only where the program's emitted IR uses it.
`heldFamilies` (`native-realm-requirements.ts`) derives this from the IR, never from the source:

- a `js.object.intrinsic` use naming a member of `X`: an identifier read of `X` that no fold answered, or (B3bc) a
  prototype or method read through it;
- (B3bc) a `js.object.create-wrapper` or `js.object.wrapper-data` use of `X`'s selector;
- (B3bc) a constant-key member read of a primitive of `X`'s kind whose key `%X.prototype%` owns (the catalog's key
  set). Today such a read refuses by name, so no program that compiles today changes;
- (B3bc) `Number.prototype.toString` with a radix argument also holds `%RangeError%` (the Error family) where the
  program can catch.

Not a use: a folded `Number.MAX_VALUE` (a constant, no intrinsic read), a `String(v)` / `Number(v)` / `Boolean(v)`
direct call (a conversion), `typeof X` (folded to "function"), and a primitive member read of a key the prototype does
not own. Such programs keep their bytes.

**Members** (blocker 10). G1's cost on the prelude: `assert(true);` 77,429 B; with the catch binding holding Error,
TypeError and Error.prototype.toString, 81,397 B (+3,968 B, +5.1 %); compile time unchanged within noise (G1 result
section of #7354). Holding every member of the String family is 53 function rows plus the prototype: an **estimate**
of 8 to 16 KB on the same prelude. Gate, measured first on the B3bc branch (prelude + one `new String("a")` row,
all members held vs the members the row reaches, bytes and median of 3 compiles): **more than 4 KB or more than 10 %
compile time ⇒ per-member holding**. Per-member holding holds the constructor, the prototype, every member whose name
is a constant key the program reads or writes (a member access, a `hasOwnProperty` / descriptor key argument), and the
members the IR's own algorithms call (`valueOf`, `toString`); where any computed-key access or own-key enumeration
could reach the prototype, all members. Today a computed key refuses by name and no own-key enumeration reaches a
prototype's non-enumerable members (`defineProperties` / `create` read enumerable keys only), so per-member holding is
unobservable. The estimate is above the gate, so expect per-member holding.

### Slice B3a — the constructors and Number's constants

**Behaviour:**

- `String`, `Number`, `Boolean` read as values where pristine: identity across reads, stored, passed, compared;
  `typeof` "function"; `X.name` and `X.length` (1) are served: every kernel entry seeds its own `length` and `name`
  (`buildFunctionLengthNameSeed`), so neither exposes the prototype.
- `Number.MAX_VALUE`, `MIN_VALUE`, `NaN`, `POSITIVE_INFINITY`, `NEGATIVE_INFINITY`: folded in the front end where
  `Number` is pristine (the constants are read-only and non-configurable, so the fold is exact). A read through a value
  (`var N = Number; N.MAX_VALUE`) is the realm's own data property, seeded from the catalog.
- `String()` "" (unchanged), `Number()` +0 (unchanged), `Boolean()` false (new); `String(v)`, `Number(v)` (now total:
  a native string operand takes the legalized ToNumber too), `Boolean(v)` (new, ToBoolean). The same answers where the
  callee is the realm value (`X` read as a value and called directly); through a variable (`var B = Boolean; B()`) the
  call is the dispatcher's built-in abort, as G1.
- `x instanceof X`: a primitive `x` answers false before `prototype` is read (C2 already does this); an object `x`
  reads `prototype` and traps (below).

**The prototype stays unreachable** (blockers 1+2). The constructor rows of B3a carry `length`, `name` and Number's
five constants only; no `prototype`. They are identity rows in B2b's sense, marked with B2b's
`BUILTIN_IDENTITY_ONLY_FLAG`:

- a **static** read of an unseeded key off a pristine constructor (`String.prototype`, `Number.isNaN`,
  `String.fromCharCode`) refuses by name in the legalization's member read: the receiver's definition is the realm
  intrinsic helper, so the key is known not seeded (`String.prototype is not reachable on this path yet (#7350
  B3bc)`);
- a **dynamic** own-property query on a marked bag that misses traps: [[Get]] (B2b's lookup status 4), [[HasProperty]],
  `hasOwnProperty`, `Object.getOwnPropertyDescriptor`, `delete` and a write of a missing key (which would otherwise
  create a writable `prototype`). B3a checks which of these B2b's mark already covers and extends the mark's test to
  the others in the same functions.
- B3a lands B2b's mark if B2b has not merged (the same code, cherry-picked from `8049075930`, not a second flag), and
  B2b then rebases onto it.

**Modules:**

| layer | module | change |
| --- | --- | --- |
| contract | `native-realm-catalog.ts` | `wrapperConstructorRows(name)` beside `errorRows`, same helpers (`callable`, `data`): length 1, constructible, `native`; Number's five constants as `{ kind: "number" }` data properties {!w, !e, !c}; `NATIVE_WRAPPER_CONSTRUCTORS`; the three ids appended to `NATIVE_VALUE_INTRINSICS` |
| runtime body | `realm-family-bodies.ts` | `RealmFamilyProperty` takes a number value (`f64.const`, boxed); the identity mark set on a row the catalog marks identity-only |
| backend | `native-realm-families.ts` | `familyProperties` passes number values instead of throwing |
| IR keys | `builtin-prototype-keys.ts` | `realmConstructorId(name)` (below) replaces `errorConstructorId`; `nativeConstantStatic("Number", name)` reads a constant off the catalog for the fold |
| IR holds | `native-realm-requirements.ts` | `heldErrorConstructors` becomes `heldFamilies`, one table: family → member ids, contracts, extra trigger (a bound catch payload for Error) |
| IR read | `identifier-read.ts`, `source-plain-objects.ts`, `dynamic-value-kinds.ts` | `realmIntrinsicRead` asks `realmConstructorId`; `namesErrors` becomes the set `realmFamilies`; `holdsErrors` a per-family question |
| IR member read | `dynamic-member-access.ts` | the static refusal of an unseeded key off an identity row |
| front end | `prepare-number-conversion.ts`, `from-ast.ts`, `realm-static-call.ts` | `Boolean` joins `ambientConversionCalls`' names (lowered as `dyn.truthy`, absent → false); the Prepared `Number` plan asks the pristine test like `String` (B3a absorbs `e50febcb71` and extends it to `Number`; `claude/7350-string-call` is then closed in favour of B3a); `lowerPreparedNumberCall` boxes a non-dynamic operand and takes `emitDynToNumber` on the Prepared lane; the `Number.<constant>` fold sits beside the static call form in `realm-static-call.ts` |

**Yield:** measured upper bound 92 of bucket A's 109, at most 98 with the `Number(v)` fix (6 rows stop at its gap);
1 file of the 420 sample.

### Slice B3bc — wrappers and the reachable prototypes

B3b and B3c are one slice (review finding 13): a wrapper is useless without ToPrimitive through `valueOf` /
`toString`, and the prototypes become reachable in the same change.

**Representation** (the IR's own choice; nothing mirrors legacy):

- A wrapper is an ordinary realm object of #3518's typed layout `$XObject`: [[Prototype]] `%X.prototype%`, the payload
  in the immutable `[[XData]]` field, the `object` kind (`typeof` "object", truthy, `===` identity). Every kernel
  operation is total over `$Object`. Declaring the subtype needs the extensible `$Object` root: the realm sets
  `extensible: true` only where it holds a wrapper family, so other realm programs keep the final type and their
  bytes.
- `%String.prototype%`, `%Number.prototype%`, `%Boolean.prototype%` are wrappers with "", +0 and false (§22.1.3,
  §21.1.3, §20.3.3), allocated by the wrapper allocation, not `createWithPrototype`. The constructor rows gain their
  `prototype` property, lose the identity mark, and the prototype and method rows join the catalog.
- **String exotic objects use the existing exotic arm** (blocker 4; decided, no materialising): String creation is
  `string-create-body.ts` (own `length`, indices virtual). Where the String family is held the realm supplies:
  `stringOwn` to the live `native-object-descriptors.ts` (its define bodies switch to their existing `string-exotic`
  mode), and the String-aware find (`buildStringExoticOwnDescriptorDefinition`, owned by
  `native-string-exotic-own-descriptors.ts`) as the `findOwn` the realm's lookup, `has`, own-descriptor and kernel
  [[Get]] call at each cursor (`native-object-access.ts`, `native-builtin-functions.ts` `findOrdinary`), as
  `native-mixed-object-access.ts` composes it today. Own keys: `string-own-keys-body.ts` where the realm enumerates an
  object's own keys. Feasible: each site takes the find as a function handle, and the virtual lookup tells a
  `$StringObject` apart by `ref.test`. If one site cannot take it, that operation on a value that may be a String
  wrapper refuses by name, and the plan's review is reopened; there is no materialised second mechanism either way.

**Rules** (blocker 3):

- **[[Get]] with a primitive receiver.** `"a".m`, `(5).m`, `true.m` where the family is held: the realm's [[Get]] on
  `%X.prototype%` with the primitive as Receiver; a getter there runs with the primitive as `this`. A string's own
  `length` and indices answer before the prototype (the String-aware find on its value, by the same exotic arm).
- **[[Set]] with a primitive receiver** (§10.1.9.2): OrdinarySet on `%X.prototype%` with the primitive as Receiver.
  An inherited data property, writable or not, and a miss answer `false` (step 2.b: Receiver is not an object), so
  a sloppy write is a no-op and a strict write a TypeError; never an own write. An inherited setter runs with the
  primitive as `this`, answering `true`; a setter-less accessor answers `false`. A string's own `length` and indices
  are non-writable: `false`. The step-2.b test goes into the kernel's set body (`source-object-bodies.ts`), before
  its own-update and CreateDataProperty, not into the IR.
- **`this` of a primitive** (§10.2.1.2 OrdinaryCallBindThis): strict code gets the primitive (unchanged). Sloppy code
  gets ToObject(this), a fresh wrapper, so `typeof this` is "object" and each call sees a new object.
  `dynamicCurrentThis`'s abort arm gains, for each primitive kind whose family is held, `js.object.create-wrapper` of
  that kind; `undefined` and `null` stay the abort (they need the global object, Session B). A primitive receiver
  reaches a sloppy function only through a held prototype (a method, getter or setter defined there), so the family is
  always held where the arm is needed. This is one arm, not a separate mechanism.

**Behaviour in scope:**

- `new String(v)`, `new Number(v)`, `new Boolean(v)`, without argument and without parentheses: ToString / ToNumber /
  ToBoolean of `v` (absent: "", +0, false), then the wrapper; a second argument is evaluated and ignored.
- A wrapper as a value: identity, truthiness, `instanceof X` true, `Object.prototype.toString` `[object String]` etc.
  (`dyn.object_tag` tests the layout by `ref.test`, beside `is-error`), own property reads and writes, as a descriptor
  object or a property key.
- `X.prototype` (!w, !e, !c), `X.prototype.constructor === X`, writes to `X.prototype` and their reads from objects,
  wrappers and primitives.
- ToPrimitive of a wrapper through the realm's `valueOf` / `toString`, recognised by identity, so an override
  (`Number.prototype.valueOf = f`) is seen.
- Calls by identity (P1's expansion): `valueOf()` and `toString()` of the three on a wrapper, a primitive and the
  prototype itself (`Number.prototype.toString(16)` is "0"). Their `this` is thisXValue: the payload of a primitive or
  of a wrapper of that kind, else a TypeError.
- `Number.prototype.toString(radix)` (§21.1.3.6): thisNumberValue first; `radix` undefined → 10; otherwise
  ToIntegerOrInfinity(radix), outside 2–36 a RangeError (test262 `S15.7.4.2_A4_*`); radix 10 is ToString, any other
  the native number formatter's radix bodies.
- Every other method is a function object (real `name`, `length`, [[Prototype]] `%Function.prototype%`, no
  `prototype`) whose own properties can be read, written and deleted.

**Not in scope, and what happens instead** (never a wrong answer; statically visible → named refusal, else the
uncatchable `unreachable`):

- A call of a method without an algorithm (`indexOf`, `substring`, `trim`, `fromCharCode`, …) in P1's `o.m(…)` shape:
  refuses by name (`String.prototype.indexOf has no Prepared algorithm`). Through any other value: the dispatcher's
  built-in abort.
- `.call` / `.apply` / `.bind` on a built-in method: unchanged (refused by name through `FUNCTION_REACHABLE_KEYS`);
  #7350 G4 / #7349 S7.
- Loose `==` / `!=` with a wrapper: stays the existing refusal (`dyn.eq (loose)`).
- ES2015+ members (`Number.isNaN`, `Number.EPSILON`, `String.raw`, `String.prototype.at`, …): held as the
  specification gives them where held at all; their calls refuse by name like any other method.
- `Object(v)` / `new Object(v)` (ToObject of a primitive, 40 `new Object` and 14 `Object(v)` first stops in the
  carriers): not here; it can reuse `create-wrapper` later.
- A shadowed, assigned or `var`-declared `String` / `Number` / `Boolean`: not pristine; the existing rules
  (`scriptVarOfRealmGlobal` picks the three up through `REALM_GLOBAL_NAMES`).

**Modules:**

| layer | module | change |
| --- | --- | --- |
| contract | `native-realm-catalog.ts` | `wrapperRows(name)` completes B3a's constructor rows: own `prototype`, the prototype row with a `primitiveData` field and `constructor`, one row per method; `NATIVE_MEMBERS` gains `valueOf` / `toString` of the three prototypes; ids appended to `NATIVE_VALUE_INTRINSICS` |
| runtime body | `primitive-wrapper-bodies.ts` (blocker 5: no new file) | thisXValue (`buildPrimitiveWrapperThisValueDefinition`: the payload of a primitive or a wrapper of that kind, else the realm's TypeError) beside the existing allocation and payload read; Boolean and Number creation use the existing allocation; String creation is `string-create-body.ts` |
| runtime body | `realm-family-bodies.ts` | an object row with primitive data is allocated as a wrapper |
| backend | `native-realm.ts`, `native-builtin-functions.ts`, `native-primitive-wrapper-layouts.ts`, `native-primitive-wrapper-storage.ts`, `native-string-create.ts`, `native-object-descriptors.ts`, `native-object-access.ts` | the wrapper owners and String create become live, reserved only for held kinds; `stringOwn` and the String-aware find are supplied where String is held; `errorCreateOperands` becomes one family-create operand builder |
| contracts | `src/ir/runtime/ordinary-object-callables.ts` | `js.object.create-wrapper(value, selector)`, `js.object.wrapper-data(object, selector)` |
| IR construction | `dynamic-wrapper-constructors.ts` (new, sibling of `dynamic-error-constructors.ts`, same shape) | `new X(v)` and the value-route call `X(v)` |
| IR methods | `dynamic-prototype-methods.ts`, `ordinary-to-primitive.ts`, `dynamic-value-chains.ts` | `RealmMethod` becomes a table (name, catalog id, algorithm); P1's `name === "toString" && errors` case and the `errorToString` hook become one realm-method-by-identity list, used by the call expansion and by ToPrimitive |
| IR member access | `dynamic-member-access.ts` | the primitive read and write arms of a held kind go to the held prototype (rules above); an unheld kind keeps the static premise |
| IR `this` | `dynamic-function-operations.ts` | `dynamicCurrentThis`'s sloppy arm wraps a primitive of a held kind |
| IR keys | `builtin-prototype-keys.ts` | `NUMBER_PROTOTYPE` / `STRING_PROTOTYPE` become `realmStringKeys("%Number.prototype%")` / `("%String.prototype%")` |

**Yield:** estimate about 260 of bucket B's 399 (66 of a random 100 with wrappers rewritten to primitives) plus part
of C's 219 (not measured: C cannot be rewritten); 10 to 20 files of the 420 sample (estimate).

**B3d** (own plan, not part of B3): String / Number method algorithms, after their bodies move from
`src/codegen/string-ops.ts` to the native runtime as B2c-1 did, and `.call` on them with G4. Bucket D's 195, plus 56
`method call .trim(...) on string` first stops on primitives.

### One recogniser (finding 6)

- **Base, catalog side:** `realmConstructorId(name)` in `builtin-prototype-keys.ts`, from `NATIVE_ERROR_CONSTRUCTORS`
  and `NATIVE_WRAPPER_CONSTRUCTORS`: the catalog id and family of a global name, or none. `realmIntrinsicRead`,
  `realmBuiltinOperand` and `programObjects` ask it.
- **Derived, IR side:** `realmConstructorOf(callee, definitions)` in `dynamic-realm-calls.ts`: unwraps coercions, reads
  the helper symbol's id (`realmIntrinsicOfHelper`), and answers `{ family, selector }` from the same lists through
  `realmConstructorId`'s table. The legalization's construct arm and dispatched-call arm switch on it once.
- Removed: `errorConstructorId`, `errorConstructorSelector`, `errorConstructorOf`.

### Reuse, and the duplicates it removes

- **Reuses**: G1's catalog shape, family allocation and seeding, `heldWith`, `js.object.intrinsic`, the pristine
  predicate (`builtin-global-binding.ts`); B2b's identity mark; P1's identity-tested call expansion; F2's call ABI and
  dispatcher; C2's `dyn.construct`, `dyn.instanceof` and `dynamicCurrentThis`; the legalization's ToString
  (`stringOf`), ToNumber (`toNumber`), ToBoolean (`js.value.to_boolean`) and number formatter; #3518's wrapper layout,
  allocation, String create, String exotic find, define and own-keys bodies, and their owners.
- **Removes**: `NUMBER_PROTOTYPE` / `STRING_PROTOTYPE`; the `errorToString` hook and P1's toString special case;
  `heldErrorConstructors`' Error-only shape; `namesErrors` as a boolean; `errorConstructorId` /
  `errorConstructorSelector` / `errorConstructorOf`; the Prepared `Number(v)` route to `js.number.from-value`;
  (finding 7, verified: no live reader) `REALM_WRAPPER_STATE_FIELD`, `createRealmPrimitiveWrapperDeclaration` and the
  `realmState` branches of `native-primitive-wrapper-layouts.ts`, `native-primitive-wrapper-storage.ts` and
  `native-string-create.ts`, with the #3518 tests that exercise only those branches (listed in the PR). If B3bc ends
  up wiring the String exotic arm only partly, the bodies it leaves unused go in the same PR.
- **Does not add**: a second object layout, a hidden-key wrapper, materialised string indices, a second identity flag,
  a second call mechanism, or a selector-side copy of the read rules.

### Acceptance criteria

Correctness:

1. Census (real harness) on the 1,068 stop files and on the 420 sample, base vs head: files gained per slice, files
   lost 0, new crashes 0. Named rows that must pass:
   - B3a: `language/expressions/division/S11.5.2_A4_T1.1.js` (`Number.NaN`, the infinities),
     `language/expressions/modulus/S11.5.3_A4_T3.js` (both pass in the rewrite).
   - B3bc: `language/expressions/division/S11.5.2_A3_T1.1.js` (Boolean wrapper ToNumber) and
     `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-40.js` (wrapper as key), both pass in the rewrite;
     `language/expressions/conditional/S11.12_A4_T2.js` (identity; the rewrite cannot show it: `NaN !== NaN`). To
     confirm on the branch before they become criteria (bucket C, no rewrite possible):
     `built-ins/Number/S15.7.5_A1_T02.js` (`(new Number()).toString === Number.prototype.toString`),
     `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-85.js` (descriptor of `Boolean.prototype.toString`),
     `built-ins/Number/prototype/toString/S15.7.4.2_A2_T14.js` (Number.prototype's +0), and the
     `S15.7.4.2_A4_*` RangeError rows.
   Each gained row gets a mutated twin (flip one expected value) that must fail in the same run.
2. A probe matrix against node, each row with a wrong twin, at module level and inside a function:
   - B3a: the three names in every value position; `X.name`, `X.length`; `String.prototype`, `Number.isNaN`,
     `String.fromCharCode` read statically (named refusal); `var S = String; S.prototype`, `"prototype" in S`,
     `S.hasOwnProperty("prototype")`, `Object.getOwnPropertyDescriptor(S, "prototype")`, `delete S.prototype`,
     `S.prototype = 1`, `({}) instanceof S` (each traps, inside `try` / `catch` and inside an `assert.throws`-shaped
     function: never caught); `1 instanceof S` false; `String()`, `Number()`, `Boolean()`, `Boolean(0)`,
     `Number("3")`, each also through the realm value (`X` read, then called).
   - B3bc: `new X(v)` over undefined, null, numbers, strings, Booleans, an object with `valueOf` / `toString`;
     ToPrimitive with an overridden `X.prototype.valueOf`; `Number.prototype.toString()` / `(undefined)` / `(16)` /
     `(1)` / `(37)` / `(Infinity)` (RangeError for the last three, caught); writes to `X.prototype` read through a
     primitive and through a wrapper; [[Set]] on a primitive: an inherited writable data property in sloppy code (no
     own property appears, the prototype's value stays) and in strict code (TypeError), an inherited setter (runs, its
     `this` is the primitive in strict code and a fresh wrapper in sloppy code: `typeof this`, and `this !== this` of
     two calls), a setter-less accessor; a getter on `String.prototype` read off `"a"` (same two `this` cases); a
     sloppy and a strict method defined on `Number.prototype` called on `5`; `new String("ab")`'s `length`, `[0]`,
     `[2]`, `hasOwnProperty("0")`, `Object.getOwnPropertyDescriptor(w, "0")`, a write and a `defineProperty` of `"0"`
     and of `"5"`; a shadowed and an assigned name.
   Nothing claimed answers differently from node; refusals and aborts are by name or `unreachable`.

No regression:

3. No test262 verdict regresses in any edition; the per-edition ratchet holds (ES5 is `completed`). Locally: the
   census on every ES5 file whose routing changes (the 1,977 carriers) plus 500 others, base vs head; CI's merge group
   is the gate.
4. JS-environment and ordinary-pipeline output byte-identical: the change touches no `src/codegen/` and no
   `integration.ts` path; checked with `prove-emit-identity.mjs` on the 1,977 carriers × default and standalone.
5. Prepared bytes: `check:prepared-bytes` (804 rows) identical for every program that holds no wrapper family
   (selectors appended; literals follow the held rows; the final `$Object` kept). Rows that change are listed, each
   run on base and head with the same outcome. Plus (finding 9): the prepared bytes of `var x = Number.MAX_VALUE;` equal
   those of `var x = 1.7976931348623157e308;`, and likewise for the other four constants.
6. Pins that move are listed in the PR: the three `m-prototype-premise` refusals (B3a: refusals with the new name;
   B3bc: value tests whose onward routes still abort or refuse); `t2-typeof-standard-globals`;
   `issue-7354-str2-to-string`'s "String not in scope" pin.

Code quality:

7. One catalog shape (`wrapperRows` next to `errorRows`, same helpers); one recogniser pair (base and derived, above);
   one held-family table; one realm-method-by-identity table; one identity mark; `dynamic-wrapper-constructors.ts` in
   the shape of its Error sibling; wrapper bodies in `primitive-wrapper-bodies.ts`.
8. The removals above are in the diff, including `errorConstructorOf`, `errorConstructorId`, the two hand lists,
   `REALM_WRAPPER_STATE_FIELD` and `createRealmPrimitiveWrapperDeclaration`.
9. (Finding 8) A unit test: for each wrapper prototype, the catalog-derived key set united with Object.prototype's
   keys equals the old `NUMBER_PROTOTYPE` / `STRING_PROTOTYPE` union (measured equal against node 22 above), so a
   program that holds no family reads primitives exactly as before.
10. No `loc-budget-allow` or `func-budget-allow`: `from-ast.ts` (over the 1,500-line threshold) ends at or below its
    base; `dynamic-value-legalization.ts`, `dynamic-value-chains.ts` and `realm-family-bodies.ts` do not grow past the
    new modules' share. Gates run bare before each commit.
11. A fresh-context adversarial review per slice, given the diff and this plan, asked to prove the quality goal was
    not met; its verdict is in the PR body.

### Risks and open questions for the plan review

1. **The prototype premise ends for three kinds (B3bc).** Primitive member reads and writes go through the held
   prototype, setters and getters included. Programs that hold no family keep the old arms and bytes. The kernel's
   [[Get]] must take a primitive Receiver (to verify: today every receiver is an object; the accessor call passes it
   through).
2. **B2b's identity mark.** B3a needs it; it is on an unmerged branch. Its own-query coverage (has-own, descriptor,
   delete, write) is to be checked and completed in the same functions.
3. **The extensible `$Object`.** A program holding a wrapper family declares the non-final root; check that no
   `ref.cast` / `br_on_cast` fast path relies on the final type.
4. **String exotic wiring.** The String-aware find must reach every own-property site of the realm (lookup, has, own
   descriptor, kernel [[Get]], own keys). If one cannot take it, that operation refuses by name for a value that may be
   a String wrapper.
5. **Byte size.** The member gate above; per-member holding is expected.
6. **Session B.** The global object (B2b) must hold the same function objects (`globalThis.String === String`): its
   realm property for the three names reads `js.object.intrinsic`. `Number.parseFloat` / `Number.parseInt` must be
   B2c's `parseFloat` / `parseInt` objects (same catalog ids), not copies.
7. **G1's shape**: `familyProperties` throws on number values and `realmFamilyAllocation` knows only
   `createWithPrototype`; both are generalised, not forked. `NATIVE_VALUE_INTRINSICS` is positional: append only.
8. **`Number(v)` on the Prepared lane**: the string-operand route changes from an unmaterializable provider to the
   legalized ToNumber. No program that compiles today changes; the 30 carriers that stop at setup get past it.
9. **Measurement caveats**: the sample is not the lead's 411 rows; buckets are from regexes; the B upper bound replaces
   wrappers by primitives, which hides wrapper-only differences (`typeof`, identity) and adds artefacts (9 rows); the
   member-size figure is an estimate from G1's cost.

### Changelog after PRV-B3 (2026-11-26)

| finding | resolution |
| --- | --- |
| 1+2 prototypes reachable in B3a | B3a is constructors and constants only; no `prototype` on its rows; B2b's identity mark: a static unseeded key refuses by name, a dynamic own miss traps; `name` / `length` served from the kernel's seed; bucket A's yield unchanged (it reads no prototype) |
| 3 primitive receivers | Rules stated for [[Get]], [[Set]] (step 2.b in the kernel's set body) and `this` (ToObject in `dynamicCurrentThis`'s sloppy arm via `create-wrapper`; main has none today and aborts); probe rows with twins |
| 4 String indices | Decided: the #3518 exotic arm (`stringOwn` into the live descriptor owner, the String-aware find into the realm's lookups, `string-own-keys-body.ts`); feasibility stated; no materialising |
| 5 new body file | Dropped; thisXValue goes into `primitive-wrapper-bodies.ts`, String creation is `string-create-body.ts` |
| 6 two recognisers | `realmConstructorId` is the base, `realmConstructorOf` derives from it; `errorConstructorOf` / `errorConstructorId` / `errorConstructorSelector` removed |
| 7 dead realm-state wrapper code | Verified unused on the live path; deletion committed in B3bc |
| 8 key lists | Diffed against node 22: equal; acceptance criterion 9 |
| 9 folded constants | A fold is not a use; holding trigger listed; byte-equality criterion for `Number.MAX_VALUE` vs the literal |
| 10 member cost | Gate up front (> 4 KB or > 10 % compile time ⇒ per-member holding), fallback rule, estimate from G1's measured cost |
| 11 `toString(radix)` | undefined → 10, RangeError outside 2–36, probes and `S15.7.4.2_A4_*` rows |
| 12 empty calls | `String()` / `Number()` / `Boolean()` direct and through the realm value; probes |
| 13 slicing | B3b and B3c merged into B3bc with its yield |
| other | `claude/7350-string-call` cited (`b05ac39870…`, feature commit `e50febcb71`); B3a absorbs it, the branch closes in its favour |

### B3a result (2026-11-26, branch `claude/7350-b3` on main `bb9123f6a3`)

**Built** (one code commit): the catalog's `wrapperRows` (identity rows, `identityOnly`, Number's five constants;
ids appended to `NATIVE_VALUE_INTRINSICS`); the kernel's identity mark (`BUILTIN_IDENTITY_ONLY_FLAG`, B2b's name and
bit); `realmConstructorId` / `realmConstructorOf` replacing the three Error recognisers; `HELD_FAMILIES` replacing
`heldErrorConstructors`; `realmFamilies` / `holdsFamily`; `dynamic-wrapper-constructors.ts`; the static refusal of an
unseeded key in `dynamic-member-access.ts`; the folds (`typeof X`, `Number.<constant>`) and the conversion calls in
`realm-static-call.ts`; the pristine conversion plans (e50febcb71 absorbed, extended to `Number` and `Boolean`).

**Deviations from the plan** (the code's reality):

- *The mark's test sits in the kernel's own-property find* (`buildBuiltinFunctionFindOwn`), not in B2b's lookup status
  4: every own query of a function object passes that find ([[Get]], [[HasProperty]] and [[Set]] through the lookup,
  HasOwnProperty, [[GetOwnProperty]]), so one test covers all of them; the kernel's define probes the find first, so
  `Object.defineProperty(S, "prototype", …)` aborts too. Both are emitted only where the realm holds an identity row,
  so every other program keeps its bytes. B2b's ordinary-object arm (its identity-only namespaces) is not in B3a; B2b
  adds it to the same find when it rebases. `delete` and `in` of a constructor's key stay compile-time refusals
  (`delete has no IR lowering`, `__extern_has`).
- *A static write* of an unseeded key (`Boolean.prototype = 1`) refuses by the write route's own receiver refusal
  (`identifier "Boolean" is not in scope`) before the legalization's named refusal is reached; still a named refusal.
- *`Number.isNaN(v)` / `Number.isFinite(v)` calls* are claimed first by an existing static-call lowering and answer as
  node (as on base); only a read of such a static (`var f = Number.isNaN`) reaches the named refusal.
- *Byte criterion*: `var x = Number.MAX_VALUE;` alone is not byte-equal to the literal program, because the #3418
  dead-binding elision (shared with the ordinary pipeline, not changed here) drops `var x = <literal>` but keeps a
  member read, which may run code in general. With `x` read, the five pairs are byte-identical (pinned in the test).
  For the fold to give the literal's bytes, `source-dynamic-provenance.ts` treats a folded constant as typed like a
  numeric literal.
- *Conversion lowering*: the Prepared lane's `Number(v)` / `isNaN(v)` / `Boolean(v)` lower in `realm-static-call.ts`
  (`lowerRealmConversionCall`); the ordinary pipeline's `lowerPreparedNumberCall` keeps its body unchanged. An admitted
  conversion call is exempt from the implicit-flow rule (its value is a primitive), which `Number({})` in a typed
  return needed once its operand became a carrier.
- *`String(object)`* (direct call) still refuses (`String() of externref operand`), as on base; the value route
  (`(0, String)(obj)`) converts.
- *`typeof` fold* applies to every realm constructor (the Error constructors too): `check:prepared-bytes` is identical
  on all 804 rows, so no measured program changed.
- `builtin-global-binding.ts` now unwraps type assertions in a write target (`(String as any) = …`), which the absorbed
  plan test needed.
- Criterion 9 (prototype key sets) belongs to B3bc: B3a adds no prototype.

**Measured** (`prepared-census.mts --harness real --jobs 3`, base = detached `bb9123f6a3`, head = this branch):

| list | base pass | head pass | gained | lost | new crashes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,068 stop files | 0 (1,068 CE) | 107 (+4 fail, 957 CE) | 107 | 0 | 0 |
| 411-row shared sample (`.tmp/o411`) | 63 | 70 | 7 | 0 | 0 |
| 420 sample (`l420.txt`) | 59 | 62 | 3 | 0 | 0 |

The 4 new `fail` rows are uncatchable aborts (`unreachable`: `Object.getOwnPropertyDescriptor(String, "prototype")`
three times, `str.constructor` once), never a wrong answer. Named rows: `division/S11.5.2_A4_T1.1.js` and
`modulus/S11.5.3_A4_T3.js` pass; their mutated twins fail. All 112 gained rows got a mutated twin (one expected value
or condition flipped); all 112 twins fail.

**No regression**: `check:prepared-bytes` 804/804 identical; ordinary pipeline sample (198 carriers × default and
standalone) 396/396 identical; `prove-emit-identity` 60/60 identical. Test suites: `issue-7354-*` and `issue-7350-*`
fail only `o-objects` "refuses what the later steps build" (fails on base too); `issue-3518-*` fails the same 131
tests on base and head.
