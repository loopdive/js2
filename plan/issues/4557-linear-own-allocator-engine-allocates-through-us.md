---
id: 4557
title: "Invert allocator ownership: a real linear-lane allocator, installed via JS_NewRuntime2 so QuickJS allocates through us"
status: in-progress
sprint: current
created: 2026-08-19
updated: 2026-08-19
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

- [ ] The engine reaches our allocator, **proven by counting calls**, not
      inferred from the wiring.
- [ ] `malloc_usable_size` reports true reserved size across a spread of sizes.
- [ ] An `eval`-in-a-loop fixture against the real artifact shows a **bounded**
      heap — the property the bump arena cannot provide.
- [ ] Allocator measured against the artifact's dlmalloc on an
      engine-realistic pattern; **both numbers recorded**. A material
      regression keeps the #4540 fallback as default, and that is an
      acceptable outcome of this issue.
- [ ] Whether exactly one component grows the memory is **answered explicitly**,
      including what wasi-libc still does.
- [ ] Standalone (unlinked) emit identity unchanged — 60/60 records.

## Non-goals

- **Memory ownership** (our module exporting the memory, the engine importing
  it via `-Wl,--import-memory`) — the other half of ADR-0020 Decision 6, only
  in scope here if it proves *required* to make the allocator work.
- Refcount discipline (#4542) and value representation (#4541).
