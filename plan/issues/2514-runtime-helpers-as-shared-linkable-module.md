---
id: 2514
title: "Link-gated shared core-Wasm runtime providers with a versioned runtime ABI"
status: backlog
sprint: Backlog
created: 2026-06-19
updated: 2026-08-12
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: runtime, linking, codegen, codegen-linear
language_feature: runtime-helpers
es_edition: n/a
goal: architecture
related: [1046, 2512, 2524, 2525, 2783, 3526, 3678, 4382]
---

# #2514 — Link-gated shared core-Wasm runtime providers

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

Proposal: compile stable provider families into shared core-Wasm modules and
have user modules import only the families required by their frozen runtime
feature manifest, instead of re-emitting those providers per module. Preserve
the existing inline path until size, startup, and engine-compatibility evidence
shows that a linked provider is a net improvement for the selected target.

## Link-gated provider plan

#3526 becomes the sole semantic authority for provider selection. Its frozen
`RuntimeFeature` closure is mapped to versioned provider units before body
lowering. The linker then chooses one of three explicit outcomes per unit:

1. backend-native lowering, requiring no provider import;
2. inline/self-host provider, preserving the current single-module artifact;
3. shared core-Wasm provider import with an exact ABI version.

Do not replace conditional inline emission with one monolithic always-linked
runtime. Provider units must be feature-granular enough that unused regex,
collections, async, dynamic-value, or host-adapter families add neither imports
nor required side modules. The final compile/capability manifest records the
selected units, versions, and transitive host capabilities for #4382.

The module import set and provider versions freeze before lowering. A missing
provider, ABI mismatch, unexpected late import, or unsupported target adapter
is a typed pre-emission failure, not a retry through inline or legacy code.

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
- Phase 3: integrate #3526 feature-closure selection, provider-unit packaging,
  ABI/version checks, and #4382 manifest projection. Promote each family only
  after differential correctness and artifact/startup-size evidence is green.

## Acceptance criteria

- [ ] A versioned provider registry maps frozen #3526 `RuntimeFeature`s to
      backend-native, inline, or shared core-Wasm implementations without
      inspecting source AST or emitted import spellings.
- [ ] Provider selection and the complete import set freeze before body
      lowering; late demand, missing adapters, and ABI mismatches fail with
      typed #3678 diagnostics before artifacts are published.
- [ ] A minimal program imports no shared provider, and focused programs import
      only their exact feature-granular provider units and dependencies.
- [ ] Non-GC/linear providers land first with JS-host and standalone/WASI
      differential parity, import-leak checks, and multi-module integration
      tests in every supported runtime.
- [ ] WasmGC provider exchange proves canonical rec-group identity across
      separately compiled modules on every supported engine and fails closed on
      ABI or Binaryen rec-group drift.
- [ ] Release artifacts distribute provider modules and ABI metadata
      atomically; incompatible combinations fail deterministically.
- [ ] Per-family measurements compare inline and linked code size, startup,
      steady-state performance, and cache reuse. Linking remains opt-in for a
      family until the target-specific tradeoff is documented.
- [ ] #4382 reports selected provider units/versions and never hides a linked
      runtime or host capability behind a generic successful-build status.

## Out of scope

- Rewriting runtime providers in C or adopting a second semantic runtime.
- Using the Component Model where its ABI would copy WasmGC values.
- Shipping one always-linked runtime blob that defeats feature gating.
- Adding a general JavaScript engine fallback or changing the supported
  language contract to simplify the provider boundary.

## Notes

Split from #2512 (Node host APIs as separate modules). Different concern: #2512
is byte/scalar-typed across the boundary and tractable now; this one needs the
canonical-rec-group ABI + Binaryen cooperation. Surfaced while investigating
loopdive/js2#389.
