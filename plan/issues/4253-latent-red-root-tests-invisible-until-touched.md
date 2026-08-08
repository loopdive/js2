---
id: 4253
title: "Latent-red root test files stay invisible until someone edits them (#3008 gate is change-scoped)"
status: ready
created: 2026-08-08
priority: medium
horizon: m
feasibility: medium
task_type: ci
area: ci
goal: release-pipeline
related: [3008, 3617, 3683, 3685, 4155, 743]
---

## Problem

**PR CI never runs the root `tests/*.test.ts` population.** The `#3008` gate
(`scripts/hooks/changed-root-tests.sh`, in `quality`) runs only root test files
the branch **added or modified** — deliberately, because the full population is
2,646 files and far too slow per commit. Nothing else in PR CI covers the rest:
`equivalence-shard`, `linear-tests`, `smoke` and `semantic-sanitizers` each run
their own scoped selections.

The consequence is a ratchet with a hole in it: a root test can go red from
ordinary main-side drift and **stay red indefinitely**, because the only thing
that would run it is a PR that happens to touch that exact file. It then
ambushes the next unrelated PR that edits it — which now must fix a
pre-existing failure it did not cause, or drop its own change to that file.

This is not hypothetical. It happened twice within one PR (#4255):

| file | assertion | why it drifted |
| --- | --- | --- |
| `tests/issue-3683-numeric-fields.test.ts` | `fieldType(wat,"A","$has_maybe") === "i32"` → `undefined` | presence tracking moved from one boolean companion per field (`$$has_<f>`) to a **packed word** (`$$presence_0`); the assertion had been reading `undefined` ever since |
| `tests/issue-3683-numeric-fields.test.ts` | reflection bitmask `=== 3` → `11` | `Object.keys` over a standalone fnctor instance started working (arm `8`); the hard-coded total was never updated |

Both were fixed in #4255 only because that PR had to touch the file for an
unrelated reason.

## Two more, still red on `main` right now

Found by a targeted sweep of the 19 root test files that assert on
`__fnctor_` struct shapes. Both reproduce with **identical assertion values** on
pristine `upstream/main` @ `d0019f86e`, so neither is caused by any in-flight
work:

- `tests/issue-3685-presence-tracked-proven-reads.test.ts` —
  *"takes the proven-receiver inline path, not the dynamic `__extern_get` arm"*
  → `expected false to be true`
- `tests/issue-3617.test.ts` —
  *"keeps constructor off the instance's enumerable own keys"*
  → `expected +0 to be 1`

These are left unfixed deliberately: each is an unrelated behavioural question
(has the proven-receiver inline path stopped firing? is `$$constructor` now
enumerable?), and fixing them inside an unrelated PR would pull them into that
PR's `#3008` gate and hide the diagnosis. **Each needs its own look — the
assertion may be stale like the two above, or it may be a real regression.**
Do not assume stale; the `#3617` one in particular reads like a real
enumerability change.

## What to do

Two independent pieces of work; the second is the point of this issue.

1. **Triage the two red files above** — decide stale-assertion vs real
   regression for each, and fix accordingly.
2. **Close the visibility hole.** The gate does not need to become
   run-everything-per-PR; it needs the population to be swept *somewhere* on a
   cadence, with the result visible. Options, cheapest first:
   - a **post-merge / nightly** job that runs the full root population (sharded,
     like the equivalence lanes) and opens or updates a single tracking issue
     listing every red file. Latency of a day is fine — the current latency is
     unbounded.
   - a **ratchet file** (`scripts/root-tests-known-red.json`) listing the
     currently-red files with a reason. The nightly fails only on files that
     went red and are NOT in the list, and a PR that touches a listed file must
     remove it from the list. That converts "invisible" into "counted", which is
     the property the repo already relies on for the IR fallback budget and the
     trap-growth gate.

## Acceptance criteria

- [ ] The two files named above are triaged and either fixed or recorded with a
      reason.
- [ ] The full root `tests/*.test.ts` population is executed on some cadence
      that does not depend on a PR touching each file.
- [ ] A file that goes red is *discoverable without editing it* — a list, an
      issue, or a failing scheduled job.
- [ ] The change-scoped `#3008` gate stays as-is for per-PR latency; this issue
      adds coverage, it does not replace that gate.

## Notes

- Sizing measured 2026-08-08: `ls tests/*.test.ts` = **2,729**; after the gate's
  own exclusions (`linear-`, `c-abi.`, `simd`, `test262-chunk|vitest`) =
  **2,646**.
- The 19-file `__fnctor_`-asserting subset took roughly 2 minutes to run in two
  batches, so a full sharded sweep is plausibly tens of minutes — nightly-sized,
  not per-PR-sized.
- Related lesson already in the repo's memory: *a detector must be able to say
  "I don't know"*. A change-scoped gate answers "nothing wrong" for every file
  it did not look at, which is indistinguishable from "no failures".
