---
id: 6435
title: "The auto-park comment names the failed step but never quotes it — now that gates print a reason to the log, the park comment could carry the reason itself"
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

`scripts/auto-park-merge-group-failure.mjs` already does the hard part: it
fetches the failed jobs, walks their steps, and distinguishes an infra step from
a verdict step by name (`isInfraStep`, the #3597 step-awareness work). So at the
moment it writes the `auto-park-bot:merge-group-failure` comment it **knows
which step produced the verdict** — and it puts that step's *name* in the
comment and stops there.

The shepherd's working surface is the comment, not the run. The comment's own
footer asks the reader to "confirm against the run before removing `hold`",
which currently means: open the run, find the job, find the step, scroll. That
round trip is the entire diagnosis cost for a park whose reason is often one
line.

[#6418](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6418-boundary-inventory-verdict-invisible-in-park)
fixed the upstream half of this for the #3518 boundary gate: its reason now
reaches the job log on stderr instead of vanishing into an artifact. That makes
this follow-up newly worthwhile — **there is now a reason in the log worth
quoting.** Before #6418, quoting the boundary step's log would have reproduced
`exit code 1` and nothing else.

Audited while fixing #6418: no other required gate has the
`> file.json`-with-no-console-verdict shape (the two
`select-changed-issue-tests.mjs` redirects carry `::error::`/`::warning::`
handlers; the lint/format/typecheck lanes `cat` their logs). So the log tail is
a reliable place to find a reason across the gate inventory, not a lottery.

## Acceptance criteria

1. The auto-park comment quotes the tail of the failed verdict step's log
   (bounded — a few dozen lines, fenced, truncated with an explicit marker), in
   addition to the step name it already carries.
2. Quoting failures degrade gracefully: if the log cannot be fetched or the step
   cannot be located, the comment is still posted with the current content and
   says the log could not be read. A park must never be lost to a formatting
   problem.
3. The park decision itself is unchanged — this is presentation only. The
   existing `--self-check` logic cases and
   `tests/issue-3597-auto-park-step-aware.test.ts` keep passing untouched.
4. A test covers the truncation boundary and the fetch-failure fallback.
