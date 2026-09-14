---
id: 6476
title: "Linked test262 harness: async completion marker ($DONE) not observed across the provider boundary"
status: ready
sprint: current
created: 2026-09-14
updated: 2026-09-14
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: test262-runner
language_feature: async
goal: test262-conformance
depends_on: [3451]
related: [3451, 2527, 3469]
# id reserved 2026-09-14 with pr_scan="degraded" (gh unreachable): verified
# against upstream main + the assignment ref, NOT against in-flight PRs.
---

# #6476 — async rows report "async completion marker not observed" when linked

## Problem

**49 rows** — the LARGEST residual class of #3451 slice 3, measured 2026-09-14
over a 404-row sample (`built-ins/Promise/prototype/then`,
`language/expressions/class`, `built-ins/Object/defineProperty`,
`language/statements/with`). Honest lane passes; the linked lane reports

```
async completion marker not observed
```

## Likely mechanism (not yet confirmed — confirm before coding)

An `async`-flagged test's harness prefix includes `doneprintHandle.js`, which
defines `$DONE`. In the linked lane that lives in the PROVIDER, so the body's
`$DONE` is a host mirror of the provider's closure and the completion sink the
runner watches is wired to the provider instance, not the consumer's.

Two things to establish first, because they lead to different fixes:

1. Is `$DONE` **called at all** (instrument the provider's closure), or called
   and not observed?
2. Does the runner's completion sink read a global the provider's realm owns?
   (`scripts/test262-worker.mjs` async completion handling; the #3469 standalone
   sink is the closest prior art.)

## Acceptance criteria

- [ ] The mechanism is established by measurement and recorded here before the
      fix.
- [ ] An `async` row that passes honest passes linked, for both a resolving and
      a rejecting promise.
- [ ] The 49 rows in the slice-3 sample flip to agreement.
- [ ] The honest lane is unchanged.
