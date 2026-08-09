# ADR-0017: Linear-backend bump/arena allocator; one fixed GC strategy, not a pluggable one

Status: Accepted

## Context

The linear-memory backend (`src/codegen-linear/`, the alternative to the
WasmGC backend per [ADR-0003](./0003-wasmgc.md) and the codegen-axes split)
owns its own allocation — there is no host GC underneath it. We had to decide
both *which* allocation strategy it uses and whether to leave that strategy
**pluggable**.

The field consensus for AOT source→Wasm compilers, captured as recommendation
**R10** in `docs/architecture/compiler-design-lessons.md`, is twofold:

1. **Do not build a pluggable / interchangeable GC.** Supporting tracing and
   reference-counting as swappable strategies is documented as *not viable* —
   reference counting cannot collect cycles, so a real system bolts tracing on
   anyway and ends up maintaining both. The GC subsystem is the
   most-redesigned part of every compiler in this space; over-abstracting it
   is a known trap.
2. **A bump/arena "allocate-and-never-free" mode is a near-free win for
   short-lived programs.** Most conformance- and CLI-style WASI programs
   allocate and then exit; for them a tracing collector is pure overhead and
   code size.

## Decision

- The linear backend's allocator is a **bump/arena**: `__malloc` advances a
  single `__heap_ptr` global (8-byte aligned) and **frees nothing**.
  Reclamation happens implicitly when the Wasm instance is dropped — the
  allocate-and-exit model. This remains the **default** mode (#1856).
- `__malloc` **grows linear memory on demand** (`memory.grow`) when a request
  would exceed the current pages, so the arena is usable for non-trivial
  programs rather than silently overflowing the initial 64 KiB page.
- An opt-in `allocator: "arena-reset"` (`--allocator arena-reset`) adds
  `__arena_reset()` (O(1) rewind of the whole arena) and `__arena_used()` for
  embedders that reuse one instance across many short-lived tasks. It also
  reclaims automatically at eligible host-call boundaries: when every export
  has primitive parameters/results and every module global is primitive, a
  wrapper rewinds immediately before entering each exported function. Internal
  calls target the unwrapped function and never rewind a live caller's arena.
- Eligibility is deliberately module-wide. Any aggregate export boundary or
  heap-backed module global disables automatic rewinds for all exports, keeping
  returned or escaped pointers live. The explicit management exports remain
  available for embedders that can establish those lifetimes themselves.
- We **do not** ship a pluggable GC abstraction. If reclamation within a
  single long-lived run is ever genuinely needed, we will commit to **one**
  fixed strategy (tracing, or RC-with-a-cycle-collector) — chosen and recorded
  then, not abstracted now. **This need is deferred**: no current standalone /
  WASI workload requires intra-run reclamation, and the WasmGC backend already
  covers long-lived, cyclic-graph workloads by delegating to the host GC.

## Consequences

- Smallest-binary, fastest path for standalone/WASI programs; the bump
  runtime is ~135 bytes and adds no per-allocation metadata. The reset runtime
  and one small wrapper per eligible export are emitted only when requested.
- Automatic reset preserves a completed call's arena until the next eligible
  host call begins. It does not reclaim within one call; workloads that exhaust
  memory inside a single invocation still need an algorithmic fix or a future
  fixed collection strategy.
- No cycle-collection or fragmentation handling on the linear backend — by
  design. Workloads that need that target the WasmGC backend instead.
- The "one fixed strategy, decided later" stance keeps the door open without
  paying the abstraction tax up front. Revisit only when a concrete workload
  demonstrates the need.
