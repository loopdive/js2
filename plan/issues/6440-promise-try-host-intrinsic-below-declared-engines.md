---
id: 6440
title: "`Promise.try` is lowered to a host intrinsic the declared `engines: node >=20` floor does not have"
status: done
sprint: current
created: 2026-09-13
completed: 2026-09-13
priority: medium
horizon: s
feasibility: easy
task_type: bug
area: runtime
goal: correctness
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::buildImports
---
<!--
  2026-09-13, #6440: `src/runtime.ts` grows by +1 line (`buildImports` +1) —
  one extra `globalSandbox: options?.globalSandbox` field on the existing
  `installAmbientCompatibility({...})` call site, wiring the new
  `Promise.try` polyfill install through it. `src/runtime.ts` is at the
  #4401 ceiling; the actual polyfill logic lives in the new
  `src/runtime/promise-try-polyfill.ts` module, not here — the naive version
  of this wiring (constructing the constructor list inline) added 7 lines and
  was moved into the new module instead (see ## Resolution below).
-->


## Problem

Residual from
[#6419](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6419-three-closure-area-tests-red-on-main)
arm 7.

On the JS-host lane the compiler lowers `Promise.try` straight onto the host's
`Promise.try`. That method landed in Node 23; `package.json` declares
`engines: { node: ">=20" }`. On Node 20/22 a compiled program using
`Promise.try` fails at runtime with `Promise.try is not a function` — and
nothing says so at compile time. The standalone lane lowers it natively and is
unaffected.

CI runs Node 24/25, so the whole repo is green on it. The gap surfaced only
because `tests/issue-2637-b2-ctor-closure-registration.test.ts` was run on a
Node 22 box, where its `Promise.try` row failed for a reason that had nothing
to do with the ctor-registration behaviour under test. #6419 gated that row on
`typeof Promise.try === "function"` — a correct thing for that test to assert,
and not a fix for this.

## The decision to make

Three options, and the point of this issue is to pick one rather than leave the
mismatch implicit:

1. **Polyfill it** next to the existing host-lane Promise handling. Note the
   constraint: `src/runtime.ts` is AT the #4401 ceiling, so new runtime code
   belongs in `src/runtime/<module>.ts`, and a library that mutates the host's
   global `Promise` is a real decision, not a detail.
2. **Raise the floor** to the engine that actually supports what the host lane
   emits (`engines: node >=23`), and say so in the README.
3. **Refuse at compile time** on a host target below the floor, with a
   diagnostic naming the method and the required engine.

## Acceptance criteria

1. One of the three is implemented, and the reasoning is written down where a
   reader meets it (`docs/` or the lowering site).
2. `engines` and the host lane agree, in whichever direction is chosen.
3. A test that fails on the unsupported host rather than silently producing a
   runtime `TypeError` at the call site.

## Implementation Plan

**Measured on upstream/main 54c36a9fe3, Node v22.23.2** (`.tmp/probe-6440.mts`): host lane lowers `Promise.try(fn)` to `__get_builtin("Promise")` + `__extern_method_call_1("try")` (imports: `__extern_method_call_1 __get_builtin …`); instantiate + `__module_init` throws `TypeError: try is not a function` — the generic arm in `src/runtime.ts` `resolveImport` `name === "__extern_method_call"` (~L14694), not a Promise-specific one. `target: "wasi"` compiles the same source with **zero** imports (native lowering, unaffected). No dogfood package calls `Promise.try` (grep over tests/dogfood and hono/jest/prettier dist: none), so this is a user-facing floor gap, not a dashboard mover.

**Decision: option 1 — spec-shaped polyfill, installed only when the intrinsic lacks it.** Precedent: `_installIteratorHelperPolyfills` (#1464, `src/runtime/iterator-polyfills.ts:552`) already mutates `globalThis.Iterator` from `installAmbientCompatibility` (`src/runtime/compatibility-adapter.ts:16`). Options 2/3 rejected: raising the floor to 23 drops two LTS lines for one method; a compile-time refusal cannot know the eventual host. Write that reasoning in the new module header (AC1).

1. **New module `src/runtime/promise-try-polyfill.ts`** (`src/runtime.ts` is at its #4401 LOC ceiling — do not touch it beyond the one option plumb below). Export `_installPromiseTryPolyfill(C: unknown): void`: no-op unless `typeof C === "function" && typeof (C as any).try !== "function"`; then `Object.defineProperty(C, "try", { value, writable: true, enumerable: false, configurable: true })` where `value` is a plain `function try_(callbackfn, ...args)` (spec §27.2.4.8): `if (this == null || typeof this !== "object" && typeof this !== "function") throw TypeError`; build the capability via `new this(function(res, rej){ resolve = res; reject = rej })` (NewPromiseCapability(C) — so `Promise.try.call(SubPromise, …)` still runs the #2637 B2 subclass ctor exactly once); call `callbackfn.apply(undefined, args)` inside try/catch → `resolve(value)` / `reject(e)`; return the promise. Set `name: "try"`, `length: 1` via `defineProperty`. Idempotent (re-install is a no-op because `try` is now present).
2. **Wire it** in `installAmbientCompatibility` (`src/runtime/compatibility-adapter.ts`): add optional `promiseConstructors?: unknown[]` to `AmbientCompatibilityOptions`; install on each. Caller in `src/runtime.ts` (~L19011) passes `[Promise, options?.globalSandbox?.Promise]` (dedupe when identical) — the sandbox Promise matters because `builtin(n, …)` (~L11026) resolves `__get_builtin("Promise")` to `globalSandbox.Promise` for coherent realms, and `Promise_new` (~L16940) already uses `globalSandbox?.Promise ?? Promise`. Order: keep the call before any compiled `__module_init` (it already is). Register the new export so `check:dead-exports` sees a consumer.
3. **Docs / engines agreement (AC2):** keep `engines: node >=20`; add one sentence to `README.md` ~L234 and `docs/getting-started.md` ~L102: "`Promise.try` (Node 23+) is polyfilled by the JS-host runtime on older engines".
4. **Un-skip** the `Promise.try` row in `tests/issue-2637-b2-ctor-closure-registration.test.ts` (~L88–104): drop `hostHasPromiseTry`/`skipIf` and the `needsHostPromiseTry` column — with the polyfill the row is a real Node 20/22 regression check.

**Probe first:** re-run `.tmp/probe-6440.mts` (kept under `.tmp/`) — fails on parent with `try is not a function`, must print `hits: 1 p: {…}` after step 1–2.

**Regression test `tests/issue-6440-promise-try-polyfill.test.ts`** (host-version-independent, so it is meaningful on CI's Node 24/25): compile `var p = Promise.try(function(){ hits = 1; return 7 }); export function test(){ return hits }` (untyped body, `skipSemanticDiagnostics`), instantiate with `buildImports(…, { globalSandbox })` where the sandbox is a `node:vm` context whose `Promise.try` has been `delete`d and which is registered via `markCoherentBuiltinRealm` (pattern: `tests/issue-2623-p7b-observable-resolve.test.ts:28-56`). Assertions: (a) `__module_init` does not throw and `test()===1`, `await p === 7` — fails on parent (`try is not a function`), passes with fix; (b) a throwing callback yields a rejected promise, not a sync throw; (c) **anti-vacuity**: same sandbox but `Promise.try = spy` — spy is invoked and its identity unchanged (polyfill never overwrites an existing `try`); and `Promise.try === before` on the real global when the host already has it. Also add a `Promise.try.call(SubPromise, fn)` row through the sandbox to lock NewPromiseCapability(C).

**Expected movement:** dogfood anchors unchanged (webpack 16/16 · three 17/18 · … · hono ~261/324) — CI hosts have the intrinsic, polyfill is a no-op there. test262 `Promise/try/*` unchanged on CI for the same reason. Standalone lane: zero change (no imports emitted for `Promise.try` on this HEAD). Gates: run the five ratchet gates chained before commit; `src/runtime.ts` grows by ≤3 lines — if the LOC gate trips, move the constructor-list construction into the new module.

## Dispatch

**sonnet** — runtime-only, fully specified (exact spec steps, install site, realm plumbing, test shape), no codegen or ordering hazards; the only judgement call (option 1) is already made above.

## Resolution

Implemented as planned, with two adjustments made during implementation:

- The constructor-list de-dupe (`[Promise, globalSandbox?.Promise]` minus
  duplicates) was moved into the new module as `_promiseTryTargets`, exported
  from `src/runtime/promise-try-polyfill.ts` and called from
  `installAmbientCompatibility` (`src/runtime/compatibility-adapter.ts`) rather
  than at the `src/runtime.ts` call site, per the plan's own fallback
  ("if the LOC gate trips, move the constructor-list construction into the
  new module") — the naive version added 7 lines to `buildImports` and tripped
  both the LOC and function budget gates; the moved version adds exactly 1
  line (`globalSandbox: options?.globalSandbox`) to the existing
  `installAmbientCompatibility({...})` call site.
- `plan/audit/host-import-policy-baseline.json`'s `maximumRuntimeTsLines`
  (19735 → 19736) and `maximumOwnedAdapterLines` (819 → 824, matching the new
  `promise-try-polyfill.ts` module counted as owned-adapter surface) were
  bumped to the merged values, following the existing per-PR-bump precedent
  for that file (e.g. commit `95cbc7239b`, "host-import runtimeTsLines ceiling
  to the merged 19735") — this file is a tracked migration ceiling under
  `plan/audit/`, not one of the `scripts/*-baseline.json` ratchet files main
  alone refreshes.
- `scripts/compiler-boundaries.json` classifies the new
  `src/runtime/promise-try-polyfill.ts` module (owned runtime adapter,
  alongside `iterator-polyfills.ts` / `legacy-regexp.ts`).

Verified: `.tmp/probe-6440.mts` reproduces the Node 22 failure on the base
commit (`try is not a function`) and passes after the fix (`hits: 1`).
`tests/issue-6440-promise-try-polyfill.test.ts` (5 cases, host-version
independent via a `node:vm` sandbox with `Promise.try` deleted) and the
un-skipped `Promise.try` row in
`tests/issue-2637-b2-ctor-closure-registration.test.ts` both fail on the
pre-fix source and pass on the fix (checked both ways). No dogfood package
calls `Promise.try`; no test262/dogfood movement expected or observed.
