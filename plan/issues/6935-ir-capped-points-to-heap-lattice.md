---
id: 6935
title: "IR heap lattice for untyped objects: alloc-site < class < union-find region < any, with a Steensgaard-style cap"
status: ready
sprint: Backlog
created: 2026-10-10
updated: 2026-10-10
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: research
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [6934, 1586, 1587, 747, 743]
---

# #6935 — Capped points-to heap lattice for objects without precise types

Follow-up from [`plan/log/nightmonkey-analysis.md`](../log/nightmonkey-analysis.md)
lesson 2. Research-grade: the first deliverable is the lattice, its
monotonicity proof and a consumer that *reads* it; no lowering changes until
a consumer shows a measured need. **[confirmed]** = read in source on
2026-10-10 at the cited location; **[proposed]** = design.

## Problem

**[confirmed]** For a receiver whose propagated type is `object` with a known
structural shape, js2 lowers property access to `struct.get` (ADR-005;
`src/ir/propagate.ts` L105–120, `object` atom with recursive field shape,
depth cap `LATTICE_OBJECT_SHAPE_MAX_DEPTH = 3` at L152). For a receiver that
is `dynamic`, it has nothing: the access is either an `unsupported` outcome
(`property-access-unsupported`, `method-call-unsupported`,
`src/shared/contracts/ir-preparation-failure.ts` L100–114 — a demote) or a
fully dynamic `__dyn_get` (`src/codegen/dyn-read.ts`). There is no middle
abstraction — "one of these three allocation sites", "some instance of class
C or its prefix-compatible subclasses" — that would let the compiler emit a
cheap `ref.test` cascade or a direct call instead of a hash lookup.

**[confirmed]** The existing analyses are keyed by *site* or *shape*, not by
*may-alias set*:

| Module | Keyed by | Answers | Does not answer |
| --- | --- | --- | --- |
| `src/ir/analysis/alloc-registry.ts` (#1586) | `AllocSiteId` per value-creating instr | Stable identity across inline/mono/CF/DCE; metadata namespaces `ownership`, `encoding`, `lifetime`, `escape` (L117–127) | Which sites a *use* may see |
| `src/ir/analysis/ownership.ts` (#1587) | per value, intra-procedural | owned/borrowed/shared/escaped; unknown callee ⇒ escaped (L17–18) | Inter-procedural flow |
| `src/ir/analysis/escape.ts` (#747) | per alloc site | local/returned/stored/captured/opaque | Where a stored value is read back |
| `src/ir/fnctor-field-lattice.ts` + `fnctor-method-edges.ts` (#743) | per constructor unit + field name | Field type facts for function-style constructors (`IrFnctorShape`, `src/ir/core/fnctor-shapes.ts` L28) | Receivers that are not a single known constructor |
| `src/ir/propagate.ts` | per unit param/return, structural `object` atom | Shape-equality typing; `union` capped at 4 members, then `dynamic` | Identity: two sites with the same shape are one atom; two shapes are `dynamic` |

## Motivation (NightMonkey evidence)

NightMonkey (DESIGN.md §4 "Calls and heap") models the heap as a lattice:
**allocation site < constructor class (object literals get a pseudo-class) <
union-find region of classes < any object**. Flow is directional
(Andersen-like), but where an Andersen points-to set would grow past one
element the members are *unioned* into a region (Steensgaard-like cap), so no
set ever exceeds one element and the fixpoint stays near-linear. Each
abstraction carries predicted field types and slot numbers. Compatible layouts
receive **contiguous numbered IDs** so a subtype test is one range check
(§6 "Compatible prefix layouts receive contiguous keys so one range check can
cover a layout region").

Ablation (VMIL 2026 slides, speed relative to full): **no heap abstractions
0.76×**, **no direct call targets 0.82×**, no slot predictions 0.88×. Together
the heap side is worth roughly a third of the runtime on Octane — second only
to likely types.

## Current js2 state (cited)

- `object` atoms are structural, so `{x, y}` from two sites is one atom and
  `{x, y}` vs `{x, y, z}` join to `union` then `dynamic` (`propagate.ts` join
  rules L46–52). Identity is lost at the first join of different shapes.
- Class dispatch is already direct when the receiver IrType is `class`:
  `src/ir/lower-generic.ts` L2186–2202 emits `call $<Class>_<method>` after
  resolving the shape. There is no devirtualisation for a `dynamic` receiver,
  and no `ref.test` cascade for "one of N classes".
- Function-style constructors get the #743 satellite fixpoint whose output
  feeds exactly one consumer (`fnctor-method-edges.ts` header, "its output
  feeds exactly ONE consumer") — a deliberate guard against widening the main
  TypeMap, which the #1712-class demotion hazard punishes.
- ADR-0013 reserves alloc-registry namespaces "for the follow-up issues"; a
  points-to namespace does not exist yet.

## Implementation Plan

### Which module this extends (not a parallel authority)

**[proposed]** The lattice is a new **alloc-registry metadata namespace**,
`pointsTo`, alongside `ownership`/`encoding`/`lifetime`/`escape`
(`ALLOC_NAMESPACES`, `src/ir/analysis/alloc-registry.ts` L117–127). The
registry already owns site identity across every pass; the new analysis owns
*only* the abstraction-per-value map and the union-find over classes. It does
not touch `propagate.ts`'s TypeMap (same discipline as #743's satellite) and
it does not mint a second notion of class — a "class" tier element is an
existing `IrClassShape` / `IrFnctorShape`, or a literal pseudo-class keyed by
the object literal's `AllocSiteId`.

### Lattice [proposed]

```
⊥  <  site(AllocSiteId)  <  class(ClassKey)  <  region(UnionFindRoot)  <  anyObject
```

- `site ⊔ site'` (same class) → `class`; (different classes) → `region`
  after `union(class, class')`.
- `class ⊔ class'` → `region(union(...))`; `region ⊔ x` → `region(union(root, class(x)))`.
- `anyObject` absorbing. Non-object atoms (`f64`, `string`, …) are not in this
  lattice; a value that may be object-or-primitive is `anyObject` here and the
  scalar fact lives in the TypeMap as today.
- Monotone: unions only grow, tiers only go up; finite height = 4 + number of
  classes. Terminates without a budget, but a region count cap (proposal 256)
  collapses to `anyObject` to bound `ref.test` cascades.

Each class carries per-field facts (type from the #743 field lattice where
it exists, else `dynamic`) and a **slot ordinal**; prefix-compatible classes
(subclass adds fields after the parent's) get **contiguous numbered IDs** in a
DFS numbering of the inheritance tree so "instance of C or a subclass" is
`id ∈ [first(C), last(C)]`.

### Flow [proposed]

Directional, over the IR after `inlineSmall`/`monomorphize` (so clones have
their own sites): `object.new`/`class.new`/`fnctor.new`/`vec.new_fixed`
produce `site`; `object.set`/`class.set` flow the value's abstraction into
the field fact of the *receiver's* abstraction; `object.get`/`class.get` read
it; calls flow args→params and return→call site per unit (the call graph from
`propagate.ts`/`fnctor-method-edges.ts`, not a new one); unknown callee or
`coerce.to_externref` ⇒ `anyObject` (same rule as `ownership.ts` L17–18).
Writes with an unknown key or receiver are **not dropped** (NightMonkey drops
them — a soundness corner js2 cannot take): they widen the receiver's every
field to `dynamic`.

### Consumers, in order [proposed]

1. **Read-only report** (`scripts/ir-points-to-report.ts`, `.tmp/` style
   output): per module, how many `dynamic` receivers at `object.get`/
   `class.get`/method-call sites resolve to `site`/`class`/`region` vs
   `anyObject`. This is the go/no-go number.
2. **Property-access lowering:** a `class`/`region` receiver lowers to a
   `ref.test` (one, or a range check once numbered IDs are emitted) then
   `struct.get`, with the `anyObject` arm as the boxed fallback — i.e. the
   GEN arm of [#6934](6934-ir-optimistic-track-runtime-fallback.md). This
   consumer **depends on #6934's design** for the fallback arm.
3. **Devirtualisation:** a `class` receiver turns `method-call-unsupported`
   demotes into the existing direct `call` path (`lower-generic.ts` L2186);
   a small `region` turns into an `if`-cascade over its members.
4. **Escape/ownership precision:** `ownership.ts` can treat a store into a
   receiver whose abstraction is a single non-escaping `site` as `borrowed`
   rather than `escaped`; `escape.ts` `stored` becomes `stored-into(site)`.

### Files that would change [proposed; Session A to confirm]

`src/ir/analysis/alloc-registry.ts` (namespace), new
`src/ir/analysis/points-to.ts` (lattice + union-find + flow),
`src/ir/analysis/escape.ts` / `ownership.ts` (consumer 4, optional),
`src/ir/from-ast.ts` or a new pass under `src/ir/passes/` (consumers 2–3),
`src/ir/core/nodes.ts` only if a range-check instr is needed (prefer `ref.test`
cascades first). `docs/adr/0013-ir-allocation-sites.md` gains the namespace
row.

### Owner implications

Shared IR scope under #3518 / Session A integration. **Needs Session A
acknowledgement before implementation.** Consumer 1 (report only) touches no
production lowering and could be released first.

## Acceptance criteria

- [ ] `points-to.ts` with a property-based test that joins are monotone and
      the fixpoint terminates on randomly generated flow graphs.
- [ ] Report (consumer 1) on `website/playground/examples/`, the acorn
      dogfood corpus and the #874 Octane sources: counts per tier at every
      dynamic-receiver site, committed under `plan/log/`.
- [ ] Decision recorded: which consumer (2/3/4) the numbers justify, or none.
- [ ] If consumer 2 or 3 is built: default output byte-identical with the
      analysis off; equivalence gate green; `check:ir-fallbacks` buckets not
      higher.

## Measurement plan

- Static: tier histogram from consumer 1 (the analysis's own output).
- Dynamic: Octane Richards/DeltaBlue via the [#874](874-benchmark-compare-all-js-to.md)
  harness once landed — these are the subtests whose cost is dispatch and
  field access, exactly what tiers 2–3 target; interim
  `benchmarks/cross-engine/` object/dispatch axes with checksum match, same
  session, min-of-5.
- Compile-time: wall-clock of `compile()` on the acorn corpus before/after
  the analysis is on; cap at +10 % or the region cap is lowered.

## Risks

- **Parallel authority.** The real risk this issue is written to avoid: a
  second shape model competing with `IrClassShape`/`IrFnctorShape`/the
  structural `object` atom. Mitigation is structural — tier-2 elements *are*
  those shapes, and the lattice lives in the registry namespace.
- **Unsound corners NightMonkey accepts** (dropped unknown-key writes,
  prototype methods taking the prototype as `this`, "builtins not
  monkeypatched", globals static after init). js2 may not; each is listed
  above with the conservative rule, and a reviewer should check no rule was
  loosened.
- **Region explosion on polymorphic libraries:** the cap collapses to
  `anyObject`, which is today's behaviour — never worse than now.
- **Without #6934 there is no fallback arm**, so consumers 2–3 cannot ship
  before it; consumer 1 and 4 can.
