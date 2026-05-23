---
id: 1586
title: "IR preparation: explicit allocation sites with stable identity and metadata hooks"
status: ready
sprint: 55
created: 2026-05-23
updated: 2026-05-23
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: compiler
language_feature: compiler-internals
goal: platform
depends_on: []
es_edition: n/a
---
# #1586 — IR preparation: explicit allocation sites with stable identity and metadata hooks

Foundational IR refactor that makes every value-creation site in the
intermediate representation a first-class, identifiable, annotatable node.
This is the prerequisite for any future static analysis that needs to reason
about allocations — escape analysis, lifetime analysis, ownership tracking
(#1587), and the dual-target IR architecture (#1585).

The issue is intentionally narrow: it does not perform any new analysis. It
prepares the IR so that subsequent analyses *can* be added without
re-plumbing every pass.

## Goal

After this issue:

1. Every operation that brings a new value into existence is an explicit
   `AllocSite` node (or carries an `AllocSite` annotation), addressable by
   subsequent passes.
2. Each `AllocSite` has a stable identifier that survives IR transformations
   — inlining, constant folding, dead-code elimination must either preserve
   the ID, transfer it to a fused node, or explicitly mark it as deleted.
3. A documented metadata API allows passes to attach typed annotations to
   `AllocSite` nodes (e.g. `escapes: true`, `lifetime: function-local`,
   `encoding: utf8-guaranteed`) without modifying the IR core.
4. No behavioral changes. The existing test suite (unit, equivalence,
   test262, differential) passes unchanged before and after.

## Why this is a prerequisite

Several pending compiler enhancements depend on the IR being able to answer
"where was this value allocated, and what do we know about it?" reliably
across passes:

- **Ownership and access semantics analysis (#1587)** — needs allocation
  sites as analysis anchor points.
- **Dual-target IR architecture (#1585)** — the long-term ability to target
  linear memory requires lifetime annotations on allocation sites.
- **String encoding tracking (#1588)** — tags strings at their origin
  (allocation site) and propagates through.
- **Escape analysis for closure-capture optimization** — currently implicit;
  becomes explicit and reusable.

Each of these can be implemented independently *if* the IR provides stable,
annotatable allocation sites. Without it, each analysis has to recover the
information itself, and the results do not compose.

## Current state (to be confirmed during implementation plan)

The current IR mixes explicit and implicit allocation:

- **Explicit**: object literals, array literals, function declarations,
  class instantiations, explicit `new`-expressions. These already have
  dedicated IR nodes.
- **Implicit**: string concatenation result objects, intermediate values
  from spread/rest, arguments objects, template-literal cooked/raw arrays,
  return values from built-ins that allocate.
- **Black-box**: allocations performed inside built-in implementations are
  not visible to the IR and remain so under this issue.

The "implicit" category is where the cleanup happens. The audit step of the
implementation plan must enumerate every such case.

## Design

### `AllocSite` node shape

```ts
interface AllocSite {
  id: AllocSiteId;          // stable across passes
  kind: AllocKind;           // 'object' | 'array' | 'string' | 'closure' | …
  type: IRType;              // what is being allocated
  origin: SourceLocation;    // for diagnostics and source maps
  metadata: AllocMetadata;   // open map for analysis annotations
}
```

`AllocSiteId` is a numeric ID assigned at IR construction. Passes that
fuse or replace nodes must update the IR's allocation-site registry to
reflect provenance:

```ts
interface AllocSiteRegistry {
  resolve(id: AllocSiteId): AllocSite | null;
  alias(from: AllocSiteId, to: AllocSiteId): void;  // for fusion
  retire(id: AllocSiteId): void;                     // for deletion
}
```

### Metadata API

Annotations are typed by namespace + key, written and read through the
registry:

```ts
registry.annotate(id, 'ownership', { kind: 'owned' });
registry.read(id, 'ownership'); // → { kind: 'owned' } | undefined
```

Namespace prevents collision between analyses; each analysis owns its own
namespace and may not write to others.

### Pass discipline

Three rules every pass must follow after this issue lands:

1. **Preserve IDs through value-preserving transformations.** If a pass
   rewrites `x = new Foo()` to `x = inlined-foo-body`, the resulting value
   must carry the original `AllocSite` ID.
2. **Alias IDs through fusion.** If two allocations are fused (e.g. by
   common subexpression elimination), the registry records the alias.
3. **Retire IDs on deletion.** If a pass proves an allocation dead and
   removes it, the registry is informed so downstream passes do not see
   stale references.

Verification: a debug-mode invariant checker walks the IR after each pass
and asserts that every value with an allocation provenance resolves
through the registry to a live or retired entry.

## Scope

1. Audit the existing IR for implicit allocations. Produce a list in the
   implementation plan; convert each to an explicit `AllocSite` node or
   annotation.
2. Implement the `AllocSiteRegistry` with the API above.
3. Update every existing IR pass to follow the three pass-discipline rules.
   This is the bulk of the work — each pass must be reviewed and patched
   if it currently loses provenance.
4. Add the debug-mode invariant checker. Make it a CI gate at least in
   `pnpm typecheck` or a dedicated check.
5. Document the API and discipline in a new ADR. The ADR should
   cross-reference #1587, #1588, and #1585 as known consumers.
6. No new analyses in this issue. The hooks are added; the analyses come
   in follow-up issues.

## Non-goals

- Performing any new analysis (ownership, lifetime, escape, encoding) —
  those are #1587, #1588, and future issues.
- Changing the IR's external semantics. All test suites must pass
  unchanged.
- Reaching into built-in implementations to expose their internal
  allocations. Built-ins remain black boxes at the IR level; if a future
  analysis needs visibility inside a built-in, that built-in is rewritten
  to expose its allocations or a separate mechanism is added.
- Tracking allocation sites in the bytecode interpreter (#1584). The
  interpreter is a separate concern; the registry is for the AOT IR.
  Future work can extend it.

## Relationship to other issues

- **#1587** (ownership and access semantics analysis) — hard dependency on
  this issue. The analysis pass reads from and writes to `AllocSite`
  metadata.
- **#1588** (string encoding tracking) — hard dependency on this issue.
  Encoding annotations live on string `AllocSite` nodes.
- **#1585** (dual-target IR architecture) — long-term consumer. The
  defensive-design checklist in #1585 point 3 ("Allocation sites
  identified explicitly") is satisfied by this issue.
- **#1584** (Wasm-GC-native bytecode interpreter) — orthogonal. Does not
  block this issue, does not depend on it.

## Acceptance criteria

- [ ] Implementation plan enumerates every implicit allocation in the
      current IR with an audit table (source location, kind, planned
      conversion to explicit `AllocSite`).
- [ ] `AllocSiteRegistry` implemented under `src/ir/alloc-registry.ts`
      (or equivalent).
- [ ] All existing IR passes patched to preserve, alias, or retire IDs
      per the three pass-discipline rules.
- [ ] Debug-mode invariant checker added and runs in CI.
- [ ] ADR-XXX (`docs/adr/`) documents the API, discipline, and known
      consumers.
- [ ] All existing test suites (`npm test`, `pnpm run test:262`,
      `pnpm run test:diff`) pass with no new failures and no behavioral
      changes vs. baseline.
- [ ] No new failing test262 cases. No new differential-testing
      mismatches.

## Risks

- **Audit incompleteness.** An implicit allocation missed in the audit
  remains invisible to downstream analyses. Mitigation: invariant checker
  is conservative — if a value appears without provenance, it is flagged.
  Forces audit gaps to surface during CI rather than later.
- **Performance regression from registry overhead.** The registry is
  consulted on every IR transformation. Mitigation: implement as a flat
  array indexed by ID, not a hash map; benchmark on a representative
  test262 subset before merging.
- **Pass-discipline drift over time.** Future passes may forget to update
  the registry. Mitigation: the invariant checker catches violations in
  CI; ADR documents the rules clearly.
- **Scope creep into analysis work.** Tempting to add "just one simple
  analysis" while doing the plumbing. Mitigation: explicit non-goal; any
  analysis is a separate issue.

## Notes

- This issue is **infrastructure**, not feature work. It produces no
  user-visible behavior change. Its value is enabling subsequent issues to
  be smaller and more focused.
- The pattern (registry + per-pass discipline) is the same one LLVM uses
  for its `Value` provenance and MLIR uses for its op-attribute system.
  Worth referencing in the ADR.
- The work can plausibly run in parallel with built-in expansion work,
  since the audit and registry implementation touch the IR core and IR
  passes, not the built-in library.
- A natural sprint shape: week 1 audit + ADR draft, weeks 2–3 registry
  implementation + pass patching, week 4 invariant checker + CI
  integration + ADR finalization.
