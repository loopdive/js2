---
id: 3090
title: "Shrink codegen: delete dormant legacy direct-codegen handlers superseded by IR (~40–55K net LOC)"
status: ready
sprint: current
created: 2026-07-08
updated: 2026-07-08
priority: high
horizon: xl
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: ir-full-coverage
related: [2855, 2856]
---

# #3090 — Shrink codegen: delete the dormant legacy direct-codegen handlers the IR already supersedes

## Why (motivation)

The compiler ships **two front-ends at once**: the legacy direct AST→Wasm
path (`src/codegen/`, accumulated hacks) and the typed IR
(`src/ir/`, `from-ast.ts` → `lower.ts` → `backend/`). With
`experimentalIR: true` the default (`src/codegen/index.ts:1540`), the IR
body is the one that **ships** for every `ir-owned` kind — yet the legacy
direct handler for those kinds is still compiled in as dormant fallback.
That duplication is the single biggest reason the compiler is ~6.4× the
size of a comparable linear-memory TS→Wasm compiler (Porffor: ~32K code
vs our ~207K).

`#2855` (+ `#2856`–`#2859`) drives the *fallback buckets* to zero and
promotes reasons into `STRICT_IR_REASONS` — but it **does not delete** the
now-dead legacy bodies. This issue is the complementary **subtraction**
pass: actually remove the dormant code so the tree shrinks.

## Measured opportunity (tokei, 2026-07-08 baseline)

`src/codegen/` = **154,938** code lines / 150 files. Three-way split:

| Bucket | Code | Disposition |
| --- | --: | --- |
| **STAYS** — substrate/orchestrator the IR reuses (`index.ts`, `coercion-engine`, `js-tag`, `value-tags`, `native-strings`, `registry/`, `context/`, `regex/`, `statements/{loops,control-flow}`…) | ~35,221 | keep |
| **RUNTIME** — stdlib *behavior* emission (`object-runtime`, `array-methods`, `property-access`, `native-regex`, `map-runtime`, `dataview`, generators…) — the IR backend calls it; a front-end swap does not remove the need to emit an array `.map` loop or a regex matcher | ~39,635 | **keep** |
| **FRONTEND** — AST→Wasm dispatch & lowering that `from-ast.ts`/`lower.ts` replace (`expressions/`, operator/closure/literal/object lowering, statement lowering…) | ~80,082 | **deletable** |

**Net estimate: ~40–55K code lines removed** after (a) subtracting ~8–10K
of FRONTEND-classified files that are really shared emission passes
(`stack-balance.ts`, `type-coercion.ts`, `regexp-standalone.ts`), and
(b) offsetting ~15–25K of IR growth needed to finish the remaining
`mixed`/`direct-only` kinds. That takes `src/` from ~207K → **~155–165K
code (~20–27% smaller compiler)** with **no capability change** for the
Phase‑1 slice. It does *not* close the gap to Porffor — RUNTIME (~40K) and
WasmGC substrate (~35K) are intrinsic to targeting WasmGC with a full
stdlib.

## Scope — what to delete vs never touch

**Delete (only):** legacy direct-codegen handlers for AST kinds that are
already `ir-owned` in `plan/log/ir-adoption.md` (22 kinds today), i.e. the
FRONTEND-bucket lowering that is unreachable when `experimentalIR: true`.

**Never touch:**
- Any file in **STAYS** or **RUNTIME** (substrate + stdlib behavior).
- **Deferred** kinds (`eval`, `with`, `Proxy`, `for-in`, async-generator…) —
  they remain direct-only by design; their handlers (e.g. `with-scope.ts`)
  stay.
- Any handler for a `mixed`/`direct-only` kind — the legacy path is still
  live for those until `#2855`-family work flips them to `ir-owned`
  (Phase 3 couples deletion to that flip, per-PR).

## Plan (Fable-friendly: mechanical, sliceable, test-gated)

**Phase 0 — audit → ranked delete-list (1 slice, `s`/`m`).**
Per-function attribution over the 89 FRONTEND files: mark each exported
function legacy-only vs shared, by call-graph reachability from the
non-IR branch in `src/codegen/index.ts` (the demote-to-warning fallback
~`index.ts:889`). Output a checklist doc under `plan/log/` mapping
{kind → file → deletable functions → LOC}, cross-checked against the
`ir-owned` rows of `plan/log/ir-adoption.md`. Replaces the ±10K estimate
band with a hard number and becomes the work-list for Phases 1–2.

**Phase 1 — delete dormant `ir-owned` legacy handlers (many `s`/`m` slices).**
One slice per kind (or per FRONTEND file). Delete the dead handler + its
now-unreferenced local helpers; keep the dispatch shim only if a
`mixed`/deferred kind still needs it. **Zero capability change** — proven by
green full CI + equivalence tests + **no test262 regression** (broad-impact
change ⇒ validate on full CI / `merge_group`, never a scoped sweep;
standalone-floor only runs on `merge_group`). Highest-confidence subtraction;
do first.

**Phase 2 — dead-code sweep (1 slice, `s`).**
No `knip`/`ts-prune` is configured today. Add `knip` to the `quality` CI
job and delete the orphaned exports it flags across `src/codegen/`
(handlers stranded by refactors, helpers no longer dispatched). Low-risk
mechanical win; catches residue Phase 1 leaves behind.

**Phase 3 — couple deletion to bucket-flips (ongoing, follows `#2855`).**
As each `mixed`/`direct-only` kind flips to `ir-owned` (via `#2856`-family
work), **delete its legacy handler in the same PR** rather than leaving it
dormant. Add a "legacy LOC deleted" metric alongside the `#2855` ratchet so
retirement is tracked as subtraction, not just bucket-zeroing.

## Acceptance criteria

- [ ] Phase 0 audit doc committed with a hard deletable-LOC number + ranked
      per-file/per-kind delete-list.
- [ ] `src/codegen/` shrinks by **≥ 30K code lines** net across Phases 1–2
      (stretch: ≥ 45K), measured by `tokei src` before/after (baseline
      `src` = 206,674 code; `src/codegen` = 154,938).
- [ ] **Zero test262 regressions** vs baseline on `merge_group` for every
      slice; equivalence suite green.
- [ ] No file in the STAYS/RUNTIME buckets or any deferred-kind handler is
      modified by Phase 1.
- [ ] `knip` wired into the `quality` CI job (Phase 2); no new orphaned
      exports.

## Guardrails / hazards

- **Broad impact** — each deletion slice touches the shipping compiler;
  validate on full CI / `merge_group`, not a scoped issue sweep
  (see memory `project_broad_impact_validate_full_ci`,
  `project_standalone_floor_only_on_merge_group`).
- **Don't confuse RUNTIME with FRONTEND** — `array-methods`/`object-runtime`/
  `native-regex` have zero IR imports today but emit behavior both paths
  need; deleting them breaks features. Only delete what Phase 0 proves is
  reachable *solely* via the legacy front-end dispatch.
- **Late-import funcidx discipline** — codegen is sensitive to function-index
  shifts; deleting a handler that registered helper imports can shift
  indices. Re-run the standalone floor on `merge_group` for any slice that
  removes an import-registering helper.
- One slice = one kind/file = one PR; keep slices small so a regression
  bisects to a single deletion.

## Notes

Suited to a Fable dev fleet: Phase 1/2 are high-confidence, mechanical,
per-slice deletions gated by strong existing test coverage — parallelizable
across several devs with low collision risk (distinct files per slice).
Phase 0 (the audit) is a good first single-owner task; consider a fan-out
over the 89 FRONTEND files to produce the delete-list quickly.
