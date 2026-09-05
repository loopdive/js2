---
id: 5337
title: "Compiled modules break on JavaScriptCore: host-callback dispatch finds no exports"
status: done
completed: 2026-09-05
sprint: current
created: 2026-09-05
updated: 2026-09-05
loc-budget-allow:
  # 2026-09-05: +9 lines in runtime.ts — one import block and three one-line
  # call-site swaps to the new src/runtime/exported-function-identity.ts;
  # the mechanism itself lives in that module.
  - src/runtime.ts
func-budget-allow:
  # 2026-09-05: +1 line — buildImports re-mints the association token via
  # installFreshDataStructAssociationToken (one call).
  - src/runtime.ts::buildImports
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: correctness
---

## Problem

On iOS Safari (JavaScriptCore) the playground's AST panel fails where Chrome and
Node succeed. Two console lines, from the deployed build:

```
[Error]   TypeError: wasm closure dispatcher __call_fn_0 is not available
[Warning] Since Acorn 8.0.0, options.ecmaVersion is required.
          Defaulting to 2020, but this will stop working in the future.
```

Both come from inside the compiled module's host boundary, and together they say
the same thing twice:

1. **The warning is acorn's own.** Compiled acorn could not read `ecmaVersion`
   off the options object the host passed to `parse(src, opts)` — the object
   crossed the boundary, but its properties read as absent. Everything after
   that runs on default options, which is how the user-visible
   `Cannot read properties of null (reading 'replace')` arises: that message is
   **ours**, thrown by `src/runtime.ts:14068` in `__extern_method_call` when a
   compiled method call has a null receiver. The most likely site is acorn's
   `keywordRegexp(words)` (`dist/acorn.mjs:279`), whose keyword-table lookup is
   indexed by `options.ecmaVersion` / `options.sourceType`.
2. **`__call_fn_0 is not available`** is thrown by `src/runtime.ts:2365` when
   `callbackState.getExports()?.__call_fn_0` is not a function.

So a compiled module that takes a host object or host callback misbehaves under
JSC. The AST panel is the first consumer to surface it; it is not a panel bug.

## What is already ruled out

- **The export is present.** `website/public/acorn/acorn.wasm` exports 611
  symbols including `__call_fn_0..4` and `__call_fn_method_0..8`. The dispatcher
  exists; the *lookup* failed, i.e. `getExports()` returned undefined or a
  partial set at call time.
- **Not the js-string-builtins fallback.** Safari has no `js-string` builtins, so
  `instantiateWasm` takes its polyfill branch. Simulated exactly (rejecting the
  3-argument `WebAssembly.instantiate` so the real `instantiateWasm` falls back):
  `nativeBuiltins: false`, and `parse` returned a correct 18-node Program. The
  branch itself is sound under V8.
- **Not the parse input.** Fixed separately (PR #5603): the panel used to feed
  acorn the generated `example.js` usage-example tab. It now feeds the user's own
  source with TS syntax blanked in place, verified in Chrome.
- **Not a stale deployment.** Pages deploys #7880/#7881 (2026-09-05 17:55 and
  18:50 UTC) succeeded on revisions containing the fix.

## Root cause — reproduced on real JavaScriptCore

WebKitGTK ships the same engine as iOS Safari as a shell (`jsc`,
`apt-get install libjavascriptcoregtk-bin`). Running the panel's exact load
sequence there (`node scripts/jsc-acorn-smoke.mjs`) reproduced both console
lines and the null `.replace`, and tracing the host imports found the chain:

```
__new_plain_object()                      acorn getOptions: options = {}
__for_in_keys(defaultOptions)  -> []      the compiled object literal enumerates as EMPTY
__extern_get(options, "ecmaVersion") -> undefined   → acorn's warning → keywords null → .replace
```

`__for_in_keys` enumerates a WasmGC struct through the exported
`__struct_field_names` helper, and that helper — with every `__call_fn_*`
closure dispatcher — had been **masked to `undefined` by the runtime's own
host-bridge authentication**, not lost by the engine. `_hostBridgeExportView`
accepts a helper only if the frozen export (`instance.exports.$d1`) is `===`
the entry the compiler placed in its binding table (`bindings.get(1)`). The JS
API requires both reads to yield the one cached Exported Function object, and
V8 honours it. JavaScriptCore does not — two deviations, both confirmed with
minimal probe modules:

| Probe (`.tmp/jsc-probe*.js`) | V8 / Node 22 | JSC (WebKitGTK 2.52.6) |
| ---------------------------- | ------------ | ---------------------- |
| `instance.exports.f === table.get(0)` for the same function | `true` | `false` (each wrapper stable on its own, never equal to the other) |
| imported `WebAssembly.Global` re-exported: `exports.x === g` | `true` | `false` |

So on JSC the closure bridge lost all 18 helpers (`__call_fn_0 is not
available`), and the data-struct bridge failed twice over (helper identity and
the association-token Global identity). `setInstance` was called and succeeded;
"the export set was never published" — the earlier V8-only hypothesis — was
wrong: the exports were published and then every authenticated one masked.

## Fix

`src/runtime/exported-function-identity.ts`:

- `sameExportedFunction(helper, binding)` — strict `===` first. Only where a
  one-time probe module shows the engine splits identities does it fall back
  to: both sides are genuine Wasm functions (only those can enter a funcref
  table) with the same function index (an Exported Function's `name`). JS
  impostors and a different function of the same instance still fail closed;
  the one case the fallback cannot split — the same index in another instance
  of the same module — runs the same code.
- `sameAssociationToken(token, expected)` — identity first; on a
  non-canonicalizing engine, compare the Globals' values. To make that exact,
  `buildImports` re-mints the token Global with a **fresh frozen object per
  call** (`installFreshDataStructAssociationToken`), so two builds' tokens
  never compare equal by value either.
- The four identity sites in `src/runtime.ts` and the one in
  `standalone-timer-callback-bridge.ts` route through these. V8 behaviour is
  unchanged (the probes report canonical there, so only the strict path runs).

Verified: `scripts/jsc-acorn-smoke.mjs` → `PASS` on real JSC (canary `0`
round-trips, a class + arrow sample parses); `tests/issue-5337-…` pins the
mechanism on V8; the #3520 bridge-ABI suites (donor rejection, forged tables,
same-funcref substitution) still pass.

## Acceptance criteria

1. The failing call is identified: which value reaches `__extern_method_call`
   as null, and why `getExports()` is empty at the `__call_fn_0` dispatch.
2. Reading a property off a host-supplied plain object from inside a compiled
   module returns the same value on JSC as on V8.
3. A regression test covers the host-object property read and the zero-arg
   callback dispatch, at a level that would have caught this without a browser
   (see "Open question" below — a V8-only test did not catch it, so a test that
   only runs under V8 may not be sufficient).

## Plan

1. **Done — canary + diagnostics** in the panel (`parse("0")` at load; status
   names the instantiation branch and export facts on a non-syntax error).
2. **Done — root cause on real JSC**, see above.
3. **Done — fix + tests**: `src/runtime/exported-function-identity.ts`,
   `tests/issue-5337-exported-function-identity.test.ts`,
   `scripts/jsc-acorn-smoke.mjs` (skips when no `jsc`; CI has none, so it is
   a developer check, not a gate).

## Open question

Every compiled-module consumer on JSC was affected — the masking is in
`_hostBridgeExportView`, which every `buildImports`/`wrapExports` path goes
through — so the playground's compile-and-run preview (`calendar.ts` DOM
callbacks) was almost certainly failing on iOS for the same reason. Not
re-verified in Safari itself: this container has no WebKit browser, only the
engine. One iOS load of the deployed playground after this lands closes it.
