---
id: 2370
title: "[ARCH] DCE remapTypeIdxInBody is non-idempotent — any aliased helper body double-remaps (latent miscompile)"
status: ready
sprint: Backlog
created: 2026-06-18
assignee: ""
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: codegen-infra
goal: standalone-mode
---

# DCE `remapTypeIdxInBody` is non-idempotent — aliased bodies double-remap

## Problem (latent landmine)

`eliminateDeadImports` (`src/codegen/dead-elimination.ts`) removes dead types and
remaps surviving type indices. It mutates each function body **in place** via
`remapTypeIdxInBody(func.body, tR)` (`walkInstructions` + `a.typeIdx = tR.get(...)`).

The remap is **non-idempotent**: it rewrites `a.typeIdx` to `tR.get(a.typeIdx)`
without marking the instruction as already-mapped. When the remap table `tR`
contains a CHAIN — e.g. `46→40` AND `40→34` (common: both 46 and 40 are live old
indices that compact to different new positions) — and an instruction object is
reachable **more than once** in the body walk, the rewrite composes:
`46 → 40 → 34`. The instruction ends at the wrong type index while the type-def
(remapped once via `surv.map(remapTD)`, which reads the original `td`) lands
correctly. Result: `invalid struct index` / wrong-type miscompile.

**Confirmed instance (#2169b):** `buildIteratorBody` aliased one `vecArm`
`Instr[]` into BOTH the `if`'s `then` and `else` (`elseArm = vecArm` on the
vec-only path), so its shared `struct.new $__IterRec` was walked twice and
double-remapped `46→40→34` (34 = `$__box_boolean_struct`), breaking
`Array.from(<native iterator>)`. That instance was fixed _locally_ (de-alias the
arm — distinct instruction objects per branch). But the DCE pass itself is still
non-idempotent, so **any** helper whose body aliases an instruction object across
two reachable positions is a latent double-remap waiting to trigger whenever the
type-table shape produces a chained `tR`.

## Why this is architect-scale

The durable fix changes the **global DCE remap contract**, not one helper:
make `remapTypeIdxInBody` idempotent so a chained `tR` + any aliasing is safe.
That touches every body the pass rewrites. Options:

1. **Idempotent remap (recommended):** build `tR` so it is NOT chained — i.e.
   compute the new index for each old index directly against the _original_
   numbering (a single old→new map with no transitive composition), and/or apply
   the map by **rebuilding** each instruction's `typeIdx` from a snapshot of the
   pre-remap value rather than reading the possibly-already-mutated field. Since
   `tR` is built old→new in one pass (`surv` enumeration), the chain only bites
   when an instruction is VISITED twice — so the minimal robust fix is to ensure
   `walkInstructions` visits each instruction object at most once, OR to guard the
   mutation (`if (!instr.__remapped) { instr.typeIdx = tR.get(...); instr.__remapped = true; }`)
   and clear the flag after. Prefer a clean "snapshot-then-write" that is immune
   to aliasing.
2. **Forbid body aliasing (defense-in-depth):** a dev-time invariant check that no
   two reachable positions share an `Instr` object. Catches the class at its
   source but doesn't fix the pass.

## Acceptance

- A repro where a helper body aliases a `struct.new` across two arms with a
  chained `tR` no longer miscompiles (add a synthetic test that constructs such a
  body, or re-introduce the #2169b alias and assert it stays valid post-fix).
- Full equivalence suite + standalone HW floor green (the pass rewrites every
  body — broad blast radius).
- No funcIdx/type-idx churn regressions ([[reference_no_rebuild_helper_body_at_finalize]]).

## Source

Root-caused 2026-06-18 (sdev-iter) while fixing #2169b's `__iterator` aliasing.
The localized #2169b fix landed separately; this is the durable global-invariant
follow-on, routed to architect per tech-lead direction.
