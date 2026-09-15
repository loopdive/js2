---
id: 6482
title: "Linked test262 harness: a provider reading a consumer array by index is lowered in-wasm and misses the consumer's vec type"
status: ready
sprint: current
created: 2026-09-15
updated: 2026-09-15
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: arrays
goal: test262-conformance
depends_on: [6477]
related: [3451, 5225, 6477]
---

# #6482 — cross-module vec index read never reaches the host

## Problem (measured 2026-09-15 under #6477)

`verifyEqualTo(arr, "0", v)` inside the harness provider is `arr[name]`. With
`_safeGet` and the `__extern_get` import traced, **zero** runtime imports fire
for that read once the body runs after registration (#6477 P1). The read is
lowered to in-wasm vec access that `ref.test`s the receiver against the
PROVIDER's own vec types; a consumer-minted vec misses and the read yields the
null/0 shape default — `Expected obj[0] to equal NaN, actually null`.

No host-side `_decoderExportsFor` redirect can see it. The linked ABI must
make a consumer-minted vec castable in the provider (canonical rec-group
membership for the vec carrier, or a boundary terminal that routes the miss to
the cross-module decoder instead of the default).

Rows: `built-ins/Object/defineProperty/15.2.3.6-4-{299-1,300,540-8}.js`, the
`arr540` and `plainval` minimal bodies in #6477.

## Acceptance criteria

- [ ] A minimal body (`var arr = [1]; verifyEqualTo(arr, "0", 1)`) passes in the
      linked lane; the lowering site of the in-wasm index read is named here.
- [ ] The three defineProperty rows flip to agreement; honest lane byte-identical.
