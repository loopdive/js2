---
id: 5295
title: "The runtime-eval global mirror stamps `configurable: false` on MODULE bindings, so the program cannot redefine its own globals"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

When a module needs the runtime-eval global environment,
`emitRuntimeEvalGlobalBindingPushBody` mirrors each top-level binding onto the
global object and picks the descriptor attributes with:

```ts
const attributes = isScriptBinding ? 0x23 : 0x05;
```

`0x23` specifies exactly one attribute — `configurable: false` — which is
§9.1.1.4.16 CreateGlobalFunctionBinding's rule for a **script**. A module's
top-level function/var bindings are not global-object properties at all, so
applying it there is not the spec attribute; it is a fabricated one, and it
takes the name away from the program:

```js
function beforeEach(body) { /* … */ }
// mirror runs first and creates globalThis.beforeEach as {configurable: false}
Object.defineProperty(globalThis, "beforeEach", { configurable: true, writable: true, value: fn });
// → TypeError: Cannot redefine property: beforeEach
```

The throw happens inside `__module_init`, so nothing in the module runs.

## Where it bites

The upstream-suite shim (`tests/dogfood/upstream-suite-runner.mjs`) installs
its four vitest hooks in exactly that shape — a `function beforeEach(…)`
declaration plus an `Object.defineProperty(globalThis, "beforeEach", …)`.

Traced with `Object.defineProperty` instrumented around a real compile of
`.axios-upstream-suite-generated/tests/unit/core/mergeConfig.test.ts`:

```
[dP] beforeEach desc={"configurable":false} onGlobal=true
    at __runtime_eval_push_globals (wasm-function[614])
    at __module_init_chunk_13 …
[dP] beforeEach desc={"writable":true,"configurable":true} onGlobal=true
    at __module_init_chunk_20 …
init threw: TypeError: Cannot redefine property: beforeEach
```

`tests/unit/core/mergeConfig.test.js` is **0/57** for this reason alone — every
test reports `module init: TypeError: Cannot redefine property: beforeEach`.

## Fix

Two parts, both scoped to the module path so script behaviour is byte-identical:

1. Keep the script rule for scripts; on the **JS host lane only**, mirror a
   module's binding as an ordinary writable, configurable global so user code
   keeps ownership of the name:

   ```ts
   const attributes = isScriptBinding ? (ctx.sourceIsModule ? 0x2d : 0x23) : 0x05;
   ```

   `0x2d` sets the specify-and-value bits for `writable: true` and
   `configurable: true` and leaves `enumerable` unspecified, so it does not
   disturb an attribute the program set itself.

2. Carve `undefined` / `NaN` / `Infinity` **out of that carve-out**, keeping
   the pre-existing `0x23` spelling for them. They are the §19.1 immutable
   global properties — non-writable **and** non-configurable — so specifying
   `configurable` throws on them; the old attributes survived only because
   `0x23` specifies `configurable: false`, which already matches what is there.
   `var undefined;` at module scope is a common idiom in published packages
   (axios reaches it through `get-intrinsic` / `function-bind`), and without
   this carve-out part 1 throws on `undefined` before axios gets anywhere.

   The names stay **in** the mirror. An earlier cut dropped them from the name
   list instead, which desynchronised the push and pull helpers and tripped the
   pull's lexical-cell `ref.as_non_null` invariant (`dereferencing a null
   pointer` in `__module_init`).

## Measured

- **axios: 108/231 → 190/231 (+82).** `tests/unit/core/mergeConfig.test.js`
  goes 0/57 → **57/57**; `buildURL` 0/20 → 14/20, `fromDataURI` 0/12 → 8/12,
  `transformResponse` 0/6 → 1/6, `transformData` 0/4 → 2/4, `isX` 11/14 → 11/14.
- `tests/module-eval-mirror-global-attributes.test.ts`: the
  function-declaration shape fails on the parent commit and passes with the
  fix. The other four cases are guards — two of them (`var undefined`, and
  `NaN`/`Infinity`) pin exactly the regression part 1 would otherwise
  introduce, and the last checks the mirror still exposes a top-level function
  binding to `eval`.

## Not fixed here

`var undefined;` in a module that also has an indirect eval throws
`Cannot redefine property: undefined` on the **parent** commit too — the
mirrored value is not yet SameValue with the existing global when the define
runs. That predates this change and is a separate defect; the carve-out keeps
it exactly as it was rather than making it worse.

## Why the JS host lane only

The first cut applied the new attributes on every lane and **broke the quickjs
eval-provider's build-time canary**: `membraneProbe() returned -1, expected
4321` — the #4245 inward-membrane probe threw instead of reading its four
digits. That canary compiles `target: "standalone"`, and it is a non-required
CI check, so the PR sat `UNSTABLE` and `auto-enqueue` would never have taken it.

The narrowing is not a workaround, it is the correct scope. On the JS host the
global environment object **is** the real `globalThis`, so the program's own
`Object.defineProperty(globalThis, name, …)` competes with the mirror — that is
the conflict being fixed, and it is the only lane where it exists. Standalone
and WASI mirror onto a synthesized carrier the program never defines properties
on, and the canary is direct evidence that the existing attributes are
load-bearing there. Those lanes stay byte-identical.
