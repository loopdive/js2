---
id: 6686
title: "S2: the JS value boundary (strings, admitted objects, callbacks, errors) works under the native regime"
status: done
completed: 2026-09-26
created: 2026-09-26
updated: 2026-09-26
assignee: ttraenkler/opus-6686
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen, runtime, host-interop
language_feature: wasm-js-interop
goal: architecture
sprint: current
parent: 5385
depends_on: [6685]
related: [4397, 4399, 4401]
# 2026-09-26 (#6686): the jsValueBoundary helper must sit next to
# hostFreeEnvironment in context/types.ts (per the #5385 v2 design rule); the
# other growth is 1-6 lines of import/re-key per file (net +22 lines).
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/native-strings.ts
  - src/codegen/index.ts
  - src/codegen/object-runtime.ts
# 2026-09-26 (#6686): +1 line — the host callback arm is composed behind the
# Wasm-owned test (composeHostCallFallback lives in host-call-fallback.ts).
func-budget-allow:
  - src/codegen/expressions/calls.ts::buildInlineDynamicDispatch
---

# #6686 — S2: JS value boundary under the native regime

Slice S2 of the #5385 "Implementation Plan v2" (read that section first). S1
(#6685) must land first: it introduces `hostFreeEnvironment(ctx)` and settles
the console arm.

## Problem

With `JS2WASM_NATIVE_REGIME_JS=1`, a `semanticProviders: "native-first"` build
in a JavaScript environment lowers with the standalone regime, and nine tests
in `tests/issue-4397-native-semantic-js-host.test.ts` break because arms that
answer "does this module keep the JS value bridge?" are still gated on
`ctx.standalone` (now "which provider regime"). Under the regime those arms
must read the profile's `hostValueInterop` instead.

| 4397 test                                                      | observed                                               |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| keeps Wasm-owned objects live and identity-stable; native JSON | `type incompatibility when transforming from/to JS`    |
| matches host-assisted string values and observable errors      | `expected {} to be 'ALPHA'`                            |
| object-rest CopyDataProperties with a JS-owned `any` source    | `illegal cast`                                         |
| DataView admits caller-owned views; scopes admitted objects    | `expected null to be 9`; `expected undefined to be 42` |
| compiled bind / JS function admitted at the boundary           | `[object Object] is not a function`                    |
| translates Wasm-owned errors only at the JS boundary           | `expected Error to be an instance of TypeError`        |

## Change

Introduce `jsValueBoundary(ctx)` ≡ `ctx.targetProfile.hostValueInterop !== "off"`
in `src/codegen/context/types.ts` (next to `hostFreeEnvironment`). The
reference pattern already exists at `src/codegen/object-runtime.ts` ≈ L937
(`boundaryObjectInterop`) and `src/codegen/export-throw-boundary.ts:76`;
generalize it. Re-key ONLY boundary arms, one test at a time, in table order:

1. **String marshal at exports** — `src/codegen/closure-exports.ts` ≈ L773 and
   ≈ L1516 (`needsHostFacadeUnwrap = !ctx.standalone && !ctx.wasi && …`) and
   the export-wrapper string bridge (`__str_from_mem`/`__str_to_mem`,
   `src/codegen/native-strings.ts` ≈ L1711); string params/results must cross
   as JS primitives exactly as the `native-first` (non-regime) build does today.
2. **Admitted-object reads on `any` receivers** — the `any` arms in
   `src/codegen/property-access.ts` / `property-access-dispatch.ts` that cast
   externref→`$Object` under `ctx.standalone` must first consult the admitted
   boundary MOP (`__boundary_object_get/has/…`, minted in `object-runtime.ts`)
   when `jsValueBoundary(ctx)`. Wasm-owned `$Object` values never route
   through it (existing #4399 invariant).
3. **Callbacks / callable `any`** — `src/codegen/expressions/calls.ts` ≈
   L4711–L4960 (`allowHostBoundaryFallback` arms gated `!ctx.standalone &&
   !ctx.wasi`) → `jsValueBoundary(ctx)`; `planHostCallFallback(arity,
   nativeBoundary=true)` already yields `__boundary_callback_call_N`.
4. **Error translation at the boundary** — native `$Error` structs crossing out
   must present as the matching JS `Error` subclass with `name`/`message`;
   locate the kind-tag consumer in `src/runtime.ts` (`_wrapForHost` error arm)
   and the codegen side (`src/codegen/js-errors.ts` `noJsHost()` consumers that
   skip the kind tag under `ctx.standalone`).
5. **Symbol fields in struct exports** — `src/codegen/struct-field-exports.ts`
   L219 / L482 / L572 / L783: `ctx.standalone || ctx.wasi` there means "no host
   Symbol"; with a JS bridge use the boundary Symbol map (#4397 Symbol slice).

Never widen `hostValueInterop` semantics, never touch "which provider" arms,
no new compound predicates. Add `JS2WASM_NATIVE_REGIME_JS=1` to
`scripts/check-host-import-policy.ts` so the ratchet measures the regime;
raise maxima in `plan/audit/host-import-policy-baseline.json` only with a
measured reason stated in the PR.

## Acceptance

- [x] `tests/issue-4396-target-profile.test.ts` byte-identity test green
      (default `gc`/`standalone`/`wasi` unchanged) — 12/12.
- [x] `JS2WASM_NATIVE_REGIME_JS=1 npx vitest run tests/issue-4397-native-semantic-js-host.test.ts tests/issue-4399*.test.ts tests/issue-4401-host-import-policy.test.ts`:
      4397 **29/30** (was 12/30 after S1; the file has 30 tests now, not 16).
      "parse and URI string globals" is now GREEN under the regime. The one
      red is `assignmentRest` in "object-rest CopyDataProperties…"
      (`illegal cast`) — it fails identically with plain `--target
      standalone`, so it is a native object-rest provider defect, not a
      boundary arm (out of S2 scope). The boundary half of that test
      (`boundaryRest`) passes. 4399 green; 4401 unchanged (same 2 reds before
      and after, both pre-existing under the regime).
- [x] `JS2WASM_NATIVE_REGIME_JS=1 pnpm run check:host-import-policy` green with
      zero legacy/unknown imports (the script now sets the env var itself).
      `nativeFirst.maximumImports` raised 395 → 426, measured: promise +14 and
      generators +14 (the regime lowers them through the native object
      runtime, which registers the 14-import admitted-object MOP — the same
      set core/regexp/errors already carry), date +3 (string bridge),
      functionBind +2 (callable-kind), typedArrays/errors −1 each
      (instance-wiring). All added imports are `value-adapter`.
- [x] 321-row sample 219/321 — equal to the S1 before-state, per-test
      identical (0 lost, 0 gained).
- [x] `wrapCompiledExports` live-view / copied-value / opaque-handle policies
      unchanged (`tests/issue-4399*` green; no runtime.ts change).

## Test Results (2026-09-26)

Re-keyed to `jsValueBoundary(ctx)` (≡ `hostValueInterop === "required"`, i.e.
JS embedder + bridge on; `"enabled"` is the host-free `hostBridge: "always"`
projection the standalone test262 harness uses, which may not import `env::*`
value adapters):

1. `ensureNativeStringBoundaryBridge` (native-strings.ts) — string marshal at
   exports. Alone this flipped 14 of the 18 regime reds.
2. `__ir_dyn_call_boundary_extern` (dyn-ops.ts) — a JS object reaches tag 6 as
   a parked non-eq externref; hand it back instead of a null receiver (fixes
   `any`-receiver method calls on admitted objects: DataView, dynamic ops).
3. `tryEmitInlineDynamicCall` / `buildInlineDynamicDispatch` (calls.ts) — the
   `__boundary_callback_call_N` fallback arms; under the regime the host arm
   is composed behind a Wasm-owned (`ref.test eq`) test so native closures
   keep the in-Wasm apply fallback (without that guard the sample dropped
   219 → 179: "value is not an admitted JavaScript boundary callback"). The
   `__is_callable` guard now registers `__boundary_object_callable_kind`
   (new `ensureBoundaryCallableKind`, shared with `ensureNativeProxyRuntime`).
4. `needsHostFacadeUnwrap` (closure-exports.ts, both sites) — a compiled
   object handed back into a closure export arrives as a host facade.
5. Leak scan (index.ts) keyed on `targetProfile.target === "standalone"` —
   the #2961 audit of the standalone deliverable — not on the regime.

Not changed (provider-question arms): struct-field Symbol exports
(`__box_symbol`/`__unbox_symbol` vs native `$Symbol` — the regime already
round-trips symbol fields correctly), `hostStringBridgeUsable` (owned by the
S1 console follow-up), `js-errors.ts` (error translation already green once
strings marshal).

New regression test: `tests/issue-6686-js-value-boundary-regime.test.ts`
(5 tests; sets the env var itself, 4 fail on the base).
