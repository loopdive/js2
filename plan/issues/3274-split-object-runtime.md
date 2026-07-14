---
id: 3274
title: "Decompose ensureObjectRuntime: extract descriptor/integrity helper builders (WAVE-B slice 1)"
status: in-progress
created: 2026-07-14
updated: 2026-07-14
priority: high
feasibility: hard
horizon: l
reasoning_effort: max
task_type: refactor
area: codegen
goal: maintainability
sprint: current
subtask_of: 3182
assignee: ttraenkler/Dev-WaveB-ObjRuntime
related: [3182, 742, 808]
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
coercion-sites-allow:
  - src/codegen/object-runtime-descriptors.ts
---

# #3274 — Decompose `ensureObjectRuntime` (WAVE-B slice 1: descriptor + integrity)

## Problem

`ensureObjectRuntime` in `src/codegen/object-runtime.ts` is a ~7,378-LOC single
function (the file's remaining core after the wave-1 Proxy split; file ~10,149
LOC). It sequentially BUILDS the whole standalone-native open-object runtime —
dozens of `registerNative(...)` helper-build blocks that all share a captured
scope (the `registerNative` minter, the object-runtime type indices / ValType
aliases, dependency func indices, and the `$PropEntry.$flags` / `$Object.flags`
bit constants). This is a WAVE-B (mega-function decomposition) target under the
code-bloat elimination epic #3182.

## Approach — byte-identical intra-function decomposition

Extract cohesive groups of helper-builds into named helper functions in NEW
sibling modules, replacing each inline block with a single call that threads the
captured scope through a typed state bundle. The gate is
`scripts/prove-emit-identity.mjs`: baseline BEFORE, `check` AFTER each slice MUST
print `IDENTICAL` (39/39 gc/standalone/wasi). `tsc --noEmit` stays 0.

Because the relocation is verbatim (the moved code is character-for-character
identical; the only additions are a destructuring preamble in the new function
and a state-object literal at the call site), the `registerNative` call ORDER —
and therefore the minted func-index sequence and the emitted Wasm — is preserved
exactly. This is an intra-function relocation, so the oracle-ratchet is net-zero
(#3070, change-scoped/net-per-field).

## Slice 1 (this issue) — descriptor + integrity group

Extracted the `__defineProperty_value` … integrity-SET-path block (~2,464 LOC,
former lines 5052–7515) VERBATIM into `src/codegen/object-runtime-descriptors.ts`
as `buildObjectDescriptorHelpers(ctx, state)`. Helpers relocated:

- `__defineProperty_value` / `__defineProperty_accessor` (define one property)
- `__defineProperties` (plural define)
- `__obj_define_from_desc` (dynamic single-descriptor apply)
- `__getOwnPropertyDescriptor` (descriptor read-back)
- `__create_descriptor` / `__create_accessor_descriptor` (descriptor objects)
- `__getOwnPropertyNames` / `__getOwnPropertySymbols` (own-key enumeration)
- `__object_getOwnPropertyDescriptors` / `__object_fromEntries`
- `__object_isFrozen` / `__object_isSealed` / `__object_isExtensible` (integrity predicates)
- `__object_preventExtensions` / `__object_seal` / `__object_freeze` (integrity set path)

`ensureObjectRuntime` shrinks from ~7,378 → ~4,950 LOC; `object-runtime.ts` from
10,149 → 7,721 LOC.

### Why the state bundle (implementation note)

The block reads a fixed set of values from the enclosing scope. Rather than
re-derive them (which would risk drifting the `registerNative` minting order),
they are threaded through `ObjectDescriptorHelperState` and destructured at the
top of the extracted function, so the moved body is textually unchanged:

- **The `registerNative` closure itself** (captures `ctx`) — passing the SAME
  closure object preserves func-index minting order.
- **Type indices**: `anyStrTypeIdx`, `nativeStrTypeIdx`, `propEntryTypeIdx`,
  `propMapTypeIdx`, `objectTypeIdx`, plus `symbolKeysEnabled`.
- **ValType aliases**: `objRefNull`, `propMapRef`, `entryRefNull`.
- **Dependency func indices** (already registered earlier in the pass):
  `strFlattenIdx`, `strEqualsIdx`, `objFindIdx`, `objInsertIdx`, `objGrowIdx`,
  `objVecNewIdx`, `objVecPushIdx`, `objIndexOfKeyIdx`, `objOrderedIdx`,
  `objOrderedAllIdx`, `externSetIdx`, plus optional `bfnGopdIdx` /
  `bfnPushOwnNamesIdx`.
- **Shared bit constants**: `NONE_HEAP`, `FLAG_WRITABLE`, `FLAG_ENUMERABLE`,
  `FLAG_CONFIGURABLE`, `FLAG_ACCESSOR`, `OBJ_FLAG_NONEXTENSIBLE`,
  `OBJ_FLAG_SEALED`, `OBJ_FLAG_FROZEN`, `WRAPPER_PRIMITIVE_KEY`.

`externGetIdx` is NOT captured — it is (re)declared block-locally inside the
`__defineProperty_accessor` and `__obj_define_from_desc` blocks, so it stays
self-contained. `emitIntegrityPredicate` / `emitSetFlags` are defined AND used
entirely within the extracted region, so they move with it. The constants are
passed via state (not imported) to avoid a new `object-runtime ↔ descriptors`
import cycle. Cross-module utility functions (`addStringConstantGlobal`,
`emitSelfHostedFunc`, `stringConstantExternrefInstrs`, `nativeStringLiteralInstrs`,
`undefinedExternInstrs`, `undefinedSingletonActive`, `emitWasiErrorConstructor`,
`ensureExnTag`, `addUnionImportsViaRegistry`, `SELF_HOSTED_OBJECT_RUNTIME`) are
imported directly from their original source modules.

## Acceptance criteria

- `scripts/prove-emit-identity.mjs check` → `IDENTICAL` (39/39). ✓
- `tsc --noEmit` → 0 errors. ✓
- `tests/issue-3274.test.ts` — descriptor/integrity helpers reachable and correct
  under `--target standalone` with zero host imports. ✓
- No behavioural change (pure relocation).

## Test Results

`tests/issue-3274.test.ts` (4 tests, all pass): `__defineProperty_value`,
`__defineProperty_accessor`, and `__getOwnPropertyDescriptor` (writable flag +
value read-back) exercised end-to-end in standalone with `env` imports empty.
Byte-identity `check` prints `IDENTICAL` across all 39 (file,target) emits.
