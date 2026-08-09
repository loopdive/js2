---
id: 3645
title: "Regression test: an allowance must be readable everywhere it is enforced (trap-growth-allow in the baseline writers)"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: s
feasibility: easy
task_type: ci
area: ci
es_edition: multi
goal: release-pipeline
related: [3644, 3596, 3370, 3335, 3189, 3303]
origin: "Split out of #3644. Deliberately NOT landed with the fix: a file under tests/ pulls the change-set into the &test262-paths shard matrix, which would have blocked the very PR that unblocks the queue."
---

# #3645 — regression test for #3644

## Why this is a separate issue

#3644 fixed a P0 outage: a `trap-growth-allow` that was honoured on the PR and
then **unreadable** in the post-merge baseline writers, which wedged promotion
permanently and stopped the queue. The fix had to land while the queue was
wedged, and **any file under `tests/` is on `&test262-paths`** — adding the test
in the same PR would have pulled it into the shard matrix, where it would have
hit the very trap it fixes and been auto-parked. So the test waits until the
queue moves. Not an oversight; see #3644's PR body.

## What to assert

The property, stated once so it generalises beyond this one gate:

> **An allowance must be readable in every context where it is enforced.**
> A declaration landing on `main` must not fail (i) the next baseline promote,
> or (ii) an unrelated PR's `merge_group`.

Concretely, in `tests/issue-3303.test.ts` (which already covers this family) or a
new `tests/issue-3644-*.test.ts`:

1. **The contract selector** — `baselineTrapAllowanceContract` (exported from
   `scripts/check-baseline-trap-growth.ts`) returns:
   - `named-verified` when `tests:` is present, **regardless of** `forwardOracleBump`;
   - `bare-oracle-bump` for a bare count **with** a bump;
   - `inert` for a bare count **without** one.
2. **End-to-end through the CLI**, driven by the `TRAP_GROWTH_ALLOW_FILE` hook so
   it is hermetic (the ambient repo diff must not be able to leak an allowance
   in). Fixtures mirroring the real #3629 row — baseline `status: fail`,
   `error_category: type_error`, `oracle_version: 11` on **both** sides, i.e. no
   oracle bump — and these four cases with their **real** exit codes:

   | case | expect |
   | --- | --- |
   | no declaration | exit 1 (strict ratchet intact) |
   | named declaration, same oracle | **exit 0** — this is the #3644 regression |
   | bare `count:`, no oracle bump | exit 1 (inert; #3370 unchanged) |
   | declaration naming a **passing** test | exit 1 (not an escape hatch) |

   `.tmp/repro/run.sh` on the #3644 branch is a working prototype of exactly
   this; lift it.
3. **The workflow invariant** — extend the existing `fetch-depth: 2` assertion
   (`tests/issue-3303.test.ts:126`) to cover **`write-run-cache-bot`** as well as
   `promote-baseline`. That job is the queue-merge writer and is the one that
   actually wedged; its checkout depth is what makes `HEAD^1` — and therefore the
   whole change-scoped mechanism — resolvable there.

## Trap to avoid when writing it

The first #3644 harness reported `EXIT=0` for **every** case, including ones
labelled "must fail", because `${PIPESTATUS:-$?}` is a bashism: under `sh` after
a pipeline it yields `sed`'s status, not the script's. Capture to a file and read
`$?` directly. **A test asserting an exit code must be shown to produce a
non-zero one at least once**, or it is asserting nothing.

## Acceptance criteria

- [ ] All four CLI cases asserted on **real** exit codes, with the harness
      demonstrated to report a failure correctly.
- [ ] `baselineTrapAllowanceContract` unit-tested across the three arms.
- [ ] `fetch-depth: 2` asserted for `write-run-cache-bot`.
- [ ] Each assertion verified to fail against #3644's merge base.
