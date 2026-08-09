---
id: 3103
title: "Split src/runtime.ts (15,032 LOC) host runtime by concern; decompose resolveImport (6,517-line function)"
status: ready
sprint: current
created: 2026-07-09
updated: 2026-07-17
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

## Progress — Slice 1 (opus-splitrt, 2026-07-13)

**Landed:** first bounded, byte-identical slice of the decomposition. Three
self-contained concerns lifted verbatim out of `src/runtime.ts` into
`src/runtime/`; `runtime.ts` shrank **16,242 → 14,618 LOC** (−1,624).

| New module | Extracted | LOC | Wiring |
| --- | --- | --- | --- |
| `src/runtime/wasi-polyfill.ts` | `buildWasiPolyfill` (public) | ~300 | re-exported from `runtime.ts` (barrel) — public API unchanged |
| `src/runtime/string-constants.ts` | `buildStringConstants`, `buildStringConstants16` (public) | ~50 | imported back (used in `buildImports`) **and** re-exported |
| `src/runtime/iterator-polyfills.ts` | generator/iterator prototype machinery + `_installIteratorHelperPolyfills` (ES2025 helpers) | ~1,310 | 8 symbols still used by `runtime.ts` re-exported and imported back |

**Why these three (root-cause selection, not arbitrary):** a pure file-split is
only safe when the moved region has **no live coupling** back into the parent
module (else you get import cycles or dangling state). I proved each region's
dependency footprint statically before cutting:

- `buildWasiPolyfill` references **zero** module-scope decls and **zero**
  top-of-file imports — fully standalone (only local params + JS globals).
- `buildStringConstants`/`16` depend only on `string-surrogate.js` (an
  external import the new module takes directly); `hasLoneSurrogate`/
  `hexCodeUnits` were dropped from `runtime.ts`'s import (now unused there).
- The generator/iterator block (`L230–710` + `L761–1572`, non-contiguous —
  the sidecar wasm-struct state at `L711–760` is a **different** concern and
  was deliberately left behind) references **nothing** outside itself. Its
  state cells (`_GeneratorState`, `_AsyncGeneratorState`, the proto caches)
  move **with** it and stay in exactly one module, imported back — never
  duplicated (per the issue's warning about split state cells).

This yields **one-directional** imports (`runtime.ts` → `runtime/*`), no
cycles. Bodies moved **verbatim**; the only added lines are license headers,
one import block, and the re-export lists (net +37 LOC across the change-set).

**Safety proof (this is a REFACTOR — zero behavior change):**
- `prove-emit-identity check`: **IDENTICAL, all 39 (file,target) emits match**
  the pre-change baseline byte-for-byte (runtime.ts is host-side JS, not in the
  Wasm emit path — the split cannot change an emitted byte by construction).
- `tsc --noEmit`: clean. `biome lint` (2,600 files): clean. `prettier
  --check`: clean.
- Quality gates green: loc-budget (no new file crosses the 1,500 threshold;
  largest new module ~1,310), dead-exports, any-box-sites, coercion-sites,
  speculative-rollback, codegen-fallbacks, stack-balance, oracle-ratchet,
  ir-adoption, ir-fallbacks, issues.
- Targeted vitest (generators, iterators, WASI, string-constants, promise,
  object, map/set, weak, equivalence): the only failing files
  (`imported-string-constants`, `generator-yield-contexts`,
  `struct-proxy-wrappers`, `map-set-basic`'s broken `../../src/runtime.js`
  path) fail **identically on pristine `origin/main`** — pre-existing, not
  introduced here.

**Remaining (future slices, issue stays open):** `resolveImport` handler-map
decomposition (the 6.5k-line function), `sidecar.ts`, `to-primitive.ts`,
`wrap-host.ts`, `instantiate.ts`, and the `imports/*` handler groups per the
Target-structure table above. `runtime.ts` is still 14,618 LOC; acceptance
criterion #2 (<600 LOC barrel) is a multi-PR target.

## Progress — Slice 2 (dev-k, 2026-07-17)

**Landed:** one more bounded, byte-identical slice — the Annex B legacy RegExp
static-state machinery plus the `String.prototype` symbol-method reroute for
primitive search values (#3095), lifted verbatim into a new sibling module.
`runtime.ts` shrank **15,025 → 14,834 LOC** (−191).

| New module | Extracted | LOC | Wiring |
| --- | --- | --- | --- |
| `src/runtime/legacy-regexp.ts` | `_rerouteStringSymbolMethodPrimitive` (#3095), `_makeLegacyRegExpState`, `_updateLegacyRegExpState`, `_installLegacyRegExpAccessors`, type `LegacyRegExpState` (all imported back); privates `_escapeRegExpLiteral`, `_stringMethodDispatchSymbol`, `_legacyRegExpState`, `_legacyRegExpInstalledOn` fully contained | ~205 | one-directional import (`runtime.ts` → `runtime/legacy-regexp.js`); no cycle |

**Root-cause selection (why this region is safe to cut):** the two extracted
ranges (`_escapeRegExpLiteral`/reroute cluster + the legacy-state cluster)
reference **nothing** outside themselves — only JS globals (`RegExp`, `Object`,
`Symbol`, `WeakSet`) and their own module-local decls. The shared default state
cell `_legacyRegExpState` and the `_legacyRegExpInstalledOn` WeakSet move **with**
the cluster and stay in exactly one module (per the split-state warning). The
interspersed `_symbolToWasm`/`_symbolIdToKeys` maps (a **different** concern —
they depend on `_disposeSym`/`_asyncDisposeSym`) were deliberately left behind.
Confirmed **0** stray references to the four privatized symbols remain in
`runtime.ts`; the five re-exported symbols are wired via one import block.

**Safety (REFACTOR — zero behavior change):** bodies moved verbatim (only added
lines: license header, one import block, `export` keywords). Isolated
`tsc --noEmit --skipLibCheck` of the new module: clean. `check:loc-budget`:
green (runtime.ts shrinks; new module ~205 LOC, well under the 1,500 threshold).
Targeted vitest (`issue-2161-matchall`, `issue-1539-standalone-regex-replace`,
`issue-3014`): green. runtime.ts is host-side JS, not in the Wasm emit path, so
the split cannot change an emitted byte by construction.

## Progress — Slice: sparse Array.prototype fast paths (dev-k, 2026-07-17)

**Landed:** another bounded, byte-identical slice — the #1234 sparse-aware
`Array.prototype.{unshift,reverse,forEach}` fast paths (for non-Array
receivers) lifted verbatim into a new sibling module
`src/runtime/array-proto-sparse.ts`. `runtime.ts` shrinks **-187 LOC**.

| New module | Extracted | Wiring |
| --- | --- | --- |
| `src/runtime/array-proto-sparse.ts` | `_collectIntegerKeys`, `_arrayProtoUnshiftSparse`, `_arrayProtoReverseSparse`, `_arrayProtoForEachSparse` (all private to the module) + the `_arrayProtoSparseFastPaths` dispatch map | only `_arrayProtoSparseFastPaths` is used by `runtime.ts` (one call site in `__proto_method_call`) — exported and imported back; one-directional, no cycle |

**Root-cause selection:** the whole `#1234` cluster references **nothing**
outside itself — only JS globals (`Reflect`, `Number`, `Set`, `String`,
`TypeError`). The 4 functions and their dispatch map move as one unit;
confirmed **0** stray references to the four privatized symbols remain in
`runtime.ts`.

**Safety (REFACTOR — zero behavior change):** bodies moved verbatim (only added
lines: license header, one `export` keyword, one import block). `tsc --noEmit`:
clean. `check:loc-budget`: green. `runtime.ts` is host-side JS, not in the Wasm
emit path, so the split cannot change an emitted byte by construction.
