---
id: 4050
title: "`check-verdict-oracle-bump.mjs` watches 5 files and misses `src/runtime.ts` / `src/runtime/**` — a runtime change can flip ~1,000 verdicts with no bump demanded"
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
# `check-verdict-oracle-bump.mjs` watches 5 files and misses `src/runtime.ts` / `src/runtime/**` — a runtime change can flip ~1,000 verdicts with no bump demanded

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Found 2026-07-26 by `opus-loop-a` while landing the #3603 de-inflation. Deliberately not filed by it (mid-measurement); evidence preserved here. Whoever picks this up files the issue (`claim-issue.mjs --allocate`, then hand-verify the id).**

## The existence proof — captured in-repo, no need to re-derive

Running the gate on PR #3635, a PR that flips **~1,000 verdicts**:

```
check-verdict-oracle-bump (#3003): diff vs origin/main; ORACLE_VERSION 11 → 12.
  ✓ no verdict-logic files changed.
```

The gate whose entire job is to demand a bump reports **nothing changed**. This output is recorded in #3635's history entry and issue file, so the tracker inherits the proof rather than reconstructing it.

## The gap

`scripts/check-verdict-oracle-bump.mjs` (watched-file list, ~lines 61–71) covers exactly five files:

```
PURE:  scripts/negative-verdict.mjs
MIXED: scripts/test262-worker.mjs, tests/test262-shared.ts,
       tests/test262-vitest.test.ts, tests/test262-runner.ts
```

**`src/runtime.ts` and `src/runtime/**` are absent** — and that is the layer #3635 changes.

## Why it is more than a missing entry — the silent five-step chain

1. Author writes a well-formed `regressions-allow: {count, reason}`.
2. No gate demands a bump, so none is made.
3. `rebaseMode` is false (`scripts/diff-test262.ts:1390`).
4. The allowance is read **only inside `if (rebaseMode)`** (~line 2344) — **parsed, valid, never consulted**.
5. The gate fails on regressions and the PR parks — **indistinguishable from "the ceiling is too small."**

The predictable response is to resize the ceiling, re-park, resize again, never touching the cause. The read-site comment states the intent plainly: *"a declared allowance grants nothing without the oracle bump that makes this a deliberate re-baseline."* **The intent is sound; the detector for when a bump is owed doesn't watch the layer that can owe one.**

Third distinct instance in one session of *never-read being indistinguishable from read-and-rejected* (with #3644 and #3648).

## Scope — keep SEPARATE from #3649 / TaskList #6

- **#3649 / task #6** — *which contexts read an allowance* (`change-scope.mjs` / `diff-test262.ts` consumer).
- **This** — *which file changes demand a bump* (`check-verdict-oracle-bump.mjs`).

Different gates, owners and tests. loop-a and the lead both concluded it stands alone.

## What to do

- Extend the watched set to every layer that can alter verdicts — at minimum `src/runtime.ts` and `src/runtime/**`. **Derive the list from what *can* change a verdict, not from what historically has**, or this recurs with the next layer.
- **Consider inverting the design**: instead of an allow-list of watched files, flag any change whose *measured verdict delta* exceeds a threshold without a bump. The current list is a denylist-shaped solution to an open-ended problem — the recurrence is structural, not an oversight.
- Add a test asserting a runtime-layer verdict change demands a bump.
- **Make the refusal legible**: when a gate refuses and no allowance was consulted, print **"no allowance was read (rebase mode inactive)"** rather than only the count. That one line collapses the five-step chain into a readable fact — the same fix #3644 and #3648 both converged on.

## Context

`tests/test262-oracle-version.ts` was at **11**; the lead sanctioned **11 → 12** for #3635's landing kit (verdict-altering change; #3468 F1 precedent), landed in `69493a7d9`. Project rule: `reference_verdict_logic_change_must_bump_oracle_version`.
