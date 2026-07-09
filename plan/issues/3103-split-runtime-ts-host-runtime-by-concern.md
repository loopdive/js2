---
id: 3103
title: "Split src/runtime.ts (15,032 LOC) host runtime by concern; decompose resolveImport (6,517-line function)"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: high
horizon: l
feasibility: medium
model: opus
reasoning_effort: high
task_type: refactor
area: runtime
language_feature: compiler-internals
goal: maintainability
related: [1172, 3102, 3104]
---

# #3103 — Split `src/runtime.ts` by concern

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

`src/runtime.ts` is **15,032 LOC** in one file (266 top-level declarations),
mixing at least eight concerns. The core offender is `resolveImport`
(L7560–~L14076): a **6,517-line function** — one `switch (intent.type)` with 36
cases (`string_literal`, `math`, `console_log`, `string_method`,
`extern_class`, `builtin`, `callback_maker`, `await`, `dynamic_import`,
`typeof_check`, `box`/`unbox`, `extern_get`/`extern_set`, `host_eq`,
`date_*`, `node_*`, `timer_*`, `jsx_runtime`, `proxy_create`, …), each case a
50–800-line inline closure. Other measured clusters:

| Cluster                                               | approx. size | anchors                                                                                                      |
| ----------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `resolveImport` intent dispatch                       | 6,517        | L7560                                                                                                        |
| Iterator-helper polyfills                             | 792          | `_installIteratorHelperPolyfills` L744                                                                       |
| Host wrapping layer                                   | ~700         | `_wrapForHost` L5640, `_wrapCallableForHost` L6009, `_wrapVecForHost` L5522, `_wrapWasmClosure*` L2013/L2110 |
| ToPrimitive / coercion                                | ~500         | `_toPrimitive` L2924, `_hostToPrimitive` L3224, `_wasmToPlain` L3623                                         |
| Sidecar property store + safe get/set                 | ~600         | `_safeSet` L4645, `_safeGet` L4502, descriptor helpers L1723+                                                |
| WASI polyfill                                         | ~300         | `buildWasiPolyfill` L14279                                                                                   |
| Public instantiation API                              | ~400         | `buildImports` L14559, `wrapExports` L14812, `instantiateWasm*` L14941+                                      |
| Legacy RegExp statics, proxy bridge, generators proto | ~400         | L4367, L6322, L413/L553                                                                                      |

Growth: +1,073 LOC in the last 12 days alone. 92 `as any` casts (highest
count in src/).

## Why this is the SAFEST big split available

`src/runtime.ts` is **host-side JS**, not codegen — it is not in the Wasm emit
path at all. Splitting it cannot change a single emitted byte _by
construction_; `scripts/prove-emit-identity.mjs` is not even needed (run it
once anyway as a belt-and-braces check — it must trivially pass). The real
guardrails are the vitest suite (the 793 test files that call
`instantiateWasm`/`buildImports` exercise this module heavily) and test262
host-mode in CI.

## Target structure

Keep `src/runtime.ts` as the public entry (re-export barrel — the `/runtime`
package export path and `buildImports`/`buildStringConstants`/
`buildWasiPolyfill`/`instantiateWasm`/`instantiateWasmStreaming`/
`compileAndInstantiate`/`wrapExports` signatures must not change). Move
implementation into `src/runtime/`:

```
src/runtime/
  sidecar.ts          — WeakMap sidecar store, _safeGet/_safeSet, descriptors
  wrap-host.ts        — _wrapForHost/_wrapCallableForHost/_wrapVecForHost/_wrapWasmClosure*
  to-primitive.ts     — _toPrimitive/_hostToPrimitive/_wasmToPlain
  polyfills.ts        — iterator-helper polyfills, generator prototypes, legacy RegExp statics
  wasi-polyfill.ts    — buildWasiPolyfill
  instantiate.ts      — buildImports, wrapExports, instantiateWasm*, checkPolicy
  imports/
    index.ts          — resolveImport: intent.type -> handler-map dispatch
    strings.ts        — string_literal/string_method/string statics
    console.ts        — console_log variants
    extern.ts         — extern_class/extern_get/extern_set/builtin
    equality.ts       — host_eq/host_loose_eq/host_add/host_compare/same_value_zero
    date-timers.ts    — date_*/timer_*
    node.ts           — node_builtin/node_dirname/node_filename/node_builtin_fn/web_storage
    async.ts          — await/callback_maker/getter_callback_maker/dynamic_import
    misc.ts           — typeof_check/box/unbox/truthy_check/jsx_runtime/proxy_create/declared_global
```

`resolveImport` becomes a lookup in
`Record<ImportIntent["type"], (intent, deps, callbackState, sandbox, state) => Function>`
merged from the per-file handler maps — each case body moves verbatim.

## Incremental steps (each its own PR-able commit)

1. Extract leaf utilities with no intra-file cycles (`sidecar.ts`,
   `to-primitive.ts`) — the closures inside `resolveImport` call these; pass
   them via imports (they are module-scope today, so plain `import` works).
2. Extract `wrap-host.ts`, `polyfills.ts` (depend on 1).
3. Extract `wasi-polyfill.ts`, `instantiate.ts`.
4. Convert `resolveImport` switch → handler map **in place** (same file), one
   `case` = one map entry, verbatim bodies. Full test run.
5. Move handler groups to `src/runtime/imports/*.ts`, one group per commit.
6. Leave `src/runtime.ts` as re-exports; verify the package `exports` map and
   `runtime-instantiate.ts`/`runtime-eval.ts` imports still resolve.

Watch for: module-scope mutable state (`_nodeRequire` memo, legacy RegExp
state, instance-state maps) — keep each piece of state in exactly one module
and import accessors; never duplicate the state cell in two modules.

## Estimated LOC delta

Net ~0 (motion) minus dedup of the two closure-iterable drainers (#1849
documents `runtime.ts:1626` vs `:1720`) and repeated coercion preambles ≈
**−300 to −500**; `runtime.ts` 15,032 → <500 barrel + ~14k spread across
~15 focused modules, largest ~1,500.

## Acceptance criteria

1. Full vitest suite green; test262 CI shows no regression (net_per_test ≥ 0).
2. `src/runtime.ts` < 600 LOC (barrel + module docs); no new module > 2,000 LOC.
3. Public API (`/runtime` entry) unchanged — verified by existing import sites
   in tests and `src/index.ts`.
4. `prove-emit-identity check` trivially passes (belt-and-braces).
5. #3102's baseline updated (banked shrinkage) if it has landed.
