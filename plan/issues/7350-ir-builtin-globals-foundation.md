---
id: 7350
title: "IR foundation: built-in globals as values — one admission on the realm"
status: in-progress
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-11-15
updated: 2026-11-19
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7349]
related: [7349, 7352, 7353, 7343, 7189, 7127, 7294, 7106, 7342]
loc-budget-allow:
  # 2026-11-16 (#7350 G1): +4 in from-ast.ts and +3 in select.ts are the lane capability
  # `native-builtin-globals` in each file's capability union (the JS environment keeps its output) and the
  # selector's lane object; the admission itself moved out of both callers into `ir/builtin-globals.ts`.
  - src/ir/from-ast.ts
  - src/ir/select.ts
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

## G1 result (2026-11-16, branch `claude/7350-g1`)

**Corrected yield.** Re-measured before coding on main `ed17563bc2` with a research switch that admits a built-in
name only outside member positions: G1 alone frees **about 2** of the 272 only-family files, not 22. The
research prototype's 22 counted `X.m` values and `X.m = v` writes, which are G2 / G6 positions; the 34
`X` as an argument files are `Object.isExtensible(Math)`-style, which is G1b. Decision (2026-11-16): land G1
as planned, then widen in the same branch, one commit each with its own measurement: G1b (object-statics
operands may be built-ins) and `X.m` own-data reads that the runtime already answers (asked from the
runtime-side fact, no hand list). Writes stay out (G6).

**What G1 builds.**
- `src/ir/builtin-globals.ts`: the one admission, `builtinGlobalValueAdmitted`, asked by the selector
  (`isAmbientIntrinsicValue`) and the from-ast identifier arm. It asks the name set, which lives in
  `src/shared/ambient-intrinsics.ts` (`builtinGlobalLanes`: the ES5 constructors, namespaces and global
  functions plus `Symbol`; new: `Math`, `JSON`, `Date`, `RegExp`, the eleven global functions), and holds
  the position walk and the #7189 / #7127 member-value reads, which go through the same
  admission. `src/shared/ambient-intrinsics.ts` keeps the lib-binding helpers and #7294's member shapes.
- `isPristineIntrinsic` (`shared/intrinsic-prototype-writes.ts`, the shared write scanner): not declared,
  not written / deleted / defined by a literal route, and not inside a `with` body. (Review RV7263 delta: the
  lexical `with` screen stays. It decides nothing on today's main only because the #4206 with-closure lane is
  broken — `isPhase1WithStatement` admits a closure in `with (<object literal>)` by design and scopes only the
  literal's own field names — so "measured dead on today's main" is not "unreachable". Pinned by the
  `__proto__: { Math: 3 }` closure row, which keeps refusing through a #4206 repair.) `function-mention.ts`'s
  `objectStaticIsPristine` asks it instead of its own copy and keeps its file-wide `with` screen (elision's
  boundary; a lexical one there would change JS-environment output). A file-wide `with` screen in the
  admission dropped 12 units that main lowers in 2 non-ES5 files (`propertyHelper.js`'s
  `e instanceof TypeError` beside an unrelated `with`), so the admission's test is lexical.
- The walk refuses at select two positions from-ast cannot lower, which main claimed and then withdrew for
  the old names: a loose compare with `null` (`nullComparisonFolds`) and a conditional beside a bare `null`
  (`nullValueAdmissible`). On the JS environment main's claim is kept for those (`null-mix`), because the
  withdrawn claim leaves different bytes there.
- The new names were measured on standalone only, so they ask a lane capability, `native-builtin-globals`
  (`backend/legality.ts`, the same profile as `native-object-statics`); #7118's names keep every lane. With
  the new names on the JS environment its output changed in 112 of 666 probe binaries; with the gate, 0.

**Differences from the plan.**
- `return X` and other escapes (array / object literal, an unresolvable callee's argument) stay refused:
  the walk cannot follow the value to the member reads behind it, and an unseeded member answers
  `undefined` (hazard 3). The walk follows locals and same-file parameters, as before.
- Conversions (`"" + Math`) stay refused: a constructor carrier is a `$Object` whose ToPrimitive is not the
  function's source text.
- The static folds still use their own screens (`objectStaticsArePristine`, `realmIsUnpatched`); moving
  them onto `isPristineIntrinsic` is G6.

**Measured** (standalone, main `ba6652f671`, QuickJS and the Temporal provider built per tree,
`TEST262_FULL_RUNTIME_EVAL=1`):

| population | files | gained | lost | units newly legacy | new post-claim | new CE | standalone binaries differ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ES5 carriers (1,837) + 500 IR-only controls | 2,337 | 2 | 0 | 0 | 0 | 0 | 2 |
| non-ES5: bare uses of the new names, and files writing / deleting / defining a built-in or with `with` | 1,982 | 0 | 0 | 0 | 0 | 0 | 0 |

- Gained: `built-ins/JSON/15.12-0-1.js`, `built-ins/global/S10.2.3_A1.1_T4.js`; both pass on both trees.
- Probes against node (module level and in a function): 408 position programs, 228 identity programs,
  120 realm-graph programs: 0 claimed-wrong, 0 lost, 0 new post-claim errors.
- JS-environment output: identical on 666 binaries (the 408 position programs, the 2 gained files and 256
  sampled carrier, control and `with` files).

**Re-measured 2026-11-19** (lead takeover; branch head after merging main `ee3fcdd610`, standalone, compile census
without the Temporal provider, verdicts with `scripts/run-test262-paths.mts`). Population: the 1,327 ES5 files
that pass on the standalone baseline of 2026-11-19, still carry legacy units, and name a built-in global outside
a call, `new`, `instanceof` or member position (`.tmp` prefilter; the earlier 1,837-file carrier list is not in
the repository).

| population | files | gained | lost | units newly legacy | new post-claim | new CE | standalone binaries differ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ES5 candidates | 1,327 | 3 | 0 | 0 | 0 | 0 | 3 |
| random test262 sample, default and standalone | 100 | 0 | 0 | 0 | 0 | 0 | 0 (JS environment 0 of 103 incl. the gained) |

- Gained: `built-ins/JSON/15.12-0-1.js`, `built-ins/global/S10.2.3_A1.1_T4.js` and (new since 2026-11-16)
  `built-ins/global/S10.2.3_A1.2_T4.js`; all three pass on both trees.
- `tests/issue-7294-builtin-proto-member-provider.test.ts` fails the same 4 rows on main `ee3fcdd610` as on
  the branch (`operand-coercion-unsupported` on `Object.is`); not caused by G1.

### Review RV7263 (2026-11-19, APPROVE on `46c3e8d62f`) — follow-ups recorded here

- **Named item, G2: `admittedBuiltinProtoMember` is a second admission.** Reviewer: "#7294's
  `admittedBuiltinProtoMember` admits the built-in `B` in `<B>.prototype.<m>` with only
  `builtinProtoMemberGlobalsUnshadowed`: no pristine screen and no lane name set. #7127's
  `isExactProtoMethodValueRead` admits the same source shape behind a different screen." G2 folds
  `src/ir/builtin-proto-member.ts:50` into `builtinGlobalValueAdmitted`.
- **Named item, G6:** `objectStaticsArePristine` (`src/ir/object-integrity.ts`) and `realmIsUnpatched`
  (`src/ir/wrapper-construction.ts`) keep their own pristine screens; G6 moves them onto
  `isPristineIntrinsic`.
- **Not folded, layering:** `STRICT_EQUALITY_OPERATORS` (`src/shared/ambient-intrinsics.ts`) duplicates
  `isStrictEqualityOperator` (`src/ir/analysis/operand-admissibility.ts`), but `src/shared/` may not import
  `src/ir/`. The fold is moving the operator predicates to `src/shared/` with their 11 IR importers; filed as
  part of G2 rather than widened here.

- **Review RV7263 delta (BLOCKER on `8926554a54`), fixed:** the `with` screen is restored (above) and the
  `isLibOnlyBinding` guard is pinned by a REFUSED row, `namespace TypeError { export const z = 1; }` with
  `typeof TypeError === "object"` in a function (without the guard the IR claims it and answers 0).

## Known

- **`null` mix of #7118's names on the JS environment** (lead decision 2026-11-19, accepted as is): there
  `if (TypeError == null) throw 0;` is claimed and then withdrawn after the claim, the routing it had before
  #7350, so the JS environment's output stays byte-identical; on standalone it is refused at select. The
  `native-builtin-globals` capability decides both the new names and this refusal. Remove the exception with
  the JS lane.

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
