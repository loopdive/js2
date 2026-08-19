---
id: 4540
title: "Heap coexistence in one linear memory: relocate the bump arena above the engine's heap base, passive data segments only"
status: in-progress
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
# The bulk of the new code went to a NEW module, src/codegen-linear/linked-arena.ts
# (~280 lines: the chunk-carving prologue, the passive-image installer, the
# linked-mode predicates). That took runtime.ts's growth from +340 to +98.
# What remains in the three god-files cannot move without making it worse:
#   runtime.ts (+98)  — one `ArenaOptions` field, the two mode refusals, the
#                       arena-limit global and the extra `__malloc` local. These
#                       ARE the arena; a module that owns half of `addRuntime`
#                       would split one function across two files.
#   index.ts (+97)    — `resolveLinkedHeap` (the validation that makes the
#                       catastrophic combination unrepresentable) plus the
#                       `LinearOptions` field. Option validation belongs next to
#                       the option it validates.
#   binary.ts (+33)   — two opcode cases, the passive-segment branch and the
#                       data-count section. Encoder cases only exist in the
#                       encoder.
loc-budget-allow:
  - src/codegen-linear/runtime.ts
  - src/codegen-linear/index.ts
  - src/emit/binary.ts
# Same reasoning, at function granularity. `encodeInstr` is the emitter's one
# opcode switch — a new opcode has nowhere else to be encoded (+14 for
# memory.init and data.drop). `emitBinaryWithSourceMapUnguarded` writes the
# section sequence in order, and the data-count section is only legal BETWEEN
# element and code (+19, with the passive-segment branch).
func-budget-allow:
  - src/emit/binary.ts::encodeInstr
  - src/emit/binary.ts::emitBinaryWithSourceMapUnguarded
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

- The artifact's first `malloc` returns an address above a 64 KiB `--stack-first`
  shadow stack at address 0 and ~105 KiB of static data.
- Our linear `__heap_ptr` initialises to a hard-coded **1024** (`HEAP_START` in
  `src/codegen-linear/runtime.ts`) — i.e. **inside the artifact's shadow
  stack**.

So the arena's very first allocation writes through the engine's stack.

### Correction (2026-08-19): the first-`malloc` constant is not portable

This section and ADR-0020 both recorded that first `malloc` as **171,696
(0x29EB0)**. Re-measured on a locally-built artifact from the *same* pinned refs
(quickjs-ng `954dc53`, wasi-libc `8d8348e`, nominally the same clang 18.1.3) it
is **172,176** — **+480**, because the static data shifted. Full layout as
measured 2026-08-19, read out of the binary and confirmed by running it:

| quantity | value |
| --- | --- |
| `__stack_pointer` global init | 65,536 → shadow stack `[0, 65536)`, grows down |
| static data | `[65536, 170392)`, 104,856 B in 2 active segments |
| `malloc(1)`, then `malloc(1)` | 172,176 then 172,192 (16-byte granularity) |
| memory | 256 pages initial (16 MiB), 16,384 max (1 GiB) |

**The substance of the collision claim is confirmed; the constant is not
evidence.** `HEAP_START = 1024` is inside `[0, 65536)` on any build of this
shape, and so are `DATA_SEGMENT_BASE = 64` and the Ryū `TABLE_BASE = 1024` /
`LINEAR_NUMBER_FORMAT_DATA_BASE = 16384`; the Ryū heap floor of 65,536 lands on
the *first byte* of static data. But anything that **hardcodes 171,696, or any
measured heap base, is wrong by construction** — the number is a property of one
build in one container, not of the artifact. Placement must be queried or
delegated, never baked. (Both numbers are recorded rather than one silently
replaced, because the discrepancy is the finding.)

### Correction (2026-08-19): "two growers corrupt" was not reproducible

This issue stated that *"two independent growers over one memory remains a
corruption hazard even after relocation"*. **Measured, that is false for this
artifact.** Probe: fill the engine's initial 16 MiB so its `dlmalloc` has grown,
then grow the memory independently from outside by 16 pages, fill the new region
with a canary, then make the engine allocate 8 MiB more. Result: **zero** engine
pointers landed inside the externally-grown region, **zero** canary bytes were
clobbered, and `eval("1+2")` still returned 3. wasi-libc's `MORECORE` re-derives
its break from `memory.size`, so an interleaved external grow just makes its next
segment non-contiguous, which it handles.

The real second hazard is the mirror image, and it is about the *claim*, not the
growth: our bump arena treats **everything from `__heap_ptr` to the end of
memory** as its own. Once the engine grows, the pages it just took are inside
the region the arena considers free, so the bump pointer walks into a live
engine heap. Relocating the base fixes the first collision and not this one —
which is exactly why a fixed `--global-base` is refused. The fix below removes
both by construction.

A second, independent hazard: **active data segments**. A linear module that
emits an active segment writes at a link-time offset straight through the
engine's static data. The #4236 probe module was safe only *by construction* —
it links to zero `DATA` section and never touches a global, so the only bytes
it can reach are ones it got from `malloc`.

## Scope

- **Fix heap ownership, not just the base address.** The boxed tier allocates
  from the engine's `malloc`; the native arena must sit above the artifact's
  `__heap_base` or be dynamically placed. Moving `HEAP_START` to a different
  constant is not a fix — the engine's heap grows. **Superseded in part** — see
  the Decision below: the engine allocates through *our* allocator, so placement
  becomes ours to answer rather than the artifact's to dictate.
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

## Decision (2026-08-18): write our own allocator and install it via the hook

Project-lead decision. The section above rejects supplying `JSMallocFunctions`
because the **bump arena** cannot serve — it never frees, so `free`, `realloc`
and `usable_size` have no honest implementation. That reasoning is correct and
stands. It rules out *the arena as the engine's allocator*; it does not rule out
**an allocator we write**, which is a fourth option this issue did not
previously consider. The direction is now:

> Implement a real allocator — `malloc`, `calloc`, `free`, `realloc`,
> `usable_size` — in the linear lane and install it as the engine's allocator
> via `JS_NewRuntime2`. One grower owns the address space because the module
> contains only one allocator. The typed arena survives as a bump fast path
> carved from **our own** heap, so ADR-0017's zero-metadata path is kept rather
> than traded.

Carve-from-the-engine's-`malloc` above is not deleted: it becomes the
**comparison baseline and the fallback** if the numbers below do not hold.

This is an ADR-0017-level change and should be recorded as one. That ADR
deferred intra-run reclamation while reserving "one fixed strategy, chosen and
recorded then, not abstracted now" — this is that choice arriving, for the
reason ADR-0020 already gives: targeting long-lived and native binaries makes
reclamation needed.

**What it buys over carving from the engine's `malloc`:**

- One allocator by construction rather than by discipline. There is no second
  implementation to coexist with, so the collision class is gone rather than
  managed.
- We own the address-space layout, making the arena's placement our decision
  instead of something read out of the artifact at runtime.
- Accounting becomes ours, so `JS_SetMemoryLimit` / `JS_SetGCThreshold` observe
  numbers we control.
- Dropping dlmalloc from the artifact may shrink it, which the ADR-0020 size
  budget (626,104 / 261,243 gzipped at `-O2`) cares about. Unverified — measure,
  do not assume.

**What it costs — price these before building:**

- **A real allocator is real work**: free lists, coalescing, realloc-in-place,
  fragmentation behaviour. Getting it wrong corrupts the engine's heap, not
  ours, so the failure surfaces inside foreign code.
- **dlmalloc is tuned for exactly this workload.** A JS engine allocates many
  small, short-lived objects; a first-cut allocator can lose materially on that
  pattern. The comparison must be measured against the pinned artifact's
  dlmalloc, not argued.
- **`js_malloc_usable_size` must be honest.** QuickJS uses it for accounting
  behind the memory limit and GC threshold. A wrong answer corrupts nothing but
  skews when the collector runs — a footprint or latency mystery far from its
  cause.
- It removes none of the rest of this slice: passive data segments, the
  absolute-address audit and the two-memory question are all orthogonal to which
  allocator wins.

**Ownership is now explicit, and it points our way (project-lead, 2026-08-19;
ADR-0020 Decision 6).** Two directions were left implicit and both are decided:

- **The linear memory is ours** — our module defines and exports it, the engine
  imports it. Today the reverse holds: `scripts/quickjs-artifact/build.sh:148`
  passes `-Wl,--export-memory`, so the artifact owns the memory and #4539's
  `declareImportedMemory` has us import it. Flipping this means rebuilding the
  artifact with `-Wl,--import-memory`. This is a build-flag change plus an emit
  change, and it has not been attempted — cost unmeasured.
- **The allocator is ours** — installed via `JS_NewRuntime2` so the engine
  allocates through us, with the typed arena as a bump fast path carved from
  our own heap.

This means the shipped slice is the RIGHT fix for the corruption class and the
WRONG ownership direction: carving our arena from the engine's `malloc` gives
one grower, but it is the engine's. Keep it as the working fallback; it is not
the end state. The costs recorded in the Decision above are unchanged by this —
they are the price of the intended direction, not of the fallback.

**Status 2026-08-19: NOT implemented in THIS slice; implemented in #4557.** See
"Implementation status" below — this slice shipped the recorded fallback (carve
from the engine's `malloc`), which closes the corruption class on its own.
The own allocator was then built in
[#4557](./4557-linear-own-allocator-engine-allocates-through-us.md): a real
`malloc`/`calloc`/`free`/`realloc`/`usable_size` in the linear lane, installed
through `qjs_new_runtime2` → `JS_NewRuntime2`. Three of that work's findings
correct assumptions recorded on THIS page:

- The `JSMallocFunctions` members are wired as **`__indirect_function_table`
  callbacks, not wasm imports** — five unconditional imports would make the
  artifact un-instantiable without a peer allocator, which `extract-abi.mjs`
  and the runtime-eval tier both require.
- The "many small, short-lived objects" premise this page uses to argue
  dlmalloc's tuning advantage is **false for quickjs-ng v0.16.1**: it has its
  own 4 KiB size-class arena in front of the embedder allocator, so an eval
  creating 120,000 objects makes **10** calls to the embedder allocator.
- Dropping dlmalloc did **not** shrink the artifact (it is still linked);
  it grew by 6,735 bytes.

**The fallback on this page stays the DEFAULT.** `linearHeapAllocator` is
opt-in; the measured end-to-end cost of the own allocator is 1.025×.

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

## Implementation status (2026-08-19) — slice 1 landed, allocator NOT attempted

Delivered: dynamic placement, passive data segments, the absolute-address audit,
and verification against the real artifact. **Not** delivered: our own
`malloc`/`free`/`realloc`/`usable_size` installed via `JS_NewRuntime2`. The
shim was not touched and the artifact was not rebuilt. The recorded fallback —
**carve the arena from the engine's `malloc`** — is what shipped, and it is
sufficient to close the corruption class on its own.

### What changed

| Area | Change |
| --- | --- |
| `src/codegen-linear/runtime.ts` | `ArenaOptions.linkedHeap`. In linked mode `__malloc` is a **chunked** bump arena: it carves chunks from an imported `malloc` and emits **no `memory.grow` at all**. `__heap_ptr` starts at 0 ("no chunk yet"), `__arena_limit` tracks the current chunk end. `finalizeLinkedDataImage` installs the passive literal image. |
| `src/codegen-linear/index.ts` | `LinearOptions.linkedHeap`, and `resolveLinkedHeap` makes `importMemory` **without** `linkedHeap` a compile error — the catastrophic combination is now unrepresentable rather than merely discouraged. |
| `src/codegen-linear/string-literals.ts` | Literal references become `global.get $__rodata_bias; i32.const <link-time offset>; i32.add` in linked mode. Rebasing per site, **not** inside `__str_from_data`: that helper is also called by the C ABI wrappers with a caller-supplied pointer, and biasing those would corrupt every string crossing the C boundary. |
| `src/codegen-linear/number-format.ts` | Literal segment is emitted **passive** in linked mode. `number.toString()` is **refused** in linked mode (see limitations). |
| `src/ir/types.ts`, `src/emit/{binary,wat,opcodes}.ts` | Passive data segments, `memory.init` / `data.drop`, and the **data-count section** (id 12, required before the code section or a validator rejects `memory.init` outright). All gated on a passive segment existing, so pre-existing modules are byte-identical. |

### Why one grower, established by construction

In linked mode the emitted module contains **no `memory.grow` opcode** — asserted
on the WAT, with a companion assertion that the standalone module *does* contain
one so the check cannot pass vacuously. The engine is the only grower because
ours has no instruction to grow with.

### Verified against the real artifact (`tests/issue-4540-heap-coexistence.test.ts`)

- **Canary / differential probe.** Run the workload with our module and record
  the exact `malloc` call sequence; replay that same sequence on a fresh engine
  with no module of ours present; diff `[0, 170392)`. The sequences are
  identical, so dlmalloc's state and shadow-stack residue match and **any**
  differing byte is a write by our module. Result: zero.
  **Not vacuous** — with the pre-fix placement temporarily restored
  (`heapStart = 1024`, carving disabled) the same assertion fails at
  `firstDiff === 1024`, the exact old `HEAP_START`.
- **Literal placement.** The literal image lands at an allocated address above
  the engine's static data; address 64 (its link-time base) still holds the
  engine's bytes.
- **Growth.** A workload that pushes 1.5 M array elements takes the memory from
  256 pages past its initial size while the engine holds a live runtime, a
  context and a 1 MiB filled block. The engine's block is byte-intact, `eval`
  still evaluates, and our arena still works on the enlarged memory.
- **Standalone emit identity.** `scripts/prove-emit-identity.mjs`: 60/60
  `(file, target)` hashes identical to a baseline captured before the first edit.

### Limitations, stated rather than hidden

- **`number.toString()` is refused in linked mode.** The Ryū tables are
  addressed by link-time constants spread across a large generated body
  (`TABLE_BASE` plus per-table cursors, appearing as both `i32.const` operands
  and `offset=` immediates). Rebasing them means rewriting every one of those
  sites correctly; miss one and the formatter silently reads engine memory and
  returns a plausible wrong number. A refused compile beats that. Follow-up:
  rebase the tables with the same `__rodata_bias`.
- **`exposeArenaReset` is refused in linked mode.** The linked arena is a chain
  of host-allocated chunks; an O(1) rewind would strand every chunk but the
  last — an unbounded leak from the export that exists to prevent leaks. Freeing
  the chain needs a chunk list, which is follow-up work.
- **Chunks are never freed.** ADR-0017's never-free property is unchanged; it is
  now scoped to chunks rather than to the whole address space. This is the
  reclamation gap the own-allocator decision exists to close.
- **Start-function ordering is a contract, not an enforcement.** The image copy
  runs in our module's `start`, which calls the engine's `malloc`; the engine
  must therefore be instantiated and `_initialize`d first. That is the linked
  topology's normal order, but nothing in the binary can check it.

### Corrections to this issue found while implementing

1. The first-`malloc` constant is environment-dependent (above).
2. "Two independent growers corrupt" did not reproduce (above).
3. The issue named `HEAP_START = 1024` as the collision. It is **one of five**
   colliding constants: `HEAP_START` 1024, `DATA_SEGMENT_BASE` 64,
   Ryū `TABLE_BASE` 1024, `LINEAR_NUMBER_FORMAT_DATA_BASE` 16384, and
   `LINEAR_NUMBER_FORMAT_HEAP_START` 65536. The last is the worst of them and
   was not mentioned: it is not merely inside the shadow stack, it is the exact
   first byte of the engine's **static data**.
4. The issue treats active data segments as a hazard alongside the arena. They
   are strictly worse: an active segment is written **at instantiation**, before
   any instruction of ours runs, so no discipline in our generated code can
   mitigate it.

### Unrelated pre-existing failures observed (NOT caused by this work)

Both reproduce with these changes fully reverted on the same commit:

- `pnpm run check:linear-ir` — `IR-compiled function count DECREASED: 8 → 6`,
  buckets `illegal:instr-vec.set_length` and `select:string-builder-candidate`
  each `0 → 2`.
- `tests/emit-encodeinstr-failloud.test.ts` — the `br_table` case throws
  `Cannot read properties of undefined (reading 'length')` instead of a message
  naming `br_table`.

## Acceptance criteria

Ticked only where the criterion was **exercised**, not merely reasoned about.

- [x] A linked module allocates, writes, and reads without touching any byte it
      did not obtain from an allocator. **Met, by a different probe than the one
      specified.** A canary *fill* of the engine's static region is not usable —
      that region holds live dlmalloc state, so filling it stops the engine
      working. The differential probe (replay the identical `malloc` sequence on
      a pristine engine, diff `[0, 170392)`) attributes every differing byte to
      our module with no canary at all, and its negative control fails at
      exactly 1024. A canary *is* used for the engine's heap block in the growth
      test, where filling is safe.
- [x] All literal data in linked mode is emitted via passive segments; an
      emit-time assertion rejects active segments in that mode
      (`finalizeLinkedDataImage` throws and names the offending ranges). A
      companion test asserts the standalone lane still emits an ACTIVE segment,
      so the passive assertion cannot pass by accident.
- [x] Standalone (unlinked) output is unchanged — `prove-emit-identity`, 60/60
      identical against a baseline captured before the first edit.
- [x] The refused alternatives are recorded with their failure mode, here and in
      ADR-0022. Note the correction above: *spacing* is refused because the
      engine's heap grows into the region the arena claims, which is a different
      (and reproducible) reason from the "two growers corrupt" one originally
      recorded, which did not reproduce.
- [x] Exactly **one** component grows linear memory, established by
      construction: the linked module contains **no `memory.grow` opcode**
      (asserted on the WAT, with a discriminating counter-assertion that the
      standalone module does contain one). The growth test drives the shared
      memory past the engine's initial 256 pages with both workloads live.

- [ ] The arena-carved-from-`malloc` design is measured against routing typed
      allocation directly at the engine's `malloc` — **NOT DONE. No numbers were
      taken and none should be inferred from this work.** Carve-from-`malloc` is
      what shipped; the direct-`malloc` comparison arm was never built.
- [ ] The **two-memory** alternative is explicitly decided — **NOT DONE.** Left
      open deliberately: it carries a security dimension (one shared memory
      means an exploited `eval` reaches our arena) that is a project-lead call,
      not something this slice should settle by shipping one side of it.

- [ ] The linear lane implements `malloc`/`calloc`/`free`/`realloc`/
      `usable_size` and installs them via `JS_NewRuntime2`; a test asserts the
      engine reaches **no** dlmalloc entry point. — **NOT ATTEMPTED.**
      `qjs_shim.c` is untouched and the artifact was not rebuilt.
- [ ] `js_malloc_usable_size` reports the true reserved size, asserted across a
      spread of allocation sizes rather than assumed from the request. — **NOT
      ATTEMPTED** (no allocator).
- [ ] The allocator is measured against the pinned artifact's dlmalloc on an
      engine-realistic workload (many small, short-lived allocations) and both
      numbers are recorded. A material regression is grounds to fall back to
      carve-from-`malloc`, which stays the baseline for exactly this reason. —
      **NOT ATTEMPTED** (no allocator). The fallback is what shipped.
- [~] The typed arena keeps its zero-metadata bump path, carved from our own
      heap; standalone (unlinked) emit-identity is unchanged. — **half met.**
      The bump path is intact and emit-identity holds, but the heap it is carved
      from is the **engine's**, not ours.
- [ ] A stress run that frees and reallocates enough to exercise coalescing
      shows a bounded heap — the failure this allocator exists to prevent only
      appears under reuse, not under allocate-and-exit. — **NOT DONE, and not
      currently meaningful:** nothing frees. Chunks are never returned. This is
      the open reclamation gap the own-allocator decision exists to close.

**The five own-allocator criteria above now belong to #4557** ("Invert allocator
ownership: a real linear-lane allocator, installed via JS_NewRuntime2 so QuickJS
allocates through us"), which is in progress. They are kept here with their
honest NOT-ATTEMPTED annotations as the record of what this slice did and did
not do; #4557 is where they get closed. An unannotated duplicate of the same
five was removed rather than left to drift out of sync with them.

## Validation

- Differential probe above, run against the real pinned artifact
  (`tests/issue-4540-heap-coexistence.test.ts`, 10 tests, all passing).
- `pnpm run check:linear-ir` — **fails, and fails identically with these changes
  reverted on the same commit.** Pre-existing; see above.
- Emit-identity proof vs a pre-change baseline: 60/60 identical.
- A stress run that grows the shared memory past its initial pages with both
  workloads live.

## Non-goals

- Reference-count correctness (#4542) and value representation (#4541). This
  slice is purely about two allocators not destroying each other.
