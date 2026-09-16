---
id: 6482
title: "Linked test262 harness: a provider reading a consumer array by index is lowered in-wasm and misses the consumer's vec type"
status: ready
sprint: current
created: 2026-09-15
updated: 2026-09-16
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
`arr540` and `plainval` minimal bodies in #6477; after #6474 (script goal moves
top-level values from module globals to global-object properties, which routes
the provider's read down the same in-wasm vec path) also
`built-ins/Object/defineProperty/15.2.3.6-4-258.js` and `15.2.3.6-3-185.js`
(reproduced in isolation by the #6474 lane, 2026-09-15).

## Acceptance criteria

- [ ] A minimal body (`var arr = [1]; verifyEqualTo(arr, "0", 1)`) passes in the
      linked lane; the lowering site of the in-wasm index read is named here.
- [ ] The three defineProperty rows flip to agreement; honest lane byte-identical.

## Re-measured 2026-09-16 (Fable lane) — the class splits in three

The in-process lanes (smoke script, `issue-3451/6475/6476/6477` suites) ran the
body with the consumer's runtime UNWIRED: `wireCompiledInstance` read
`imports.__setInstance`, but `buildImports` publishes the consumer hook as
`setInstance` (only provider import objects carry the `__setInstance` alias).
With `getExports()` undefined, `_vecDefineOwnProperty` bailed to the sidecar
and the provider read the stale element. The sharded worker calls
`importObj.setInstance` itself, so its numbers were right. Fixed in
`src/linked-provider-runtime.ts` (`__setInstance ?? setInstance`); after the
fix `arr540`, `arr258` and `plainidx` pass in-process, matching the worker.

What remains, each a different mechanism:

| row(s) | message | mechanism |
| --- | --- | --- |
| `15.2.3.6-4-540-8.js`, `plainval` | `to equal NaN, actually …` | #6487 — provider param body-inferred to f64 — **fixed 2026-09-16, both pass linked** |
| `15.2.3.6-4-299-1.js`, `-300.js` | `Expected obj[0] to equal 10, actually 0` | `arguments` object with a defineProperty ACCESSOR read from the provider — `_safeGet`'s arguments fast path or the vec index path answers the raw slot |
| `15.2.3.6-4-258.js` | `0 descriptor should be enumerable/writable/configurable` | element VALUE now right; the per-index flags (`_wasmPropDescs`) the consumer wrote are not what the provider's `_readOwnDescriptor` vec branch reads |
| `15.2.3.6-3-185.js` | `Invalid descriptor field: label` | provider's `__getOwnPropertyNames` on the consumer's `{ value: undefined, writable: false }` literal returns a phantom name — decoder still resolving to the wrong module's `__struct_field_names` ladder for this shape |

The original "in-wasm vec read never reaches the host" attribution was an
artifact of the unwired in-process lane; keep this issue for the last three
rows (accessor / flags / phantom name), all provider-side reads of
consumer-minted values.
