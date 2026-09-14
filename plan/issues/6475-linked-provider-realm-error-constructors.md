---
id: 6475
title: "Linked provider rebuilds its own env, so it resolves different error constructors than the consumer's realm"
status: ready
sprint: current
created: 2026-09-14
updated: 2026-09-14
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime
language_feature: module-linking
goal: test262-conformance
depends_on: [3451]
related: [3451, 2527, 5225, 5226]
# id reserved 2026-09-14 with pr_scan="degraded" (gh unreachable): verified
# against upstream main + the assignment ref, NOT against in-flight PRs.
---

# #6475 — a linked provider does not share the consumer's realm intrinsics

## Problem

`assert.throws(TypeError, fn)` fails from inside a linked harness provider with

```
Expected a TypeError but got a different error constructor with the same name
```

Measured 2026-09-14 across 404 rows of the #3451 slice-3 sample: **~32 rows**,
the second-largest residual class after async completion (#6476). Affected
constructors: `TypeError`, `ReferenceError`, `SyntaxError`, `RangeError`.

## Where it comes from

`buildProviderImportObject` (`src/linked-provider-runtime.ts`) builds the
provider's import object as

```ts
env: { ...(overrides?.env ?? {}), ...built.env },
```

— **provider-owned wrappers win over the inherited root ones**, deliberately,
because the adapter carries per-instance callback/host state.

The test262 runner installs a **fresh per-test realm** (`scripts/test262-sandbox-globals.mjs`):
the consumer's `TypeError` is that realm's. The provider's `env` is rebuilt from
its own metadata and therefore resolves the *ambient* intrinsics. Two
constructors, same name, not `===`.

This is invisible outside a linked graph, and invisible inside one unless the
embedder swaps realm intrinsics — which is exactly what the runner does. A
micro-probe with a plain import object does NOT reproduce it; the runner's
sandbox is load-bearing for the repro.

## Constraint a fix must respect

The precedence is not arbitrary. Letting the ROOT `env` win wholesale would hand
the provider the consumer's per-instance callback/host state, which is the bug
that comment was written to prevent. The answer is likely a *split*: realm
INTRINSICS (error constructors, `Object`, `Array`, …) inherited from the root,
per-instance ADAPTER state kept provider-owned.

## Acceptance criteria

- [ ] A native error thrown in a linked consumer satisfies
      `assert.throws(<NativeError>, …)` evaluated in the provider.
- [ ] The per-instance adapter state the current precedence protects is still
      provider-owned (name the test that covers it).
- [ ] The Temporal provider lane (#5353) shows no verdict change.
- [ ] The ~32 rows in the #3451 slice-3 sample flip to agreement.
