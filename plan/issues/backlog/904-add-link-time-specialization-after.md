---
id: 904
title: "Add link-time specialization after separate compilation"
status: ready
created: 2026-04-02
updated: 2026-04-28
priority: high
feasibility: hard
reasoning_effort: max
goal: performance
depends_on: [33, 743]
files:
  src/link/:
    modify:
      - "Resolve imported functions/globals to concrete definitions and expose enough information for post-link specialization"
  src/codegen/index.ts:
    modify:
      - "Support late specialization/devirtualization once linked callees are known"
  src/compiler.ts:
    modify:
      - "Preserve type/signature metadata needed by the linker or post-link optimizer"
---
# #904 -- Add link-time specialization after separate compilation

## Problem

Separate compilation hides information temporarily, but the final linked program often becomes closed-world again.

Today that means the compiler may be forced into conservative import/interface paths during compilation even when the linker later knows:

- the concrete callee
- the concrete type/signature
- the concrete object/layout contract

Without a post-link specialization step, that information is lost and the final program stays slower than necessary.

## Goal

Teach the js2wasm toolchain to recover specialization once separately compiled modules are linked.

## Approach

After relocatable objects are linked:

1. resolve imported functions/globals to known definitions
2. propagate concrete signatures across module boundaries
3. remove interface checks that are no longer needed
4. devirtualize/import-direct calls where possible
5. enable post-link monomorphization / inlining / dead-wrapper removal

## Examples

- A module imports `add(x, y)` through a generic interface, but after linking the callee is known to be pure `f64 -> f64 -> f64`
- A property helper import becomes unnecessary because the linked object shape is closed and known
- A conservative import/export wrapper can be removed once both sides are known statically

### Concrete code example

`math.ts`

```ts
export function add(x: number, y: number): number {
  return x + y;
}
```

`main.ts`

```ts
import { add } from "./math";

export function run(): number {
  return add(40, 2);
}
```

If these files are compiled separately, `main.ts` may initially have to call `add`
through an imported/generic interface because the callee body is not yet present in
the local compilation unit.

After linking, the toolchain now knows:

- `add` resolves to the concrete definition from `math.ts`
- both arguments are `number`
- the return type is `number`
- the callee body is a direct numeric `x + y`

So the post-link specialization pass should be able to collapse the boundary from:

```text
main -> imported/generic add wrapper -> concrete add
```

to something materially closer to:

```text
main -> direct typed call to add
```

or, if heuristics allow:

```text
main -> inlined f64.add
```

The key point is that separate compilation should only delay specialization, not
prevent the final linked program from recovering the same direct numeric path as
single-shot compilation.

### JavaScript example

`math.js`

```js
export function twice(x) {
  return x * 2;
}
```

`main.js`

```js
import { twice } from "./math.js";

export function run() {
  return twice(21);
}
```

At per-file compile time, `main.js` may not have enough local information to assume
that `twice` is always the numeric `x * 2` function from `math.js`.

After linking, the toolchain can see the full closed-world program:

- `twice` resolves to the one concrete exported definition in `math.js`
- the reachable call site passes a numeric literal
- the callee body is a direct numeric multiply

So the linked result should be able to recover a specialized path such as:

```text
run -> direct typed call to twice
```

instead of being permanently stuck behind a generic imported-function boundary just
because the source started life as separate `.js` files.

## Acceptance criteria

- the linker or post-link optimizer can specialize across previously imported boundaries
- separate compilation no longer permanently forces conservative runtime checks where linked information is concrete
- linked closed-world programs recover direct call paths materially closer to single-shot compilation

## Implementation Plan

(Author: architect, 2026-05-21. Builds on #1046's `.widl`
infrastructure and #743's type-flow.)

### Entry point

New module `src/link/specialize.ts` providing
`postLinkSpecialize(linkedModule, widls, programTypes)`.

Invoked from a new linker stage after `compileMultiSource` finishes
emitting individual modules but before final output.

### Algorithm

1. **Collect import edges**: each imported function call becomes an
   edge `(consumerModule, importedSymbol, callSiteCallType)`.

2. **Resolve to concrete definitions** via the `.widl` files (#1046):
   look up the producer's wasm function index.

3. **Type propagation across boundaries**: feed the resolved
   definitions into #743's type-flow analysis as additional
   call-graph edges. Re-run propagation; previously externref-typed
   imports may now narrow to concrete types.

4. **Devirtualization**:
   - Replace `(call_indirect ...)` with `(call $resolved)` when the
     funcref can be statically proven.
   - Replace `(call $imported_wrapper)` with `(call $direct_target)`
     when the wrapper is identity-by-types.

5. **Wrapper elimination**: a thin `extern.convert_any` /
   `ref.cast` wrapper at a module boundary that's now provably
   redundant (both sides agree on the concrete type) can be deleted.

6. **Re-emit with peephole + wasm-opt**: feed back through the
   existing peephole optimizer + Binaryen `wasm-opt -O3` to inline
   the now-direct calls.

### Edge cases

- **Dynamic dispatch through external references** — devirt only
  when single-target proven; preserve indirection when polymorphic.
- **Recursive imports** — handle via SCC analysis; specialize within
  each SCC.
- **Versioned producer** — `.widl` `schemaVersion` mismatch aborts
  specialization, falls back to conservative imports (correctness
  before performance).
- **Concrete-type identity across modules** — Wasm types are per
  module; types in producer and consumer with the same shape are
  not the same `ref $T`. The linker must rewrite ref types at the
  boundary or fall back to externref. Phase 1: fall back; Phase 2:
  rewrite.
- **Globals**: same dataflow as functions; track globals' values
  through the link.

### Test plan

- `tests/issue-904-link-specialize.test.ts`:
  - Compile `math.ts` (export `add: (number, number) → number`)
    standalone.
  - Compile `main.ts` (import + call) standalone.
  - Link; verify the resulting wasm contains a direct
    `(call $add)`, not `(call_indirect $imported_add)`.

### Dependencies

- **#1046** Milestone 1 — separate compile + `.widl`. Hard
  dependency.
- **#743** — type flow; if not present, link-time has nothing to
  propagate. Hard dependency.
- **#33** — declared dependency; whatever that is, honour the
  ordering.

### Risks

- **Type-identity across modules**: WasmGC's per-module type names
  block direct ref sharing. Solving this requires module-merge
  (Binaryen `wasm-merge`) or runtime trampolines. Phase 1 ships
  trampolines; Phase 2 wasm-merge.
- **Code-bloat**: aggressive monomorphization can N×-multiply
  function counts. Cap specializations per export at 4; beyond,
  use generic externref variant.
