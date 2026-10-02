---
id: 6765
title: "vitest workers ignore NODE_OPTIONS heap size (512 MB default); suites misreported as 'OOM on main'"
status: ready
sprint: Backlog
created: 2026-09-29
updated: 2026-09-29
priority: medium
horizon: s
feasibility: easy
task_type: docs
area: tooling
goal: ci-hardening
requested_by: ttraenkler/claude-lead
related: [3518]
---

# The worker heap knob is `VITEST_FORK_MAX_OLD_SPACE_SIZE`, not `NODE_OPTIONS`

## Symptom

On 2026-09-29 four lanes reported `tests/issue-6651-a9-*`, `issue-6651-a14-*`,
`issue-6651-sg1-*`, `issue-6731-*` and `issue-6738-*` as "out of heap even on
unmodified main" and treated them as untestable. The runs had set
`NODE_OPTIONS=--max-old-space-size=4096` (and 7168). The worker still died at
about 520 MB: "Mark-Compact 509.7 (521.9) → 506.1 MB … heap out of memory".

## Cause

`vitest.config.ts` forks each worker with its own heap limit:

```ts
const forkMaxOldSpaceSize = process.env.VITEST_FORK_MAX_OLD_SPACE_SIZE || "512";
...
execArgv: [`--max-old-space-size=${forkMaxOldSpaceSize}`, "--expose-gc"],
```

The fork's `execArgv` wins over the inherited `NODE_OPTIONS`. CI already sets
the right variable (`ci.yml`, "Run issue tests this PR touched":
`VITEST_FORK_MAX_OLD_SPACE_SIZE: "4096"`). Nothing tells a local user.

With `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 VITEST_MAX_FORKS=1`,
`tests/issue-6651-a14-genfn-residuals.test.ts` passes 18/18.

A second trap in the same suites: the QuickJS-realm blocks `describe.skipIf`
themselves when the adapter cache for the current compiler hash is missing.
They show as `skipped`, not failed. Forcing them needs `JS2WASM_EVAL_ENGINE=quickjs`
and a built adapter (`npx tsx scripts/build-quickjs-eval-provider.mjs`; plain
`node` fails with "no usable compiler … run under tsx").

## Fix

1. `CLAUDE.md` "Running Tests": one bullet naming `VITEST_FORK_MAX_OLD_SPACE_SIZE`
   and the QuickJS force/build step.
2. Optional: in `vitest.config.ts`, when `VITEST_FORK_MAX_OLD_SPACE_SIZE` is
   unset, take a `--max-old-space-size=N` found in `NODE_OPTIONS`, so the
   intuitive knob works.

## Acceptance

`NODE_OPTIONS=--max-old-space-size=4096 npx vitest run tests/issue-6651-a14-genfn-residuals.test.ts`
passes (with option 2), or CLAUDE.md names the working variable (option 1).
