# Sprint 78 retrospective

**Numbers, completed-issue list and action items live in
[`plan/issues/sprints/78.md`](../../issues/sprints/78.md)** — under the rolling
budget-window model (#2751) the freeze record written by `freeze-sprint.mjs`
*is* the retrospective of record. This file carries the one post-mortem too
long to sit inline there.

---

## Post-mortem — status fields nothing validates

### What happened

Wrapping the window turned up nine issues whose `status:` matched no value in
`plan/issues/SCHEMA.md`: five read `complete`, four read `in_progress` (a fifth,
#2929, made nine). Separately, every frozen window record since the rolling
model began — sprints 75, 76 and 77 — was reading as **not closed** on the
dashboard.

None of this was noticed because nothing reads these fields against a schema.

### Why `complete` was the dangerous one

The two malformed spellings are not equally harmless, and the difference is
worth internalising:

| token | who normalises it | consequence |
| --- | --- | --- |
| `in_progress` | `build-data.js:112` → `in-progress` | cosmetic; every consumer agrees it is not done |
| `complete` | **nobody** | `freeze-sprint.mjs` matches `status === "done"` *exactly*, so the issue rolls forward as unfinished work — every window, silently |

So five completed issues were on track to be re-counted as open work
indefinitely, while the statusline reported them in the denominator and not the
numerator (`cur 300 783`). The failure is invisible by construction: a
rolled-forward issue looks exactly like an issue that genuinely is not done.

### Why the dashboard bug survived three windows

`build-data.js` decides closedness in three tiers — an explicit
`status: closed`, an explicit active/planning status, and otherwise the fallback
`sprintNumber <= explicitlyClosedMax`. Sprint **74** was the last doc written
with frontmatter. When the rolling model took over, `freeze-sprint.mjs` began
emitting sprint docs with **no frontmatter at all**, so 75, 76 and 77 each fell
to the fallback and each compared against a threshold frozen at 74.

The active-sprint calculation still resolved correctly — the synthetic `current`
window takes the highest number — which is precisely why nobody caught it. The
bug only shows in the sprint *list*, where finished windows render as open.

Adding `status: closed` to the sprint 78 doc raises the threshold to 78 and
closes 75–77 along with it. The durable fix is for `freeze-sprint.mjs` to write
that frontmatter itself; until it does, the next window reintroduces the bug.

### The common root cause

All three defects are the same absence: **no gate reads issue or sprint
frontmatter against `SCHEMA.md`.** The repo already walks every issue file in CI
for `check:issue-ids:against-main`, so the marginal cost of also validating the
status enum is close to zero — and it would have caught all nine at PR time
instead of at freeze time, after the mislabelling had already been carried
across an unknown number of windows.

The schema itself needs a pass first: it lists `review`, while the lifecycle in
`CLAUDE.md` and 17 live issues use `in-review`, and the suspend workflow writes
`suspended`, which the schema does not mention. Gating on an enum that
disagrees with practice would just move the breakage.

### What was deliberately not done

#3764 was left at `complete` rather than promoted to `done`. Its own
verification suite fails on main — one failure environmental (uninitialised
test262 submodule), one real: the standalone-purity assertion
`expect(result.importObject).toEqual({})` receives `env` and a populated
`string_constants`. A status token is not evidence of completion, and four of
the five were promoted only because their named suites were run and passed.
