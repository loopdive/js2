---
id: 4242
title: "Eval engine parity measurement + default flip to QuickJS — interpreter STAYS selectable behind the flag, nothing is deleted"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: medium
horizon: l
feasibility: medium
model: fable
reasoning_effort: high
task_type: feature
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4013, 4229, 4236, 4238, 4245]
blocked_by: [4238, 4245]
# id 4242 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable; pr_scan=degraded). Equivalent open-PR scan
# via the GitHub MCP at reservation time: sole open PR was PR 4250 (#4238
# slice 1, edits the existing 4238 issue file, introduces no new issue ids).
# The id coincides with a merged PR number — shared sequence, not a namespace
# (precedent: 4235/4236/4237, 4245).
---

# #4242 — parity measurement + default flip to QuickJS (no removals)

## The directive this issue encodes (project lead, 2026-08-08)

> do that, but dont delete or remove our interpreter or ir code that it
> needs.

So the migration endgame is a **default flip, not a retirement**:

- `JS2WASM_EVAL_ENGINE` unset → **quickjs** (after this issue lands).
- `JS2WASM_EVAL_ENGINE=interpreter` → the Acorn+bytecode interpreter
  provider, exactly as today, **kept working indefinitely**.
- **Non-goal, permanently out of scope here: deleting or degrading
  `src/interp/`, the interpreter provider build, acorn, or any IR/codegen
  substrate the interpreter needs.** Any future retirement is a separate
  decision for the project lead, not part of this migration.

## Phase 1 — parity measurement (the decision artifact)

- [ ] Run the full eval-dependent test262 set (the ~826-file eval bucket +
      Annex B eval families + `new Function` buckets) under
      `JS2WASM_EVAL_ENGINE=quickjs` on the #4238+#4245 stack; produce a
      three-way diff: quickjs-vs-interpreter-vs-baseline, bucketed by root
      cause (scope fidelity, membrane residuals, engine differences,
      genuine wins where QuickJS fixes interpreter residuals).
- [ ] Record the table in this file. Gate: proceed to Phase 2 only if the
      quickjs engine is **net ≥ interpreter** on the measured set, or every
      net-negative bucket has an explicit accepted-residual entry approved
      in this file.

## Phase 2 — the flip

- [ ] Default branch in `scripts/runtime-eval-provider.mjs` flips to
      quickjs; `interpreter` remains a first-class selectable engine; the
      unknown-value error lists both.
- [ ] Artifact availability becomes a default-path concern: wire the
      QuickJS artifact into the #4013 provider-artifact CI pattern (shared
      cache, key folds the pinned quickjs-ng sha + shim hash) so default
      runs never build from scratch; offline/cache-miss behavior defined
      (hard error with the build command — never a silent fallback to the
      interpreter, which would make conformance numbers lie).
- [ ] Re-baseline test262 (the flip will move eval-bucket results; the
      regression gates must compare like-with-like), following the
      #1528/#3467 baseline-refresh discipline.
- [ ] The QuickJS eval lane becomes the default-exercised path in CI;
      an **interpreter lane** (small, scheduled or per-merge scoped subset
      under `JS2WASM_EVAL_ENGINE=interpreter`) is ADDED so the kept engine
      can't rot silently — mirror image of #4238's constraint 3.
- [ ] Consumers audited: playground/REPL (#4229) and any
      `selectCachedRuntimeEvalProvider` caller picks the intended engine
      explicitly or inherits the new default knowingly (grep audit recorded
      here).
- [ ] Docs: `docs/architecture/runtime-eval-interpreter.md` gains the
      two-engine section; CLAUDE.md test262 notes updated if eval-bucket
      counts shift.

## Acceptance criteria

- [ ] Flip lands with the parity table recorded and the gate above
      satisfied.
- [ ] `JS2WASM_EVAL_ENGINE=interpreter` still passes the interpreter's own
      eval lane after the flip (proof the kept engine still works).
- [ ] No file under `src/interp/` deleted; no acorn/IR removal; diff
      audited for accidental interpreter-path changes.
- [ ] Zero regressions outside the eval buckets; eval-bucket deltas match
      the parity table's accepted entries.

## Implementation Plan

(To be written by architect once #4245 lands and the parity run is
possible — mostly Phase-1 runner mechanics + the flip-site inventory.)
