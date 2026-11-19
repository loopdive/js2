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

## Slice B2a plan — the one global table (2026-11-19)

Lead decision 2026-11-19: S5 owns the realm rows for the global object. Lane S1 (Ty, `typeof` of a global)
needs the same table, so it lands first, as pure data.

**Target structure.** A sibling of the realm catalog, `src/runtime/contracts/native-realm-globals.ts`:
`NATIVE_REALM_GLOBALS`, the complete own-property population of the global object in the realm's edition
(`NATIVE_REALM_EDITION` in `native-realm-catalog.ts`, 2026 — the newest ratified edition, the year before
`CURRENT_DRAFT_EDITION` in `scripts/generate-editions.ts` and `T262_CURRENT_DRAFT_EDITION_YEAR` in
`website/components/t262-charts.js`, all three pinned together by the test). **Scope** (lead, RV7315 delta):
every global the test262 runner's classifier (`classifyTestScope`) scores as a language global — §19.1–19.4 with
`Temporal` (ES2026, #5173), Annex B.2.1 `escape` / `unescape`, and the draft's explicit-resource-management
globals (`SuppressedError`, `DisposableStack`, `AsyncDisposableStack`), which the runner counts as standard. Each
row carries an **edition**: the realm's edition, or the draft after it for a draft-only global — a property of
the row, not a filter. One exception, recorded in the test: `ShadowRealm` (stage 2.7, in no edition or draft) is
scored as standard by the runner but is not a row, so the Prepared path refuses it by name. Each entry carries
its attributes and its value: a number (`NaN`, `Infinity`), `undefined`, the global object (`globalThis`), a
function (intrinsic id, `length`, construct behaviour: `none`, `ordinary`, or `throws` for exactly `BigInt`,
`Iterator` and `Symbol`, whose IsConstructor is true but whose `new X()` throws), or a namespace (intrinsic
id). `nativeRealmGlobalTypeof(name)` answers a tag or `"not-a-language-global"` (host-only: `console`,
`document` — no `typeof` answer, the caller refuses).

**The duplicate it removes.** `AMBIENT_TYPEOF_TAGS` (`src/ir/ambient-typeof.ts`) is a second typeof list on
main. It sits in lane S1's region; S1 removes its tags in Ty (#7305) and keeps only the ordinary lane's
16-name admission set, whose tags come from this table, so gc output stays byte-identical (S1's ack,
2026-11-19).

**Why a sibling and not catalog rows.** The realm's literal plan (`native-realm-literals.ts`,
`native-builtin-function-requests.ts`) interns every catalog row's name and property keys into every realm
binary; adding about 60 rows to `NATIVE_REALM_CATALOG.intrinsics` would add their strings to every Prepared
realm program. The global table references catalog rows by id and adds none.

**Identity only.** An intrinsic the catalog has a row for (`%Object%`, `%Function%`) has its complete
property population there (`nativeRealmGlobalSurface` answers `"complete"`). Every other intrinsic the table
names is identity only (`"identity"`): its identity, typeof tag, `length` and constructibility are known, its
members are not. B2b's rule for an identity intrinsic (lead, 2026-11-19): an unsupported member or algorithm is never a
catchable JavaScript error, which would let `assert.throws(TypeError, …)` pass for the wrong reason — a
statically visible callee or key refuses by name at compile time, a dynamic one aborts with an uncatchable
trap; never `undefined`. Its `name`, `length`, `prototype` and constructibility are part of the identity. Checked
2026-11-19: no realm row breaks the rule today — the kernel materializes only `%Function.prototype%` and
`%ThrowTypeError%` (both spec behaviour) and its request validator refuses every `unavailable` algorithm, so
the abort tests (inside `try` / `catch` and inside `assert.throws`-style code) land with B2b, which
materializes the first identity row.

**Reuse.** Nothing is implemented here. When a row's surface is filled (B2c…), it binds the existing native
body: `object-constructor-body.ts` (Object), `primitive-wrapper-bodies.ts` (String, Number, Boolean),
`number-bodies.ts` (isNaN, isFinite), `error-bodies.ts` (the NativeErrors), `codegen/json-codec-native.ts` /
`json-standalone.ts` (JSON) and `codegen/math-helpers.ts` (Math), moving codegen-side pure bodies to
`runtime/wasmgc/values/` when they are bound.

**Acceptance.** A unit test, run on node 22 and on CI's node 25: every row the running node has equals node's
`globalThis` descriptor (attributes, typeof tag, `length`, `name`, IsConstructor, and `new` throwing for the
`throws` rows); the rows an engine may predate (`Float16Array`, `Temporal`, the three draft globals) are compared
with their spec values written in the test, and node may lack no other row; every `built-ins/` directory the
runner's classifier scores as standard names a row (directories of non-global intrinsics are listed, and
`ShadowRealm` is the one named exception); the `throws` rows are exactly `BigInt`, `Iterator`, `Symbol`; a fresh V8 context (only the engine's own globals) has no ECMAScript global the table
misses; `length` / construct of the catalog's complete rows equal the catalog's. Output byte-identical
(nothing under `src/` reads the table yet; `check:dead-exports` only scans `src/codegen/`, so it says nothing
about this file). Quality: one table; the typeof answer is derived from it.

**Named follow-up (needs an issue id; allocation was refused in this session):** fold the other global-name
lists into this table once their lanes allow — `GLOBAL_VALUE_NAMES` / `NAMESPACE_GLOBALS`
(`src/checker/inhouse-globals.ts`, the second mixing in `console`, `process` and `Intl`), `BUILTIN_CLASS_NAMES`
(`src/codegen/expressions/builtin-class-names.ts`), `ES5_INTRINSIC_OBJECTS` (`src/ir/object-integrity.ts`) —
and the literal-interning `flatMap` duplicated in `native-realm-literals.ts` and
`native-builtin-function-requests.ts`.

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
