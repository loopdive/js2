# Queue-drain historical document archive — 2026-09-09

This index accompanies byte-exact restoration of five previously published
document blobs into consolidation base
`1eaa57abcce554226f0a8b22e9118d5f7a68c2f9`, tree
`213f573218875f0cc61ee9a8ec4e012252141b7e`.
The parent supplied the exact source blob identities below. Original text,
including then-current pending decisions, claims, instructions and results, is
retained unchanged for provenance. Those statements are historical, not fresh
dispatch authority, current ownership clearance, queue readiness or main delivery.
Later explicit decisions and current review/queue requirements take precedence.

## Restored documents and exact Git blobs

- [3518-native-async-integration-decisions-2026-09-09.md](./3518-native-async-integration-decisions-2026-09-09.md)
  — `375be4d186dbb0646ec8d80a207375b225a3f228`.
- [3518-native-async-lane-b-api-handoff-2026-09-09.md](./3518-native-async-lane-b-api-handoff-2026-09-09.md)
  — `8eae55a139f0fd7140374069e5f5cdf2cd1782d1`.
- [3518-native-string-output-extraction-spec-2026-09-09.md](./3518-native-string-output-extraction-spec-2026-09-09.md)
  — `574abc11cf415af7b0af210d766a57318ae6a4e6`.
- [3518-pr-shepherd-stack-receipts-2026-09-09.md](./3518-pr-shepherd-stack-receipts-2026-09-09.md)
  — `b13ddfb140bb403da13b6c083333279a18ad8826`.
- [3518-pr5786-conflict-validation-2026-09-09.md](./3518-pr5786-conflict-validation-2026-09-09.md)
  — `47b29a6fd408e772bcfc64965f644fc10c3bc3a7`.

The first three blobs preserve the original native-async decisions, lane-B
interface contract and E1 extraction specification; restoration neither
implements their remaining work nor authorizes new work. The shepherd receipt
blob is present at both repair commits `0f1d880e5c32b08097d8c172e8546cb3abe345ef`
and `a778df748b6ba54fbf9ded49e38326b2a248ca92`. The5786 validation blob is from
the latter. Their recorded scoped results and stack-merge identities are
historical evidence, not a current-main test result. No hold is removed.

## Archived activation records, not active policy

Exact source: `0f1d880e5c32b08097d8c172e8546cb3abe345ef`,
`scripts/compiler-boundaries.json`, zero-based `activationHistory[1]` then
`[2]`. Identical records occur at indices2 then3 in `a778df748b6ba54fbf9ded49e38326b2a248ca92`.
Record order, property order and entry order below are preserved.

SHA256 of UTF8 `JSON.stringify(record)`, without trailing newline:
- First: `9ca5609d7b3a7d186d669f0017c058e1b762519f3a47dce376d61623f94744a0`.
- Second: `e7c4d5e824c5160b9d328d207f7b8651bb8f503413c3a8e4ff7793ebed7181d9`.

The active68-record history remains untouched. Newer activations already cover
these roots/minima; this archive preserves the two exact earlier records rather
than replacing newer policy, reducing populations or asserting exact historical
inclusion where it was absent.

```json
[
  {
    "layer": "native-runtime",
    "entries": [
      "src/runtime/wasmgc/async/microtask-queue-bodies.ts",
      "src/runtime/wasmgc/promise/settlement-bodies.ts",
      "src/runtime/wasmgc/async/frame-engine.ts",
      "src/runtime/wasmgc/async/native-await.ts",
      "src/runtime/wasmgc/promise/delay-bodies.ts",
      "src/runtime/wasmgc/promise/combinator-bodies.ts",
      "src/runtime/wasmgc/values/vector-grow-store.ts",
      "src/runtime/wasmgc/promise/resolution-bodies.ts",
      "src/runtime/wasmgc/promise/thenable-bodies.ts",
      "src/runtime/wasmgc/values/string-layouts.ts",
      "src/runtime/wasmgc/values/string-literal-bodies.ts",
      "src/runtime/wasmgc/values/error-bodies.ts",
      "src/runtime/wasmgc/values/primitive-layouts.ts",
      "src/runtime/wasmgc/values/number-bodies.ts",
      "src/runtime/wasmgc/values/string-number-grammar.ts",
      "src/runtime/wasmgc/values/decimal-scale-bodies.ts",
      "src/runtime/wasmgc/values/string-number-bodies.ts",
      "src/runtime/wasmgc/values/string-flatten-bodies.ts",
      "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts",
      "src/runtime/wasmgc/values/argument-vector-bodies.ts",
      "src/runtime/wasmgc/values/closure-layouts.ts"
    ],
    "minModules": 21
  },
  {
    "layer": "backend-wasmgc",
    "entries": [
      "src/backend/wasmgc/resources/native-vectors.ts",
      "src/backend/wasmgc/resources/native-promises.ts",
      "src/backend/wasmgc/resources/native-string-literals.ts",
      "src/backend/wasmgc/resources/native-errors.ts",
      "src/backend/wasmgc/resources/native-values.ts",
      "src/backend/wasmgc/resources/native-string-number.ts",
      "src/backend/wasmgc/resources/native-string-flatten.ts",
      "src/backend/wasmgc/resources/native-argument-vectors.ts",
      "src/backend/wasmgc/resources/native-closures.ts"
    ],
    "minModules": 9
  }
]
```

## Scope of this restoration

The [ABI/startup issue-addition archive](./3518-abi-startup-historical-issue-additions-2026-09-09.md)
also preserves the exact own-parent patches and ordered added lines from
PR5739 `c3afa4389469e55d434c0715698dc59c6caa9120` (eight nonempty lines)
and PR5741 `7b37b23c72af84a1e336cebce2954942408ecea6` (111 nonempty lines).
Those lines are absent from the issue at cumulative5751 `48fb6d7133aeb360e795826b227d7de4ef09c8e6`;
this archive does not claim complete archival absorption by5751 or overwrite
the current issue. Full source parent/head/path/blob provenance is in the companion.

Documentation only: five exact originals, this index and the issue-addition
companion. No source, tests,
policy, Git index, commit, push, retarget or public update is part of this work.
No tests or compiler executions were run. Frozen uncommitted E2 work is not
included or represented as published. The parent remains the sole integration
owner and decides subsequent publication and queue order.
