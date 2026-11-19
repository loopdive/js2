---
id: 7355
title: "Fold the duplicated canonical-provider comparisons and SSA value-type maps of the IR runtime"
status: done
sprint: current
created: 2026-11-17
updated: 2026-11-19
completed: 2026-11-19
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
related: [7354, 3518]
---

# #7355 — Fold the duplicated provider comparisons and SSA value-type maps

## Problem

Two helper families are copied across the IR runtime. #7354 D1 extracted one
shared helper for each but could not fold every copy in that slice:

1. **Canonical provider comparison.** `src/ir/runtime/canonical-provider-mismatch.ts`
   (`canonicalProviderMismatch`) serves the ordinary-object and dynamic-value
   families. Three families keep their own copy:
   - `vectorProviderMismatch` (`src/ir/runtime/vector-callables.ts`);
   - `nativeAsyncProviderMismatch` (`src/ir/runtime/native-async-callables.ts`),
     which also answers "foreign clock projection" for a non-canonical
     `standalone-clock-zero` row;
   - `numberRemainderProviderMismatch` (`src/ir/runtime/number-remainder-callables.ts`),
     which compares with its own `sameData` instead of JSON equality.
2. **SSA value-type maps.** `irValueTypes` (`src/ir/analysis/value-types.ts`)
   is the neutral map of each SSA value's defining type.
   `nativeAsyncCallableValueTypes` (`src/ir/runtime/native-async-callables.ts`)
   is the same walk, plus a conflict check that throws the async family's error.
   About ten more modules keep a private `valueTypesOf`, among them
   `generator-support.ts`, `intrinsic-preparation.ts`, `async-prepare-ir.ts`
   and `prepared-component-dependencies.ts`.

## Why it was not done in D1

- `vectorProviderMismatch` and `nativeAsyncProviderMismatch` are source-hash
  pinned by the #3518 historical reconstruction
  (`tests/issue-3518-historical-runtime-reconstruction.test.ts`). Folding them
  needs a reviewed replay step for those receipts, the same mechanism as
  `tests/helpers/same-value-nan-correction.ts`.
- `numberRemainderProviderMismatch` first needs a decision: is `sameData` or
  JSON equality the canonical comparison? They differ on key order and on
  `undefined` fields.
- Most `valueTypesOf` copies sit under relocation receipts too.

## Acceptance criteria

1. One canonical-provider comparison serves every family; family-specific
   answers, such as the foreign clock row, stay in the family's module.
2. `nativeAsyncCallableValueTypes` is `irValueTypes` plus the family's conflict
   check, and at least the unpinned `valueTypesOf` copies call `irValueTypes`.
3. Pins change only by reviewed replay steps; no behaviour or byte change.
   Failing-test sets of `tests/issue-3518*` and `tests/issue-3526*` match main.

## Implementation Plan (2026-11-19, base `origin/main` ee3fcdd610)

### Provider comparison — module `src/ir/runtime/canonical-provider-mismatch.ts`

- **The comparison.** `numberRemainderProviderMismatch`'s `sameData` becomes the canonical field comparison
  (decision): it compares own data properties, so a `toJSON` forgery and an explicit `undefined` field are
  rejected, which `tests/issue-3525-number-remainder-callables.test.ts` requires and JSON equality cannot give.
  JSON equality is order-sensitive on keys; `sameData` is not, so the only rows the switch could newly accept are
  key-reordered copies of the same data. Every canonical row is a frozen literal, so no shipped provider changes
  verdict.
- **Split.** `canonicalProviderRow(rows, provider)` (find by id or feature) and
  `canonicalProviderMismatch(rows, provider, family)`. Families:
  - ordinary object, dynamic value: unchanged calls;
  - vector: `canonicalProviderMismatch(VECTOR_CALLABLE_RUNTIME_PROVIDERS, …)` (one row, so the same as row 0);
  - number remainder: the shared call; its private `sameData` moves into the shared module;
  - native async: `canonicalProviderRow` first, the "foreign clock projection" answer for a row-less
    `standalone-clock-zero` provider stays in the family module, then the shared comparison.
- **Pins.** `vectorProviderMismatch` and `nativeAsyncProviderMismatch` are source-pinned by the #3518 historical
  reconstruction. Their new bodies get a hash-checked inverse span in the reconstruction helper, the same mechanism
  as `tests/helpers/same-value-nan-correction.ts`; receipts stay immutable.

### SSA value types — module `src/ir/analysis/value-types.ts`

- One walker, `forEachIrValueDefinition(fn, visit)`: parameters, async-plan values, typed block arguments, and
  every instruction result in block bodies and async-plan state bodies, nested buffers included.
  `irValueTypes` collects it into a map; `nativeAsyncCallableValueTypes` runs it with its conflict check.
- Copies that are the same walk call `irValueTypes`: `runtime/generator-support.ts`,
  `runtime/intrinsic-preparation.ts`, `prepared-component-dependencies.ts`, `prepared-dynamic-support.ts`,
  `analysis/linear-memory-plan.ts` (`collectValueTypes`). Left as they are, with the reason recorded in the
  result: `async-prepare-ir.ts` and `async-linear-prepare.ts` (a shallow walk without async-plan values; folding
  would add entries, which is a behaviour question, not a fold), `program-native-async-resources.ts`
  (`delayCombinatorValueTypes` reads occurrence records, not the function).
- A copy whose source is pinned by a receipt and cannot take a reviewed inverse step stays, with a note.

### Lanes

S2 (`claude/7354-perf2`) and S3 (`claude/7354-o`) change `runtime/dynamic-value-callables.ts` and the runtime
contracts only; S4 (`claude/7354-fa`) was not pushed at planning time. None of the helpers above is in their diff;
re-checked before each push.

### Acceptance (quality)

One provider comparison and one definition walker, each with every non-pinned copy folded into it; no family
module keeps a comparison loop or a private SSA walk it could share. Bytes identical on a 100-file test262 sample ×
gc/standalone; failing-test sets of `tests/issue-3518*`, `tests/issue-3526*` and `tests/issue-7354-*` equal to
main's.

## Result (2026-11-19, base `origin/main` ee3fcdd610)

- **Provider comparison.** `canonicalProviderMismatch` (`canonical-provider-mismatch.ts`) serves the
  ordinary-object, dynamic-value and number-remainder families, with number-remainder's `sameData` as the shared field
  comparison. Vector and native-async keep their own copies: their files are source-pinned (see RV7340 below).
- **SSA value types.** `irValueTypes` (`analysis/value-types.ts`, unchanged) replaces the private walks in
  `prepared-component-dependencies.ts`, `prepared-dynamic-support.ts` and `linear-memory-plan.ts`. Those walks
  skipped a block argument without a type; `IrBlock.blockArgTypes` is parallel to `blockArgs` by contract (checked
  in `integration.ts`), so the skip was a branch for a case that cannot occur.
- **Left as they are.**
  - `intrinsic-preparation.ts`'s `valueTypesOf`: its whole-file source pin (`runtime-preparation-relocation`) is
    live and green on main, so folding it would break a receipt.
  - `async-prepare-ir.ts` and `async-linear-prepare.ts`: these are shallow walks, and folding them would add
    entries, which is a behaviour change.
  - `program-native-async-resources.ts`: it reads occurrence records, not the function.
- **Lines in `src/`.** The first cut was net −82 lines over 9 files; after RV7340 round 1 it is 5 files, +30/−91.
- **Tests.** The whole unit suite ran on base and branch in 8 chunks (14,095 rows in chunks 0–4 and 6–7). Chunk 5
  ran per file with a 6 GB heap, because it runs out of memory as a batch.
  - No test that passes on base fails on the branch. 12 rows first read as branch-only failures; they pass
    133/133 on both trees when re-run alone, so they were load timeouts.
  - Pass/fail counts: `issue-3526*` 373/33 on both; `issue-7354-*` 649/0 on both.
  - `issue-3518-program-abi-seam` runs out of memory on both trees.
- **Byte identity.** 100 test262 files × gc/standalone, binaries identical (200/200).

## Review round 1 (RV7340, 2026-11-19, on aad4c56365): BLOCKER

| finding | answer |
| --- | --- |
| Must-fix: `vector-callables.ts`, `native-async-callables.ts` and `generator-support.ts` are source-pinned. Their receipts pass on base and failed on head, hidden by families already red on main. | Fixed: the three files are back to base, and their sha256 prefixes (`b594f734`, `31b3cb6a`, `afc937aa`) match the pins again. Their folds wait for #7417's rework of the #3518 receipts. `forEachIrValueDefinition` and `canonicalProviderRow` lost their second user, so they are gone and `value-types.ts` is unchanged. |
| Should-fix: the shared comparison moved from `JSON.stringify` to `sameData`. Key-reordered rows are now accepted; `toJSON` forgeries and explicit-`undefined` fields are rejected. | **Decision: keep `sameData`.** A provider row is finite data, and a custom serializer must not be able to stand in for it, which is the rule number-remainder already had. It now holds for ordinary-object and dynamic-value too. Vector and native-async keep `JSON.stringify` until they can be folded. `tests/issue-7355-canonical-provider-mismatch.test.ts` pins it per family: 9 rows. On base, the 6 ordinary-object and dynamic-value rows fail; the 3 number-remainder rows pass, since that family already compared as data. |
| Nit: `value-types.ts` made a third copy of the "block + async-state bodies" list. | Gone: `value-types.ts` is back to base, and the list stays only in the two pinned files and `linear-integration.ts`, as before. |

Round-1 measurements on the fixed tree:

- **Tests.** 44 test files that import a changed module (the all-red #3518 historical reconstruction excluded) ran
  per file with a 6 GB heap on base and on this tree: 3,209 rows each. The only difference is the 6 new pins.
- **Byte identity.** 100 test262 files × gc/standalone: 200/200 identical to base.
- **Gates.** loc and func (also at origin/main), coercion sites, oracle ratchet, dead exports and import cycles all
  exit 0.

