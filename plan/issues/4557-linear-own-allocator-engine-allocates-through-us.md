---
id: 4557
title: "Invert allocator ownership: a real linear-lane allocator, installed via JS_NewRuntime2 so QuickJS allocates through us"
status: done
sprint: current
created: 2026-08-19
updated: 2026-08-19
completed: 2026-08-19
# Implementation complete and all acceptance criteria exercised (see
# "Implementation notes"). `in-review` rather than `done` because this lane does
# not merge: the project lead consolidates. Flip to `done` on merge.
priority: high
horizon: l
feasibility: hard
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
depends_on: [4540]
related: [652, 1856, 4236, 4539]
assignee: ttraenkler/senior-dev
# Growth on top of #4540's grants: the allocator is a NEW module
# (src/codegen-linear/heap-allocator.ts), so what these cover is only the
# wiring that could not live anywhere else — the `heapAllocator` option next to
# the option it configures, and two opcode cases in the one opcode switch.
loc-budget-allow:
  - src/codegen-linear/runtime.ts
  - src/codegen-linear/index.ts
  - src/emit/binary.ts
func-budget-allow:
  - src/emit/binary.ts::encodeInstr
# id 4557 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-19 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: open PRs were 4646,
# 4649, 4650, 4651; only 4651 touches issue files and its highest id is 4402.
# Highest id on main is 4554, so the space above it was clear.
---

# #4557 — QuickJS allocates through our allocator, not its own

Project-lead decision, 2026-08-19. Implements [ADR-0020](../../docs/adr/0020-linear-dynamic-tier-quickjs-jsvalue.md)
Decision 6 (allocator half). #4540 recorded this direction and shipped the
opposite as a working fallback; this issue is the inversion.

## Problem

Ownership currently points at the engine, in both places it can:

- `scripts/quickjs-artifact/qjs_shim.c:85` is
  `JSRuntime *QJS_EXPORT(qjs_new_runtime)(void) { return JS_NewRuntime(); }` —
  the plain constructor, so the engine uses its built-in dlmalloc.
- `src/codegen-linear/linked-arena.ts` makes our `__malloc` a **chunked bump
  arena whose chunks come from the engine's imported `malloc`**. One grower, but
  the engine's.

That fallback is correct as far as it goes — it closes the corruption class
#4540 exists for — and it is not the intended end state.

The reason our arena cannot simply be handed to the engine is recorded in
#4540 and still holds: `JSMallocFunctions` requires a real `free`, `realloc`
and `usable_size`, and the bump arena by design never frees (ADR-0017). So the
inversion is gated on writing an allocator, not on wiring.

## Scope

1. **A real allocator in the linear lane** — `malloc`, `calloc`, `free`,
   `realloc`, `malloc_usable_size`; free lists, coalescing, realloc-in-place
   where possible. ADR-0017 deferred reclamation while reserving "one fixed
   strategy, chosen and recorded then, not abstracted now"; this is that choice.
2. **Export them**, and have the artifact import them.
3. **Shim**: a constructor building `JSMallocFunctions` from imported functions
   and calling `JS_NewRuntime2`. `qjs_shim.c` already uses an `export_name`
   attribute macro (line 64) — mirror that style for `import_module`/
   `import_name`. Rebuild with `bash scripts/quickjs-artifact/build.sh`.
4. **Keep the typed arena** as a bump fast path carved from *our own* heap, so
   ADR-0017's zero-metadata path is kept rather than traded.
5. **Keep the #4540 fallback selectable.** If the numbers below do not hold, it
   is where we retreat to.

## Known hazards — answer these, do not assume them

- **`js_malloc_usable_size` must be honest.** QuickJS drives
  `JS_SetMemoryLimit` / `JS_SetGCThreshold` off it. A wrong answer corrupts
  nothing and skews *when the collector runs* — a footprint or latency mystery
  far from its cause. Assert against a spread of sizes; do not assume it equals
  the request.
- **This may not actually deliver "one grower".** wasi-libc inside the artifact
  still calls dlmalloc for its own purposes, outside `JSMallocFunctions`.
  Whether dlmalloc still grows the memory is an open question, not a detail. If
  two growers survive, that is the finding.
- **dlmalloc is tuned for exactly this workload** — many small, short-lived
  objects. Ours can lose materially. Measure against the pinned artifact rather
  than arguing.

## Acceptance criteria

Ticked only where the criterion was **exercised**. Evidence is in
`tests/issue-4557-own-allocator.test.ts` unless another source is named.

- [x] The engine reaches our allocator, **proven by counting calls**, not
      inferred from the wiring. Four call counters live in the emitted module
      (`__heap_stats(4..7)`) and are read back from OUR side, so no JS closure
      sits on the allocation path distorting what is measured. Creating the
      runtime + context alone is 58 allocations; an eval adds more.
- [x] `malloc_usable_size` reports true reserved size across a spread of sizes.
      Measured, and it is **not** the request: `malloc(1)→12`, `13→20`,
      `31→36`, `100→100`, `1000→1004`. The test also WRITES the full reported
      reservation, so an over-report would trap rather than pass.
- [x] An `eval`-in-a-loop fixture against the real artifact shows a **bounded**
      heap. 12 rounds: region bytes flat at 196,608 from round 3 onward,
      QuickJS's own `malloc_size` flat at 68,304, memory flat at 256 pages.
- [x] Allocator measured against the artifact's dlmalloc; **both numbers
      recorded** — see "Measurements" below.
- [x] Whether exactly one component grows the memory is **answered explicitly**
      — see "Who grows the memory" below.
- [x] Standalone (unlinked) emit identity unchanged — 60/60 records identical
      to a baseline captured before the first edit (`prove-emit-identity`).

## Non-goals

- **Memory ownership** (our module exporting the memory, the engine importing
  it via `-Wl,--import-memory`) — the other half of ADR-0020 Decision 6, only
  in scope here if it proves *required* to make the allocator work.
  **NOT required, and the reason is worth recording**: it would have been
  required under the *import-based* wiring this issue originally specified,
  because that creates an instantiation CYCLE (the engine imports the allocator
  from us; we import the memory from the engine, and neither can instantiate
  first). The table-callback wiring actually used has no cycle, so memory
  ownership stays untouched. See "Wiring" below.
- Refcount discipline (#4542) and value representation (#4541).

---

## Implementation notes (2026-08-19)

### What was built

| Area | Change |
| --- | --- |
| `src/codegen-linear/heap-allocator.ts` (new) | The allocator. 4-byte block header, boundary tags with a footer in free blocks only, `PINUSE`/`INUSE` flag bits, 32 exact-size small bins (16…264 B) + 16 power-of-two large bins, both-direction coalescing, `realloc` in place in both directions, honest `usable_size`, overflow-checked `calloc`. Control block carved from the FIRST region (no link-time address exists in linked mode — ADR-0022), pointed at by one global `__heap_ctl`. |
| `src/codegen-linear/runtime.ts` | `ArenaOptions.heapAllocator: "bump" \| "malloc-v1"`. Under `malloc-v1` the allocator is emitted first and `__malloc` becomes the SAME chunked bump prologue #4540 already ships — only the chunk source moves, from the engine's `malloc` to our `__heap_alloc`. ADR-0017's zero-metadata typed path is kept, now over our own heap. |
| `src/codegen-linear/linked-arena.ts` | Split `isLinkedArena` (imports its memory) from `hasChunkedArena` (`__arena_limit` exists). They were the same question only while a chunked arena implied linked mode; `malloc-v1` gives a STANDALONE module a chunked arena too, and left merged it would have emitted a passive Ryū segment with nothing to copy it in. |
| `src/emit/{binary.ts}`, `src/ir/types.ts` | `memory.copy` / `memory.fill` (`0xFC 10/11`). `calloc` must zero and `realloc` must relocate; a hand-written byte loop for either puts an interpreter loop on the allocator's path. Neither needs the data-count section. |
| `scripts/quickjs-artifact/qjs_shim.c` | `qjs_set_allocator(5 table slots)` + `qjs_new_runtime2()` → `JS_NewRuntime2(&mf, NULL)`. Every scratch allocation in the shim also follows the peer allocator, and `qjs_libc_alloc_count()` reports how many did not. `qjs_malloc_size`/`qjs_malloc_count` expose QuickJS's own accounting so a wrong `usable_size` shows up as a number. |

### Wiring: table callbacks, not imports — and why the issue's instruction could not be followed

The issue (scope item 3) specifies
`__attribute__((import_module("js2wasm"), import_name(...)))`. **That encoding
cannot be used, and the reason only shows up downstream.** A wasm import must be
satisfied at INSTANTIATION, so five unconditional imports make the artifact
un-instantiable without a peer that supplies an allocator. Two shipped
configurations do exactly that:

- `scripts/quickjs-artifact/extract-abi.mjs` instantiates the artifact ALONE to
  read the ABI constants out of it — that is how the build produces
  `qjs-abi.json`;
- the runtime-eval tier instantiates it beside an adapter that imports FROM it
  and exports no allocator.

Both would have to hand it JS closures, which is what
`assertQuickjsArtifactStandalone` exists to forbid ("wasi-stub.mjs is the ONLY
JavaScript allowed behind the seam"). So this mirrors the **#4245 membrane**,
which solved the identical problem in the same file: the peer's functions go
into the artifact's exported, growable `__indirect_function_table` and are
called through it. The edge stays wasm→wasm, and the artifact **still imports
only `wasi_snapshot_preview1`** — asserted in the test. Cost: one indirect call
per allocation instead of a direct one.

`qjs_set_allocator` REFUSES once the shim has already served a libc allocation,
so a pointer minted by dlmalloc can never be freed through the peer.

### Correction to this issue: the "many small, short-lived objects" premise is FALSE for this engine

The issue and ADR-0020 both reason from "a JS engine allocates many small,
short-lived objects; dlmalloc is tuned for exactly that; a first-cut allocator
can lose materially". **Measured against the pinned artifact, quickjs-ng
v0.16.1 does not hand that pattern to `JSMallocFunctions` at all.** It has its
own size-class arena (`JSArenaState`, `JS_ARENA_SIZE = 4096`,
`JS_ARENA_BLOCK_SIZE_COUNT = 31`, `quickjs.c:266`) between the interpreter and
the embedder allocator.

Request-size histogram for an eval that creates **120,000 objects**, read out of
our own allocator (`__heap_stats(16..31)`):

| bucket | calls |
| --- | --- |
| 8–15 B | 1 |
| 128–255 B | 1 |
| 512–1023 B | 2 |
| 2048–4095 B | 6 |
| **total** | **10** |

Ten calls, not 120,000. The distribution that reaches us is a handful of ~4 KiB
arenas plus occasional large blocks. Any benchmark run on a synthetic
many-tiny-allocations pattern is measuring something this engine never asks for.

### Measurements (2026-08-19, this container, artifact rebuilt from the current shim)

Artifact: quickjs-ng `954dc53` / wasi-libc `8d8348e`, clang 18.1.3, `-O2`.
`.tmp/qjs-alloc-bench.mjs`, medians of 7.

**End-to-end engine workload** (120,000 objects + arrays + string keys, evaluated
by the engine, identical source both sides):

| allocator | median |
| --- | --- |
| dlmalloc (`JS_NewRuntime`) | 73.13 ms |
| ours (`JS_NewRuntime2`) | 74.98 ms |
| **ratio** | **1.025×** |

**Allocator microbenchmarks**, driven from JS against the same shared memory,
with the JS→wasm call floor measured (`qjs_noop`, 0.62 ms / 200k calls) and
subtracted:

| pattern | dlmalloc | ours | ratio (floor-subtracted) |
| --- | --- | --- | --- |
| engine-shaped (4 KiB arenas + large) | 3.26 ms | 3.51 ms | **1.076×** |
| many small short-lived (8–256 B) | 3.04 ms | 6.29 ms | **2.068×** |

The 2× on the small pattern is real and it is **not** instrumentation: an A/B
with the counters and histogram removed measured 6.93 ms vs 6.91 ms — within
noise. The cause is that `__heap_alloc` makes four to five non-inlined wasm
calls per allocation (`__heap_find`, `__heap_unlink`, `__heap_insert`, and
`__heap_bin` three times) where dlmalloc inlines its whole fast path. It does
not bind on the engine workload, because that pattern does not reach us.

**Artifact size**: 1,016,254 → 1,022,989 bytes raw (349,808 → 352,305 gzipped),
**+6,735 / +2,497**. ADR-0020 speculated that dropping dlmalloc might shrink the
artifact; it did not, because dlmalloc is still linked — see below.

### Who grows the memory — answered explicitly

**Exactly one component grows it: the engine's dlmalloc. That is unchanged by
this work, and dlmalloc is NOT eliminated.**

- Our emitted module contains **no `memory.grow` instruction at all** in linked
  mode — asserted on the WAT, with #4540's discriminating counter-assertion
  that the standalone module does contain one. Installing our allocator does
  not change this: our allocator takes whole REGIONS from the engine's `malloc`
  and sub-allocates inside them.
- Measured: six evals of the workload with our allocator installed leave the
  memory at 256 pages.
- **What still allocates outside `JSMallocFunctions`:** the shim's own scratch
  allocations would, and they were rerouted — `qjs_libc_alloc_count()` reads
  **0** after a full workload. What remains outside is (a) our own region
  requests, which go to the engine's `malloc` by design, and (b) anything
  wasi-libc allocates for itself. On this artifact (b) is not exercised by the
  eval path — the artifact imports only five WASI functions and the build has
  no stdio in the hot path — but it is **not** zero by construction, and
  dlmalloc remains linked, which is why the artifact did not shrink.
- So the honest statement is: **QuickJS's heap is ours; the address space is
  still the engine's.** Flipping that is the memory-ownership half of Decision
  6, which is out of scope here.

### Recommendation

**Keep `bump` (the #4540 fallback) as the DEFAULT; ship `malloc-v1` opt-in**,
which is what this change does — `linearHeapAllocator` is undefined for every
existing caller and standalone emit is byte-identical.

The measured case for adopting it in the linked/dynamic tier is good and the
decision is the project lead's: it costs **2.5% end-to-end** and buys real
reclamation, which the linked chunked arena does not have at all (its chunks are
never returned). The case against flipping the default *today* is that the
allocator is new and a bug in it corrupts the engine's heap, where the failure
surfaces inside foreign code. Suggested order: enable for the dynamic tier
first, leave standalone on the bump arena.

### Follow-ups (not done)

1. **Small-allocation fast path.** Inline `__heap_bin` and stop recomputing the
   bin index in `__heap_unlink`/`__heap_insert`; that is most of the 2× above.
   Only worth it if a future engine version stops arena-ing small allocations.
2. **`exposeArenaReset`** is still refused with a chunked arena (unchanged from
   #4540) — now for both chunk sources. Freeing the chunk chain needs a chunk
   list.
3. **Region source in linked mode** is fixed to the host `malloc`. Letting it be
   `memory.grow` would drop dlmalloc from the region path but give up #4540's
   by-construction one-grower proof. Not attempted.

### Pre-existing failures observed, NOT caused by this work

- `pnpm run check:godfiles` — 14 regressions, all in `src/codegen/`
  (`index.ts`, `object-runtime.ts`, `array-methods.ts`, `native-strings.ts`,
  `expressions/calls.ts`). This change touches none of those files; the
  flagged-file set and the changed-file set do not intersect.
- `pnpm run check:linear-ir` and `tests/emit-encodeinstr-failloud.test.ts` were
  already recorded as red on this branch by #4540.
