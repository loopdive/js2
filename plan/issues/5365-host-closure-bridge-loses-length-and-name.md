---
id: 5365
title: "JS-host closure bridge loses Function.prototype.length and .name once a compiled closure crosses a call boundary as a value"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-12
completed: 2026-09-12
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-12 (#5365 slice 1): +13 lines in src/runtime.ts. The fix is one new
# leaf module (src/runtime/compiled-closure-length.ts); these 13 are the three
# CALL SITES it has to be wired into — the by-name `__extern_get` binding, its
# `case "extern_get"` intent twin, and `__extern_length` — plus the import.
# Each site is 4 lines: hoist the existing `_structOwnFieldStatus` verdict,
# call the helper, return on a hit. They cannot move out of runtime.ts: the
# answer has to land AHEAD of that file's `__sget_` probe, which is what was
# returning the wrong 0.
loc-budget-allow:
  - src/runtime.ts
# 2026-09-12 (#5365 slice 1): +12 of those 13 lines land inside `resolveImport`,
# which is where BOTH `__extern_get` bindings live (the by-name one and its
# `case "extern_get"` intent twin) and `__extern_length` too. Splitting that
# function is #3399's job, not this fix's.
func-budget-allow:
  - src/runtime.ts::resolveImport
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

## Resolution — slice 1 (`length`), 2026-09-12

Landed. `length` is closed for every shape except a defaulted parameter; `name`
is unchanged and moves to
[#6427](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6427-host-mode-closure-name-carrier),
with the static-fold half at
[#6429](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6429-namedevaluation-static-name-folds).

### The plan's mechanism was wrong, and measuring it first is what fixed this

The plan (and the issue's own `String(f)` row) said the value the callee sees at
the boundary is the **host bridge wrapper** `_wrapWasmClosure` mints, so slice 1
should `defineProperty` a `length` onto it at wrap time. It is not. Probed
through the dogfood runner on `upstream/main` d4108568d4:

```
wasm:   len=0  name=undefined  hasOwnName=false  str=function () { [native code] }
        tag=[object Object]  typeof=function
native: len=2  name=f          hasOwnName=true   str=(a, b) => a + b
        tag=[object Function]  typeof=function
```

`[object Object]` and `hasOwnName=false` are not a JS function — the callee holds
the **raw WasmGC closure carrier**. `String(f)` looks bridge-shaped only because
`compiledClosureNativeSource` applies the same native-code facade to a carrier.
A marker return placed at the head of `_wrapWasmClosure` never fired; one placed
in the `extern_get` intent binding did. The read lowers to
`__extern_get(carrier, "length")` — no wrap on this path at all.

### Root cause — a wrong answer, not a missing one

`__extern_get`'s WasmGC arm walks: sidecar → descriptor table → delete tombstone
→ `masksField` → `__sget_<key>` field getter. A closure struct has no field-name
registry, so `_structOwnFieldStatus` answers `undefined` ("unknown shape") and
`wsh.readField` probes the getter anyway. `__sget_length` exists in almost every
real module — minted for the vec shape whose struct genuinely has a `length`
field — it cast-succeeds on the closure and returns its **miss-default 0**. That
is the #1629 anti-pattern, on the one receiver with no positive discriminator.
(In a module with no vec there is no getter to probe and the read answered
`undefined` instead; both are wrong, the `0` is the silent one, and it is the one
every package hits.)

### Fix

`src/runtime/compiled-closure-length.ts` (new) answers `length` from
`__closure_arity(carrier)` — the `$arity` header slot (#3673) every
funcref-wrapper struct already carries, via an export that already exists. No
codegen, no new struct field, no module-size delta.

Wired in **ahead of** the `__sget_` probe at three call sites in
`src/runtime.ts`, gated on `ownFieldStatus !== true`:

- `__extern_get`, by-name binding;
- `__extern_get`, the `case "extern_get"` intent binding — the live one for a
  compiled module, and a twin that had to be found by marker (the by-name edit
  alone changed nothing);
- `__extern_length`, for the numeric lowering (`handler.length > 1`).

The sidecar, the descriptor table and the delete tombstone all run before it, so
`defineProperty(f, "length", …)` and `delete f.length` still win; a struct that
genuinely owns a `length` field keeps the field read.

### Counts both ways

`tests/issue-5365-host-closure-length.test.ts`, untyped `.js` two-file fixtures:
**7 failed / 5 passed** on the parent → **12 passed** with the fix. The 5 that
pass both ways are the anti-vacuity controls: the direct `f.length` read, a live
array length, a string length, an object that really owns a `length` field, and
an explicit `defineProperty` override.

| declaration        | parent | fix   | spec |
| ------------------ | ------ | ----- | ---- |
| `(a, b) => a + b`  | 0      | **2** | 2 ✓  |
| `function g(a,b,c)`| 0      | **3** | 3 ✓  |
| `() => 1`          | 0      | 0     | 0 ✓  |
| `(a, ...rest) => a`| 0      | **1** | 1 ✓  |
| `(a, b = 1) => a`  | 0      | **2** | 1 ✗  |

A rest parameter is already excluded from `$arity`; a defaulted one is not — see
residuals.

### A/B — 17 dogfood suites, base vs fix at one head (upstream/main d4108568d4)

| suite | base | fix | delta |
| --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | +0 |
| three | 17/18 | 17/18 | +0 |
| clsx | 32/32 | 32/32 | +0 |
| cookie | 63740/63740 | 63740/63740 | +0 |
| lodash | 59/62 | 59/62 | +0 |
| redux | 67/82 | 67/82 | +0 |
| axios | 202/231 | 202/231 | +0 |
| stylelint | 108/108 | 108/108 | +0 |
| tailwindcss | 13/13 | 13/13 | +0 |
| jsdom | 6/6 | 6/6 | +0 |
| styled-components | 9/9 | 9/9 | +0 |
| uuid | 75/75 | 75/75 | +0 |
| marked | 16/30 | 16/30 | +0 |
| moment | 10/10 | 10/10 | +0 |
| prettier | 105/151 | 105/151 | +0 |
| jest | 335/356 | 335/356 | +0 |
| **hono** | **258/324** | **261/324** | **+3** |

Per-file movers — one file, no losses anywhere:

- hono `src/helper/dev/index.test.ts` **1/8 → 4/8** (+3): "should render not
  colorized output" (registered twice upstream) and "should render colorized
  output if colorize: true".

### Residuals

1. **`name` is untouched** — `undefined` across the boundary. #6427.
2. **A defaulted parameter still reports the declared count** (`(a, b = 1)` → 2,
   §15.1.5 says 1). `$arity` cannot be re-pointed: `closure-exports.ts` widens an
   under-applied dispatch to `max(n, $arity)` and would stop padding omitted
   arguments (#4436 R2). Needs the same carrier as `name`. #6427.
3. **The static folds still answer the storage key** — `o.h.name` → `"h"`,
   `arr[0].name` → `""`, unchanged by this PR because they never reach the
   runtime. #6429.
4. **hono dev/index reaches 4/8, not the 5/8 the issue predicted** for `length`
   alone. The remaining four all print a route table whose `handlerName` is
   `handler.name || …`, so they need #6427.
5. **The bridge path is not covered.** `_wrapWasmClosure`'s wrapper still reports
   `length === 0` when a compiled closure is handed to a *real host* function
   that reflects on it. No dogfood suite measured it, and the `arity` that
   function is handed is the call-site expectation rather than the declaration's,
   so stamping it there would have been wrong as often as right. Folded into
   #6427, which has the per-declaration carrier the stamp needs.

### Slice 2's carrier question, decided by this measurement

The plan preferred "a declaration-indexed `__closure_name(idx)` table the bridge
reads at wrap time", with `$__fn_instance_meta` (#4437) as the fallback. Both
halves of that preference fail on the evidence above: there is **no wrap** on this
path, so nothing can hand a table an index — the reader holds only the carrier;
and a `ref.test` ladder over struct types cannot separate declarations, because
WasmGC canonicalizes types structurally (`function-instance-meta.ts` states this
itself), so two declarations with the same capture shape and signature are the
same type and would get each other's name. The index must live **on** the
carrier, which is exactly what `$fnmeta` is — a per-declaration `{name, length}`
singleton reached by pointer instead of by index, already carrying the §15.1.5
`length`. #6427 is written against that.
