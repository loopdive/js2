---
id: 6711
title: "lodash standalone-dynamic: realm object lacks Function/TypeError/Date/RegExp/String/Error when a runtime-eval site exists but no provider is linked"
status: done
sprint: current
created: 2026-09-27
completed: 2026-09-27
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6703, 6683, 6651, 6713]
---

# #6711 — standalone realm constructors missing in a provider-less runtime-eval module

## Problem

After [#6703](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6703-lodash-standalone-optimization-error-invalid-raw-module)
the lodash 4.18.1 npm-compat **standalone-dynamic** lane reported (re-measured
on `c2601efa89`):

```
runtime-error (phase: module-init): TypeError: Cannot access property on null or undefined at 1468:21
```

The line points at `var coreJsData = context['__core-js_shared__'];`, but a
stage probe (`__stage = N` markers, with `runInContext()` wrapped in a
try/catch) showed the throw is between the `var Array = context.Array, …,
TypeError = context.TypeError;` block and the `arrayProto/funcProto/objectProto`
reads: `Function.prototype` where `Function` is `context.Function`.

`context` is lodash's realm object (`root = freeGlobal || freeSelf ||
Function('return this')()`), which in standalone is the native `globalThis`
singleton. Its constructor seed (`appendStandaloneGlobalConstructorSeeds`)
installs `Function`, `String`, `Date`, `RegExp`, `Error`, `TypeError`, … only
when the module has **no** runtime-eval boundary site. `Function('return
this')` is such a site, so only `Symbol`/`ArrayBuffer`/`DataView`/`Promise`
were seeded and `context.Function` read `undefined`.

The gate exists because, with a provider linked, the eval boundary builds its
own callable constructor carriers and re-entering the full constructor emitter
while the realm object is being built recursed. With **no** provider
(`runtimeEvalProvider: false`, which is exactly what every npm-compat
standalone lane passes) the boundary builds nothing: every `%Function%` read
already takes the self-contained carrier (#6683).

Reduction (standalone, `runtimeEvalProvider: false`): the lodash
`runInContext` idiom reads `typeof context.Function` → `"undefined"` and
`context.Function.prototype` throws; with `root = globalThis` instead of
`Function('return this')()` all constructors are present.

## Implementation Plan

Executed 2026-09-27:

1. `src/codegen/standalone-global-object-carriers.ts`
   `appendStandaloneGlobalConstructorSeeds`: treat the module as a
   runtime-eval module only when a provider can exist —
   `evalModule = sites > 0 && !isRuntimeEvalProviderAbsent(ctx)`.
   Provider-linked modules (the test262 standalone lane, which never passes
   `runtimeEvalProvider: false`) keep the eval-safe list byte-for-byte.
2. Regression test `tests/issue-6711-standalone-realm-ctors-without-eval-provider.test.ts`
   (the lodash context idiom; zero imports; checks the eight constructors'
   `typeof` and that `Function.prototype` reads).

## Resolution

- Regression test: parent **fails** (`expected 100003 to be 511` — only
  `Array`/`Object` present, `Function.prototype` throws), fix **passes** (511).
- lodash standalone-dynamic lane: `TypeError: Cannot access property on null or
  undefined at 1468:21` → next blocker, verbatim:
  `TypeError: Cannot read properties of undefined (reading 'test')`
  (`phase: module-init`, optimization verified, 2,518,830 bytes, 0 imports).
  Mechanism filed as
  [#6713](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6713-standalone-dynamic-regexp-carrier-call-construct):
  calling / constructing the `RegExp` constructor carrier held as a dynamic
  value (`var RegExp = context.RegExp; RegExp(src)`) does not produce a RegExp,
  so lodash's `reIsNative` is not a RegExp and `baseIsNative`'s
  `pattern.test(…)` throws.
- Scope: only modules compiled with `runtimeEvalProvider: false` change; the
  test262 standalone lane (provider linked) and JS-host (`!standalone`) take
  the old path. Scoped standalone test262 (`built-ins/global` +
  `built-ins/Function/prototype/*.js`, 46 rows, quickjs provider): parent
  41 pass / 5 fail, fix 41 / 5, identical non-pass sets.
- npm-compat standalone-dynamic lanes that were `measured` before stay
  `measured`, 0 imports, with the fix: moment, hono, redux, clsx, cookie, uuid,
  marked, acorn, react.
