---
id: 903
title: "Add typed host import contracts and effect summaries"
status: ready
created: 2026-04-02
updated: 2026-04-28
priority: high
feasibility: hard
reasoning_effort: max
goal: spec-completeness
files:
  src/index.ts:
    modify:
      - "Extend compile/import metadata with host contract annotations"
  src/compiler.ts:
    modify:
      - "Preserve host import intent together with effect summaries"
  src/runtime.ts:
    modify:
      - "Resolve only declared host imports and keep contract boundaries explicit"
  src/codegen/index.ts:
    modify:
      - "Use host contracts to avoid widening values or invalidating shapes unnecessarily"
---
# #903 -- Add typed host import contracts and effect summaries

## Problem

Host imports currently act as a semantic escape hatch. Even when the import interface is fixed, the compiler lacks structured information about what the host call is allowed to do.

Without that information, codegen and optimization must conservatively assume that a host call may:

- mutate passed objects
- retain references
- call back later
- observe identity/prototype/layout
- return broader dynamic values than necessary

That pushes generic runtime machinery deeper into code that should otherwise stay on a closed, specialized path.

## Goal

Represent host imports as explicit contracts, not just names.

Each host import should describe:

1. parameter and result representations
2. whether it may mutate arguments
3. whether it may retain references after the call
4. whether it may re-enter the module via callbacks
5. whether it may observe generic JS object identity/prototype/property layout

## Approach

1. Extend the compiler import manifest with effect summaries
2. Teach codegen/optimization to preserve specialization across imports that are:
   - pure
   - non-retaining
   - non-reflective
   - non-reentrant
3. Keep conservative widening only for imports whose contract actually requires it
4. Make host-boundary assumptions auditable in one place

## Examples

Safe fixed-interface imports:

- `Math.floor(x)`
- `Date.now()`
- `console.log(number)`

Potentially boundary-heavy imports:

- DOM mutators
- callback registration
- generic property access helpers
- dynamic module/eval hooks

These should not all be treated the same way.

## Acceptance criteria

- host imports carry explicit effect metadata, not only names/intents
- closed-world code can stay specialized across imports proven pure/non-retaining
- conservative invalidation remains only on imports whose contract requires it
- the runtime import surface remains explicit and auditable

## Implementation Plan (added 2026-05-21)

### Entry points
- New `src/host-contracts.ts` — central registry of contract metadata
- `src/codegen/index.ts` — every `addImport` call site reads from the registry
- `src/runtime.ts` — `buildImports` validates host adheres to declared contract (debug-mode only)
- New `src/checker/effect-analysis.ts` — uses contracts to prune conservative widening

### Data structure
```ts
export interface ImportContract {
  module: string;             // e.g. "env", "Math"
  name: string;               // e.g. "Math.floor", "console.log"
  params: WasmType[];
  result: WasmType | "void";
  // Effect summary:
  pure: boolean;              // no side effects, same input → same output
  retainsRefs: boolean;       // may store refs across calls
  callsBack: boolean;         // may invoke a callback synchronously
  reflective: boolean;        // may observe prototype / property layout
  mayThrow: boolean;          // may throw an exception
  shapeStable: boolean;       // does not mutate shapes of args
}
```

### Algorithm
1. **Registry seed**: bootstrap `host-contracts.ts` with entries for every existing built-in import:
   - `Math.*` → all pure, no retention
   - `Date.now / Date.UTC` → impure (clock) but no retention
   - `console.log` → retains externref strings (logger may stash), reflective on object args
   - `__box_number / __unbox_number` → pure, no retention
   - `__extern_length / __extern_get_idx` → pure, no retention, reflective (reads .length / [k])
   - `__defineProperty_value` → mutates first arg, callsBack getters, may throw
   - `RegExp_new` → allocates, retains pattern internally, may throw on parse error
   - DOM/Node imports (#1044/#1045) → most are reflective + retaining
2. **Codegen integration**: at every `addImport` call, look up the contract; cache on `ctx.importContracts: Map<funcIdx, ImportContract>`.
3. **Effect-aware analysis**: extend the shape inference / type flow pass:
   - On a call to a `pure + !reflective + !callsBack` import, do NOT invalidate any locals/shapes.
   - On `callsBack`, treat as a generic call that may mutate any escaped reference.
   - On `reflective`, do NOT specialize the object's shape past this point unless the analysis can prove the import doesn't see THIS object.
4. **Debug-mode validation**: in `runtime.ts`, when `JS2WASM_VALIDATE_CONTRACTS=1`, wrap each host import to record observed behaviour; warn on contract violations.

### Wasm output
Contracts are compile-time only — no Wasm changes. They drive analysis decisions that affect what other code paths emit.

### Edge cases
- **User-declared imports** (via `import { x } from "host"`): default to the most conservative contract; allow user to annotate via `@js2wasm-contract` JSDoc on the import declaration.
- **Re-entrant imports** (`callsBack: true`): treat all globals and escaped refs as potentially observed/mutated; equivalent to a black-box call.
- **Throwing imports**: must be visible to the exception-handling analysis (already a property in `mayThrow`).
- **Variadic / overloaded imports**: split into named contracts per arity.
- **Imports that wrap a callback** (e.g. `setTimeout(cb)`): mark `retainsRefs: true` and `callsBack: true` (later).

### Test plan
- New `tests/issue-903-contracts.test.ts`:
  - Compile `Math.floor(x) + 1` and verify no externref widening of `x` past the call (WAT snapshot)
  - Compile `console.log(obj); return obj.x` and verify `obj`'s shape is preserved (no full deopt)
  - Negative: a `callsBack` import correctly invalidates downstream specialization
- Microbench: hot loop calling `Math.floor` should not regress vs. the current generic path

### Dependencies
- **Hard**: #743 (whole-program type flow analysis) — uses contracts as the boundary condition
- **Soft**: #1044/#1045 (Node/DOM host imports) — both need contracts populated; coordinate

### Files touched
- new `src/host-contracts.ts` (registry)
- new `src/checker/effect-analysis.ts`
- `src/codegen/index.ts` (consume contracts in addImport / call sites)
- `src/runtime.ts` (debug-mode validator)
- All existing `addImport` call sites adopt the contract lookup (~30 sites)
- new `tests/issue-903-contracts.test.ts`
