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

## Slice B2c-2 plan — Error message slot and JSON quote / parse-primitive bodies move to the native runtime (2026-11-19)

Second surface of the B2c move (B2c-1: `parseFloat` / `parseInt`, PR #7323): pure body builders leave codegen
for `src/runtime/wasmgc/values/`, bytes identical, so the realm can bind them later.

**Target structure.**

- `buildUndefinedAwareMessageSlot(anyTypeIdx, argCount, existingLocalCount)` joins `buildErrorConstructorBody`
  in `error-bodies.ts`, which codegen (`registry/error-types.ts`) and the backend (`native-errors.ts`) already
  share. Codegen's `fillErrorCtorUndefinedMessage` keeps the finalize patch and the "no `$AnyValue` reserved"
  test, now made once before the loop instead of per constructor.
- New `json-bodies.ts`: `buildJsonQuoteStringDefinition(bindings)` and
  `buildJsonParsePrimitiveDefinition(bindings)`, each `→ { locals, body }`. Bindings: `$AnyString`,
  `$NativeString`, `$__str_data`, the `__str_flatten` handle and, for the parser, `$AnyValue`.
  `src/codegen/json-runtime.ts` keeps registration only: function type, handle, `funcMap` row, the
  `ensureNativeStringHelpers` / `ensureAnyValueType` calls, and one `registerJsonHelper` both share.
- `counterLoopInstrs` (`emit-idioms.ts`, #3105) moves with its only user from `src/codegen/` to
  `src/runtime/wasmgc/values/`: the runtime layer may not import codegen.

**What it reuses / removes.** Both JSON bodies opened with the same flatten preamble (differing only in the
local that takes the offset) and the same `c = data[i]` read: now `flatStringPreamble(b, offLocal)` and
`readCodeUnit(d)`. The quote builders' private `cEq` and the parser's `cEq` become one. Inside the parser the
three digit loops share `digitLoop`, the two mantissa updates `accumulateMantissa`, the two power loops
`scaleByTenLoop(op, step)`, the four `$AnyValue` boxes `boxAnyValue`. `emitJsonParsePrimitive` (534 lines) and
`emitJsonQuoteString` (328), both over the function budget, are gone; no new function exceeds 300 lines.

**Acceptance.** Bytes identical on default, standalone and linear over every test262 file whose source names
`JSON` or calls a native Error constructor (`Error(`, `TypeError(`, …), plus the 103-file control sample
(`scripts/check-bytes-identical.mts` from B2c-1); the two JSON bodies' instruction trees identical to base;
the surfaces' tests fail identically on base and head; the new files join the `native-runtime` layer.
Quality: the builders read only their bindings.

**B2c-2 measured (2026-11-19, main `89e4748241`).** `check-bytes-identical.mts` over 1,004 test262 files (362
whose source names `JSON`, 550 that call a native Error constructor, plus the 103-file control sample;
2,728 rows): 0 rows differ. Binaries compared: 762 default, 762 standalone, 3 linear (100 files compile on
neither tree, 142 are runner skips; linear compiles almost none of the harness-wrapped files, as in B2c-1).
`__json_parse_primitive` is not reachable from any test262 file: its only caller, `tryEmitJsonParsePrimitive`,
is `void`-ed in `call-namespace-static.ts` since `JSON.parse` moved to the `__json_parse_text` codec. Both JSON
bodies were therefore also dumped on base and head with a mocked context (`.tmp/b2c2-dump.test.ts`): the
pushed function records, instruction trees included, are identical byte for byte, as is the call order of
type, handle and `funcMap` registration. Sizes: `json-runtime.ts` 991 → 109 lines, `error-types.ts`
1,081 → 1,006; `json-bodies.ts` 822 (largest function `qQuoteBuilders`, 259, moved unchanged);
`error-bodies.ts` 59 → 137. Fourteen test files for these surfaces (`issue-1342`, `issue-1599*`,
`issue-1636-json-stringify`, `issue-2933`, `issue-6651-error-undefined-message`, `issue-4376`, `issue-4262`,
`issue-5161`, `issue-2029-…-standalone`, `issue-3518-native-string-error-resources`, `issue-3105`): 160 pass /
21 fail on both trees, the same rows.

**RV7330 follow-up (2026-11-19).** `__json_parse_primitive` is deleted instead of moved (review S2): it was
unreachable, so moving it kept a second decimal scanner alive for nothing. Removed: `buildJsonParsePrimitiveDefinition`
and its helpers (`digitLoop`, `accumulateMantissa`, `scaleByTenLoop`, `boxAnyValue`, `skipJsonWhitespace`, …),
`emitJsonParsePrimitive`, `tryEmitJsonParsePrimitive` and its `void` reference. With one body left,
`registerJsonHelper` and `jsonBodyBindings` fold into `emitJsonQuoteString`, and `flatStringPreamble` loses its
offset-local parameter. A `tests/issue-1599-runtime.test.ts` row pins that runtime `JSON.parse` emits
`__json_parse_text` and never `__json_parse_primitive`. The three copies of the flatten preamble across the
native runtime (review S1) are #7402, after #7323 and #7330 land.

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

**After review RV7433** (fixes on the same branch):

- *Statics refuse by name.* `Object.getOwnPropertyDescriptor` / `defineProperty` with a string-literal key, and
  `defineProperties` with a literal map, whose target is the pristine `String` / `Number` / `Boolean` and name a key
  the identity row lacks, refuse at the front end (`tryLowerRealmStaticCall`) with the member read's wording
  (`String.prototype is not reachable on this path yet (#7350 B3bc)`). Both sites call one test,
  `identityOnlyKeyRefusal` (`builtin-prototype-keys.ts`). The statics' check sits in the front end, not in
  `dynamic-object-statics.ts`: a literal map's keys exist only in the AST (in IR they are result-less
  `js.object.define-data` calls that `definitions` does not reach), and one site for all three statics beats two
  layers. A key the row has (`getOwnPropertyDescriptor(Number, "MAX_VALUE")`) lowers as before; a key known only at
  run time still reaches the kernel's abort. As for the member read, a refusal inside a function declaration's
  unit still compiles to that unit's abort body.
- *One miss check after B2b rebases.* B3a's own-property find already covers every own query, so `claude/7350-b2b`
  drops its lookup-walk check (`identityOnlyMiss` in `builtin-function-prototype-bodies.ts:58`) and its own mark
  helper (`builtin-function-bodies.ts:135`) when it rebases onto B3a. The repo keeps one miss check, the find's.
- `RealmConstruction` / `RealmConstructionBuilders` moved to `dynamic-realm-calls.ts` beside `realmConstructorOf`.
- `X(v)`'s conversion and absent-argument answer ("", +0, false) have one owner, `WRAPPER_CONVERSIONS`
  (`builtin-prototype-keys.ts`), which `lowerRealmConversionCall` and `dynamicWrapperConstruction` both read. The
  direct `String(v)` route (`isAmbientStringBinding`) does not join: it is the ordinary pipeline's ambient-`String`
  lowering, shared with the JS-environment and legacy paths, and moving it would change their bytes.

## Implementation Plan — B3bc: wrappers and the reachable prototypes (2026-11-26, on B3a `1770ed68f3`)

This extends "Slice B3bc" above. That sketch stays the behaviour specification (representation, rules, scope, not in
scope). This section adds the measured yield, the target structure per module, the split into two PRs, PRV-B3's
three conditions, the B2b verdict, and two to-dos from review RV7433.

Revised 2026-11-26 after the plan review PRV-B3bc (blocker on `32e1685d00`); the changelog is at the end of this
section. The measurement inputs and the stub are in `plan/samples/7350-b3bc/`.

### Measured (2026-11-26)

**Heads.** Main is `c3b7be667a`, 9 merges after the lead's census head `6694a8b8`, with the same three counts. B3a is
`1770ed68f3` (PR #7433). The tool is `scripts/ir-census/prepared-census.mts --harness real --jobs 3`, run on
`git archive` copies of each head. The lists, the stub patch and the exact commands are in `plan/samples/7350-b3bc/`
(README); the result files were scratch and are not committed.

**Lists.**

- *Carriers*: 1,977 files, every ES5 file whose source names `String`, `Number` or `Boolean`. It is the same list as
  B3's.
- *o411*: `plan/samples/7354-o411.txt`, from `b1a7c75a16` (tip of `origin/claude/7354-o411-sample`; the list is
  byte-identical to the one at `155b06691f` and to `.tmp/o411/sample.txt` of the B3 worktree). This branch commits a
  copy.
- *l420*: B3's 420-row sample.

**Main.** The first stops on `new X` are 281 `String` + 174 `Number` + 172 `Boolean` = 627 files, all of them
carriers (re-derived; the lead's numbers hold). Main passes 87 carriers, 63 of o411 and 59 of l420.

**B3a.** B3a passes 228 carriers, 70 of o411 and 62 of l420. On B3a, 728 carriers stop first at a wall B3bc owns:

| first stop on B3a | files |
| --- | ---: |
| `new String` / `new Boolean` / `new Number` (a wrapper object; #7350 B3bc) | 185 / 140 / 139 |
| `String.prototype` / `Number.prototype` / `Boolean.prototype` is not reachable (member read; 3 more in the front end) | 154 / 68 / 9 |
| other keys a constructor's identity row lacks: `fromCharCode` 19, `hasOwnProperty` 8, `bind` 3, `EPSILON` 1 | 31 |
| `identifier "Number" is not in scope` (a statement-form expando, to-do 2 below, and a binding write) | 2 |

Of main's 627 `new X` files, B3a moves 170 to an earlier wall that is not B3bc's: arrays 54, RegExp 44, `delete` 21,
`Object` as a value 17, and others. Main stops at `new X` before it reaches them; B3a's `new X` refusal sits later, in
the legalization.

**Method: two probe builds.** The census reports first stops only, so a stub stands in for B3bc. It is two scratch
copies of B3a (never committed), and the stub claims exactly what B3bc claims:

- `new X(v)` converts its argument as B3bc will. One build answers a fresh ordinary object (an object, like the
  wrapper). The other answers the primitive.
- `identityOnlyKeyRefusal` no longer refuses.
- A primitive's read of a key its wrapper prototype owns no longer refuses. Its arm stays the run-time abort.
- A JavaScript expando statement on the three names no longer makes them non-pristine (to-do 2).

The stub keeps refusing what B3bc will refuse:

- a call of a wrapper method without an algorithm in the `o.m(…)` shape (B3d);
- a static call `X.m(…)` other than Object.prototype's methods;
- `.call` / `.apply` / `.bind` read off a built-in wrapper method (G4).

Each row records which stub hooks fired. B3a's identity mark still traps in both builds, so the run-time verdict is
meaningful only for rows that read no prototype or constructor key.

**The stub is committed** as `plan/samples/7350-b3bc/stub.patch` (on B3a `1770ed68f3`; `B3BC_STUB=object` or
`primitive` picks the stand-in; marked `B3BC-STUB`, never to merge). The original scratch trees were gone, so the patch
is a reconstruction from this section and the recorded hooks, re-run on the 728 wall files in both builds:
- `B3BC_STUB=primitive`: 728 / 728 rows with the original verdict and detail;
- `B3BC_STUB=object`: 728 / 728 likewise (against `obj-snb` with the 9 `hasOwnProperty` re-runs of `obj-hop-snb`).

Getting there took one fix to the first reconstruction: TypeScript records an expando as an `Identifier` declaration
(the object of `X.k = v`, or `defineProperty`'s first argument), and the refusal comes from the lib-only test in
`module-bindings.ts` (`makeIrAmbientBindingPredicate(checker, "every")`), which the front end's `isLibOnlyBinding` and
`pristineBuiltinGlobal` share. The 58 wall rows of o411 and l420 also re-ran with their original verdicts.

**B3bc alone** (files whose first stop on B3a is a B3bc wall):

| list | B3bc walls | blocked by another wall | compile clean (upper bound) | pass with the object stand-in | pass with the primitive stand-in only | measured (lower bound) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| carriers | 728 | 244 | 484 | 117 | 178 | 295 |
| of them, main's 627 `new X` files | 457 | 142 | 315 | 116 | 174 | 290 |
| o411 | 35 | 18 | 17 | 6 | 5 | 11 |
| l420 | 23 | 6 | 17 | 3 | 7 | 10 |

How to read the bounds:

- *Upper bound*: compile clean behind the stub, so no other compile wall.
- *Lower bound*: the file passes with a stand-in that is less than a wrapper. A file that passes with an ordinary
  object has no use for a wrapper's value. A file that passes with the primitive has no use for wrapper identity. The
  lower bound holds if B3bc implements the specification. It is not a strict bound: a test could pass by accident with
  a wrong stand-in.
- *The gap* (189 carriers): files that read a prototype or constructor key (174), use `instanceof X` (9), the String
  exotic (3), or other (3). The stub traps for all of them, so their verdict can only be measured on the branch.

On o411, B3bc alone frees 11 to 17 files. Of the sample's 27 `new X` first stops on main, it frees 11 to 12.

**By what B3bc must deliver** (carriers, 484 compile-clean files; each file in its first matching row):

| needs | files | measured passes |
| --- | ---: | ---: |
| wrapper construction only (an object: identity, `typeof`, truthiness) | 117 | 117 |
| + ToPrimitive through `valueOf` / `toString` | 178 | 178 |
| + the constructor and prototype graph (`X.prototype`, its members as values, statics, `instanceof X`); 68 of these read only `X.prototype` and its `valueOf` / `toString` / `constructor`, 106 read other members or statics | 183 | 0 (trap in the stub) |
| + the String exotic (own `length`, index keys, own descriptors of a wrapper) | 3 | 0 |
| other (`switch` on a wrapper, a throwing `valueOf` inside `new String`) | 3 | 0 |

No passing file needs a primitive receiver's read of a prototype key: in both builds such a read is the run-time
abort, and the 295 pass. (Corrected wording: the first version said no "primitive read" hook fired. In the
reconstructed stub the hook fires at compile time wherever a read's receiver may be such a primitive, which is almost
every row, through the harness's own reads, with the same verdicts.) The primitive-receiver rules are needed for
correctness once the prototypes are reachable, not for this yield.

**The next walls behind B3bc** (carriers, the 244 blocked; main's 627 `new X` subset in brackets):

| next wall | files |
| --- | ---: |
| B3d: String / Number method algorithms (`substring` 17, `slice` 14, `fromCharCode` 23, case conversion, `indexOf`, …) | 124 (80) |
| G4 / #7349 S7: `.call` / `.bind` on a built-in method | 54 (0) |
| loose `==` / `!=` (`dyn.eq (loose)`) | 31 (29) |
| dynamic relational `<` `<=` `>` `>=` (`__ir_dyn_lt` …) | 28 (28) |
| a numeric member key (`w[0]`, "computed key") | 5 (5) |
| Math (Session B), a binding write of `Number` (G6) | 2 (0) |

Of the 170 `new X` files that B3a moves to another wall, the walls are arrays 54 (Session B), RegExp 44, `delete` 21,
`Object` as a value 17, and others.

**Named rows** (B3's acceptance list). All compile behind the stub:

- `division/S11.5.2_A3_T1.1.js` and `getOwnPropertyDescriptor/15.2.3.3-2-40.js` pass with the primitive stand-in.
- `conditional/S11.12_A4_T2.js` passes with the object stand-in.
- `Number/S15.7.5_A1_T02.js`, `15.2.3.3-4-85.js`, `S15.7.4.2_A2_T14.js` and `S15.7.4.2_A4_T01/T02/T05` read the
  prototype and trap in the stub.
- `S15.7.4.2_A4_T03` / `T04` stop earlier, at `Date` and `Object`.

### Slices (revised after PRV-B3bc)

The cut is by receiver mechanism, not by member. A cut by member (prototypes with `valueOf` / `toString` first, the
other methods later) would leave the prototype objects partly populated, which needs B2b's ordinary-object miss check.
The cut by mechanism avoids that dependency.

| # | slice | content | yield (carriers; o411; l420) | how the yield is known |
| --- | --- | --- | --- | --- |
| 1 | **Expando fix** (own PR, S2 reviews) | the expando declaration no longer makes a name non-pristine; the escape rule for folds of writable members (to-do 2); test rows for `eval`, `Object`, `Error` and the three wrapper names | 1; 0; 0 | measured: the stub's `expando` hook fired in `S8.5_A9.js` (pass) and one other carrier, `11.13.1-4-14-s.js`, which already passes on B3a |
| 2 | **B3b-0** — data only | `wrapperRows` complete (prototypes, methods, statics; `primitiveData`); the `RealmConstructor` union (to-do 1). No row is held yet, `identityOnly` stays on the three constructor rows | 0; 0; 0 | by construction: rows enter a realm only through `heldWith`; `check:prepared-bytes` 804 / 804 identical |
| 3 | **B3b-1** — wrappers, ToPrimitive, holding | `new X(v)`; wrappers and the three prototypes as `$XObject`s (String ones by StringCreate); the realm-method-by-identity table in ToPrimitive (B3 fix) and in P1's call expansion; `valueOf` / `toString` / `toString(radix)` / thisXValue; `instanceof X`; `[object X]` tags; retiring the identity mark from the three rows; holding with the whole-family trigger (condition 2); the extensible `$Object` root where a wrapper family is held; the interim String aborts. **A member read or write on a primitive of a held kind refuses by name** (`X.prototype is reachable: a primitive's member access is #7350 B3b-2`), through C2's rule: a compile refusal where every kind the receiver may hold refuses, else that kind's run-time abort | 295 to 481; 11 to 17; 10 to 17 | lower bound measured (stub verdicts, re-run below); upper bound = compile clean behind the stub. Expected loss from the primitive refusal: none, because the stub already aborts a primitive's read of every wrapper-owned key at run time and the 295 still pass; a non-owned key on a primitive of a held kind (`"a".foo`) is the one difference, measured on the branch |
| 4 | **B3b-2** — primitive [[Get]] / [[Set]] | the primitive arms of a held kind go through `%X.prototype%` (rules of "Slice B3bc"); the 2.b operand of the set body (condition 1); lifts B3b-1's primitive refusal | 0; 0; 0 as first stops, plus whatever B3b-1's primitive refusal cost | measured: no carrier, o411 or l420 row stops first on B3a at a wrapper key read off a primitive (`b3a-*.jsonl`: 0 such rows; the only "prototype's properties" stops are Function.prototype's) |
| 5 | **B3c** — String exotic, sloppy `this` | as before: #3518's exotic find, define and own-keys; a numeric constant key; ToObject of a primitive `this` in sloppy code; removes the interim aborts and the dead realm-state wrapper code (finding 7) | ≤ 3; 0; 0 | measured upper bound (compile clean, need the exotic) |

Order: 1, 2, 3, 4, then 5. Slice 1 is independent of the rest and can land first.

**B3b-1's interim aborts** (run-time aborts, never wrong answers; B3c deletes both):

- a constant array-index key (a read, `in`, `hasOwnProperty`, an own descriptor) meets a `$StringObject`;
- an own-key enumeration meets a `$StringObject` (`defineProperties` / `create` reading a String wrapper's keys; JSON,
  for-in and `Object.keys` where the Prepared path lowers them for a dynamic object, see the probes).

`length` needs no abort: StringCreate inserts it as an ordinary own data property {!w, !e, !c}
(`string-create-body.ts:133`), so every own query finds it.

A sloppy method on a primitive keeps C2-D3's abort until B3c. B3b-1's primitive refusal means it is not reached
before B3b-2 either.

### Target structure (per module, IR layering)

**Contract.**

- `native-realm-catalog.ts`. `wrapperRows(name)` takes `errorRows`' shape and helpers: `callable`, `reference`,
  `data`, `methodProperties`, `members`.
  - Each constructor row: `prototype` {!w, !e, !c}, the statics (Number's constants as in B3a; `Number.isNaN`,
    `isFinite`, `isInteger`, `isSafeInteger`, `EPSILON`, `MAX_SAFE_INTEGER`, `MIN_SAFE_INTEGER`; `String.fromCharCode`,
    `fromCodePoint`, `raw`). `identityOnly` is dropped.
  - Each prototype row: `primitiveData` ("", +0, false), `constructor`, and one method row per member (50 / 6 / 2
    per node 22, B3's count).
  - Ids are appended to `NATIVE_VALUE_INTRINSICS`. `NATIVE_MEMBERS` gains `valueOf` / `toString` of the three
    prototypes.
  - `Number.parseFloat` / `parseInt` are not rows until the global functions are catalog rows. Then they reference the
    same ids, as one object.
- `src/ir/runtime/ordinary-object-callables.ts`: `js.object.create-wrapper(value, selector)` and
  `js.object.wrapper-data(object, selector)`.

**Runtime body.**

- `primitive-wrapper-bodies.ts`: thisXValue beside the existing allocation and payload read. String creation is
  `string-create-body.ts`.
- `realm-family-bodies.ts`:
    - an object row with `primitiveData` is allocated by the wrapper allocation, and a String one by StringCreate
    (`string-create-body.ts`, own `length`), so `%String.prototype%` has its own `length` 0 (PRV-B3bc B2);
  - `realmFamilySeed` seeds only held members (the per-member pin below);
  - `markIdentityOnly` goes (condition 3).
- `source-object-bodies.ts` `buildSourceObjectSetDefinition`: step 2.b, behind an optional operand (condition 1).

**Backend.**

- `native-realm.ts`, `native-builtin-functions.ts`, and the wrapper owners `native-primitive-wrapper-layouts.ts`,
  `native-primitive-wrapper-storage.ts` and `native-string-create.ts`. They are live only for held kinds.
- The extensible `$Object` root is declared only where a wrapper family is held (B3b-1; a fixture row puts it under
  `check:prepared-bytes`).
- `errorCreateOperands` becomes one family-create operand builder.
- B3c: `native-object-descriptors.ts` (`stringOwn`) and `native-object-access.ts` (the String-aware find, as
  `native-mixed-object-access.ts` composes it).

**IR keys.** `builtin-prototype-keys.ts`:

- `NUMBER_PROTOTYPE` / `STRING_PROTOTYPE` become `realmStringKeys("%Number.prototype%")` / `("%String.prototype%")`
  (criterion 9 of B3);
- `IDENTITY_ONLY_KEYS` and `identityOnlyKeyRefusal` go;
- `RealmConstructor` becomes a union by family (to-do 1).

**IR recogniser.** `dynamic-realm-calls.ts`: `realmConstructorOf` generalises to `realmIntrinsicOf(value)`, which also
answers `%X.prototype%` for a constant `prototype` read off a realm constructor. It is the one recogniser for the
construct arm, the method-by-identity expansion and the static member reads.

**IR construction.** `dynamic-wrapper-constructors.ts`: `new X(v)` is `WRAPPER_CONVERSIONS`' conversion, then
`js.object.create-wrapper`. `X(v)` is unchanged. The `gap` goes.

**IR methods.**

- `dynamic-prototype-methods.ts`: `RealmMethod` becomes one table (name, catalog id, algorithm). P1's
  `name === "toString" && errors` case and the `errorToString` hook become rows of this table.
- `ordinary-to-primitive.ts` and `dynamic-value-chains.ts`: the `errorToString` hook becomes the table's
  "realm method by identity" test, used by the call expansion and by OrdinaryToPrimitive (PRV-B3bc B3):
  - holding a wrapper family admits the function kind for ToPrimitive, so `isCallable` is defined and the
    `toString`-only shortcut (`ordinary-to-primitive.ts:81`) no longer applies: `new Number(1) + 1` consults
    `valueOf` in a program without source functions too;
  - the identity test runs before `builtinOnly` and the dispatcher, and the table includes Object.prototype.toString
    answering `dyn.object_tag`;
  - the absent-`toString` arm answers the object's tag (`[object Number]`) instead of the literal "[object Object]".

**IR member access.** `dynamic-member-access.ts`: where X's family is held, B3b-1's `missing` answers a refusal for
every key of a read or write on a primitive of kind X; B3b-2 replaces it: the primitive arms call `js.object.get` /
`js.object.set` on `%X.prototype%` with the primitive as receiver. An unheld kind keeps the static premise and its
bytes. The static refusal of B3a goes (B3b-1).

**IR `this`** (B3c). `dynamic-function-operations.ts`: `dynamicCurrentThis`'s sloppy arm wraps a primitive of a held
kind.

**IR holds.** `native-realm-requirements.ts` `HELD_FAMILIES`: the wrapper row gets the per-member pin, the whole-family
trigger (condition 2) and `%RangeError%` for `toString(radix)`.

**Front end.**

- `module-bindings.ts` (`makeIrAmbientBindingPredicate`): the expando fix; `builtin-global-binding.ts`: the escape
  rule (to-do 2, slice 1).
- `realm-static-call.ts`: `identityOnlyTargetRefusal` goes (B3b-1). The folds of writable members ask the escape
  rule (slice 1).

**Reuses:**

- G1: the catalog shape, `heldWith` and `heldCatalogRows`, the family allocation and seeding, `js.object.intrinsic`,
  and the pristine predicate;
- B3a: `WRAPPER_CONVERSIONS` for `new X(v)`'s conversion, `realmConstructorId` / `realmConstructorOf` (generalised,
  not copied), and `HELD_FAMILIES`;
- P1's identity-tested call expansion;
- C2's `dyn.construct`, `dyn.instanceof` and `dynamicCurrentThis`;
- the kernel's [[Get]] / [[Set]] (`js.object.get` / `set` with a receiver argument);
- #3518's wrapper layout, allocation, String create, exotic find, define and own-keys bodies, and their owners.

**Removes:**

- the two hand key lists;
- `identityOnly`, `IDENTITY_ONLY_KEYS`, `identityOnlyKeyRefusal`, `identityOnlyTargetRefusal`, and the kernel's mark
  where no row uses it (condition 3);
- the `errorToString` hook and P1's `toString` special case;
- the `ctor.name as NativeWrapperConstructor` cast;
- B3c: `REALM_WRAPPER_STATE_FIELD`, `createRealmPrimitiveWrapperDeclaration` and the `realmState` branches (finding 7),
  and B3b's two interim aborts.

**Does not add:** a second layout, a hidden-key wrapper, materialised indices, a second identity flag, a second
kernel set entry, or a selector-side copy of a rule.

### PRV-B3's three conditions

**1. Step 2.b bytes** (B3b-2).

- *How 2.b enters.* `buildSourceObjectSetDefinition` takes an optional `primitiveReceivers` operand, the same pattern as
  its optional `accessorCalls`. With it, the body tests the receiver before it reads the receiver's own storage:
  - if the receiver is no `$Object` and no function, the walk starts at `object` (the held `%X.prototype%`);
  - a found accessor runs as now, with the receiver as `this`;
  - a found data property, writable or not, answers `false`, and so does a miss. That is step 2.b: the receiver is
    no object.

  The realm passes the operand only where it holds a wrapper family, so there is one body and one kernel entry.
- *Bytes.* A program that holds no wrapper family emits the unchanged body. See "`check:prepared-bytes` on the base"
  below for the 804 rows: no row holds a wrapper family on any slice, so every slice expects 804 / 804 identical.
- *Rejected alternative.* The 2.b test in the shared body unconditionally would change every realm program that
  declares `js.object.set`.

**2. Holding: a per-member pin with a whole-family trigger** (B3b-1). Revised after PRV-B3bc B1.

- *What is held.* A wrapper family is held as B3's "When a family is held" says. What it holds is pinned per member:
  - the constructor, the prototype and its `constructor`;
  - every member whose name is the constant key of any `js.object.get` / `set` / `has` / `has-own` /
    `own-descriptor` / define use in the program, whatever the receiver (`use.constantKey`, as `readsPrototypeMethod`
    already reads it);
  - `valueOf` / `toString` wherever ToPrimitive can meet the family;
  - `%RangeError%` for a `toString` with a radix argument.
- *The whole-family trigger.* A non-constant key reaches three admitted contracts today (B1, verified):
  - `js.object.has-own`, from `hasOwnProperty` / `propertyIsEnumerable` (`dynamic-prototype-methods.ts`
    `ownProperty`, which takes the argument through `stringOf`);
  - `js.object.own-descriptor` and `js.object.descriptor-define`, from `getOwnPropertyDescriptor` /
    `defineProperty` (`dynamic-object-statics.ts` `withKey`, line 57).

  test262's `propertyHelper.js` `verifyProperty(obj, name, …)` passes the name as a parameter, so this is common.
  Where the program holds a wrapper family and any of these three sites has a key argument that is not a string
  constant, every member of each held wrapper family is held. Example:
  `var k = "index" + "Of"; String.prototype.hasOwnProperty(k)` must be true, and is, because the trigger holds
  `indexOf`.
- *Where the key is read.* The trigger reads the call's argument at the legalization, before `stringOf`
  (`constantKeyOf(definitions, argument)`), and records a "computed own key" use on the emitted call; the per-member
  pin reads the same recorded key. So a literal (`hasOwnProperty("indexOf")`) pins `indexOf` alone even though the
  emitted key operand is `stringOf`'s result. A probe pins it: the literal form holds the named member and not the
  whole family (bytes of the two forms differ), and answers true.
- *Why the rest is closed.* Every other key path refuses a computed key or reads enumerable keys only:
  - a member read or write with a computed key refuses by name (`dynamic-member-access.ts` `constantKey`);
  - `in` and `delete` refuse (`__extern_has`, `delete has no IR lowering`);
  - `defineProperties` and `create` read enumerable keys, and every wrapper member is non-enumerable;
  - `getOwnPropertyNames` is not a native static.

  A unit test lists every IR contract that takes a key operand and asserts each one is either constant-keyed, a
  trigger site, or enumerable-only. A slice that admits another key path must add it to that test, with a trigger.
- *The size gate from B3 still applies:* more than 4 KB or more than 10 % compile time. It is measured on the B3b-1
  branch: the prelude plus one `new String("a")` row, all members held vs the pinned set, bytes and the median of 3
  compiles; and the prelude with `propertyHelper.js`, whose `verifyProperty` fires the trigger.

**3. The identity-only mark** (B3b-1).

- *What changes.* B3b-1 gives the three rows their complete population, so they stop being identity-only. The catalog
  field `identityOnly` has no row left, so `IDENTITY_ONLY_KEYS`, `identityOnlyKeyRefusal`, both its call sites
  (`constantKey` in `dynamic-member-access.ts`, `identityOnlyTargetRefusal` in `realm-static-call.ts`) and the field go.
- *What happens to B3a's four aborts.* They become answers: `Object.getOwnPropertyDescriptor(String, "prototype")`
  three times, and `str.constructor` once.
- *Whether the kernel's mark stays* depends on the landing order:
  - if B2b has landed, its global identity rows use the mark, so the flag and the find's test stay;
  - otherwise B3b-1 deletes them with `markIdentityOnly` in `realm-family-bodies.ts`, and B2b keeps its own helper
    and `identityOnlyMiss`, as on its branch.

  Either way the repository keeps one mark with real users.
- *Why no member needs the mark after B3b-1* (restated after B1). A member that is not held is reachable only through
  a key the program does not name as a constant. Every such key reaches a trigger site (condition 2), which holds the
  whole family, or a path that refuses it or sees only enumerable keys. The unit test of condition 2 keeps that true.

### `check:prepared-bytes` on the base (PRV-B3bc N2)

`npm run -s check:prepared-bytes` (`scripts/prepared-byte-identity.mts`) on this branch's code (B3a `1770ed68f3`;
the plan commits change no source), 2026-11-26: 804 rows; 745 `bytes`, 58 `refused`, 1 `threw` (row 787,
`duplicate normalized source name`, a fixture artefact). The output is a comparison input, not a pin: each slice runs
it on its base and head and diffs the two.

Rows that touch the wrapper names: one, row 582, `function h(v) { return new Number(1) == v; } h(1);`. It emits
bytes on the base: the unit `h` refuses and compiles to its abort body (B3a's unit rule), which a probe confirms
(`new Number(1) == v` and `v == v` in `h` give different bytes, `v == v` and `v === v` the same). No row reads a
primitive's wrapper-owned key at the legalization, and none holds a wrapper family.

What each slice expects:

| slice | expected | why |
| --- | --- | --- |
| 1 expando fix | 804 / 804 identical | no row has an expando statement on a realm name |
| 2 B3b-0 | 804 / 804 identical | data only |
| 3 B3b-1 | 804 / 804 identical | row 582: `new Number(1)` now lowers, but `dyn.eq (loose)` still refuses, so `h` stays its abort body, and a refused unit's IR holds nothing; the extensible `$Object` root is declared only where a wrapper family is held, which no row does. A changed row 582 means the holding scan reads a refused unit's IR: a bug |
| 4 B3b-2 | 804 / 804 identical | the 2.b operand is passed only where a wrapper family is held |
| 5 B3c | 804 / 804 identical | as for 4 |

### B2b (`origin/claude/7350-b2b`, `23d952425f`): B3bc needs nothing from it

Read from `git diff origin/main...origin/claude/7350-b2b`. B2b is:

- the global object (`js.object.global`, `dyn.global_object` reads);
- B2a's global table (`native-realm-globals.ts`);
- callable identity rows for globals without catalog rows;
- the mark's ordinary-object arm (`identityOnlyMiss` in `builtin-function-prototype-bodies.ts`, `markIdentityOnly` in
  `builtin-function-bodies.ts`).

B3bc uses none of these:

- the kernel's built-in function lookup already follows [[Prototype]] after an own miss on main
  (`buildBuiltinFunctionLookup` calls `getPrototypeOf`), which `Number.hasOwnProperty` needs. Not verified at run
  time: the stub traps there;
- the split by mechanism leaves no partly populated ordinary object, so the ordinary-object miss arm is not needed;
- `this` of `undefined` / `null` in sloppy code stays C2-D3's abort and needs the global object only when Session B
  takes it.

Three ordering notes for whichever lands second:

- the mark (condition 3);
- B2a's `nativeRealmGlobalSurface` must answer "complete" for the three names once B3b lands;
- the global object's `String` / `Number` / `Boolean` properties must read `js.object.intrinsic` (B3 risk 6).

### To-dos from review RV7433

1. **Drop the `ctor.name as NativeWrapperConstructor` cast** (`dynamic-wrapper-constructors.ts:44`; slice 2,
   B3b-0). `RealmConstructor` becomes `{ family: "error"; name: NativeErrorConstructor; … } | { family: "wrapper";
   name: NativeWrapperConstructor; … }`, built by one generic `constructors(family, names)`.
   `dynamicWrapperConstruction` takes the wrapper member, so the legalization's `ctor.family` test narrows it, and
   `WRAPPER_CONVERSIONS[ctor.name]` type-checks.
2. **A bare `Object.defineProperty(String, …);` statement refuses with "String is not in scope"** (slice 1, its own
   PR).
   - *Root cause.* In a JavaScript file, TypeScript's binder treats a statement `Object.defineProperty(X, "k", d);` or
     `X.k = v;` as an expando declaration of `X`. It merges the source identifier into the lib symbol's
     declarations. The pristine predicate's lib-only test (`makeIrAmbientBindingPredicate(checker, "every")`) then
     fails, so every read of `X` in the file is "not in scope".
   - *Evidence.* Checked on B3a: the statement form refuses for `String`, `Number`, `Error` and `Object`. Checked with
     the TypeScript API: `var r = Object.defineProperty(String, …)`, an expression that is not a statement, and a
     non-literal key do not merge, and the first reaches B3a's named refusal. `String.prototype.k = v;` does not merge
     either. The bug predates B3a.
   - *Fix, part 1* (`module-bindings.ts` `makeIrAmbientBindingPredicate`, its `"every"` quantifier): a source
     declaration that is such an expando does not count against "lib only". TypeScript records it as an `Identifier`
     declaration: the object of a property access (`X.k = v;`) or the first argument of a call
     (`Object.defineProperty(X, …);`). The stub's version (in `stub.patch`) accepts a symbol whose declarations are
     lib ones plus only such identifiers. The one predicate serves `isLibOnlyBinding` (the identifier read) and
     `pristineBuiltinGlobal`, so both see the fix.
   - *Fix, part 2: the escape rule* (PRV-B3bc B4; replaces the written-member fact of the first version). The
     written-member fact was unsound: it saw `X.k = …` written with the name `X`, but not a write through an alias
     (`var N = Number; N.isNaN = f; Number.isNaN(1)`, a parameter `function w(x) { x.isNaN = f } w(Number)`,
     `Object.defineProperty(N, "isNaN", …)`), and not `X["k"] = …`, compound assignment, `++` / `--`, a destructuring
     target or a for-in target. The rule that replaces it: a fold of a **writable** member of `X` applies only where
     `X` does not escape, that is, where every occurrence of `X` in every source file is one of
     - a callee (`X(v)`, `new X(v)`);
     - the object of a static member read or of a method call (`X.k`, `X.k(…)`), not a write target, a `delete`
       operand, a compound or `++` / `--` target, a destructuring target or a for-in / for-of target;
     - a `typeof` operand;
     - the right side of `instanceof`.

     Anything else (an argument, including `Object.defineProperty(X, …)`; an initializer or assignment value; a
     return value; a property value; a member write `X.k = …` or `X["k"] = …`) escapes `X`, and no writable member of
     `X` folds: the access goes through the realm's [[Get]] and call. One walk computes it, beside
     `boundOrWrittenNames` in the same module, and `pristineBuiltinGlobal` gains a second answer,
     `foldableMembers(identifier)`. The folds that ask it: the `Object` statics' call form (#7354 O1), the static-call
     lowering of `Number.isNaN` / `isFinite`, #3787's `String.fromCharCode`, and any later fold of a writable member.
     Non-writable, non-configurable constants (Number's five) keep folding whatever `X` does: a write fails.
   - *Why part 2 must ship with part 1.* On B3a an alias write traps (probe on B3a: `var N = Number; N.isNaN = f;
     Number.isNaN(1)` ends in `unreachable`, as the identity row has no `isNaN`), and the statement form of a direct
     write refuses through the expando. Part 1 alone would admit `Object.keys = f; Object.keys(o)` with the native
     `keys` folded in: a wrong answer, since `Object` is a complete object today. With part 2 that program does not
     fold.
   - *Remaining holes, filed under #7503* (its issue file is on
     `origin/claude/prepared-eval-a7`, not yet on main; slice 1's PR adds these rows to it as plan text): an escape through the global
     object (`globalThis.Number`, `this.Number`, a global-object alias), and code run by eval or the `Function`
     constructor. Both stay unreachable while the Prepared path refuses `globalThis`, script-level `this` and
     unbound eval (#7503's "why it is mostly sound today").
   - *Yield.* 1 carrier: `S8.5_A9.js` (`Number.NaN = 1;`) passes with the stub (`Number` escapes as a write target,
     and `NaN` is a constant, so it still folds). The only other carrier with the pattern, `11.13.1-4-14-s.js`,
     already passes on B3a.
   - *Scope and review* (PRV-B3bc N1). The fix also changes `Object`, the Error constructors and `eval`, which share
     the predicate. It conflicts with eval A4's planned edit to `boundOrWrittenNames` (#7363 A4 adds
     `DeleteExpression` to the walk) and widens A4's pristine `eval` (an expando on `eval` no longer disqualifies it).
     So it is its own PR, and S2 (owner of `origin/claude/prepared-eval-a7`) agrees to it before the hold is
     released. Test rows: an expando statement and an alias write for each of `eval`, `Object`, `Error`, `String`,
     `Number`, `Boolean`, each with a node-checked expected value and a wrong twin.

### Compiler boundaries (`scripts/compiler-boundaries.json`)

No slice adds a `src/` file: every change lands in an existing module, so no slice adds a `files` entry. If a slice
must add one after all, it classifies it in `scripts/compiler-boundaries.json` in the same commit, and runs
`node scripts/check-compiler-boundaries.mjs --mode inventory --base HEAD^1` and `--base origin/main` (both exit 0).

| slice | modules (layer) | edge check |
| --- | --- | --- |
| 1 expando fix | `src/ir/module-bindings.ts` (mixed-needs-split, destination ir-core: the change uses only `ts` node tests, no new import); `src/ir/builtin-global-binding.ts` (mixed-needs-split, destination frontend-ts); the folds' callers `realm-static-call.ts` (mixed-needs-split, destination ir-core), `source-plain-objects.ts`, `from-ast.ts` | the escape fact reaches `realm-static-call.ts` through its host interface, as `isPristineGlobal` does today (`FunctionObjectLoweringHost`), never by import: ir-core may not depend on frontend-ts |
| 2 B3b-0 | `native-realm-catalog.ts` (runtime-contracts); `builtin-prototype-keys.ts`, `dynamic-realm-calls.ts`, `dynamic-wrapper-constructors.ts` (ir-program) | ir-program → runtime-contracts is allowed |
| 3 B3b-1 | ir-program: `dynamic-value-chains.ts`, `ordinary-to-primitive.ts`, `dynamic-prototype-methods.ts`, `dynamic-object-statics.ts`, `dynamic-member-access.ts`, `native-realm-requirements.ts`; ir-runtime: `ordinary-object-callables.ts`; native-runtime: `realm-family-bodies.ts`, `primitive-wrapper-bodies.ts`, `string-create-body.ts`; backend-wasmgc: `native-realm.ts` and the wrapper owners | the whole-family trigger is recorded by the legalization and read by `native-realm-requirements.ts`, both ir-program; no ir-program module imports `builtin-global-binding.ts` or any frontend-ts module |
| 4 B3b-2 | `dynamic-member-access.ts` (ir-program); `source-object-bodies.ts` (native-runtime); backend-wasmgc for the operand | none new |
| 5 B3c | `dynamic-function-operations.ts` (ir-program); backend-wasmgc descriptor and access owners | none new; the deletions of finding 7 remove `files` entries in the same commit |

### Session B's areas: the boundary

- *Untouched:* Math, arrays, property-descriptor semantics, `with` and the global object.
- *The String exotic (B3c)* hooks #3518's existing `string-exotic` define mode into the existing descriptor owner. It
  changes no descriptor algorithm.
- *Own-key enumeration* stays as it is. B3c adds only the String wrapper's virtual keys.
- *`this` of `undefined` / `null`* stays the abort.
- *`Number.parseFloat` / `parseInt`* wait for the global function rows.
- *A wrapper as an array-like* (`Array.prototype.m.call(w)`) stays G4 / Session B.

### Acceptance criteria (per slice; B3c in brackets)

Correctness:

1. Census on the 728 carriers B3a stops at a B3bc wall, the 1,977 carriers, o411 and l420 (commands in
   `plan/samples/7350-b3bc/README.md`), base = the slice's base vs head:
   - files lost 0, new crashes 0;
   - gained within the slice table's range; a gain below the lower bound is explained row by row before the hold is
     released.

   B3's named rows pass, each with a mutated twin that fails. Every gained row gets a twin.
2. B3's probe matrix against node, at module level and inside a function, each row with a wrong twin, plus:
   - *slice 1:* the expando statement forms of to-do 2 for `eval`, `Object`, `Error` and the three names; the escape
     rule: `Number.isNaN = f; Number.isNaN(1)`, `var N = Number; N.isNaN = f; Number.isNaN(1)`,
     `function w(x) { x.isNaN = f } w(Number); Number.isNaN(1)`, `Number["isNaN"] = f`,
     `Object.defineProperty(Number, "isNaN", { value: f })`, `Object.keys = f; Object.keys({})`, each answering `f`'s
     result or refusing by name, never the folded built-in; `Number.NaN = 1; Number.NaN` still NaN (folded).
   - *B3b-1, wrappers:* `new Number(1) !== new Number(1)`; `var w = new Number(1); w !== 1`; NaN wrappers:
     `var n = new Number(NaN); n === n`, `n !== new Number(NaN)`, `isNaN(n)`; `typeof Number.prototype` "object";
     `Object.prototype.toString` of `Number.prototype`, `String.prototype`, `Boolean.prototype` and of a wrapper of
     each: `[object Number]` etc.; `Number.prototype.toString()` "0", `String.prototype.length` 0,
     `Boolean.prototype.valueOf()` false.
   - *B3b-1, String wrappers (B2):* `new String("abc").length` 3; `hasOwnProperty("length")` true;
     `Object.getOwnPropertyDescriptor(w, "length")` {3, !w, !e, !c}; a write and a `defineProperty` of `length`
     fail (sloppy no-op, strict TypeError, `defineProperty` TypeError); `w[0]`, `hasOwnProperty("0")` and an own-key
     enumeration of `w` (`Object.defineProperties({}, w)`, and JSON / for-in / `Object.keys` of `w` where the
     Prepared path lowers them) are the interim abort, uncatchable inside `try`.
   - *B3b-1, ToPrimitive (B3):* in a program **with no source function value**: `new Number(1) + 1` 2,
     `String(new Boolean(true))` "true", `new String("a") + "b"` "ab"; and with one. An own `valueOf` that returns an
     object falls through to `toString` (`var w = new Number(2); w.valueOf = function () { return {}; }; w + 1`
     "21"). `delete Number.prototype.toString; String(new Number(1))` "[object Number]" (the tag, not
     "[object Object]"); same for `String.prototype` / `Boolean.prototype`; `Number.prototype.valueOf = f` seen.
   - *B3b-1, holding (B1):* `var k = "index" + "Of"; String.prototype.hasOwnProperty(k)` true;
     `Object.getOwnPropertyDescriptor(String.prototype, k)` a method descriptor; `verifyProperty(String.prototype,
     "indexOf", …)` through the real `propertyHelper.js`; the literal `String.prototype.hasOwnProperty("indexOf")`
     true and holding `indexOf` only (bytes smaller than the computed-key form).
   - *B3b-1, primitive refusal:* `"a".foo`, `(5).toFixed`, `true.x = 1` in a program holding the kind's family:
     refused by name (or the run-time abort where the receiver may hold another kind).
   - *B3b-1, JSON:* `JSON.stringify(new Number(1))` "1", `JSON.stringify(new String("a"))` "\"a\"",
     `JSON.stringify({ b: new Boolean(false) })` "{\"b\":false}" (SerializeJSONProperty step 4 unwraps), or a
     refusal by name where JSON reaches a value that may be a wrapper. Never `{}`.
   - *B3b-2:* a write to `X.prototype` read back through a primitive and through a wrapper; an inherited setter and
     a setter-less accessor on a primitive, in strict and sloppy code; a strict write of an inherited writable data
     property on a primitive (`"use strict"; "a".x = 1` with `String.prototype.x = 0`) a TypeError and no own
     property; `Object.prototype.foo = 1; (5).foo` 1.
   - `Number.prototype.toString` with the radices 16, 1, 37, `Infinity` and `undefined` (B3b-1).
   - [B3c: String wrapper indices, own keys and descriptors; a sloppy method on a primitive.]

   *Pre-existing, checked on B3a* (probe run, real Prepared path): `Object.prototype` is not obtainable today, so
   `(5).foo` cannot be wrong yet. `Object` read as a value refuses ("not in scope"), and `({}).__proto__` traps. No
   defect to record; the B3b-2 probe above is the first time it can be observed.

No regression:

3. No test262 verdict regresses in any edition; ES5's `completed` ratchet holds. CI's merge group is the gate.
4. JS-environment and ordinary-pipeline output byte-identical (`prove-emit-identity.mjs` on the carriers × default and
   standalone). No slice touches a `src/codegen/` file.
5. `check:prepared-bytes`: 804 / 804 identical on every slice (the table in "`check:prepared-bytes` on the base").
   Any changed row is listed with the same outcome on base and head. B3b-1 adds a fixture row for the extensible
   `$Object` declaration: `new Number(1); 1;` with a wrapper family held, so the root's declaration is under the
   byte check from then on, and a row without a wrapper keeps the final `$Object` (identical).
6. The holding gate (condition 2) is measured and recorded in B3b-1's PR body, with and without the trigger.

Code quality:

7. One catalog shape (`wrapperRows` beside `errorRows`), one recogniser (`realmIntrinsicOf`), one held-family table,
   one realm-method-by-identity table (ToPrimitive and P1), one set body with an optional operand, one walk for the
   pristine and escape facts, and no `as` cast on a constructor name.
8. The removals listed above are in the diff of the slice that makes them dead, the identity mark's per condition 3.
9. The prototype key-set unit test: the catalog-derived set united with Object.prototype's equals the old hand lists.
10. No `loc-budget-allow` / `func-budget-allow`: `from-ast.ts` ends at or below its base. Gates run bare before each
    commit.
11. A fresh-context adversarial review per PR, given the diff and this plan. Its verdict is in the PR body.

**Not measured here:**

- the verdict of the 189 compile-clean files that read the prototype graph (the stub traps there);
- the holding size gate, with and without the whole-family trigger;
- what B3b-1's primitive refusal costs (only a non-owned key on a primitive of a held kind can differ from the stub).

All three are measured on the branch.

### Changelog after PRV-B3bc (2026-11-26, review of `32e1685d00`)

| finding | verified? | resolution |
| --- | --- | --- |
| B1 per-member holding observable | yes: `ownProperty` (`dynamic-prototype-methods.ts:79`) and `withKey` (`dynamic-object-statics.ts:57`) take any argument through `stringOf` | Condition 2: a non-constant key at `has-own`, `own-descriptor` or `descriptor-define` holds every member of each held wrapper family; the key is read before `stringOf`, so a literal still pins one member (probe). Condition 3's "no member needs the mark" restated on top of the trigger and a unit test over every key-taking contract |
| B2 `new String("abc").length` | partly. Rebutted for wrappers: StringCreate inserts `length` as an own data property (`string-create-body.ts:133`), and the object arm's [[Get]] finds it before the prototype. Accepted for the prototype: the first version allocated `%String.prototype%` by the wrapper allocation, with no own `length` | Every String wrapper, `%String.prototype%` included, is created by StringCreate in B3b-1, so `String.prototype.length` is 0. `length` needs no interim abort; probes for `length`, its descriptor, writes and `defineProperty` |
| B3 ToPrimitive shortcut | yes: `ordinary-to-primitive.ts:81` consults only `toString` when `isCallable` is undefined, and `callIfCallable` then skips it; the absent arm answers "[object Object]" | Holding a wrapper family admits the function kind for ToPrimitive (`isCallable` defined), so both names are consulted in hint order. The realm-method-by-identity table runs before `builtinOnly` and the dispatcher and includes Object.prototype.toString, answering `dyn.object_tag`; the absent-`toString` arm answers the same tag. Probes without and with source functions |
| B4 written-member fact unsound | yes, by reading: the fact saw writes by name only. On B3a an alias write traps (probe), so the hole opens once members are complete, and for `Object` at once with the expando fix | Replaced by the escape rule (to-do 2): a writable member folds only where every occurrence of `X` is a callee, a static read or call receiver, a `typeof` operand or the right side of `instanceof`. Constants keep folding. Global-object and eval escapes are added to #7503 |
| N1 expando fix as its own PR | accepted | Slice 1, own PR, S2's agreement before release (A4's `boundOrWrittenNames` edit and pristine `eval`); test rows for `eval`, `Object`, `Error` and the three names; the escape rule ships with it |
| N2 `check:prepared-bytes` | run on the base | 745 bytes, 58 refused, 1 threw. Correction: row 582 emits bytes (its unit `h` refuses and is its abort body); the first version said it refuses. Expectation per slice: 804 / 804 identical. B3b-1 adds a fixture row that holds a wrapper family, so the extensible `$Object` declaration is under the byte check |
| N3 probes | accepted | Added: NaN-wrapper identity, `w !== 1`, `new Number(1) !== new Number(1)`, `typeof Number.prototype`, prototype tags, an own `valueOf` returning an object, a strict primitive write, JSON / for-in / `Object.keys` of a String wrapper, `Object.prototype.foo = 1; (5).foo` (not a pre-existing defect: `Object.prototype` is unobtainable on B3a, probed) |
| N4 re-split | accepted | Slices 1 expando fix, 2 B3b-0, 3 B3b-1, 4 B3b-2, 5 B3c, with yields from the measurement data; B3b-1 refuses a member access on a primitive of a held kind by name, at no measured cost |
| N5 reproducibility | done | `plan/samples/7350-b3bc/`: `stub.patch` (reconstructed: the scratch trees were gone; re-run on the 728 wall files reproduces every verdict in both builds, "Measured"), `walls-728.txt`, `carriers.txt`, `l420.txt`, `README.md` with the census command per head; `plan/samples/7354-o411.txt` from `b1a7c75a16` (`origin/claude/7354-o411-sample`), byte-identical to `.tmp/o411/sample.txt` of the B3 worktree and to the list at `155b06691f` |
| boundaries (lead's standing rule) | n/a | "Compiler boundaries" section: no slice adds a `src/` file; per slice the layers touched and the one edge to watch (the escape fact reaches `realm-static-call.ts` by its host interface) |

### B3b-0 result (2026-11-26, branch `claude/7350-b3b0` on plan head `a2e9a7858b`)

**Built** (one code commit):

- `wrapperRows` complete, in `errorRows`' shape. Each constructor row gains:
  - its statics (`String.fromCharCode` / `fromCodePoint` / `raw`; `Number.isFinite` / `isInteger` / `isNaN` /
    `isSafeInteger`);
  - Number's `EPSILON`, `MAX_SAFE_INTEGER` and `MIN_SAFE_INTEGER`;
  - an own `prototype` {!w, !e, !c}.
- Each prototype row: `primitiveData` ("", 0, false), `constructor`, and one property per method (50 / 6 / 2). String's
  Annex B.2.2 members are `legacy`.
- One function row per static and method, all `unavailable`.
- `legacyProperty` replaces Object.prototype's inline Annex B map.
- `RealmConstructor<F>` is a union by family, built by one generic `constructors(family, names)`.
  `dynamicWrapperConstruction` takes `RealmConstructor<"wrapper">` and `dynamicErrorConstruction` takes
  `RealmConstructor<"error">`, so the `ctor.name as NativeWrapperConstructor` cast is gone.
- `tests/issue-7350-b3b0-wrapper-catalog.test.ts` (15 tests) pins:
  - the key sets, names, lengths and attributes against node 22;
  - Number's constants;
  - the Annex B and trim aliases;
  - the gate;
  - criterion 9's key-set equality with the hand lists.

**Deviations from the plan:**

- *"By construction" did not hold.* `heldCatalogRows` brings every row whose `heldWith` the realm holds, and B3a
  already holds `%String%` / `%Number%` / `%Boolean%` wherever the IR reads the name. Without a gate, those realms
  would have gained the following, so B3a's tests would have changed behaviour and bytes:
  - the prototype objects (`familyObjects`);
  - the statics' references (`familyProperties`);
  - about 60 literals;
  - the folds and keys of `EPSILON` and the other new constants.

  The gate is one catalog function, `modelledRow(row)`, read by its four consumers:
  - `heldCatalogRows`;
  - `beginRealm`, which now reads its intrinsic rows from the held rows;
  - `IDENTITY_ONLY_KEYS`;
  - `nativeConstantStatic`.

  `modelledRow` answers three ways:
  - an identity-only constructor: only the own properties its `identityOnly` names (`length`, `name`, and Number's B3a
    five, in B3a's order);
  - the other rows of that family: none;
  - every other row: itself.

  To make this possible, `identityOnly` changes from `true` to the list of modelled keys. B3b-1 deletes `modelledRow`
  with `identityOnly`. Two files this adds to the boundaries table: `native-realm-requirements.ts` (ir-program) and
  `native-realm.ts` (backend-wasmgc). Both edges already exist.
- *`trimLeft` / `trimRight` are properties, not rows.* They reference `%String.prototype.trimStart%` /
  `%String.prototype.trimEnd%` (Annex B.2.2.15-16; node: `trimLeft === trimStart`). That gives 48 String method rows
  for its 50 method properties.
- *Not in B3b-0:*
  - `NATIVE_MEMBERS` (`valueOf` / `toString` as native);
  - the appended `NATIVE_VALUE_INTRINSICS` ids.

  Marking a row native claims an algorithm, and appending holds a function value. Both belong to B3b-1, which writes
  the algorithms. `dynamic-realm-calls.ts` needed no change: it returns the union.
- The catalog version is now `…Wrappers:v4`.

**Measured:**

- `prepared-byte-identity.mts`: 804 / 804 identical. Base `a2e9a7858b` and head both give 745 bytes, 58 refused and 1
  threw; the diff is empty.
- `prove-emit-identity`: 60 / 60 identical.
- Tests: B3a's test, its 7 pin files and the new test all pass.
- Gates exit 0: loc, func, coercion sites, oracle ratchet, dead exports, typecheck, import cycles, compiler boundaries
  (`--base HEAD^1` and `--base origin/main`).
- With `LOC_GATE_BASE=origin/main`, the loc and func gates fail, but only on files this branch does not touch:
  `src/codegen/*` and `src/ir/from-ast.ts` (+2). Main has moved past the base.

### Slice 1 result (2026-11-27, branch `claude/7350-expando-escape` on main `2af9fc6e7c`)

**Built** (one code commit):

- *Expando fix.* `makeIrAmbientBindingPredicate` gains the quantifier `"every-but-expando"`: `"every"`, except that a
  JS property declaration on the name (`X.k = v;`, `X["k"] = v;`, `Object.defineProperty(X, "k", d);`) does not count
  against "lib only". It reuses `isJsPropertyDeclarationTarget` (`shared/binding-writes.ts`, already imported). Only
  `pristineBuiltinGlobal` asks it.
- *Escape rule.* `builtin-global-binding.ts` walks the sources once (`bindingFacts`, which replaces
  `boundOrWrittenNames`) for two facts: the names declared or assigned (as before), and the names some reference of
  which escapes (`keepsValue`). A reference keeps the value when it is a callee, the object of a member read that is no
  store target (`occurrenceIsWriteTarget`: assignment, compound, `++` / `--`, `delete`, destructuring, for-in / for-of)
  and is not `__defineGetter__` / `__defineSetter__`, a `typeof` operand, or the right side of `instanceof`. Type
  positions are skipped; `extends X` counts. The new export `builtinMembersFold(checker, sourceFiles)` answers
  "pristine and never escapes", from the same cached facts as `pristineBuiltinGlobal`.
- *The folds that ask it:* the resolver's `foldsBuiltinMembers` (`source-dynamic-contracts.ts`), read by from-ast's
  `isAmbientReceiver` (Math methods, the static predicates `Number.isNaN` / `isFinite` / `Object.is`,
  `JSON.stringify`, the unadmitted-`defineProperty` check), and the host's `foldsMembers`
  (`FunctionObjectLoweringHost`), read by `realm-static-call.ts` for the `Object` statics' call form and the pristine
  `Math` call; `realmBuiltinOperand` takes both answers (`RealmGlobals`). Number's constants (`realmConstantRead`),
  the realm read of a name and the Error constructor's argument exemption keep the pristine answer.
- `realm-static-call.ts` gets the fact through its host interface; no new import edge, no new `src/` file.
- `tests/issue-7350-slice1-expando-escape.test.ts` (65 tests): the two facts per spelling; the expando statement forms
  for `eval`, `Object`, `Error`, `String`, `Number`, `Boolean`; S8.5_A9's shape, constants beside writes, Error's
  expandos and alias write against node with a wrong twin; every escape spelling of `Number.isNaN` refusing by name; the
  non-escaping folds still answering node's value. Mutation check: with `foldsBuiltinMembers` wired to the pristine
  answer, 3 of the rows fail (alias write, write through a parameter, a write in an uncalled function).

**Deviations from the plan:**

- *The expando acceptance is a fourth quantifier, not a change of `"every"`.* `"every"` serves about twenty
  lib-only consumers in both pipelines (`select-object-statics`, `object-create-call`, `ambient-intrinsics`' Math and
  static values, RegExp statics, `builtin-proto-member`, …) that fold writable members without the escape fact. Changing
  `"every"` would admit, for example, `Object.create = f; Object.create(null)` to the native fold there, and would change
  ordinary-pipeline bytes. On the Prepared path the realm names are read through `pristineBuiltinGlobal`
  (`realmIntrinsicRead`, `realm-static-call.ts`), so that one predicate is where the fix is needed.
- *B3a's pin of `Boolean.prototype = 1;`* changes from `identifier "Boolean" is not in scope` to
  `Boolean.prototype is not reachable on this path yet (#7350 B3bc)`: the statement is an expando.
- *What an escaping member does today:* every wrapper row and `Number.isNaN` refuse by name at the identity row
  (`X.k is not reachable on this path yet`); `Object`, `eval` and `Math` are no values on this path, so their member
  writes refuse as `identifier "X" is not in scope`; an alias write of `String` / `Boolean` keeps B3a's run-time abort.
  No row folds. B3b-1 turns the identity refusals into reads through the realm.
- `prepare-number-conversion.ts`'s own `canonical()` lib-file test is not relaxed, so a program with an expando on
  `String` / `Number` / `Boolean` loses the source-bound conversion plan for `X(v)` (the call reaches the realm's
  value). No census row is affected; relax it with B3b-1 if a row needs it.

**Holes for #7503** (its issue file is on `origin/claude/prepared-eval-a7`; S2 adds these rows there):

- A reference through the global object (`globalThis.Number`, `this.Number`, a global-object alias) is not seen by
  the escape walk.
- Code run by eval or the `Function` constructor is not walked. **Once S2's A4 lands (pristine `eval`), the escape walk
  must cover eval sources**, as `bindingFacts` covers the program's files; A4's planned `DeleteExpression` edit to
  `boundOrWrittenNames` now goes into `bindingFacts`' visit (the expando fix also widens A4's pristine `eval`: an
  expando on `eval` no longer disqualifies it).
- A route that names no `X`: `X.prototype.constructor`, `(1).constructor`, `"".constructor`, `({}).constructor`. All
  refuse or abort today (no wrapper prototype is reachable; `.constructor` on a string refuses); B3b-1 makes them
  reachable and must treat a `constructor` read off a held prototype as an escape of its constructor.

**Measured** (base `2af9fc6e7c`, a `git archive` copy, vs head):

- `prepared-byte-identity.mts`: 804 / 804 identical (744 bytes, 59 refused, 1 threw on both); the diff is empty.
- `prove-emit-identity`: 60 / 60 identical.
- Ordinary pipeline: 110 test262 files (30 whose source has an expando statement on a realm name or `Math`, plus 80
  carriers), each compiled with `assert.js` + `sta.js` at the default and the standalone target: 220 / 220 identical.
- Census (`prepared-census.mts --harness real`):

  | list | base pass | head pass | gained | lost | new crashes |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | carriers (1,977) | 228 | 229 | 1 (`S8.5_A9.js`) | 0 | 0 |
  | o411 (411) | 83 | 83 | 0 | 0 | 0 |

  On carriers the only changed row is `S8.5_A9.js`; on o411 no row changes.
- Tests: the new test, B3a's test, B3b-0's test and the 7 B3a pin files pass. `tests/issue-2856-module-bindings.test.ts`
  fails 14 rows on base and head alike (ordinary pipeline, unrelated).
- Gates exit 0: loc, func (also with `LOC_GATE_BASE=origin/main`), coercion sites, oracle ratchet, dead exports,
  typecheck, import cycles, compiler boundaries (`--base HEAD^1` and `--base origin/main`).

**After review RV-PR7549** (2026-11-27, on `795a5945fe`; #7502 not yet merged, so no merge of main here):

- *1, BLOCK, the escape rule was unsound: fixed.* "No reference of `X` escapes" did not stop a write of `X.k` by a
  route that never spells `X`: `X.prototype.constructor`, an instance's `constructor`, `this` in a method or getter `X`
  inherits from `Function.prototype` / `Object.prototype`, an `export { X }`. The rule is now the *member rule*: `X.k`
  folds when `X` is pristine, no reference of `X` escapes, **and no write in the program may store or define the key
  `k` on a realm object** (new module `src/ir/realm-member-writes.ts`). A write is a store target `o.k` / `o["k"]`
  (assignment, compound, `++` / `--`, `delete`, destructuring, for-in / for-of) or a key writer called as a member
  (`defineProperty`, `defineProperties`, `assign`, `__defineGetter__`, `__defineSetter__`; keys from its literal
  operands). A computed key, any other mention of a key writer, `with` and a reference to `Reflect` write every key.
  A write reaches no realm object only when its receiver is a fresh value (a literal, a function or class expression)
  or a name every binding of which holds one, that nothing assigns and that no reaching write names as a key (a
  top-level binding is a global-object property); the largest such set is found by dropping names until none is
  written. The key is what makes it cheap: the harness writes `this.message`, `assert.throws`, … but never a folded
  key. The routes a)–d) and their twins are pinned (`facts` rows: 26 stop the fold, 7 keep it); the doc of
  `foldsBuiltinMember` states the guarantee. The name rule is kept beside it: dropping it would widen folds and change
  bytes, a separate change.
- *2, BLOCK, duplicated predicate: folded.* `isNonReferenceName` now lives in `src/shared/binding-writes.ts` with
  closure-signature-flow's explicit parent-kind list (one guard added: a node without a parent is a reference). It
  replaces closure-signature-flow's copy, builtin-global-binding's (which matched an export specifier and a binding
  element's key by `name` / `propertyName`, finding 1d), function-local-var's `isIdentifierReference`,
  select-expression-structure's `identifierIsValueReference` (7 uses in `select.ts`) and source-plain-objects'
  `isMemberName`. The twins' differences were not deliberate: each list was a subset of the others (getter, setter,
  property-declaration, qualified-name and enum-member names; labels and declaration names in source-plain-objects,
  whose `familyRead` already excluded them through `isPristineGlobal`). Bytes unchanged (below).
- *3, nit, four names: fixed.* One name, `foldsBuiltinMember`, for the export, the facts field, the resolver hook,
  the contracts field, the host field and the realm-static-call parameters. It is singular now that the fact is per
  member.
- *4, nit, `binds` rebuilt per call: fixed.* `isLib` and `binds` are built once per predicate.
- *Test changes outside this issue.* Three `#7354 O2` ToPropertyDescriptor rows used a `logged(d, k, v)` helper that
  defines a computed key on a parameter; that may write any key on any object, so no `Object` static folds beside it.
  The helper is now an object literal of logging getters (same read order checked). `#7354 O1` (13) used
  `defineProperties(n, n)` with `n` from `Object.create` (not a fresh value to the scan); its map is now `5`, which
  likewise defines nothing. `Object.create(…)` as a fresh value was left out: it needs the member rule's own answer for
  `Object.create` (a fixed point over two facts) for one test row.

**Measured after the review** (base `795a5945fe`, a `git archive` copy, vs head):

- `prepared-byte-identity.mts`: 804 / 804 identical (744 bytes, 59 refused, 1 threw); the diff is empty.
- `prove-emit-identity`: 60 / 60 identical.
- Ordinary pipeline: the 110 files of slice 1 plus 70 with getters, setters, labels or a declaration named `Symbol`
  (the folded predicate's differences), `assert.js` + `sta.js`, default and standalone: 360 / 360 identical.
- Census (`--harness real`): carriers 229 → 229, o411 83 → 83; 0 gained, 0 lost, 0 new crashes, no row changes.
  `S8.5_A9.js` keeps passing: `Number.NaN` is a constant and folds on the pristine answer.
- Tests: slice 1's test (98), B3a's, B3b-0's, the 7 B3a pin files and the folded predicate's callers'
  (closure signatures, function-local var, G1, O1, O2, O2b, #7564 Math, #7118): 22 files, 781 tests pass.
- Gates exit 0: loc, func, coercion sites, oracle ratchet, dead exports, typecheck, import cycles, compiler boundaries
  (`--base HEAD^1` and `--base origin/main`; `realm-member-writes.ts` classified beside `builtin-global-binding.ts`).
  With `LOC_GATE_BASE=origin/main` (`ad10f474ca`) func passes and loc fails only on `src/ir/program-physical-plan.ts`
  (+1), which this branch does not touch: main has moved past the base.

**After review RV-PR7549, round 2** (2026-11-28, on `e104f5a5a0`; review of `716f742e04`: BLOCK, soundness). The
member rule missed a key writer called without its name being spelled. Lead's calls, in order:

- *1(b), landed: readers of an operand's values.* `getOwnPropertyDescriptors`, `values`, `entries` and
  `getOwnPropertyDescriptor` join `KEY_WRITERS` as readers (`{ target: 0 }`): a call as a member counts as a write of
  every key **on its operand**, so a fresh operand (a literal, a fresh name) still folds; any other spelling writes
  every key on any object, as for the writers. `getOwnPropertyDescriptor` by a literal key (`readKey`) writes nothing:
  it hands out that key's value only, which holds a key writer only under the writer's own name (itself a counted
  mention) or after a write of every key. `getOwnPropertyNames` and `keys` are left out: they hand out names, which
  reach a value only through a computed read (rule a), a descriptor read or `Reflect`. Without the literal-key case,
  (b) cost 8 carriers and 1 o411 pass (`getOwnPropertyDescriptor/15.2.3.3-4-191`, `-194`, `-196` … `-201`:
  `Object.getOwnPropertyDescriptor(Number, "MAX_VALUE")`); with it, nothing.
- *1(a), measured, NOT landed: a read by a key that is no literal* (`o[k]`, `` o[`a${b}`] ``, `var {[k]: d} = o`,
  `({[k]: d} = o)`, counted as a write of every key on any object; any receiver may inherit a key writer). Census, base
  `e104f5a5a0`, (a) on top of the landed head: carriers 229 → 215 (−14: the 8 `getOwnPropertyDescriptor/15.2.3.3-4-*`
  rows above and `defineProperty/15.2.3.6-3-5`, `-6`, `-7`, `-10`, `-11`, `-12`, now the run-time abort), o411
  83 → 40 (−43: `Object.create` / `defineProperty` / `defineProperties` / `getOwnPropertyDescriptor` / `Math` rows,
  now `"Object"` / `"Math"` not in scope or the abort). Cause: `assert.js`'s `compareArray` reads `b[i]` and `a[i]`,
  so every test262 program writes every key and no writable member folds (checked: the `assert.js` + `sta.js` prelude
  alone defeats `Math.abs`'s fold; without that one line it folds). Left for the lead's decision; until then the doc
  of `foldsBuiltinMember` lists the route under "Not yet seen". The patch and its six test rows are kept out of the
  branch.
- *2, landed: `Object.create(…)` results are fresh* (`Freshness = "fresh" | "created"`, `freshnessOf`,
  `objectCreateCallee`). A created value, or a name only ever bound to fresh or created values, is fresh while
  `create` folds: every `Object` it is read off is pristine, `Object` never escapes, and no reaching write names
  `create`. The last is part of `realmWrittenKeys`' fixed point (the created values are dropped with the names until
  nothing written rebinds them). A helper's parameter is never fresh. O1 (13) is back to its original input
  (`Object.defineProperties(n, n)`) and agrees with node; its original-shape refusal pin (`e104f5a5a0`) is removed, as
  it pinned the same input to a refusal that no longer happens and the row itself now covers it.
- *3, nit, landed:* `KEY_WRITERS`' doc says that matching every spelling of a member name (a declaration's, a
  string's) is an intended over-approximation.
- *Tests* (`issue-7350-slice1-expando-escape`, 111): stop rows for the descriptor routes (values of
  `getOwnPropertyDescriptors(Object)`, a descriptor read by a computed key, a held reader) and for created values
  (`create` written, directly and by a route that names no `Object`; `Object` escaping; `Object` declared; a parameter
  given a created value); keep rows for fresh operands and an iterator's `values()`, literal-key descriptor reads,
  own names only, writes on a created value, a created map. Mutation checks: without the readers 3 stop rows fail;
  without the created-value conditions 4 more fail; with (a) removed from its patch, exactly its 6 rows fail.

**Measured after round 2** (base `e104f5a5a0`, a `git archive` copy, vs head):

- `prepared-byte-identity.mts`: 804 / 804 identical (744 bytes, 59 refused, 1 threw); the diff is empty.
- `prove-emit-identity`: 60 / 60 identical.
- Ordinary pipeline: the same 180 files, `assert.js` + `sta.js`, default and standalone: 360 / 360 identical.
- Census (`--harness real`):

  | list | base pass | head pass | gained | lost | new crashes |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | carriers (1,977) | 229 | 229 | 0 | 0 | 0 |
  | o411 (411) | 83 | 83 | 0 | 0 | 0 |
  | carriers, with (a) | 229 | 215 | 0 | 14 | 0 |
  | o411, with (a) | 83 | 40 | 0 | 43 | 0 |

  No row changes on the landed head. Without `readKey`, (b) alone measured carriers 221, o411 82.
- Tests: the same 22 files, 797 tests pass.
- Gates exit 0: loc, func, coercion sites, oracle ratchet, dead exports, typecheck, import cycles, compiler boundaries
  (`--base HEAD^1` and `--base origin/main`). With `LOC_GATE_BASE=origin/main` (`91ed0c420c`) loc fails on
  `src/ir/program-physical-plan.ts` (+1) and func on `from-ast.ts::lowerBinary` (+8): neither changes in this round;
  main has moved past the branch (no merge of main here, #7502 not yet merged).

**Fallback for 1(a), chosen by the lead (2026-11-28).** The naive rule costs −14 carrier and −43 o411 passes. Its
six routes are therefore listed under "Not yet seen" in the `foldsBuiltinMember` doc and pinned as `it.fails` rows
(fold = false) in `tests/issue-7350-slice1-expando-escape.test.ts`. They are tracked as #7628
(`plan/issues/7628-realm-write-scan-computed-key-writers.md`), which B3b-1 (#7561) depends on.

**Merge with main after #7502 (2026-11-28).** #7502's `DeleteExpression` arm is now in `bindingFacts`' visit and
goes into `assigned`, so `delete eval` still lands in `taken`. `GLOBAL_ALIASES` stays exported for #7502's
`ownThisEscapes`. The `foldsBuiltinMember` doc's eval line follows S2's wording, minus the `globalThis` clause,
which the write scan now covers.

## Implementation Plan — B3b-2 (2026-11-28, on main 330caff2a8)

**Parked: yield 0 on 330caff2a8** (lead decision, 2026-11-28). No carrier or o411 row stops first at the B3b-2 site, and replacing the abort with step 2.b's answer changes none of the 302 failing rows; the plan below is kept for when a measured row needs it.

B3b-2 is the **write half** of a primitive's member access through a held wrapper prototype. B3b-1 landed as #7561,
which already took the read half (#7561 decision 2: a primitive of a kind whose prototype the program can obtain,
`ProgramObjects.wrappers`, reads through `%X.prototype%` with the primitive as receiver), so B3b-1's interim
primitive *refusal* is gone from main. What is left is one run-time abort and the step-2.b operand of the set body.

### Measured (2026-11-28, main `330caff2a8`, no code change)

Commands (in this worktree, `test262/` a symlink to the checkout; result files are scratch, not committed):

```bash
sed 's|^test/||' plan/samples/7354-o411.txt > .tmp/o411-files.txt
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/o411-files.txt --out .tmp/main-o411.jsonl --harness real --jobs 3
npx tsx scripts/ir-census/prepared-census.mts --files plan/samples/7350-b3bc/carriers.txt --out .tmp/main-carriers.jsonl --harness real --jobs 3
```

| list | rows | pass | fail | compile error | skip (negative) | crash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| carriers | 1,977 | 819 | 278 | 846 | 33 | 1 |
| o411 | 411 | 118 | 36 | 237 | 20 | 0 |

**First stops at a B3b-2 site: 0 carriers, 0 o411.** Attribution:

- The census reports the first run-time abort's reason (`abort.detail`, with `siteFrame`) for 142 of the 278
  carrier fails and 30 of the 36 o411 fails. No reason is B3b-2's ("member write 'k' of a … whose prototype chain
  holds the key"); no compile refusal names B3b-2; no row's abort-body list (`aborts`) does either.
- The other 136 + 6 fails trap without a site: in the dispatcher's method arms (`__call_fn_method_N`, 119 carriers)
  or in the realm's `findOwn` / `ownKeys` / `deleteOwn` (identity-only misses). The B3b-2 abort always carries its
  site, so none of them is B3b-2's.
- **Stub check** (cheap, measured). A `git archive` copy of main with the B3b-2 abort replaced by step 2.b's answer for
  a data property or a miss (`held = absent`: sloppy no-op, strict TypeError; a setter is not called), re-run on all
  302 failing rows of both lists: **0 rows change** (status or abort reason).

So the yield is **0; 0** (measured upper bound), and the slice table's claim "B3b-2 is 0; 0; 0 as first stops"
holds for carriers and o411 on current main (l420 was not re-run). B3b-2 is a correctness completion: it turns an
uncatchable abort into the specification's answer.

**B3c, measured the same way** (slice-table row 5): **1 carrier, 0 o411.**

- carriers: `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-3-14.js` ("an own-property operation on a String
  object with a key that may be an index": `getOwnPropertyDescriptor(new String("123"), "2")`).
- The one o411 row with the sloppy-`this` abort, `language/expressions/call/11.2.3-3_8.js`, is `this` of `undefined`
  (a sloppy function called without a receiver): the global object (#7609 A2), not B3c's primitive half.
- Not B3c either: `language/types/string/S8.4_A3.js` ("member read 'length' of a string needs its own length and
  index properties", a primitive's own keys, #7352).

What the failing carriers stop at instead (first-stop counts on main, measured): `.call` / `.apply` read off a
function (G4 / #7349 S7) 53; `Number.prototype.toString with a radix` 40; String methods without an algorithm (B3d)
about 45 site aborts plus most of the 119 dispatcher-arm traps (not attributed by name: an estimate).

**Behaviour probes on main** (Prepared entry, runner options, a receiver that reaches `dyn.member_set` through a
parameter: `function put(v) { v.x = 1 } put("a")`), against node in a fresh realm:

| program | node | main |
| --- | --- | --- |
| `String.prototype.x = 0`, sloppy write of `x` on a string | no-op | abort |
| the same, strict | TypeError | abort |
| setter-less accessor on `Boolean.prototype`, strict write on `true` | TypeError | abort |
| strict setter on `String.prototype`, `this` seen | the primitive | abort |
| strict write of `length` on a string, String family held | TypeError | abort |
| a miss, family held, sloppy / strict | no-op / TypeError | agrees / agrees |
| a getter on `Number.prototype` read through `5` (strict getter) | "number" | agrees (#7561) |

A **statically typed** primitive receiver never reaches this site: `"a".x = 1`, `(5).z = 2`, `true.g = 1` refuse in
the front end ("property assignment on string / f64 / i32 is not in slice 4", `from-ast.ts` `lowerPropertyAssignment`;
reads: ".x on string is not in slice 2"). Both lists have 0 first stops there. That wall is out of B3b-2's scope
(open question 3).

### Sites, and what replaces each

| # | site on main | today | B3b-2 |
| --- | --- | --- | --- |
| 1 | `src/ir/program/dynamic-member-access.ts` `dynamicMemberWrite`, the `primitive` arm (~line 345–359: `held`, "whose prototype chain holds the key") | where the kind's prototype is held, `js.object.has` on it, then the abort if found, else the absent answer | `js.object.set(%X.prototype%, key, value, primitive)` and the same PutValue branch as the object and function arms (sloppy: ignore `false`; strict: TypeError on `false`). The `has` call and the abort go |
| 2 | same file, the module doc (lines 8–12) and `dynamicMemberWrite`'s doc | "a write meeting a key on it is the run-time abort (§10.1.9.2 step 2.b, a setter's call, is #7350 B3b-2)" | states the rule: OrdinarySet on the held prototype with the primitive as Receiver |
| 3 | same file, `Access.missing` of the write | no string-own-key case: `"ab"["0"] = 1` on a held String prototype reaches the walk | where the String prototype is held, a constant array-index key on a string is missing ("its own index properties", #7350 B3c), so the existing refusal / abort machinery (`memberAccess`) answers it. `length` needs no case (below) |
| 4 | `src/runtime/wasmgc/values/source-object-bodies.ts` `buildSourceObjectSetDefinition` | a primitive receiver traps at `findInStorage`'s `ref.cast` (`bag`) | step 2.b behind an optional operand (design below) |
| 5 | `src/backend/wasmgc/resources/native-builtin-functions.ts` `operands()` | `...(wrappers && { wrapperAllocation })` | the same spread also supplies the operand; `realmWrapperRepresentation(...)` is built once for both |

`grep -rn "B3b-2" src` on main finds exactly sites 1 and 2. No other interim abort or refusal is B3b-2's:

- the read arm is #7561's;
- the delete arm involves no prototype: a primitive's [[Delete]] is on its wrapper's own keys, already answered;
- a sloppy setter or getter called with a primitive `this` is `dynamicCurrentThis`'s sloppy abort
  (`dynamic-function-operations.ts:92`): B3c;
- the String-object index aborts (`stringObjectIndex`, `unlessStringObject`): B3c.

### The step-2.b operand

`SourceObjectSetOperands` gains `primitiveReceiver?: (value: readonly Instr[]) => Instr[]`. It is a test that leaves
an i32: the value is a primitive of a held wrapper kind. The body uses it once, before it reads the receiver's own
storage:

```text
if primitiveReceiver(local 3):            ;; §10.1.9.2 with Receiver not an Object
  inherited                                ;; lookup(object, key): status 1 -> requireWritable, status > 2 -> trap
  i32.const 0; return                      ;; a data property (writable or not) or a miss: step 2.b, false
findInStorage(bag(receiver)) …             ;; unchanged
inherited
define(CREATE_DATA_PROPERTY)
```

- `inherited` is today's lookup segment (`lookup`, the status test, `requireWritable`), extracted into one constant
  that both paths use, not copied.
- `requireWritable` already does the rest: an accessor with a setter calls it with local 3 (the primitive) as
  `this` and answers `true`; a setter-less accessor and a read-only data property answer `false`.
- A writable data property falls through `requireWritable`, and the primitive path answers `false` instead of
  CreateDataProperty: step 2.b.
- Where the operand is absent the emitted body is instruction-for-instruction today's. The backend passes it only
  under `...(wrappers && …)`, that is, only where the realm holds a wrapper family.

The test is built from `primitive-wrapper-bodies.ts`' `SLOT[kind].isPrimitive`, which `buildWrapperDataDefinition`
already uses, over the held kinds (`realmWrapperKinds`). It is one new export, `heldPrimitiveTest(d, kinds, value)`,
which ORs the held kinds' tests. Rejected:

- a flag (`primitiveReceivers: true`) with the test inside the set body: a boolean operand whose meaning is
  "re-derive what the backend already knows";
- "no `$Object` and no function" (`ref.test` plus `match`): it would accept a non-held carrier that no caller passes,
  and the realm's own representation already answers "a primitive of kind X".

### The IR arm

`dynamicMemberWrite`'s `set()` and `putValue` take the base (the object the walk starts at) and the receiver as
parameters, instead of reading `instr.recv` for both. The object and function arms pass `instr.recv` twice. The
primitive arm of a held kind passes the realm's `%X.prototype%` (`b.realmIntrinsic`, as the read arm does) and
`instr.recv`.

So the three arms are one parameterised PutValue arm. The primitive arm of an **unheld** kind keeps `absent`: the
static premise, and its bytes.

### Target modules and layers (`scripts/compiler-boundaries.json`)

| module | layer | change |
| --- | --- | --- |
| `src/ir/program/dynamic-member-access.ts` | ir-program (clean) | sites 1–3 |
| `src/runtime/wasmgc/values/source-object-bodies.ts` | native-runtime (clean) | site 4 |
| `src/runtime/wasmgc/values/primitive-wrapper-bodies.ts` | native-runtime (clean) | `heldPrimitiveTest` beside `SLOT` |
| `src/backend/wasmgc/resources/native-builtin-functions.ts` | backend-wasmgc (clean) | site 5 |

No new file, no new import edge: backend → native-runtime and ir-program → runtime contracts already exist. No change
to `src/ir/from-ast.ts`, `src/codegen/` or `native-source-objects.ts` (its `js.object.set` row already passes
`nativeBuiltinFunctionOperands`).

**Reuses:**

- the kernel's one set entry (`js.object.set`) and its walk, `requireWritable` and `buildAccessorCall`;
- `heldPrototype`, `b.realmIntrinsic` and `memberAccess`'s refusal / abort chain;
- `SLOT.isPrimitive`, `realmWrapperKinds` and `realmWrapperRepresentation`.

**Removes:**

- the `has`-then-abort arm and its reason;
- the primitive arm's own copy of the PutValue branch (folded into the parameterised arm);
- the second `realmWrapperRepresentation` call in `operands()`;
- the stale B3b-2 doc text.

**Does not add:** a second set entry, a wrapper allocation for ToObject (unobservable: step 2.b never writes the
wrapper), or a selector-side rule.

### Hazards

- **Order.** The value is evaluated before the set (unchanged `dyn.member_set` operands). One lookup, then at most
  one setter call. No getter runs on a write.
- **`this` is the primitive, not a wrapper.** The setter is called with local 3. A *strict* setter sees the
  primitive. A *sloppy* setter takes ToObject(this) (§10.2.1.2), which is `dynamicCurrentThis`'s sloppy abort until
  B3c. Pinned as an abort row, so the slice cannot answer it wrongly.
- **ToObject.** No wrapper is allocated: the only effects of [[Set]] are the setter call and the answer, so the
  wrapper's identity is unobservable.
- **Strict vs sloppy.** `instr.sloppy` picks: ignore `false`, or throw a TypeError. The message is one per arm
  (V8 has three: "Cannot create property", "Cannot assign to read only property", "… which has only a getter"). Tests
  check the class only.
- **A read-only data property** on the chain answers `false`, like a writable one (step 2.b). The difference shows
  only in V8's message.
- **A setter on the chain above `%X.prototype%`.** `lookup` walks the chain, so an accessor on `%Object.prototype%`
  is found. A user-defined one is unreachable today (`Object` is no value: "not in scope"; `__proto__` refuses), and
  the walk is already right once it is reachable (#7561 item 2). The realm's incomplete Object.prototype (status 2)
  is a miss, as today. The write's `missing` keeps refusing Object.prototype's accessor keys.
- **A string's own keys.**
  - `length`: the walk finds `%String.prototype%`'s own `length` {!w} and answers `false`. That is the answer of the
    string's own non-writable `length`, and `%String.prototype%.length` is non-configurable, so no accessor can stand
    there.
  - An index key: the primitive's own non-writable index must shadow a setter on the prototype, and only a non-empty
    string has it. It is refused or aborts until B3c (site 3).
- **Identity-only objects** on the chain: the walk's `abortIfUnmodelled` (`parentLink`) still traps, unchanged.

### Acceptance criteria

Correctness, each row in `tests/issue-7350-b3b2-primitive-set.test.ts`:

- Rows with `agreesWithNode(…, runnerOptions(), freshRealmOut)`, each with its wrong twin. Every program writes a
  built-in, so the fresh realm is required. Each is run at module level and inside a function, and with the receiver
  reaching `dyn.member_set` (a parameter):
  - `String.prototype.x = 0` and a sloppy write of `x` on a string: a no-op; `x` read back is 0 through the
    primitive and through `new String`;
  - an inherited strict setter on `Number.prototype` called by a sloppy and by a strict write: called once, `this`
    the primitive (`typeof this`, `this === 5`), the setter's argument the written value;
  - a write of `X.prototype` read back through a primitive and through a wrapper (B3bc criterion 2, B3b-2);
  - a compound write `v.c += 1` with an inherited `c`: the get, then the set's `false`;
  - `length` written on a string with the String family held: sloppy no-op;
  - a miss and a hit on each of String, Number and Boolean.
- Rows with `throwsAsNode`, or a catch that answers `e instanceof TypeError`, in strict code: an inherited writable
  data property (`"use strict"`, `String.prototype.x = 0`), a read-only one (`defineProperty(String.prototype, "r",
  {value: 1})`), a setter-less accessor on `Boolean.prototype`, and `length` on a string. Each also checks that no own
  property was created.
- Rows with `abortsAtRunTime(…, reason, freshRealmOut)`:
  - a sloppy setter on a wrapper prototype, called through a primitive (B3c's `this`);
  - a constant index key written on a string with the String family held (site 3), unless the receiver can only be a
    string, which is a refusal by name.
- `Object.prototype.foo = 1; (5).foo` (B3bc criterion 2): still refuses by name (`Object` is no value). It is
  recorded, not built.
- `check:prepared-bytes` (`scripts/prepared-byte-identity.mts`): 804 / 804 identical, base `330caff2a8` (a
  `git archive` copy) vs head. Only row 582 names a wrapper. If it changes, the change is explained (it would mean
  that row declares `js.object.set` and holds Number), before the hold is released.
- `prove-emit-identity`: 60 / 60 identical. Ordinary pipeline: the 180 files of slice 1, default and standalone,
  360 / 360 identical. No `src/codegen/` file changes.
- Census on carriers and o411, base vs head: 0 lost, 0 new crashes. Expected gained: 0. A gain is listed row by row.
- The #7561 suite, B3a's, B3b-0's, slice 1's and `tests/issue-7354-o3-member-write.test.ts` and `tests/issue-7354-f1b-function-object-writes.test.ts` pass.

Code quality:

- One PutValue arm for object, function and primitive, parameterised by base and receiver. No `has`-then-abort.
- One set body. The step-2.b path reuses the extracted `inherited` segment. With the operand absent, the body is
  byte-identical (the criterion above).
- The operand is a test built from `SLOT.isPrimitive`, not a flag, and is present only under `wrappers`.
- No `func-budget-allow` / `loc-budget-allow`.
- A fresh-context adversarial review gets the diff and this section; its verdict goes in the PR body.

### Size

About 40 to 60 source lines net, with deletions about equal to additions in `dynamic-member-access.ts`, and about
150 test lines. Every touched file stays far below the 1,500-line ceiling. `dynamicMemberWrite` (~60 lines) and
`buildSourceObjectSetDefinition` (~95) stay below 300 lines. No budget grant.

### Recommendation

The measured yield is 0 (carriers, o411). B3c's is 1 carrier, 0 o411. Neither is a yield slice. By the "foundations
first" rule, the next slice by measured size is not B3b-2 or B3c but `.call` / `.apply` on functions (G4 / #7349 S7,
53 carriers), `Number.prototype.toString(radix)` (40 carriers), and B3d's String methods (about 45 named aborts plus
unattributed dispatcher traps, an estimate).

If the #7350 lane continues in order anyway, take B3b-2 before B3c:

- B3b-2 is small;
- it removes one uncatchable abort;
- B3c's sloppy `this` then also covers the sloppy setters B3b-2 reaches.

Measuring B3c first is not needed: it is measured above.

### Risks and open questions for the plan reviewer

1. **Row 582.** If `ProgramObjects.wrappers` holds Number for `new Number(1)` inside a refused unit, and the program
   declares `js.object.set`, its bytes change. That would be a #7561 holding question (a refused unit's IR should
   hold nothing), not a B3b-2 defect. Checked by the byte criterion.
2. **The operand's test.** `SLOT.isPrimitive` over the held kinds vs "no `$Object` and no function". The plan picks
   the first. The reviewer may prefer the second for a smaller body; both keep the bytes where no wrapper family is
   held.
3. **Typed primitive receivers** (`"a".x = 1` refusing in `from-ast.ts`). They have 0 first stops on both lists. When
   they do matter, the fix is to box the receiver and take the dynamic arm. That is a `from-ast.ts` change under its
   no-growth rule, so it stays out of this slice; it would be its own issue if a census run shows yield.
4. **Session B's areas.** B3b-2 needs none of them. The chain above `%X.prototype%` is Object.prototype (#7561
   item 2, `Object` as a value), not the global object or descriptor semantics.
5. **l420** was not re-run here. The slice table's 0 for it is from the B3a run.
