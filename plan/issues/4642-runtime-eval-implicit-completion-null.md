---
id: 4642
title: "runtime-eval: a provider-minted function's IMPLICIT completion value crosses as null, not undefined — Function()() === null; explicit `return undefined;` is correct"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime-eval
es_edition: 5
language_feature: eval
goal: standalone-gap
related: [4639, 4637, 4624, 2928]
origin: "dev-4639/dev-4637 three-lane investigation (2026-08-23), both dead ends recorded in #4639's issue file under '## Handed to another lane'. Owner: runtime-eval provider."
---

# #4642 — implicit completion value crosses as null

## Problem (measured by dev-4639 + dev-4637, jointly narrowed)

```js
function h(){}; var g = Function("");
String(h()) + "|" + String(g())   // "undefined|null"  — spec: "undefined|undefined"
```

Established by the two lanes' A/B exchange (full chain in #4639's issue
file):

- An EXPLICIT `return undefined;` through the same conversion decodes
  correctly — the decode arm and the classifier are both faithful
  (`classifiedValue` tags the singleton `_UNDEFINED` and a bare
  `ref.null.extern` `_NULL`, correctly, both times).
- The wrong value is TIER-INDEPENDENT: identical under the quickjs
  provider AND `JS2WASM_EVAL_ENGINE=interpreter` — which rules out both
  engines and their marshalling in one measurement.
- The shared piece is NOT in `src/`: `__runtime_apply_interpreted` is a
  host import whose body lives in the provider artifact
  (`scripts/runtime-eval-provider.mjs` ~L233, returns
  `[ok, __runtime_eval_wrap_result(exposeRuntimeEvalValue(value))]`).

Leading hypothesis, EXPLICITLY NOT MEASURED (both lanes declined to fix
blind): the provider is itself a js2wasm-compiled module, so a JS
`undefined` for an implicit completion materializes as `ref.null.extern`
crossing into its wasm — i.e. the envelope encoding of an implicit
completion, provider-side.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Verify the
   hypothesis FIRST: instrument the provider's wrap path for an implicit
   vs explicit completion; find where undefined degrades to null.
2. Fix in the provider build (`scripts/runtime-eval-provider.mjs` /
   `scripts/build-quickjs-eval-provider.mjs` land) — encode the implicit
   completion as the undefined envelope the decode arm already handles.
3. Verification surface is a PROVIDER REBUILD plus an eval-dependent
   corpus sweep (the reason both wave-3 lanes declined): rebuild both
   tiers, re-run the eval-dependent ES≤5 rows before/after (own runs),
   plus the affected #4637-A5 `built-ins/Function` S15.3.2.1 rows.
4. Pins: extend tests with the `"undefined|undefined"` probe both tiers.
