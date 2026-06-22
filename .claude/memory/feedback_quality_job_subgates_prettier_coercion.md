---
name: feedback_quality_job_subgates_prettier_coercion
description: "The CI `quality` job runs sub-gates (prettier format:check + #2108 coercion-drift) a scoped local test never triggers — pre-check both before pushing codegen"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

The required CI `quality` job bundles several sub-gates beyond tsc/lint that a scoped local compile-and-run check NEVER surfaces. Two bit me in sequence on one #2575 PR (#1865), costing two CI round-trips:

1. **prettier `format:check`** (NOT biome — see [[project_prettier_not_biome_write]]): long single-line test expectations fail. Fix: `npx prettier --write 'src/**/*.ts' 'tests/**/*.ts'`.
2. **#2108 coercion-site drift gate** (`scripts/check-coercion-sites.mjs`): counts uses of the sealed coercion vocabulary (`number_toString`, `__to_primitive`, `__extern_toString`, `__to_boolean`, …) OUTSIDE the engine, baseline-per-file. A new codegen site that legitimately REUSES an engine helper (e.g. calling native `number_toString` to ToString an array index) still trips it as growth. It even counts the token in COMMENTS. Minimize to the irreducible string-literal reference (a `const NAME = "number_toString"` + rephrase prose comments to drop the literal token), then refresh: `node scripts/check-coercion-sites.mjs --update` and commit `scripts/coercion-sites-baseline.json`.

**Why:** "compiles + my test passes" ≠ "quality gate passes". The quality job is the same `quality` required check the merge queue enforces; its sub-gates are orthogonal to test logic, so a green scoped local run says nothing about them.

**How to apply:** before pushing ANY codegen/test change, run locally in the worktree: `npx tsc --noEmit`, `npx prettier --check '<changed files>'`, `node scripts/check-coercion-sites.mjs`, and `node scripts/check-test262-hard-errors.mjs`. If the coercion gate flags a legitimate engine reuse, minimize the footprint then `--update` the baseline (it's the sanctioned path the gate message itself points to). See [[feedback_verify_gates_against_committed_tree]] for the verify-against-committed-tree discipline.
