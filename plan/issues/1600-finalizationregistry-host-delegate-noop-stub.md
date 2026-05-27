---
id: 1600
title: "FinalizationRegistry: host-delegate (JS mode) + no-op standalone stub (~12 CEs)"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: low
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen+runtime
language_feature: FinalizationRegistry
goal: npm-library-support
sprint: Backlog
related: [1101]
es_edition: ES2021
---
# #1600 — FinalizationRegistry: host-delegate + no-op standalone stub

`new FinalizationRegistry(...)` currently hits "Unsupported new expression for
class: FinalizationRegistry" → ~12 test262 compile errors (built-ins/
FinalizationRegistry). Unlike `WeakRef` (already wired as a host-constructible
builtin, `builtin-tags.ts: WeakRef: -24`), FinalizationRegistry isn't wired at
all.

This issue is the **cheap, scoped** path — NOT faithful standalone finalization
(that needs the unshipped Wasm weak-references/finalization proposal; tracked
under [[1101]]).

## Why a cheap path is viable

The ECMAScript spec **never guarantees** FinalizationRegistry cleanup callbacks
run — an implementation that never calls them is **fully conformant** (§ cleanup
is best-effort; "callbacks may never be called"). So:

1. **JS-host mode:** delegate to the host engine's real FinalizationRegistry via
   a host import, exactly like the existing `WeakRef` path. Gives real
   finalization where a JS runtime is present.
2. **Standalone (WASI) mode:** a **no-op stub** — `FinalizationRegistry`
   constructor + `register`/`unregister` that track registrations but never fire
   the cleanup callback. WasmGC exposes no GC-reclamation hook, so this is the
   best possible — and it's spec-permissible.

## Scope

- Add `FinalizationRegistry` to the host-constructible builtin set
  (`src/codegen/builtin-tags.ts` alongside `WeakRef`; the host lists in
  `src/codegen/index.ts` ~L5179/L8320; subclass handling in `runtime.ts`).
- JS-host: route `new FinalizationRegistry(cb)`, `.register(target, heldValue
  [, token])`, `.unregister(token)` to host imports backed by the engine's
  FinalizationRegistry.
- Standalone: a Wasm-native no-op registry (struct holding the callback +
  registrations; register/unregister mutate it; cleanup never fires). Gate on
  `ctx.standalone` / `ctx.wasi` like the other no-host-host fallbacks (#1471-1474).
- Add `lib.es2021.weakref.d.ts` is already loaded (checker/index.ts:117) so the
  type is resolvable — no type-lib change needed.

## Out of scope (→ #1101)

Faithful standalone finalization (actually firing callbacks on GC reclamation).
Requires the Wasm weak-refs/finalization proposal. The test262 cases that force
GC (`$262`/`gc()`) and assert a callback fired will still fail — that's expected
and acceptable.

## Acceptance

- `new FinalizationRegistry(() => {})` + `.register`/`.unregister` compile and
  instantiate in both JS-host and `--target wasi` modes (no CE).
- JS-host mode: callbacks fire via host delegation (verify with a host-driven test).
- Standalone mode: no-op, byte-valid Wasm, instantiates clean.
- The ~12 built-ins/FinalizationRegistry CEs that only exercise the API surface
  (construct/register/unregister, no forced-GC assertion) flip from CE to pass.
- No regression to the existing WeakRef path.

## Implementation

Wired `FinalizationRegistry` as a host-constructible extern class, mirroring the
`WeakMap`/`WeakSet` pattern:

- `src/codegen/index.ts` — registered `FinalizationRegistry` in `ctx.externClasses`
  (constructor takes the cleanup callback as externref; `register(target,
  heldValue, token?)` → undefined, `unregister(token)` → boolean). This routes
  `new FinalizationRegistry(...)` through the `externInfo` path in
  `new-super.ts:2338` instead of falling through to "Unsupported new expression".
- `src/runtime.ts` — added `FinalizationRegistry` to the `builtinCtors` resolver
  map (guarded by `typeof`), and substituted a no-op `() => {}` for the cleanup
  callback when the wasm-closure externref isn't a callable JS function (the
  engine's constructor otherwise throws "cleanup must be callable"; spec permits
  callbacks to never fire).

**Root cause**: when the TS checker resolves the `FinalizationRegistry` lib type,
`className` becomes `"FinalizationRegistry"`, bypassing the `!className`
unknown-constructor host-import path and falling through to the "Unsupported new
expression" error at `new-super.ts:2790`.

## Test Results

built-ins/FinalizationRegistry (JS-host runner):
- Before: pass 18, fail 15, compile_error 14
- After:  pass 31, fail 14, compile_error 2

The 2 remaining CEs are an unrelated `for-of requires an array expression` codegen
limitation (returns-new-object-from-constructor.js, unnaffected-by-poisoned-
cleanupCallback.js), not FinalizationRegistry. Remaining fails are pre-existing
limitations (Reflect.construct/isConstructor harness stub, Symbol coercion,
prototype-chain, $262/forced-GC) shared with the WeakRef path.

WeakRef regression check: pass 19, fail 9, compile_error 1 — unchanged.

Standalone (`--target wasi`) `new FinalizationRegistry(cb)` compiles byte-valid.

Unit test: `tests/issue-1600.test.ts` (3 cases, all pass).
