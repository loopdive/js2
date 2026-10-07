---
id: 6890
title: "native regime in a JS environment: `console` read as a VALUE is null — react's `console.createTask` feature test throws at module init"
status: ready
created: 2026-10-07
updated: 2026-10-07
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: architecture
parent: 6749
related: [5385, 6671, 6685, 6749, 6877]
requested_by: ttraenkler/opus-6877
---

# #6890 — `console` as a value under the native regime in a JS environment

## Problem

Found while landing #6877 (react's cross-module bare-name collisions). With
#6877, react measures on the `js-host` npm-compat lane (checksum 8 = Node's),
but `js-host-native` still dies at module init:

```
runtime-error @ module-init: TypeError: Cannot access property on null or undefined at 681:5
```

That is react.development.js's feature test (rewritten line 681 = source line
678, the `var … createTask = console.createTask ? console.createTask : …`
list). Replacing `console.createTask` with `(void 0)` in a copy of the package
makes the same lane measure with checksum 8 (unoptimized probe, 2026-10-07).

Three-line reduction (`compileProject`, `platform: "node"`,
`semanticProviders: "native-first"`):

```js
// dev.js
(function () {
  var createTask = console.createTask;   // also: console.log as a value, or `var c = console; c.createTask`
  exports.va = function () { return typeof createTask; };
})();
// main.js
import dev from "./dev.js"; export function va() { return dev.va(); }
```

→ uncaught `WebAssembly.Exception` at instantiation. The module imports no
console capability for the read, and `globalThis.console` is `undefined` (the
regime's `globalThis` is the Wasm-native global object).

## Why it falls through

- `standalone-console-object.ts` `isStandaloneAmbientConsoleRead` declines in a
  JS environment (#6685: "a JS environment takes the existing declared-global
  capability route").
- That route does not exist under the regime: `extern-declarations.ts`
  `collectDeclaredGlobals` skips every `global_<name>` when `ctx.standalone`,
  and `identifiers.ts`'s host `console`-as-value arm (#4618,
  `__get_globalThis` + `__extern_get`) is gated `!ctx.standalone`.
- So the read reaches the graceful `ref.null.extern` default.

## Direction (to decide)

Either (a) the Wasm-native console object (#6671) in a JS environment too, with
its methods calling the host console capability (`console_log_*`, #6685) rather
than the `__stdout_*` sink the environment no longer mints; or (b) a declared
console capability import under the regime. (a) keeps `globalThis`-shaped
semantics Wasm-owned and adds no host import; (b) is smaller. Either way
`console.createTask` must read `undefined` (react takes its fallback) and
`pnpm run check:host-import-policy` must stay 0 legacy / 0 unknown.

## Acceptance

- [ ] The reduction above runs (`va() === "undefined"`) on the regime; default
      gc / standalone / wasi bytes unchanged.
- [ ] react measures on `js-host-native` with Node's checksum (the remaining
      #6877 acceptance box).
