---
id: 2552
title: "Annex B B.3.3 Phase 2 rework — TDZ-var outer-binding allocation perturbs hot-path codegen (-1180 test262 regression)"
status: ready
sprint: 64
created: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: annex-b, block-functions
goal: spec-completeness
parent: 2200
related: [2200, 1764]
origin: "2026-06-19 — #2200 Phase 2 (PR #1769) failed the full test262-regression gate -1180; parked Phase-1-only. This is the rework follow-up."
---

# #2552 — Annex B Phase 2 rework: TDZ-var allocation perturbs hot-path codegen

> **ID note (2026-06-20):** originally drafted as `#2514`, which collided with
> the already-on-main `#2514` (runtime-helpers-as-shared-linkable-module).
> Renumbered to `#2552` via the atomic allocator (`claim-issue.mjs --allocate`).

## Context

#2200 Phase 1 (#1764, ~93-test floor: case-A cancellation) is **merged and stands
alone**. Phase 2 (case-B uninitialised-then-init outer var-binding + `typeof`
resolution) was implemented on branch `issue-2200-annexb-phase2` (PR #1769) but
the **full CI test262-regression gate flagged -1180 net pass (1411 regressions,
231 improvements)** — so Phase 2 is parked (PR #1769 → draft) pending this rework.

## The regression (gate bucket output, signature `d57ce880bc38ea96`)

- categories: `wasm_compile: 625`, `null_deref: 593`, `type_error: 143`, other 41.
- top buckets (each >50): `Array/prototype/{some 115, every 113, filter 109,
  map 93, forEach 86, reduceRight 69, reduce 58}`,
  `language/statements/{function/dstr 88, generators/dstr 88,
  async-generator/dstr 52}`.

**Confirmed NOT drift:** PR #1767 ran its gate against the SAME fresh baseline
seconds apart and was clean (+21, different signature, 3 files). The -1180 is
specific to #1769's 4-file Phase 2 delta (`context/types.ts`, `statements.ts`,
`nested-declarations.ts`, `typeof-delete.ts`; `array-methods.ts` byte-identical to
main).

## Root cause (hypothesis — needs local-slice confirmation)

The Phase 2 **TDZ-var allocation in `hoistFunctionDeclarations`**
(`src/codegen/statements/nested-declarations.ts`): `annexBBlockNestedEligible`
→ for any block-nested function it does `allocLocal(fctx, funcName, externref)` +
an `__tdz_<name>` i32 flag and records `annexBOuterBindings`. The `null_deref` /
`wasm_compile` categories across hot-path Array methods + `*/dstr` strongly
suggest this **perturbs local-index layout** (or leaves an uninitialised
outer-binding externref local that a shared codegen path reads) for the dominant
test262 harness shape: a function that merely **contains** a block-nested helper
(the Array-method test files wrap assertions + helper fns in blocks). The
gate fails, but it does NOT reproduce in targeted local compiles (standalone OR
host) of realistic shapes — it lives in test262's specific harness/strict-mode
config.

## Rework plan

1. **Reproduce FIRST against a local test262 slice** over the flagged buckets
   (`built-ins/Array/prototype/{some,every,filter,map,forEach,reduce,reduceRight}`
   + `language/statements/{function,generators,async-generator}/dstr`) — do NOT
   attempt a blind patch. Use `pnpm run test:262` scoped to those paths (or the
   runner's category filter) on the `issue-2200-annexb-phase2` branch vs main to
   get the exact failing files + WAT.
2. **Narrow `annexBBlockNestedEligible`** so the outer-binding TDZ-var is
   allocated ONLY when the outer binding is actually OBSERVED (read/typeof'd
   outside the declaring block) — a function that merely *contains* a block-nested
   helper, or whose block-fn name is never referenced at function scope, must be
   byte-identical to pre-Phase-2 codegen (no `allocLocal`, no flag, no
   `annexBOuterBindings` entry). The current gate fires on mere structural
   eligibility, which is too broad.
3. **Preserve the typeof-resolution fix** (`emitAnnexBTypeofFlagBranch` invoked at
   the top of the undeclared-identifier branch in `typeof-delete.ts`) — it is
   correct and reusable; the bug is in the allocation breadth, not the typeof
   read.
4. **Re-validate against the FULL gate** (not just local unit tests) before
   re-opening #1769 / a fresh PR — the local Phase-2/typeof/scope tests passed
   while the broad gate caught the regression, so a local-slice + full-gate
   re-run is mandatory.

## WIP / branch

`issue-2200-annexb-phase2` (PR #1769, draft). Phase 2 plumbing + the correct
typeof fix + the full regression diagnosis live there. Phase 1 floor is on main
(#1764).

## Acceptance criteria

- The case-B behaviours work (TDZ binding / value / in-block call / if-skip /
  `typeof` after-block→"function", before/skip→"undefined") — i.e. the Phase 2
  unit tests pass.
- The full test262-regression gate is **net ≥ 0** with no bucket >50 and ratio
  <10% (no Array/prototype/* or */dstr regression).
- `#2200` can then close (both phases complete).
