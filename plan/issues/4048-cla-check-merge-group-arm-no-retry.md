---
id: 4048
title: "`cla-check` merge_group arm has no retry — a transient `gh api POST .../statuses/` failure ejects the PR on a non-verdict step"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `cla-check` merge_group arm has no retry — a transient `gh api POST .../statuses/` failure ejects the PR on a non-verdict step

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

⚠️ PREMISE CORRECTED 2026-07-28 — I originally reasoned "it failed twice identically, therefore reproducible, not flake." The fuller timeline shows it is **intermittent**: it failed a THIRD time (ejection at 14:15:52Z after the cron re-added at 14:07:02Z) and then **succeeded on the next attempt**, merging at 14:28:38Z. So ~3 failures then a pass. My "twice = deterministic" inference was reasonable on the data I had and wrong on the full record.

That correction matters for the fix: this is a **retry-able transient**, so retry-with-backoff is the right remedy — where a deterministic failure would have needed a redesign.

**The failure.** `.github/workflows/cla-check.yml`, step "Non-PR event — post passing cla-check status (CLA enforced at PR time)":

```bash
gh api --method POST "repos/${{ github.repository }}/statuses/${{ github.sha }}" \
  -f state=success -f context=cla-check \
  -f "description=..." -f "target_url=..."
```

Died with `unexpected end of JSON input`, exit 1, on merge_group runs `30363639349` (13:28Z) and `30364156989` (13:35Z), plus at least one more around 14:15Z. Each time **every verdict workflow passed** (CI, Test262 Sharded, Differential). The only failure was this status POST — pure plumbing that exists solely to satisfy the required `cla-check` context on the merge-group commit, since the real CLA evaluation is deliberately skipped for non-PR events.

**Impact:** a transient API blip on a **zero-content-signal** step ejects an otherwise fully-green PR from the queue, costing a full merge-group cycle each time. #3729 burned three cycles and ~53 minutes on it.

**Fix:** retry with backoff around the POST; and/or `|| true` followed by explicit verification that the `cla-check` status is present on the SHA, failing only if verification fails. Consider whether `gh api` is mis-handling a 2xx-with-empty-body. Add a positive control that forces one POST failure and proves the retry recovers.

**Do NOT weaken the real CLA gate** — this is only the non-PR passthrough arm. CLA acceptance for external contributors is enforced at `pull_request_target` time and must stay strict.
