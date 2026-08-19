# ADR-0020: QuickJS `JSValue` as the linear backend's dynamic tier

Status: Accepted — decided by the project lead 2026-08-08 (recorded in #4236);
written up as an ADR 2026-08-17 when the implementation program (#4538) was
scheduled. **Corrected 2026-08-19** — the original text defined the dynamic
tier's trigger as *statically untyped*; the trigger is *eval-reachable*. That
was a drafting mistake, not a superseded decision, so it is fixed in place. See
Corrections at the end for what changed.

## Context

The linear backend (`src/codegen-linear/`, the WASI/native target per
[ADR-0003](./0003-wasmgc.md) and the codegen-axes split) has **no dynamic value
representation at all**. `layout.ts` is a static fat-slot model over
compile-time-planned records; a value that must be reachable from code the
compiler never sees has nowhere to live. Everything a JS engine provides for that residue —
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

1. **The linear backend's eval-reachable values are represented as QuickJS
   `JSValue`.** The rule, stated once and governing everywhere this ADR says
   "dynamic": *a binding or object is engine-represented **iff it is reachable
   by code that is not known at compile time*** — `eval`, `with`,
   `new Function`. Everything else stays native, **including values the type
   system cannot pin down**. A program with no `eval` links no engine however
   dynamically typed it is; that is what makes the pay-for-what-you-use
   requirement below achievable rather than aspirational. #4543 owns computing
   the frontier. Typed code is untouched: unboxed `i32`/`f64` and planned
   record layouts stay exactly as they are, and keep the measured AOT win.
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
6. **We own the memory and the allocator; the engine does not.** Our module
   defines and exports the linear memory and the engine imports it, and the
   engine allocates through a real `malloc`/`calloc`/`free`/`realloc`/
   `usable_size` we implement, installed via `JS_NewRuntime2`. The typed arena
   stays a bump fast path carved from our own heap, so ADR-0017's zero-metadata
   path is kept rather than traded. Both directions are currently reversed in
   the tree — `scripts/quickjs-artifact/build.sh` passes `-Wl,--export-memory`,
   and #4540 shipped the arena carved *from the engine's* `malloc` — so this
   decision is a target, with that fallback working in the meantime. #4540
   carries the cost analysis.

   **Status 2026-08-19 — the allocator half is BUILT (#4557); the memory half
   is not.** The linear lane now has a real
   `malloc`/`calloc`/`free`/`realloc`/`usable_size`, and QuickJS allocates
   through it via `JS_NewRuntime2`, proven by call counters read out of our own
   module. It is **opt-in** (`linearHeapAllocator: "malloc-v1"`); #4540's
   carve-from-the-engine arena remains the default, because the measured
   end-to-end cost is 1.025× and the reclamation benefit does not yet justify
   flipping a new allocator under foreign code by default.

   Two things recorded above turn out to be wrong, and both are worth carrying
   forward rather than quietly fixing:

   - **The members are installed as table callbacks, not wasm imports.** Five
     unconditional imports would make the artifact un-instantiable without a
     peer that supplies an allocator — which `extract-abi.mjs` (it instantiates
     the artifact alone to read these very constants out of it) and the
     runtime-eval tier both do. The #4245 membrane already solved this shape.
     A consequence: memory ownership is *not* required for the allocator,
     though it WOULD have been under imports, because engine-imports-allocator
     plus we-import-memory is an instantiation cycle.
   - **"Dropping dlmalloc may shrink the artifact" did not happen.** dlmalloc is
     still linked and still provides the regions our allocator sub-allocates
     from, so the artifact grew by 6,735 bytes. Exactly one component still
     grows the memory, and it is still the engine.

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

## Alternatives rejected (recorded because they resurface)

**Implement our own refcounting or GC over the engine's objects**, sharing only
its layout and allocator. Rejected on two independent grounds. First, the
engine's own compiled code adjusts refcounts as it runs — every property read,
builtin and bytecode op — so our scheme and its scheme would write the same
header field and disagree about when it reaches zero; the failure is a
premature free *inside* the engine, unfixable from our side. Second, a
collector must traverse, which means knowing per object class (Array, Map,
closure, Promise, TypedArray, Proxy) where the child references live — exactly
the internals this ADR declines to couple to, and they would rot silently at
the next version bump. It would also not achieve its usual motivation: we link
the engine for the object model, builtins and `eval`, so replacing its
collector removes nothing from the link.

What *is* available without any of that: the allocator, via the documented
`JS_NewRuntime2` / `JSMallocFunctions` hook, and collection **policy**, via
`JS_SetGCThreshold` / `JS_RunGC`. Mechanism stays the engine's; allocation and
policy are ours. That split is consistent with ADR-0017's refusal to build a
pluggable GC.

**Adapt the engine to use WasmGC.** Not possible by adaptation: there is no
C→WasmGC compiler, and the memory models are incompatible — WasmGC structs are
not addressable, references are opaque and carry no integer value, so NaN
boxing (the engine's core value representation) is undefined rather than merely
hard. "The engine on WasmGC" would be a rewrite of its object model, i.e. a new
engine — and the WasmGC lane already has the native equivalent in its own
dynamic family plus the self-hosted interpreter. The adjacent option, bridging
a linear-memory engine to WasmGC objects, is recorded as **rejected** in
`docs/architecture/runtime-eval-interpreter.md` (strategy 2c: handle table,
identity broken).

## Consequences

- The linear lane gains a finished runtime — builtins, RegExp, `eval`, and a
  collector — where it previously had nothing, and caps the cold dynamic tier
  at best-in-class-interpreter speed instead of the 400× interpreter cost.
- **It costs a fixed artifact size**: measured 1,011,134 bytes raw / 350,017
  gzipped at `-O2`; `-Oz` gives 626,104 / 261,243 but costs ~23% on both eval
  and per-property time. The tier must therefore be **pay-for-what-you-use**,
  elided entirely when a program's dynamic residue is empty (#4544).
- **Two allocators over one linear memory is a real corruption hazard**, not a
  theoretical one: the artifact's heap begins above its 64 KiB shadow stack
  `[0, 65536)` and ~105 KiB of static data, while our linear `__heap_ptr`
  initialises to a hard-coded 1024 — inside that shadow stack. Heap coexistence
  is a correctness prerequisite (#4540); **resolved** for placement by
  [ADR-0022](./0022-linked-mode-heap-and-rodata-placement.md).
  - **Correction, 2026-08-19:** this bullet previously stated the first `malloc`
    returns **171,696**. A local build from the same pinned refs returns
    **172,176** — +480, because static data shifted. The ordering claim is what
    matters and is confirmed; the constant is a property of one build in one
    container. **Nothing may hardcode it**, which is why ADR-0022 delegates
    placement to the artifact's own allocator instead of naming an address.
- **Refcount discipline becomes a codegen obligation** on every path, including
  exceptional ones; getting it wrong leaks or double-frees (#4542).
- **Cycles that close through native memory are invisible to the engine's
  collector.** This is a documented leak class with a weak-wrapper mitigation,
  accepted for this lane (#4541).

## Corrections

**2026-08-19 — the dynamic-tier trigger.** As first written, the Context said "a
value the middle-end cannot give a single type has nowhere to live" and Decision
1 said "the dynamic residue is represented as `JSValue`" without defining the
term. Read together those say *statically untyped ⇒ engine*, which is wrong and
expensive: it would link the ~1 MB engine into any program holding a
heterogeneous value. The governing rule was always the one #4543 states —
reachability from code not known at compile time — and Decision 1 now says so.
Nothing had been built against the old wording; #4541 and #4540 were updated in
the same change.

**Open consequence, recorded rather than resolved:** this ADR supersedes #1852's
native value+tag scheme (16-byte `[tag][val]` cell) for this target. Under the
eval-reachable rule, untainted-but-dynamic values still need a native
representation, and that scheme was retired. Either it returns for the untainted
case, or the claim is that without `eval` little genuinely dynamic remains to
represent. #4541 must settle this explicitly rather than inherit it.
