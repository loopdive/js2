# ADR-0020: QuickJS `JSValue` as the linear backend's dynamic tier

Status: Accepted — decided by the project lead 2026-08-08 (recorded in #4236);
written up as an ADR 2026-08-17 when the implementation program (#4538) was
scheduled.

## Context

The linear backend (`src/codegen-linear/`, the WASI/native target per
[ADR-0003](./0003-wasmgc.md) and the codegen-axes split) has **no dynamic value
representation at all**. `layout.ts` is a static fat-slot model over
compile-time-planned records; a value the middle-end cannot give a single type
has nowhere to live. Everything a JS engine provides for that residue —
dynamic property add/delete, prototype chains, interned keys, the builtin
surface, `eval`, and reclamation — would otherwise have to be built from
scratch.

[ADR-0017](./0017-linear-bump-arena-allocator.md) deliberately deferred
intra-run reclamation, recording that *if* it were ever needed we would commit
to **one** fixed strategy, "chosen and recorded then, not abstracted now".
Targeting long-lived and native binaries makes it needed. This ADR is that
record.

Two measurements from #4236 (2026-08-08, one container, scripts preserved in
that issue) set the shape of the answer:

- AOT-compiled JS beats engine-interpreted JS by **~4×** on identical work
  (84.6 ms vs 349.6 ms parsing a 226 KB corpus) — compiling wins wherever
  types and structure are static.
- Our Phase-1 self-hosted eval interpreter loses to the same engine by
  **~400×** (1857 ms vs 4.7 ms) — it is a correctness vehicle, not a
  performance one.

A spike and a follow-up slice then proved the link is real: a wasi-sdk build of
quickjs-ng (pinned v0.16.1 / `954dc53`) imports **five** `wasi_snapshot_preview1`
functions and nothing else, shares one linear memory with a peer module, and
preserves object identity and two-way mutation across the seam at **1.86 ns**
per cross-module call.

## Decision

1. **The linear backend's dynamic residue is represented as QuickJS
   `JSValue`.** Typed code is untouched: unboxed `i32`/`f64` and planned record
   layouts stay exactly as they are, and keep the measured AOT win.
2. **`JSValue` is opaque.** All manipulation goes through the QuickJS C API
   with codegen-enforced refcount discipline. Internal layouts — NaN-boxing
   configuration, shapes, atoms — are never open-coded: they are not a stable
   ABI and vary by build flags.
3. **Immediate fast paths come from build-time tag extraction.** A small shim
   in the pinned artifact exports the tag constants and float64 encoding, so
   number box/unbox lowers to inline sequences learned from that build rather
   than hardcoded constants. Refcounted values stay API-mediated.
4. **The C-API seam is the engine boundary.** If the dynamic tier later
   justifies an owned runtime, it swaps in behind the same seam without
   touching the front-end.
5. **Reclamation for the linear backend is therefore reference counting plus
   the engine's cycle collector** — the single fixed strategy ADR-0017
   deferred. The bump arena remains for typed, compile-time-planned
   allocations.

## Scope

- **The WasmGC backend is unaffected.** `JSValue` cannot hold WasmGC
  references, so that lane keeps its own dynamic family and the self-hosted
  interpreter for `eval`.
- This is a **deliberate, scoped exception** to the standing non-goal recorded
  with the backend-agnostic-IR work (#3299) — *do not adopt an external
  engine's object layouts, builtins, or GC wholesale*. The exception covers
  **only** the dynamic residue on the linear target, reached **only** through
  the C API. Planned and typed data keeps our own layouts, which is what that
  non-goal exists to protect.

## Consequences

- The linear lane gains a finished runtime — builtins, RegExp, `eval`, and a
  collector — where it previously had nothing, and caps the cold dynamic tier
  at best-in-class-interpreter speed instead of the 400× interpreter cost.
- **It costs a fixed artifact size**: measured 1,011,134 bytes raw / 350,017
  gzipped at `-O2`; `-Oz` gives 626,104 / 261,243 but costs ~23% on both eval
  and per-property time. The tier must therefore be **pay-for-what-you-use**,
  elided entirely when a program's dynamic residue is empty (#4544).
- **Two allocators over one linear memory is a real corruption hazard**, not a
  theoretical one: the artifact's first `malloc` returns 171,696, while our
  linear `__heap_ptr` initialises to a hard-coded 1024 — inside the artifact's
  shadow stack. Heap coexistence is a correctness prerequisite (#4540).
- **Refcount discipline becomes a codegen obligation** on every path, including
  exceptional ones; getting it wrong leaks or double-frees (#4542).
- **Cycles that close through native memory are invisible to the engine's
  collector.** This is a documented leak class with a weak-wrapper mitigation,
  accepted for this lane (#4541).
