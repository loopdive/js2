---
id: 4053
title: "`scripts/equivalence-baseline.json` is stale and produces bidirectional false verdicts — needs a `--update` ratchet"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `scripts/equivalence-baseline.json` is stale and produces bidirectional false verdicts — needs a `--update` ratchet

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Found 2026-07-26 by `opus-loop-d`, A/B-confirmed. Distinct from #3648 — different mechanism, same symptom class.**

## The defect

`scripts/equivalence-gate.mjs` reads a **committed, static** `scripts/equivalence-baseline.json`. There is no inline clone and no moving reference, so it **cannot** race the way the test262 gate does (#3648). The mechanism is plain **staleness**: the baseline was last ratcheted **2026-07-10 — 16 days and ~92 commits ago**.

## Why it matters: it fails in BOTH directions

On PR #3660 the gate reported **3 new regressions** *and simultaneously* claimed **1 baseline failure now passes** (`math-pow`) — a test the PR could not plausibly touch.

**That bidirectionality is the diagnostic.** A real regression set from a change is one-directional. A stale reference moves things **both** ways, so an unrelated *improvement* appearing alongside regressions is the signature of a bad baseline rather than a bad change.

**A/B confirmed** — scoped local-vs-local on the same tree, same moment, only the change differing:
- merge base: **45 passed / 1 failed**
- with the fix: **45 passed / 1 failed** — identical

So all 3 "regressions" were drift. The dev nearly spent a cycle fixing a change that had no effect on them.

## Cost

Every PR touching this surface pays the same diagnosis, and the failure mode is **actively misleading**: it names specific test files, which reads as a real finding. loop-d ran a full (mis-scoped) suite and burned significant time before the scoped A/B settled it.

## Fix

Add a **`--update` ratchet** so the baseline refreshes on merge rather than decaying, mirroring how the other ratchets bank improvements automatically. Consider also emitting a **staleness warning** when the baseline is more than N commits behind — per the #3648 lesson, *print the provenance*: which baseline, from when, how far behind.

## Related
- **#3648** — the test262 gate clones its baseline **inline at step time**, so verdicts are not reproducible and depend on wall-clock position. Different mechanism (moving vs stale), same symptom class: **a gate whose reference is not pinned or not fresh produces confident, wrong verdicts.**
- Both belong to the session's dominant pattern: *a proxy returning a plausible number for a question it is not answering.*
