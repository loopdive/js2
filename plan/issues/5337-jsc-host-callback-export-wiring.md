---
id: 5337
title: "Compiled modules break on JavaScriptCore: host-callback dispatch finds no exports"
status: in-progress
sprint: current
created: 2026-09-05
updated: 2026-09-05
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

## Reproduced under V8 — the symptom class is "export set never published"

An instance whose exports are never published (`setInstance` not called) does
**not** fail loudly. It parses anyway, wrongly:

```
Since Acorn 8.0.0, options.ecmaVersion is required.
Defaulting to 2020, but this will stop working in the future.
unwired instance: THREW — Cannot read properties of null (reading 'replace')
second wired instance: parse OK — 18 nodes
```

That is both iOS symptoms, verbatim, on Node/V8 — no WebKit needed. So the
mechanism is established: **the module could not see its own export set at call
time.** Property reads on a host object and closure dispatch both route through
exports-backed marshalling, which is why the options object reads as empty AND
`__call_fn_0` is unavailable.

What is *not* yet established is why publishing fails on JSC specifically.
`setInstance` throws on a non-instance rather than no-opping
(`src/runtime/instance-lifecycle-adapter.ts:67`), and the panel would have
surfaced that, so the plausible remainder is `prepareExports` establishing only
a partial set under JSC, or a second instantiation attempt (Safari's failed
native-`js-string` attempt precedes the polyfill fallback) leaving the runtime's
per-closure caches bound to the first, dead instance.

No WebKit engine is reachable from the dev container: Playwright's webkit
download fails and `js2wasm.loopdive.com` is proxy-blocked (403). Fixing the
wiring blind would touch a path every compiled-module consumer depends on, so
the next step is one iOS screenshot with the diagnostics below, not a patch.

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

1. **Done — canary + diagnostics.** The panel now proves the boundary at load
   with a one-token parse (`parse("0")` must round-trip `0`). When it fails, the
   status says the boundary is not live and the error is a symptom, not the
   user's source; any non-syntax parse error also reports which instantiation
   branch ran, whether `setInstance` was wired, and the export count.
   `tests/playground-acorn-artifact.test.ts` pins the unwired reproduction.
2. **Next — one iOS screenshot** of the AST tab with the new build. Its status
   line distinguishes: boundary not live (wiring) vs. live-but-throwing
   (something else), plus branch/export facts.
3. Root-cause from that report; fix in `src/runtime.ts`; regression test.

## Open question

Whether other compiled-module consumers are affected on JSC — the playground's
own compile-and-run path passes DOM callbacks across the same boundary, so the
`calendar.ts` preview may fail on iOS for the same reason. Worth checking once
the mechanism is known.
