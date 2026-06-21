---
id: 2550
title: "Author-trust gate must allow the maintainer's fork — auto-enqueue locked out ALL fork PRs"
status: done
sprint: 64
created: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: low
task_type: infrastructure
area: tooling
language_feature: n/a
goal: correctness
related: [2549, 2547, 1758]
assignee: "ttraenkler/dev-gate"
---

# #2550 — author-trust gate fork allowlist

## Problem

The #2549 author-trust gate in `scripts/enqueue-green-prs.mjs` only auto-enqueues
PRs whose `authorAssociation` is `OWNER` / `MEMBER` / `COLLABORATOR`. But GitHub
classifies the maintainer `ttraenkler` — whose fork (`ttraenkler/js2`) the WHOLE
team pushes to — as `authorAssociation=CONTRIBUTOR` on the base repo (they have
merged PRs but are not an org MEMBER). So with the association check alone,
**every** team fork PR was skipped with `untrusted-author:CONTRIBUTOR`,
auto-enqueue was effectively disabled, and the tech-lead had to hand-enqueue
every green PR. Confirmed live in the auto-enqueue log:
`#1779 skip (untrusted-author:CONTRIBUTOR)`.

## Fix (USER-APPROVED — approach a: code allowlist by login/fork)

Layer a login/fork allowlist **alongside** the existing
`TRUSTED_AUTHOR_ASSOCIATIONS` check, mirroring `approve-fork-runs.yml`'s existing
"trusted `ttraenkler/js2` fork" notion. A PR is trusted if it satisfies **ANY**
of:

1. `authorAssociation ∈ {OWNER, MEMBER, COLLABORATOR}` (unchanged #2549 path), OR
2. author login ∈ `TRUSTED_AUTHOR_LOGINS` (default `["ttraenkler"]`), OR
3. head-repository owner ∈ `TRUSTED_FORK_OWNERS` (default `["ttraenkler"]`).

Everything else still **FAILS CLOSED** — a stranger `CONTRIBUTOR`/`NONE`/unknown
is never auto-enqueued and still requires a deliberate human enqueue.
`cla-check` remains the deeper merge gate for external contributions.

### Implementation notes

- New pure exported helper `isTrustedAuthor({ assoc, authorLogin, headRepoOwner })`
  → `{ trusted, reason }`. The inline gate now calls it. Exported so it can be
  unit-tested without running the live `gh` sweep.
- The live sweep body is wrapped in `runSweep()`, invoked only under an
  `import.meta.url === pathToFileURL(process.argv[1])` main-module guard (the
  convention used across `scripts/`). Importing the module makes **no** `gh`
  call — required for the test to import `isTrustedAuthor` safely.
- `openPrs()` now also fetches `author` and `headRepositoryOwner` (both ARE
  supported by `gh 2.23`'s `pr list --json`, unlike `authorAssociation` which
  needs GraphQL) to feed the allowlist.
- Both `TRUSTED_AUTHOR_LOGINS` and `TRUSTED_FORK_OWNERS` are env-overridable,
  comma-separated, lower-cased; the membership check is exact (no substring
  trust). Kept narrow — a deliberate trust grant, not a convenience widening.

## Acceptance criteria

- [x] `ttraenkler` + `CONTRIBUTOR` now PASSES the gate (`trusted-login:ttraenkler`).
- [x] A head-repo owned by `ttraenkler` passes even with a non-`ttraenkler`
  author login (`trusted-fork:ttraenkler`).
- [x] `OWNER`/`MEMBER`/`COLLABORATOR` still pass by association alone.
- [x] A stranger (`CONTRIBUTOR`/`FIRST_TIME_CONTRIBUTOR`/`NONE`/`MANNEQUIN`/
  unknown) with no allowlist match still SKIPS (`untrusted-author:<assoc>`) —
  fail closed.
- [x] Missing/empty input fails closed.
- [x] Importing the script makes no `gh` calls; `--dry-run` runs without crashing.
- [x] Unit test in `tests/issue-2550-trust-gate-fork-allowlist.test.ts`.

## Test results

`node --check` passes; `prettier --check` clean.
`npx vitest run tests/issue-2550-trust-gate-fork-allowlist.test.ts` → 13/13 pass.
`DRY_RUN=1 node scripts/enqueue-green-prs.mjs` against live open PRs runs clean —
fork PRs are no longer skipped `untrusted-author:CONTRIBUTOR` (they now fall
through to the ordinary green/state checks). Direct gate simulation:
`ttraenkler`+`CONTRIBUTOR` → `{trusted:true, trusted-login:ttraenkler}`; stranger
`NONE` → `{trusted:false, untrusted-author:NONE}`.
