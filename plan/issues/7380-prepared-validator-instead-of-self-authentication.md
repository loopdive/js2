---
id: 7380
title: "Prepared path: replace self-authentication (receipts, census, forgery pins, layout audits) with one validator"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
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

## PR 2a result

In progress on `claude/7380-pins-a` (base `claude/7380-validator`).

### Before: every `tests/issue-3518-*.test.ts` on the base

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

<!-- before-table:end -->
