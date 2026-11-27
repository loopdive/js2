---
id: 7552
title: "Remove the dead HOST_RAN-only steps from test262-sharded.yml"
status: ready
created: 2026-11-26
updated: 2026-11-26
priority: low
feasibility: medium
reasoning_effort: medium
task_type: ci
area: ci, test262
goal: ci-hardening
sprint: Backlog
horizon: s
es_edition: n/a
related: [7551, 6979, 1668, 1942, 6786, 3467]
---

# #7552 — remove the dead `HOST_RAN`-only test262 gates

`merge-report` sets `HOST_RAN: "false"` unconditionally, because the JS-host
lane is retired (#6979). Every step gated on `env.HOST_RAN == 'true'`
therefore never runs, yet each still reads as a live gate. Examples in
`.github/workflows/test262-sharded.yml`:

- the catastrophic guard (#1668);
- the host completed-edition per-row gate (#6786);
- the compile-time regression guard (#1942);
- every diff step of `regression-gate` (`check for test262 regressions`),
  including the #3467 merge-base cache and the #1956 predecessor-group
  resolution;
- `write-run-cache-bot` (`if: false`).

That required check is a no-op in every event as a result.

Found while reworking the queue gate for #7551, and deliberately left out of
that change so its diff stays reviewable and revertible.

## Acceptance criteria

- The steps and jobs above are removed. Required check names stay, and
  `check for test262 regressions` keeps publishing a green no-op (or the
  ruleset is changed in a separate, owner-approved step).
- No step reads `HOST_RAN` any more, or the variable is gone.
- `scripts/auto-park-merge-group-failure.mjs` and the docs no longer name the
  removed steps.
