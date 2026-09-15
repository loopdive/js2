---
id: 6476
title: "Linked test262 harness: async completion marker ($DONE) not observed across the provider boundary"
status: done
sprint: current
created: 2026-09-14
updated: 2026-09-15
completed: 2026-09-15
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

- [x] The mechanism is established by measurement and recorded here before the
      fix — see "Mechanism" below; the marker is printed, to the wrong sink.
- [x] An `async` row that passes honest passes linked, for both a resolving and
      a rejecting promise — `tests/issue-6476-linked-async-marker.test.ts`,
      which also asserts the marker does NOT arrive without `linkedHost`.
- [x] The 49 rows in the slice-3 sample flip to agreement — re-measured
      2026-09-15 over 399 common rows: **0** rows in this class (#3451,
      "Re-measured 2026-09-15").
- [x] The honest lane is unchanged — the change is confined to the provider's
      import-object build, which the honest lane does not reach;
      `tests/issue-3451-linked-harness-lane.test.ts` (the honest-vs-linked
      gating guard) green.

## Mechanism — established by measurement 2026-09-15 (Opus lane)

Confirmed, and the confirmation is an artifact of the test rather than a
transient probe: `tests/issue-6476-linked-async-marker.test.ts` runs the
resolving body through the linked lane WITHOUT `linkedHost`, and vitest captures

```
stdout | … > without linkedHost the marker never reaches the row's console
Test262:AsyncTestComplete
```

on the REAL console while the row's capturing proxy stays empty. So the answer
to the issue's question 1 is: `$DONE` **is** called, `print` **does** run, and
the marker is emitted — to the process console, because the provider's `env`
was built with no `deps`. Question 2 does not arise: the sink the runner polls
(`harnessOutput`, fed by the row's `consoleProxy`) is correct; nothing was
wired to it from the provider side. Not a completion-plumbing defect, and not
a separate fix — the same `linkedHost` threading as #6475.

## Implementation Plan (2026-09-14, Fable lane)

Mechanism, from reading the code (confirm with one instrumented row before
coding, as the issue asks): the marker path is `$DONE → print →
console.log("Test262:AsyncTestComplete")` and the worker's `findMarker` scans
the row's **console proxy**. The provider's `env` is built without the row's
`{ console: consoleProxy }` deps (`buildProviderImportObject` calls
`buildCompiledImportsRuntime(providerResult)` bare), so the provider's `print`
writes to the real console and the marker is never captured. This is the same
defect as #6475 (ambient realm instead of the row's `globalSandbox`), so **the
fix is #6475's plan** — the `linkedHost` threading gives the provider the
row's console proxy and sandbox in one change. Do not implement separately;
verify here:

1. Instrument: run one async row linked with `TEST262_ORACLE_MODE=linked` and a
   temporary `console.error` in the provider's `print` path; confirm the marker
   is printed but not captured. Record the observation in this file.
2. After #6475 lands in the same PR, rerun `built-ins/Promise/prototype/then`
   (the 49-row class) linked vs honest; record the count.
3. Add `tests/issue-6476-linked-async-marker.test.ts`: an `async`-flagged body
   (`asyncHelpers.js` + `doneprintHandle.js` in the prefix) whose promise
   resolves, and one that rejects; through `instantiateTest262Module` with a
   capturing console in `linkedHost.deps`, assert the marker reaches the
   capture in both cases and that the rejecting case carries the error text.
