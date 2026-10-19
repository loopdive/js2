---
id: 7011
title: "Regime gap: `new SharedArrayBuffer(n)` still emits the host `SharedArrayBuffer_new` import on host-free builds"
status: ready
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: SharedArrayBuffer
goal: architecture
sprint: current
parent: 5385
related: [6979, 6705]
---

# #7011 — `SharedArrayBuffer` construction on the native regime

Found by the S7-b slice of #6979 (2026-10-15): `new SharedArrayBuffer(n)`
is the only construct in the Atomics test262 rows (4 corpus programs in the
1-in-97 sample) whose sole implementation is the host import
`SharedArrayBuffer_new`. S7-b classifies it under the explicit `regime-gap`
family (owner #5385) so the universal publication gate does not reject it;
closing this issue lets that family entry be deleted.

## Plan

1. Measure: which test262 rows under `built-ins/SharedArrayBuffer/` and
   `built-ins/Atomics/` reach the import on standalone and native-first
   (`TEST262_PATH_FILTER`), and what `ArrayBuffer` does today on the native
   path (`src/codegen/dataview-native.ts`, the typed-array native layer).
2. Implement natively: a `SharedArrayBuffer` object whose backing store is
   the same native byte array as `ArrayBuffer` (there is no shared memory
   between Wasm instances to honour, so the semantic difference is the
   constructor identity, `[[ArrayBufferData]]` sharing on `slice`, and
   `growable`/`maxByteLength`); `Atomics.*` operate on the native store with
   the ordinary (single-agent) semantics. Keep the JS-host accelerator-free:
   no host import; a `--target standalone` build must link with no `env`
   import.
3. Tests: a focused test under native-first and standalone (construction,
   `byteLength`, `slice`, a typed-array view, `Atomics.add`/`load`); the
   test262 subset counts before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; the
   `regime-gap` entry for `SharedArrayBuffer_new` deleted from
   `src/host-import-policy.ts` and its probe; direct-AST freeze respected
   (native provider/runtime code).
