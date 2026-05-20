---
id: 1528
sprint: 53
title: "Move 15 MB test262-current.jsonl baseline to js2wasm-baselines repo"
status: ready
created: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: low
task_type: ops
area: ci, repo-hygiene
goal: ci-hardening
related: [1391, 1393, 1525]
---

# #1528 — Move 15 MB test262-current.jsonl baseline to js2wasm-baselines repo

## Problem

`benchmarks/results/test262-current.jsonl` is ~15 MB and committed to the
main repo, refreshed by `refresh-committed-baseline.yml` after every push
to `main`. Every clone of the repo carries this binary-ish blob in
history, and every CI step that touches it pays the cost.

The `loopdive/js2wasm-baselines` repo already exists as the canonical
location for baseline JSONL data. The duplication is historical —
`refresh-committed-baseline.yml` was added so the `dev-self-merge` bucket
analysis could read the JSONL locally without an extra fetch.

## Acceptance criteria

1. **Remove** `benchmarks/results/test262-current.jsonl` from the main
   repo. Add an explicit ignore pattern so it cannot be re-committed
   accidentally.
2. **Retire** `refresh-committed-baseline.yml`.
3. **Dev-self-merge skill** and the bucket analysis step fetch the
   JSONL on demand from `loopdive/js2wasm-baselines` (the workflow
   already pushes to that repo via `promote-baseline` —
   `test262-sharded.yml`). Cache to a local untracked path
   (`.test262-cache/test262-current.jsonl`).
4. **Validator** `pnpm run test:262:validate-baseline` fetches from
   the baselines repo or uses the local cache; behaviour from
   `scripts/validate-test262-baseline.ts` stays identical.
5. **PR template / CI message** points devs at the baselines repo for
   "what does the current baseline look like" questions.
6. **`refresh-committed-baseline.yml`** removal must not silently break
   any other consumer — grep for the path before removal and update or
   delete every reference.

## Implementation notes

- Removing the file is one commit. Coordinate with #1525 (branch
  protection) so the removal commit goes through the same gate.
- The committed `test262-current.json` (~few kB) stays in the main repo
  — it powers the landing page badges and is small enough to be free.
- Consider purging the file from history (git filter-repo) only if
  repo-size reduction is the goal; not required for the immediate fix.
