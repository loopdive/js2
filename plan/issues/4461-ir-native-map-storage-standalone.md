---
id: 4461
title: "IR: model the native $Map struct as module-binding storage so Map claims in standalone"
status: done
sprint: current
created: 2026-08-15
updated: 2026-08-15
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
