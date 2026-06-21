---
id: 2514
title: "Runtime helpers (number_toString, string/array/GC helpers) as a shared linkable module via a canonical runtime-type rec-group ABI"
status: backlog
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: codegen
language_feature: runtime-helpers
goal: architecture
related: [2512, 1046]
---

> **Linking mechanism (decided):** **core-wasm module linking in a shared store**
> + a frozen canonical rec group — see **#2524** (chosen). The Component Model is
> the wrong vehicle here: its Canonical ABI *copies* GC values across the
> boundary, defeating zero-copy sharing (#2525, deferred). Cross-module GC type
> identity is **already provided by runtime canonicalization** — not blocked.

## Problem / proposal

js2wasm emits its runtime helpers — `number_toString`, `__str_concat`, native
string/array/vec helpers, boxing helpers, GC struct accessors, etc. — **inline
into every compiled module** (each only when used, via DCE). Across multiple
compiled modules this duplicates the same helper code.

Proposal: compile the runtime helpers once into a shared `runtime.wasm` and have
user modules **import** them, instead of re-emitting per module.

## This is NOT blocked on a missing standard — it's an ABI engineering project

Earlier framing (this issue's first draft) called WasmGC "nominal" and treated
cross-module GC sharing as blocked on a future standard. That was wrong. WasmGC
is **structural with canonicalization**: the engine canonicalizes rec groups, so
two **separately-compiled** modules that declare **structurally identical** types
get the **same** runtime type identity. A `ref.cast` to module A's `String`
succeeds on an object module B created — *if* the types canonicalize the same.
So GC objects genuinely can interchange across modules today; no new proposal is
required.

### The actual approach: a canonical, versioned runtime-type rec-group ABI

- Define a **fixed, versioned "js2wasm runtime type rec group"** — the closed set
  of GC types that cross the boundary (`String`, `Vec`, boxed values, and their
  transitive dependencies), in a frozen, canonical layout.
- **Every** artifact emits that exact rec group: `runtime.wasm` (which also
  exports the helper functions) AND every user module. Structural
  canonicalization then unifies them, so `runtime.wasm`'s `String` IS the user
  module's `String` — helpers take/return them with **no copy**.
- A module links only against a `runtime.wasm` of a **matching ABI version**;
  any change to a shared type bumps the version.

### The real costs / risks (the crux of the work)

1. **Rec-group granularity.** Our `String`/`Vec`/boxed types are
   mutually-referential, so canonicalization matches the **entire rec group**,
   not one type. You share the closed type graph the shared types belong to, not
   an isolated `String`. Defining a tight, stable boundary group is the design
   problem.
2. **Binaryen must preserve the group verbatim.** `wasm-opt` merges, reorders,
   and optimizes types, which perturbs rec-group structure and breaks canonical
   equality. Need to pin/disable type-merging for the shared group, or
   post-process to guarantee byte-stable identity. **This is the main risk.**
3. **ABI versioning + distribution** of `runtime.wasm` and the matching type
   group.

### What ships sooner

- **Non-GC helpers** (value-typed / linear-memory: pointer + length, scalars)
  have no type-identity concern and can be factored into the shared module first.
- The **linear-memory string backend** (`--nativeStrings` / linear target)
  sidesteps the GC-string identity problem entirely (memory-typed strings carry
  no GC identity), so a shared runtime could land there before the WasmGC path.

## Standards context (checked 2026-06-19)

- **Engine-level canonicalization already solves cross-module GC type identity —
  and it is shipped.** Per the WasmGC design and V8's implementation, the engine
  canonicalizes *all* types from *all* modules in an isolate into a single global
  type index; a struct type from module M1 is **equivalent** to a structurally
  identical struct from M2 (isorecursive type canonicalization). So structurally
  identical rec groups across separately-compiled modules unify to the same
  runtime type today — which is exactly what makes the canonical-rec-group ABI
  above viable without any new standard.
  Refs: WasmGC overview <https://github.com/WebAssembly/gc/blob/main/proposals/gc/Overview.md>,
  isorecursive canonicalization discussion <https://github.com/WebAssembly/gc/issues/292>.
  **Engine-maturity asterisk:** this canonicalizer is security-sensitive and has
  had real bugs (a Chrome RCE was filed against the cross-module
  type-canonicalization machinery) — validate behavior on target engines.
- **The Component Model is NOT the vehicle.** Its in-flight shared-module design,
  Shared-Everything Dynamic Linking
  <https://github.com/WebAssembly/component-model/blob/main/design/mvp/examples/SharedEverythingDynamicLinking.md>,
  is the `.dll`/`.so`-style mechanism — but it is **purely linear-memory based and
  does not address WasmGC types**. It shares *code*, not *GC objects*; each
  instance gets its own memory. GC-object sharing would need separate extensions.
- **Explicit alternative (not required):** the Type Imports & Exports proposal
  <https://github.com/WebAssembly/proposal-type-imports> would let a module import
  a type by reference (abstract/nominal sharing) and is slated to become part of
  the future basis for GC. It is a separate, not-yet-shipped proposal; the
  canonical-rec-group convention above does **not** depend on it.

## Scope / phasing

- Phase 0 (architect): design the canonical runtime-type rec-group ABI; confirm
  Binaryen can be made to emit it stably (risk #2).
- Phase 1: factor out **non-GC** helpers behind a stable interface (no
  identity concern) — and/or the `--nativeStrings` linear path.
- Phase 2: GC-typed helpers via the canonical rec-group ABI once #2 is solved.

## Notes

Split from #2512 (Node host APIs as separate modules). Different concern: #2512
is byte/scalar-typed across the boundary and tractable now; this one needs the
canonical-rec-group ABI + Binaryen cooperation. Surfaced while investigating
loopdive/js2#389.
