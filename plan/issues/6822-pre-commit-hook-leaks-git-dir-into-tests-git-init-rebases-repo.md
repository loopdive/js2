---
id: 6822
title: "hooks: `test:changed-root` runs vitest with the hook's `GIT_DIR` in the environment — a test that ran `git init` in a tmp dir re-initialised the shared repository as bare (2026-10-02 06:30 UTC, every worktree lost git)"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: s
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: tooling
language_feature: n/a
goal: maintainability
related: [6797, 6783, 3008]
requested_by: ttraenkler/claude-review
origin: "incident during the #6797 implementation (2026-10-02): tests/check-flat-dir-budget.test.ts and tests/check-import-cycles.test.ts under the pre-commit hook; root-caused by dev-6797, per-test hardening pending in its follow-up PR"
---
# #6822 — strip the hook's git environment before running tests

## Incident

Git exports `GIT_DIR` (and, for linked worktrees, the worktree gitdir) to
hooks. `.husky/pre-commit` runs `pnpm run test:changed-root`
(`scripts/hooks/changed-root-tests.sh`) with that environment. A changed root
test created a throwaway repository with `git init` in `os.tmpdir()`; with
`GIT_DIR` inherited, `git init` re-initialised the **real** repository
(`/home/user/js2/.git`) and wrote `core.bare = true`. From that moment every
`git status`/`commit`/`merge` in every worktree failed with
`fatal: this operation must be run in a work tree`, the agent harness could
not verify worktrees, and three in-flight PRs were stranded until a human
repaired the config.

Ten other root tests also `git init` (`tests/issue-3303.test.ts`,
`tests/issue-3344.test.ts`, `tests/issue-3518-*.test.ts`,
`tests/issue-3880.test.ts`, `tests/issue-3965.test.ts`, `tests/issue-3969.test.ts`,
…); they have not bitten only because the changed-root gate runs a test only
when that test file itself changed.

## Correction

1. `scripts/hooks/changed-root-tests.sh`: after resolving the repo root,
   run vitest under `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX -u GIT_COMMON_DIR`
   (the hook has already `cd`'d to the top level, so discovery works without
   them).
2. A shared `tests/helpers/git-env.ts` (`cleanGitEnv()`) used by every test
   that spawns git in a temporary directory; the per-test hardening dev-6797
   wrote for the two new tests moves there.
3. A guard test that greps `tests/**/*.test.ts` for `"init"` git calls and
   fails unless the call site uses the helper.

## Acceptance

- Reproduction: a test that runs `git init` in a tmp dir, executed via the
  pre-commit hook, leaves `git config core.bare` unchanged in the real repo.
- The guard test is green; `scripts/hooks/changed-root-tests.sh` strips the
  variables (asserted by the hook's existing test).
