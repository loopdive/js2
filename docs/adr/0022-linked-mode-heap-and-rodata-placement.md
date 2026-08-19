# ADR-0022: Linked-mode heap and read-only-data placement in the linear backend

Status: Accepted for the placement question (2026-08-19, #4540). The **allocator
ownership** question it defers to is recorded as decided in #4540 and is
**unimplemented**; see "What this ADR does not decide".

Supersedes nothing. Constrains [ADR-0017](./0017-linear-bump-arena-allocator.md)
and implements a prerequisite of
[ADR-0020](./0020-linear-dynamic-tier-quickjs-jsvalue.md).

## Context

ADR-0020 links our compiled linear-memory code against a pinned quickjs-ng
artifact over **one shared linear memory**. ADR-0017 gave the linear backend a
bump arena that assumes it owns the address space: `__heap_ptr` initialises to a
fixed floor and, when it runs out of room, calls `memory.grow`.

Those two assumptions are incompatible. Measured against the pinned artifact on
2026-08-19 (quickjs-ng `954dc53`, wasi-libc `8d8348e`, wasm32-wasip1,
`--stack-first`):

| quantity | value |
| --- | --- |
| `__stack_pointer` init | 65,536 → shadow stack `[0, 65536)`, grows down |
| static data | `[65536, 170392)`, 104,856 B, 2 **active** segments |
| `malloc(1)` | 172,176 |
| memory | 256 pages initial, 16,384 max |

Against that layout, **five** fixed constants in `src/codegen-linear/` address
memory the artifact owns:

| constant | value | lands in |
| --- | --- | --- |
| `HEAP_START` | 1,024 | engine shadow stack |
| `DATA_SEGMENT_BASE` | 64 | engine shadow stack |
| Ryū `TABLE_BASE` | 1,024 | engine shadow stack |
| `LINEAR_NUMBER_FORMAT_DATA_BASE` | 16,384 | engine shadow stack |
| `LINEAR_NUMBER_FORMAT_HEAP_START` | 65,536 | first byte of engine **static data** |

Two failure modes, and they are not equally bad. The arena's first allocation
writes through the engine's stack — bad, but our code has to run first. An
**active data segment** is written by the runtime **at instantiation**, at the
offset baked into the binary, before a single instruction of ours executes. No
discipline in generated code can mitigate that one.

**The specific constant 172,176 is not evidence and must never be hardcoded.**
#4236 and ADR-0020 both record 171,696 for the same pinned refs; the local build
differs by 480 because static data shifted. Placement has to be delegated or
queried, never baked.

### A claim that did not reproduce

#4540 recorded that "two independent growers over one memory remains a
corruption hazard even after relocation". Probed on 2026-08-19: fill the
engine's initial 16 MiB so its `dlmalloc` has grown, grow the memory
independently from outside, canary the new region, then make the engine allocate
8 MiB more. **Zero** engine pointers landed in the external region, **zero**
canary bytes were clobbered, `eval("1+2")` still returned 3. wasi-libc's
`MORECORE` re-derives its break from `memory.size`, so an interleaved external
grow merely makes its next segment non-contiguous, which it handles.

The real second hazard is the mirror image and is about the arena's *claim*, not
about growth: the bump arena treats everything from `__heap_ptr` to the end of
memory as its own. Once the engine grows, the pages it just took lie inside the
region the arena considers free, so the bump pointer walks into a live engine
heap.

## Decision

**In linked mode — i.e. whenever the module imports its memory — the linear
backend owns no address. It obtains every address from the memory's owner.**

1. **The arena is chunked and carved from the owner's allocator.** `__malloc`
   bump-allocates inside a chunk obtained from an imported `malloc`, and carves
   a new chunk when the current one is exhausted. An oversized request gets its
   own exactly-sized chunk. ADR-0017's zero-metadata bump path is preserved
   *inside* a chunk; only chunk acquisition pays the host allocator's cost.

2. **The emitted module contains no `memory.grow` opcode in this mode.** "Exactly
   one component grows the memory" therefore holds by construction: ours has no
   instruction to grow with.

3. **Read-only data is emitted as a passive segment and copied into an allocated
   block.** A `start` function allocates the image through `__malloc` and
   `memory.init`s it, then `data.drop`s the segment. Literal *references* are
   rebased through a single `__rodata_bias` global, because the image preserves
   the link-time layout byte for byte, so one bias corrects every offset in it.

4. **Emitting an active data segment in linked mode is a hard emit-time error**,
   not a lint.

5. **`importMemory` without a linked heap is a compile error.** The catastrophic
   combination is unrepresentable rather than discouraged.

6. **Standalone mode is untouched**, proven by byte-identical emit across the
   full identity corpus.

### Where the rebase lives, and where it must not

Literal references are rebased **at each literal site**, not inside
`__str_from_data`. That helper is also called by the C ABI wrappers with a
*caller-supplied* pointer; biasing inside it would corrupt every string crossing
the C boundary. This is the kind of "one obvious central place" that is wrong
because the helper has two callers with different address provenance.

## Alternatives rejected

**Relocate `HEAP_START` to a higher fixed constant** (or link with
`--global-base` above the artifact's `__heap_base`). Rejected. It fixes the base
collision and not the claim collision: the engine's heap grows upward into
whatever range we picked, so the constant is correct only until the first
sufficiently large workload. It also re-bakes an environment-dependent number —
the exact defect the 171,696-vs-172,176 discrepancy demonstrates.

**Space the two arenas apart and rely on discipline.** Rejected for the same
reason, plus it makes correctness a property nobody can check from the artifact.

**PIC / side-module dynamic linking.** Correct, and much larger. Recorded in
#4236's preference order as option (c); passive segments (option (a)) are local
to codegen and need no link-time negotiation.

**Query the artifact's `__heap_base` at runtime.** Not available — the artifact
is linked `--strip-all` and exports no such global — and it would not help
anyway: it names where the engine's heap *starts*, not where it ends.

## What this ADR does not decide

**Who ultimately owns allocation.** #4540 records a project-lead decision to
write our own `malloc`/`calloc`/`free`/`realloc`/`usable_size` and install it via
`JS_NewRuntime2`, keeping the arena as a bump fast path carved from our own heap.
That decision stands and is **unimplemented**: `qjs_shim.c` still calls plain
`JS_NewRuntime()`. What this ADR ships is the recorded **fallback and comparison
baseline** — carve from the engine's `malloc` — which closes the corruption class
on its own and is a prerequisite either way.

**The one-memory-versus-two-memories question**, including the security
consequence of sharing one memory with an engine whose purpose is to execute
`eval` input. Recorded as open in #4540.

**Reclamation.** Chunks are never freed. ADR-0017's never-free property is
unchanged, merely rescoped from the whole address space to a chain of chunks.
`__arena_reset` is *refused* in linked mode rather than silently redefined: an
O(1) rewind would strand every chunk but the last.

## Consequences

- Linked modules gain one extra global (`__arena_limit`), one extra `__malloc`
  local, a `__rodata_bias` global, a start function, and a data-count section.
  Standalone modules gain nothing and emit identical bytes.
- **`number.toString()` is refused in linked mode.** The Ryū tables are addressed
  by link-time constants spread across a large generated body, as both
  `i32.const` operands and `offset=` immediates. Rebasing them means rewriting
  every such site correctly, and missing one makes the formatter read engine
  memory and return a plausible wrong number. Follow-up work is to rebase them
  with the same `__rodata_bias`.
- **Instantiation order becomes a contract.** The start function calls the
  engine's allocator, so the engine must be instantiated and `_initialize`d
  first. Nothing in the binary can enforce this.
- The emitter gained passive data segments, `memory.init` / `data.drop`, and the
  data-count section — all gated on a passive segment existing.
