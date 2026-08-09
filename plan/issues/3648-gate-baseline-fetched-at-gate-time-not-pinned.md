---
id: 3648
title: "The regression gate clones the baseline AT GATE TIME, so two PRs in the same queue are judged against different baselines — pass/park becomes a race with the promote job"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci, merge-queue
es_edition: multi
goal: release-pipeline
related: [3644, 3467, 3468, 3611, 3303, 1956]
origin: "Found closing an 'unexplained green': PR #3637 passed the trap ratchet at 22:44 while #3627/#3636 failed it on the identical test minutes earlier. The difference was 64 seconds, not merit."
---

# #3648 — the gate's baseline is fetched at gate time, not pinned to the run

## The observation that exposed it

During the 2026-07-25 trap-ratchet wedge, three PRs met the *same* main-side
`illegal_cast 74 → 75` and got **different verdicts**:

| PR | outcome |
| --- | --- |
| #3627 (`+56 pass`, no compiled code) | **parked** |
| #3636 | **parked** |
| #3637 (`src/**`, full shard matrix) | **passed, merged** |

The natural reading — "#3637's change retired the trap" — is **wrong**. Measured
timeline from the run logs:

| time (UTC) | event |
| --- | --- |
| 22:32:31 | #3637's `merge_group` run starts; shards run against its merged state |
| **22:43:12** | an operator's re-run promotes the baseline `illegal_cast` 74 → **75** (`tolerance 1`, `BASELINE_TRAP_GROWTH_ALLOW`) |
| **22:44:16** | #3637's gate step **freshly clones** `js2wasm-baselines` — now at 75 |
| 22:44:21 | `Catastrophic guard: diff-test262 gate PASS (exit 0, authoritative — #3303): 3 raw wasm-change regressions` |

**#3637 passed by 64 seconds.** Its gate compared 75 against 75. Had the same
run reached that step a minute earlier it would have compared 75 against 74 and
parked exactly like the other two. Nothing about the change decided it.

## Root cause

The gate step clones the baseline **inline, at the moment the step runs**:

```sh
git clone --depth=1 --filter=blob:none --no-checkout \
  https://github.com/loopdive/js2wasm-baselines.git /tmp/cat-baselines \
  && git -C /tmp/cat-baselines sparse-checkout set --no-cone /test262-current.jsonl … \
  && git -C /tmp/cat-baselines checkout main
npx tsx scripts/diff-test262.ts /tmp/cat-baselines/test262-current.jsonl …
```

`checkout main` resolves to whatever the baselines repo holds **at that instant**.
The comparison is therefore against a **moving target**, while the candidate side
was measured minutes earlier. Two consequences:

1. **Verdicts are not reproducible.** Re-running a parked PR can flip it to
   green with no change to the PR, main, or the corpus — purely because a promote
   landed in between. Conversely a PR can park because a promote landed *after*
   its shards but *before* its gate, in the unfavourable direction.
2. **Queue-position bias.** Within one merge queue, entries whose gate step runs
   on either side of a promote are judged against different baselines. That
   breaks the assumption behind auto-park: that a `merge_group` failure is a
   property of the change.

This is adjacent to but distinct from #3467/#3468 (per-SHA baseline *reuse* for
the shard matrix) and #3611 (promote skipping on the reuse path). Those concern
which baseline gets **written**; this one concerns which baseline gets **read**,
and specifically that it is not pinned.

## The consequence, stated plainly

**A `merge_group` failure is no longer a property of the change.** It is a
property of the change **and the wall-clock position of the gate step relative to
the last promote.**

That is precisely the assumption `auto-park` is built on. If it does not hold:

- **a park is not evidence of a regression**, and
- **every park-triage rule inherits the uncertainty** — including the rule that a
  bot park-hold marks a real merged-baseline regression and must never be cleared
  without diagnosing the cited run. That rule is still right in *direction*, but
  "the cited run failed" no longer implies "the change caused it".

Concretely, from one evening: **some fraction of the parks were clock artifacts,
and at least one green certainly was** (#3637). Neither is distinguishable from
the genuine article in the logs as they stand — which is the whole problem.

## Why it stayed invisible

The failure is *silent and self-correcting in the favourable direction*: a PR
that passes because of a well-timed promote produces a green log with nothing
anomalous in it. Only the unfavourable direction is visible — as an auto-park
that then "mysteriously" clears on re-run, which reads as flake. There is no line
in the log recording **which baseline commit** the verdict was computed against.

## The recurring disease, and its one cure

This is the **fifth** instance in a single session of one failure shape: *the
benign-looking outcome is indistinguishable from the broken one, and no line
records which happened.*

| instance | benign reading | actual |
| --- | --- | --- |
| this issue | "gate passed" | gate compared against a different baseline |
| #3644 | "no allowance applied" | allowance never **read** vs read-and-rejected |
| `grep` on `diff-test262.ts` | "no matches" | binary-classified; needs `-a` |
| `${PIPESTATUS:-$?}` under `sh` | "EXIT=0, all cases pass" | reported `sed`'s status |
| `fetch-baseline-jsonl.mjs` without `--force` | "fetched" | silent no-op on a stale cache |

The cure has been identical every time: **print the provenance.** Not "did it
work" but *what did it use, where did that come from, and which arm ran.*

## Proposed fix (scope approved)

1. **Pin and record.** Resolve the baselines-repo commit **once per run** (at the
   probe/setup step that already exists for #3467/#3468), export it, and have
   every gate step check out **that SHA** rather than `main`. Any consumer that
   cannot be pinned should at minimum **log the resolved baseline commit +
   timestamp**, so a verdict can be reproduced and two runs can be compared.
2. **Make the provenance a required line.** `diff-test262.ts` should print the
   baseline commit it was handed. "Which baseline said this?" is currently
   unanswerable from the log alone — the same silent-empty class as #3644's
   "never read vs. read-and-rejected" ambiguity.
3. **Follow-on, not a blocker for (1)+(2):** `auto-park` should **re-verify
   against the pinned baseline** before labelling. A park computed against a
   since-superseded baseline is a false positive **by construction**.

**(2) ships even if (1) slips.** It is a one-line change that converts a silent
ambiguity into a readable fact and makes every future verdict auditable —
including retrospectively, once the line exists in enough runs to compare.

## Acceptance criteria

- [ ] Every gate step reads a baseline pinned for the run, not `checkout main`.
- [ ] The resolved baseline commit is logged by `diff-test262.ts` on every run.
- [ ] A test proves two gate invocations in one run cannot see different
      baselines.
- [ ] Recorded: a park is a property of the change, not of the clock.
