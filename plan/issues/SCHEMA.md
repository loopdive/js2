# Issue Metadata Schema

This repository treats issue frontmatter as the canonical source of truth for:

- issue identity
- current status
- sprint assignment
- historical created/completed dates
- classification for filtering and dashboards

Sprint markdown remains prose-first documentation. Issue tables inside sprint
files are generated from issue frontmatter and should not be edited manually.
Canonical issue files live under sprint-grouped folders in `plan/issues/`.
Status is expressed only in frontmatter, not in directory placement.

Current layout (flat, #1616):

- numbered issues: `plan/issues/<id>-<slug>.md` — flat, one stable location for
  every issue regardless of sprint. The file never moves when an issue is
  scheduled or rescheduled; only its `sprint:` frontmatter value changes.
- sprint docs: `plan/issues/sprints/<number>.md` — the planning doc lives
  directly under `sprints/`. Any sprint-scoped planning artifacts (drafts,
  triage notes, screenshots) stay in the corresponding `sprints/<number>/`
  sub-directory.
- sprint membership / bucket is frontmatter only: `sprint: <N>` (numbered
  sprint), `sprint: 0` (pre-sprint history), `sprint: Backlog` (unscheduled);
  wont-fix is a `status: wont-fix`, not a sprint value.
- `plan/issues/backlog/index.md` and `plan/issues/wont-fix/index.md` are
  generated indexes (link to `../<id>-<slug>.md`); `backlog/backlog.md` is the
  curated backlog doc.

## Canonical Frontmatter

Use this shape for real issue files:

```yaml
---
id: 1006
title: "Support eval via JS host import"
status: ready
sprint: 42
created: 2026-04-09
updated: 2026-04-09
completed: 2026-04-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: eval
goal: correctness
parent: 1000
depends_on: [1073]
blocked_by: external
assignee: "ttraenkler/senior-dev-1"
---
```

## Required Fields

- `id`
  - Canonical issue identifier.
  - Usually numeric, for example `1006`.
  - Preserve historical alphanumeric suffixes where they are part of the real
    record, for example `797a`.
  - **A new id MUST be reserved atomically via `claim-issue.mjs --allocate`
    (#2531), never hand-picked.** Hand-picking "next free off `main`" races: two
    creators on separate branches pick the same number, the duplicate is green
    at PR time and only fails in the `merge_group`, wedging the queue.
    `--allocate` reserves the next id unique against `origin/main` ∪ every open
    PR's added issue files ∪ ids already reserved on the orphan
    `issue-assignments` ref (first-push-wins). The required CI gate
    `check:issue-ids:against-main` rejects any PR introducing a main-colliding
    id.
- `title`
  - Human-readable issue title.
- `status`
  - One of:
    - `backlog`
    - `ready`
    - `in-progress`
    - `review`
    - `blocked`
    - `done`
    - `wont-fix`
- `sprint`
  - Use a plain number for numbered sprints, for example `42`.
  - Use `0` for all pre-sprint historical work that predates Sprint 1.
  - Use `Backlog` only for the non-sprint backlog bucket.

## Historical Fields

- `created`
  - First known issue creation date in `YYYY-MM-DD`.
- `updated`
  - Last metadata/content update date in `YYYY-MM-DD` when maintained.
- `completed`
  - Completion date for `done` or `wont-fix` issues in `YYYY-MM-DD`.

## Classification Fields

- `priority`
  - `critical`, `high`, `medium`, `low`
- `feasibility`
  - `easy`, `medium`, `hard`
- `reasoning_effort`
  - `low`, `medium`, `high`, `max`
- `task_type`
  - One of:
    - `analysis`
    - `bugfix`
    - `feature`
    - `investigation`
    - `infrastructure`
    - `performance`
    - `planning`
    - `docs`
    - `refactor`
    - `test`
- `area`
  - Broad subsystem classification.
  - Optional until historically verified.
  - Suggested values:
    - `compiler`
    - `codegen`
    - `runtime`
    - `host-interop`
    - `testing`
    - `tooling`
    - `dashboard`
    - `website`
    - `planning`
    - `docs`
- `language_feature`
  - Dash-case feature tag, for example:
    - `eval`
    - `destructuring`
    - `iterators`
    - `esm-export-default`
    - `weak-references`
    - `compiler-internals`
    - `n/a`
  - Optional until historically verified.

## Normalization Rules

- `status`, `sprint`, and dates are canonical historical metadata and may be
  normalized automatically when backed by issue text, sprint docs, and git
  history.
- `task_type` may be alias-normalized:
  - `bug` → `bugfix`
  - `enhancement` → `feature`
  - `documentation` → `docs`
  - `infra` → `infrastructure`
  - `ui` → `feature`
- `area` and `language_feature` should be added conservatively.
  - If the historical record is unclear, leave them empty and surface the file
    in audit output instead of guessing.

## Relationship Fields

- `goal`
  - Canonical goal identifier.
  - Must match a markdown filename in `plan/goals/` without the `.md` suffix.
  - Example: `core-semantics` maps to `plan/goals/core-semantics.md`.
- `parent`
  - Optional numeric parent issue id.
- `depends_on`
  - Optional flat array of numeric issue ids.
- `blocked_by`
  - Optional blocker label or id.

## Assignment Field (multi-dev, #2155)

- `assignee`
  - Who is working the issue. Humans use their name/handle; dev **agents** use a
    github-account-prefixed name, e.g. `ttraenkler/senior-dev-1`, so an agent's
    work is attributable to the account whose token pushed it.
  - **This frontmatter value is eventually-consistent.** It is written into the
    issue file lazily, inside the issue's own implementation PR (alongside
    `status: in-progress`), and so only reflects on `main` once that PR merges.
  - **The live claim lock is NOT this field.** Because multiple developers
    (humans + agents, possibly across forks) cannot see each other's in-memory
    TaskList, the authoritative "who holds this issue right now" lock lives on a
    dedicated orphan ref, `refs/heads/issue-assignments` on `origin`, one
    `<id>.json` per claimed issue. Claiming pushes there — which never moves
    `main`, never rebuilds queued merge groups (#1951), and never triggers CI.
  - **Always claim through the script**, never by hand-editing this field as the
    lock: `node scripts/claim-issue.mjs <id> <assignee>` (or the `/claim-issue`
    skill). It fetches `origin`, refuses if already claimed or already
    done/wont-fix on `main`, and the first `git push` wins (a concurrent
    claimant gets a non-fast-forward rejection and re-evaluates). `--release`
    on abandon, `--complete` on merge, `--list` to see all live claims.

## Provenance Fields

- `renumbered_from`
  - Optional original issue number when the historical record was split from an
    older duplicate-number ticket.

## Non-Issue Files

The following files are related planning artifacts but are not canonical issue
records:

- `plan/issues/SCHEMA.md`
- `plan/issues/AUDIT-2026-04-14.md`
- `plan/issues/backlog/backlog.md`
- `plan/log/issues-log.md`
- `plan/log/issues/82-findings.md`
- `plan/log/issues/analysis-2026-03-25.md`
- `plan/log/issues/sprint-1.md`
- `plan/log/issues/sprint-2.md`
- `plan/log/issues/sprint-3.md`
- `plan/log/retrospectives/*.md`

Any audit or dashboard tooling must exclude those files.

## Historical Caveat

Some historical records were reopened, superseded, or re-scoped over time. When
those later records had reused an older issue number, they were renumbered into
new unique ids and annotated with `renumbered_from`. Older issue numbers should
therefore be treated as provenance in historical docs, while current planning
and dashboards should use the canonical `id` in frontmatter.

Earlier historical labels such as `Session`, `Dep-driven`, `Wave`, and
`W6-Wave1` were normalized into synthetic sprint `0` so pre-sprint work can be
filtered consistently.
