---
id: 1199

title: "perf: linear-memory backing for typed numeric arrays (`Array<number>` with i32-only ops → `i32.load`/`i32.store`)"
status: ready
created: 2026-04-27
updated: 2026-04-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: arrays
goal: performance
depends_on: [1197]
es_edition: n/a
related: [1126, 1179, 1195, 1196, 1197, 1198]
origin: 2026-04-27 array-sum perf analysis — Tier 2 architectural move. Bypasses WasmGC array overhead entirely. Matches AssemblyScript's approach.
---
# #1199 — Linear-memory backing for typed numeric arrays

## Problem

WasmGC `array<i32>` and `array<f64>` are heavyweight: allocation goes through the GC, every access carries type tags / RTT info, and the runtime can't fully fuse element access into raw memory ops the way `i32.load` / `i32.store` allow. For numeric arrays (`Array<number>` whose element type is provably i32 or f64), an alternative is to back them with **linear memory** — the same model AssemblyScript uses by default and the same model `Int32Array` / `Float64Array` would use.

The benefit: a `values[i] = expr` lowering becomes a single `i32.store` with no GC interaction, no type tag check. Per-element overhead drops to roughly one Wasm instruction. On the array-sum benchmark, this would close most of the remaining gap to Node even without the other Tier 1 fixes (#1195/#1196/#1197/#1198).

The cost: we lose automatic GC for these arrays. Lifetime management has to be explicit (or we wrap a linear-memory buffer inside a small WasmGC struct that owns it and runs a finalizer). And the user-visible JS object still has to behave like a JS Array on the boundary — so we need conversions when the array crosses a JS-host call site.

## Implementation plan

This is a Tier 2 architectural move and should be planned in two parts.

### Part 1 — internal-only linear-memory arrays (smaller blast radius)

When a `number[]` is provably i32-typed (#1197's analysis) AND non-escaping (#1195's analysis) — i.e. the array stays inside the Wasm side and never crosses to JS — back it with linear memory:

- Allocation: bump-allocate a chunk of size `4 * n` bytes for i32, `8 * n` for f64. Use a per-function arena that resets at function exit (since the array doesn't escape the function).
- `values[i] = expr` → `i32.store offset=base, align=2 (compute base + i*4)`
- `values[i]` → `i32.load offset=base, align=2 (compute base + i*4)`
- `values.length` → keep a single i32 local for length

This is the same trick AssemblyScript uses — and gets us 90% of the perf without the lifetime complications. Builds on #1197 and #1195 — those should land first.

### Part 2 — observable-typed-array semantics (bigger change)

Eventually we want `Array<number>` instances that DO cross to JS to also use linear-memory backing, with a `WasmGC struct { length: i32, dataPtr: i32, capacity: i32 }` wrapper that JS sees as an Array-like object. This requires:

- A bridge between the linear-memory buffer and JS Array / TypedArray APIs
- Reference counting or a finalizer hook to free the buffer when the wrapper is GC'd
- Method dispatch (`.push`, `.pop`, `.slice`, etc.) — most are easy since they translate to memory ops

Defer Part 2 to a follow-up issue once Part 1 ships and we have measured impact.

## Acceptance criteria (Part 1 only)

1. `array-sum` competitive benchmark `runtimeArg=1000000` hot runtime improves by **at least 3×** beyond what #1195+#1196+#1197+#1198 deliver. (i.e. if those 4 land us at ~30 ms, this should bring us to ~10 ms or below — within parity of Node).
2. Specialisation triggers ONLY when the array is both i32-typed (#1197) and non-escaping (#1195). All other arrays unchanged.
3. New equivalence test in `tests/issue-1193.test.ts`:
   - i32-only non-escaping array → linear-memory backed (verify via wast)
   - Same array but returned from function → falls back to WasmGC array
   - Same array but stored on a struct field → falls back
4. The arena-based allocator must reset correctly across function invocations — no cross-call leakage. Test by running the same benchmark many times; memory should not grow unboundedly.
5. CI test262 net delta ≥ 0; arrays sub-suite strictly improves; no GC-related regressions.

## Out of scope (Part 1)

- JS-observable array semantics (Part 2 — separate issue).
- Float64Array / TypedArray-backed storage as the user-facing API (different feature).
- Mixed i32/f64 arrays (Part 2).

## Risk

Lifetime management is the hard part. If the arena is per-function but the array is captured by an inner closure that outlives the function — we have a use-after-free. The escape analysis from #1195 must catch this; bail conservatively if any uncertainty.

Memory fragmentation: bump allocation that resets at function exit avoids fragmentation but means we can't free intermediate arrays mid-function. For typical hot loops this is fine (memory grows briefly during the call, drops at return). Document this and watch for pathological cases.

## Notes

This is the larger of the two Tier 2 architectural moves called out in the array-sum perf analysis. Big change but high leverage. Plan to land Part 1 only after #1195, #1196, #1197 are stable; Part 2 is a separate multi-week effort.

Reference: AssemblyScript uses this approach by default for typed arrays. Our specialisation triggers under stricter conditions (must be provably i32 + non-escaping) but the codegen mechanics are the same.

## Architect refinement (2026-05-21)

The existing plan is already concrete. Adding the file-level
breakdown plus the edge cases not yet enumerated.

### Entry points

- **Memory section emission**: `src/codegen/index.ts` — add a memory
  declaration when the module needs linear memory (it likely already
  exists for native-strings; reuse).
- **Arena allocator**: new helper `emitArenaAlloc(ctx, sizeExpr)` in
  `src/codegen/helpers/arena.ts` (new). Tracks a per-function arena
  base via two locals `$arena_base` and `$arena_top`.
- **Array-literal lowering**: branch in `compileArrayLiteral` (search
  `src/codegen/expressions.ts`) — if `ctx.isI32Array(node) &&
  ctx.isNonEscaping(node)` (from #1197/#1195), allocate from the
  arena and store via `i32.store`.
- **Element access**: branches in `src/codegen/property-access.ts`
  for indexed read/write when the receiver is arena-backed.
- **Length tracking**: per-array `length` lives as an i32 local,
  same as the existing fast-path vec uses.

### Arena scheme

```wat
(local $arena_base i32)        ;; bump pointer at function entry
(local $arena_top i32)         ;; pointer to next free byte

;; at function entry:
global.get $heap_top
local.set $arena_base
local.get $arena_base
local.set $arena_top

;; at function exit (every return path):
local.get $arena_base
global.set $heap_top
```

Reset on every exit including `throw` (use existing finally
machinery).

### Edge cases not in the existing plan

- **Tail-call** (`return_call`): arena reset must happen *before* the
  tail call. Treat tail calls as exit points.
- **Exception thrown through the function**: the existing finally
  machinery in `src/codegen/statements/exceptions.ts` must wrap the
  whole function body in a `try {} finally { arena reset }`.
- **Loop-allocated arrays in a hot loop**: arena grows unboundedly
  within one function call. Mitigation — emit a *loop-local* arena
  reset at the loop back-edge when the loop-allocated array
  doesn't escape the iteration. Detect via #1195's per-iteration
  escape analysis.
- **Nested function calls**: callee receives the parent's `$heap_top`
  unchanged; allocates its own arena segment above; resets on its
  own return. No cross-call leakage by construction.
- **Bounds checks**: indexed read/write past length must throw — but
  linear memory has no automatic bounds. Emit explicit
  `i32.ge_u (length) → if → throw RangeError`. Existing peephole pass
  should be extended to elide bounds checks when index is provably
  in-range (constant-propagation analysis).
- **`.push` / `.pop` on arena-backed arrays**: require capacity
  growth. For non-escaping arrays with known max length (constant
  bound), allocate the max up front; for unbounded, fall back to
  WasmGC array.
- **Mixed-type arrays sneaking in**: a single `arr.push("string")`
  forces a bail to WasmGC for the whole array. Escape analysis must
  detect this and fall back at allocation.

### Test paths to add

Add `tests/perf/issue-1199-arena.test.ts` validating both the
backing choice (inspect emitted wasm) and the arena reset
behaviour (call the function 1M times, observe `__heap_top`
unchanged at end).

### Dispatch

Block this issue's start on #1195 + #1196 + #1197 landing and
stable. Spec is ready; just sequence carefully.
