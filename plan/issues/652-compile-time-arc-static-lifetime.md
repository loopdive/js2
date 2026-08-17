---
id: 652
title: "Compile-time ARC: static lifetime analysis for linear memory mode"
status: ready
created: 2026-03-20
updated: 2026-04-28
priority: low
feasibility: hard
reasoning_effort: max
goal: standalone-mode
sprint: Backlog
files:
  src/codegen/index.ts:
    new:
      - "static lifetime analysis pass"
      - "linear memory allocator with compile-time free"
  src/codegen/expressions.ts:
    new:
      - "emit linear memory alloc/free instead of struct.new for analyzed lifetimes"
---
# #652 — Compile-time ARC: static lifetime analysis for linear memory mode

## Status: open (low priority — after JS compatibility)

## Problem

Two scenarios where WasmGC's garbage collector **does not help**:

1. **wasmtime/wasmer**: The GC collector is null — allocated WasmGC structs are never freed. Every allocation leaks. Long-running programs OOM.
2. **Fast/linear memory mode**: When targeting linear memory for performance, there's no GC at all. Manual memory management is required.

## Idea: Runtime-free ARC via static analysis

Instead of a Rust-style borrow checker (which requires language changes), implement **compile-time automatic reference counting** through static analysis of the module:

### How it works

1. **Allocation**: `new Foo()` → `memory.grow` or bump-pointer in linear memory, returns an i32 offset
2. **Static reference counting**: The compiler analyzes all paths through the program and determines, at compile time, exactly when each allocation's last reference dies
3. **Compile-time free**: At the point where the last reference is provably dead, emit a `free(offset)` call — no runtime reference counting overhead, no GC pauses, no leaks
4. **Fallback**: If the compiler can't prove the lifetime (e.g., stored in a global, returned to caller, captured by closure that escapes), fall back to a simple runtime refcount or leak-and-warn

### What makes this feasible for TypeScript

TypeScript modules are **closed systems** — the compiler sees all code. Unlike C where pointers can alias freely, TS has:
- No pointer arithmetic
- No `void*` casts
- Structural types that the compiler fully understands
- No threads (single-threaded Wasm) — no concurrent mutation

This means the compiler can track every reference to every allocation through the entire module.

### Static analysis approach

```
For each allocation site `new T()`:
  1. Track the local variable it's assigned to
  2. Follow all assignments, function arguments, returns, field stores
  3. Build a reference graph: which variables/fields hold refs to this allocation
  4. Compute the "last use" point for each reference
  5. At the last use point, emit free(offset)

For function parameters (external refs):
  - Don't free — caller owns

For return values:
  - Transfer ownership to caller — caller's analysis handles free

For closures that capture refs:
  - If closure doesn't escape: free when closure's last use dies
  - If closure escapes: fall back to runtime refcount
```

### Example

```typescript
function process(data: number[]): number {
  const result = new Accumulator();  // alloc at offset 100
  for (const x of data) {
    result.add(x);                   // reference alive
  }
  const sum = result.total;          // last use of result
  // compiler emits: free(100)       // ← compile-time inserted
  return sum;
}
```

### Phased implementation

**Phase 0 — Escape analysis (M complexity)**
Identify allocations that never escape the function. Emit them as locals (or linear memory with deterministic free at function exit). No reference counting needed.

**Phase 1 — Intraprocedural lifetime analysis (L complexity)**
Track references within a single function. Handle conditionals (free at join point), loops (free after loop), and early returns (free before return).

**Phase 2 — Interprocedural analysis (XL complexity)**
Track references across function calls. Requires whole-module analysis. Handle ownership transfer in function arguments and return values.

**Phase 3 — Runtime refcount fallback (M complexity)**
For allocations that escape static analysis (closures, globals, dynamic dispatch), emit runtime `ref_inc`/`ref_dec` with free-on-zero. This is the safety net.

### Runtime cost analysis

**Module size impact:**

| Phase | Size delta | Why |
|-------|-----------|-----|
| Phase 0 (escape analysis) | **Smaller** | Locals instead of struct.new, fewer GC allocations |
| Phase 1 (intraprocedural) | **+50-100 bytes** per module | Bump allocator + free list function. Each alloc/free site is 2-3 instructions |
| Phase 2 (interprocedural) | Same as Phase 1 | No additional infrastructure |
| Phase 3 (runtime refcount) | **+200-300 bytes** | ref_inc/ref_dec helpers. One call instruction per reference site |

**Performance impact:**

| Phase | Overhead | Why |
|-------|----------|-----|
| Phase 0-2 | **Faster than GC** | `i32.const + i32.store` (linear memory) is faster than `struct.new` (GC allocation + potential pause). Free is bump pointer reset or free-list push |
| Phase 3 | **~5% per assignment** | One `i32.add` to increment count. Only for values escaping static analysis — common case (Phase 0-2) has zero overhead |

**Comparison with alternatives:**

| Approach | Runtime cost | Memory management | Drawback |
|----------|-------------|-------------------|----------|
| WasmGC (current) | Zero alloc cost | GC handles it | Unpredictable pauses; wasmtime leaks forever |
| Compile-time ARC (this) | Zero for 80% of allocs | Deterministic free | Complex analysis; fallback for escaping refs |
| Rust ownership | Zero | Compile-time | Requires language changes |
| Swift ARC (runtime) | ~10-15% per assignment | Runtime refcount | Always pays the cost, even for local values |

**Bottom line:** Phase 0+1 covers ~80% of allocations with zero runtime overhead and slightly smaller binaries. The remaining ~20% (escaping refs) fall back to Phase 3 (~5% overhead) or GC on WasmGC targets.

### Ownership transfer (move semantics)

When an object is passed to a function or returned and the origin provably never uses it again, the compiler can **transfer ownership** — pass the i32 offset directly, skip the copy, skip the free on the caller side. This is the easiest optimization to prove statically:

```typescript
function createPoint(x: number, y: number): Point {
  const p = new Point(x, y);  // alloc at offset 200
  return p;                    // last use of p → ownership transfers to caller
  // NO free(200) here — caller now owns it
}

function transform(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const moved = translate(p, 10, 20);  // p's last use → ownership transfers
    // NO copy of p needed — translate receives the offset directly
    result.push(moved);
  }
  return result;  // ownership transfers to caller
}
```

**Detection rules:**

| Pattern | Ownership | Cost |
|---------|-----------|------|
| `return localObj` | Move to caller | Zero (pass offset) |
| `fn(localObj)` where localObj is never used after | Move to callee | Zero (pass offset) |
| `fn(localObj)` where localObj IS used after | Borrow (callee must not free) | Zero (pass offset, no free) |
| `obj.field = localObj` where localObj is never used after | Move to field | Zero (store offset) |
| `array.push(localObj)` where localObj is never used after | Move to array | Zero (store offset) |

**What makes this easy to detect:**

TypeScript has no aliasing surprises. After `const moved = translate(p, 10, 20)`, the compiler can see whether `p` appears in any subsequent statement. If not, it's a move. This is a simple liveness analysis — every compiler textbook covers it.

**Reuse analysis (Perceus-style):**

Even better — when an allocation dies and a new allocation of the same size immediately follows, the compiler can **reuse the memory** without freeing and reallocating:

```typescript
for (let i = 0; i < 1000; i++) {
  const temp = new Point(i, i * 2);  // alloc
  result += temp.x + temp.y;
  // temp dies here — but next iteration allocates same size
  // compiler reuses the same offset for all 1000 iterations
}
// Only ONE allocation for the entire loop
```

This is the Perceus optimization from the Koka language. It turns O(n) allocations into O(1) with zero runtime overhead.

### Thread safety, atomics, and locks

**Current state:** js2wasm is single-threaded. Wasm modules run on one thread. No shared memory. Moves are always safe.

**If threads are added later (Wasm threads proposal + SharedArrayBuffer):**

Move semantics break if two threads hold references to the same object. The compiler must distinguish between thread-local and shared allocations:

| Memory region | Ownership | Move cost | Free cost |
|---------------|-----------|-----------|-----------|
| Thread-local (default) | Single owner | Zero (pass offset) | Deterministic free |
| Shared (explicit) | Atomic refcount | `i32.atomic.add` per move | `i32.atomic.sub` + free-on-zero |
| Transferred (postMessage) | Move to receiver | Zero (ownership changes thread) | Receiver frees |

**Detection:**

```typescript
// Thread-local — compiler proves obj never escapes to shared memory
const obj = new Point(1, 2);     // local heap, free moves
process(obj);                     // zero-cost move

// Shared — obj stored in SharedArrayBuffer or passed to Worker
const shared = new SharedPoint(); // shared heap, atomic refcount
worker.postMessage(shared);       // atomic ref_inc
// shared still usable here       // both threads hold refs

// Transfer — obj moved to worker, caller gives up access
worker.postMessage(transfer(obj)); // zero-cost: ownership moves
// obj is DEAD here — compiler error if used after transfer
```

**Implementation approach:**

1. **Default: everything is thread-local.** Zero overhead. Moves are free. This covers 99% of code.
2. **Shared memory opt-in:** When the compiler sees `SharedArrayBuffer`, `Atomics`, or worker `postMessage` without `transfer()`, allocations that flow into shared context get atomic refcounts. The shared heap uses `memory.atomic.*` instructions.
3. **Transfer semantics:** `transfer(obj)` is a zero-cost ownership move across threads. The compiler marks the variable dead after transfer — any subsequent use is a compile error. This mirrors `structuredClone(obj, { transfer: [obj] })` in JS.
4. **Lock elision:** If the compiler can prove a shared object is only accessed under a lock (e.g., inside a `Atomics.wait`/`Atomics.notify` critical section), it can skip the atomic refcount and use plain `i32.add`/`i32.sub` instead. This is a standard optimization from Java/HotSpot.

**Key insight:** Thread safety is **per-allocation**, not global. The compiler tracks which objects flow into shared contexts. Objects that stay thread-local (the vast majority) pay zero cost. Only the ~1% that cross thread boundaries need atomic ops.

### Linear memory layout

```
[0..1023]       — reserved (null guard page)
[1024..heap_ptr] — static data (string literals, constants)
[heap_ptr..]    — bump allocator for structs

struct header (8 bytes):
  [0..3] type_id: i32  — struct type for field layout
  [4..7] size: i32     — total size including header

fields follow header at known offsets (computed from struct type)
```

### Prior art
- Swift ARC: runtime reference counting (we do compile-time instead)
- Lobster language: compile-time reference counting via flow analysis
- Perceus (Koka): precise reference counting with reuse analysis
- MLKit: region inference (similar to arena approach)

### Key insight
This is NOT a borrow checker. The user writes normal TypeScript. The compiler silently manages memory. If analysis fails for a value, it falls back to runtime refcount or (on WasmGC targets) the GC. Zero user-facing changes.

## Complexity: XL overall (Phase 0: M, Phase 1: L)

## Architect refinement (2026-05-21)

The existing design is comprehensive. Adding entry-point file refs
and dispatch sequencing.

### Entry points

- **Phase 0 (escape analysis)**: implemented under **#747**. Land
  #747 first as the foundation.
- **Phase 1 (intraprocedural)**: new `src/checker/lifetime.ts`.
  Hooks into `src/codegen/expressions.ts` to inject `__free(offset)`
  after the last-use instruction.
- **Phase 2 (interprocedural)**: extends `src/checker/type-flow.ts`
  (#743) with ownership transfer in the call-graph propagation
  step.
- **Phase 3 (refcount fallback)**: new runtime helpers `__rc_inc`
  / `__rc_dec` + bump allocator in linear memory.

### Dispatch sequencing

1. Land **#747** (escape analysis) — gives Phase 0 directly.
2. Land **#743** (type flow) — gives Phase 2's interprocedural
   foundation.
3. Land **#1199** (linear-memory typed arrays) — proves out the
   allocator + free-list infrastructure.
4. Then start Phase 1 of this issue.

### Risk

Building static ARC is months of work and risks regressing the
GC-mode hot path. Recommend keeping behind `--memory-mode=arc`
flag indefinitely; default remains WasmGC.

### Dependencies

- **#747** Phase 0 — direct dependency.
- **#743** — needed for Phase 2.
- **#1199** — proves linear-memory allocator infrastructure.
- **#1535/#1536** — native bigint / externref-free runtime;
  prerequisites for full standalone ARC.

## Measurement record (2026-08-17) — what the shipping analysis actually proves

Three measurements, run to decide whether this issue is worth scheduling. The
short version: **the analysis is not the blocker; the allocation-kind and
constant-size policy filters are, and on real code they exclude nearly
everything worth promoting.**

Method: `planLinearMemory` runs `analyzeOwnership`, `analyzeEscape` and
`findStackAllocCandidates` itself, so compiling with
`{ target: "linear", allocator: "analysis-stack" }` and reading
`getLastLinearIrReport()?.memoryPlan.allocations` measures the analysis **as it
ships**, not a reimplementation. Probes lived in `.tmp/` (gitignored); every
load-bearing number is restated here.

### 1. Playground corpus — no denominator

13 files under `website/playground/examples`, all compiled, all produced a
linear IR report. The linear IR path claimed **6 of 49 functions** (43
rejected), and those 6 contain **0 allocation sites**.

So the corpus fraction is **0/0 — undefined, not 0 %**. The allocating
functions are among the 43 rejections.

> A first version of this probe reported a bare "0 sites" and would have been
> read as "nothing is stack-allocatable". It could not distinguish *no report*
> from *report with no sites*. Positive controls were added and are what makes
> the numbers above meaningful — a control allocating a non-escaping object
> yields exactly one site, `owned` / `local` / `stack`.

### 2. Pattern capability profile — 7 of 9 observed sites promoted

Ten hand-written patterns; 3 rejected outright by the linear IR path, 7
produced sites (9 sites, 7 promoted). **This is a capability profile, not a
population estimate** — the patterns were chosen by the author.

| pattern | escape | promoted |
| --- | --- | --- |
| temp object, fields read | `local` | **stack** |
| temp object, mutated then read | `local` | **stack** |
| object allocated in a loop | `local` | **stack** |
| two objects, aliased values | `local` | **stack** ×2 |
| object stored into another object | `local` | **stack** ×2 |
| object **conditionally** allocated | `opaque` | arena |
| **array** literal, non-escaping | `local` | arena |
| object returned | — | rejected at IR build |
| object passed to a local callee | — | rejected at IR build |
| closure capturing a local | — | `select:body-shape-rejected` |

Two things the analysis handles better than expected: **mutation does not kill
promotion**, and an object **stored into another local object** still proves
`local` (both promoted). Two systematic gaps: **conditional allocation
degrades to `opaque`** (the drop-flag case, now confirmed rather than
predicted), and **arrays prove `local` but are excluded by policy** —
`SMALL_ALLOC_KINDS` in `stack-alloc.ts` is `{object, refcell, box}`.

### 3. `cookie@2.0.1` — a real package, read by hand

The tool claims **0 of 9** functions in `cookie`'s `dist/index.js`, so it
contributes no data; the following is a manual reading of the source.

**Module level (7 sites):** six RegExp literals plus `NullObject`. Allocated
once at init, program lifetime — static/global, and irrelevant to per-call
cost either way.

**Per call:**

| function | site | verdict |
| --- | --- | --- |
| `parseCookie` | `new NullObject()` | returned → **escapes** |
| `parseCookie` | key / value strings from `valueSlice`, `dec(...)` | stored into the returned object → **escapes** |
| `stringifyCookie` | `Object.keys(cookie)` | **local**, never escapes — but **dynamically sized** |
| `stringifyCookie` | `str += …` temporaries | **local, transient**, dynamically sized |
| `stringifySetCookie` | ~10 sequential `str += "; X=" + v` temporaries | **local, transient** — the dominant allocation |
| `stringifySetCookie` | `priority/sameSite.toLowerCase()`, `expires.toUTCString()` | **local, transient**; the first two are conditional |
| `parseSetCookie` | `setCookie` object literal (ternary, two arms) | conditional **and** returned → **escapes** |
| `parseSetCookie` | `attr`, `attr.toLowerCase()` | **local, transient** |
| `parseSetCookie` | `val`, `new Date(val)`, `val.toLowerCase()` | **conditionally** stored → must be treated as escaping |
| all | error-path template literals + `new TypeError` | escape via `throw`; cold |

**The finding.** Every genuinely promotable allocation in `cookie` is a
**string temporary** or **one array** — precisely the kinds `SMALL_ALLOC_KINDS`
excludes — and nearly all are **dynamically sized**, which
`ANALYSIS_STACK_ARENA_POLICY` also excludes via
`facts.layout.size.kind === "constant"`. Meanwhile the allocations that *are* of
a promotable kind — the `NullObject` instance, the `setCookie` literal — are
exactly the ones that escape by construction, because they are the return
values.

So on this package the current Phase-1 policy would promote **zero** sites even
with perfect IR coverage and a perfect escape analysis. Not because locality
cannot be proven, but because the two policy filters exclude what real
string-processing code allocates.

### Consequences for this issue

1. **Extending the kind filter beats extending coverage.** Arrays already prove
   `local` and are dropped by policy alone; strings are the dominant population
   in real code. Both are cheaper to enable than more selector coverage.
2. **Fixed-size scalar replacement is the wrong mechanism for this workload.**
   The wins are dynamically sized and die at function exit.
3. **A per-call arena rewind is the better-fitting primitive.** ADR-0017 already
   ships an O(1) `__arena_reset`; a *per-call* variant would capture nearly all
   of `cookie`'s transient traffic, and it needs only "nothing escapes this
   call" — strictly weaker than per-object promotion, and it sidesteps both the
   conditional-allocation and dynamic-size problems at once.
4. **Re-run measurement 1 once linear-lane coverage rises** (#4539, #4541). Until
   then any corpus fraction measures the selector, not the lifetime analysis.

Caveat on scope: this reads `cookie`'s JS semantics. How our compiler actually
lowers `+=` on strings (rope, builder, or fresh allocation per concat) was not
inspected, and it changes the size — though not the direction — of point 3.
