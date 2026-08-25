---
id: 4461
title: "IR: model the native $Map struct as module-binding storage so Map claims in standalone"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
assignee: ttraenkler/opus-4461
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
related: [4457, 3518, 2856, 1103]
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/module-bindings.ts
  - src/ir/integration.ts
  # +7/+4 below are merge-resolution artifacts of the queue-bot's main-merge
  # (985b8f0d interleaving #4575/#4581 god-file edits with this branch's
  # #4457-based edits), not new feature code in the barrels.
  - src/ir/select.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/from-ast.ts::lowerMethodCall
  - src/codegen/index.ts::planIrOverlay
---

# #4461 — IR has no storage model for the native `$Map`, so `Map` never claims in standalone

Spun out of **#4457** (standalone-lane `body-shape-rejected` attribution). This
is one of the two chains that issue measured but deliberately did not attempt.

## Problem

Two units of the `check:ir-only` **standalone** reference corpus are blocked on
exactly one missing representation:

| unit | reject arm |
|------|-----------|
| `website/playground/examples/js/algorithms.ts::fibMemo` | `expr-module-storage-unrepresentable` |
| `website/playground/examples/js/algorithms.ts::<module-init>` | `body-shape-rejected` |

Both come from a single module binding:

```ts
const fibCache = new Map<number, number>();       // <module-init>

function fibMemo(n: number): number {
  if (n < 2) return n;
  const hit = fibCache.get(n);                     // fibMemo
  if (hit !== undefined) return hit;
  const v = fibMemo(n - 1) + fibMemo(n - 2);
  fibCache.set(n, v);
  return v;
}
```

The **host** lane claims both (37/37, zero fallbacks). The asymmetry is not
shape coverage — it is that the IR knows exactly one `Map` representation, and
it is the wrong one for standalone.

## Root cause

`src/ir/module-bindings.ts` gates builtin-Map module storage on:

```ts
allowBuiltinMapExtern: jsHostExterns && !ctx.nativeStrings
```

(`src/codegen/index.ts:2498`, mirrored at `src/ir/integration.ts:885`), consumed
by `externClassNameForType` against `MODULE_EXTERN_BUILTINS = new Set(["Map"])`.
So the IR represents a module-level `Map` **only** as a host-extern handle.

In standalone, `jsHostExterns` is false (and `nativeStrings` is true), so the
predicate is false twice over and the binding is reported unrepresentable —
even though **legacy standalone lowers `Map` perfectly well**, to the WasmGC
native `$Map` struct (#1103a, `src/codegen/index.ts:8882`), the same backing
store `Set`/`WeakMap`/`WeakSet` reuse (#2162).

So the gap is a missing IR storage kind, not a missing capability in the
backend.

## Acceptance criteria

1. The IR can represent a module-level `Map` binding backed by the native
   `$Map` struct, distinct from the existing host-extern handle representation.
2. `fibMemo` and `<module-init>` of `algorithms.ts` are `emitted` in the
   standalone lane of `pnpm run check:ir-only`; the standalone lane's
   `emittedFloor` / `irBodyEmittedFloor` ratchet up by 2 (standalone-lane-only;
   host lane stays 37/37 READY).
3. Selector claim ⇔ lowering parity: `.get`/`.set` on a native-`$Map` binding
   lower, and a runtime check compiles standalone, runs, and matches node for
   `fibMemo`.
4. No growth in `pnpm run check:ir-fallbacks`; `node scripts/gen-ir-adoption.mjs --check` clean.

## Implementation Plan (sketch)

1. **Split the representation, do not widen the flag.** Resist simply setting
   `allowBuiltinMapExtern: true` for standalone — that would claim the binding
   and then hand `from-ast` a host-extern lowering that does not exist, which
   is precisely the failure mode #4457 recorded on the sibling console chain
   (`assertNotDeferred` fires with an `unexpected-internal-throw`). Add a
   distinct storage kind (e.g. `native-map`) alongside the extern one in
   `src/ir/module-bindings.ts`, selected on the same target facts the backend
   uses (`nativeStrings` / standalone), so the selector's verdict and the
   available lowering are decided by one predicate.
2. **Thread it through the resolver surface.** `externClassNameForType` and the
   `exactModuleMapMethod` / `isExactModuleMapGenericInitializer` guards in
   `src/ir/select.ts` currently assume the extern form; they need to accept the
   native form with the same arity rules (`get`/1, `set`/2) and the same
   `moduleExternConsumerIsProven` discipline for the `get` result. Note the
   existing deliberate carry of `Map.get`'s result as externref until a strict
   `undefined` check proves the value branch — `fibMemo`'s
   `if (hit !== undefined) return hit;` is exactly that shape, so the native
   form must preserve it rather than shortcut it.
3. **Lowering in `src/ir/from-ast.ts`** to the native `$Map` helpers legacy
   already emits; reuse those funcMap entries rather than minting parallel
   ones, so IR and legacy agree bit-for-bit.
4. **Capability row.** If the native-map surface is target-gated, give it a row
   in `src/ir/capability.ts` (the standalone-* capability family in
   `src/ir/backend/legality.ts` is the established idiom) so the builder's
   `assertNotDeferred` guard and the selector consult one table.
5. **Ratchet** `scripts/ir-only-baseline.json` standalone-lane-only, per the
   #4555 pattern.

## What was built

The plan's step 1 held: `native-map` is a **distinct** `IrModuleBindingValueKind`
selected by a new `allowNativeMapStorage` option (`= ctx.nativeStrings`),
complementary to `allowBuiltinMapExtern` and never both true. `select.ts` then
treats the two carriers uniformly through two shared predicates
(`isIrModuleReferenceValueKind` for the extern-consumer discipline,
`isIrModuleMapValueKind` for the `Map`-specific arms), so the existing
`exactModuleMapMethod` / `isExactModuleMapGenericInitializer` /
`moduleExternConsumerIsProven` machinery — including the deliberate carry of
`Map.get`'s result until a strict `undefined` check — applies unchanged.

Steps 3 and 4 landed differently from the sketch, and the difference is the
substantive design decision:

- **Lowering goes through three externref-ABI adapters** (`src/codegen/ir-native-map.ts`)
  rather than direct `__map_*` calls from the IR. The `$Map` helper ABI is
  `(ref $Map, anyref, …)`; the IR has neither a native-collection reference
  type nor a boxing primitive, so a direct call would have required teaching
  the middle end both. The adapters call the SAME `__map_new` / `__map_get` /
  `__map_set` helpers legacy calls — one hash table, not two.
- **The adapter ABI is f64-keyed on purpose.** That is the capability
  statement, not a shortcut: the selector claims a native-map `.get`/`.set`
  only where the checker proves every key and value is a number, so the
  adapter surface and the claim surface are the same set. Widening to string
  keys means adding an adapter AND widening the proof, in one change.
- **No capability row was needed** (step 4). The single predicate
  `nativeMapStorageType()` on the lower resolver decides every arm, so there
  is no second table for a capability row to keep in sync.

Two providers had to learn they are not host-only, because a native `$Map`
read reaches sites nothing else in a host-free lane reached before:
`__extern_is_undefined` (load-bearing under the #2106 non-null `undefined`
singleton) and `__unbox_number`. Both exist as real Wasm functions on host-free
lanes under the same name and signature, so the arms now ask the resolver which
provider this lane owns instead of emitting an `env` import into a standalone
module. Reserve-time provider **observation** was also needed: prepared-component
discovery runs before lowering and rejects a component whose external callables
have no planned Program ABI identity, so a runtime symbol the reserve pass mints
must be observed in that same pass.

## Test Results

Measured on this branch (base `4b64d25e`, the #4457 tip).

| gate | before | after |
|------|--------|-------|
| `check:ir-only` standalone `emitted` | 17 | **19** |
| `check:ir-only` standalone `unsupported` | 20 | **18** |
| `select/body-shape-rejected` (standalone) | 5 | **3** |
| `check:ir-only` single-host | 37/37 READY | 37/37 READY (unmoved) |
| `check:ir-fallbacks` | OK | OK, no unintended/post-claim/module-level growth |
| `gen-ir-adoption.mjs --check` | up to date | up to date |
| `tests/issue-4461.test.ts` | — | 5/5 |
| `tests/issue-4457.test.ts` | 4/4 | 4/4 (two counts updated: `body-shape-rejected` 5→3, split 17/20→19/18) |
| `pnpm run typecheck` | clean | clean |
| `tests/equivalence/{map-set-basic,ir-slice10-map-set,weakmap-weakset,ir-slice10-date}` | pass | pass (33/33) |
| `tests/equivalence/tdz-reference-error` | 6 failed / 3 passed | 6 failed / 3 passed (A/B'd on base — pre-existing, unrelated) |

`scripts/ir-only-baseline.json` ratcheted **standalone-lane-only**
(`emittedFloor`/`irBodyEmittedFloor` 17→19, `unsupportedCeiling` 20→18,
`select/body-shape-rejected` 5→3). The host lane's floors are untouched.

Acceptance criteria 1–4 are met. Criterion 3's runtime half is a real run, not
an inspection: `tests/issue-4461.test.ts` compiles the memo source standalone,
instantiates it against a `Proxy` import object that records every `env.*`
lookup, runs `test()`, and compares to the same algorithm evaluated in JS.
It passes and the recorded host-import list is **empty**.

## Known residual (NOT introduced here, measured)

A caller that pulls a module-binding reader into its own prepared component
fails preparation for **every** module-binding kind, not just native `$Map`:

```
source-global-outside-component: source global …module-tdz:0 belongs to
  non-candidate storage terminal …module-init:0
unplanned-abi-binding: external callable runtime|20:__new_ReferenceError
  has no Program ABI identity
```

Measured by A/B on this branch's merge base with an **f64 control** — a plain
`let total = 0` binding under the identical call graph reproduces the failure
byte-for-byte on base (`bump unsupported late-preparation-unsupported`,
`test invariant unpatched-slot`, `success: false`). So it is a pre-existing
prepared-component limitation for TDZ-guarded module globals. #4461 does not
cause it; it only makes a `Map`-using function reach it, because claiming
`fibMemo` opens the call-graph closure that previously rejected its caller.

One #4461-owned item is currently **masked** by that residual and should be
closed when it is lifted: the native-map binding's IrType is
`{ kind: "val", val: { kind: "ref_null", typeIdx: $Map } }`, a module-relative
type index, which prepared-component discovery rejects with
`implicit-support-reference-unavailable: raw IR reference type ref_null:N has
no symbolic Program ABI type ref`. Closing it means giving the carrier a
symbolic `IrTypeRef` (the `prepareDynamicCarrier` / `prepareVectorLayout`
idiom in `program-abi-type-planning.ts`) and, with it, a new `IrType` arm —
deliberately deferred here because it is unreachable while the pre-existing
blocker fails first, and because a new IR type leaf touches every exhaustive
switch over `IrType`.

`tests/issue-4461.test.ts` pins this **differentially**, not as a fixed
expectation: the native-`$Map` shape must do whatever the f64 control does.
That assertion stays true if the residual is fixed, and fails loudly if
native `$Map` ever becomes the worse of the two.

Also observed and out of scope: a module whose ONLY union-import consumer is
the IR path fails on the **JS-host** lane with
`unknown exact function import env.__box_number` (`addUnionImports` registers
the import after the imported-callable catalog is built). Reproduced on base
with the same source; the `algorithms.ts` corpus does not hit it because
`console.log` forces the registration earlier.
