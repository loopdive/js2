---
id: 3517
title: "IR: claim the exact generic Map module initializer"
status: done
completed: 2026-07-21
sprint: 73
created: 2026-07-21
updated: 2026-07-21
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
es_edition: es2015
goal: ir-full-coverage
parent: 2855
depends_on: [2856]
related: [2138, 3142]
origin: "2026-07-21 IR-only migration: eliminate the last playground module-init fallback without widening generic constructor selection"
files:
  - plan/issues/3517-ir-generic-map-module-init.md
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - tests/issue-3517-map-module-init.test.ts
  - scripts/ir-fallback-baseline.json
  - scripts/gen-ir-adoption.mjs
  - plan/log/ir-adoption.md
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
---

# #3517 — IR: claim the exact generic Map module initializer

## Problem

After #2856 drove function-level `body-shape-rejected` to zero and made
Calendar's module initializer IR-owned, the playground fallback gate retained
one module-level rejection:

```ts
const fibCache = new Map<number, number>();
```

The storage, constructor, and later `Map.get`/`Map.set` operations were already
supported. Erasing the type arguments produced a source shape that selected,
lowered, validated, and ran. The remaining rejection came solely from the
selector's blanket `NewExpression.typeArguments` guard.

Removing that guard generally would be unsound. It would admit generic local
classes and shadowable constructor names without proving that the erased type
arguments agree with the selected runtime ABI.

## Implementation

Admit one checker-certified exception to the generic-constructor guard. A
`NewExpression` with type arguments is accepted only when all of these facts
hold:

- it is the initializer itself of a direct top-level `const` identifier;
- the constructor is the ambient `Map` symbol, not a same-named local;
- there are exactly two type arguments and zero runtime arguments;
- the declaration's already-allocated module storage is extern `Map`;
- the shared module-binding resolver accepts the extern call ABI; and
- selection is currently assessing the single-source `<module-init>` unit.

No storage, AST-to-IR lowering, Wasm lowering, host runtime, or import behavior
is added. The accepted type arguments are erased exactly as they already are on
the legacy path. Local generic constructors, wrapped initializers, `let`,
shadowed `Map`, constructor arguments, native strings, fast mode,
standalone/WASI, strict-no-host, and the M0 multi-source overlay remain outside
the exception.

## Acceptance criteria

- [x] The exact live `website/playground/examples/js/algorithms.ts` source
      genuinely IR-emits `<module-init>` under both IR-first settings.
- [x] Its module Map is constructed once, persists across calls, and uses only
      the exact `Map_new`, `Map_get`, and `Map_set` imports.
- [x] The fallback gate records module-level `body-shape-rejected` at zero with
      no function-level or post-claim increase.
- [x] Unsupported generic constructors and every non-host/single-source lane
      reject before claim.
- [x] No direct-codegen, module-storage, lowering, or runtime implementation is
      changed.

## Implementation Summary

### What was done

- Added the exact ambient generic-Map module-initializer certification to the
  selector and documented the erased-generic boundary beside lowering.
- Added a focused live-source runtime suite with IR-first on/off anti-vacuity,
  import-set checks, persistent Map read/write checks, and negative containment.
- Banked the module-level fallback baseline from one to zero and regenerated
  the IR-adoption record.

### What worked

- Reusing the checker-backed module-binding resolver proved every property the
  existing builder and runtime require, so no new IR node or runtime path was
  necessary.
- Keeping the exception at direct top-level `const` initialization preserved
  the general generic-constructor rejection and the M0/host-free boundaries.

### What did not work

- Broadly treating all constructor type arguments as erasable was rejected:
  erasure alone does not prove constructor identity, storage representation, or
  argument ABI.

### Files changed

- `src/ir/select.ts` and the corresponding boundary comment in
  `src/ir/from-ast.ts`.
- `tests/issue-3517-map-module-init.test.ts`.
- The fallback baseline, generated IR-adoption record, and this issue file.

## Test Results

- Focused #3517 live-source and containment suite: 14/14 passed.
- Combined Algorithms, module-binding, module-init, and M0 matrix (including
  the focused suite): 108/108 passed across five suites.
- Fallback gate: module-level body-shape 0; function body-shape 0; deferred
  async 4; no post-claim demotions.
- Typecheck, adoption generation/check, formatting, LOC, and diff gates:
  passed.
