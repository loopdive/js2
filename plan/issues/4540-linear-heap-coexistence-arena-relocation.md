---
id: 4540
title: "Heap coexistence in one linear memory: relocate the bump arena above the engine's heap base, passive data segments only"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: bug
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
depends_on: [4539]
related: [1856, 4236]
# id 4540 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4540 — Heap coexistence in one shared linear memory

Slice 2 of #4538. Implements handoff items 4–5 from #4236's slice-2 table.

## Problem — a measured collision, not a theoretical one

Sharing one linear memory between our compiled code and the engine means two
allocators over one address space. Measured on the pinned artifact (#4236):

- The artifact's first `malloc` returns **171,696 (0x29EB0)**, above a 64 KiB
  `--stack-first` shadow stack at address 0 and ~105 KiB of static data.
- Our linear `__heap_ptr` initialises to a hard-coded **1024** (`HEAP_START` in
  `src/codegen-linear/runtime.ts`) — i.e. **inside the artifact's shadow
  stack**.

So the arena's very first allocation writes through the engine's stack. Two
independent growers over one memory remains a corruption hazard even after
relocation, and must be resolved by ownership rather than by spacing.

A second, independent hazard: **active data segments**. A linear module that
emits an active segment writes at a link-time offset straight through the
engine's static data. The #4236 probe module was safe only *by construction* —
it links to zero `DATA` section and never touches a global, so the only bytes
it can reach are ones it got from `malloc`.

## Scope

- **Fix heap ownership, not just the base address.** The boxed tier allocates
  from the engine's `malloc`; the native arena must sit above the artifact's
  `__heap_base` or be dynamically placed. Moving `HEAP_START` to a different
  constant is not a fix — the engine's heap grows.
- **Passive data segments + `memory.init` into a `malloc`'d pointer** for all
  literal data in linked mode. Preference order recorded in #4236:
  (a) passive segments — local to codegen, no link-time negotiation;
  (b) `--global-base` above the engine's heap base — fragile, the heap grows;
  (c) PIC/side-module dynamic linking — correct but much larger.
  Take (a); record why (b) is refused so it is not re-proposed.
- Audit the linear lane for any other absolute-address assumption (globals,
  stack-like scratch regions, string literal placement).

## The engine has a documented allocator hook — prefer one heap over two placed apart

Verified against the pinned header (quickjs-ng v0.16.1 / `954dc53`) on
2026-08-17: the engine takes embedder-supplied allocation functions via

```c
JSRuntime *JS_NewRuntime2(const JSMallocFunctions *mf, void *opaque);
typedef struct JSMallocFunctions {
  void *(*js_calloc)(void *opaque, size_t count, size_t size);
  void *(*js_malloc)(void *opaque, size_t size);
  void  (*js_free)(void *opaque, void *ptr);
  void *(*js_realloc)(void *opaque, void *ptr, size_t size);
  size_t (*js_malloc_usable_size)(const void *ptr);
} JSMallocFunctions;
```

alongside `JS_SetMemoryLimit`, `JS_SetGCThreshold`, and `JS_RunGC`. Our shim
currently calls plain `JS_NewRuntime()`, so we are on the engine's default
allocator (libc `malloc` → `dlmalloc`, per `-DMALLOC=dlmalloc` in
`build.sh`).

This reframes the slice: **the goal is one grower, not two growers placed
carefully.** Spacing two independent allocators apart is a truce that a heap
growth breaks; unifying removes the failure mode instead of postponing it.

Direction matters, and only one direction works. Our bump arena **cannot**
serve as the engine's allocator — `JSMallocFunctions` requires real `free`,
`realloc`, and `usable_size`, and the arena by design never frees (ADR-0017).
So unify the other way, and keep the arena's benefit:

> Carve the native arena's region **from** the engine's allocator — one (or a
> few) large blocks — and keep bump-allocating typed data inside it. One
> grower owns the address space; typed allocation keeps its ~135-byte
> zero-metadata fast path; the collision cannot recur by construction.

The alternative worth measuring against it is routing typed allocation
straight at the engine's `malloc` (simplest, one allocator, but typed data
loses the bump path and pays dlmalloc per allocation — which is exactly what
ADR-0017 chose the arena to avoid).

## The alternative this slice does not currently consider: two memories

Everything above assumes **one** linear memory and then works to make two
allocators coexist inside it. Multi-memory removes that problem rather than
solving it: the engine keeps memory 0, our arena moves to memory 1, and there
are two address spaces, so a collision cannot occur by construction and the
arena keeps ADR-0017's zero-metadata bump path untouched.

This is worth costing before the single-memory design is built, because the two
options trade opposite things.

**Why it fits this codebase better than it looks.** ADR-0020 already requires
that `JSValue` be **opaque** and that all manipulation go through the C API.
That *is* the accessor discipline — we never dereference engine memory
directly, so almost nothing we do needs to see memory 0. And the arena is
precisely the data that never needs to be visible to the engine: it holds our
compiled program's typed, statically-planned values.

**What it costs.** Payloads that genuinely cross — a string handed to
`JS_NewStringLen`, an array we ask the engine to wrap — must live in the memory
the engine can read. Under one memory we can build them in the arena and pass
the pointer; under two we must allocate from the engine's `malloc` and copy
into it. So multi-memory removes the coexistence hazard and reintroduces a copy
at exactly the boundary where data crosses. The single-memory design has the
mirror-image tradeoff. Neither is free, and which is cheaper is an empirical
question about how much data actually crosses the seam in real workloads.

**The security argument, which this issue does not currently weigh.** One
shared memory means the engine can read and write our arena, and vice versa.
That matters more here than in a generic two-module link, because the engine's
whole purpose in ADR-0020 is to execute **`eval`** — attacker-controlled input
by design. Under one memory, an exploited engine bug reaches our compiled
program's data; under two, it does not. #4539's `declareImportedMemory` gives
up the inter-module sandbox deliberately, and that is a defensible trade for a
trusted peer — it is a different trade when the peer is running untrusted
source.

**Prior art, with the discussion.** This is the design in
[WebAssembly/component-model#626](https://github.com/WebAssembly/component-model/issues/626)
("intra-module sandboxing"): after a multi-memory merge, an accessor exported
by one module carries the other's memory index as a **static immediate**, so
post-merge inlining reduces it to a direct load — the boundary is enforced
pre-merge and erased by inlining, at no runtime cost. Two findings from that
thread bear directly on this slice:

- **Bounds checking is not optional.** lukewagner's objection: an accessor
  taking a raw `i32` and loading indiscriminately lets the caller read anywhere
  in the callee's memory, which is "roughly equivalent to importing its linear
  memory" — the sandbox is nominal. A region must carry its length and the
  accessor must check, statically for fixed-size regions and dynamically
  otherwise. He argues handles-plus-call-scoped-lifetimes converges on lazy
  lowering; cfallin (Cranelift) disagrees explicitly, holding that an
  unforgeable resource handle with primitive-wise accessors is "not covered by
  lazy lowering" and fills a niche no other zero-copy mechanism does — the same
  shape Wasmtime's compile-time builtins target. That disagreement is unresolved
  upstream; we do not need to resolve it, but we should not assume either
  answer.
- **The bulk-data gap is the known weak point**, and it is the same one we hit
  above: per-element accessors lose to a single `memory.copy`. The upstream
  answers are explicit bulk methods, region borrows
  ([#568](https://github.com/WebAssembly/component-model/issues/568)'s
  `mappableref`, [#383](https://github.com/WebAssembly/component-model/issues/383)
  lazy lowering), or optimizer recovery of sequential accessor loops.

**What would need building here**: multi-memory emission in
`src/codegen-linear/` (today `declareImportedMemory` asserts the module defines
no memory, and the emitter assumes a single one), memory-index immediates in
our own arena accesses, and a measured comparison of the cross-boundary copy
against the single-memory design. Engine/runtime multi-memory support on our
target matrix needs verifying rather than assuming.

**This is recorded as an option, not a recommendation.** The single-memory
allocator-unification design above may well still win on the numbers. What it
should not do is win by default because the alternative was never written down.

## Acceptance criteria

- [ ] A linked module allocates, writes, and reads without touching any byte it
      did not obtain from an allocator — asserted by a probe that fills the
      engine's static region with a canary and verifies it is intact after a
      workload.
- [ ] All literal data in linked mode is emitted via passive segments; a lint
      or emit-time assertion rejects active segments in that mode.
- [ ] Standalone (unlinked) output is unchanged — same emit-identity proof as
      #4539.
- [ ] The refused alternatives (fixed `--global-base`, spacing the arenas
      apart) are recorded with their failure mode in the issue or ADR, not just
      in a commit message.
- [ ] Exactly **one** component grows linear memory, established by
      construction rather than by convention, and asserted by a test that
      grows both workloads past their initial pages.
- [ ] The arena-carved-from-`malloc` design is measured against routing typed
      allocation directly at the engine's `malloc`, and the choice is recorded
      with both numbers — ADR-0017's zero-metadata bump path is the thing
      being traded, so the trade needs a figure.
- [ ] The **two-memory** alternative is explicitly decided, not defaulted past:
      record whether it was rejected on the cross-boundary copy cost, on
      toolchain/runtime support, or on measurement — and state the security
      consequence accepted by staying on one memory, given the engine executes
      `eval` input.

## Validation

- Canary probe above, run against the real pinned artifact.
- `pnpm run check:linear-ir`, emit-identity proof vs a pre-change baseline.
- A stress run that grows both heaps past their initial pages — the failure
  mode this slice exists to prevent only appears under growth.

## Non-goals

- Reference-count correctness (#4542) and value representation (#4541). This
  slice is purely about two allocators not destroying each other.
