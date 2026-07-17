---
id: 1585
title: "Dual-target IR architecture: defensive design for an eventual linear-memory backend"
status: backlog
created: 2026-05-23
updated: 2026-05-23
priority: low
feasibility: hard
model: fable
reasoning_effort: high
task_type: investigation
area: compiler
language_feature: compiler-internals
goal: platform
sprint: Backlog
depends_on: [1586, 1587]
es_edition: n/a
---
# #1585 — Dual-target IR architecture: defensive design for an eventual linear-memory backend

Tracking issue for the architectural option of supporting a second compilation
target (linear memory, no Wasm GC) at some point in the future. This issue
**does not commit to building a second backend**. It documents the option,
records the design constraints that would make such a backend feasible
without prohibitive surgery, and lists the triggers that would justify
revisiting the decision.

The project's primary target is and remains Wasm GC. This issue exists so
that decisions made in the current compiler architecture do not foreclose
the dual-target option prematurely.

## Context

The motivation for considering a linear-memory target is **distribution
reach** rather than performance:

- `wasm2c` produces standalone native binaries from Wasm modules with no
  runtime dependency, but does not support Wasm GC.
- Wasmer's `create-exe` produces lean standalone binaries (~2–5 MB) but
  Wasm GC support there is significantly behind Wasmtime.
- Wasmtime static-linking produces standalone binaries (~15–30 MB) that
  bundle the full Wasmtime runtime including Cranelift. This is the
  pragmatic distribution path today and is documented in #XXXX (Wasmtime
  static-link distribution — to be filed if not already present).
- Several adjacent hosts in the ecosystem run linear-memory Wasm only:
  WAMR minimal mode, older browser versions, several WASI Preview 1
  runtimes, embedded scenarios, and Wasm-in-database hosts (DuckDB Wasm
  and similar).

None of these targets are part of the current product surface. They are
plausible future targets that would require linear-memory output. This
issue captures the architectural cost of preserving that option versus
foreclosing it.

## The information problem

The naive idea — "emit Wasm GC, then lower to linear memory in a later pass" —
does not work in production. The Wasm-GC output has, by the time it is
emitted, **already lost the information** that a linear-memory backend
needs to make sound decisions. Four categories of information are at stake:

### 1. Allocation lifetime and garbage collection

Wasm GC delegates garbage collection to the runtime. The IR emits
`struct.new` and `array.new` operations with no explicit notion of when
the allocated value becomes unreachable. In linear memory, no runtime GC
exists; the compiler must either:

- propagate refcounting through every aliasing operation (insert
  `dup` / `drop` calls — the information needed to place them correctly is
  not produced by the current IR because it is unnecessary for Wasm GC),
- implement a tracing GC in Wasm-runtime code (a substantial subsystem,
  on the order of several thousand lines, with the standard tracing-GC
  hazards: root tracking, write barriers, finalization ordering), or
- use region-based or arena allocation (largely incompatible with JS
  reference semantics).

This is the largest single missing capability and is not recoverable from
the Wasm-GC output.

### 2. Object layout choices

In Wasm GC, struct layout is the runtime's responsibility. The IR
specifies *which* struct, the runtime decides *how* it is laid out in
memory. In linear memory, layout is the compiler's responsibility, and
the choice has significant downstream consequences:

- where the type tag lives (high pointer bits, NaN-boxed Float64, object
  header field)
- inline-cache shape pointer placement
- hidden-class transition mechanics
- sparse-array versus dense-array representation
- Symbol-keyed property storage

These decisions cannot be deferred. Different layout choices yield
different access patterns in every consumer of the type, so the layout
strategy must be present in the IR before lowering, not derived from a
Wasm-GC representation that has already discarded the choice.

### 3. Type hierarchy and subtype tests

Wasm GC provides `ref.test` and `ref.cast` against nominal subtypes,
typically used for JS-value-hierarchy operations (`JSAny` → `JSObject` →
`JSFunction` and so on). In linear memory, these become explicit tag-bit
inspections and branches. The translation is mechanical *if* the type
hierarchy is preserved in the IR; if the IR has already lowered to opaque
`ref` operations, the original hierarchy must be reconstructed by
analysis.

### 4. Reference identity semantics

`ref.eq` in Wasm GC compares object identity cleanly. In linear memory,
the same operation becomes pointer comparison, which is correct in the
common case but breaks under several common optimizations: object
pooling, NaN-boxing of floats colliding with pointers, interned strings
treated as values rather than references. Whether a comparison is
identity-significant or value-significant is information that exists at
the IR level but is not preserved into Wasm-GC output, where both look
identical.

## Approaches considered

### Approach A: Lower Wasm-GC output to linear memory

A nominally attractive option, with prior art in the Binaryen
`--lower-gc` experiment. In practice this is a decompiler-plus-recompiler
operation: the lowering pass must reconstruct lifetime, layout, type
hierarchy, and identity semantics from a representation that has already
discarded them. Binaryen's experiment worked on toy examples and did not
scale to realistic codebases. This approach is **not pursued** by this
issue; it is research-grade work, not engineering.

### Approach B: Second backend reading the current IR directly

A linear-memory backend that consumes the existing IR rather than
Wasm-GC output. This works if the current IR retains enough information
above the Wasm-GC operations, which is partly true and partly not. The
backend would need to:

- add lifetime annotations through a separate analysis pass
- pick a layout strategy and implement it
- build a GC subsystem in Wasm
- implement all built-ins against the linear-memory representation

Estimated effort: 3–5 months of focused engineering, plus ongoing
maintenance overhead of two parallel lowering paths. This approach is
**deferred**, not rejected. It would be the right move if a concrete
distribution requirement justified the cost.

### Approach C: Mid-level IR with explicit memory-model abstraction

The architecturally clean option, and the one this issue tracks. A
mid-level IR layer sits between the current high-level IR and the
backend, explicitly representing the information that Wasm GC currently
hides: allocation sites with lifetime annotations, layout decisions per
type, identity-significant versus value-significant operations.

Both backends — Wasm GC and (eventual) linear memory — read this
mid-level IR. The Wasm-GC backend uses the information partially
(delegating GC to the runtime); a linear-memory backend would use it
fully.

This is an MLIR-style multi-level IR pattern. It does not require building
the second backend immediately. It requires designing the current IR and
lowering pipeline such that adding the mid-level layer later is not
prohibitively invasive.

## What "defensive design" means in practice

Concrete IR and pipeline properties that preserve the dual-target option
without committing to a second backend today:

1. **GC-specific operations introduced late, not early.** Keep the
   high-level IR free of `struct.get` / `array.new` / `ref.cast` until
   the final lowering pass to Wasm GC. The earlier in the pipeline these
   appear, the more passes need to be rewritten to add a mid-level layer
   later.

2. **Type hierarchy maintained as a first-class concept in the IR.** The
   relationship `JSFunction <: JSObject <: JSAny` should be expressible
   without depending on Wasm-GC nominal subtypes. A linear-memory backend
   needs the same hierarchy for tag-bit dispatch.

3. **Allocation sites identified explicitly.** Every point where a new
   value comes into existence should be a marked IR node, not a side
   effect of another operation. This is the prerequisite for any future
   lifetime analysis.

4. **Identity-significant operations tagged.** Distinguish `ref.eq` for
   identity from value equality at the IR level, not at the Wasm-GC
   level. The information is cheap to record and expensive to recover.

5. **Layout decisions captured per-type, not per-emission.** When the IR
   says "this is a JSObject", the layout used to represent it should be
   queryable from the IR's type system, not embedded only in the
   Wasm-GC emitter.

6. **Built-ins authored against an abstract value API, not against
   Wasm-GC operations directly.** Built-ins that read fields via
   `getField(obj, "length")` rather than `struct.get $JSArray $length` 
   are portable between targets without rewriting. This aligns with
   #1251's shared-built-in architecture.

These properties are individually low-cost if applied as the IR evolves.
They are expensive to retrofit, which is the reason this issue exists
now rather than later.

## Triggers for activation

This issue should be revisited and potentially converted into a feature
issue when any of the following conditions are met:

- **Concrete external requirement for native distribution.** A specific
  use case or integration that requires standalone executables without the
  Wasmtime footprint.
- **Wasmer GC support reaches production maturity.** If Wasmer's GC
  implementation closes the gap with Wasmtime, the `wasmer create-exe`
  path becomes viable and reduces the need for a linear-memory backend.
  Track in a separate issue (#XXXX — Wasmer GC maturity tracking).
- **`wasm2c` gains Wasm-GC support.** Unlikely in the near term, but
  would change the calculus completely.
- **A research collaboration emerges.** If an external group proposes
  joint work on a linear-memory backend, the cost calculation
  changes.
- **Internal need for dual-target validation.** If differential testing
  reveals semantic ambiguities that would be resolved by a second
  independent execution path.

None of these triggers are met today. The expected timeframe for
re-evaluation is 12–18 months.

## Non-goals

- Building a second backend now.
- Lowering Wasm-GC output to linear memory.
- Designing the mid-level IR in detail. The detailed design happens only
  when a trigger fires; this issue records the architectural option, not
  its implementation.
- Optimizing the current Wasm-GC backend for parity with a hypothetical
  linear-memory output. Wasm GC remains the primary target.
- Targeting WAMR minimal, embedded Wasm runtimes, or legacy browsers as
  near-term distribution paths. Those become tracked features only if a
  concrete requirement materializes.

## Relationship to other issues

- **#1251** (Wasm-GC-native bytecode interpreter with Acorn) — orthogonal
  concern. The interpreter handles dynamic-execution fallback; this
  issue handles target-architecture flexibility. Both share the goal of
  keeping the shared built-in library abstract enough to serve multiple
  consumers.
- **#1058** (js2wasm self-host) — adjacent. Self-hosting exercises the
  same IR layers this issue cares about; gaps surfaced by self-host work
  inform the defensive-design checklist above.
- **#1066** (eval via host-compiled Wasm child module) — adjacent. The
  recursive-compilation path would also benefit from the IR being
  emission-target-agnostic, since the child module is compiled into the
  same target as the parent.
- **Distribution-tracking issues** (Wasmtime static-link, Wasmer GC
  maturity, `wasm2c` GC support) — separate issues to be filed; this
  issue references them as triggers.

## Risks

- **Over-engineering hazard.** Designing the IR for dual-target
  flexibility when no second target is committed risks adding
  abstraction overhead with no payoff. Mitigation: the defensive-design
  checklist above is intentionally minimal — properties that are
  individually cheap and individually justifiable by Wasm-GC reasons
  too (e.g. late introduction of Wasm-GC ops makes the IR easier to
  reason about regardless of dual-targeting).
- **Bit-rot of the option.** If the defensive properties are not
  maintained, the option silently closes. Mitigation: include
  defensive-design checks in compiler-architecture review for any IR
  changes; reference this issue in the relevant ADR.
- **Communication hazard.** "We could support linear memory if we
  wanted" can be mis-communicated as "we plan to support linear memory".
  Mitigation: this issue is marked `status: backlog` and `priority: low`
  intentionally. Public communication should reflect that the option is
  preserved, not pursued.

## Notes

- The dual-target option is sometimes worth mentioning to explain the
  compiler's strategic flexibility ("the architecture is not locked into
  Wasm GC if the ecosystem demands otherwise"), but it should be
  communicated as architectural defensibility rather than as a roadmap
  item. Roadmap items have delivery dates; this does not.
- Reference: the MLIR project (LLVM ecosystem) is the canonical example
  of multi-level IRs done at scale. Their lessons on dialect design and
  progressive lowering are directly applicable if this issue is ever
  activated. Not a dependency, but a useful prior.
- Reference: the Binaryen `--lower-gc` experiment is the canonical
  example of why Approach A does not work in practice. Worth re-reading
  before any activation of this issue, both as warning and as catalog of
  partial solutions.
- The shared-built-in property (point 6 of defensive design) is already
  partially enforced by #1251's design. Any progress there contributes
  to the dual-target option being kept open, without that being its
  primary purpose.
