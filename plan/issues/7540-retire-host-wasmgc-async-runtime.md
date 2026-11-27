---
id: 7540
title: "Retire the unreachable `host-wasmgc` async runtime and rename `standalone-native-wasmgc` to `native-wasmgc`"
status: backlog
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: ir
goal: backend-agnostic-ir
related: [7533, 6708, 6979]
---

# #7540: retire the `host-wasmgc` async runtime

Since #6708 S6-A and #6979 S7-c, every WasmGC build runs the native regime, and the IR runtime policy target is never
`"host"`. That leaves the `host-wasmgc` async runtime arm (`src/ir/runtime/intrinsic-preparation.ts`
`attachAsyncRuntime`, `src/codegen/ir-async-runtime-adapters.ts`) unreachable. The native runtime is still named
`standalone-native-wasmgc` although it also serves the JS environment. Found while planning #7533.

Backlog. Per the project direction, removing JS-host code needs its own reviewed change, and it has to wait until
#7533 lands.

## Acceptance criteria

- The `host-wasmgc` arm and its adapters are deleted, and the native runtime kind is renamed `native-wasmgc` everywhere.
- gc, standalone and WASI output stay byte-identical on the playground corpus. Only the name changes, so the bytes must
  be identical.
- `pnpm run check:ir-fallbacks` and `node scripts/equivalence-gate.mjs` are unchanged.
