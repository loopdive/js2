---
id: 4068
title: "`regressions-allow` has two gaps in `changeSetNumericAllowances` — rebase-mode-only AND no `tests:` support"
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
# `regressions-allow` has two gaps in `changeSetNumericAllowances` — rebase-mode-only AND no `tests:` support

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Same family as #3644 (PR #3639) — the same defect wearing different clothes.** The generalisation is the durable deliverable: **an allowance must be readable in every context where it is enforced, and each enforcement point needs a test proving it reads one.**

## Gap 1 — mode-scoped (the original)

`regressions-allow` is honoured **only inside `evaluateRebaseGate` / `if (rebaseMode)`**, which requires an `ORACLE_VERSION` bump — so it is **inert on ordinary PRs**. Without the bump the allowance is **silently ignored** and #1897 fails forever. Precedent: v4/#3285; hit again in #3468 F1.

⚠️ **Citation corrected 2026-07-26:** the shape-driven `trap-growth-allow` fix to mirror landed as **#3596**, *not* #3599 — `#3599` on `main` is `fyi-source-executor-reuse` (renumbered in `d9f954138`). The mis-citation is itself an artifact of the id-collision churn that #3636 exists to stop. **Port the #3596 shape-driven contract.**

## Gap 2 — `tests:` is PARSED but IGNORED (refined 2026-07-26 by opus-loop-a)

**This is a policy change, not a parser change — much cheaper than first scoped.**

`changeSetNumericAllowances` **already calls** `parseFrontmatterCountReason`, so a `tests:` list on a `regressions-allow` declaration **is parsed today**. The **consumer in `diff-test262.ts` ignores it.** The parser's own doc says as much: *"requiring it is the caller's policy decision."*

So the work is: have the `regressions-allow` consumer **honour and verify** the parsed `tests:` — machine-checking each named test is non-passing on the baseline, exactly as the `trap-growth-allow` path does — rather than accepting a bare number with prose. That is the difference between *attributing* a change and *banking* it; the same distinction that made the blanket `BASELINE_TRAP_GROWTH_ALLOW=1` valve a blunt instrument during the 2026-07-25 outage.

**Do not touch the parse path** — see the live consumer below.

## Why both in one pass

Same reader, same file, same conceptual bug. Fixing only the mode-scoping leaves the allowance unverifiable; enforcing `tests:` alone leaves it unreadable outside rebase mode.

## Live consumer — coordinate before designing

`opus-loop-a` is declaring a **`regressions-allow: {count, reason}`** right now for the #3603 host de-inflation (task #10, stakeholder-approved), and is **depending on the existing parse path**. It found Gap 2 and messaged loop-b directly. **Do not break the bare `{count, reason}` form it is landing** — if `tests:` becomes *required* rather than *verified-when-present*, that PR breaks. Prefer: honour and verify `tests:` when present; keep bare `{count, reason}` valid, and consider requiring it only in a later ratchet step.

## Required, per #3644's pattern

- A regression test asserting the **general property** — an allowance is read in every context that enforces it — not two tests asserting instances. Repoint **#3645** at both fixes.
- **Confirm the allowance is actually READ**, not that CI went green. The reader's own line is the check — for this gate: `=== regressions-allow (#3303): excused N of M declared … ===`. A malformed or mode-excluded declaration is reported `invalid` and grants nothing, failing identically to a too-small ceiling.
- Let the **declaration's shape select the contract**, so enforcement points cannot drift.

## Do not put the regression test in the fix PR

Any file under `tests/` joins `&test262-paths` and pulls the PR into the full shard matrix. #3639 hit this; file the test separately and say so in the PR body.

## Related — read before designing

**#3648** (loop-b): the gate clones the baselines repo **inline at step time**, so verdicts are not reproducible and a park is not purely a property of the change. An allowance sized against an unrecorded baseline is unfalsifiable — these two fixes compose.

⚠️ **Denominator hazard when reading any of these numbers:** `benchmarks/results/test262-current.json` is **scoped** (`include_proposals: 0`, total 43,098) while `test262-current.jsonl` is the **unscoped** full corpus (47,852 entries). Mixing them silently produces a plausible, wrong delta — the lead did exactly that on 2026-07-26 (a bogus −410 that was really +126 like-for-like).
