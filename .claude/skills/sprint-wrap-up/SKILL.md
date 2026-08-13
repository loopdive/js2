---
name: sprint-wrap-up
description: End-of-sprint checklist — finalize results, clean up worktrees, update docs, prepare for retro. Any agent can run this.
---

# Sprint Wrap-Up

Run this when all sprint tasks are done or the sprint is being closed.

## Step 1: Verify all tasks are merged or closed

```bash
# Check TaskList for any in_progress or pending tasks
```

For each unmerged task: either have the dev self-merge via /test-and-merge, or document why it's deferred.

## Step 2: Clean up worktrees

```bash
ls /workspace/.claude/worktrees/
```

For each worktree:

- Check for uncommitted work: `git -C <wt> diff --stat`
- Check for unmerged commits: `git -C <wt> log --oneline main..HEAD`
- If all merged: `git worktree remove --force <wt>`
- If unmerged: document in the issue file as Suspended Work

Then prune dead agent-status heartbeats and resync the shared checkout:

```bash
node /workspace/scripts/prune-agent-status.mjs          # clears stale ✕ records
bash /workspace/scripts/sync-workspace-main.sh          # FF /workspace to origin/main
```

(`prune-agent-status` also runs automatically on every SessionStart; this is
the belt-and-suspenders end-of-sprint sweep.)

## Step 3: Clean up branches

```bash
git branch | grep -v '^\*'
```

Delete branches that are fully merged. Keep branches with unmerged work.

## Step 4: Verify test262 ran on the final state

Check that test262 has been run on the current main (either via CI sharded run
on the last merged PR, or a local run). Do NOT run locally unless CI didn't cover it.

```bash
# Check latest CI test262 run on main
gh run list --workflow=test262-sharded.yml --branch=main --limit 1
# Or check local results
node -e "const r=JSON.parse(require('fs').readFileSync('benchmarks/results/test262-current.json','utf8')); console.log(r.summary.pass, '/', r.summary.total)"
```

Record results in sprint doc.

## Step 5: Push sprint/N end tag

```bash
git tag sprint/N  # replace N with sprint number
git push origin sprint/N
```

> Sprint-end tags ONLY `sprint/N` — it does **not** tag a version. Never
> `git tag vX.Y.Z` at sprint end. Version tags are cut exclusively via
> `node scripts/release.mjs <x.y.z>` (the deliberate, reviewed release flow);
> see `docs/releasing.md` and loopdive/js2wasm#389.

Then set `end_tag_pushed: true` in the `wrap_checklist` in `plan/issues/sprints/{N}/sprint.md`.

## Step 6: Carry over unfinished issues to the next sprint

Any issue still open (status not `done`/`wont-fix`) when the sprint closes must
be moved forward, or the dashboard counts a closed sprint as incomplete and the
work falls off the radar:

```bash
# Bump every open issue tagged `sprint: N` to the next sprint (N+1)
for f in $(grep -rl '^sprint: N$' plan/issues/*.md); do
  grep -qE '^status:\s*(done|wont-fix)\b' "$f" || sed -i 's/^sprint: N$/sprint: M/' "$f"   # N=closing, M=next
done
node scripts/sync-sprint-issue-tables.mjs   # refresh the GENERATED_ISSUE_TABLES in every sprint doc
```

Add a `## Carry-over` section to the closing sprint doc listing the moved issue
numbers and the phrase "moved into [sprint-M.md]" (this sets the dashboard's
`explicitCarryOver` flag).

## Step 7: Update sprint doc + mark status closed

Sprint docs are **flat files** (#1616): `plan/issues/sprints/{N}.md` (NOT a
`{N}/sprint.md` directory). Edit `plan/issues/sprints/{N}.md`:

- Fill in final test262 numbers
- Calculate delta from baseline
- Note any deferred tasks
- Set `status: closed` (and `closed: <date>`)
- Set the **next** sprint's doc to `status: active` so it becomes the current
  sprint (the active sprint = highest sprintNumber with `!isClosed && !isPlanning`)
- Set `status_closed: true` in `wrap_checklist`

## Step 8: Regenerate + commit the dashboard data (REQUIRED — this is what the statusline reads)

Flipping `status:` in the doc is **not** enough. The statusline and dashboard
read the committed `website/dashboard/data/sprints.json`, which is a generated
artifact. If you skip this, a doc-closed/tagged sprint still shows as "active"
in the statusline (this is the bug that left s59 stuck after it was closed
2026-06-05):

```bash
node website/dashboard/build-data.js
git add website/dashboard/data/sprints.json
# Verify the active sprint advanced:
node scripts/statusline-sprint.mjs --porcelain   # should print "M <done> <total>"
```

`build-data.js` also rewrites `data.js` / `issues.json` / `feature-examples.json`.
Those are large and regenerated on every push to main by the deploy pipeline, so
when wrapping mid-flight (open PRs in the queue) commit **only `sprints.json`** to
avoid conflicts with in-flight issue-status changes; leave the siblings for the
deploy regen.

## Step 9: Spawn SM for retrospective

Spawn the scrum-master agent to write `plan/log/retrospectives/sprint-{N}.md`. The SM reads:

- `plan/issues/sprints/{N}.md` — results, deferred tasks
- `git log sprint-{N}/begin..sprint/{N}` — what landed
- Previous retro for format reference

The retrospective must exist before the sprint is considered closed. A "record sprint results" commit without a retro file is **not** a complete wrap-up.

After the retro file is written, set `retro_written: true` in `wrap_checklist`.

## Step 10: Update diary

Append entry to `plan/diary.md` with sprint summary (baseline, net tests, key wins, carry-overs).

After appending, set `diary_updated: true` in `wrap_checklist`.

## Step 11: Run test262 error harvest

Before closing the sprint, run the `harvest-errors` skill to cluster any new failure patterns that surfaced during the sprint and file issues for them. This keeps the next sprint's backlog populated with concrete, actionable work instead of requiring manual triage.

```
Invoke the harvest-errors skill (or spawn a dedicated harvester agent)
```

The harvester:

- Clusters failures in the baseline JSONL by normalized error pattern (run
  `node scripts/fetch-baseline-jsonl.mjs` first to populate
  `.test262-cache/test262-current.jsonl` — the file is no longer
  committed; see #1528)
- Cross-references with existing issues in `plan/issues/`
- Files new issue files in `plan/issues/` for unaddressed buckets above the threshold (default: >50 occurrences)
- Reports a summary table

Commit any newly-filed issues before Step 10.

**Why here and not at sprint kickoff:** after the sprint's merges have landed, the failure distribution has shifted — running harvest at wrap-up captures the _current_ gaps, not stale pre-sprint ones. The next sprint's planning session (PO) can then slice the fresh issue list by theme. See memory: `feedback_harvest_at_sprint_end.md`.

## Step 12: Update session memory

Update `/home/node/.claude/projects/-workspace/memory/project_next_session.md` with:

- Final git hash
- Test262 numbers
- What's still open
- Key learnings

## Step 13: Commit everything

Sprint docs are flat files (`{N}.md`), and the regenerated dashboard data must
ride along or the statusline won't update:

```bash
git add plan/issues/sprints/{N}.md plan/issues/sprints/{M}.md \
        website/dashboard/data/sprints.json \
        plan/diary.md plan/log/retrospectives/sprint-{N}.md
# Plus the carried issue files: git add plan/issues/<id>-*.md
git commit -m "chore(sprint-{N}): close sprint — carry-over to {M}, retro, diary, dashboard data. ✓"
```

## Step 14: Push

```bash
git push
```
