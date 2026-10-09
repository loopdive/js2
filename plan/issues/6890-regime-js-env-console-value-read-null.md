---
id: 6890
title: "native regime in a JS environment: `console` read as a VALUE is null — react's `console.createTask` feature test throws at module init"
status: done
assignee: ttraenkler/opus-6890
created: 2026-10-07
updated: 2026-10-07
completed: 2026-10-07
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
loc-budget-allow:
  # 2026-10-07 (#6890): +1 line — the existing `wrapConsoleForHost(...)` call
  # site gains one argument (`_nativeDynamicFromHost`) and prettier wraps it to
  # two lines (134 > 120 cols). The logic lives in runtime/console-host-marshal.ts.
  - src/runtime.ts
func-budget-allow:
  # 2026-10-07 (#6890): same +1 line, the call-site wrap inside resolveImport.
  - src/runtime.ts::resolveImport
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

- [x] The reduction above runs on the regime; default gc / standalone / wasi
      bytes unchanged. (`va()` is the HOST's `typeof console.createTask` —
      `"function"` on Node 22 — since the regime now reads the host console;
      `tests/issue-6890-regime-console-value.test.ts`.)
- [x] react measures on `js-host-native` with Node's checksum (the remaining
      #6877 acceptance box).

## Implementation notes (2026-10-07, opus-6890)

Neither option as written: `console` is a PLATFORM capability (like `process`,
`Buffer`, `crypto`, `Intl`), so the ENVIRONMENT decides what the value is, not
the regime. Option (a) would hand a JS-environment module a Wasm-owned stand-in
console (no `createTask`, `console.log !== host console.log`); the regime should
see the host's console. So this is option (b), done through the value adapter:

- **Codegen** (`src/codegen/standalone-console-object.ts`): the ambient-read
  predicate is now regime-only (`isRegimeAmbientConsoleRead`), and
  `tryEmitStandaloneConsoleValue` asks `hostFreeEnvironment(ctx)`: host-free
  keeps the #6671 native console object (bytes unchanged); a JS environment
  with `jsValueBoundary(ctx)` emits `call global_console` — the declared-global
  capability — plus `ensureBoundaryCallableKind` so `typeof`/[[Call]] see the
  host methods as functions. No `__extern_get`, no `__get_globalThis`: member
  reads go through the native MOP's non-`$Object` arm, i.e.
  `__boundary_object_get`. A JS environment without the value bridge still
  declines (no MOP to read a host object with).
- **Policy** (`src/host-import-policy.ts`): `declared_global` named `console`
  classifies `platform-capability`/`console` (was the generic `global:console`).
- **Runtime** (`src/runtime/console-host-marshal.ts`): the console seam wraps
  the `global_console` capability so its result crosses the value boundary
  (`_nativeDynamicFromHost`), which ADMITS the host object for this instance —
  the boundary MOP serves only admitted objects. Inert for a gc module (an
  object crosses unchanged).
- `plan/audit/host-import-policy-baseline.json` `maximumOwnedAdapterLines`
  952 → 962 for the ten marshal lines (same file the #6685 seam was counted
  under). `check:host-import-policy`: 0 legacy / 0 unknown.

**Known limit:** a read executed in the wasm START section (a module compiled
without `deferTopLevelInit`) happens before exports exist, so nothing can be
admitted and the boundary MOP returns `undefined` for its members — the same
limit every `__boundary_object_*` operation has. npm-compat lanes (and react)
defer top-level init, so this does not bite there.

**Measured:** the reduction (and `typeof console.createTask === "function"`,
`f(console)`, `var l = console.log; l(...)`) returns the host's answers on the
regime (Node 22: `createTask` is a function). react on `js-host-native`:
measured, checksum 8 = Node (wasm-opt level 4 verified; 197 s compile on a
loaded box).
gc / standalone / wasi bytes: sha256-identical on a 7-shape probe × 3 lanes.

**`process.env.NODE_ENV` on the regime:** always `undefined`.
`property-access-dispatch.ts` lowers `process.env` to a fresh empty plain
object when `ctx.standalone` (`__new_plain_object`) — keyed on the regime, not
`hostFreeEnvironment(ctx)` — so a JS-environment regime module never reads the
host's env (gc reads `"production"` with `NODE_ENV=production`; the regime
reads `undefined`). react does not need the re-key (the harness leaves
`NODE_ENV` unset, so Node and the regime both take the development build), so
it is left for a follow-up under #6749: re-key that arm on
`hostFreeEnvironment(ctx)` and classify `__get_process_env` as the Node
platform capability.
