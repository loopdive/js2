---
id: 6824
title: "hygiene residue from #6796: 22 MB of dogfood npm tarballs and 23 fixture-only devDependencies still in the root package, the critical `decompress` advisory needs a componentize-js/weval upgrade, and the shared worktree node_modules is pinned at vitest 3.2.4 while the lockfile says 3.2.7"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: low
horizon: m
feasibility: medium
reasoning_effort: low
task_type: infrastructure
area: tooling
language_feature: n/a
goal: maintainability
related: [6796, 916]
requested_by: ttraenkler/claude-review
origin: "carve-outs named by the #6796 implementation (2026-10-02, PR 6424: −15.2 MB / −463 files landed, the rest deferred)"
---
# #6824 — what #6796 deliberately left out

| item | state after PR 6424 | correction |
|---|---|---|
| `tests/dogfood/fixtures/*.tgz` (29 tarballs, 22 MB) | still tracked | fetch at test time from the lockfile versions into a gitignored `tests/dogfood/.fixtures/`; the harness already has the version list |
| 23 devDependencies with zero `src/` imports (react, three, webpack, jest, hono, lit, …) | still in the root `package.json` | move to `packages/dogfood-fixtures/package.json` (workspace exists); root install pulls none of them |
| `decompress` critical advisory via `@bytecodealliance/componentize-js` | open | upgrade componentize-js (and weval if it pins it); if no fixed version exists, record the accepted risk in `docs/ci-policy.md` with a date |
| `pnpm audit --audit-level=critical` | 1 remaining (above) | exit 0 |
| shared worktree `node_modules` on vitest 3.2.4 | lockfile moved to 3.2.7 in #6796 | the worktree provisioning hook (`provision-worktree.sh`) must re-link when the lockfile changes, or new worktrees run the old version |
| `peerDependencies` on `bun`/`deno` | unchanged | replace with an `engines` note in README |

## Acceptance

- `git ls-files -z | xargs -0 du -cb | tail -1` drops by ≥ 20 MB more.
- `pnpm install` at the root pulls no React/three/webpack unless the dogfood
  workspace is installed; `pnpm audit --audit-level=critical` exits 0.
- A fresh worktree runs the lockfile's vitest version (asserted by a hook test).
