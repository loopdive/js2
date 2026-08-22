---
id: 4604
title: "npm-compat refresh runtime exceeds its 180-min timeout — dashboard stale since 2026-08-20 18:45Z"
status: in-progress
created: 2026-08-21
updated: 2026-08-21
assignee: loopdive/claude
priority: critical
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ci, npm-compat
goal: performance
sprint: current
horizon: s
related: [3988, 4585, 4586, 4602]
origin: "Check-in while verifying the acorn/clsx recovery (#4602): 39 consecutive npm-compat-refresh runs (683-721) have failed to publish; the last successful run is 682 (2026-08-20 18:45Z), which is exactly the snapshot still showing the pre-fix collapse on the website."
files:
  - .github/workflows/npm-compat-refresh.yml
---

# #4604 — npm-compat refresh runtime exceeds its timeout; dashboard stale >22h

## Problem

`benchmarks/results/npm-compat*.json` is only updated by `npm-compat-refresh.yml`
(measure on main → promotion PR). The last run that completed is **682**
(measuring `7b2a1f94`, finished 2026-08-20 18:45Z) — the snapshot that shows
the acorn/clsx standalone-dynamic collapse. Every one of the **39 runs since
(683–721)** died without publishing, so the website keeps serving the
regression even though the compiler fixes (#4578, #4586, #4602) are long
merged and verified.

Three failure phases:

1. **683–692:** hard failures — `React.captureOwnerStack is not a function`
   from the #4660 upstream React infra (fixed by #4683/#4685), plus two quick
   infra failures.
2. **693 onward:** the marathon phase. Generation time now **approaches or
   exceeds the job's `timeout-minutes: 180`**:
   - run 700: started 06:59Z, dead 10:44Z (3h44m)
   - run 705: started 10:26Z, dead 13:44Z (3h18m)
   - run 714: started 13:19Z, dead 16:08Z (2h49m — cancelled before its own
     timeout; the cancellation source is unclear and worth confirming from
     the run's annotations)
   None completed. The roster growth that drove this is visible in the same
   window: six+ merges on 2026-08-21 alone expanded the upstream suites
   (lodash #4693/#4698, stylelint #4696/#4697, React #4660/#4683/#4686/#4687).
3. **Supersession:** each push to main replaces the QUEUED run (by design,
   `cancel-in-progress: false` keeps one running + one queued), so on a busy
   day only one marathon attempt exists at a time — and each one dies.

Net effect: the 6h-staleness guarantee #3988 was built for is void; the
artifact is >22h old and structurally cannot catch up.

## Why this is not #3988's livelock again

`cancel-in-progress` is already `false`; running jobs are not being killed by
new pushes. The #3988 analysis warned: "never `cancel-in-progress` a job
longer than its own trigger interval". The new failure mode is the sibling
hazard on the OTHER bound: **never let the job's runtime outgrow its own
`timeout-minutes`** — a timeout kill and a supersession cancel produce the
same stale artifact.

## Status

- **S1 landed (this PR): `timeout-minutes` 180 → 350.** Run 721's job record
  settled the diagnosis: its generate step was killed at exactly 180:00
  (16:09:17 → 19:09:01Z), promotion steps never reached — a pure timeout, the
  fourth in a row (700/705/714/721). 350 sits just under the 6h GitHub-hosted
  hard cap. The structural bound and the staleness alert below remain OPEN.

## Fix directions (pick during implementation)

- **Immediate unblock (S1, done):** raise `timeout-minutes` so one run can
  actually land and publish the recovery. Cheap, reversible, buys time.
- **Structural:** the generation is a serial walk over ever-growing upstream
  suites. Options, roughly in order of leverage:
  - split measurement per package (matrix jobs) and merge artifacts, so
    wall-clock is the slowest package, not the sum;
  - add a per-package time budget in `generate-npm-compat-report.mjs` with a
    loud `unavailableInfra`-style marker when exceeded (precedent: the React
    watchdogs of #4683), so one slow suite cannot eat the whole budget;
  - a runtime guard in the workflow that publishes whatever completed before
    a self-imposed deadline rather than losing the entire measurement.
- **Guard:** a CI assertion or scheduled check that alerts when
  `generatedAt` in the committed artifact is older than ~12h, so the next
  silent-staleness episode is caught by machinery instead of a manual audit
  (this episode ran >22h before being noticed).

## Acceptance criteria

- [ ] One `npm-compat-refresh` run completes end-to-end and its promotion PR
      merges; the committed `npm-compat-perf.json` shows acorn and clsx
      standalone-dynamic recovered (acorn back in its ~0.10–0.15 band per
      #4602, clsx ~0.12–0.2).
- [ ] The workflow's runtime has headroom against its timeout again (either a
      raised timeout with measured margin, or a bounded/parallelized
      generation).
- [ ] Staleness of the committed artifact is observable (guard or alert),
      not only discoverable by manual audit.
