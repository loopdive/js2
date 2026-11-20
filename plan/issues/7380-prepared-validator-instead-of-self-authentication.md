---
id: 7380
title: "Prepared path: replace self-authentication (receipts, census, forgery pins, layout audits) with one validator"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-20
priority: critical
horizon: l
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, backend
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Prepared path: one validator instead of self-authentication

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R3. Numbers below are from that report's section on question 3.

## Problem

The Prepared path re-proves, at many points, that its own in-memory plan was not altered: provider census, support
receipts, "complete source" hash pins, re-planning on use, and a layout audit on every `physicalIndex()` call. The
threat it models is another compiler module forging a plan object. No external input can do that.

Measured cost (see the report for commands and commits):

- Compile time through the strict Prepared entry: a 50-line string program took 436 s before the perf slice and 50 s
  after; 200 lines take 428 s (#7354 "Perf result", 2026-11-17). With the native realm one small program takes about
  18 s; 16 s of it is `PhysicalModuleReservations#verifyLayout` (#7354 "Realm join", 2026-11-19). A full ES5 run at
  18 s per file is about 45 CPU-hours.
- Measured 2026-11-19 on `claude/7354-o`: one object-literal program compiles in 13.0 s; with `#verifyLayout`
  returning at once in 0.60 s, with identical bytes. 80 % of the profile is under proof functions.
- About 38 % of the Prepared-only code (45,600 lines) is proof, by a hand sample (±15); of the last 10 merged
  Prepared PRs' 8,023 added lines, 1,183 were mechanism.
- `tests/issue-3518-runtime-program-relocation.test.ts` fails 298 of 298 on main unnoticed.
- Slice D1's first cut broke 150 receipt tests by moving a pass; PR #7268 needed five review rounds on forged plan
  objects; 9 of the 10 merged Prepared PRs record a NOT MET review round.
- Every new intrinsic edits closed lists and hash pins in several files (slice T, `js.value.to_boolean`: 17 files, a pinned list
  length and a pinned SHA-256 of the table text).

## To decide

- The invariants that must hold at each stage boundary (lowered IR, legalized IR, physical plan, emitted module),
  written once as a validator that runs in tests and CI, plus `WebAssembly.validate` and a differential run.
- Which existing checks are that validator already, and which only re-prove object identity or source hashes.
- Whether audits become a debug/CI flag or are deleted; what happens to the "complete source" SHA pins and the
  forgery tests (delete, or freeze as historical).
- Exhaustiveness of kind/intrinsic tables by a TypeScript `never` check instead of counted pins.

## Acceptance criteria

1. Compile time through the Prepared entry is linear in program size; the #7354 proving programs compile in under
   1 s each and a 200-line program in under 5 s, with the realm reserved.
2. Adding one intrinsic or value kind touches its definition, its provider and its tests; no hash or count pin.
3. A seeded set of invalid plans (wrong type, missing provider, out-of-range index) is rejected by the validator.
4. Prepared-path output bytes for the existing proving programs are unchanged.
5. Code quality: the validator is one module per stage; the removed machinery is deleted, not bypassed.

## Decision

Accepted by the project lead on 2026-11-19. From then on no lane adds census rows, receipts, hash or count pins, or
forged-plan tests for new mechanisms, and reviews block on behaviour and code quality, not on forged in-memory plans.

## Implementation Plan

Written 2026-11-19 by the architect lane. Base read: `origin/main` `89e4748241`. Branches read on top:
`claude/7354-perf2` `c693577a9d`, `claude/7354-o` `e587829733`, `claude/7354-realm` `2efccd886f`,
`claude/7354-fa` `e22cb7c872`. Probes and raw logs are scratch files (`.tmp/` of the architect worktree), not committed.

Gist:

- Two one-line switches remove 97 % of the compile time of a realm program with identical bytes (14.2 s → 0.45 s):
  the layout audit and the thrown slot probes. That is PR 1.
- The provider census is today the only thing that refuses seven `Math.*` calls. Its refusal moves to an explicit
  table before the census is deleted.
- Source-pin tests are retired before the machinery is deleted, because every edit of a pinned file breaks them
  again. Each mechanism then leaves together with its forged-plan tests, in one PR.
- Production keeps: refusal by name at the front, the IR verifier, the ledger's O(1) phase checks,
  `WebAssembly.validate`. Tests and CI add one validator per stage boundary behind `JS2WASM_VALIDATE_PREPARED=1`.

### 0. Experiment that grounds PR 1 (measured 2026-11-19, scratch copy of `claude/7354-perf2` `c693577a9d`)

Method: `git archive` of the branch into a scratch tree, five env-flag early returns inserted by script, each program
compiled through `src/test262/test262-prepared-entry.ts` (`wholeProgram: prepared-program-required`, wasmgc,
standalone, `allowJs`), second compile in the process, one run each, load average 1.5 to 2.5 from another agent.
`sha1` of the binary compared against the unswitched run; every binary also passed `WebAssembly.validate`.

Switch points (one line each):

| switch | where | what returns at once |
| --- | --- | --- |
| `layout` | `PhysicalModuleReservations.#verifyLayout` (`src/wasm/physical/module-reservations.ts:379`) | the layout audit |
| `probe` | `hasNativeCollectionState` (`src/ir/program/data.ts`) and the Date / Map / Set / WeakMap / WeakSet slot probes in `copyIrPreparationData` (`src/ir/analysis/alloc-registry.ts:56,81`) | `instanceof` instead of 4 to 5 thrown `TypeError`s per object |
| `current` | 18 functions: every `assert*Current` under `src/ir`, `src/backend/wasmgc`, plus `assertNativeStringValueReservationInput`, `authenticateCensus`, `assertNativeValueResourcePlan` | re-derive-and-compare checks |
| `copy` | `immutableCopy` (`src/ir/program/data.ts`) | a value it produced itself is returned, not copied again |
| `validate` | `assertPreparedIrProgram` (`src/ir/program/validation.ts:195`) | the program validator (runs 5 times per compile) |

Compile time in seconds (bytes identical to the unswitched run in every cell, 12 programs × 9 configurations):

| program | none | layout | probe | current | copy | validate | layout+probe | layout+probe+current+copy | all five |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| numeric (`var x = 1; x = x + 1; …`) | 0.26 | 0.15 | 0.21 | 0.24 | 0.24 | 0.25 | 0.09 | 0.07 | 0.06 |
| throw / catch | 0.20 | 0.11 | 0.18 | 0.20 | 0.21 | 0.22 | 0.07 | 0.05 | 0.05 |
| remainder + thrown parameter | 0.34 | 0.24 | 0.27 | 0.34 | 0.32 | 0.37 | 0.14 | 0.10 | 0.10 |
| `for` loop | 0.28 | 0.18 | 0.24 | 0.27 | 0.26 | 0.30 | 0.12 | 0.07 | 0.09 |
| 1 string line (literal + concat + length + `===`) | 0.32 | 0.24 | 0.26 | 0.37 | 0.32 | 0.42 | 0.12 | 0.08 | 0.08 |
| 20 string lines | 1.23 | 1.06 | 0.87 | 1.12 | 1.13 | 1.34 | 0.65 | 0.27 | 0.23 |
| 200 string lines | 13.01 | 11.79 | 8.06 | 10.68 | 10.63 | 13.95 | 6.22 | 2.88 | 2.19 |
| `typeof v` | 0.62 | 0.28 | 0.53 | 0.60 | 0.60 | 0.66 | 0.17 | 0.14 | 0.11 |
| `String(n)` (number formatter) | 1.70 | 0.94 | 1.39 | 1.79 | 1.83 | 1.78 | 0.50 | 0.42 | 0.31 |
| 1 dynamic `+` site | 1.92 | 1.11 | 1.47 | 1.98 | 2.00 | 2.04 | 0.58 | 0.40 | 0.29 |
| 20 dynamic `+` sites | 10.46 | 9.56 | 6.71 | 9.55 | 8.07 | 9.24 | 5.39 | 2.27 | 2.01 |
| truthiness of `null` | 0.33 | 0.17 | 0.26 | 0.30 | 0.27 | 0.30 | 0.08 | 0.06 | 0.05 |

What this says:

- No single switch gives the win on this branch. `layout` halves the small programs (the audit is a fixed cost per
  reservation call), `probe` gives 35 to 40 % on the large ones, and the four proof switches together give 4.5× on
  the large programs and 3 to 5× on the small ones. The validator (`validate`) costs under 25 % once the rest is off,
  so running it once per compile in tests and CI is affordable.
- The remaining 2.2 to 2.9 s at 200 lines is still not the mechanism: the ordinary pipeline compiles the same program
  in 1.1 s (review evidence, section 5.1). It is the remaining defensive copies and whole-program deep compares
  (`preparedIrDataMismatch`), which PR 3 removes by deleting their callers.
- CPU profile of the unswitched run (200 lines then 20 `+` sites, 24.6 s): `hasNativeCollectionState` 5.96 s self,
  `immutableCopy` 3.54 s self, the slot probes of `copyIrPreparationData` 2.94 s self, the layout audit's text
  encoder 1.74 s self; `preparedIrDataMismatch` 7.16 s inclusive, `planNativeStringValuePhysical` 6.03 s inclusive
  (it re-plans to compare), `assertPreparedIrProgram` 2.33 s inclusive; `lowerIrFunctionBody` 1.56 s inclusive
  (most of it nested audits).

Same switches on a scratch copy of `claude/7354-o` `e587829733` (the native realm is reserved there):

| program | none | layout | layout+probe | layout+probe+current+copy | all five | probe+current+copy (audit left on) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `function f(){ var o = { a: 1 }; return o.a; } if (f() !== 1) throw 1;` | 14.21 (14.56 on a second run) | 0.90 | 0.45 | 0.35 | 0.39 | 14.02 |
| 20 object literals in one function | 16.69 | 2.54 | 1.12 | 0.54 | 0.54 | 13.56 |
| numeric | 0.27 | — | 0.09 | 0.06 | 0.05 | 0.15 |

Bytes identical in every cell (`sha1 965e46bdbd9a`, `9b0045958bd4`, `6f62adfb4514`). With the realm reserved the
layout audit is the single switch: 14.2 s → 0.90 s alone, and nothing else moves the number while it stays on.

Conclusion for PR 1: two switch points carry it, `#verifyLayout` and the thrown slot probes. Together: realm program
14.2 → 0.45 s, 200 string lines 13.0 → 6.2 s, 20 dynamic `+` sites 10.5 → 5.4 s, numeric 0.26 → 0.09 s. The
re-derivation checks and the copy memo are the second step (2.9 s and 2.3 s for the two large programs).

Found on the way, not part of this issue: on `claude/7354-perf2` the object-literal program throws
`PreparedIrProgramInvariantError: … accepted body … and then failed to lower it: ir/lower: resolver cannot lower
object<a:f64>` out of `compile()` instead of returning a refusal (same class as #7277 / #7305). `claude/7354-o`
compiles it.

### 1. Inventory

Terms, each with one example:

- *layout audit*: on every ledger call, `#verifyLayout` re-serialises every reserved record, type, filled function
  and global to text and compares it with a stored copy.
- *currentness check*: `assertNativeStringOutputRequirementsCurrent(req)` derives the requirements again from the
  program and deep-compares them with `req`, to prove the caller did not pass a stale or altered object.
- *census*: `runtimeCensus` compares the selected runtime providers with the functions the emitted module holds, row
  by row.
- *receipt*: `emittedSupportFunctionReceipts(emission)` answers `(key, function index)` pairs only for an emission
  object found in a module-private `WeakMap`.
- *source pin*: a test that fails when the SHA-256 or length of a file under `src/` changes.

Sizes on `origin/main` `89e4748241`: Prepared family 192 files, 50,778 lines, 1,443 functions, 38,352 function-body
lines (TypeScript AST walk; same family as the review plus `src/ir/prepared-*.ts` and `alloc-registry.ts`).

How to read the table:

- "src lines" counts whole functions whose **name** identifies the mechanism. It is a lower bound: proof code inside
  mechanism-named functions is not counted. The review's hand sample puts the true share at 38 % ± 15, about 14,000
  of the 38,352 lines.
- "tests" is file-level, and files overlap between rows. Do not sum the column.
- "calls" is one compile of: the trivial numeric program / 20 string lines / one object literal (the last on
  `claude/7354-o`), counted with scratch counters.

| # | mechanism | files and entry functions (main) | src lines | tests (main) | calls per compile | what it protects | class |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| M1 | Layout audit | `src/wasm/physical/module-reservations.ts` `#verifyLayout`, `#snapshot`, `#recordText`, `audited`, `physicalIndices`; `data-snapshot.ts` (107); `owned-function-data.ts` (264) | 393 | 88 files / 39,143 lines name the ledger; 33 files / 16,776 lines assert an audit refusal text | 383 / 5,749 / 5,249 audits, each O(module) | another module overwriting `WasmModule` arrays, a reserved type or a filled body behind the ledger's back | **b** |
| M2 | Ledger phase and population checks | same file: `#require` (phase), `#key` (duplicate key), `#owned`, duplicate / missing fill, `#importsClosed`, `seal()`, `#validateResources`, `#validateInstructions`, `#validateType`, `#validateDeclaredFunctionReferences` | 194 (the `#validate*` part) | the same 88 files | O(1) per call; `#validate*` once at `seal()` and once per fill | index out of range, missing fill, an import added after a defined function (the index-shift bug class of `addUnionImports`), duplicate export name | **a** for `#validate*`; the O(1) state checks are **c** and stay in the ledger |
| M3 | Owner and completion re-authentication | 61 functions in `src/backend/wasmgc/**`: `ownerFor`, `completedOwner`, `checkCompletedOwner`, `requireCompleted*`, owner `WeakMap`s; largest `program/native-string-values.ts` (91), `resources/native-object-descriptors.ts` (53) | 876 | 50 files / 23,752 lines | 3 / 83 / 11 `ownerFor`; each `requireCompleted*` re-checks its dependencies | a resource pack used with a ledger or plan other than the one it was reserved for | **b** |
| M4 | Currentness by re-derivation | 18 `assert*Current` functions under `src/ir/program/` and `src/backend/wasmgc/`, `assertNativeStringValueReservationInput`, `authenticateCensus`, `assertNativeValueResourcePlan`; `same(demands, collect…(program), "stale or mismatched demand census")` | 735 | 29 files / 19,969 lines | 21 / 581 / 214 `assertNativeValueResourcePlan`; `planNativeStringValuePhysical` 4 times (it re-plans to compare) | a requirement record that is not the one derived from this program | **b** |
| M5 | Provider census | `src/compiler/prepared-provider-census.ts` (418): `runtimeCensus`, `nativeRows`, `nativeSlots`, `supportPopulationJoins`, `stringProvidersJoin`, `literalUsesJoin`, `remainderRows`; caller `checkResourceDemand` (`ir-program-presentation.ts:661`) | 212 (+139 in the presentation) | `tests/issue-7354-r-provider-census.test.ts`, 815 lines, 113 tests | 1 | three things. (i) The emitted support functions equal the selected providers: **a**, one population check. (ii) Forged setups: **b**. (iii) By accident, the only refusal of seven `Math.*` calls: **d**, see below | **a + b + d** |
| M6 | Support receipts and capability tokens | `src/ir/program-consumer.ts`: the `acceptances` and `startupAdapters` `WeakMap`s, `recordEmissionObservation`, `emittedSupportFunctionReceipts`, `emittedPhysicalSetupPlan`, `isAuthenticAcceptedIrProgram` ("invalid-transaction-capability") | ~120 | 10 files / 6,235 lines | 10 receipt reads, 7 plan reads | an emission or acceptance object that this consumer did not create | **b**. The data it carries is mechanism and stays, as a plain return value |
| M7 | Finalization observation | `ir-program-presentation.ts:1222–1545`: `detachedPresentations`, `observeModuleData`, `verifyDataObservation`, `copyModuleData`, `wideningSlots`, `begin…` / `completePreparedPresentationFinalization`, `preparedPresentationWitView` | 493 (268 in this file) | 4 files / 1,976 lines | 5,571 / 8,784 / 25,527 `verifyDataObservation` visits | the finalizer changing anything but reference nullability. It exists because M1 rejected the pipeline's own in-place finalization (#7354 R, "altered type descriptor") | **b**; the nullability-only rule is **a**, one check in the module validator |
| M8 | Data hygiene | `src/ir/program/data.ts` (322): `hasNativeCollectionState`, `immutableCopy`, `FrozenMap` / `FrozenSet` brands, `preparedIrDataMismatch`; `src/ir/analysis/alloc-registry.ts` `copyIrPreparationData`, `assertAllocRegistrySnapshot`; `src/test262/test262-prepared-entry.ts` `selected()` | 351 | 20 files / 12,442 lines | 8,780 / 93,237 / 91,889 slot probes (up to 4 thrown `TypeError`s each); 54 / 59 / 266 deep copies; 123 / 2,362 / 2,280 deep compares | a plain record that is secretly a `Map`, an accessor or a Proxy; a caller keeping a mutable alias | **b**. `preparedIrDataMismatch` stays as the structural-equality helper of the validators and tests; freezing stays once, where the program is produced |
| M9 | Settled verdicts | main: `isImmutablePreparedIrValue`, `sharedPrototypeState` inside `native-string-values.ts` | 30 | `tests/issue-7354-perf-string-authentication.test.ts`, 312 lines | per emit | nothing: a cache whose only purpose is to pay for M3 and M4 | **b**, deleted with M3 and M4 |
| M10 | Program validator | `src/ir/program/validation.ts` `assertPreparedIrProgram` (200 lines) + `population.ts` (165) + `runtime-validation.ts` (169) + `allocations.ts` + `runtime-support-dependencies.ts`; source-map validation (600 lines of the same file) | 1,495 together with M2's `#validate*` | 21 files / 8,935 lines | 6 / 6 / 6 full runs, from 13 call sites in 7 files | ABI entries unique, every call and global declared, body signature equals its ABI entry, startup order, `verifyIrFunction` per body | **a**; the 5 repeat runs are **b** |
| M11 | IR verifier | `src/ir/runtime/verify.ts` `verifyIrFunction` (3,164 lines, shared with the ordinary pipeline) | shared | 66 files / 28,365 lines | 9 / 18 / 18 | operand and result types, SSA definitions, dominance | **a**; stays on the production path exactly as in the ordinary pipeline |
| M12 | Engine validation | `src/compiler/validation.ts` `gateEmittedModule` (`WebAssembly.validate`) | shared | — | 1 | an invalid module never reports success (#4420, #6776) | **a**; stays on in production |
| M13 | Strict entry | `src/test262/test262-prepared-entry.ts`; the generator spies in every `issue-7354-*` test | ~60 | 16 files / 4,924 lines | 1 | a strict Prepared request never reaches a legacy generator, so the IR-only figure is honest | **c**; becomes an import-boundary rule plus one spy test |
| M14 | Invariant errors leaving `compile()` | `runIrProgramDriver` throws `IrProgramDriverInvariantError`; `emissionFailed` | — | — | — | #7277 and #7305 fixed two cases. Measured today on `claude/7354-perf2`: an object literal throws "accepted body … and then failed to lower it", and `eval("1")` throws "certified global eval lost an owning predicate" | **c**; one catch at the strict entry turns any invariant into a named compile error |
| M15 | Source pins and historical reconstruction | `tests/helpers/ir-*`: 71 `.ts` helpers (34,572 lines) and 39 `.json` receipts (4,396 KB); `scripts/audit-legacy-reachability.mjs --moved-reference-contract=preservation-v1` | 0 in `src/` | 94 test files / 65,874 lines use a pin helper; 82 more / 46,090 lines hash `src/` files directly; 121 of the 176 are `issue-3518-*` | not on the compile path | where a declaration lived when a review happened | **b** |
| M16 | Closed lists and counted pins | seven tables per intrinsic id (section 3); `tests/issue-3518-core-vocabulary-seam.test.ts` (`INTRINSIC_IDS` length), `tests/issue-3518-semantic-verification-ownership.test.ts` (SHA-256 of the definitions table) | one row per id in each table | 85 files hold a two-digit `toHaveLength` or name `INTRINSIC_IDS` | not on the compile path | a table that forgot a row | **a**, by the type checker (section 3) |
| M17 | Presentation joins after emission | `ir-program-presentation.ts`: `joinDeclarations`, `checkAbiExports`, `joinStartup`, the export loop (about 30 gap codes such as `startup-call-order`, `export-binding-join`, `physical-signature`) | ~450 | `tests/test262-prepared-entry.test.ts` (703 lines), `tests/issue-7188-…` | 1 | the emitted exports, start function and adapter are the ones the source asked for | **a**, module validator; six of the codes are also **d**, listed below |
| M18 | Front refusals | `capturePresentation` (`ir-program-presentation.ts:264`), `ir/from-ast`, the legalization, the runtime policy, `acceptPreparedIrProgram` gaps | — | every `issue-7354-*` refusal block | 1 | a construct the path cannot compile | **d**, unchanged |

Out of scope: the `mixed` (wasmgc:host, Promise) half of the presentation (`checkMixedDemand`, `checkMixedImports`,
`checkMixedResources`, `checkMixedFrames`, about 270 lines) and `src/codegen/multi-prepared*` /
`src/codegen/program-abi*` (27,982 lines, ordinary-pipeline bookkeeping). The first belongs to the JS-host lane that
is being retired; the second is not on the Prepared path. Neither is touched, except that their source-pin tests go
with M15.

Totals on main, by class ("src" is the named-function lower bound, "tests" a file-level upper bound):

| class | src lines | tests |
| --- | ---: | --- |
| a, real stage invariant | about 2,150 (M2 194, M5's population join ~60, M7's one rule ~30, M10 1,300, M17 ~450; M11 and M12 are shared code) | the 21 + 66 files that call the two verifiers; they stay |
| b, re-proof of the compiler's own data | 2,878 named (M1 393, M3 876, M4 735, M5 ~290, M6 ~120, M7 ~460, M8 ~350 less the helper that stays, M9 30); by the review's sample about 14,000 | 136 Prepared-importing files / 68,364 lines use a forgery idiom; 176 files / 111,964 lines are source pins (M15) |
| c, guards a bug class that occurred | about 100 (ledger O(1) checks, strict entry, the invariant catch) | 16 files name the strict request |
| d, user-facing refusal | not counted (front-end code) | 12 `issue-7354-*` files, 3,840 lines; they stay |

What the in-flight branches add (lines changed in mechanism files against the merge base):

| branch | adds |
| --- | --- |
| `claude/7354-perf2` | M5: `prepared-provider-census.ts` +87/−15 (490 lines) and new `prepared-formatter-census.ts` (212): `formatterSetupJoins`, `derivedFormatterSetup`, `batchJoins`, `ryuTablesJoin`, `callableCarried`, `unjoinedSupport`. M9 as its own mechanism: `src/shared/contracts/settled-verdict.ts` (121), `src/ir/program/settled-verdict.ts` (15), `src/ir/program/prepared-allocations.ts` (21), `checkUnlessSettled` in four requirement files. M1: the per-body `audited` scope in the consumer. Tests +2,505 lines in 14 files, among them `issue-7354-str2c-formatter-census.test.ts` (390 forgeries) and `issue-7354-perf2-settled-checks.test.ts` (12). Named-function totals: census and receipts 1,415 → 1,522, hygiene 351 → 390. |
| `claude/7354-o` | perf2's Str2 and Perf parts, plus `prepared-provider-census.ts` +140/−23, `native-realm.ts` +66, `program-consumer.ts` +50/−26, new `prepared-code-strictness.ts` (15). Census and receipts 1,554, owner 910. Tests +2,963 lines in 26 files. |
| `claude/7354-realm` | the realm join: `prepared-provider-census.ts` +50/−11, `native-realm.ts` +66, `program-consumer.ts` +49/−25, `program-physical-plan.ts` +30/−15. Tests +532. |
| `claude/7354-fa`, `claude/7354-fb` | the same realm join (+50 and +27 in the census), `alloc-registry.ts` +12, `ir-program-presentation.ts` +10/−6, `native-invocation-requirements.ts` +38 (fb). Tests +1,029 and +860. |
| `claude/7354-ty-r2` | two rows in three closed id lists (M16); `native-string-values.ts` +2. |
| `claude/7350-g1`, `claude/7372-globals-registry`, `claude/7354-script-scope` | no mechanism file. |
| `claude/7354-perf3-reservations` (#7365, not in the brief's list) | a third design of M1 (audit only in completion checks) plus `scripts/check-pinned-refusals.mjs`. PR 1 supersedes it; do not merge it. |

#### Refusals that census and receipt code produces today (class d), and where each goes

Probe: 69 small programs with unsupported or borderline constructs through the strict entry on `claude/7354-perf2`,
once as built and once with the census joins answering "joined". 62 answers were identical. Seven changed:
`Math.floor`, `Math.abs`, `Math.sqrt`, `Math.ceil`, `Math.trunc`, `Math.min`, `Math.max`.

- Each is refused today only by the pair "host provider or async demand is outside this numeric presentation
  contract" + "nondefaultable reference widening needs a separately authenticated physical post-state".
- The cause is one line in `nativeRows`: `providers.some((row) => !strings.includes(row) && !callables.includes(row))`
  refuses every provider whose implementation is not a runtime callable. These seven select `backend.f64.floor`,
  `backend.math.min` and so on (kind `backend-op`).
- With the joins off all seven compile, validate and return the right answer. So nothing wrong would ship here. But
  the accepted set would grow without a decision, and the next provider kind may not be so benign.

| refusal text (code) | produced by | constructs that reach it | after the change |
| --- | --- | --- | --- |
| "host provider or async demand is outside this numeric presentation contract" (`runtime-demand`) | `checkResourceDemand`: `manifest.hostCapabilities`, `asyncPlan`, or `runtimeCensus` answered `undefined` | Host capability or async: plain reads. Census `undefined` for a real program: a selected provider of a kind the presentation has no setup for (measured: the seven `Math.*` above; before Str2-c also `String(n)`) | The first two clauses stay where they are. The third becomes `admittedProviders(manifest.providers, plan)` in new `src/compiler/prepared-admission.ts`: a `Record<RuntimeProviderImplementation["kind"], Admission>` (the union has 16 kinds, `src/ir/runtime/contracts/manifest.ts:480–636`), so a new kind does not compile until it has a row. `runtime-callable` is admitted when the physical plan declares a setup function bound to its symbol; `native-global` and `carrier-field` when the string setup is present; the remainder providers by catalogue id; every other kind refuses. Same code, same text. |
| "nondefaultable reference widening needs a separately authenticated physical post-state" (`widening-demand`) | `referenceDemand(mod, native)`; `native` is the census's answer | any `ref` type outside the native setup's type and global slots: an unadmitted provider (above), or any reference on gc / WASI | The slots are read from the physical plan's declarations (`plan.nativeStrings`; on perf2 also `plan.nativeNumberFormat`; on the realm branches the realm setup) by a plain lookup in `prepared-admission.ts`. `referenceDemand` itself is unchanged. |
| "promise/reference callable contracts require an explicit boundary producer" (`non-numeric-contract`) | `checkAbiExports` (`ir-program-presentation.ts:467`), predicate `inCall`; on perf2 `callableCarried` lives in the census module | a callable whose parameter or result is not a number, the dynamic value or a string: object, Promise or vector results | A pure function of `program.abi.entries`; it moves verbatim to `prepared-admission.ts`. On perf2 the formatter-scratch arm of `callableCarried` moves with it (it compares with the canonical declaration; no join). |
| "source and prepared runtime must independently prove no async/support demand" (`async-demand`) | `checkResourceDemand`; on perf2 `unjoinedSupport(program, native)` | async functions; a runtime-support batch other than the formatter's | The async half is unchanged. The batch half becomes "exactly the formatter batch, and only when the formatter provider is admitted", in the admission table. |
| "live imports/string/extern/JSX resources require an explicit presentation contract" (`resource-demand`), "globals need a numeric or dynamic contract", "complete synchronous numeric or Boolean function declarations are required", "top-level global storage needs a numeric source classification", `unproved-output-option`, `unmapped-wit-*` | plain reads of the module, the ABI and the captured declarations | host imports, JSX, non-numeric exports, source maps on this path | Unchanged, same place. They read no census and no receipt. |
| "string policy not selected" | This text does not exist in `src/`. The refusal a string had before slice Str was "runtime feature js.string.… is unavailable under … policy …=unsupported", from the runtime manifest (`prepareWholeProgramRuntimeManifest`). `"a" < "b"` gets it today for `js.string.compare`. | a feature whose policy is `unsupported` | Unchanged; it never touched the census. |

Rule for the move (PR 4): the admission table lands while the census still runs, and a test asserts on the probe
corpus that both refuse the same programs. Only then is the census deleted. Admitting the seven `Math.*` calls is a
separate, deliberate change with its own tests; file it as a follow-up and do not fold it in.

### 2. The validator

One module per stage boundary. Three of the four exist; the plan moves checks into them and adds one. Each exports
one function that takes plain data and throws `PreparedIrProgramInvariantError("invalid-prepared-data", …)` with the
stage name in the message. None takes a capability token, keeps a `WeakMap`, or compares with a stored snapshot.

| stage boundary | module | status | invariants |
| --- | --- | --- | --- |
| 1. Lowered IR (after `lowerFunctionAstToIr` and after every middle-end pass) | `src/ir/runtime/verify.ts` `verifyIrFunction` | exists, shared with the ordinary pipeline; called at `src/ir/program-middleend-ir.ts:60` | every operand is defined before use and dominates it; operand and result types match the instruction; every block ends in one terminator; branch arguments match block parameters; a call's argument and result types match the declared signature |
| 2. Legalized (prepared) program | `src/ir/program/validation.ts` `assertPreparedIrProgram`, with `population.ts`, `runtime-validation.ts` | exists | every terminal unit has exactly one body or a recorded refusal; ABI binding ids are unique; every `call`, `closure.new`, `global.get` / `global.set` names a declared ABI entry; a body's signature equals its ABI contract; startup rows follow source order and each executable row has one typed body; one runtime projection per backend and target, consistent with its policy; stage 1 on every body with the declared signatures. **New**: no `dyn.*` operation and no `dynamic` type survives legalization; every intrinsic a body uses has exactly one provider in the selected manifest ("missing provider") |
| 3. Physical plan (`PhysicalSetupPlan`, the output of `acceptPreparedIrProgram`) | **new** `src/ir/program/validate-physical-plan.ts` `assertPhysicalSetupPlan(program, plan)` | new, about 150 lines | every selected provider is answered by exactly one setup row and every setup function is a provider's implementation or a dependency the setup declares (the census's population join, kept once, as data equality); resource keys are unique; each declaration's type keys resolve to a declared type of the same setup; each `required` ABI entry has exactly one reservation key and no entry has two; the plan's backend and target are the request's |
| 4. Emitted module (`WasmModule` storage after `seal()`, before binary emission) | **new** `src/wasm/physical/validate-module.ts` `assertPhysicalModule(module, expectations)` | new file, about 300 lines, of which about 250 **move** out of `PhysicalModuleReservations` (`#validateResources`, `#validateInstructions`, `#validateType`, `#validateFinalParents`, `#validateCanonicalGroup`, `#validateDeclaredFunctionReferences`) | every type, function, global, tag, table and local index is in range; every defined function has a body and every defined global an initializer; export names are unique and each export index is in range; the start function exists and has signature `() -> ()`; every `ref.func` target is declared; imports precede definitions. From M17, as `expectations`: the adapter calls each startup unit once in source order; each source export joins one physical export with the captured signature. From M7: finalization changed reference nullability only |
| 5. Binary | `src/compiler/validation.ts` `gateEmittedModule` (`WebAssembly.validate`) | exists, on by default | the engine accepts the module |
| 6. Behaviour | the "run as written, then with one wrong answer" tests (`tests/issue-7354-*`), `.github/workflows/diff-test.yml` and `test262-differential.yml` | exist | the answers equal node's |

Reuse, and what it removes:

- `preparedIrDataMismatch` stays as the one structural-equality helper (stage 3 and tests). Its slot probes go (M8).
- Stage 4 is a move, not a second copy: the ledger class loses its `#validate*` methods (1,268 → about 1,000 lines
  in PR 3, about 700 after PR 5c) and calls nothing in their place.
- `assertPreparedIrProgram(program)` has 13 call sites in 7 files. Three stay: `program-prepare-ir.ts:143` (where
  the program is produced; it becomes the one flagged stage 2 call), `program-codec.ts:448` (a decoded program is
  external input, so this one runs always), and the two in `program-native-async-resources.ts` (host lane, not
  touched). The other nine go: `program-consumer.ts` ×3, `program-physical-plan.ts` ×2,
  `program-native-invocation.ts` ×3, `program.ts:82`. That is why the trivial program validates 6 times today.

When each runs:

| check | production compile | vitest | CI |
| --- | --- | --- | --- |
| refusal by name (M18, and `prepared-admission.ts` after PR 4) | always | always | always |
| stage 1, `verifyIrFunction` | always, as today and as in the ordinary pipeline | always | always |
| ledger O(1) checks (phase, duplicate key, unknown token, duplicate or missing fill, imports closed) | always | always | always |
| stages 2, 3, 4 | only with `JS2WASM_VALIDATE_PREPARED=1`, once per stage per compile | on (`test.env` in `vitest.config.ts`) | on in `quality` (it runs vitest) and in the Prepared test262 lane's worker |
| stage 5, `WebAssembly.validate` | always | always | always |
| stage 6 | — | the behaviour tests | `diff-test`, `test262-differential`, the test262 lanes |

Wiring, one place each:

- The flag is read once, by the existing `readEnv` (`src/env.ts:107`), in the leaf PR 1 adds
  (`src/shared/contracts/prepared-validation.ts`: one boolean and a setter for tests). It is a leaf because the
  ledger (`src/wasm/physical/`, which imports nothing from `src/ir/` today) and `data.ts` both read it in PR 1.
  If `check:compiler-boundaries` rejects the `wasm/physical → shared/contracts` edge, the driver passes the boolean
  to the ledger's constructor instead.
- Stage 2 is the existing call at `program-prepare-ir.ts:143`, made conditional on the flag. `runIrProgramDriver`
  (`src/compiler/ir-program-driver.ts`) calls stage 3 after `acceptPreparedIrProgram` and stage 4 after
  `emitAcceptedIrProgram`, under the same flag. Nothing else calls them.
- A validator failure is a compiler bug, never a refusal. The strict entry reports it as a compile error
  `prepared validator (<stage>): <detail>` and it counts as a failure in every lane (see M14).

Why stage 2 may leave the production path. With all five scratch switches of section 0 off, stage 2 costs under
25 % of what remains, so cost is not the reason either way. The reason is the rule that a production compile does
not re-prove its own output. The condition for it: **no program may depend on a validator for its refusal.** PR 3
measures this before it flips the default (step 3 of PR 3 below). If any program does, that construct gets a named
refusal at the front first.

Seeded invalid plans (acceptance criterion 3): `tests/issue-7380-prepared-validator.test.ts`. Each seed compiles
one small real program to the stage's input, alters one field of a copy, and calls the stage's function directly.
Each seed has a twin that passes unaltered. No module mock, no forged capability.

| # | stage | seed | expected |
| --- | --- | --- | --- |
| 1 | 1 | an `f64.add` operand replaced by a string value (wrong type) | refused |
| 2 | 1 | a use of a value id no instruction defines | refused |
| 3 | 1 | a block with its terminator removed | refused |
| 4 | 2 | a `call` whose target has no ABI entry | refused |
| 5 | 2 | two ABI entries with one binding id (duplicate slot) | refused |
| 6 | 2 | a body whose result type differs from its ABI contract | refused |
| 7 | 2 | an intrinsic whose provider is removed from the manifest (missing provider) | refused |
| 8 | 2 | a `dyn.member_get` left in a body | refused |
| 9 | 3 | a setup function removed while its provider stays selected (missing provider) | refused |
| 10 | 3 | two declarations with one resource key (duplicate slot) | refused |
| 11 | 3 | a declaration whose type key names no declared type | refused |
| 12 | 4 | a `call` with `funcIdx` equal to the function count (out-of-range index) | refused |
| 13 | 4 | a `global.get` past the last global | refused |
| 14 | 4 | two exports with one name | refused |
| 15 | 4 | a start function with a parameter | refused |
| 16 | 5 | seeds 12 and 13 emitted with the flag off | `compile()` reports `invalid-module`, not success |

Seed 16 is the one that matters for production: it shows what still stops a broken index when stages 2 to 4 are off.

### 3. Exhaustiveness instead of pins

One intrinsic id is written in seven source files today (`grep -rlF '"js.value.to_boolean"' src`). Fate of each:

| table | file | today | after |
| --- | --- | --- | --- |
| id list per family | `src/ir/core/intrinsic-vocabulary.ts` (`DYNAMIC_VALUE_INTRINSIC_IDS`, …) | `Object.freeze([...] as const)` | stays; it is the definition. `IntrinsicId` is derived from it |
| id → signature | `src/ir/core/intrinsics.ts:209` `INTRINSIC_DEFINITIONS` | `Record<IntrinsicId, …>` | already exhaustive |
| feature list | `src/ir/runtime/contracts/intrinsics.ts:65` `DYNAMIC_VALUE_RUNTIME_FEATURES` | a second literal list, "1:1 with their intrinsic IDs" by comment | derived: `= DYNAMIC_VALUE_INTRINSIC_IDS`. The same for each family whose features equal its ids |
| id → runtime symbol | `src/ir/runtime/dynamic-value-callables.ts:19` `SYMBOLS` | `Record<DynamicValueRuntimeFeature, string>` | already exhaustive |
| provider id | `src/ir/runtime/contracts/manifest.ts` | literal `native.<id>` rows | built by mapping over the id list (`native.${id}`) |
| ABI role | `src/backend/wasmgc/program/native-primitive-boundary-abi.ts:134` | one `canonicalRow(id, role, native)` call per id | `const DYNAMIC_VALUE_ROLE: Record<DynamicValueIntrinsicId, string>`, mapped to rows |
| legalization rewrite, resource fill | `src/ir/program/dynamic-value-legalization.ts`, `src/backend/wasmgc/resources/native-dynamic-values.ts` | mechanism | unchanged; where they switch on a kind or id, the `default:` arm assigns to `never` |

After PR 6 a new intrinsic touches: its id (one line), its `INTRINSIC_DEFINITIONS` row, its symbol row, its role
row, its body, its legalization arm and its test. A missing row is a `tsc` error. Value kinds already work this way
on `claude/7354-perf2`: `TYPEOF_KIND`, `KIND_TEST`, `TYPEOF_NAME` and `ADD_ROLE` are `Record<CarrierKind, …>` and
`boxedKind()` returns `CarrierKind`. PR 6 adds nothing there; it deletes the tests that count the same rows.

Pin test files and their fate:

| files | what they pin | fate |
| --- | --- | --- |
| `tests/issue-3518-core-vocabulary-seam.test.ts` | `INTRINSIC_IDS` `toHaveLength(42)`, twice | delete the count assertions (PR 6); `Record<IntrinsicId, …>` checks the same thing at compile time |
| `tests/issue-3518-semantic-verification-ownership.test.ts` | SHA-256 of the `INTRINSIC_DEFINITIONS` table text, catalogue length, the "predecessor chain" | delete the file's pin blocks (PR 2). If nothing is left, delete the file |
| `tests/issue-3518-core-vocabulary-evolution.test.ts` (115 red), `tests/helpers/ir-core-vocabulary-evolution.{ts,json}` | reconstructed historical vocabulary files | delete (PR 2) |
| `tests/issue-3518-runtime-program-relocation.test.ts` (298 of 298 red on main, re-run 2026-11-19 on `89e4748241`: "length/SHA256: src/ir/prepared-component-dependencies.ts"), `tests/helpers/ir-runtime-program-relocation.json`, `ir-c1-current-source.ts`, `ir-c1-authority.json` | length and SHA-256 of whole files | delete (PR 2). Yes, they simply go away: every one of the 298 fails at the same hash comparison before it asserts anything else |
| the other families of #7358: `issue-3518-wasmgc-helper-policy-evolution` (~626 red with `issue-3518-semantic-provider-boundary`), `issue-3518-program-ownership-runtime-seam` (10), `issue-3518-native-number-format-requirements` (2), `issue-3518-native-realm-requirements` (1) | whole-file hashes; receipts that pin `src/ir/program/data.ts` | delete the pin blocks (PR 2). A file that still has behaviour blocks keeps them and must then be green |
| all of M15: 71 `tests/helpers/ir-*.ts` pin helpers (34,572 lines), 39 `.json` receipts (4.4 MB), 176 test files that depend on them or hash `src/` directly (111,964 lines, 2,620 blocks) | SHA-256, length, reconstructed bytes, `git show` of old revisions | PR 2 retires them. Per file: a block that reads source text, hashes it or reconstructs history is deleted; a block that compiles and runs stays. Where a pin stood for a real structural rule ("module X must not import Y", "these names are exported"), the rule goes into the existing `scripts/check-compiler-boundaries.mjs` inventory or `check:import-cycles`, which read the current tree |
| count pins in `issue-7354-*` ("Test pins updated by …" in #7354: D1's closed lists, P's refusal rows) | list lengths that move with every slice | delete with PR 6; refusal-by-name rows stay, they are class d |
| `scripts/check-pinned-refusals.mjs` (only on `claude/7354-perf3-reservations`) | which test pins which audit refusal | never lands |

This closes #7358 (and #7357's Prepared rows) as "retired with a reason": the reason is this issue. It also frees
`src/ir/program/data.ts`, `src/ir/analysis/alloc-registry.ts` and `src/ir/program/runtime-manifest.ts` for edits; three
changes in #7354 were withdrawn or bent only because those files are content-pinned.

### 4. Order of work

Six PRs, the fifth in four parts. Each leaves main green and the Prepared bytes of the proving programs unchanged.

The order differs from "machinery first, pins last" in one point: **the source pins go second, not last.** A source
pin fails when the pinned file's text changes, so every deletion PR would break pins of files it edits, and the
per-PR `quality` gate requires every test file a PR modifies to pass. Forged-plan tests are different: each leaves in
the same PR as the mechanism it attacks.

Shared tooling, added by PR 1 and used by every later PR:

- `tests/fixtures/prepared-proving-programs.json`: the distinct programs of the `issue-7354-*`,
  `test262-prepared-*` and `issue-7188` tests (perf2 logged 539: 465 binaries, 74 refusal messages) plus the 69 probe
  programs of section 1 and the 14 of section 0.
- `scripts/prepared-byte-identity.mts`: compiles each through the strict entry and prints `name → sha256 | refusal
  text`. Every PR runs it on its base and its head (file-copy A/B, `.tmp/base`) and puts the empty diff in the PR
  body. It writes no committed hash: it is a comparison tool, not a pin.

| PR | size | content | files | expected lines | what proves it safe |
| --- | --- | --- | --- | --- | --- |
| **1. Self-audit behind one switch** | S | New leaf `src/shared/contracts/prepared-validation.ts`: one boolean, read once from `JS2WASM_VALIDATE_PREPARED` through `readEnv` (`src/env.ts`), with a setter for tests. Three readers: `#verifyLayout` returns at once when it is off; `hasNativeCollectionState` and the two probe loops of `copyIrPreparationData` use `instanceof` when it is off. `vitest.config.ts` sets it on, so every existing audit and forgery test runs as before. | `src/shared/contracts/prepared-validation.ts` (new), `src/wasm/physical/module-reservations.ts`, `src/ir/program/data.ts`, `src/ir/analysis/alloc-registry.ts`, `vitest.config.ts`, `scripts/compiler-boundaries.json`, the two tooling files above, `tests/issue-7380-self-audit-switch.test.ts` | src +35 / −5, tests and tools +250 | Byte identity on the proving programs with the switch on and off, and against base. Ordinary pipeline bytes on 100 test262 files × {JS, standalone} (`alloc-registry.ts` is shared). Failing sets of the 43 reservation / snapshot test files equal to base (switch on). Measured in scratch: realm program 14.2 → 0.45 s, 20 object literals 16.7 → 1.12 s, 200 string lines 13.0 → 6.2 s, 20 dynamic `+` sites 10.5 → 5.4 s, numeric 0.26 → 0.09 s. |
| **2a. Retire the red pins (#7358)** | M | Delete the pin blocks and helpers of the families that are red on main: runtime-program relocation (298), core-vocabulary evolution (115), policy evolution and provider boundary (~626), ownership seam (10), the six receipts that pin `data.ts`. Files left without a block are deleted. | `tests/issue-3518-*.test.ts` (about 8), `tests/helpers/ir-*` they alone use | tests about −10,000; src 0 | Every touched test file is green or gone (required by `quality` for modified files). `check:dead-exports`. No `src/` change, so no bytes question. |
| **2b. Retire the remaining source pins (M15)** | L by volume, mechanical | The rule of section 3 applied to the other pin-dependent files. Real structural rules move into `scripts/compiler-boundaries.json` / `check:import-cycles`. Drop `--moved-reference-contract=preservation-v1` from `check:dead-exports` if it reads the deleted receipts (verify first). | up to 176 test files, 71 `.ts` helpers, 39 `.json` | tests −60,000 to −110,000 lines (file-level upper bound 111,964 plus 34,572 helper lines and 4.4 MB of JSON); src 0 | As 2a. Split by issue family (`3518`, `3519–3529`, others) into separately mergeable parts if the diff is unreviewable; each part deletes whole blocks only. |
| **3. Validator, seeded tests, one driver hook** | M | New `src/ir/program/validate-physical-plan.ts`. New `src/wasm/physical/validate-module.ts`, receiving the ledger's `#validate*` methods (a move). Two new invariants in `assertPreparedIrProgram`, each its own function. The stage 2 call at `program-prepare-ir.ts:143` and the two new driver calls (stages 3 and 4) read PR 1's flag; nine repeat `assertPreparedIrProgram` call sites are deleted (section 2). The strict entry catches invariant errors and reports `prepared validator (<stage>): …` (M14). | the two new files, `src/ir/program/validation.ts`, `src/ir/program-prepare-ir.ts`, `src/compiler/ir-program-driver.ts`, `src/test262/test262-prepared-entry.ts`, `src/wasm/physical/module-reservations.ts`, the 4 files with deleted call sites, `tests/issue-7380-prepared-validator.test.ts` | src +480 / −330 (250 of the +480 are moved lines), tests +400 | The 16 seeds of section 2. Byte identity. **Step 3 of this PR, before the default flips:** run the proving programs, the 411-row test262 sample and the ES5 census list twice, validators on and off, and diff the outcomes. Any program that is refused with them on and compiles with them off is listed in the PR, and gets a named front refusal in this PR. Zero such rows is the condition for "off by default". |
| **4. Refusals move to the admission table** | S–M | New `src/compiler/prepared-admission.ts`: `admittedProviders` (exhaustive over the 16 implementation kinds), the native-slot lookup from the plan, `inCall`. `checkResourceDemand` and `checkAbiExports` call it. `preparedPresentationPolicy` moves there too (it is policy, not census). The census still runs, under the validator flag only, until 5a. | `src/compiler/prepared-admission.ts` (new), `src/compiler/ir-program-presentation.ts` (shrinks; it is over the 1,500-line ceiling, so it must not grow), `src/compiler/prepared-provider-census.ts`, `src/compiler.ts` (import path), `scripts/compiler-boundaries.json`, `tests/issue-7380-prepared-admission.test.ts` | src +130 / −60, tests +200 | Refusal-set identity: the test compiles the proving programs and asserts that table and census agree on every one, including the seven `Math.*` rows (still refused, same text). First-gap tally of the 411-row sample unchanged. Byte identity. |
| **5a. Delete census, receipts and capability tokens (M5, M6)** | M | Delete `prepared-provider-census.ts` (and on perf2 `prepared-formatter-census.ts`, less the admission predicates PR 4 moved). `emitAcceptedIrProgram` returns its plan, binding indices and support rows as a plain frozen record; the two `WeakMap`s and "invalid-transaction-capability" go. The one population join survives as stage 3. | `src/compiler/prepared-*-census.ts`, `src/ir/program-consumer.ts`, `src/ir/program.ts` (types), `src/compiler/ir-program-presentation.ts`; tests: the forgery blocks of `issue-7354-r-provider-census` (113 tests; its 7 accepted programs and 3 refusal probes stay as behaviour tests) and of `issue-7354-str2c-formatter-census` (390 forgeries; the acceptance programs and the 265-number sweep stay) | src −600 (main) to −900 (with perf2 and the realm join), tests −1,500 to −3,500 | Byte identity. Refusal-set identity (now against the fixture's recorded refusal texts from PR 4's run). Seeds 9 to 11. |
| **5b. Delete currentness, owner re-authentication and settled verdicts (M3, M4, M9)** | L; split per resource family if over ~1,500 changed src lines (strings and number format; objects, realm, closures, invocation) | Requirement packs become plain values derived once per compile from the program and passed by parameter (`planNativeStringValuePhysical(program, projection)` instead of a demands object that is then re-derived to check it). `ownerFor` becomes a field read. `settled-verdict.ts` ×2 and the memo in `prepared-allocations.ts` are deleted; the registry is restored once in preparation and passed along. | `src/ir/program/native-*-requirements.ts` (9), `src/backend/wasmgc/program/*.ts`, `src/backend/wasmgc/resources/*.ts` (about 40 files with a `requireCompleted*`), `src/shared/contracts/settled-verdict.ts`, `src/ir/program/settled-verdict.ts`, `src/ir/program/prepared-allocations.ts`; tests: forgery blocks in up to 50 `issue-3518-native-*` files, `issue-7354-perf-string-authentication`, `issue-7354-perf2-settled-checks` | src −1,600 to −2,500, tests −10,000 to −20,000 | Byte identity. Compile-time table of section 6 re-measured. Mutation check on three packs: swap two packs between two programs in a test and show stage 3 or stage 5 refuses. |
| **5c. Delete the layout audit, snapshots and finalization observation (M1, M7)** | L | Delete `#verifyLayout`, `#records`, `#typeRecords`, `#publications`, `#expected`, `audited`, the descriptor capture in `physicalIndices`, `data-snapshot.ts`, `owned-function-data.ts` (`fillOwnedFunction` becomes `fillFunction`). Finalization widens in place; `observeModuleData` / `verifyDataObservation` / `copyModuleData` / the two presentation `WeakMap`s go; the nullability-only rule is one comparison in stage 4. | `src/wasm/physical/module-reservations.ts` (→ about 700 lines), `data-snapshot.ts`, `owned-function-data.ts`, `src/compiler/ir-program-presentation.ts` (→ about 1,150), `src/compiler.ts` (the finalization call), `src/ir/program-consumer.ts`; tests: the blocks asserting an audit refusal text (33 files) and the finalization forgeries (4 files) | src −1,200, tests −8,000 to −16,000 | Byte identity is the main proof here, because finalization changes from "widen a copy" to "widen in place": run it also with `--utf8-storage` and through `compileMulti`. Seeds 12 to 16. Host lane (`gc`) bytes on 100 test262 files, since the ledger is shared with the mixed presentation. |
| **5d. Delete data hygiene (M8)** | M | `hasNativeCollectionState`, the `FrozenMap` / `FrozenSet` brand checks and the per-hand-off `immutableCopy` go; a program is deep-frozen once where it is produced (`freezePreparedIrRuntimeValue`) and passed on by reference. The probes in `copyIrPreparationData` go. `selected()` keeps the kind / version check and drops the accessor / inherited-property checks. The flag leaf of PR 1 loses its last self-audit reader; its only readers are then the three validator calls. | `src/ir/program/data.ts` (322 → about 150), `src/ir/analysis/alloc-registry.ts`, `src/compiler/ir-program-driver.ts`, `src/test262/test262-prepared-entry.ts`; tests: 20 files | src −350, tests −3,000 to −6,000 | Byte identity, Prepared and ordinary (`alloc-registry.ts` is shared). A frozen program still throws `TypeError` on a late write: one test. |
| **6. Exhaustive tables instead of counts** | S | The table changes of section 3. Delete the count and table-hash assertions. | `src/ir/runtime/contracts/intrinsics.ts`, `src/ir/runtime/contracts/manifest.ts`, `src/backend/wasmgc/program/native-primitive-boundary-abi.ts`, a `never` default in the id switches; `tests/issue-3518-core-vocabulary-seam.test.ts`, count rows in `issue-7354-*` | src ±60, tests −200 | Byte identity. Acceptance criterion 2, shown in the PR body: a scratch commit that adds one dummy intrinsic, with its file list and no test edit other than its own. |

Dependencies: 1 and 2a start at once, in parallel. 2b after 2a. 3 after 1. 4 after 3. 5a after 4; 5b, 5c, 5d after 3
and 2b, in any order, but one at a time (they share `native-string-values.ts` and the ledger). 6 any time after 2a.

In-flight branches. The principle: a lane merges main after each PR; where a lane changed a file this series
deletes, it takes the deletion and re-adds only its mechanism lines.

| branch | touches | conflicts with | how it merges |
| --- | --- | --- | --- |
| `claude/7354-perf2` (Str2 + Perf2, about to be a PR) | `data.ts` (the Array shortcut at the top of `hasNativeCollectionState`), census +87, formatter census (new), settled verdicts (new), four requirement files, `native-string-values.ts` | PR 1: one hunk in `data.ts`. PR 4, 5a, 5b: whole files it adds | **Land it before PR 4.** PR 1 can land before or after it (keep both lines in the one hunk). After 5a its formatter census reduces to the admission predicates (`callableCarried`'s scratch arm, `formatterKernelScratch`); `internalNativeBinding` and `nativeSupplementalOrder`, exported only for `derivedFormatterSetup`, lose their `export`. After 5b its `settled-verdict.ts` files and the 12-test file are deleted. Its compile-time gains are subsumed (section 6). |
| `claude/7354-realm`, `-o`, `-fa`, `-fb` | the realm join in the census (+27 to +140), `program-consumer.ts` (+28 to +50), `program-physical-plan.ts` +30, `native-realm.ts` | PR 4 and 5a (census), 5a and 5c (`program-consumer.ts`) | If they merge before PR 4: PR 4 adds the realm row to the admission table (the realm setup's slots, the realm providers) and 5a deletes their join. If after: they take the deletion and add that one row; their census forgery tests are dropped, not ported. In `program-consumer.ts` they keep their reservation and fill lines and drop the receipt lines. PR 1 touches none of their files (`alloc-registry.ts` +12 on fa / fb is a different region); it gives them 14 s → 0.5 s per realm compile the day it lands. |
| `claude/7354-ty-r2` | two ids in three closed lists | PR 6 | after PR 6 it adds the two ids to the id list, the definitions and the role record only |
| `claude/7350-g1`, `claude/7372-globals-registry`, `claude/7354-script-scope` | no mechanism file; each edits a few pin or count tests ("pins updated") | PR 2a, 2b, 6 (modify / delete) | take the deletion |
| `claude/7354-perf3-reservations` (#7365) | a different fix of M1 | PR 1 | close without merging; PR 1 is faster (0.45 s against 3.0 s) and moves no test |

Rule for every lane from the day PR 3 lands: a slice adds no census join, no currentness check, no forged-plan test
and no count or hash pin. It adds its refusals by name, its admission row if it selects a new provider kind, its
behaviour tests ("run as written, then with one wrong answer"), and a seed in `issue-7380-prepared-validator` when
it adds a field to a stage's data. Reviews attack answers and refusals, not certificates.

### 5. Risks

What protection is lost, and what catches the defect instead:

| defect class | caught today by | caught afterwards by | residual |
| --- | --- | --- | --- |
| A pass mutates a planned object after planning (aliasing bug) | deep copies at every hand-off, snapshot compares | the program is deep-frozen once, so the write throws `TypeError` at the writing line | none; the diagnostic is better (it names the writer) |
| A late pass rewrites a filled function body or a reserved type in `WasmModule` storage | layout audit ("altered completed function") | type-wrong: `WebAssembly.validate`, always on. Type-right but different behaviour: the differential and behaviour tests | **This is the real loss.** A type-correct late rewrite of an emitted body reaches a module that validates. Only running the program finds it. The one recorded occurrence was the pipeline's own finalizer (#7354 R), which was intended; no unintended one is on record. Stage 4's "nullability only" rule covers the finalizer in tests and CI |
| A function index shifts because an import is added after definitions | ledger `#importsClosed` (O(1)) | unchanged, stays in production | none |
| A call or global index out of range, a missing fill | `#validateInstructions` at fill and seal | missing fill: ledger O(1) check at `seal()`, stays. Index: stage 4 in CI, `WebAssembly.validate` in production (seed 16) | none for validity |
| A resource pack built for program A is used while compiling program B | owner `WeakMap`s, currentness re-derivation | packs are derived once per compile and passed by parameter, so there is no second program in scope; stage 3 under the flag | a module-level cache keyed by something other than the program object would reintroduce it; the quality criterion forbids such caches |
| A provider is selected and no setup function implements it | census ("joins nothing") | emission cannot resolve the binding and fails by name; stage 3 under the flag | none |
| Two setup functions of one signature are bound to each other's slot | not caught today either (#7354 Str2 round 2, "ruled harmless, kept as a named known-limit test") | behaviour tests | unchanged |
| A provider kind the presentation never planned for becomes selected by a policy change | census, by accident (the seven `Math.*`) | the admission table, exhaustive over the kinds | none, and it is now explicit |
| An unsupported program is refused only because a validator trips | stage 2 running in production | PR 3 step 3 lists every such program before the default changes and gives each a named refusal | programs outside the three measured corpora. In production such a program then meets stage 1 and `WebAssembly.validate`; a type-correct wrong answer would need a front-end gap that produces well-typed, fully declared IR for a construct it does not implement |

What the review rounds on census holes were buying. #7354 R took three rounds, Str three, Str2 two; five of them
were NOT MET on forged setups only. Every forged input came from a `vi.mock` wrapper or a replayed census call; "in
production the plan is one frozen object, so that check is not reachable" (Str round 2). None of the eight wrong
answers or crashes in the #7354 records was found by a census, a receipt or an audit. The one user-visible effect
of the census measured here is the accidental refusal of seven working `Math.*` calls. The rounds bought internal
consistency of a second bookkeeping, not correctness of a module.

Gates the series will trip, and how:

- **`check-loc-budget.mjs`** (file ceiling 1,500; growing a file already over it fails). Over the ceiling today:
  `ir-program-presentation.ts` 1,545, `program-consumer.ts` 1,512, `program-physical-plan.ts` 1,519,
  `program-source.ts` 1,846, `prepared-component-dependencies.ts` 1,793. Every PR here shrinks or leaves them; PR 3
  and PR 4 must put new code in the new modules, not in these files. No `loc-budget-allow` grant is planned. If one
  becomes unavoidable it goes in this issue's frontmatter with a date and reason; `scripts/*-baseline.json` is
  never edited.
- **`check-func-budget.mjs`** (300 lines per function). `assertPreparedIrProgram` is 200 lines and gains two
  invariants: write each as its own function in `validation.ts`. The moved `#validate*` methods are all under 60.
- **`check:dead-exports`**. Each deletion leaves exports whose only readers were deleted tests or checks (for
  example `preparedIrFrozenCollectionMembers`, `internalNativeBinding`, `assertNativeStringValueReservationInput`).
  Remove the export, or the function, in the same PR; run the gate bare before every commit. PR 2 may orphan
  exports that only pin tests read: same rule. Not verified: whether `--moved-reference-contract=preservation-v1`
  reads any receipt PR 2 deletes.
- **`check:import-cycles`** and **`check:compiler-boundaries`**. New modules (`prepared-validation.ts`,
  `prepared-admission.ts`, `validate-physical-plan.ts`, `validate-module.ts`) must be classified in
  `scripts/compiler-boundaries.json` in the PR that adds them, and deleted modules removed from it. The switch leaf
  sits in `src/shared/contracts/` because `src/wasm/physical/` may not import from `src/ir/`. `validate-module.ts`
  must import nothing from `src/ir/` (the ledger does not today). perf2 already holds a grant `backend->ir` 119 → 120;
  5b removes that edge again.
- **`check:oracle-ratchet`, `check-coercion-sites`**: not expected to move; run them anyway.
- **`issue-tests`** (post-merge, known-failures baseline in `loopdive/js2wasm-baselines`). Deleted red files leave
  the baseline by themselves. A test this series leaves in place must not become newly red: after each 5x PR, run
  every remaining test file that imports a touched module (`git grep -l` on the module path), one file at a time.
- **Per-PR `quality`**: every test file a PR modifies must pass in full. This is why a partly-pin file is either
  cleaned to green or deleted, never left half-edited.

### 6. Acceptance: code quality criterion and targets

Code quality criterion (beside the issue's five; it is checked by commands, in the PR body of 5d):

1. `git grep -nE "verifyLayout|assert[A-Za-z]+Current\(|ownerFor\(|checkUnlessSettled|settledAtIssue|hasNativeCollectionState|emittedSupportFunctionReceipts|runtimeCensus|observeModuleData|invalid-transaction-capability" -- src`
   prints nothing outside the host-only mixed presentation and `src/codegen/`.
2. No module of the Prepared family keeps a module-level `WeakMap` / `WeakSet` whose key is a plan, program, pack or
   emission object, and none compares a value with a stored text or snapshot of itself.
3. Each of the four validator modules exports one entry function and holds no state. Stages 3 and 4 are called from
   exactly one place (`runIrProgramDriver`), stage 2 from `program-prepare-ir.ts` and the codec, stage 1 from
   `program-middleend-ir.ts`. The env flag is read in exactly one place (`prepared-validation.ts`).
4. `PhysicalModuleReservations` is at most 750 lines and `ir-program-presentation.ts` is under the 1,500-line
   ceiling without a grant. The series adds no `loc-budget-allow` or `func-budget-allow` entry.
5. Net change over the series: at least −3,000 lines in the Prepared family under `src/`, and no new file over 400
   lines.
6. No test under `tests/` reads a file under `src/` as text, hashes it, or asserts the length of an id list.

Targets. "Today" is measured through the strict entry, standalone, second compile in the process, single runs on a
shared 4-core box (load 1.5 to 2.5), on `claude/7354-perf2` `c693577a9d` unless the row says otherwise. "PR 1" and
"after 5d" are the scratch-switch measurements of section 0 (`layout+probe`, and the four proof switches); the
real PRs must meet the last column.

| program | today | after PR 1 (scratch) | after 5d (scratch, four switches) | target (acceptance) |
| --- | ---: | ---: | ---: | ---: |
| trivial numeric (`var x = 1; x = x + 1; if (x !== 2) throw 1;`) | 0.26 s | 0.09 s | 0.07 s | ≤ 0.1 s |
| 20 dynamic `+` sites in one function | 8.7 to 10.5 s (three runs) | 5.4 s | 2.3 s | ≤ 1.5 s, and linear: 50 sites ≤ 2.5 × 20 sites |
| realm program, one object literal (`claude/7354-o` `e587829733`; perf2 has no realm) | 14.2 s | 0.45 s | 0.35 s | ≤ 0.5 s |
| 20 object literals (`claude/7354-o`) | 16.7 s | 1.12 s | 0.54 s | ≤ 1 s |
| prelude-sized: 200 string lines in one function, 27 KB module | 11.1 to 13.0 s (three runs) | 6.2 s | 2.9 s | < 5 s (criterion 1); stretch ≤ 1.5 s (the ordinary pipeline takes 1.1 s) |
| `String(n)` (number formatter) | 1.7 s | 0.50 s | 0.42 s | ≤ 0.5 s |
| the real harness prelude | not measurable: refused at its first gap (about 0.5 s per the review; not re-measured here) | — | — | re-measure when it first compiles |

The scratch column "after 5d" is above two targets (20 `+` sites, 200 lines) because the switches only skip the
named checks; the deep compares and copies inside mechanism-named functions remain there and are removed by 5b and
5d for real. If the real 5d misses a target, the remaining cost is to be profiled and reported, not hidden behind a
cache.

Not verified in this plan:

- A closure program: none compiled on `claude/7354-perf2` or `claude/7354-o` ("closure must have a return type
  annotation"; with annotations "initializer has no supported carrier"). `claude/7354-fa` was not measured.
- Byte identity under the switches was checked on 14 + 69 programs, not on the 539-program corpus, and not with
  `--utf8-storage` or `compileMulti`.
- No `issue-3518-*` suite was run except `runtime-program-relocation` (298 of 298 red). The pin counts of section 3
  are file-level greps; the red counts are those of #7358.
- Whether any program's refusal depends on a stage 2 check (PR 3 step 3 measures it).
- The behaviour of `check:dead-exports` when tests are deleted, and of its `preservation-v1` contract.
- Timings are single runs on a loaded box; ratios are safe, digits are not.

## PR 1 result

Implemented 2026-11-19 on `claude/7380-validator` (base `71173e020b` = main `89e4748241` + this plan).

What is behind the switch:

- **Switch:** `JS2WASM_VALIDATE_PREPARED`. It is on only when the value is exactly `1`.
- **Where it lives:** `src/shared/contracts/prepared-validation.ts`, a foundation leaf. It exports
  `preparedValidationEnabled()`, plus `setPreparedValidation(on)` for tests.
- **How it is read:** once, at module load, from `globalThis.process?.env`.
  - This is a deviation from the plan, which named `readEnv`. The foundation layer may import only foundation, and
    `src/env.ts` is `mixed-needs-split`.
  - The read is the same expression `readEnv` uses. No other file reads the variable.
- **Defaults:**
  - Off for `compile()` outside tests: the CLI, the API and `scripts/*.mts` runs.
  - On under vitest: `vitest.config.ts` sets `test.env` to `process.env.JS2WASM_VALIDATE_PREPARED ?? "1"`, so
    `JS2WASM_VALIDATE_PREPARED=0` turns it off for a measurement.
  - The test262 vitest lanes inherit it too: `scripts/compiler-pool.ts` forks its workers with `process.env`.
- **Readers (three sites):**
  1. `PhysicalModuleReservations.#verifyLayout` returns at once when the switch is off.
  2. `hasNativeCollectionState` (`src/ir/program/data.ts`) returns `false` when off. Deviation from the plan's
     `instanceof`: both callers pair it with the prototype check (non-array, prototype neither `Object.prototype`
     nor `null`). That check already refuses every genuine collection, with the same message, and an array has no
     collection slot. So `instanceof` would be a branch that never decides anything.
  3. In `copyIrPreparationData` (`src/ir/analysis/alloc-registry.ts`), the Date probe and the collection probe loop
     moved into `hasDateSlot` and `hasCollectionSlot`. When off they answer by `instanceof`, so a genuine Date or
     collection keeps its exact refusal text ("unsupported Date instance" / "unsupported collection prototype").
- **Shared tooling:**
  - `scripts/prepared-byte-identity.mts`.
  - `tests/fixtures/prepared-proving-programs.json`: 804 distinct programs, captured by logging every strict-entry
    call of `tests/issue-7354-*`, `tests/test262-prepared-*` and `tests/issue-7188-*`. It is one JSON row per line
    and listed in `.prettierignore`; it is not `.jsonl`, because `*.jsonl` is gitignored.
  - Not included: the 69 + 14 probe programs of sections 0 and 1, which live in the architect's scratch.
- **Test:** `tests/issue-7380-audit-flag.test.ts`, 7 tests. It checks:
  - the default (unset, `0` and `true` read as off, `1` as on);
  - that the switch is on under vitest;
  - with the switch on, the seeded "altered completed function" of `issue-3518-module-reservations` and the
    erased-prototype `Map` of `issue-3518-native-authentication-performance` are refused; with it off they are not;
  - identical bytes with the switch on and off for a numeric, a string and a dynamic program.

Compile time, through the strict entry. Standalone, second compile in the process, single runs, load about 1.5:

| program | main (`71173e020b`) | switch on | switch off |
| --- | ---: | ---: | ---: |
| trivial numeric `var x = 1; x = x + 1; if (x !== 2) throw 1;` | 0.51 s | 0.47 s | 0.11 s |
| 1 string line in a function (literal + concat + `length` + `===`) | 0.63 s | 0.70 s | 0.11 s |
| 50 string lines in a function | 8.26 s | 8.45 s | 1.46 s |
| 200 string lines in a function | 41.51 s | 40.63 s | 6.80 s |

The binaries are identical in every row (`sha1` `6f62adfb4514`, `f3e00e0ed006`, `6088809e5f5b`, `bb07134afecc`).
The number of times each check is called per compile is the same with the switch on or off; with it off, the calls
return at once.

| program | layout audits | `hasNativeCollectionState` calls | `copyIrPreparationData` slot queries |
| --- | ---: | ---: | ---: |
| numeric | 318 | 13,496 | 828 |
| 1 string line | 382 | 18,330 | 2,084 |
| 50 lines | 1,019 | 392,200 | 71,174 |
| 200 lines | 2,969 | 1,656,100 | 282,674 |

With the switch on, each slot query on an object not seen before throws up to four `TypeError`s. The remaining
6.8 s at 200 lines is not linear yet; PR 3 and 5b to 5d address it.

Byte and outcome proofs:

- **Prepared path**, 804 programs × {main, switch on, switch off}: all three outputs identical, byte for byte.
  - 670 binaries and 132 refusals with the same text.
  - 2 programs throw out of `compile()` already on main, and nothing new throws:
    - row 533: `PreparedIrProgramInvariantError` "… accepted body … failed to lower it: ir/lower: resolver cannot
      lower object<>" (the M14 class);
    - row 787: the entry's own `TypeError`, "duplicate normalized source name".
- **Ordinary pipeline:** 100 test262 files (every 400th of `built-ins` + `language`) × {default target,
  `--target standalone`}, main against switch off, run in two chunks of 50. The output is identical: 176 binaries
  and 24 compile errors with the same text.
- **ES5 sample** of 411 rows (`l420.txt`), run through `tests/test262-chunk-dynamic.test.ts` with
  `TEST262_COMPILER_PATH=ir`, standalone, QuickJS eval engine, with the switch `0` and `1`:
  - per-row results are identical in every field except `workerPid` (397 `compile_error`, 14 `pass`, wall time
    45 s against 46 s);
  - this sample discriminates weakly, because its rows refuse at the prelude before the ledger is used. The
    804-program corpus is the stronger proof that no refusal depends on these checks.

Failing sets with the switch on: 101 files, that is the 89 `tests/issue-3518-*` files that name the ledger, the
snapshots, `program/data` or `alloc-registry`, plus the 12 `tests/issue-7354-*` files. They ran in chunks of 8,
single fork.

- Main fails 835 tests and this branch fails 841. No test that failed on main passes here.
- The 6 new failures are all a source pin, `tests/issue-3518-allocation-runtime-seam.test.ts`.
  - The failing tests are "retains every declaration, …" and the five "rejects changed … in the complete relocation
    receipt".
  - The pin hashes each top-level declaration of `src/ir/analysis/alloc-registry.ts` and expects exactly the
    declaration list `['copyIrPreparationData', …(4)]`. Any edit to the probes in `copyIrPreparationData` breaks
    it; inlining the switch instead of extracting the two helpers would change the body hash all the same.
  - Per this plan, PR 2 retires the pin. It is not re-hashed here. No other pin moved: the edits to `data.ts` and
    `module-reservations.ts` turned no green test red.

Pin retired in this PR (coordinator's decision, 2026-11-19): `tests/issue-3518-allocation-runtime-seam.test.ts`.

- **What was deleted:** "retains every declaration, method, getter, private field, initializer and comment", and
  the five "rejects changed … in the complete relocation receipt". Their only helpers went with them:
  - the declaration and member SHA-256 receipts;
  - `verifyCanonical`, `declarationName` and `sha`.
- **Why:** they hash every top-level declaration of `src/ir/analysis/alloc-registry.ts`, so any edit of that file
  breaks them. #7380 PR 2 retires the remaining pins.
- **Size:** 226 test lines deleted.
- **What is left:** the 18 tests that remain check the registry's behaviour, and all pass. None of the file's tests
  was red on main.

Gates, each run bare: all exit 0.

- `npm run -s typecheck`
- `node scripts/check-loc-budget.mjs`, `node scripts/check-func-budget.mjs`, each also with
  `LOC_GATE_BASE=bd8317fbbc` (then `origin/main`)
- `node scripts/check-coercion-sites.mjs`
- `npm run -s check:oracle-ratchet`, `npm run -s check:dead-exports`, `npm run -s check:import-cycles`
- `node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main`, after classifying the new leaf
  as `foundation`
- `JS2WASM_EVAL_ENGINE=interpreter sh scripts/hooks/changed-root-tests.sh`: 7 of 7 pass

Not verified:

- the realm program and the 20 dynamic `+` sites of section 0: neither compiles on main, they need `claude/7354-o`
  and `claude/7354-perf2`;
- `--utf8-storage` and `compileMulti`, beyond the 16 multi-file programs in the corpus;
- the host (`gc`) lane bytes, beyond the 28 gc-target programs in the corpus;
- the rest of `tests/` outside the 101 files;
- that the `quality` job's full vitest run stays within its time budget. The switch is on there exactly as before,
  so nothing should change.

### Review round 1 (2026-11-20)

Verdict: NOT MET, for the orphaned script and two test gaps. The output claim held on everything the reviewer tried:

- 15 programs with the switch toggled in one process, × 2 targets;
- fresh processes;
- cross-realm, subclassed and Proxy collections in the options;
- 45 ordinary-pipeline files.

Fixed:

- **Orphaned script.** The reviewer added `check:prepared-bytes` to `package.json` (`355b5730f6`). The script and the
  new test now share one reader of the fixture, `tests/helpers/prepared-proving-programs.ts`. The script's output
  is unchanged on all 804 rows.
- **S1, mutation survivors.** `tests/issue-7380-audit-flag.test.ts` now observes each guarded site through what
  it does, on and off:
  - the altered completed function for the layout audit;
  - the erased-prototype `Map` for `hasNativeCollectionState`;
  - an erased-prototype `Date` and `WeakSet` for the two `copyIrPreparationData` probes. A genuine `Date` /
    `WeakSet` keeps its refusal text either way.

  The byte-identity tests now assert `preparedValidationEnabled()` in each leg. Five mutations, each applied alone,
  each fails the file:
  - each of the four guards ignoring the switch (1 test fails each);
  - a no-op `setPreparedValidation` (7 tests fail).
- **S2, the shipped setting.** New `tests/issue-7380-prepared-production-setting.test.ts`:
  - every 2nd program of the fixture (402) with the switch off: no exception, and either a module that
    `WebAssembly.validate` accepts or a refusal;
  - every 67th program (12): the same outcome line with the switch on as off.
  - 21 tests. The test phase takes 69 s: 57 s for the 402, 13 s for the 12. Wall time is 124 s including a cold
    transform.
  - Each program ends with a `setImmediate` turn. A run of strict compiles awaits only settled promises, and
    without the turn vitest's task-update RPC timed out (an "Unhandled Error", exit 1, with every test green).

Not changed, with reasons. All four functions are deleted by later steps of this plan, so reshaping them now is
churn:

- **S3, the name `hasNativeCollectionState`.** Deleted in 5d (data hygiene, M8).
- **S4, the three sites behave differently when off.**
  - The layout audit returns at once, `hasNativeCollectionState` answers `false`, and the two preparation probes
    answer by `instanceof`.
  - The reason is in each comment: each answer is the cheapest one that keeps the site's refusal texts for genuine
    objects.
  - The audit goes in 5c (M1); the other two in 5d.
- **S5, `hasCollectionSlot` duplicates the probe loop of `nativeCollectionBrand`.** The duplication predates this
  PR; PR 1 only named the inline loop. Both go in 5d.
- **S6, brand-cache writes in `immutableCopy` while off.** The cache and `immutableCopy`'s per-hand-off copies go
  in 5d.

Also recorded:

- **Reviewer's finding:** no user program reaches the layout audit's refusals. Every test that expects one forges
  the module, or alters it behind the ledger. This is consistent with section 5, where the "real loss" row is a
  type-correct late rewrite by a compiler module, never a source program.
- **Not verified:** Deno and browser bundles, where the switch is read eagerly from `globalThis.process?.env` at
  module load. Also not verified: an ESM + CJS double load of the leaf, which would give two independent switches.

## PR 2a result

Implemented 2026-11-20 on `claude/7380-pins-a` (base `claude/7380-validator` `c0ab3915bb`). No `src/` change, so no
byte question: the Prepared and ordinary outputs are untouched by construction.

Gist:

- The base has far more red pin tests than #7358 and section 3 listed: **114 of the 287 `tests/issue-3518-*` files
  are red, 4,480 failing tests** (table at the end of this section). Section 3's counts were file-level greps.
- This PR retires the families section 4 assigns to 2a, and with them the whole web that reads the six receipts
  pinning `src/ir/program/data.ts`. That web reaches into `issue-3525`, `issue-4376` and `issue-6866` files; all ten
  of those were red too (measured, below).
- **Retired: 34 test files touched, 3,610 red tests gone.** 30 files deleted, 4 cut down to their behaviour tests,
  which all pass (110 tests, 0 red).
- Deleted: 37,221 lines of test files, 19,447 lines of 20 `.ts` helpers, 31 JSON receipts (54,063 lines,
  2,341,617 bytes), and the 7 historical-source fixtures of `tests/fixtures/issue-3518-c1-historical-authority/`
  (11,301 lines).
- **Exports removed: none.** `check:dead-exports` (with `preservation-v1`) passes unchanged; none of the deleted
  helpers was the only reader of a `src/` export.

How each failing test was classified (brief classes):

- **(i) pin, deleted.** Every red test in the files below failed at a source hash, a length or SHA-256 of a whole
  file, a reconstructed historical file, or a receipt comparison, before asserting any behaviour. Its green
  siblings were the same machinery (forged-receipt and forged-span controls of the pin helpers), so a file with
  nothing else left was deleted whole.
- **(i) inside a behaviour test, assertion cut.** Three red tests mixed a pin into a real check. Only the pin line
  went; the behaviour assertions stay and pass:
  - `issue-3518-program-ownership-runtime-seam` "forwards both admission functions …": the exact export-name lists of
    `program/data.ts`, `program/input.ts` and `program/errors.ts` (closed lists that grow with every export).
  - `issue-3518-native-number-format-requirements` "borrows both primary views … fast path false/true":
    `supportBuffers.toHaveLength(31)`, the instruction-buffer count of the formatter support body (43 today). The
    literal rows, owner and identity checks after it are unchanged and pass.
- **(ii) red for a real reason, kept and untouched:** `issue-3518-native-realm-requirements` "retains the original
  genuine Number/object frontend preparation refusal". It expects preparing `REALM_NO_SOURCE` to throw "runtime
  feature js.number.from-value has no provider", and preparation now succeeds, because that feature gained a
  provider (#7354 D1). It is not a pin: it asserts a refusal that a later slice removed on purpose. Whoever owns the
  realm requirements must decide whether the program is now meant to prepare (then the test changes to assert what
  it prepares) or not. It stays red here and is the only red test left in a #7358 family.
- **(iii) behaviour sharing setup with a pin:** none needed separating beyond the two cuts above. In
  `issue-3518-runtime-data-contract-seam` the 64 passing tests (live old/canonical/barrel identity, the compiled
  type joins, authentication and rollback) did not depend on the receipts; the receipt arrays lost their dead `hash`
  and `types` fields and the file lost the receipt checks and both fixture-capture suites.
- One deleted test was red without being a pin failure: `issue-3518-program-data-contract-seam` "actually compiles
  old/new identities …" timed out (180 s, type-checks a generated file under load). Its name list is the 40-entry
  receipt of the move, so it went with the file. Whether `src/ir/program.ts` still re-exports those types is checked
  by `typecheck` for every real importer.

What each family was:

| family | files | red before | fate |
| --- | --- | ---: | --- |
| runtime-program relocation (`length/SHA256: src/ir/prepared-component-dependencies.ts`) | `runtime-program-relocation` (298/298), `c1-current-source` | 568 | deleted with `ir-runtime-program-relocation.{ts,json}`, `ir-c1-*` |
| core-vocabulary evolution (`complete source SHA256/length mismatch: src/ir/ast-lowering-plans.ts`) | `core-vocabulary-evolution` | 117 | deleted with `ir-core-vocabulary-evolution.{ts,json}` |
| Deno post-position successor profile (`complete raw source profile mismatch`), the policy-evolution chain | `wasmgc-helper-policy-evolution`, `semantic-provider-boundary`, `canonical-3c6/489d-inventory-successor`, `current-main-inventory-successor`, `nested-stackification-`, `number-prerequisite-`, `program-validator-`, `validation-`, `well-known-symbol-policy-evolution`, `program-data-contract-boundary`, `runtime-program-policy-evolution`, the `issue-3525` / `4376` / `6866` successors | 2,476 | deleted; `semantic-provider-boundary` keeps its 5 live "declaration contract is model-only" tests |
| C1 historical authority (`full-file pin changed: tests/issue-3518-program-ownership-runtime-seam.test.ts`) | `program-pre-a-evolution`, `program-data-contract-seam`, `program-initial-graph-evolution`, `program-validator-relocation`, `program-core-type-evolution`, `lowering-analysis-preservation` | 353 | deleted with `ir-c1-historical-authority.ts`, `ir-ownership-evolution.ts`, the `ir-program-*-evolution` helpers and the fixture directory |
| ownership seam | `program-ownership-runtime-seam` | 11 | 9 SHA tests and the import-list test deleted, one test cut; 12 live tests stay |
| runtime data-contract receipts | `runtime-data-contract-seam` | 83 | receipt and fixture-capture tests deleted; 64 live tests stay |
| formatter count, realm refusal | `native-number-format-requirements`, `native-realm-requirements` | 2 + 1 | count line cut (2 tests green again); realm test kept red, class (ii) |

Helpers were deleted by reachability, not by reference count: a helper is dead when no file outside `tests/helpers/`
reaches it. That matters because `ir-runtime-program-policy-evolution.ts`, `ir-c1-historical-authority.ts` and
`ir-c1-current-source.ts` name each other in a cycle. Every deleted name was grepped in `scripts/`, `.github/`,
`package.json`, `vitest.config.ts` and `docs/`: no reader. Only historical logs under `plan/log/` mention them.
`tests/helpers/ir-runtime-contract-evolution.json` records a hash of `tests/issue-3518-runtime-data-contract-seam.test.ts`
as authoring provenance; its test asserts that the file is never read, so the edit cannot turn it red.

Gates, each run bare, all exit 0: `npm run -s typecheck`; `node scripts/check-loc-budget.mjs`,
`node scripts/check-func-budget.mjs`; `npm run -s check:dead-exports`; `npm run -s check:import-cycles`;
`node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main`;
`JS2WASM_EVAL_ENGINE=interpreter sh scripts/hooks/changed-root-tests.sh` (6 changed root files, all pass).
With `LOC_GATE_BASE=origin/main` (`7fe105289d`) both budget gates fail, on `src/ir/module-bindings.ts` (+2) and
`emitNativeParseNumber` (358). This branch does not touch either file: main changed them after this stack's base, so
the diff against main's tip sees main's own change in reverse. They clear when the stack merges main.

What is left for 2b (and why it was not done here):

- **90 `issue-3518-*` files are still red, 1,567 tests** (table below). They are other pin families, not readers of
  the six receipts: the "main port" receipts (`later-main`, `resume-main`, `delivery-main`, `array-main`,
  `typedarray-main`, `promise-export` dependency mismatches; 21 files fail at load), `runtime contract evolution`
  (`historical-runtime-reconstruction` 631/631, `provider-verification-ownership`, `runtime-preparation-relocation`),
  `source-contract-relocation`, `validation-analysis-relocation`, `descriptor adapter`, inline SHA-256 pins of body
  text (`native-string-no-demand-emitter-forward`, `native-object-layouts`, `symbolic-support-ref`, …), and counted
  lists. A minority look like real failures and need a look before deletion, e.g. `ir-math-switch-retirement`
  (standalone `__get_builtin` codegen error), `host-coercion-get-abrupt`, `host-utf8-literal-keys`,
  `ordinary-object-callable-contracts` ("expected function to throw"), `public-retirement-gate`, `string-repeat-ir`,
  and five `STACK_TRACE_ERROR` timeouts under load. Classifying those 1,567 tests one by one is the 2b job; the
  "also seen red" list of #7358 is in it.
- The green pin families of section 3 (M15), as planned.
- `issue-3518-native-realm-requirements` (class ii above).

Not verified:

- The non-`issue-3518` test files outside the ten receipt readers were not run; none of them names a deleted file.
- The `quality` job's full vitest run; the four edited files pass alone.

Remaining red `issue-3518-*` files after this PR (base measurement; none of them was touched):

| file | red / tests | most frequent failure |
| --- | ---: | --- |
| `issue-3518-any-to-string-source-composition` | 6 / 15 | AssertionError: expected [Function] to throw error matching /builder/ but got 'resume-main span missing or dup |
| `issue-3518-argument-vector-source-composition` | 59 / 61 | AssertionError: expected [Function] to throw error matching /span/ but got 'later-main dependency mismatch: sr |
| `issue-3518-array-main-refresh-port` | 0 / 0 | load: array-main dependency missing: src/codegen/apply-closure-variadic-builtin.ts |
| `issue-3518-async-frame-body-source-preservation` | 19 / 47 | AssertionError [ERR_ASSERTION]: exact mapped edit: import { |
| `issue-3518-bench-array-prepared-cutover` | 1 / 5 | AssertionError: expected [ …(13) ] to deeply equal [ …(13) ] |
| `issue-3518-bench-string-prepared-cutover` | 2 / 3 | AssertionError: expected Set{ …(105) } to deeply equal Set{ 'TypeError', …(106) } |
| `issue-3518-bigint-carrier-port` | 26 / 35 | Error: BigInt carrier span order or offset mismatch |
| `issue-3518-builtin-metadata-main-port` | 26 / 28 | Error: builtin-metadata span offset mismatch |
| `issue-3518-capability-schema-boundary` | 1 / 49 | AssertionError: expected { id: 'runtime-contracts', …(5) } to match object { status: 'active', …(4) } |
| `issue-3518-class-to-primitive-presence` | 2 / 24 | Error: resume-main span missing or duplicated: src/codegen/type-coercion.ts:0 |
| `issue-3518-closure-source-composition` | 0 / 0 | load: typedarray-main dependency src/codegen/ta-static-from-of-spec.ts source mismatch |
| `issue-3518-conversion-source-composition` | 16 / 16 | Error: later-main dependency mismatch: src/codegen/builtin-ctor-value-invoke.ts |
| `issue-3518-core-kind-neutrality` | 2 / 53 | AssertionError: expected 83 to be 55 // Object.is equality |
| `issue-3518-core-nodes-boundary` | 29 / 29 | AssertionError: [{"code":"unresolved-module","detail":"src/ir/core/nodes.ts: ../../shared/contracts/ir-unit-in |
| `issue-3518-core-nodes-seam` | 6 / 33 | AssertionError: expected [ …(84) ] to have a length of 83 but got 84 |
| `issue-3518-core-type-boundary` | 15 / 15 | AssertionError: [{"code":"unresolved-module","detail":"src/ir/core/types.ts: ./binding-key-primitives.js"},{"c |
| `issue-3518-core-type-seam` | 5 / 25 | AssertionError: expected [ 'IR_CLASS_SHAPE_CELL', …(10) ] to deeply equal [ Array(10) ] |
| `issue-3518-delay-combinator-layout-ownership` | 12 / 31 | Error: promise-export dependency mismatch: src/codegen/promise-class-receiver-drive.ts |
| `issue-3518-delivery-main-refresh-port` | 0 / 0 | load: delivery-main dependency mismatch: src/codegen/object-proto-has-own-property.ts |
| `issue-3518-descriptor-adapter-relocation` | 0 / 0 | load: descriptor adapter actual helper mismatch |
| `issue-3518-descriptor-undefined-correction` | 9 / 10 | Error: descriptor adapter actual helper mismatch |
| `issue-3518-historical-runtime-reconstruction` | 631 / 631 | Error: runtime contract evolution: complete source SHA256/length mismatch: src/runtime/contracts/provider-poli |
| `issue-3518-host-coercion-get-abrupt` | 10 / 14 | AssertionError: expected undefined to be 99 // Object.is equality |
| `issue-3518-host-utf8-literal-keys` | 16 / 33 | AssertionError: expected 0 to be greater than 0 |
| `issue-3518-ir-math-switch-retirement` | 1 / 7 | AssertionError: Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported  |
| `issue-3518-later-main-preservation-port` | 0 / 0 | load: later-main dependency mismatch: src/codegen/builtin-ctor-value-invoke.ts |
| `issue-3518-lowering-cycle` | 1 / 25 | AssertionError: expected [ …(34) ] to deeply equal [ …(33) ] |
| `issue-3518-native-accessor-call-bodies` | 1 / 40 | AssertionError: expected '34b92c047582bf8987d68df6dd59faf8871b9…' to be '9b618d740d61571e3fb0d69712ca79e54d31d |
| `issue-3518-native-any-to-string-donor` | 0 / 0 | load: resume-main span missing or duplicated: src/codegen/native-strings.ts:0 |
| `issue-3518-native-argument-vector-resources` | 0 / 0 | load: later-main dependency mismatch: src/codegen/builtin-ctor-value-invoke.ts |
| `issue-3518-native-carrier-bag-read-bodies` | 0 / 0 | load: resume-main span offset mismatch: src/codegen/carrier-bag-visibility.ts:0 |
| `issue-3518-native-closure-resources` | 0 / 0 | load: typedarray-main dependency src/codegen/ta-static-from-of-spec.ts source mismatch |
| `issue-3518-native-delay-combinator-body-ownership` | 8 / 33 | AssertionError: expected [ …(11) ] to deeply equal [ …(10) ] |
| `issue-3518-native-delay-combinator-source-preservation` | 89 / 145 | Error: promise-export dependency mismatch: src/codegen/promise-class-receiver-drive.ts |
| `issue-3518-native-family-source-contract` | 8 / 45 | AssertionError: expected 3 to be greater than or equal to 4 |
| `issue-3518-native-family-source-identity` | 2 / 55 | AssertionError: expected [Function lower] to throw an error |
| `issue-3518-native-mixed-object-access` | 3 / 37 | Error: STACK_TRACE_ERROR |
| `issue-3518-native-number-format-ownership` | 2 / 13 | AssertionError: expected '// Copyright (c) 2026 Loopdive GmbH. …' to be '// Copyright (c) 2026 Loopdive GmbH.  |
| `issue-3518-native-object-descriptor-resources` | 1 / 75 |  |
| `issue-3518-native-object-get-bodies` | 55 / 91 | Error: resume-main span offset mismatch: src/codegen/instance-props.ts:0 |
| `issue-3518-native-object-key-foundation` | 1 / 28 | Error: later-main dependency mismatch: src/codegen/builtin-ctor-value-invoke.ts |
| `issue-3518-native-object-layouts` | 2 / 52 | AssertionError: expected 'b7944c4cbf8407f2b73458e4d694fbbf1038d…' to be 'e4d546ab2007a44fe45d5bcda8453e190aaaa |
| `issue-3518-native-object-storage-resources` | 14 / 51 | Error: descriptor adapter actual helper mismatch |
| `issue-3518-native-object-write-composition` | 0 / 0 | load: later-main dependency mismatch: src/codegen/builtin-ctor-value-invoke.ts |
| `issue-3518-native-prototype-seeder-bindings` | 1 / 49 |  |
| `issue-3518-native-realm-requirements` | 1 / 26 | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-realm-wrapper-storage` | 0 / 24 | suite hook failure |
| `issue-3518-native-string-no-demand-emitter-forward` | 8 / 8 | AssertionError: expected '4c95384bd705460f7208b040a84a9146d3022…' to be 'a23bbcb037bf8bb0fd2b22bc4c85a86d43e87 |
| `issue-3518-native-string-number-resources` | 35 / 123 | Error: missing/duplicate mapped source: /** |
| `issue-3518-native-string-output-preservation` | 24 / 24 | Error: resume-main span missing or duplicated: src/codegen/native-strings.ts:0 |
| `issue-3518-native-symbol-carrier-resources` | 0 / 0 | load: resume-main span offset mismatch: src/codegen/symbol-native.ts:1 |
| `issue-3518-native-value-resources` | 61 / 118 | Error: resume-main span missing or duplicated: src/codegen/any-helpers.ts:0 |
| `issue-3518-native-vector-resources` | 4 / 31 | AssertionError: expected 'wasmgc:standalone physical setup cann…' to contain 'scheduler/promise runtime materi |
| `issue-3518-number-format-source-support` | 1 / 10 | AssertionError: expected 2226 to be 1618 // Object.is equality |
| `issue-3518-object-runtime-main-composition` | 0 / 0 | load: later-main dependency mismatch: src/codegen/builtin-ctor-value-invoke.ts |
| `issue-3518-open-extension-boundaries` | 1 / 66 | AssertionError: expected [ …(2) ] to deeply equal [ …(2) ] |
| `issue-3518-ordinary-getter-source` | 1 / 8 | AssertionError: expected function to throw an error, but it didn't |
| `issue-3518-ordinary-object-callable-contracts` | 8 / 23 | AssertionError: expected function to throw an error, but it didn't |
| `issue-3518-ordinary-object-runtime-providers` | 2 / 117 | Error: STACK_TRACE_ERROR |
| `issue-3518-own-property-bodies` | 0 / 0 | load: array-main dependency missing: src/codegen/apply-closure-variadic-builtin.ts |
| `issue-3518-program-abi-seam` | 1 / 9 | Error: STACK_TRACE_ERROR |
| `issue-3518-promise-earlier-main-port` | 0 / 0 | load: earlier-promise dependency mismatch: src/codegen/builtin-static-globals.ts |
| `issue-3518-promise-export-main-port` | 0 / 0 | load: promise-export dependency mismatch: src/codegen/promise-class-receiver-drive.ts |
| `issue-3518-promise-resolution-preservation` | 3 / 58 | AssertionError: expected { …(4) } to deeply equal { funcs: [], calls: [], …(2) } |
| `issue-3518-promise-settlement-body-ownership` | 9 / 149 | AssertionError: expected { …(4) } to deeply equal { funcs: [], calls: [], …(2) } |
| `issue-3518-prototype-chain-preservation` | 0 / 0 | load: prototype chain builder mismatch |
| `issue-3518-prototype-companion-body` | 0 / 0 | load: prototype receiver builder mismatch |
| `issue-3518-prototype-read-recipes` | 0 / 0 | load: prototype receiver builder mismatch |
| `issue-3518-prototype-receiver-bodies` | 0 / 0 | load: prototype receiver builder mismatch |
| `issue-3518-prototype-seeder-bodies` | 2 / 53 | Error: prototype seeder extraction dependency mismatch: src/runtime/wasmgc/values/prototype-seeder-bodies.ts |
| `issue-3518-prototype-seeder-extraction` | 0 / 0 | load: prototype seeder extraction dependency mismatch: src/runtime/wasmgc/values/prototype-seeder-bodies.ts |
| `issue-3518-prototype-singleton-bodies` | 0 / 0 | load: prototype seeder extraction dependency mismatch: src/runtime/wasmgc/values/prototype-seeder-bodies.ts |
| `issue-3518-provider-verification-ownership` | 25 / 57 | Error: runtime contract evolution: complete source SHA256/length mismatch: src/runtime/contracts/provider-poli |
| `issue-3518-public-retirement-gate` | 1 / 16 | AssertionError: expected 'accepted' to be 'unsupported' // Object.is equality |
| `issue-3518-reference-error-runtime-producers` | 1 / 28 | AssertionError: expected [ …(25) ] to include 'file:///home/user/js2/.claude/worktre…' |
| `issue-3518-resume-main-composition` | 131 / 143 | Error: typedarray-main dependency src/codegen/ta-static-from-of-spec.ts source mismatch |
| `issue-3518-runtime-contract-evolution` | 0 / 380 | suite hook failure |
| `issue-3518-runtime-preparation-relocation` | 3 / 121 | Error: runtime contract evolution: complete source SHA256/length mismatch: src/runtime/contracts/provider-poli |
| `issue-3518-runtime-producers-import-boundaries` | 1 / 3 | AssertionError:  |
| `issue-3518-semantic-provider-source-acceptance` | 1 / 87 | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-3518-source-contract-relocation` | 53 / 65 | Error: source contract relocation: complete source SHA256/length mismatch: src/ir/ast-lowering-plans.ts |
| `issue-3518-startup-contract` | 1 / 25 | AssertionError: expected [] to have a length of 1 but got +0 |
| `issue-3518-string-repeat-ir` | 2 / 12 | Error: prepared string.repeat has no exact env.string_repeat import |
| `issue-3518-symbolic-support-ref` | 6 / 20 | AssertionError: expected '32421c36a56ab3483c3838e7465524cd767ae…' to be '9324caf316c596019beab1007c7e602263ae2 |
| `issue-3518-to-primitive-wrapper-forward` | 11 / 87 | Error: changed extracted presence module |
| `issue-3518-typed-async-preparation` | 3 / 26 | AssertionError: expected [ …(20) ] to have a length of 18 but got 20 |
| `issue-3518-typed-program-preparation` | 2 / 30 | AssertionError: expected undefined to be Error: omitted explicit verification opti… // Object.is equality |
| `issue-3518-typedarray-main-preservation-port` | 0 / 0 | load: typedarray-main dependency src/codegen/ta-static-from-of-spec.ts source mismatch |
| `issue-3518-validation-analysis-relocation` | 80 / 116 | Error: allocation rule sharing successor: complete source pin current src/ir/analysis/encoding.ts |
| `issue-3518-vector-grow-store-donor` | 3 / 67 | AssertionError: expected '655dac953ce3a5088564a78e124a2bf2a2264…' to be '5babe5828bd5a54964630abba6a1eafdb1a6a |
| **90 files** | **1567** | |

Per touched file, before and after (tests / red; `after` measured on this branch):

| file | before: tests / red | after: tests / red |
| --- | ---: | ---: |
| `issue-3518-c1-current-source` | 355 / 270 | deleted |
| `issue-3518-canonical-3c6-inventory-successor` | 235 / 175 | deleted |
| `issue-3518-canonical-489d-inventory-successor` | 65 / 62 | deleted |
| `issue-3518-core-vocabulary-evolution` | 132 / 117 | deleted |
| `issue-3518-current-main-inventory-successor` | 142 / 86 | deleted |
| `issue-3518-lowering-analysis-preservation` | 57 / 55 | deleted |
| `issue-3518-native-number-format-requirements` | 29 / 2 | 29 / 0 |
| `issue-3518-nested-stackification-policy-evolution` | 53 / 53 | deleted |
| `issue-3518-number-prerequisite-policy-evolution` | 456 / 456 | deleted |
| `issue-3518-program-core-type-evolution` | 49 / 46 | deleted |
| `issue-3518-program-data-contract-boundary` | 105 / 104 | deleted |
| `issue-3518-program-data-contract-seam` | 47 / 46 | deleted |
| `issue-3518-program-initial-graph-evolution` | 129 / 123 | deleted |
| `issue-3518-program-ownership-runtime-seam` | 22 / 11 | 12 / 0 |
| `issue-3518-program-pre-a-evolution` | 76 / 74 | deleted |
| `issue-3518-program-validator-policy-evolution` | 143 / 143 | deleted |
| `issue-3518-program-validator-relocation` | 62 / 9 | deleted |
| `issue-3518-runtime-data-contract-seam` | 147 / 83 | 64 / 0 |
| `issue-3518-runtime-program-policy-evolution` | 0 / 0 (load error) | deleted |
| `issue-3518-runtime-program-relocation` | 298 / 298 | deleted |
| `issue-3518-semantic-provider-boundary` | 354 / 349 | 5 / 0 |
| `issue-3518-validation-policy-evolution` | 63 / 63 | deleted |
| `issue-3518-wasmgc-helper-policy-evolution` | 135 / 134 | deleted |
| `issue-3518-well-known-symbol-policy-evolution` | 154 / 154 | deleted |
| `issue-3525-arraybuffer-isview-main-policy` | 56 / 56 | deleted |
| `issue-3525-initial-graph-optional-fields-source` | 20 / 5 | deleted |
| `issue-3525-main-inventory-source-successor` | 21 / 21 | deleted |
| `issue-3525-presentation-classification-policy` | 45 / 45 | deleted |
| `issue-4376-class-fields-main-inventory-successor` | 32 / 32 | deleted |
| `issue-4376-deno-callback-inventory-successor` | 32 / 32 | deleted |
| `issue-4376-post-position-main-inventory-successor` | 416 / 416 | deleted |
| `issue-6866-class-fields-main-inventory-successor` | 31 / 30 | deleted |
| `issue-6866-finally-main-inventory-successor` | 39 / 38 | deleted |
| `issue-6866-source-map-position-inventory-successor` | 23 / 22 | deleted |
| **total (34 files)** | **4023 / 3610** | **110 / 0** |


### Review (2026-11-20): MET, and what the deletion dropped that was not a pin

A fresh-context reviewer classified all 30 deleted test files and the 58 helpers, receipts and fixtures: no deleted test
calls the compiler or runs a program, the four trimmed files lost only pin code, and nothing outside `plan/` names a
deleted file. Three things went with the pins that were not pins. All were red at the base and could not be kept as
written, because their fixtures are built from the pinned predecessor chain. They are owed again, as ordinary tests:

- Type-level negative controls (`issue-3518-program-data-contract-seam`, "actually compiles old/new identities"): a raw
  string or an `IrSourceId` is not assignable to `IrUnitId`, `TypedIrProgramGlobal.binding` is readonly, `IrGvnMode`
  rejects "auto", the failure-stage union, `Core.IrFunction` has no `asyncRuntime`. Re-home as a small
  `@ts-expect-error` file; `typecheck` alone does not notice a brand that gets loosened. Step 6 of this plan.
- Layer-specific boundary mutations (`semantic-provider-boundary`, `program-data-contract-boundary`): "rejects an upward
  runtime dependency from the native string/value aggregate", "rejects a backend implementation dependency from the
  frontend formatter contract". The generic import-syntax cases remain in `issue-3518-compiler-boundaries.test.ts`; the
  layer-specific ones belong in the compiler-boundaries inventory (`scripts/compiler-boundaries.json`) as rules. Step 6.
- Two negative checks of the ownership-seam test: `src/ir/program/data.ts` contains neither
  `EMISSION_TRANSACTION_CAPABILITY` nor `assertPreparedIrProgram`, and the moved files do not read `process.env`. The
  first becomes moot when step 5 deletes both names; the second is a boundaries rule. Step 6.

The before-table below was measured on `c0ab3915bb`; the base moved to `d24132a05c` afterwards without touching any of
those files.

### Before: every `tests/issue-3518-*.test.ts` on the base (287 files, 14,349 tests, 4,480 red, 114 red files), plus the ten `issue-3525` / `4376` / `6866` receipt readers

Measured 2026-11-20 on `c0ab3915bb` (`1002538b5f` for the first 68 files; the two commits between touch only
`package.json` and `tests/issue-7380-audit-flag.test.ts`). One file per vitest run, `VITEST_MAX_FORKS=1`,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, `JS2WASM_VALIDATE_PREPARED=1` as `vitest.config.ts` sets it. "failed suites"
counts the file's suite plus each failed `describe`; a row with 0 tests and a failed suite failed at load time.

<!-- before-table:begin -->

| file (`tests/<name>.test.ts`) | tests | failed | failed suites |
| --- | ---: | ---: | ---: |
| `issue-3518-allocation-runtime-seam` | 18 | 0 | 0 |
| `issue-3518-any-to-string-source-composition` | 15 | 6 | 2 |
| `issue-3518-argument-vector-source-composition` | 61 | 59 | 2 |
| `issue-3518-array-main-refresh-port` | 0 | 0 | 1 |
| `issue-3518-async-frame-body-ownership` | 25 | 0 | 0 |
| `issue-3518-async-frame-body-source-preservation` | 47 | 19 | 3 |
| `issue-3518-bench-array-prepared-cutover` | 5 | 1 | 2 |
| `issue-3518-bench-string-prepared-cutover` | 3 | 2 | 2 |
| `issue-3518-bench-string-runtime-driver` | 6 | 0 | 0 |
| `issue-3518-bigint-carrier-port` | 35 | 26 | 3 |
| `issue-3518-bigint-finalized-layout` | 10 | 0 | 0 |
| `issue-3518-bigint-to-number-body` | 201 | 0 | 0 |
| `issue-3518-boolean-return-boundary` | 30 | 0 | 0 |
| `issue-3518-builtin-metadata-main-port` | 28 | 26 | 2 |
| `issue-3518-builtin-request-literal-authentication` | 24 | 0 | 0 |
| `issue-3518-c1-current-source` | 355 | 270 | 10 |
| `issue-3518-canonical-3c6-inventory-successor` | 235 | 175 | 2 |
| `issue-3518-canonical-489d-inventory-successor` | 65 | 62 | 3 |
| `issue-3518-canonical-instruction-walk` | 32 | 0 | 0 |
| `issue-3518-capability-schema-boundary` | 49 | 1 | 2 |
| `issue-3518-capability-schema-seam` | 27 | 0 | 0 |
| `issue-3518-certified-delay-source-admission` | 41 | 0 | 0 |
| `issue-3518-certified-delay-source-identity` | 45 | 0 | 0 |
| `issue-3518-checked-delay-combinator-reservations` | 6 | 0 | 0 |
| `issue-3518-class-to-primitive-presence` | 24 | 2 | 1 |
| `issue-3518-closure-coordinate-audits` | 7 | 0 | 0 |
| `issue-3518-closure-parameter-projections` | 7 | 0 | 0 |
| `issue-3518-closure-source-composition` | 0 | 0 | 1 |
| `issue-3518-closure-state-preservation-port` | 71 | 0 | 0 |
| `issue-3518-compiler-boundaries` | 125 | 0 | 0 |
| `issue-3518-conversion-source-composition` | 16 | 16 | 2 |
| `issue-3518-core-kind-neutrality` | 53 | 2 | 2 |
| `issue-3518-core-node-execution-child-admission` | 11 | 0 | 0 |
| `issue-3518-core-node-execution-gate` | 28 | 0 | 0 |
| `issue-3518-core-node-execution` | 43 | 0 | 0 |
| `issue-3518-core-nodes-boundary` | 29 | 29 | 2 |
| `issue-3518-core-nodes-dialect` | 24 | 0 | 0 |
| `issue-3518-core-nodes-seam` | 33 | 6 | 2 |
| `issue-3518-core-type-boundary` | 15 | 15 | 2 |
| `issue-3518-core-type-reachability` | 29 | 0 | 0 |
| `issue-3518-core-type-seam` | 25 | 5 | 2 |
| `issue-3518-core-vocabulary-evolution` | 132 | 117 | 2 |
| `issue-3518-core-vocabulary-seam` | 21 | 0 | 0 |
| `issue-3518-counted-string-cutover` | 6 | 0 | 0 |
| `issue-3518-current-main-inventory-successor` | 142 | 86 | 3 |
| `issue-3518-delay-combinator-layout-ownership` | 31 | 12 | 3 |
| `issue-3518-delivery-main-refresh-port` | 0 | 0 | 1 |
| `issue-3518-descriptor-adapter-relocation` | 0 | 0 | 1 |
| `issue-3518-descriptor-undefined-correction` | 10 | 9 | 2 |
| `issue-3518-descriptor-wide-bigint` | 11 | 0 | 0 |
| `issue-3518-explicit-rec-emission` | 29 | 0 | 0 |
| `issue-3518-extensible-self-root` | 81 | 0 | 0 |
| `issue-3518-final-parent-reservations` | 42 | 0 | 0 |
| `issue-3518-function-prototype-invoker-bodies` | 245 | 0 | 0 |
| `issue-3518-historical-runtime-reconstruction` | 631 | 631 | 4 |
| `issue-3518-host-async-imports` | 27 | 0 | 0 |
| `issue-3518-host-coercion-get-abrupt` | 14 | 10 | 3 |
| `issue-3518-host-utf8-literal-keys` | 33 | 16 | 2 |
| `issue-3518-identity-foundation-boundary` | 5 | 0 | 0 |
| `issue-3518-inline-call-allocation` | 2 | 0 | 0 |
| `issue-3518-ir-adoption-contract` | 5 | 0 | 0 |
| `issue-3518-ir-math-switch-retirement` | 7 | 1 | 2 |
| `issue-3518-js-value-tag-contract` | 9 | 0 | 0 |
| `issue-3518-later-main-preservation-port` | 0 | 0 | 1 |
| `issue-3518-linear-counted-string-reservation` | 6 | 0 | 0 |
| `issue-3518-logical-vector-lowering` | 25 | 0 | 0 |
| `issue-3518-lowering-analysis-owner` | 28 | 0 | 0 |
| `issue-3518-lowering-analysis-preservation` | 57 | 55 | 4 |
| `issue-3518-lowering-contract-owner` | 27 | 0 | 0 |
| `issue-3518-lowering-cycle` | 25 | 1 | 2 |
| `issue-3518-lowering-relocation-coverage` | 28 | 0 | 0 |
| `issue-3518-module-reservations` | 149 | 0 | 0 |
| `issue-3518-moved-runtime-reachability` | 39 | 0 | 0 |
| `issue-3518-multi-prepared-string-leaf-planner` | 71 | 0 | 0 |
| `issue-3518-native-accessor-call-bodies` | 40 | 1 | 2 |
| `issue-3518-native-add-default-hint` | 43 | 0 | 0 |
| `issue-3518-native-any-to-string-donor` | 0 | 0 | 1 |
| `issue-3518-native-any-to-string` | 15 | 0 | 0 |
| `issue-3518-native-argument-vector-resources` | 0 | 0 | 1 |
| `issue-3518-native-async-resource-declarations` | 29 | 0 | 0 |
| `issue-3518-native-authentication-performance` | 50 | 0 | 0 |
| `issue-3518-native-bigint-number-owner` | 82 | 0 | 0 |
| `issue-3518-native-bigint-primitive-bodies` | 20 | 0 | 0 |
| `issue-3518-native-bigint-resources` | 41 | 0 | 0 |
| `issue-3518-native-boolean-bodies` | 10 | 0 | 0 |
| `issue-3518-native-boolean-boundary-contracts` | 16 | 0 | 0 |
| `issue-3518-native-boolean-boxes` | 31 | 0 | 0 |
| `issue-3518-native-boolean-consumer` | 12 | 0 | 0 |
| `issue-3518-native-boolean-resources` | 12 | 0 | 0 |
| `issue-3518-native-builtin-functions` | 36 | 0 | 0 |
| `issue-3518-native-carrier-bag-read-bodies` | 0 | 0 | 1 |
| `issue-3518-native-clock-projection` | 37 | 0 | 0 |
| `issue-3518-native-closure-resources` | 0 | 0 | 1 |
| `issue-3518-native-closure-staged-reservations` | 20 | 0 | 0 |
| `issue-3518-native-delay-combinator-body-ownership` | 33 | 8 | 2 |
| `issue-3518-native-delay-combinator-resources` | 16 | 0 | 0 |
| `issue-3518-native-delay-combinator-source-preservation` | 145 | 89 | 4 |
| `issue-3518-native-family-callable-declarations` | 25 | 0 | 0 |
| `issue-3518-native-family-callable-providers` | 46 | 0 | 0 |
| `issue-3518-native-family-callable-replay` | 12 | 0 | 0 |
| `issue-3518-native-family-source-contract` | 45 | 8 | 2 |
| `issue-3518-native-family-source-identity` | 55 | 2 | 2 |
| `issue-3518-native-getter-invocation` | 42 | 0 | 0 |
| `issue-3518-native-getter-resource-join` | 15 | 0 | 0 |
| `issue-3518-native-getter-results` | 21 | 0 | 0 |
| `issue-3518-native-invocation-consumer` | 61 | 0 | 0 |
| `issue-3518-native-invocation-substrate` | 45 | 0 | 0 |
| `issue-3518-native-mixed-object-access` | 37 | 3 | 2 |
| `issue-3518-native-number-format-ownership` | 13 | 2 | 3 |
| `issue-3518-native-number-format-requirements` | 29 | 2 | 2 |
| `issue-3518-native-number-format-resources` | 22 | 0 | 0 |
| `issue-3518-native-number-primitive-classifier` | 192 | 0 | 0 |
| `issue-3518-native-object-access-resources` | 35 | 0 | 0 |
| `issue-3518-native-object-descriptor-resources` | 75 | 1 | 2 |
| `issue-3518-native-object-get-bodies` | 91 | 55 | 4 |
| `issue-3518-native-object-get-owner` | 66 | 0 | 0 |
| `issue-3518-native-object-key-foundation` | 28 | 1 | 1 |
| `issue-3518-native-object-layouts` | 52 | 2 | 1 |
| `issue-3518-native-object-realm-declarations` | 26 | 0 | 0 |
| `issue-3518-native-object-storage-resources` | 51 | 14 | 2 |
| `issue-3518-native-object-write-composition` | 0 | 0 | 1 |
| `issue-3518-native-primitive-wrapper-layouts` | 71 | 0 | 0 |
| `issue-3518-native-primitive-wrapper-storage` | 178 | 0 | 0 |
| `issue-3518-native-promise-inventory-emission` | 5 | 0 | 0 |
| `issue-3518-native-promise-inventory-planning` | 12 | 0 | 0 |
| `issue-3518-native-promise-inventory` | 28 | 0 | 0 |
| `issue-3518-native-promise-resources` | 49 | 0 | 0 |
| `issue-3518-native-prototype-layouts` | 17 | 0 | 0 |
| `issue-3518-native-prototype-requirements` | 16 | 0 | 0 |
| `issue-3518-native-prototype-seeder-bindings` | 49 | 1 | 2 |
| `issue-3518-native-realm-object-layouts` | 32 | 0 | 0 |
| `issue-3518-native-realm-requirements` | 26 | 1 | 2 |
| `issue-3518-native-realm-source-integration` | 24 | 0 | 0 |
| `issue-3518-native-realm-wrapper-storage` | 24 | 0 | 3 |
| `issue-3518-native-ref-cell-consumer` | 5 | 0 | 0 |
| `issue-3518-native-ref-cell-resources` | 31 | 0 | 0 |
| `issue-3518-native-resource-declarations` | 22 | 0 | 0 |
| `issue-3518-native-ryu-ownership` | 24 | 0 | 0 |
| `issue-3518-native-ryu-resources` | 15 | 0 | 0 |
| `issue-3518-native-scanner-source-preservation` | 81 | 0 | 0 |
| `issue-3518-native-scanner-value-chain` | 11 | 0 | 0 |
| `issue-3518-native-source-callable-contract` | 10 | 0 | 0 |
| `issue-3518-native-source-closure-consumer` | 5 | 0 | 0 |
| `issue-3518-native-source-closure-requirements` | 28 | 0 | 0 |
| `issue-3518-native-string-completion` | 5 | 0 | 0 |
| `issue-3518-native-string-create` | 90 | 0 | 0 |
| `issue-3518-native-string-define-own` | 473 | 0 | 0 |
| `issue-3518-native-string-equality-donor` | 5 | 0 | 0 |
| `issue-3518-native-string-equality` | 38 | 0 | 0 |
| `issue-3518-native-string-error-resources` | 29 | 0 | 0 |
| `issue-3518-native-string-flatten-resources` | 61 | 0 | 0 |
| `issue-3518-native-string-no-demand-emitter-forward` | 8 | 8 | 1 |
| `issue-3518-native-string-number-resources` | 123 | 35 | 3 |
| `issue-3518-native-string-number-source-admission` | 36 | 0 | 0 |
| `issue-3518-native-string-output-abi-join` | 28 | 0 | 0 |
| `issue-3518-native-string-output-bodies` | 60 | 0 | 0 |
| `issue-3518-native-string-output-consumer` | 24 | 0 | 0 |
| `issue-3518-native-string-output-preservation` | 24 | 24 | 2 |
| `issue-3518-native-string-output-requirements` | 36 | 0 | 0 |
| `issue-3518-native-string-output-resources` | 156 | 0 | 0 |
| `issue-3518-native-string-own-keys` | 112 | 0 | 0 |
| `issue-3518-native-string-types-split` | 20 | 0 | 0 |
| `issue-3518-native-string-utf8-rope` | 75 | 0 | 0 |
| `issue-3518-native-string-value-abi-planning` | 61 | 0 | 0 |
| `issue-3518-native-string-value-consumer-execution` | 68 | 0 | 0 |
| `issue-3518-native-string-value-demands` | 40 | 0 | 0 |
| `issue-3518-native-string-value-materialization` | 15 | 0 | 0 |
| `issue-3518-native-string-value-planning` | 7 | 0 | 0 |
| `issue-3518-native-symbol-carrier-resources` | 0 | 0 | 1 |
| `issue-3518-native-to-primitive-bodies` | 46 | 0 | 0 |
| `issue-3518-native-utf8-window-decoder` | 27 | 0 | 0 |
| `issue-3518-native-value-boundary` | 10 | 0 | 0 |
| `issue-3518-native-value-plan-source-join` | 4 | 0 | 0 |
| `issue-3518-native-value-resources` | 118 | 61 | 7 |
| `issue-3518-native-vector-resources` | 31 | 4 | 2 |
| `issue-3518-native-wasm-foundation` | 6 | 0 | 0 |
| `issue-3518-native-well-known-symbols` | 114 | 0 | 0 |
| `issue-3518-nested-stackification-owner` | 21 | 0 | 0 |
| `issue-3518-nested-stackification-policy-evolution` | 53 | 53 | 2 |
| `issue-3518-number-format-source-support` | 10 | 1 | 2 |
| `issue-3518-number-from-value-body` | 252 | 0 | 0 |
| `issue-3518-number-prerequisite-policy-evolution` | 456 | 456 | 6 |
| `issue-3518-number-source-plan` | 18 | 0 | 0 |
| `issue-3518-object-create-null-source-admission` | 65 | 0 | 0 |
| `issue-3518-object-realm-algorithm-bodies` | 214 | 0 | 0 |
| `issue-3518-object-runtime-main-composition` | 0 | 0 | 1 |
| `issue-3518-open-extension-boundaries` | 66 | 1 | 2 |
| `issue-3518-ordinary-descriptor-capture` | 7 | 0 | 0 |
| `issue-3518-ordinary-getter-source` | 8 | 1 | 2 |
| `issue-3518-ordinary-object-access-source-plan` | 12 | 0 | 0 |
| `issue-3518-ordinary-object-callable-contracts` | 23 | 8 | 2 |
| `issue-3518-ordinary-object-closure-signatures` | 15 | 0 | 0 |
| `issue-3518-ordinary-object-runtime-providers` | 117 | 2 | 2 |
| `issue-3518-own-property-bodies` | 0 | 0 | 1 |
| `issue-3518-own-property-execution` | 7 | 0 | 0 |
| `issue-3518-physical-snapshot-comparison` | 49 | 0 | 0 |
| `issue-3518-physical-type-layout` | 25 | 0 | 0 |
| `issue-3518-preparation-allocation-replay` | 29 | 0 | 0 |
| `issue-3518-prepared-async-frame-plan` | 27 | 0 | 0 |
| `issue-3518-prepared-native-main-lowering` | 14 | 0 | 0 |
| `issue-3518-primitive-wrapper-bodies` | 185 | 0 | 0 |
| `issue-3518-program-abi-seam-boundary` | 11 | 0 | 0 |
| `issue-3518-program-abi-seam` | 9 | 1 | 2 |
| `issue-3518-program-codec-replay` | 27 | 0 | 0 |
| `issue-3518-program-core-type-evolution` | 49 | 46 | 3 |
| `issue-3518-program-data-contract-boundary` | 105 | 104 | 3 |
| `issue-3518-program-data-contract-replay` | 8 | 0 | 0 |
| `issue-3518-program-data-contract-seam` | 47 | 46 | 2 |
| `issue-3518-program-initial-graph-evolution` | 129 | 123 | 2 |
| `issue-3518-program-module-completion` | 9 | 0 | 0 |
| `issue-3518-program-ownership-runtime-seam` | 22 | 11 | 2 |
| `issue-3518-program-pre-a-evolution` | 76 | 74 | 2 |
| `issue-3518-program-validator-owner` | 13 | 0 | 0 |
| `issue-3518-program-validator-policy-evolution` | 143 | 143 | 2 |
| `issue-3518-program-validator-relocation` | 62 | 9 | 3 |
| `issue-3518-promise-earlier-main-port` | 0 | 0 | 1 |
| `issue-3518-promise-export-main-port` | 0 | 0 | 1 |
| `issue-3518-promise-getter-capture` | 14 | 0 | 0 |
| `issue-3518-promise-resolution-preservation` | 58 | 3 | 3 |
| `issue-3518-promise-settlement-body-ownership` | 149 | 9 | 2 |
| `issue-3518-promise-settlement-source-preservation` | 19 | 0 | 0 |
| `issue-3518-prototype-brand-contract` | 2 | 0 | 0 |
| `issue-3518-prototype-chain-execution` | 6 | 0 | 0 |
| `issue-3518-prototype-chain-preservation` | 0 | 0 | 1 |
| `issue-3518-prototype-companion-body` | 0 | 0 | 1 |
| `issue-3518-prototype-read-recipes` | 0 | 0 | 1 |
| `issue-3518-prototype-receiver-bodies` | 0 | 0 | 1 |
| `issue-3518-prototype-seeder-bodies` | 53 | 2 | 3 |
| `issue-3518-prototype-seeder-extraction` | 0 | 0 | 1 |
| `issue-3518-prototype-singleton-bodies` | 0 | 0 | 1 |
| `issue-3518-prototype-singleton-execution` | 3 | 0 | 0 |
| `issue-3518-provider-verification-ownership` | 57 | 25 | 3 |
| `issue-3518-public-retirement-gate` | 16 | 1 | 2 |
| `issue-3518-reference-error-runtime-producers` | 28 | 1 | 1 |
| `issue-3518-reservation-completion-assertion` | 15 | 0 | 0 |
| `issue-3518-resume-main-composition` | 143 | 131 | 2 |
| `issue-3518-root-finality-fingerprint` | 124 | 0 | 0 |
| `issue-3518-runtime-contract-evolution` | 380 | 0 | 1 |
| `issue-3518-runtime-data-contract-seam` | 147 | 83 | 4 |
| `issue-3518-runtime-demand-abi-owner` | 13 | 0 | 0 |
| `issue-3518-runtime-preparation-owner` | 8 | 0 | 0 |
| `issue-3518-runtime-preparation-relocation` | 121 | 3 | 2 |
| `issue-3518-runtime-producers-import-boundaries` | 3 | 1 | 2 |
| `issue-3518-runtime-producers` | 25 | 0 | 0 |
| `issue-3518-runtime-program-c1-relocation` | 43 | 0 | 0 |
| `issue-3518-runtime-program-policy-evolution` | 0 | 0 | 1 |
| `issue-3518-runtime-program-relocation` | 298 | 298 | 4 |
| `issue-3518-runtime-projection-owner` | 15 | 0 | 0 |
| `issue-3518-runtime-support-codec` | 5 | 0 | 0 |
| `issue-3518-runtime-support-source-free` | 2 | 0 | 0 |
| `issue-3518-runtime-support-transport` | 18 | 0 | 0 |
| `issue-3518-semantic-provider-boundary` | 354 | 349 | 2 |
| `issue-3518-semantic-provider-source-acceptance` | 87 | 1 | 2 |
| `issue-3518-semantic-verification-ownership` | 35 | 0 | 0 |
| `issue-3518-source-contract-relocation` | 65 | 53 | 2 |
| `issue-3518-source-validation-contracts` | 53 | 0 | 0 |
| `issue-3518-standalone-caller-abi` | 9 | 0 | 0 |
| `issue-3518-startup-boundary` | 12 | 0 | 0 |
| `issue-3518-startup-contract` | 25 | 1 | 2 |
| `issue-3518-string-equality-source-composition` | 12 | 0 | 0 |
| `issue-3518-string-exotic-own-descriptors` | 146 | 0 | 0 |
| `issue-3518-string-repeat-ir` | 12 | 2 | 2 |
| `issue-3518-symbolic-support-ref` | 20 | 6 | 2 |
| `issue-3518-timer-publication-contract` | 25 | 0 | 0 |
| `issue-3518-to-object-body` | 96 | 0 | 0 |
| `issue-3518-to-primitive-wrapper-forward` | 87 | 11 | 3 |
| `issue-3518-transitive-getter-captures` | 23 | 0 | 0 |
| `issue-3518-type-reservation-auth` | 6 | 0 | 0 |
| `issue-3518-typed-async-preparation` | 26 | 3 | 2 |
| `issue-3518-typed-gvn-diagnostics` | 15 | 0 | 0 |
| `issue-3518-typed-middleend-controls` | 36 | 0 | 0 |
| `issue-3518-typed-program-callable-contract` | 4 | 0 | 0 |
| `issue-3518-typed-program-preparation` | 30 | 2 | 2 |
| `issue-3518-typed-program-source-free` | 7 | 0 | 0 |
| `issue-3518-typedarray-main-preservation-port` | 0 | 0 | 1 |
| `issue-3518-validation-analysis-relocation` | 116 | 80 | 2 |
| `issue-3518-validation-policy-evolution` | 63 | 63 | 2 |
| `issue-3518-vector-construction-nullability` | 7 | 0 | 0 |
| `issue-3518-vector-grow-store-body` | 22 | 0 | 0 |
| `issue-3518-vector-grow-store-donor` | 67 | 3 | 3 |
| `issue-3518-vector-runtime-callable-admission` | 61 | 0 | 0 |
| `issue-3518-verifier-body-relocation` | 39 | 0 | 0 |
| `issue-3518-void-closure-results` | 16 | 0 | 0 |
| `issue-3518-wasmgc-helper-policy-evolution` | 135 | 134 | 2 |
| `issue-3518-wat-type-index-preservation` | 1 | 0 | 0 |
| `issue-3518-well-known-symbol-policy-evolution` | 154 | 154 | 2 |
| `issue-3518-whole-program-route-audit` | 9 | 0 | 0 |
| `issue-3525-arraybuffer-isview-main-policy` | 56 | 56 | 2 |
| `issue-3525-initial-graph-optional-fields-source` | 20 | 5 | 2 |
| `issue-3525-main-inventory-source-successor` | 21 | 21 | 3 |
| `issue-3525-presentation-classification-policy` | 45 | 45 | 2 |
| `issue-4376-class-fields-main-inventory-successor` | 32 | 32 | 3 |
| `issue-4376-deno-callback-inventory-successor` | 32 | 32 | 3 |
| `issue-4376-post-position-main-inventory-successor` | 416 | 416 | 2 |
| `issue-6866-class-fields-main-inventory-successor` | 31 | 30 | 2 |
| `issue-6866-finally-main-inventory-successor` | 39 | 38 | 2 |
| `issue-6866-source-map-position-inventory-successor` | 23 | 22 | 2 |

<!-- before-table:end -->

## PR 2b result

Branch `claude/7380-pins-b`, base `claude/7380-pins-a` `e41fd9cc1d`. Status: **pass 1 (triage) and pass 2 (every red
pin retired) done; pass 3 (green pin families) not done.** The triage found 50 red tests that are not pins, so it
stopped for a decision; the lead's decisions (file the defects, fix the stale expectations, keep T and F) are applied
below.

### Triage

Method: each of the 90 red files from the 2a table, one vitest run per file (`VITEST_MAX_FORKS=1`,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, JSON reporter), on `e41fd9cc1d`. The per-file failing sets equal the 2a
before-table in every file (1,567 red tests). Every red test outside an obvious pin message was read; the (R) rows
were reproduced outside vitest with a small program, and the (T) rows re-run alone with a larger limit.

Classes:

- **P**: fails at a source hash, length, reconstructed historical file, receipt, closed list or count, or is a
  control of that machinery. Files marked "(load)" fail before any test runs; all their tests are pin-gated.
- **R bug**: a program or compiler function gives a wrong answer. Stays red.
- **R stale**: the compiler behaves correctly (or a deliberate later change made the old expectation false); the
  test expects the old state. Stays red unless the right answer is obvious.
- **T**: timeout under the 35 s / 10 s defaults on this box; passes alone with a larger limit.
- **F**: a forged-plan or verifier-plumbing test of a mechanism. Not a source pin, so not 2b's; it leaves with its
  mechanism (PR 3 / 5b).

Totals: **1,567 red = 1,507 P + 14 R bug + 36 R stale + 6 T + 4 F**, plus one suite-level T
(`native-realm-wrapper-storage`, 16 tests skipped behind a slow `beforeAll`).

#### R bug: wrong answers (14 tests, 4 defects)

| test file, tests | reproduction (expected = node) | where it belongs |
| --- | --- | --- |
| `host-coercion-get-abrupt`, all 10 red (`propagates … from the original getter`, `keeps ordinary fallback …`, utf8 off/on) | `export function run(o:any):number{return Number(o);}`, `target: "host"`, called from JS. `run({ valueOf(){ return 5; } })` gives NaN (node 5); `run({ toString(){ return "6"; } })` NaN (6); a throwing `valueOf` getter is never read (node throws 99); null-prototype object with `valueOf: undefined` and a `toString` getter gives NaN (node 7). | JS-environment value adapter: ToPrimitive of a host object reached through `__boundary_object_*` (#6708 / #6979 native-first core). |
| `ir-math-switch-retirement` "keeps all 42 exact-arity misses pre-claim and legacy-owned" | `export function f(value: number): number { return Math.atan(); }` (with `@ts-expect-error`), default JS target, IR on or off: compile error "`__get_builtin` (dynamic-shape object/property operation) is not yet supported in --target standalone" (on the JS target). node: `NaN`. Same for every one-argument method of the 21 and `imul()`; too-many-argument calls compile. | Math builtin call lowering for missing arguments (legacy codegen; the error text is #1472 Phase B's). |
| `native-family-source-identity` "does not certify a shadowed undefined read … `const undefined = 42; …`" and "retains the unsupported undefined read when the lowerer has no checker" | `lowerFunctionAstToIr` on `const undefined = 42; export function f(): void { return undefined; }` with a checker and no module-binding resolver lowers the read to `dyn.undefined` instead of refusing. End to end, `const undefined = 42; export function f(): number { return (undefined as any) + 1; }` returns NaN on the default and the standalone target; node (module code) returns 43. | `src/ir/from-ast.ts` identifier arm for `undefined` (around line 5232, #7104 / #7106) and `isUnshadowedGlobalExpression`: both treat "no module binding found" as "the global", which is false when there is no resolver. The ordinary pipeline gives the same wrong answer. |
| `runtime-producers-import-boundaries` "loads the physical type, closure, and ABI planning leaves without the frontend" | Loading `src/codegen/closures/funcref-wrapper-types.ts` under the frontend barrier fails: "blocked frontend module: src/ts-api.ts". The file has `import { ts } from "../../ts-api.js"` since `708382dc7c` (#5334). | A layering rule broken by #5334; codegen closures owner. Not a pin: the rule reads the current tree. |

#### R stale: correct behaviour, old expectation (36 tests)

| test file, tests | evidence | proposed right answer |
| --- | --- | --- |
| `host-utf8-literal-keys`, 16 (every `target=host` row) | `run()` equals the node oracle twice per row (the assertions before line 118 pass). Red only at `owners.length > 0`: the test wraps host imports `__defineProperty_accessor` / `__extern_set`, and the native-first module imports neither, so the spy never fires. | Drop the host-import spy block; keep the oracle comparison. Owner decides. |
| `ordinary-object-callable-contracts` "cannot materialize js.object.* merely because its semantic declaration exists", 8 | `RuntimeManifestBuilder({target:"standalone",backend:"wasmgc"}).requestFeature(name).freeze()` now selects `native.<name>` (`runtime-callable`) for all eight; the providers were added on purpose by `85750eeee0` ("join native invocation with ordinary object preparation"). The doc comment "no physical provider is granted by this catalogue" in `manifest.ts` is stale too. | Either assert the selected provider, or delete the case (its premise is gone). Owner decides. |
| `ordinary-getter-source` "does not mistake the full Number contract for unboxing or a physical provider", 1 | Same for `js.number.from-value` (provider `native.js.number.from-value`, #7354 D1). | As above. |
| `native-realm-requirements` "retains the original genuine Number/object frontend preparation refusal", 1 | As recorded in 2a: `js.number.from-value` gained a provider. | Realm owner. |
| `string-repeat-ir` "registers the exact host ABI …", "executes host repeat through the compiled adapter manifest", 2 | The JS target no longer imports `env.string_repeat` (imports are `__str_from_mem`, `__str_to_mem`, `__str_extern_len`); calling the raw export with a JS string throws "type incompatibility when transforming from/to JS", as for any `string` parameter without `jsFacingExports`. In-module, `s.repeat(n)` gives node's answer for all 8 cases of the test (−0.5, NaN, 1.9, 3, −1, Infinity, `""`×−1, `""`×2^53−1), default and standalone target. | Rewrite against the native provider and the JS-facing exports, or delete as host-lane history. |
| `bench-array-prepared-cutover`, 1; `bench-string-prepared-cutover`, 2 | Artifact identity between the Prepared and the direct lane. Differences: closure body names in the route audit (`__closure_0` vs `__closure_2`), and the Prepared string pool lacks `"Object"` and the `Object.prototype` key-list string. The runtime-value assertions come later and are not reached. | Owner of the bench cutovers: compare answers, not closure numbering. Not verified whether the runtime values still match. |
| `native-vector-resources` "retains the complete population and located physical gaps", 4 | The whole-family physical setup is still refused (`kind: "unsupported"`), but the detail lists 35 other gaps ("async frames do not support wasmgc:standalone; …") instead of "scheduler/promise runtime materialization". | Update the expected gap text, or assert the refusal kind only. |
| `public-retirement-gate` "keeps typed async refusal before acceptance/emission …", 1 | `async function run(x){ const y = await (x+1); return await (y+2); }` is accepted on the wasmgc host lane and `run(5)` resolves to 8 (node 8). | **Done** in `00832dc282`: the test now asserts acceptance and the answers 8 and 0. 16/16 green. |

#### T and F

- T: `ordinary-object-runtime-providers` (2 empty-closure codec tests, 41–43 s each), `program-abi-seam` (1, 200 s;
  it type-checks a generated file, which also trips vitest's RPC timeout), `native-mixed-object-access` (3, 38–55 s;
  whole file 456 s), `native-realm-wrapper-storage` (`beforeAll` over 10 s). All pass alone with larger limits.
  `program-abi-seam`'s slow test is the type-level negative control of program ABI brands: not a pin, keep it.
- F: `typed-program-preparation` (2: the "omitted explicit verification options" error no longer fires, and the
  final-only verifier call count is 0), `native-object-descriptor-resources` "rejects a foreign exception token" and
  `native-prototype-seeder-bindings` "refuses foreign-ledger descriptor token 0" (both forged tokens now crash with
  `TypeError: Cannot read properties of undefined (reading 'name')` instead of a named refusal).

#### Found on the way, not a red test here

Native `Math` functions differ from node, some badly for large or tiny arguments: filed as #7441 with a 200-input
sweep.

#### Per-file triage (the 90 red files)

| file (`issue-3518-…`) | red | P | R bug | R stale | T | F | classification |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `any-to-string-source-composition` | 6 | 6 | 0 | 0 | 0 | 0 | P |
| `argument-vector-source-composition` | 59 | 59 | 0 | 0 | 0 | 0 | P |
| `array-main-refresh-port` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `async-frame-body-source-preservation` | 19 | 19 | 0 | 0 | 0 | 0 | P |
| `bench-array-prepared-cutover` | 1 | 0 | 0 | 1 | 0 | 0 | R-stale: Prepared vs direct legacy-entry audit differ only in closure numbering (`__closure_0` vs `__closure_2`) |
| `bench-string-prepared-cutover` | 2 | 0 | 0 | 2 | 0 | 0 | R-stale: string pool and closure numbering differ between lanes; runtime value not reached |
| `bigint-carrier-port` | 26 | 26 | 0 | 0 | 0 | 0 | P |
| `builtin-metadata-main-port` | 26 | 26 | 0 | 0 | 0 | 0 | P |
| `capability-schema-boundary` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `class-to-primitive-presence` | 2 | 2 | 0 | 0 | 0 | 0 | P |
| `closure-source-composition` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `conversion-source-composition` | 16 | 16 | 0 | 0 | 0 | 0 | P |
| `core-kind-neutrality` | 2 | 2 | 0 | 0 | 0 | 0 | P |
| `core-nodes-boundary` | 29 | 29 | 0 | 0 | 0 | 0 | P |
| `core-nodes-seam` | 6 | 6 | 0 | 0 | 0 | 0 | P |
| `core-type-boundary` | 15 | 15 | 0 | 0 | 0 | 0 | P |
| `core-type-seam` | 5 | 5 | 0 | 0 | 0 | 0 | P |
| `delay-combinator-layout-ownership` | 12 | 12 | 0 | 0 | 0 | 0 | P |
| `delivery-main-refresh-port` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `descriptor-adapter-relocation` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `descriptor-undefined-correction` | 9 | 9 | 0 | 0 | 0 | 0 | P |
| `historical-runtime-reconstruction` | 631 | 631 | 0 | 0 | 0 | 0 | P |
| `host-coercion-get-abrupt` | 10 | 0 | 10 | 0 | 0 | 0 | R-bug: JS-target `Number(o)` on a JS object: no `valueOf`/`toString` call, returns NaN |
| `host-utf8-literal-keys` | 16 | 0 | 0 | 16 | 0 | 0 | R-stale: answers equal node; spies on host imports `__defineProperty_accessor`/`__extern_set` that native-first no longer emits |
| `ir-math-switch-retirement` | 1 | 0 | 1 | 0 | 0 | 0 | R-bug: `Math.atan()` (0 args) does not compile on the JS target |
| `later-main-preservation-port` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `lowering-cycle` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `native-accessor-call-bodies` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `native-any-to-string-donor` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `native-argument-vector-resources` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `native-carrier-bag-read-bodies` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `native-closure-resources` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `native-delay-combinator-body-ownership` | 8 | 8 | 0 | 0 | 0 | 0 | P |
| `native-delay-combinator-source-preservation` | 89 | 89 | 0 | 0 | 0 | 0 | P |
| `native-family-source-contract` | 8 | 8 | 0 | 0 | 0 | 0 | P |
| `native-family-source-identity` | 2 | 0 | 2 | 0 | 0 | 0 | R-bug: module-scope `const undefined = 42` read lowers to `dyn.undefined` |
| `native-mixed-object-access` | 3 | 0 | 0 | 0 | 3 | 0 | T: three structural-owner tests take 38–55 s; pass alone with a larger limit (whole file 456 s) |
| `native-number-format-ownership` | 2 | 2 | 0 | 0 | 0 | 0 | P |
| `native-object-descriptor-resources` | 1 | 0 | 0 | 0 | 0 | 1 | F: foreign exception token forgery crashes with a TypeError (M3); leaves with PR 5b |
| `native-object-get-bodies` | 55 | 55 | 0 | 0 | 0 | 0 | P |
| `native-object-key-foundation` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `native-object-layouts` | 2 | 2 | 0 | 0 | 0 | 0 | P |
| `native-object-storage-resources` | 14 | 14 | 0 | 0 | 0 | 0 | P |
| `native-object-write-composition` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `native-prototype-seeder-bindings` | 1 | 0 | 0 | 0 | 0 | 1 | F: foreign-ledger token forgery crashes with a TypeError (M3); leaves with PR 5b |
| `native-realm-requirements` | 1 | 0 | 0 | 1 | 0 | 0 | R-stale: 2a class (ii): `js.number.from-value` gained a provider |
| `native-realm-wrapper-storage` | 0 | 0 | 0 | 0 | 0 | 0 | T (suite): beforeAll takes >10 s, 16 tests skipped; 24/24 pass with a larger hook limit |
| `native-string-no-demand-emitter-forward` | 8 | 8 | 0 | 0 | 0 | 0 | P |
| `native-string-number-resources` | 35 | 35 | 0 | 0 | 0 | 0 | P |
| `native-string-output-preservation` | 24 | 24 | 0 | 0 | 0 | 0 | P |
| `native-symbol-carrier-resources` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `native-value-resources` | 61 | 61 | 0 | 0 | 0 | 0 | P |
| `native-vector-resources` | 4 | 0 | 0 | 4 | 0 | 0 | R-stale: whole-family physical setup still refused, with a different gap text |
| `number-format-source-support` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `object-runtime-main-composition` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `open-extension-boundaries` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `ordinary-getter-source` | 1 | 0 | 0 | 1 | 0 | 0 | R-stale: same for `js.number.from-value` (provider added by #7354 D1) |
| `ordinary-object-callable-contracts` | 8 | 0 | 0 | 8 | 0 | 0 | R-stale: expects `missing-runtime-provider`; `native.js.object.*` providers were added on purpose (85750eeee0) |
| `ordinary-object-runtime-providers` | 2 | 0 | 0 | 0 | 2 | 0 | T: two empty-closure codec runs take 41–43 s against the 35 s limit; pass alone with a larger limit |
| `own-property-bodies` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `program-abi-seam` | 1 | 0 | 0 | 0 | 1 | 0 | T: type-checks a generated file for 200 s; passes alone with a larger limit |
| `promise-earlier-main-port` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `promise-export-main-port` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `promise-resolution-preservation` | 3 | 3 | 0 | 0 | 0 | 0 | P |
| `promise-settlement-body-ownership` | 9 | 9 | 0 | 0 | 0 | 0 | P |
| `prototype-chain-preservation` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `prototype-companion-body` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `prototype-read-recipes` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `prototype-receiver-bodies` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `prototype-seeder-bodies` | 2 | 2 | 0 | 0 | 0 | 0 | P |
| `prototype-seeder-extraction` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `prototype-singleton-bodies` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `provider-verification-ownership` | 25 | 25 | 0 | 0 | 0 | 0 | P |
| `public-retirement-gate` | 1 | 0 | 0 | 1 | 0 | 0 | R-stale, fixed: typed async now accepted and correct; expectation updated in 00832dc282 |
| `reference-error-runtime-producers` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `resume-main-composition` | 131 | 131 | 0 | 0 | 0 | 0 | P |
| `runtime-contract-evolution` | 0 (380 skipped) | 0 | 0 | 0 | 0 | 0 | P: `beforeAll` fails on a source SHA pin, all 380 tests skipped |
| `runtime-preparation-relocation` | 3 | 3 | 0 | 0 | 0 | 0 | P |
| `runtime-producers-import-boundaries` | 1 | 0 | 1 | 0 | 0 | 0 | R-bug: `funcref-wrapper-types.ts` value-imports the frontend (`ts-api`) |
| `semantic-provider-source-acceptance` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `source-contract-relocation` | 53 | 53 | 0 | 0 | 0 | 0 | P |
| `startup-contract` | 1 | 1 | 0 | 0 | 0 | 0 | P |
| `string-repeat-ir` | 2 | 0 | 0 | 2 | 0 | 0 | R-stale: expects host import `env.string_repeat` and a raw JS-string export call; repeat semantics are correct in-module |
| `symbolic-support-ref` | 6 | 6 | 0 | 0 | 0 | 0 | P |
| `to-primitive-wrapper-forward` | 11 | 11 | 0 | 0 | 0 | 0 | P |
| `typed-async-preparation` | 3 | 3 | 0 | 0 | 0 | 0 | P |
| `typed-program-preparation` | 2 | 0 | 0 | 0 | 0 | 2 | F: verifier-option threading and call counts (M10); leaves with PR 3 |
| `typedarray-main-preservation-port` | 0 (load) | 0 | 0 | 0 | 0 | 0 | P: fails at load on a source pin; every test in the file is pin-gated |
| `validation-analysis-relocation` | 80 | 80 | 0 | 0 | 0 | 0 | P |
| `vector-grow-store-donor` | 3 | 3 | 0 | 0 | 0 | 0 | P |
| **90 files** | **1567** | **1507** | **14** | **36** | **6** | **4** | |

### After the triage: lead's decisions applied (2026-11-20)

**A. Defects filed** (`ba36767817`). The red tests stay red and unedited: a comment would modify a red file, and
`quality` requires every modified test file to pass.

| issue | red tests |
| --- | --- |
| #7437 `Number(o)` on a JS object skips ToPrimitive | `issue-3518-host-coercion-get-abrupt`, the 10 red tests |
| #7438 Math calls with a missing argument do not compile (32 functions, swept) | `issue-3518-ir-math-switch-retirement` "keeps all 42 exact-arity misses …" |
| #7439 module-scope `const undefined` read as the global | `issue-3518-native-family-source-identity`, the 2 red tests |
| #7440 `funcref-wrapper-types.ts` imports `ts-api` | `issue-3518-runtime-producers-import-boundaries` "loads the physical type, closure, and ABI planning leaves …" |
| #7441 native Math differs from node (200-input sweep in the issue) | none; found by probe |

**B. Stale expectations fixed** (one commit each, the evidence in the message; each file passes in full): 31 of 36.

- `public-retirement-gate` (1, `00832dc282`).
- `host-utf8-literal-keys` (16, `b07bb95818`): compares answers with node; the retired host-import spy is gone.
- `ordinary-object-callable-contracts` (8, `9a6921f7e7`) and `ordinary-getter-source` (1, `41abb84319`): assert the
  exact selected provider, which `85750eeee0` and `69e6b7f3ef` (#7106) added on purpose.
- `native-vector-resources` (4, `cf1b1f6ada`): asserts the located gap report that `999a6a4235` introduced.
- `string-repeat-ir` (1 of 2, `311c9a7cbe`): repeat through the JS exports adapter.

  That rewrite exposed a real wrong answer, kept as its own red test: `"a".repeat(Number.MAX_SAFE_INTEGER)` throws a
  Wasm `RuntimeError` ("requested new array is too large"), node throws `RangeError`. **No issue id yet** (only the
  five reserved ids were to be used).

**Still red, needs the owner** (4): `bench-array-prepared-cutover` (1) and `bench-string-prepared-cutover` (2), whose
runtime values are not reached; `native-realm-requirements` (1). (The `string-repeat-ir` host-ABI test was resolved in
review round 1.)

**C. Timeouts.**

- Fixed with a measured per-test limit:
  - `ordinary-object-runtime-providers`: 180 s, `630a2a2a7b`; 117/117.
  - `native-realm-wrapper-storage`: 180 s hook limit, `f30accec07`; 24/24.
- Left, because a limit alone does not make the file deterministic: `program-abi-seam` (1, 200 s) and
  `native-mixed-object-access` (3, 38 to 55 s). With a larger limit both pass, but vitest then reports "Timeout
  calling onTaskUpdate" (the worker's event loop is blocked) and the file still exits 1.

**D. F, untouched:**

- `typed-program-preparation` (2), for PR 3.
- `native-object-descriptor-resources` (1) and `native-prototype-seeder-bindings` (1), for PR 5b.

### Pass 2: every red pin retired

| part | commit | what | lines | bytes |
| --- | --- | --- | ---: | ---: |
| 1 | `05ef799232` | 37 files whose tests are all pins or controls of the pin machinery (21 of them failed at load) | 12,234 test lines | |
| 1 | `05ef799232` | 17 helpers and fixtures reachable only from them | 14,271 | 784,860 |
| 2 | `e51637f49b` | red pin tests cut out of 33 mixed files (their tests pass; six files still failed at file level until review round 1) | 4,505 test lines (−4,505 / +11) | |
| 2 | `e51637f49b` | 5 helpers and receipts left unreferenced | 31,588 | 1,219,513 |

How the cuts were chosen:

- Red tests were located by vitest's task location, per generated instance.
- A test was removed whole when every instance was red.
- A generated test with red and green instances was removed whole only where every instance was a mutation control
  of the same receipt or donor (7 sites).
- Three pin lines inside behaviour tests were cut instead of the test:
  - the scan counts in `native-family-source-contract`;
  - one closed-list entry in `reference-error-runtime-producers`;
  - the provider-list length in `provider-verification-ownership`.
- Helpers were deleted by reachability (imports and path strings), then checked again by name;
  `prototype-singleton-extraction.ts` stays because a kept receipt names it.

Red tests left in the 90 files (all other red tests are gone):

- 14 R bug (A above); the repeat defect #7442 is pinned green in its modified file;
- 4 still red, needing the owner (B);
- 4 T (`program-abi-seam` 1, `native-mixed-object-access` 3);
- 4 F (D).

### Owed, not pins (rule C)

- **Covered elsewhere, fine to drop:**
  - the `ir-core` layer rule of `core-nodes-boundary` / `core-type-boundary`, which is in
    `scripts/compiler-boundaries.json`;
  - `lowering-cycle`'s no-cycle claim, which `check:import-cycles` enforces.
- **Owed:**
  - `native-value-resources` "rejects a forbidden upward edge" (the native value layouts must not import
    `codegen/context`, `codegen/registry`, `codegen/index`): a boundaries-inventory rule.
  - The four resource files that failed at load and executed canonical runtime bodies against reconstructed donors:
    `native-argument-vector-resources`, `native-carrier-bag-read-bodies`, `native-closure-resources`,
    `native-symbol-carrier-resources`. A donor-free execution test of those bodies is owed.
  - `symbolic-support-ref` "lowers the unchanged original radix through the genuine frontend kernel": its assertions
    were source-structure counts after the byte pin. A behaviour test of the radix kernel is owed if none exists.
- **Stays:** `program-abi-seam`'s type-brand control (a T row).

### Pass 3: not done

`git grep -l "createHash\|sha256\|completeSource\|relocation receipt" -- tests` still matches 295 files:

- 157 top-level test files;
- 19 under `tests/dogfood`;
- 52 helpers;
- 67 fixtures.

Retiring the green pin families of section 3 file by file is the next step. Not every match is a pin: dogfood,
`issue-6450/named-crypto` and the linear-link fixtures hash their own outputs.


### Review round 1 (2026-11-20): NOT MET, fixed

| finding | what changed |
| --- | --- |
| 6 mixed files failed at file level: 12 `describe` blocks left with no test | Blocks deleted (`dd9b22c7ca`). An AST scan of all modified test files finds no empty `describe`. |
| `closure-state-preservation-port` went red: a hash pin read two deleted test files | That test cut, 70/70 (`9fa8cc15fc`). A grep of `tests/`, `scripts/` and `src/` for all 59 deleted files' names finds no other reader. Seven helpers and receipts left unreferenced were deleted with it (771 lines, 91,862 bytes): `closure-source-composition`, `builtin-metadata-main-port` (each .ts + fixture), `native-closure-donors.json`, two native-value forward receipts. |
| `string-repeat-ir` modified and left red (2 tests) | File kept modified and made green (`09a9a2b663`). The host-ABI test now asserts the two exact refusals: `nativeStrings: false` throws the #6979 error, and the host provider refuses on the native-string context. The repeat defect is filed as **#7442** (in-module `"a".repeat(2^53-1).length` is 2147483647 on both targets; through the adapter it traps). Its test pins the current trap under a comment naming the issue, the repo's convention for an open defect (cf. `issue-3912-fast-number-stringify`); no `skip`. |
| 10 files lost their license header | The cut tool removed the first import's leading comment. Base line 1 restored in all ten (`10070a241f`; two of them in `dd9b22c7ca`). |
| #7440 said the inventory has no entry | Corrected (`00e29ad59b`): the file is listed as `mixed-needs-split`. That entry is recorded debt; the stricter test passed until #5334, so the red test stays as a real regression. |
| #7438 count | 31 functions (`e9aa9dbfb5`). |
| #7437 throwing-getter row | Re-measured (`c776abdebd`): through the exports adapter the getter is read and 99 propagates; on the raw export nothing throws. The other three rows are NaN either way. |
| #7441 rows | Added seven spot-check rows (`f86f4a232c`), identical on the JS and the standalone target; dropped the stale "not filed" note here. |
| `public-retirement-gate` dropped the phase assertion | Restored (`6c7ef18b03`): the accepted program is observed as `prepared`, `accepted`, `emission-started`, `emitted`, and `phaseProblems` is empty. |

Correction: the pass 2 sentence "33 mixed files, which now pass in full" was false at `e51637f49b`. Their tests
passed, but six of the files failed at file level ("No test found in suite"). The criterion is now the file's exit
status.

Every modified test file, one vitest run each (`VITEST_MAX_FORKS=1`, `VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`), at
`f86f4a232c`. There are 42 files; the review counted 41 before `closure-state-preservation-port` was edited:

| file (`issue-3518-…`) | tests | failed | exit |
| --- | ---: | ---: | ---: |
| `async-frame-body-source-preservation` | 22 | 0 | 0 |
| `capability-schema-boundary` | 48 | 0 | 0 |
| `class-to-primitive-presence` | 22 | 0 | 0 |
| `closure-state-preservation-port` | 70 | 0 | 0 |
| `core-kind-neutrality` | 51 | 0 | 0 |
| `core-nodes-seam` | 27 | 0 | 0 |
| `core-type-seam` | 16 | 0 | 0 |
| `delay-combinator-layout-ownership` | 14 | 0 | 0 |
| `host-utf8-literal-keys` | 33 | 0 | 0 |
| `lowering-cycle` | 24 | 0 | 0 |
| `native-accessor-call-bodies` | 39 | 0 | 0 |
| `native-delay-combinator-body-ownership` | 25 | 0 | 0 |
| `native-delay-combinator-source-preservation` | 17 | 0 | 0 |
| `native-family-source-contract` | 45 | 0 | 0 |
| `native-number-format-ownership` | 11 | 0 | 0 |
| `native-object-get-bodies` | 35 | 0 | 0 |
| `native-object-key-foundation` | 27 | 0 | 0 |
| `native-object-layouts` | 50 | 0 | 0 |
| `native-object-storage-resources` | 37 | 0 | 0 |
| `native-realm-wrapper-storage` | 24 | 0 | 0 |
| `native-string-number-resources` | 88 | 0 | 0 |
| `native-value-resources` | 57 | 0 | 0 |
| `native-vector-resources` | 31 | 0 | 0 |
| `number-format-source-support` | 9 | 0 | 0 |
| `open-extension-boundaries` | 65 | 0 | 0 |
| `ordinary-getter-source` | 8 | 0 | 0 |
| `ordinary-object-callable-contracts` | 23 | 0 | 0 |
| `ordinary-object-runtime-providers` | 117 | 0 | 0 |
| `promise-resolution-preservation` | 50 | 0 | 0 |
| `promise-settlement-body-ownership` | 83 | 0 | 0 |
| `prototype-seeder-bodies` | 51 | 0 | 0 |
| `provider-verification-ownership` | 33 | 0 | 0 |
| `public-retirement-gate` | 16 | 0 | 0 |
| `reference-error-runtime-producers` | 28 | 0 | 0 |
| `runtime-preparation-relocation` | 118 | 0 | 0 |
| `semantic-provider-source-acceptance` | 86 | 0 | 0 |
| `startup-contract` | 24 | 0 | 0 |
| `string-repeat-ir` | 13 | 0 | 0 |
| `symbolic-support-ref` | 14 | 0 | 0 |
| `to-primitive-wrapper-forward` | 73 | 0 | 0 |
| `typed-async-preparation` | 22 | 0 | 0 |
| `vector-grow-store-donor` | 60 | 0 | 0 |


Gates at `f86f4a232c`, each run bare, all exit 0: typecheck, dead-exports, import-cycles, orphaned-scripts
(49/305), LOC budget, function budget.

### Gates and verification

- Gates, each run bare, exit 0 at `e51637f49b`'s content:
  - `npm run -s typecheck`;
  - `npm run -s check:dead-exports` (no export orphaned; `preservation-v1` unaffected);
  - `npm run -s check:import-cycles`;
  - `node scripts/check-orphaned-scripts.mjs` (49 of 305, baseline 49);
  - `node scripts/check-compiler-boundaries.mjs --mode inventory --base e41fd9cc1d`;
  - LOC and function budgets (commit hook).
- No file in `scripts/`, workflows, `package.json` or `docs/` named a deleted file.
- Every modified test file was run alone: see the per-file table in review round 1 (all 42 exit 0).
- `scripts/hooks/changed-root-tests.sh` was not run as one command: its 40 files take over the 9-minute limit on this
  box.

Not verified:

- The bench cutovers' runtime values.
- The behaviour of the `native-realm-requirements` program.
- Whether the verifier change behind `typed-program-preparation` was deliberate.
- The `quality` job's full vitest run.
- `LOC_GATE_BASE` against the upstream tip.

## PR 2c result

Branch `claude/7380-pins-c`, base `claude/7380-pins-b` `1c83c44d3b`. Status: **the `issue-3518` … `issue-3527` families
are done; every other family is inventoried but not reviewed or cut** (list at the end). No `src/` change.

Gist:

- 89 files of the 35xx families reviewed: 5 deleted whole (P), 61 trimmed (T), 11 kept as they are (K), 12 left
  untouched because they are red at base (K*).
- 259 pin test sites removed, 1,169 kept (sites are `it`/`test` calls in the source; generated instances are more).
- 72 files deleted: the 5 test files plus 67 receipts, donor fixtures and port/extraction helpers that no test reads
  any more. 20,901 lines removed, 127 added.
- Every modified file passes (16 batches, table below). Gates pass.

### Method

- **Inventory.** An AST pass over every test file (`.tmp/classify.mjs` in the worktree, not committed) marks a value
  as source-derived when it comes from `readFileSync` / `readFile` / `readdirSync` / `createSourceFile` /
  `createProgram` of a `src/` path (also through local reader functions), from a receipt or donor JSON under
  `tests/helpers` / `tests/fixtures`, or from a helper module that hashes text. A test that uses such a value is a pin
  candidate; one that also compiles or runs a program is "mixed" and was read by hand. Every candidate in the 35xx
  families was read before it was cut. False positives of the pass (a script tested on a copied tree, `sha` in a log
  line, a hash comparing two compiled binaries, test programs that mention `src`) are the K rows.
- **What counts as a pin here.** A test asserting the text, hash, byte size, line or declaration count, import list or
  re-export chain of a source file; a reconstruction of a historical source ("donor") and any equality against it;
  a receipt or fixture-authentication control; a mutation control of that machinery; a hash or byte size of a test's
  own input program or of a codec encoding.
- **What stayed.** Tests that compile and run programs, call compiler functions and check results or named refusals,
  type-level compile checks, and tests of scripts. Where a behaviour test also compared with a donor, the donor
  comparison went and the assertion on the current code stayed: canonical walker traversal, accessor-call traces,
  Boolean box globals, object key coercion, rope execution (now against the live legacy materializer), Promise
  resolution locals and settle-closure independence, timer publication refusals, vector body freshness, the core
  allocator identity. Input-hash lines inside behaviour tests were dropped.
- **Not in this step.** Closed-list count assertions on exported tables (`INTRINSIC_IDS` length and similar) are
  section 3 / PR 6 material and stay. Forged-plan and receipt-comparison tests that read no source (for example
  `semantic-provider-source-acceptance`, the `core-node-execution` witness script) stay for PR 3 / 5.
- **Cuts** were made by AST (statement removal, then pruning of describes and declarations left without a user,
  resolved by symbol, and unused imports), never by line deletion. Every modified file was then checked for: no empty
  `describe`, no unused import or variable (biome), no module- or describe-level setup statement lost against base
  (one was, in `native-string-utf8-rope`, and was restored before its commit), license header intact.
- Helpers and fixtures were deleted by reachability: a file under `tests/helpers` or `tests/fixtures` whose name no
  tracked file in `tests/`, `scripts/`, `src/`, `package.json`, `.github/` or a config mentions, repeated until
  nothing new appeared. The baseline orphans (`ir-closure-probes/*`, `issue-6969-parse-number-tostring-delta.json`,
  `npm-resolve/lib/explicit-js.d.ts`) were already unreferenced at base and are left.

### Files

| file (`tests/…test.ts`) | class | test sites removed | kept | what went |
| --- | --- | ---: | ---: | --- |
| `issue-3518-native-string-equality-donor` | P | 3 | 0 | donor equality |
| `issue-3518-runtime-preparation-relocation` | P | 18 | 0 | relocation receipt |
| `issue-3518-semantic-provider-boundary` | P | 2 | 0 | layer rule: Owed |
| `issue-3518-string-equality-source-composition` | P | 9 | 0 | composition receipt |
| `issue-3525-source-map-validator-proof` | P | 9 | 0 | byte/sha pins of validator sources |
| `issue-3518-allocation-runtime-seam` | T | 1 | 12 | facade structure and export list read from source |
| `issue-3518-async-frame-body-source-preservation` | T | 4 | 1 | historical-body receipts cut; the public-source execution test kept |
| `issue-3518-canonical-instruction-walk` | T | 8 | 8 | export lists, source receipt, WAT import pins cut; traversal tests now run the canonical walker only (donor dropped) |
| `issue-3518-capability-schema-boundary` | T | 1 | 16 | declaration-count pin cut |
| `issue-3518-capability-schema-seam` | T | 3 | 5 | declaration receipt and count pins cut; type-compatibility compile test kept |
| `issue-3518-certified-delay-source-identity` | T | 3 | 19 | declaration receipts and the overlay import-structure pin |
| `issue-3518-closure-state-preservation-port` | T | 12 | 1 | receipt/inverse machinery; the closure-layout builder assertion kept |
| `issue-3518-core-nodes-seam` | T | 0 | 9 | class-member structure lines dropped from the allocator identity test |
| `issue-3518-core-vocabulary-seam` | T | 1 | 11 | layer rule (Owed); count pins left for step 6 |
| `issue-3518-delay-combinator-layout-ownership` | T | 2 | 6 | donor-route mutation controls; layer rule (Owed) |
| `issue-3518-host-utf8-literal-keys` | T | 0 | 2 | input-hash line dropped |
| `issue-3518-lowering-contract-owner` | T | 1 | 15 | donor reconstruction |
| `issue-3518-lowering-cycle` | T | 3 | 8 | facade/parameter structure pins and the test-local cycle walker (check:import-cycles covers it); export identity kept |
| `issue-3518-lowering-relocation-coverage` | T | 1 | 10 | body-hash receipt (it.skipIf) |
| `issue-3518-module-reservations` | T | 2 | 49 | declaration receipt and export-list pins |
| `issue-3518-native-accessor-call-bodies` | T | 2 | 9 | layer rule (Owed) and donor-mutation test cut; donor equality dropped from the trace test |
| `issue-3518-native-bigint-primitive-bodies` | T | 0 | 9 | hash checks of the expected-instruction literals dropped |
| `issue-3518-native-boolean-boxes` | T | 2 | 16 | historical-donor equality; global-placement assertion kept without the donor |
| `issue-3518-native-delay-combinator-source-preservation` | T | 4 | 1 | historical-body reconstruction; the execution test kept |
| `issue-3518-native-family-callable-declarations` | T | 2 | 8 | forward-structure and declaration-hash pins |
| `issue-3518-native-family-source-contract` | T | 1 | 17 | pin of another test file's text |
| `issue-3518-native-number-format-ownership` | T | 5 | 1 | donor reconstruction; registration/idempotency behaviour kept without the donor comparison |
| `issue-3518-native-object-access-resources` | T | 1 | 25 | src text pin of three flag constants; input-hash line dropped |
| `issue-3518-native-object-get-bodies` | T | 3 | 27 | donor receipts, layer rule (Owed) |
| `issue-3518-native-object-key-foundation` | T | 5 | 4 | donor-equality and receipt tests; layer-rule half of one test cut (Owed), its instruction-sharing check kept |
| `issue-3518-native-promise-inventory-planning` | T | 0 | 7 | input-hash line dropped from shared prepare() |
| `issue-3518-native-ref-cell-resources` | T | 1 | 17 | donor inverse |
| `issue-3518-native-ryu-ownership` | T | 3 | 3 | donor reconstruction and legacy-vs-donor emission |
| `issue-3518-native-scanner-source-preservation` | T | 12 | 11 | src projections and their mutation controls; the script-helper tests kept |
| `issue-3518-native-string-error-resources` | T | 9 | 8 | donor fixture, own-text hash, donor equality; the rope execution test now compares with the live legacy materializer |
| `issue-3518-native-string-flatten-resources` | T | 12 | 19 | donor reconstruction and live-mutation controls; input-hash line dropped |
| `issue-3518-native-string-number-resources` | T | 3 | 28 | donor-recording tests and their harness controls |
| `issue-3518-native-string-output-consumer` | T | 0 | 7 | input-hash line dropped |
| `issue-3518-native-string-output-requirements` | T | 0 | 25 | input-hash line dropped |
| `issue-3518-native-string-utf8-rope` | T | 1 | 5 | projected-source equality; two hash lines (src and input) dropped |
| `issue-3518-native-to-primitive-bodies` | T | 7 | 3 | donor fixture, donor-trace equality, layer rule (Owed) |
| `issue-3518-native-utf8-window-decoder` | T | 0 | 6 | src hash line dropped from the shared fixture |
| `issue-3518-native-wasm-foundation` | T | 3 | 3 | layer rule (Owed), its dependency-detector control, consumer import-name pin |
| `issue-3518-physical-snapshot-comparison` | T | 1 | 28 | src function-text hash |
| `issue-3518-promise-resolution-preservation` | T | 9 | 4 | donor receipts and donor equality; two tests keep their assertions on the current builders |
| `issue-3518-promise-settlement-body-ownership` | T | 13 | 6 | moved-body receipts, declaration receipts, mutation controls, layer rule (Owed) |
| `issue-3518-promise-settlement-source-preservation` | T | 3 | 3 | receipt-validator tamper controls |
| `issue-3518-prototype-seeder-bodies` | T | 8 | 4 | donor receipt and donor-trace tests |
| `issue-3518-runtime-data-contract-seam` | T | 1 | 8 | re-export chain read from source |
| `issue-3518-semantic-verification-ownership` | T | 5 | 13 | declaration receipts, signature-prefix hash, historical-hash replay, class-member pin; count assertions left for step 6 |
| `issue-3518-startup-contract` | T | 3 | 5 | declaration hashes, declaration count/forward structure, layer rule (Owed) |
| `issue-3518-timer-publication-contract` | T | 4 | 3 | donor constants/body/traces; the refusal-control test now runs the current publisher only |
| `issue-3518-to-primitive-wrapper-forward` | T | 2 | 26 | fixture-receipt reseeding controls |
| `issue-3518-typed-middleend-controls` | T | 1 | 19 | call-count pin on src/ir/integration.ts |
| `issue-3518-vector-grow-store-body` | T | 5 | 4 | donor receipts and layer rule (Owed); the freshness test compares with a second build instead of the donor |
| `issue-3518-vector-grow-store-donor` | T | 18 | 6 | layout-inverse receipts, registry inverses, adapter-text pins |
| `issue-3518-vector-runtime-callable-admission` | T | 3 | 21 | declaration receipts and facade export structure |
| `issue-3521-r2-withdrawal-telemetry` | T | 5 | 7 | selector/codegen source-order pins; source literal count dropped from the vocabulary test |
| `issue-3521-runtime-callable-abi` | T | 0 | 11 | input-hash line dropped |
| `issue-3525-emitted-physical-plan-observation` | T | 0 | 13 | input-hash line dropped |
| `issue-3525-prepared-linear-early-return` | T | 0 | 7 | four source byte/hash pins dropped from the oracle test |
| `issue-3525-prepared-source-map-data` | T | 0 | 32 | codec byte size and hash dropped |
| `issue-3526-callable-boundary-callback` | T | 6 | 33 | source-text pins on from-ast, overlay and integration |
| `issue-3526-string-boundary-concat-many` | T | 6 | 23 | source-text pins on integration and pass selection |
| `issue-3526-string-boundary-const` | T | 7 | 32 | provider/lane source-text pins |
| `issue-3527-async-replay-oracle` | T | 0 | 5 | input-hash line dropped |
| `issue-3518-certified-delay-source-admission` | K* | 0 | 23 | red at base (F-class test 'rejects a source-produced global binding…'); one input-hash line left, file not touched |
| `issue-3518-program-codec-replay` | K* | 0 | 27 | red at base (F-class '[defect 2] emission transitions are private'); one input-hash line left, file not touched |
| `issue-3525-prepared-mixed-presentation` | K* | 0 | 12 | red at base (3 tests); input hash/byte-size lines left, file not touched |
| `issue-3525-prepared-wit-presentation` | K* | 0 | 17 | red at base (2 tests); input-hash line left, file not touched |
| `issue-3525-prepared-zero-suspension-rejection` | K* | 0 | 6 | red at base (6 tests); input hash/byte-size lines left, file not touched |
| `issue-3526-f3s3-function-prototype-call-policy` | K* | 0 | 12 | red at base (4 tests, 2 of them source pins); 4 source pins left, file not touched |
| `issue-3526-string-boundary-charcodeat` | K* | 0 | 31 | red at base (4 tests, 1 a source pin); 4 source pins left, file not touched |
| `issue-3526-string-boundary-compare` | K* | 0 | 21 | red at base (2 host-lane tests); 3 source pins left, file not touched |
| `issue-3526-string-boundary-concat` | K* | 0 | 27 | red at base (3 host-lane tests); 6 source pins left, file not touched |
| `issue-3526-string-boundary-eq` | K* | 0 | 24 | red at base (3 host-lane tests); 5 source pins left, file not touched |
| `issue-3526-string-boundary-len` | K* | 0 | 31 | red at base (3 host-lane tests); 7 source pins left, file not touched |
| `issue-3526-string-boundary-schema` | K* | 0 | 32 | red at base (3 host-lane ABI tests); 2 source pins left, file not touched |
| `issue-3518-class-to-primitive-presence` | K | 0 | 5 | sha only in a log line |
| `issue-3518-core-kind-neutrality` | K | 0 | 15 | tests scripts/check-ir-kind-neutrality.mjs on a copied tree |
| `issue-3518-core-node-execution` | K | 0 | 25 | tests scripts/lib/core-node-execution-witness.mjs |
| `issue-3518-core-type-reachability` | K | 0 | 13 | tests a script on a fixture |
| `issue-3518-identity-foundation-boundary` | K | 0 | 5 | runs the boundaries checker on a fixture |
| `issue-3518-ir-adoption-contract` | K | 0 | 5 | tests gen-ir-adoption.mjs behaviour |
| `issue-3518-semantic-provider-source-acceptance` | K | 0 | 23 | receipt-comparison harness on synthetic data; reads no source |
| `issue-3521-prepared-free-function-routing` | K | 0 | 37 | parses inline test programs, not src |
| `issue-3523-ir-calendar-retirement` | K | 0 | 11 | hash compares two compiled binaries (determinism) |
| `issue-3523-module-init-discovery-static` | K | 0 | 13 | runs test262 fixtures; no src read |
| `issue-3525-source-map-safe-passes` | K | 0 | 10 | sha only in a log line |

Totals over these 89 files: P 5, T 61, K 11, K* (red at base, untouched) 12; 259 test sites removed, 1169 kept.

K* files are red at base and were not modified, because `quality` requires every modified test file to pass. Their
remaining pins are small (input-hash lines, or source-text tests next to red host-lane tests); they go with the fix of
the red tests or with PR 6. The red tests themselves, measured on base by a file-copy A/B run:
`certified-delay-source-admission` (1, F-class), `program-codec-replay` (1, F-class), `3525-prepared-mixed-presentation`
(3), `3525-prepared-wit-presentation` (2), `3525-prepared-zero-suspension-rejection` (6), and seven `3526` files whose
host-lane end-to-end tests fail (`f3s3` 4, `charcodeat` 4, `compare` 2, `concat` 3, `eq` 3, `len` 3, `schema` 3).

Deleted helpers and fixtures (67): `fixtures/issue-3518-array-main-refresh-port.json`, `fixtures/issue-3518-async-frame-forward-main.json`, `fixtures/issue-3518-bigint-carrier-port.json`, `fixtures/issue-3518-boolean-box-donor.ts.txt`, `fixtures/issue-3518-conversion-source-composition.json`, `fixtures/issue-3518-delivery-main-refresh-port.json`, `fixtures/issue-3518-descriptor-adapter-relocation.json`, `fixtures/issue-3518-descriptor-undefined-correction.json`, `fixtures/issue-3518-native-accessor-call-donor.json`, `fixtures/issue-3518-native-number-format-donor.json`, `fixtures/issue-3518-native-object-get-donor.json`, `fixtures/issue-3518-native-object-write-donor.json`, `fixtures/issue-3518-native-object-write-extraction.json`, `fixtures/issue-3518-native-ryu-donor.json`, `fixtures/issue-3518-native-string-equality-donor.json`, `fixtures/issue-3518-native-string-error-donors.json`, `fixtures/issue-3518-native-string-flatten-donor.ts`, `fixtures/issue-3518-native-to-primitive-donor.json`, `fixtures/issue-3518-object-get-key-composition.json`, `fixtures/issue-3518-object-key-donors.json`, `fixtures/issue-3518-object-runtime-apply-extraction.json`, `fixtures/issue-3518-object-runtime-fnctor-guard-forward.json`, `fixtures/issue-3518-object-runtime-main-composition.json`, `fixtures/issue-3518-own-property-extraction.json`, `fixtures/issue-3518-prepared-registry-types-forward.json`, `fixtures/issue-3518-promise-earlier-main-port.json`, `fixtures/issue-3518-promise-export-main-port.json`, `fixtures/issue-3518-promise-resolution-donors.json`, `fixtures/issue-3518-prototype-companion-extraction.json`, `fixtures/issue-3518-prototype-read-extraction.json`, `fixtures/issue-3518-prototype-receiver-extraction.json`, `fixtures/issue-3518-ref-cell-donor.json`, `fixtures/issue-3518-resume-main-composition.json`, `fixtures/issue-3518-string-equality-source-composition.json`, `fixtures/issue-3518-string-layout-shape-forward.json`, `fixtures/issue-3518-timer-publication-donor.json`, `fixtures/issue-3518-to-primitive-presence-extraction.json`, `fixtures/issue-3518-to-primitive-wrapper-forward.json`, `fixtures/issue-3518-vector-registry-layout-forward.json`, `helpers/array-main-refresh-port.ts`, `helpers/bigint-carrier-port.ts`, `helpers/closure-state-preservation-port.ts`, `helpers/conversion-source-composition.ts`, `helpers/delivery-main-refresh-port.ts`, `helpers/descriptor-adapter-relocation.ts`, `helpers/descriptor-undefined-correction.ts`, `helpers/ir-historical-runtime-reconstruction.ts`, `helpers/ir-remainder-runtime-preparation-relocation.ts`, `helpers/ir-runtime-preparation-relocation.json`, `helpers/ir-runtime-preparation-relocation.ts`, `helpers/later-main-preservation-port.ts`, `helpers/native-object-write-donor.ts`, `helpers/object-get-key-composition.ts`, `helpers/object-runtime-apply-extraction.ts`, `helpers/object-runtime-fnctor-guard-forward.ts`, `helpers/object-runtime-main-composition.ts`, `helpers/own-property-extraction.ts`, `helpers/prepared-source-forward-receipts.ts`, `helpers/promise-earlier-main-port.ts`, `helpers/promise-export-main-port.ts`, `helpers/promise-resolution-receipts.ts`, `helpers/prototype-companion-extraction.ts`, `helpers/prototype-read-extraction.ts`, `helpers/prototype-receiver-extraction.ts`, `helpers/resume-main-composition.ts`, `helpers/string-equality-source-composition.ts`, `helpers/typedarray-main-preservation-port.ts`.

### Covered elsewhere

- `lowering-cycle`'s test-local value-closure walker (reverse edge through a barrel, unsupported graph input):
  `check:import-cycles` enforces the no-cycle claim on the real graph.

### Owed (step 6: rules for `scripts/compiler-boundaries.json`)

The inventory's layer edges are coarser than each of these file-level import rules, so none is enforced today:

- `semantic-provider-boundary`: src/runtime/wasmgc/values/native-resource-declaration-types.ts has only type imports, from wasm/model/instructions and module-records, and declares only types (inventory gives it layer native-runtime, which allows more)
- `delay-combinator-layout-ownership`: src/runtime/wasmgc/promise/delay-combinator-layouts.ts imports only wasm/model/instructions (type), values/closure-layouts, promise/combinator-bodies (type)
- `native-accessor-call-bodies`: src/runtime/wasmgc/values/accessor-call-bodies.ts has one type-only import, wasm/model/instructions
- `native-object-get-bodies`: src/runtime/wasmgc/values/object-get-bodies.ts imports only wasm/model/instructions and ./object-get-arms; object-get-arms only wasm/model/instructions
- `native-object-key-foundation`: src/runtime/wasmgc/values/object-key-bodies.ts has one type-only import and no runtime import
- `native-to-primitive-bodies`: src/runtime/wasmgc/values/to-primitive-{,method-,wrapper-}bodies.ts import only wasm/model/instructions and each other, and declare no function types
- `promise-settlement-body-ownership`: the canonical settlement body owner imports only wasm/model/instructions (type), ./reaction-order-bodies, ./rejection-event-bodies; rejection-event-bodies only wasm/model/instructions (type); wasm/model/instructions imports nothing; no CodegenContext/AsyncSchedulerState in the owner
- `startup-contract`: src/ir/program/startup.ts (canonical startup contract) and the two shared contracts it reaches import type-only and emit no runtime code (export {} only)
- `vector-grow-store-body`: the vector grow/store body module imports type-only from wasm/model/instructions and module-records, and does not mention CodegenContext/currentFunc/process/globalThis
- `native-wasm-foundation`: src/wasm/model/instructions.ts imports nothing; src/wasm/physical/function-handles.ts imports type-only from model/instructions and model/module-records; src/runtime/wasmgc/async/microtask-queue-bodies.ts imports type-only from wasm/model/instructions
- `core-vocabulary-seam`: the three moved core vocabulary leaves import nothing; the fourth imports type-only IrSourceId/IrUnitId from shared/contracts/ir-identity; ir-identity imports only source-origin; source-origin imports nothing

### Owed (step 5d)

None. `check:dead-exports` passes unchanged, so no `src/` export lost its last reader with the pins.

### Per-batch runs

`VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, at most six files per run, each run on the file's final
content (the utf8-rope file was re-run alone after its setup loop was restored: 74/74).

| batch | files | result |
| ---: | --- | --- |
| 1 | canonical-instruction-walk, closure-state-preservation-port, native-number-format-ownership, capability-schema-boundary, capability-schema-seam (+certified-delay-source-admission: red at base, reverted) | 5 files green; delay-admission red at base |
| 2 | certified-delay-source-identity, host-utf8-literal-keys, native-family-source-contract, native-object-access-resources, native-promise-inventory-planning, native-string-output-consumer | 6/6, 183 tests, exit 0 |
| 3 | native-string-output-requirements, 3521-runtime-callable-abi, 3525-prepared-source-map-data (+3 files red at base: mixed-presentation, wit-presentation, zero-suspension-rejection; reverted) | 3 files green; 11 failures identical at base |
| 4 | async-frame-body-source-preservation, delay-combinator-layout-ownership, 3525-prepared-linear-early-return | 3/3, 28 tests, exit 0 |
| 5 | lowering-contract-owner, lowering-relocation-coverage, module-reservations, native-accessor-call-bodies, native-bigint-primitive-bodies, native-boolean-boxes | 6/6, 283 tests, exit 0 |
| 6 | native-family-callable-declarations, native-object-get-bodies, native-object-key-foundation, native-ref-cell-resources, native-ryu-ownership, native-scanner-source-preservation | 6/6, 118 tests, exit 0 |
| 7 | native-string-error-resources, native-string-flatten-resources | 2/2, 31 tests, exit 0 |
| 8 | native-string-number-resources, native-string-utf8-rope, native-to-primitive-bodies, native-utf8-window-decoder, physical-snapshot-comparison (+program-codec-replay red at base, reverted) | 5 files green, 272 tests; codec-replay's 1 failure identical at base |
| 9 | promise-resolution-preservation, promise-settlement-body-ownership, promise-settlement-source-preservation | 3/3, 22 tests, exit 0 |
| 10 | runtime-data-contract-seam, startup-contract, semantic-verification-ownership, timer-publication-contract, typed-middleend-controls, vector-grow-store-body | 6/6, 142 tests, exit 0 |
| 11 | vector-grow-store-donor, vector-runtime-callable-admission, to-primitive-wrapper-forward | 3/3, 136 tests, exit 0 |
| 12 | native-wasm-foundation, core-vocabulary-seam, allocation-runtime-seam, certified-delay-source-identity, core-nodes-seam, lowering-cycle | 6/6, 117 tests, exit 0 |
| 13 | native-delay-combinator-source-preservation, prototype-seeder-bodies | 2/2, 7 tests, exit 0 |
| 14 | 3521-r2-withdrawal-telemetry, 3526-callable-boundary-callback, 3526-string-boundary-concat-many (+3 files red at base: f3s3, charcodeat, compare; reverted) | 3 files green; the 7 remaining failures are identical at base |
| 15 | 3526-string-boundary-const (+4 files red at base: concat, eq, len, schema; reverted) | const green; 12 failures identical at base |
| 16 | 3525-emitted-physical-plan-observation, 3527-async-replay-oracle | 2/2, 25 tests, exit 0 |

### Gates (each run bare, at the head of this branch)

| gate | exit |
| --- | ---: |
| `npm run -s typecheck` | 0 |
| `npm run -s check:dead-exports` | 0 |
| `node scripts/check-loc-budget.mjs` | 0 |
| `node scripts/check-func-budget.mjs` | 0 |
| `node scripts/check-orphaned-scripts.mjs` (49 of 305, baseline 49) | 0 |
| `npm run -s check:import-cycles` | 0 |
| `JS2WASM_EVAL_ENGINE=interpreter sh scripts/hooks/changed-root-tests.sh` | 0 |

The hook diffs against the `origin/main` merge base, so it sees 85 changed root files (this branch plus 2a and 2b) and
runs the first 20 (all pass). The other 2c files are covered by the batch table; the 2a / 2b files by 2b's table.

### Not done: the other families

The same pass flags 261 files outside the 35xx families. They are **not reviewed**; the class below is the
classifier's and is provisional: many are false positives of the same kinds as the K rows above (dogfood and
linker tests that compile `src/` files, tests that read `src` paths into a compile, tests of scripts). Sites are
pin / mixed / behaviour as the pass counts them.

| family | files (provisional class, pin/mixed/behaviour sites) |
| --- | --- |
| (unnumbered) (42) | `es5-a17-method-call-gate` P 2/0/0; `es5-a17-with-scoped-function` P 2/0/0; `es5-a19-redeclared-with-function` P 1/0/0; `es5-computed-harness-method-regression` P 3/0/0; `es5-date-accessor-carrier` P 1/0/0; `es5-function-constructor-residuals` P 1/0/0; `es5-live-baseline-regressions` P 1/0/0; `es5-standalone-annexb-global-script-eval` P 2/0/0; `es5-standalone-assignment-eval-scope` P 1/0/0; `es5-standalone-error-date-residual` P 1/0/0; `es5-standalone-object-valueof-detached` P 1/0/0; `es5-standalone-regexp-nested-groups` P 1/0/0; `es5-standalone-regressions-2026-09-rows` P 1/0/0; `es5-standalone-static-eval-class` P 2/0/0; `es5-standalone-string-concat-variadic` P 1/0/0; `es5-standalone-string-tag-residual` P 2/0/0; `es5-standalone-vector-expando-descriptors` P 1/0/0; `es5-string-coercion-residuals` P 2/0/0; `es5-this-binding-quad` P 3/0/0; `exhausted-parameter-rest` P 1/0/0; `host-destructuring-regressions` P 4/0/0; `host-proxy-promise-class-regressions` P 3/0/0; `standalone-transition-residuals` P 3/0/0; `test262-errors` P 1/0/0; `test262` P 1/0/0; `linker-e2e` P? 0/3/0; `linker-self-host` P? 0/2/0; `test262-vitest` P? 0/1/0; `es5-function-call-apply-null` T 1/0/3; `es5-function-callee-with` T 1/0/2; `es5-standalone-array-filter` T 2/0/11; `es5-standalone-ctor-identity` T 1/0/9; `es5-standalone-getownpropertydescriptor` T 1/0/2; `es5-standalone-global-gopn` T 1/0/2; `es5-standalone-harness-selftests` T 1/0/1; `es5-standalone-number-format` T 1/0/7; `es5-standalone-regexp-xml-shallow` T 1/0/1; `ir-bytecode-wasmgc-vm` T 0/9/5; `playground-acorn-artifact` T 1/0/4; `playground-ts-erase-types` T 3/0/1; `test262-harness-truth-table` T 0/2/3; `test262-per-lane-gating` T 1/0/22 |
| dogfood/ (14) | `dogfood/acorn-official-suite` P 1/0/0; `dogfood/dogfood-surface-modules` P 6/0/0; `dogfood/eslint` P 1/0/0; `dogfood/marked` P 1/0/0; `dogfood/prettier` P 1/0/0; `dogfood/react` P 1/0/0; `dogfood/temporal-polyfill` P 2/0/0; `dogfood/acorn` T 1/0/2; `dogfood/clsx` T 1/0/1; `dogfood/cookie` T 1/0/1; `dogfood/lit-upstream-suite` T 0/1/2; `dogfood/npm-compat-catalog` T 2/0/3; `dogfood/react-dom-upstream-suite` T 1/0/17; `dogfood/typescript-harness-verdicts` T 0/1/14 |
| issue-10xx (2) | `issue-1014` T 1/0/9; `issue-1096-env-adapter` T 5/0/5 |
| issue-12xx (2) | `issue-1222` T 4/0/2; `issue-1240` T 1/0/4 |
| issue-13xx (3) | `issue-1318` P 3/0/0; `issue-1363` T 1/0/5; `issue-1378` T 1/0/3 |
| issue-16xx (3) | `issue-1601` P 1/0/0; `issue-1627` T 3/0/6; `issue-1672-async-gen-method-trampoline` T 1/0/5 |
| issue-17xx (2) | `issue-1712-reflection-identity` T 3/0/5; `issue-1764` T 2/0/2 |
| issue-18xx (1) | `issue-1805` T 1/0/2 |
| issue-19xx (1) | `issue-1933` T 1/0/4 |
| issue-20xx (1) | `issue-2095-baseline-validator-lanes` T 1/0/1 |
| issue-21xx (2) | `issue-2180` P 2/0/0; `issue-2183` P 1/0/0 |
| issue-27xx (6) | `issue-2742-standalone-carveout` P 4/0/0; `issue-2743-pr2` P 1/0/0; `issue-2743` P 1/0/0; `issue-2717` T 1/0/7; `issue-2742-charat-transfer` T 2/0/2; `issue-2742-native-string-equality` T 1/0/2 |
| issue-28xx (1) | `issue-2818` T 1/0/20 |
| issue-29xx (5) | `issue-2940` P 2/0/0; `issue-2955-depolymorph-gate` P 1/0/0; `issue-2928` P? 0/1/0; `issue-2934-tostring-dispatch-s3` T 1/0/5; `issue-2970` T 1/0/8 |
| issue-30xx (7) | `issue-3024-packed-array-dstr-normalize` P 1/0/0; `issue-3024-tostring-closure-funcref` P 1/0/0; `issue-3035` P 1/0/0; `issue-3086` P 6/0/0; `issue-3017-function-poison-pill` T 4/0/6; `issue-3024-iterator-dispatch-arity` T 1/0/2; `issue-3024-module-global-slot-desync` T 2/0/3 |
| issue-31xx (2) | `issue-3149-map-groupby-group-vec-coercion` P 3/0/0; `issue-3188` T 1/0/3 |
| issue-33xx (8) | `issue-3368` P 4/0/0; `issue-3369-project-runner` P 1/0/0; `issue-3318` T 2/0/2; `issue-3349` T 1/0/1; `issue-3367` T 1/0/1; `issue-3370` T 2/0/3; `issue-3371-r4-reflect-construct-newtarget` T 4/0/2; `issue-3371` T 3/0/10 |
| issue-34xx (8) | `issue-3428` P 4/0/0; `issue-3429` P 4/0/0; `issue-3488` P 2/0/0; `issue-3420-species-result-store` T 1/0/1; `issue-3420-standalone-array-own-property` T 1/0/1; `issue-3422` T 1/0/2; `issue-3470` T 3/0/4; `issue-3498-landing-four-lane-backend-benchmark` T 1/0/7 |
| issue-35xx (2) | `issue-3507` T 1/0/5; `issue-3534-closure-value-representation` T 2/0/4 |
| issue-36xx (6) | `issue-3669` P 10/0/0; `issue-3673-fast-tokenizer` P 2/0/0; `issue-3613-render-parity` T 2/0/5; `issue-3628-legacy-residue` T 1/0/1; `issue-3666` T 1/0/2; `issue-3683-proto-method-write-once` T 2/0/8 |
| issue-37xx (9) | `issue-3779-cookie-ground-fold` P? 2/1/0; `issue-3762` T 1/0/1; `issue-3763-string-indexof-undefined-search` T 1/0/2; `issue-3764-reference-array-oob-undefined` T 1/0/2; `issue-3766-string-indexof-receiver-coercion` T 3/0/6; `issue-3770-regexp-boolean-getters` T 1/0/1; `issue-3771-json-rawjson-symbol` T 1/0/2; `issue-3776-es5-isfrozen-intrinsics` T 1/0/3; `issue-3778-ground-call-fold` T 2/3/5 |
| issue-39xx (2) | `issue-3973` P 2/0/0; `issue-3984` P 2/0/0 |
| issue-41xx (2) | `issue-4167-test262` P 2/0/0; `issue-4162` T 1/0/7 |
| issue-42xx (3) | `issue-4252-computed-key-call` T 1/0/5; `issue-4262-error-substrate` T 1/0/4; `issue-4276-instanceof-object-family` T 2/0/17 |
| issue-43xx (3) | `issue-4393-annexb-if-switch-lifecycle` P 3/0/0; `issue-4376-eval-alias-regression` T 1/0/1; `issue-4390-global-function-descriptors` T 1/0/2 |
| issue-44xx (5) | `issue-4447-mg-regressions` P 3/0/0; `issue-4428` T 1/0/7; `issue-4453-tdz-shadowed-block` T 2/0/14; `issue-4485` T 2/0/6; `issue-4491-wave4` T 1/0/17 |
| issue-45xx (5) | `issue-4525-moment-closure-validation` P? 0/1/0; `issue-4516-es5-residuals` T 3/0/6; `issue-4520-abi-carrier-differential` T 2/0/3; `issue-4521-legacy-caller-policy` T 1/0/2; `issue-4556-builtin-proto-member-override` T 1/0/5 |
| issue-46xx (20) | `issue-4639` P 5/0/0; `issue-4640` P 1/0/0; `issue-4641` P 3/0/0; `issue-4643` P 1/0/0; `issue-4655-concat-carrier` P 2/0/0; `issue-4675` P 2/0/0; `issue-4679` P 1/0/0; `issue-4685` P 2/0/0; `issue-4690` P 1/0/0; `issue-4693` P 2/0/0; `issue-4694` P 1/0/0; `issue-4621` T 2/0/1; `issue-4622` T 1/0/18; `issue-4624` T 4/0/11; `issue-4653` T 3/0/25; `issue-4655` T 2/0/1; `issue-4656` T 2/0/35; `issue-4688` T 2/0/1; `issue-4689` T 1/0/1; `issue-4691` T 2/0/2 |
| issue-47xx (39) | `issue-4701` P 1/0/0; `issue-4705` P 3/0/0; `issue-4708` P 1/0/0; `issue-4710` P 2/0/0; `issue-4711` P 3/0/0; `issue-4712` P 2/0/0; `issue-4713` P 4/0/0; `issue-4714` P 1/0/0; `issue-4715` P 1/0/0; `issue-4716` P 2/0/0; `issue-4718` P 1/0/0; `issue-4719` P 1/0/0; `issue-4720` P 1/0/0; `issue-4723` P 1/0/0; `issue-4731` P 1/0/0; `issue-4736` P 2/0/0; `issue-4738` P 2/0/0; `issue-4749` P 2/0/0; `issue-4750` P 2/0/0; `issue-4760` P 3/0/0; `issue-4700` P? 0/2/0; `issue-4745` P? 0/3/0; `issue-4746` P? 0/3/0; `issue-4776-symbol-prototype-valueof` P? 0/4/0; `issue-4779-bigint-tostring-symbol-radix` P? 0/4/0; `issue-4781-weakmap-constructor-prototype` P? 0/2/0; `issue-4785-weak-collection-primitive-keys` P? 0/4/0; `issue-4709` T 2/0/1; `issue-4737` T 2/0/1; `issue-4741` T 2/0/1; `issue-4742` T 2/0/1; `issue-4743` T 2/0/1; `issue-4744` T 2/0/1; `issue-4747` T 2/0/2; `issue-4748` T 2/0/1; `issue-4759-module-namespace` T 1/0/4; `issue-4777` T 2/0/2; `issue-4778-arraybuffer-isview-no-arg` T 2/0/1; `issue-4783-number-formatter-symbol` T 2/0/1 |
| issue-49xx (4) | `issue-4922-generator-arguments` P 1/0/0; `issue-4922-object-global-call` P 2/0/0; `issue-4922-runtime-eval-object-callable` P 1/0/0; `issue-4922-s13-function-binding` P 1/0/0 |
| issue-50xx (1) | `issue-5091-set-foreach-symbol-callback` T 2/0/2 |
| issue-51xx (12) | `issue-5100-set-newtarget` T 4/0/2; `issue-5102-isnan-toprimitive` T 1/0/1; `issue-5117-dataview-byteoffset-symbol` T 2/0/5; `issue-5118-es2015-error-symbol-coercion` T 2/0/17; `issue-5119-es2015-reflect-symbol-target` T 1/0/10; `issue-5120-es2015-array-find-symbol-length` T 1/0/10; `issue-5123-es2015-escape-symbol-tostring` T 2/0/5; `issue-5137-es2015-dataview-setter-undefined-carrier` T 3/0/7; `issue-5150-es2015-buffers` T 1/0/10; `issue-5195-es2015-class-r2` T 1/0/59; `issue-5195-r3-heritage-check` T 1/0/5; `issue-5195-r3-restricted-properties` T 1/0/7 |
| issue-52xx (5) | `issue-5213-es2015-class-prototype-accessor` T 1/0/1; `issue-5253` T 1/0/4; `issue-5254` T 1/0/4; `issue-5272-runner-standalone-leak` T 3/0/2; `issue-5298-kind-neutrality-stable-evidence` T 2/0/3 |
| issue-53xx (4) | `issue-5318-r4-computed-accessor-keys` T 1/0/28; `issue-5318-r5-objlit-computed-accessor-keys` T 1/0/13; `issue-5380-length-bounded-push-loop` T 0/1/2; `issue-5383-class-value-dynamic-call` T 1/0/1 |
| issue-57xx (1) | `issue-5738-destructuring-iterator-order` T 1/0/1 |
| issue-64xx (1) | `issue-6492-r28-trycatch-planner-checker` P 6/0/0 |
| issue-66xx (1) | `issue-6661-npm-compat-opaque-lane-diagnostic` T 1/0/2 |
| issue-67xx (1) | `issue-6794-cli` T 1/0/11 |
| issue-68xx (2) | `issue-6865-linear-layout-contract` T 2/0/22; `issue-6892-linear-repeat-bulk-copy` T 0/1/6 |
| issue-69xx (4) | `issue-6920-allocation-provenance-preservation` P 16/0/0; `issue-6920-allocation-rule-sharing-preservation` P 12/0/0; `issue-6976-original-call-apply-controls` P 1/0/0; `issue-6915-linear-owned-ascii-append-copy-kernel` T 1/0/4 |
| issue-6xx (1) | `issue-671-with-w1` T 1/0/8 |
| issue-70xx (1) | `issue-7012-regime-temporal-string-field` T 2/0/1 |
| issue-71xx (3) | `issue-7106-eval-void-call-splice` T 1/0/1; `issue-7143-legacy-reach-blockers` T 1/0/2; `issue-7190-prophelper-not-and-logical` T 2/0/4 |
| issue-72xx (6) | `issue-7281-throw-scalar-concat` P 1/0/0; `issue-7260-ir-move-only-dynamic-key-store` T 4/0/1; `issue-7265-ir-move-only-bool-call-into-dynamic` T 1/0/1; `issue-7274-ir-native-arraybuffer` T 9/0/4; `issue-7277-ir-param-legacy-refined-slot` T 0/1/2; `issue-7283-ir-verify-property-chain` T 2/0/1 |
| issue-73xx (6) | `issue-7380-prepared-production-setting` P? 1/1/0; `issue-7305-dynamic-function-value-call` T 1/0/2; `issue-7330-string-compound-operand` T 1/0/2; `issue-7331-carrier-return-into-number` T 1/0/3; `issue-7332-null-into-number` T 1/0/2; `issue-7334-reassigned-callable-module-var` T 1/0/2 |
| issue-7xx (1) | `issue-779c` P 5/0/0 |
| issue-8xx (1) | `issue-833-html-like-comments` T 1/0/5 |
