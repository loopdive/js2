---
id: 5365
title: "JS-host closure bridge loses Function.prototype.length and .name once a compiled closure crosses a call boundary as a value"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

In `gc`/JS-host mode, a compiled closure that is **passed as an argument** and
then reflected on inside the callee reports `length === 0` and
`name === undefined`. Measured (hono harness, `platform: web`, `target: gc`):

```js
const f = (a, b) => a + b;
const o = { h: f };
const arr = [f];
function viaParam(x) { return x.length + " / " + x.name + " / " + typeof x; }
```

| read                | native            | wasm (JS host)                    |
| ------------------- | ----------------- | --------------------------------- |
| `f.length` / `.name`| `2` / `"f"`       | `2` / `"f"`            ✓          |
| `o.h.length`/`.name`| `2` / `"f"`       | `2` / **`"h"`**        ✗ (name)    |
| `arr[0].length`/`.name` | `2` / `"f"`   | `2` / **`""`**         ✗ (name)    |
| `viaParam(f)`       | `2` / `"f"` / fn  | **`0`** / **`undefined`** / fn ✗   |
| `String(f)`         | `"(a, b) => a + b"` | `"function () { [native code] }"` |

The `String(f)` row names the mechanism: at the parameter boundary the value
the callee sees is the **host bridge wrapper**, not the closure. The wrapper is
minted in `src/runtime.ts` `_wrapWasmClosure` as

```ts
const wrapped = function wasmClosureBridge(this: any, ...args: any[]) { … };
```

so its own `length` is `0` (rest parameter) and its `name` is whatever
`installNativeFunctionSourceFacade` leaves. The direct/object/array reads above
are answered statically from the declaration, which is why only the boundary
crossing is wrong.

Static answers are also only *approximately* right: `o.h.name` returns the
property key `"h"` and `arr[0].name` returns `""`, where the spec's
NamedEvaluation gives `"f"` in both cases (the function was named at its own
declaration, not at the storage site).

`length` is recoverable — the module already exports `__closure_arity`
(`src/codegen/closure-exports.ts`), and `_wrapWasmClosure` is handed the arity
it dispatches at. `name` has **no host-mode carrier at all**: #4437's
`$__fn_instance_meta` slot (`src/codegen/function-instance-meta.ts`) is
explicitly *standalone only* — "In gc/host mode the `env::__extern_*` imports
own the reflective property path". Closing `name` therefore means either
extending that carrier to host mode or teaching the bridge to read a
per-declaration name table.

## Impact

Found while fixing [#5339](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5339-hono-dev-index-whole-module-failure).
Once hono's `src/helper/dev/index.test.ts` compiles and validates, **6 of its 7
remaining failures are this bug**: hono classifies routes with

```js
const isMiddleware = (handler) => handler.length > 1;
const handlerName = (handler) => handler.name || (isMiddleware(handler) ? "[middleware]" : "[handler]");
```

Handlers reach `inspectRoutes` through `#addRoute(method, path, handler)`, i.e.
across a call boundary, so every one of them reports arity `0` and no name. The
Wasm lane therefore labels every route `[handler]` / `isMiddleware: false`,
which breaks `inspectRoutes()` (1 test) and all four `showRoutes()` variants
plus the verbose form (5 tests).

`length` alone lifts the file from 1/8 to 5/8; `length` + `name` reaches 7/8.

## Acceptance criteria

1. `viaParam(f)` above reports the declared arity and the declaration's name in
   `gc`/host mode, matching Node.
2. `o.h.name` / `arr[0].name` answer the *declaration's* name, not the storage
   key.
3. Regression test under `tests/` with untyped `.js` two-file fixtures, failing
   on the parent and passing with the fix, plus an anti-vacuity control.
4. A/B over the 17 dogfood suites: `hono src/helper/dev/index.test.ts` improves;
   the change touches a hot global runtime path (`_wrapWasmClosure` is on every
   host callback), so a full per-file A/B is mandatory, not optional.

## Notes

`length` and `name` are separable and should probably land as two slices —
`length` is a small, well-understood change against an export that already
exists; `name` needs new per-declaration metadata in host mode.

## Implementation Plan

Two slices, two PRs, in this order. The filer's split is right: `length` is a
small change against an export that already exists; `name` needs a host-mode
carrier that does not exist yet.

### Slice 1 — `length` (small)

1. Read `_wrapWasmClosure` in `src/runtime.ts` and `__closure_arity` in
   `src/codegen/closure-exports.ts`. The wrapper is minted as
   `function wasmClosureBridge(...args)`, so its own `length` is `0`; the arity
   it dispatches at is already in hand. Set it at wrap time with
   `Object.defineProperty(wrapped, "length", { value: arity, configurable: true })`
   (spec attributes: non-writable, non-enumerable, configurable). Confirm the
   wrapper cache keeps identity across crossings (`f === f` after two trips) so
   the property is set once.
2. Check what `__closure_arity` encodes for `(a, b = 1)` and `(a, ...r)` — the
   spec value is the number of formals before the first default or rest (1 in
   both). If the export counts all formals, fix the export, not the bridge.
3. Regression test: `viaParam(f).length` for plain, default-param and
   rest-param closures; control: direct `f.length` unchanged. Untyped `.js`
   two-file fixtures, counts both ways.
4. A/B all 17 suites per file — `_wrapWasmClosure` is on every host callback.
   jest (mock arity checks), hono, axios are the ones to watch.

### Slice 2 — `name`

5. Host mode has no per-declaration name carrier (`$__fn_instance_meta`,
   #4437, is standalone-only). Prefer the **twin of the arity export**: a
   per-module `__closure_name(idx)` (or a string table indexed by closure
   declaration index) that the bridge reads once at wrap time and installs
   with `defineProperty(wrapped, "name", …)`. Names are per *declaration*, not
   per instance, so the table is the declaration count — cheap. Measure the
   module-size delta on a closure-heavy hono module and quote it. Extending
   `$__fn_instance_meta` to host mode (a field per instance) is the fallback
   if the table cannot be indexed from what the bridge is handed.
6. NamedEvaluation for the **static** reads: `o.h.name` answers `"h"` and
   `arr[0].name` answers `""` today. Find where `.name` on a statically known
   closure is folded (grep `"name"` in `src/codegen/property-access*.ts` /
   `member-get-dispatch.ts`) and make it use the declaration's own name when
   the function had one; only an *anonymous* function expression takes the
   storage key, and only for the NamedEvaluation sites (variable declaration,
   property assignment) — never for an array element.
7. Regression test: `viaParam(f).name`, `o.h.name`, `arr[0].name`, anonymous
   arrow assigned to a const (`"g"`), anonymous in an array (`""`); A/B as in
   step 4.

## Dispatch

Model: **opus** for slice 1 (well-understood, one export already exists).
Slice 2 also **opus**, with the instruction to stop and record if the carrier
cannot be a declaration-indexed table — that design question is the only
hard part, and it should be decided by measurement (size delta, wrap-time
cost) before any per-instance field is added. Dispatch after PR #5676 lands
(it carries this file); not blocked on anything else.
