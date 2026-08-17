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

## Validation

- Canary probe above, run against the real pinned artifact.
- `pnpm run check:linear-ir`, emit-identity proof vs a pre-change baseline.
- A stress run that grows both heaps past their initial pages — the failure
  mode this slice exists to prevent only appears under growth.

## Non-goals

- Reference-count correctness (#4542) and value representation (#4541). This
  slice is purely about two allocators not destroying each other.
