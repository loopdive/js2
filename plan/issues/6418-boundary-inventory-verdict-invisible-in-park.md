---
id: 6418
title: "An auto-park citing the #3518 boundary-inventory gate shows no reason in the job log — the step redirects its verdict into the artifact, so the shepherd sees only `exit code 1`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infra
area: ci
goal: correctness
---

## Problem

`quality`'s compiler-boundary step runs:

```bash
node --max-old-space-size=2048 scripts/check-compiler-boundaries.mjs \
  --mode inventory --base HEAD^1 > compiler-boundaries-report.json
```

The `>` sends the **entire verdict** — `status`, and the `errors[]` array that
names the offending files — into the artifact. When the gate fails, the job log
contains exactly one line about it:

```
##[error]Process completed with exit code 1.
```

So an `auto-park-bot:merge-group-failure` comment that cites this step gives the
shepherd a failing step name and nothing else. The auto-park comment's own
footer asks the reader to "confirm against the run before removing `hold`" —
which is impossible from the run alone. Recovering the reason needs the
artifact downloaded and unzipped, or the gate re-run locally against the right
base.

Measured on PR #5683 (park run `34674500787`, job `103501812033`): the log
showed only the exit code; running the gate locally produced the real verdict in
one shot:

```json
"status": "invalid-inventory",
"errors": [
  { "code": "unclassified-module", "detail": "src/codegen/statements/eager-capture-box.ts" },
  { "code": "unclassified-target", "detail": "src/codegen/statements/eager-capture-box.ts" }   // x5
]
```

The whole failure was one missing classification row for one new module — a
two-minute fix behind a diagnosis that cost far more than the fix.

### Why it matters beyond one PR

This is the failure family the repo already names in `pre-commit-checklist.md`
("never pipe a gate whose status you need") in its other form: **a gate whose
verdict nobody can read is operationally the same as a gate that did not run.**
Here the status *is* propagated correctly (exit 1 is honest) — it is the
*reason* that is unreadable, which is worse in one specific way: the park looks
indistinguishable from the known main-side drift parks (Temporal,
`runtimeTsLines`) that a shepherd is explicitly allowed to unhold with a
comment. A shepherd pattern-matching on "quality failed, probably group
composition" would remove this `hold` without fixing anything, and the PR would
re-park on the next pass.

## Acceptance criteria

1. The boundary-inventory step's failure reason is visible in the job log —
   e.g. `tee` the report instead of redirecting, or print `status` plus the
   `errors[]` entries to stderr on a non-zero exit. The artifact upload keeps
   working unchanged.
2. A deliberately unclassified module produces a job log that names the file
   and the error codes.
3. Audit the other `quality` steps for the same shape (`> file.json` with no
   console verdict) and give each one a log-visible failure reason.
