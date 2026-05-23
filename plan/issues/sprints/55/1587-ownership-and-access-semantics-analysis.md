---
id: 1587
title: "Static analysis pass: ownership and access semantics on IR values"
status: ready
sprint: 55
created: 2026-05-23
updated: 2026-05-23
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler
language_feature: compiler-internals
goal: platform
depends_on: [1586]
es_edition: n/a
---
# #1587 — Static analysis pass: ownership and access semantics on IR values

Flow-sensitive static analysis pass that annotates every IR value with
inferred **ownership state** (owned / borrowed / shared) and **access
pattern** (read-only / write-only / read-write / escaped). The output is
consumable metadata that downstream passes use to make better optimization,
specialization, and lowering decisions.

This is not a borrow checker in the Rust sense — JavaScript semantics do
not permit a strict-mode rejection of programs that fail ownership rules.
It is an **inference pass**: it discovers ownership and access properties
where they hold, conservatively falls back to the most permissive
classification where it cannot prove anything, and exposes the result.

Depends on #1586 (explicit allocation sites) for analysis anchor points.

## Goal

Given an IR function, produce two pieces of metadata per value reference:

1. **Ownership state.** One of:
   - `owned` — the value has exactly one reference, which is this one,
     for the duration of this reference's liveness
   - `borrowed` — the value is referenced elsewhere; this reference cannot
     deallocate or invalidate it
   - `shared` — multiple references exist; mutation must be observable to
     all of them
   - `escaped` — the value's lifetime extends beyond this function via
     return, capture, parameter passing to opaque code, or storage in a
     heap-reachable location

2. **Access pattern.** A set of:
   - `read` — this reference is used for property reads
   - `write` — this reference is used for property writes
   - `mutate` — this reference is used for read-modify-write operations
   - `identity` — this reference participates in `===` comparisons
   - `escape` — this reference is passed to opaque code (built-in,
     unknown function, host import)

Both annotations are *inferred*, not declared. A value that an analysis
cannot reason about gets the most conservative classification: `shared`
ownership with full access set.

## Why this matters

The pass enables several concrete improvements across the compiler, each
of which currently either ad-hocs the analysis or pessimizes:

- **Escape analysis.** Allocations that the pass proves `owned` and
  never `escaped` can be stack-allocated (or scalar-replaced) instead of
  heap-allocated. Significant size and GC-pressure wins for small,
  short-lived objects.
- **Closure specialization.** A closure that only reads its captures can
  be lowered differently from one that mutates them — read-only captures
  can be inlined as constants when the call site is monomorphic.
- **Built-in dispatch.** Calls into shared built-ins that we know take
  read-only arguments can skip defensive copies that the built-in
  currently makes.
- **Tier-up decisions (Phase 2 of #1584).** Hot interpreted functions
  with `owned` allocations are good tier-up candidates because their
  state is locally analyzable.
- **Dual-target preparation (#1585).** Lifetime analysis for a future
  linear-memory backend depends on ownership inference being available.
- **Differential testing diagnostics.** When AOT and bytecode paths
  diverge, ownership annotations on the divergent values help bisect
  whether the bug is in escape-analysis assumptions or elsewhere.

The pass is a force multiplier: one analysis, many downstream consumers.

## Design

### Analysis structure

A flow-sensitive, intra-procedural, may-escape analysis. For each
function in the IR:

1. **Initialization.** Every `AllocSite` from #1586 starts as `owned` with
   access set `{}`. Every imported reference (parameter, closure capture,
   global access) starts as `shared` with access set `{ read }`.
2. **Flow.** Walk the IR in topological order over the control-flow
   graph. For each operation, update the ownership and access state of
   each operand reference according to the operation's effect:
   - `LoadField(ref, name)` → adds `read` to `ref`'s access set
   - `StoreField(ref, name, value)` → adds `write` to `ref`, escape may
     apply to `value` depending on the field
   - `Call(fn, args)` → if `fn` is opaque, all `args` are `escaped` with
     full access; if `fn` is known and analyzed, propagate from `fn`'s
     parameter annotations
   - `Return(value)` → `value` becomes `escaped`
   - `StoreCapture(slot, value)` → `value` becomes `escaped`
3. **Join.** At control-flow merge points, ownership states are joined
   conservatively: `owned ∨ borrowed = borrowed`, `borrowed ∨ shared =
   shared`, `shared ∨ escaped = escaped`.
4. **Fixed point.** Iterate until annotations stabilize. For loops, this
   requires careful initial seeding; values in loops generally widen to
   `shared` quickly unless the loop is a simple counted form.

### Inter-procedural extension

The initial implementation is **intra-procedural**: each function is
analyzed in isolation, and unknown callees are treated as fully escaping.
This already provides useful information for the majority of allocations,
which are function-local.

A follow-up issue can add inter-procedural propagation: analyze known
callees first, summarize their parameter and return effects, use the
summaries when analyzing callers. This is a substantial extension and
explicitly out of scope here.

### Output API

Annotations are written to the `AllocSiteRegistry` from #1586 under the
`ownership` and `access` namespaces:

```ts
registry.annotate(allocId, 'ownership', { state: 'owned' });
registry.annotate(allocId, 'access', { ops: ['read', 'write'] });
```

For non-allocated values (parameters, captures), a parallel `ValueAnnot`
map keyed by IR value ID stores the same shape of annotation.

Downstream passes consume the annotations via a typed query API:

```ts
const ownership = analyses.ownership.of(value); // 'owned' | 'borrowed' | …
const access    = analyses.access.of(value);     // Set<'read'|'write'|…>
```

### Conservative defaults

When in doubt, the analysis returns the *most permissive* result that
preserves correctness:

- Ownership: `shared`
- Access: `{ read, write, mutate, identity, escape }`

Consumers must check whether the annotation is tight enough to enable
their optimization. If not, they fall back to the conservative path. No
optimization is allowed to assume tighter annotations than the analysis
returns.

## Scope

1. Define the lattice for ownership and access in code, with documented
   join and meet operations.
2. Implement the intra-procedural analysis pass as a worklist algorithm
   over the IR control-flow graph.
3. Wire the analysis into the pass pipeline, running after #1586's
   allocation-site infrastructure is in place but before any consumer
   pass.
4. Document the analysis output and the consumer query API in an ADR.
   The ADR must include the conservative-defaults guarantee.
5. Implement one canonical consumer as a demonstration and regression
   anchor: **stack-allocation for proven-`owned`-non-`escaped`
   allocations of small objects**. This produces measurable size and
   performance signal and ensures the pass output is correct enough to
   build on.
6. Add tests for the analysis itself (unit tests with known IR fragments
   and expected annotations) and for the demonstration consumer
   (equivalence + benchmark deltas).

## Phasing

**Phase 1 (this issue, ~4-6 weeks)**: intra-procedural analysis,
ownership and access lattices, registry integration, ADR, one
demonstration consumer.

**Phase 2 (follow-up issue)**: inter-procedural extension with function
summaries.

**Phase 3 (follow-up issue)**: precision improvements — better loop
handling, conditional ownership refinement, escape-via-exception
tracking, integration with #1588's encoding tracking.

## Non-goals

- Rust-style borrow checking. The analysis is inference, not rejection.
  Programs that would fail Rust's borrow checker compile fine; they
  simply get conservative annotations.
- Inter-procedural analysis. Phase 2.
- Annotations on values inside built-ins. Built-ins are opaque to this
  pass; they declare their parameter and return effects via manual
  annotations (a separate small issue if needed).
- Annotations as program semantics. The analysis is purely an
  optimization aid. Removing the pass must not change observable program
  behavior.

## Relationship to other issues

- **#1586** (explicit allocation sites) — hard dependency. The
  registry is where annotations live.
- **#1588** (string encoding tracking) — parallel analysis. Both run
  after #1586; both write to the registry; they do not interact in Phase
  1 but Phase 3 may benefit from joint analysis.
- **#1585** (dual-target IR architecture) — long-term consumer.
  Ownership annotations are the foundation for lifetime analysis on
  allocation sites, which is in turn a defensive-design point for a
  linear-memory backend.
- **#1584** (Wasm-GC-native bytecode interpreter) — orthogonal but
  potentially synergistic: ownership-known bytecode functions are
  better candidates for tier-up to AOT.

## Acceptance criteria

- [ ] ADR-XXX documents the ownership and access lattices, the join
      operations, and the conservative defaults.
- [ ] Analysis pass implemented under `src/ir/analysis/ownership.ts`
      (or equivalent), reading from and writing to the registry from
      #1586.
- [ ] Pass runs as part of the standard optimization pipeline and is
      gated behind a feature flag for the rollout period.
- [ ] Unit tests cover ownership and access propagation for at least
      these IR fragments: simple allocation, escape via return, escape
      via store-to-heap, escape via opaque call, mutation via field
      store, conditional escape via branching, loop-carried allocation.
- [ ] Demonstration consumer (stack-allocation for owned+non-escaped
      small objects) implemented and gated separately. Measured size
      reduction on a representative test262 subset.
- [ ] No new failures in `npm test`, `pnpm run test:262`, or
      `pnpm run test:diff`.

## Risks

- **Precision insufficient for downstream consumers.** If the analysis
  classifies too many values as `shared` or `escaped`, consumers find
  the output unusable. Mitigation: implement the demonstration consumer
  as part of this issue; if it does not produce measurable wins, the
  precision is too low and the pass needs more work before being marked
  done.
- **Performance overhead on compile time.** Flow-sensitive analyses can
  be slow on large functions. Mitigation: budget for the analysis
  separately; benchmark on the largest test262 file as a stress test;
  add an early-exit for functions trivially classifiable.
- **Soundness bugs.** A bug in the analysis that returns a tighter
  annotation than reality permits causes downstream miscompilation.
  Mitigation: differential testing must include all consumer
  optimizations; conservative defaults are the safety net; ADR
  documents the "no consumer assumes tighter than returned" rule.
- **Drift between AOT and interpreter paths.** If only AOT consumes the
  analysis, interpreted code becomes the more pessimistic path. That
  may be fine in Phase 1, but should be acknowledged. Mitigation:
  document explicitly in the ADR.

## Notes

- The analysis is broadly similar in style to Rust's MIR-level borrow
  analysis, V8's escape analysis in TurboFan, and SpiderMonkey's alias
  set analysis. Worth citing in the ADR; not worth porting from.
- The "one demonstration consumer" requirement is deliberate. Static
  analyses that no pass consumes are dead code with maintenance cost. By
  requiring a real consumer, this issue forces the analysis to be
  immediately useful, not speculative.
- Naming-wise: "ownership" is the closest English word to what the
  analysis tracks, but it carries Rust-language baggage. The ADR should
  explicitly disclaim the Rust framing: ownership here is *inferred*
  classification, not *declared* type.
- Phase 1 deliberately avoids inter-procedural analysis because the
  intra-procedural results are already useful for most short-lived
  allocations, and inter-procedural adds significant implementation
  surface (summary computation, summary serialization, summary
  invalidation on recompilation).
