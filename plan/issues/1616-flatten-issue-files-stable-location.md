---
id: 1616
title: "Flatten issue files into a stable location; sprint membership via frontmatter only"
status: ready
created: 2026-05-24
updated: 2026-08-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: tooling
language_feature: n/a
goal: process
sprint: current
---
# Issue #1616 — Flatten issue files into a stable location; sprint membership via frontmatter only

## Problem

Issue files move between `plan/issues/sprints/<N>/` and `plan/issues/backlog/`
as they are scheduled and rescheduled. Every move **breaks every link** to the
file — internal markdown links, and external GitHub issue bodies that reference
the path. Two recent breakages:

- GitHub #389 linked `plan/issues/sprints/52/1521-...` — which was both the
  wrong path (the file later moved) and (per the stakeholder) the wrong issue.
- #1530 moved the entire Sprint 52 issue set from `sprints/52/` to `sprints/55/`,
  invalidating every link into Sprint 52.

**Goal**: a permanent, stable on-disk location for each issue so links survive
sprint scheduling changes. Sprint membership is tracked by the `sprint:`
frontmatter field **only**, never by directory.

This is **design only**. No file moves, no tooling edits, no renumbering happen
under this issue. This issue file *is* the spec; a follow-up implementation PR
(one senior dev) executes it.

---

## Findings from the current repo (verified against `origin/main`, 2026-05-24)

### Scope counts (corrected)

The stakeholder's pre-measured counts used a `[0-9]{4}` filename regex, which
misses Sprint 0's 1–3-digit IDs and the two number-only files. Verified counts
using `/[0-9]+(-slug)?\.md`:

| Location | Numbered issue files |
|---|---|
| `plan/issues/sprints/*/` (excl. `sprint.md`) | **1,392** |
| `plan/issues/backlog/` | **160** |
| `plan/issues/wont-fix/` | **5** |
| number-only (`backlog/1087.md`, `sprints/47/1278.md`) | **2** |
| **Total numbered issue files** | **~1,559** |
| `sprint.md` files (STAY in `sprints/<N>/`) | **59** |

### Frontmatter coverage gap (BLOCKER #1 — must backfill before move)

- **1,592** numbered files scanned: **1,590** have `status:`, but only
  **1,433** have a `sprint:` line. **159 files have no `sprint:` frontmatter.**
- Root cause: `scripts/update-issues.mjs` has `DROPPED_KEYS = new Set(["sprint"])`
  (line 73) and **actively strips** the `sprint` field on every normalization
  pass, deriving sprint from the directory instead. So even files that get
  backfilled lose the field on the next `update-issues` run.
- **Consequence**: you cannot move files first and rely on existing frontmatter.
  The `sprint:` field must be backfilled from the *current path* for all 1,592
  files, AND `update-issues.mjs` must stop dropping it, **in the same change**.

### Duplicate issue numbers (BLOCKER #2 — flat layout impossible without resolving)

`node scripts/update-issues.mjs --check` reports **33 duplicate IDs**. They fall
into two classes:

**Class A — stale duplicate (same slug, two locations).** A backlog copy was
left behind when the issue was scheduled. Resolution: `git rm` the stale copy
(keep the one whose `sprint:`/`status:` reflects reality), no renumber.

```
#1130  backlog/ + sprints/55/   (same slug)
#1154  backlog/ + sprints/50/   (same slug)
#1307  backlog/ + sprints/50/   (same slug)
#1292  sprints/48/ + sprints/50/ (same slug)
#1310  sprints/50/ (two near-identical slugs: vm-sandbox-isolation / -test262-isolation)
#1278  sprints/47/1278.md + sprints/47/1278-update-stale-lodash-tier1-stress.md
```

**Class B — genuine number collision (different issues share a number).** These
**must be renumbered** to a fresh ID before a flat layout can exist. Use the
existing `renumbered_from:` frontmatter convention (already used by 10 issues;
it is in `ORDERED_KEYS`). The lower-information / newer file gets a new number
from the free pool (≥ 1617); add `renumbered_from: <old>` to the renamed file.

```
#1295  compiler-rethrow-wasmexception      vs lodash-init-start-function-throw
#1323  iterator-protocol-pure-wasm (s50)   vs iterator-result-struct-runtime-wiring (s56)
#1334  ecmascript-spec-compliance-audit    vs spec-gap-object-defineproperty-...
#1335  number-formatting-pure-wasm  + spec-gap-object-assign + spec-gap-object-defineproperty (THREE)
#1336..#1353  an off-by-one "spec-gap-*" sequence in sprints/50 — each number
       hosts two adjacent spec-gap files. This is a numbering drift introduced
       when the spec-gap cluster was created. Treat the whole 1334–1353 block
       as one renumber batch.
#1352  regexp-exec-result-... (backlog)    vs spec-gap-set-methods-set-like-arg (s50)
#1353  spec-backlog-memory-model (backlog) vs json-stringify-parse-shape-walking (s50)
#1392  ir-null-safe-access-primitives (s51) vs refresh-benchmarks-browser-hang (s52)
#1396  for-of-dstr-oob-undefined-sentinel  vs forof-dstr-externref-array-default
#1522  codegen-invalid-wasm-type-coercion  vs race-local-test262-vs-ci  (both backlog)
#1552  tagged-union-value-rep-retire...    vs spec-gap-try-catch-param-destructuring
#779   assert-failures-tests-compile-and (backlog) vs 779-820-cluster-decomposition (s53)
```

> **The implementer must produce a `git rm` / `git mv` + `renumbered_from`
> decision for every one of the 33 before any flatten.** This is the single
> highest-risk part of the work; do it as an explicit, reviewable pre-step
> (committed within the same PR but as its own logical chunk).

### Tooling already half-migrated (good news)

`SCHEMA.md` already declares the **target state**:

> "Status is expressed only in frontmatter, not in directory placement."
> `sprint`: plain number for sprints, `0` for pre-sprint historical, `Backlog`
> for the non-sprint backlog bucket.

And four of the consumers already prefer frontmatter over path:
`fm.sprint || sprintFromPath(file)` / `fm.sprint || sprintFromDir`. The path is
only a *fallback*. Once every file has accurate `sprint:` frontmatter, those
tools keep working under a flat layout with **no code change** — the fallback
simply stops being exercised. The one tool that breaks the model is
`update-issues.mjs` (it strips `sprint`). The schema and that tool currently
contradict each other; this migration resolves the contradiction in the tool's
favor of the schema.

---

## Decision 1 — Filename scheme

**Recommended: (a) flat, slug-retained — `plan/issues/<N>-<slug>.md`.**

Reasoning:
- The actual reported problem is *sprint-move breakage*, not slug churn. Flat +
  slug eliminates 100% of sprint-move breakage (the file never moves when a
  sprint is rescheduled — only its `sprint:` frontmatter value changes).
- Slugs keep the 1,559-file directory human-scannable (`ls plan/issues | grep
  iterator`), which matters because devs grep this dir constantly.
- The residual risk — a *slug rename* still breaks links — is real but rare and
  easily fenced off with a lint (below). Sprint moves happen every sprint;
  deliberate slug renames happen almost never.

Number-only (option b) is rejected as the default: it makes the dir
non-self-documenting (1,559 × `NNNN.md`) for a marginal gain over the lint.

**Rename-safety lint (required companion to scheme (a)):**
- Add a check to `update-issues.mjs --check` (or a new `check:issue-links`
  script wired into the `quality` CI job) that:
  1. Builds the set of valid issue paths `plan/issues/<N>-<slug>.md`.
  2. Greps all tracked `*.md` (excluding `test262/`) for
     `plan/issues/[0-9]+-[^)]*\.md` links and fails if any link points at a
     non-existent file. This is the intra-repo broken-link check (also part of
     the validation plan).
- Enforce filename ↔ frontmatter agreement: the `<N>` prefix must equal `id:`.
  `update-issues.mjs` already computes `idMismatches` (lines 642–647) — promote
  that from a printed warning to a non-zero exit under `--check`.
- Renames, when they must happen, are done via `git mv` + a `renumbered_from`-
  style note is NOT needed (number is stable); instead the rename PR must update
  all in-repo links in the same commit (the lint enforces this).

**Edge cases the scheme must preserve:**
- Alphanumeric IDs: `779a`, `797a`, `1169n` — keep the letter suffix
  (`<N><letter>-<slug>.md`). Regexes below already allow `[a-z]?`.
- The 2 number-only files (`1087.md`, `1278.md`): give them slugs during the
  move (`1087-<slug>.md`) so the layout is uniform; record old name in commit.

## Decision 2 — Sprint membership = frontmatter only; representing "no sprint"

- **`sprint: <N>`** — member of numbered sprint N.
- **`sprint: 0`** — pre-Sprint-1 historical work (SCHEMA already says this).
- **`sprint: Backlog`** (capital B, per SCHEMA) — in the backlog, not scheduled.
- **wont-fix is NOT a sprint value** — it is a `status: wont-fix`. A wont-fix
  issue keeps whatever `sprint:` it last had (or `Backlog`). This matches the
  existing tools: `generateWontFixIndex` already filters on
  `status === "wont-fix"`, and `dashboard/build-data.js` treats wont-fix as a
  label shown in the Done lane, not a separate sprint.

So "not in a sprint" = `sprint: Backlog` + a `status:` of `backlog`/`ready`/
`blocked`/`wont-fix`. No new field is introduced. `wont-fix/` and `backlog/` as
*directories* disappear; their distinction lives entirely in `status:`.

**Backfill rule (the migration's first script step):** for every file, if
`sprint:` is absent, set it from the current path —
`sprints/<N>/` → `sprint: <N>`, `backlog/` → `sprint: Backlog`,
`wont-fix/` → `sprint: Backlog` (and ensure `status: wont-fix`). 159 files need
this. Existing `sprint:` values are authoritative and left untouched (author
intent wins, matching `backfill-issue-sprint-frontmatter.mjs` semantics).

---

## Per-tool change table

Each row is current dir-based logic → required change. File:line are against
`origin/main` 2026-05-24.

| # | File | Current behavior | Required change |
|---|------|------------------|-----------------|
| 1 | `scripts/update-issues.mjs` | `DROPPED_KEYS = new Set(["sprint"])` (L73) strips `sprint`; `sprintFromPath()` (L133–139) derives sprint from `/sprints/N/`, `/backlog/`, `/wont-fix/`; `sprintNum` from path (L348–349); `generateBacklogIndex` filters `r.sprint === "backlog"` (L529); `generateWontFixIndex` filters `r.sprint === "wont-fix"` (L591); links via `basename(rec.file)` (L546, 579, 607) | (a) Remove `"sprint"` from `DROPPED_KEYS` and ADD `sprint` to `ORDERED_KEYS` so it is preserved & ordered. (b) Replace `sprintFromPath`-derived `record.sprint` with `readScalar(map.get("sprint"))`; keep `sprintFromPath` only as a fallback for any stray file. (c) `generateBacklogIndex`: filter `r.fields.sprint === "Backlog"` instead of `r.sprint === "backlog"`. (d) `generateWontFixIndex`: already filters on `status === "wont-fix"` (L591) — keep, drop the `r.sprint === "wont-fix"` half of the OR. (e) `sprintNum`: parse from `fields.sprint` (`Backlog`→null, `0`→0, else int). (f) Index links: indexes now live at `plan/issues/<id>-<slug>.md`; `basename(rec.file)` still resolves because indexes also live in `plan/issues/` — verify `backlog/index.md` and `wont-fix/index.md` output paths (they currently live under those dirs; either keep stub dirs holding only `index.md`, or relocate indexes to `plan/issues/backlog-index.md` / `wont-fix-index.md` and update links). **Recommended: keep `plan/issues/backlog/index.md` and `plan/issues/wont-fix/index.md` as index-only dirs**, and emit links as `../<id>-<slug>.md`. |
| 2 | `scripts/sync-sprint-issue-tables.mjs` | Already `fm.sprint \|\| sprintFromPath(file)` (L141). `isIssueFileName` (L50) accepts `<N>[a-z]?(-slug)?.md`. Walks `ISSUE_ROOT` recursively. | **No logic change needed** once frontmatter is complete. Optionally drop the `sprintFromPath` fallback after migration to force frontmatter-only. Verify `walkFiles(ISSUE_ROOT)` still finds the now-flat files (it recurses, so yes). |
| 3 | `scripts/check-sprint-closed.mjs` | Reads only `plan/issues/sprints/<N>/sprint.md` (L20). | **No change** — `sprint.md` files stay in `sprints/<N>/`. |
| 4 | `dashboard/build-data.js` | `sprint: fm.sprint \|\| sprintFromDir` (L167); `extractSprintNumberFromLabel(issue.sprint)` (L220); dedup by id with status priority (L119+); `sprint.md` discovery via `basename(dirname(file))` (L261). | (a) Frontmatter-first already holds; once complete, the `sprintFromDir` fallback is dead — keep or drop. (b) Ensure `extractSprintNumberFromLabel` maps `"Backlog"`→non-finite (so backlog issues are excluded from per-sprint boards) and `"0"`→0. (c) `sprint.md` discovery at L261 still works (unchanged dir). (d) Verify the recursive `walk` (L60) over flat `plan/issues/` doesn't pick `index.md`/`SCHEMA.md`/`backlog.md` as issues — guard with the `isIssueFileName` regex. |
| 5 | `scripts/statusline-sprint.mjs` | JSON fast-path from `dashboard/data/sprints.json`; **dir-scanning fallback** `currentSprint()` (L33–44) and `sprintProgress()` (L46–55) read `sprints/<N>/*.md`. | Fast-path is unaffected (sprints.json comes from build-data). The dir fallback breaks under flatten. **Change the fallback** to: scan flat `plan/issues/*.md`, read `sprint:` + `status:` frontmatter, group by sprint number, pick max numbered sprint with non-done issues. Keep `sprints/<N>/sprint.md` only for sprint discovery if needed. |
| 6 | `scripts/sync-goal-issue-tables.mjs` | `sprint: String(fm.sprint \|\| sprintFromPath(file))` (L127); `sprintFromPath` returns `"Backlog"` for backlog (L107). Recursive `readdirSync` (L50). | **No logic change** once frontmatter complete; column displays `fm.sprint` directly. Optionally drop fallback. |
| 7 | `plan/generate-graph.ts` | `sprint = String(fm.sprint \|\| sprintFromPath(file) \|\| "")` (L254); `sprintFromPath` (L236). Recursive `fs.readdirSync` (L115). | **No logic change** once frontmatter complete. Optionally drop fallback. Verify node-status mapping (L221: empty→`backlog`) still right when `sprint: Backlog` present. |
| 8 | `scripts/backfill-issue-sprint-frontmatter.mjs` | Only walks `sprints/<N>/` (L25–28), injects `sprint: <N>` if absent. Does NOT handle backlog/wont-fix. | **Extend** to also walk `backlog/` (→ `sprint: Backlog`) and `wont-fix/` (→ `sprint: Backlog` + ensure `status: wont-fix`). This is the migration's step-1 backfill driver. After migration it becomes a one-shot historical script (flat layout has no per-sprint dirs to scan) — repurpose or retire it; document in its header. |
| 9 | `.github/workflows/ci.yml` | L93–100 runs `pnpm run build:planning-artifacts` on push. L102–121 auto-commit step is **commented out** and references `plan/issues/sprints` in a `git add -f` (L114, L117). | (a) The active step (build:planning-artifacts) needs no change — it just runs the scripts above. (b) Update the commented-out `git add -f` path list (L114/L117) from `plan/issues/sprints` to `plan/issues` so a future re-enable doesn't miss flat files. Cosmetic since it's disabled, but do it to avoid a latent bug. |
| 10 | `.github/workflows/test262-sharded.yml` | Only a **doc comment** at L632 referencing `plan/issues/backlog/1522-race-...md`. | Update the comment's path to the new flat path of #1522 after its Class-B renumber (it is a collision — pick the surviving id). Comment-only, no logic. |

Tools confirmed **NOT** affected: `scripts/build-pages.js` (only a doc-comment
mention of an issue path, L354), `scripts/sprint-stats.ts` (tag-driven, no issue
paths), `scripts/build-planning-artifacts.mjs` (pure orchestrator, calls the
above), `scripts/run-pages-build.mjs` (orchestrator).

---

## Migration mechanics

One PR, one senior dev, executed as four ordered, individually-reviewable
commits so `main` is never in a broken intermediate state (the tooling rewrite
and the moves land together).

### Commit 1 — Resolve the 33 duplicate IDs (manual, reviewed)
- Class A (stale dupes): `git rm` the stale copy. ~6 files.
- Class B (collisions): `git mv` the lower-priority file to a fresh id ≥ 1617,
  add `renumbered_from: <old>` to its frontmatter, and rewrite all in-repo links
  to the old id+slug. ~27 numbers, ~27 renames + the 1334–1353 batch.
- Gate: `node scripts/update-issues.mjs --check` reports **0 DUPLICATE IDs**.

### Commit 2 — Backfill `sprint:` frontmatter (scripted, idempotent)
- Extend `scripts/backfill-issue-sprint-frontmatter.mjs` per row 8 to cover
  backlog/wont-fix, run it. 159 files gain a `sprint:` line.
- Gate: every numbered issue file has a `sprint:` line (re-run the coverage
  probe: `with_sprint_fm == total`).

### Commit 3 — Tooling rewrite (rows 1, 5, 8; touch-ups 9, 10)
- The critical one: remove `sprint` from `update-issues.mjs` `DROPPED_KEYS`,
  add to `ORDERED_KEYS`, switch sprint derivation to frontmatter, fix backlog
  index filter to `sprint === "Backlog"`. Rewrite `statusline-sprint.mjs`
  fallback. Rows 2/4/6/7 need no change (frontmatter-first already).
- Gate: `pnpm run build:planning-artifacts` produces identical sprint/goal
  tables and dashboard data **before** the move (run it on the
  still-nested-but-backfilled tree to prove the tools read frontmatter, not
  path).

### Commit 4 — The flatten (scripted `git mv` + link rewrite)
- An idempotent Node script (`scripts/flatten-issues.mjs`, new) that:
  1. Walks `plan/issues/{sprints/*,backlog,wont-fix}/` for issue files
     (regex `^[0-9]+[a-z]?(-.+)?\.md$`, excluding `sprint.md`, `index.md`,
     `backlog.md`, `SCHEMA.md`, audit files — reuse the `NON_ISSUE_BASENAMES`
     set from `update-issues.mjs`).
  2. For each, computes target `plan/issues/<id>-<slug>.md`. If the source is
     number-only, derive a slug from the title. Runs `git mv` (via
     `execFileSync("git", ["mv", src, dst])`) so history follows.
  3. Builds a `Map<oldRelPath, newRelPath>` and rewrites links in all tracked
     `*.md` (excluding `test262/`) using a single regex map. The link forms to
     cover (confirmed by sampling):
     - repo-absolute: `plan/issues/(sprints/[0-9]+|backlog|wont-fix)/<id>...md`
     - no-prefix: `issues/(sprints/[0-9]+|backlog|wont-fix)/<id>...md`
     - relative: `(\.\./)+(sprints/[0-9]+/|backlog/|wont-fix/)?<id>...md`
     New target is uniformly `plan/issues/<id>-<slug>.md` (absolute) or the
     correct relative form per source file depth.
  4. Removes now-empty `sprints/<N>/` issue files but **keeps `sprint.md`** in
     each `sprints/<N>/`. Keeps `backlog/index.md` and `wont-fix/index.md` as
     index-only dirs (per row 1 recommendation).
- Idempotent: re-running finds nothing to move (all files already flat) and the
  link regex is a no-op on already-rewritten links.
- Gate: `node scripts/update-issues.mjs --check` → 0 dupes, 0 id-mismatches, 0
  dangling deps; intra-repo broken-link check passes.

### Manual / external updates (cannot be scripted)
- **GitHub issue bodies** that link issue paths — at least **#389** (links the
  old `sprints/52/1521` path). Enumerate via
  `gh search issues --repo loopdive/js2wasm 'plan/issues/sprints'` and
  `... 'plan/issues/backlog'`; edit each body to the new flat path. List them in
  the PR description; they are out of CI's reach.
- **CLAUDE.md** — 1 issue-path reference; the `Project Structure` /
  `Issues:` section describes `sprints/{N}/` and `backlog/` as the layout.
  Update the prose to describe the flat layout + frontmatter-only sprint
  membership, and point at `SCHEMA.md`.
- **`SCHEMA.md`** — update "Current layout" (L17–22) to the flat scheme; it
  already says status/sprint are frontmatter-only, so the conceptual model is
  unchanged.
- **`.claude/agents/*.md`, `.claude/skills/*.md`** — grep for `sprints/{N}/`,
  `backlog/`, `wont-fix/` path instructions (e.g. developer.md, architect.md,
  create-issue skill, sprint-wrap-up skill) and update to the flat path +
  "set `sprint:` frontmatter" guidance. These are tracked under `.claude/` (48
  spec-compliance + agent/skill files) — include in the link-rewrite pass where
  they contain literal issue links, and hand-edit the path *instructions*.

---

## Validation plan (all must pass before merge)

Run in the PR worktree after Commit 4:

1. `node scripts/update-issues.mjs --check` → **0** DUPLICATE IDs, **0**
   FILENAME/FRONTMATTER ID MISMATCH, **0** DANGLING depends_on.
2. `pnpm run build:planning-artifacts` → no errors; `git diff` on generated
   tables (`sprint.md` issue tables, goal tables, `dashboard/data*`,
   `plan/log/sprints/index.md`, `plan/issues/backlog/index.md`,
   `plan/issues/wont-fix/index.md`) shows only link-path churn, not membership
   changes (same issues in same sprints).
3. `pnpm run build:pages` → sprint-stats + editions generate without error.
4. `node scripts/statusline-sprint.mjs` → emits the same `sN done/total` as
   before the migration (compare against a pre-migration capture).
5. **Intra-repo broken-link check** (new lint, Decision 1): every
   `plan/issues/<id>-<slug>.md` link in tracked `*.md` resolves to an existing
   file. Zero broken.
6. Coverage probe: every numbered issue file has a `sprint:` line.
7. `git log --follow plan/issues/<id>-<slug>.md` on a spot-check of 5 moved
   files shows continuous history (proves `git mv`, not delete+add).
8. CI green: `quality` (ci.yml), `cheap gate` + `merge shard reports`
   (test262-sharded.yml). No source under `src/` changes, so test262 conformance
   is untouched — a green `quality` job is the real gate here.

---

## Risk + rollback

- **Huge but mechanical diff**: ~1,559 `git mv`s + ~137 link-file rewrites in
  one PR. Reviewability: the four-commit split lets the reviewer focus on
  Commit 1 (the 33 judgment calls) and Commit 3 (the ~3 real tooling edits);
  Commits 2 and 4 are scripted and verifiable by re-running the scripts. Ask
  the reviewer to review **the scripts**, not every renamed file.
- **`git mv` preserves history** — `--follow` works; rollback is `git revert`
  of the merge (the renames revert cleanly because they're pure moves).
- **Highest risk: the 33 dup resolution (Commit 1)** — wrong renumber choice
  loses an issue's identity. Mitigate: `renumbered_from:` on every Class-B
  rename so the old number stays discoverable; list all 33 decisions in the PR
  body for explicit sign-off.
- **Link-rewrite false negatives**: the broken-link lint (validation step 5)
  catches any link the regex map missed. Gate the PR on it.
- **External GitHub bodies** can't be auto-fixed and aren't gated by CI — they
  are listed for manual edit; a stale external link after migration is the one
  residual the migration cannot fully close, but it is a one-time cleanup and
  thereafter links are stable forever.

## Recommended execution

One senior dev (Opus), one PR, four ordered commits as above. Tooling rewrite +
moves land **together** so `main` never sees a broken intermediate state. Do
**not** split the tooling and the move into separate PRs — between them, `main`
would have flat files but path-reading tools (or vice versa), breaking the
dashboard build on every push.

## Acceptance criteria

- [ ] All issue files live at `plan/issues/<id>-<slug>.md` (flat); no numbered
      issue files remain under `sprints/<N>/`, `backlog/`, `wont-fix/`.
- [ ] `sprint.md` files remain under `sprints/<N>/`.
- [ ] Every issue has an accurate `sprint:` frontmatter (number / `0` /
      `Backlog`); `update-issues.mjs` no longer strips it.
- [ ] 0 duplicate IDs, 0 filename/frontmatter mismatches.
- [ ] All 10 tools/workflows updated or confirmed-unaffected per the table.
- [ ] Validation plan steps 1–8 all pass; CI green.
- [ ] Rename-safety lint in place (broken-link check wired into `quality`).

## 2026-08-31 — reopened: canonical-set and flatten acceptance remain unmet

The migration mostly landed, but a current-source audit found concrete
residuals against the unchecked acceptance list above:

1. Three numbered issue files remain nested under `plan/issues/backlog/`:
   #1446, #1447, and #1449. No flat counterparts exist.
2. The generated backlog index links them as `../<basename>`, which resolves to
   nonexistent flat paths.
3. Tool populations disagree: `check-issue-ids.mjs` scans **4,259** flat IDs,
   while committed integrity and `update-issues` see **4,260** canonical issue
   records recursively.
4. `website/dashboard/build-data.js:53-55,136-146` accepts any digit-prefixed
   Markdown basename instead of the canonical predicate. A fresh build admits
   three planning/non-issue documents as ready issues: `sprints/0.md`,
   `sprints/73-plan.md`, and `1578-test262-analysis.md`. It produces **4,263**
   dashboard entries for **4,260** canonical issues.

Move the three legacy records to flat paths, then share one canonical issue
predicate (or require valid, matching `id:` frontmatter) across integrity,
index, and dashboard tooling. #5234 separately owns the freshness/ownership of
the tracked dashboard snapshots; this issue owns which files count as issues.

### Reopened acceptance criteria

- [ ] Zero numbered issue records remain below backlog/wont-fix/sprint
      subdirectories.
- [ ] Every generated issue link resolves to a canonical flat record.
- [ ] Workspace, committed-integrity, update, and dashboard scanners return the
      same identity set and count.
- [ ] `sprints/0.md`, `sprints/73-plan.md`, and
      `1578-test262-analysis.md` are negative regression fixtures, not cards.
