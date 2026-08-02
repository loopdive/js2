---
id: 4049
title: "Cross-environment parser discipline — test any string-parsing verifier against every producer's grammar"
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
# Cross-environment parser discipline — test any string-parsing verifier against every producer's grammar

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

SCOPE CORRECTED 2026-07-25. An earlier version of this task claimed CI trap-frame verification had "silently returned 0 for every row, always" and called for a historical audit of decisions that leaned on it. **That was over-stated and the audit is VOID — do not perform it.**

VERIFIED (with a positive control, since plain grep false-empties on this file — use `grep -a`):
- `git show upstream/main:scripts/diff-test262.ts | grep -ac "trapInnermostFrame"` → **0**
- `git log upstream/main -S "trapInnermostFrame" -- scripts/diff-test262.ts` → **empty**
- positive control `evaluateTrapCategoryGrowth` → 3 hits (so the search works on this file)

`trapInnermostFrame` **never existed on `main`**. It was introduced on the #3592 branch (`2033d7bc2`) and fixed on the same branch (`c584b37a3`), so the CI-grammar gap existed only within that window and affected exactly ONE decision — the #3601 parked run, which was caught and correctly resolved. No pre-existing gate, park, or excusal ever consumed it.

WHAT REMAINS (the real, narrower task):

1. **Rule for new verifiers:** any NEW cross-environment string-parsing verifier must be tested against EVERY producer's actual grammar before its output is treated as a measurement. The concrete instance: `test262-worker.mjs` `describeWasmError` renders frames as `[in name() ← …]` while the local runner emits ` in name() at source L…`. Already pinned for this parser via `CI_TRAP_MSG` cases in `tests/issue-3592-devacuification-allow.test.ts`.

2. **Prefer removing the divergence over teaching parsers more dialects.** Where diagnostics are consumed programmatically, carry a structured field rather than re-parsing a rendered string — every new renderer otherwise reintroduces the class.

3. **Vacuity guard (the highest-value item).** A verifier that returns "unverifiable"/zero for 100% of a NON-EMPTY input set should WARN loudly rather than return a silent zero. That property alone would have surfaced this in minutes instead of via two independent investigations.

THE DURABLE LESSON (three independent instances in one session, same shape — a tool returning a constant is indistinguishable from a tool returning a result, and all three failed silently toward the benign-looking answer):
- the frame parser: `0 verified` looked like a measurement, was a constant;
- `grep` on `scripts/diff-test262.ts`: silently binary-classified, empty output read as "symbol absent";
- a merge watcher: gh 2.23 lacks the `mergeQueueEntry` field, so every poll returned silently empty — a stalled watcher looked exactly like an empty queue.

Rule: **never accept an empty/zero result from a tool you have not seen produce a non-empty result in that same environment.** Run a positive control first.
