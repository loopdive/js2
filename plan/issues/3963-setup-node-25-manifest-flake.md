---
id: 3963
title: "CI: actions/setup-node@v6 intermittently fails to resolve Node 25 from the manifest — parks unrelated PRs and costs a diagnosis cycle each time"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: n/a
sprint: current
horizon: s
es_edition: n/a
related: [2547, 3597]
---

# #3963 — `setup-node@v6` Node-25 manifest flake parks unrelated PRs

## Status: open — observed twice in one session, on two different workflows

## Problem

`actions/setup-node@v6` intermittently fails to resolve **Node 25** from the
version manifest, and the direct-download fallback does not save it. The step
fails in ~1.6 seconds and the job dies before running anything:

```
Attempting to download 25...
Not found in manifest. Falling back to download directly from Node
##[end-action id=__self.__actions_setup-node;outcome=failure;conclusion=failure;duration_ms=1635]
```

Confirmed occurrences, 2026-07-31, both on PRs whose code was fine:

| PR | check | outcome |
| --- | --- | --- |
| #3917 | `cross-backend-parity` | re-run passed with **no code change** |
| #3914 | `test262 js-host shard 10/66` | **auto-parked** with a `hold` label |

## Why this is worse than an ordinary flake

**It parks PRs rather than merely failing them.** When it hits a test262 shard
in the `merge_group`, `auto-park` (#2547) correctly labels the PR `hold` and
comments — because from the bot's perspective a required check failed on the
merged state, which is exactly the signal it exists to catch.

Clearing that label is deliberately *not* automatic. Per the auto-park rules a
bot `hold` must never be removed without diagnosing the cited run, since it
normally marks a real merged-baseline regression. So every occurrence costs a
**human-grade diagnosis cycle**, and a wrongly-held PR **strands** until someone
does it — the auto-enqueue backstop skips held PRs.

Two knock-on effects seen today:

1. `merge shard reports` also failed, at *"Fail if required test262 shards did
   not succeed"* — downstream of the missing shard, not an independent
   regression. So one flake produces two red checks and looks worse than it is.
2. The shard's artifact upload warned `No files were found … mgchunk10.jsonl`,
   confirming no verdict of any kind was produced.

The auto-park comment's own footnote (#3597) anticipates this: *"If it is a
setup/infra step rather than a verdict step, the verdict never ran and this park
may be spurious — confirm against the run before removing `hold`."* That
footnote is what makes each incident resolvable — but it is a manual check.

## Fix options

1. **Pin a Node version that is reliably in the manifest.** Simplest and most
   likely correct. Node 25 is recent enough that manifest coverage appears
   inconsistent. Check whether the pin can be a full `25.x.y` rather than the
   bare major, which is what the failing invocations request.
2. **Retry the setup step.** `nick-fields/retry` or an equivalent around the
   `setup-node` action. Treats the symptom but is robust to the next version
   having the same problem.
3. **Both** — pin, and retry as a belt-and-braces.

Option 1 alone would probably have prevented both incidents today.

## Acceptance criteria

1. `setup-node` no longer fails on manifest resolution across a full CI run.
2. The chosen approach is applied to **every** workflow that sets up Node,
   not just the two observed — this hit `cross-backend-parity` and a test262
   shard, which are different workflows, so the exposure is repo-wide.
3. The issue records which workflows were changed.

## Worth considering alongside

Since a setup-step failure can never produce a verdict, `auto-park` could
plausibly **decline to park** when the failing step is a known
setup/infrastructure step rather than a verdict step — it already identifies
the failing step by name (#3597), which is the hard part. That would remove the
manual diagnosis cycle entirely for this class. Filed here as a suggestion, not
a requirement; the parking behaviour is deliberately conservative and changing
it deserves its own judgement.

## Provenance

Both incidents diagnosed during the #3898-#3908 performance-benchmark batch.
The #3914 park was cleared after confirming against the cited run that the
verdict never ran; the diagnosis is recorded in that PR's thread.
