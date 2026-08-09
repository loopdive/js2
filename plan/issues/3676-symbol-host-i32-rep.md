---
id: 3676
title: "JS-host Symbol.for / well-known-symbol value reads return externref, not the canonical i32 symbol id — React 19 emits a valid module that cannot instantiate"
status: done
sprint: 77
created: 2026-07-26
updated: 2026-07-30
completed: 2026-07-26
assignee: ttraenkler/opus-dev
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen, runtime
goal: dogfood
related: [2610, 2792, 2866, 3085, 1467, 2163]
origin: "React 19 dogfood — react.production.js compiled to a valid 45,739-byte module with 132 correct exports but threw TypeError at __module_init"
# The growth is overwhelmingly explanatory comment, not logic. The three edits
# are: one boolean predicate + a widened disjunct (property-access-dispatch),
# one import-name/ValType swap + one static-type-gated branch
# (call-namespace-static), and two new host imports (runtime). runtime.ts also
# LOSES ~40 lines to the `_resolveSymbolCache` extraction, which de-duplicates
# three copies of the well-known seeding block; the net +64 is the two new
# import handlers and the comments explaining why the seeding had to be shared.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
---

# #3676 — JS-host symbol producers must yield the canonical i32 symbol id

## Symptom

Compiling React 19.2.6's production CJS build
(`node_modules/react/cjs/react.production.js`) with
`{ allowJs: true, skipSemanticDiagnostics: true, emulateNode: true }` emitted a
**valid** Wasm module — `WebAssembly.validate` returned `true`, 137 exports,
zero compile errors — that **could not be instantiated**:

```
TypeError: Cannot convert a Symbol value to a number
    at Number (<anonymous>)
    at <anonymous> (src/runtime.ts:14009:16)     <- __unbox_number, `return Number(v)`
    at fn (src/runtime.ts:14853:27)              <- host-call wrapper
    at __module_init (wasm-function[158])
```

React's first statement is twelve chained `Symbol.for(...)` initializers plus
`MAYBE_ITERATOR_SYMBOL = Symbol.iterator`.

`runtime.ts`'s `__unbox_number` is **correct** and was not changed: per #1434 it
deliberately lets the TypeError propagate, because `Number(Symbol())` must throw
per §7.1.4. The defect was that something called it on a Symbol at all.

## Root cause — a representation split, not an initializer bug

The compiler represents a symbol **value** as an **i32 id** everywhere:

- `mapTsTypeToWasm` (`src/checker/type-mapper.ts:80`) maps `symbol` → `{ kind: "i32" }`
- `compileSymbolCall` (`src/codegen/literals.ts:1917`) — i.e. `Symbol()` — returns
  an unbranded `{ kind: "i32" }` counter
- `__box_symbol` is the i32 → host-Symbol bridge, pre-seeding ids 1..14 with the
  genuine well-known symbols

Two producers disagreed **under the default JS-host target only** and handed
back an `externref` instead:

| #   | producer                        | site                               | returned                                         |
| --- | ------------------------------- | ---------------------------------- | ------------------------------------------------ |
| D1  | `Symbol.<wellKnown>` value read | `property-access-dispatch.ts:1673` | `externref` via `__get_builtin` + `__extern_get` |
| D2  | `Symbol.for(key)`               | `call-namespace-static.ts:365`     | `externref` via the `__symbol_for` host import   |

Landing that `externref` in a `symbol`-typed **i32** slot makes `coerceType`
bridge it with `__unbox_number` — literally `Number(Symbol())`. Because
module-scope initializers execute in `__module_init`, the module compiled
cleanly and died at instantiate.

Direct evidence, `var S = Symbol.for("x")`:

```wat
(global $__mod_S (mut i32) (i32.const 0))
(func $__module_init
    global.get 0
    call 0            ;; __symbol_for  : (externref) -> externref
    call 1            ;; __unbox_number: (externref) -> f64   <-- throws here
    i32.trunc_sat_f64_s
    global.set 3)
```

For D1 the pre-existing code comment asserted the two lowerings were
"observationally identical" in gc/host mode. **That claim was false** — they
return different ValTypes (`externref` vs `i32`), which is precisely the bug.

### It was NOT confined to the initializer path

The initial pin suggested a module-scope-initializer defect, because
`export function g(){ var S = Symbol.for("x"); }` appeared to pass. That row was
**vacuous**: the local was never read. Once read
(`S === Symbol.for("k")`), the function-local case failed identically. The
discriminator is not "initializer vs assignment" but **"does a `symbol`-typed
slot ever receive one of these two producers' values"**. `var S; S = Symbol.for(...)`
survives only because an initializer-less `var` is typed `any` → `externref`, so
no coercion happens.

## Fix

Put both producers on the **same, already-exercised footing as `Symbol()`**. No
new representation is introduced; an inconsistent one is removed.

1. **D1** (`src/codegen/property-access-dispatch.ts`) — defer to the downstream
   `i32.const <id>` constant emitter for `Symbol.<wellKnown>` in **both** modes,
   not just standalone. Scoped strictly to `Symbol.<wellKnown>`: the Math/Number
   f64 constants and `<Ctor>.length`/`.name` keep their standalone-only defer, so
   host-mode bytes for those are unchanged. Identity across the boundary already
   holds because `__box_symbol` pre-seeds ids 1..14.

2. **D2** (`src/codegen/expressions/call-namespace-static.ts` + `src/runtime.ts`) —
   `Symbol.for(key)` returns the canonical i32 id via a new
   `__symbol_for_id(externref) -> i32` host import. Ids are allocated
   **negative**, provably disjoint from the well-knowns (1..15) and from the
   in-module `__symbol_counter` global (starts at 100, only ascends). Each id is
   registered into the **same** per-instance `symbolCache` that `__box_symbol`
   reads, so identity round-trips in both directions. §20.4.2.2 step 1
   (`ToString(key)`) is preserved by letting the host's real `Symbol.for` perform
   the coercion.

3. **`Symbol.keyFor`** follows the representation via `__symbol_keyFor_id(i32)`,
   gated on the argument being statically a symbol — mirroring the identical
   static-type gate #3085 added for `String(sym)`. Coercing an i32 to `externref`
   there would box it with `__box_number` (the unbranded-i32 hazard #2792
   describes) and hand `Symbol.keyFor` a Number.

4. **`_resolveSymbolCache`** extracted in `src/runtime.ts`. This is load-bearing,
   not cosmetic: the well-known seeding guard is `size === 0`, and
   `__symbol_for_id` is now a _second_ writer of that map. Left inline, React's
   twelve `Symbol.for` calls would populate the cache **before** the first
   `__box_symbol`, making it non-empty, so the well-known seeding would be
   skipped forever and `__box_symbol(1)` would return `Symbol("wasm_1")` instead
   of the real `Symbol.iterator`. Seeding through one shared helper makes the
   order irrelevant. (Also de-duplicates a third inline copy in `__new_Symbol`.)

## Test Results

`tests/issue-3676-symbol-host-i32-rep.test.ts` — 24 cases.

|                  | merge base `5805049`      | with fix                 |
| ---------------- | ------------------------- | ------------------------ |
| tests/issue-3676 | **13 failed** / 11 passed | **24 passed** / 0 failed |

The 11 that pass on the merge base are the **regression sentinels** — they pass
on both sides by construction, which is what makes them able to catch an
over-broad fix (`Symbol()` uniqueness, declare-then-assign,
`Symbol('d').description`, array for-of, custom `[Symbol.iterator]` protocol,
well-known distinctness).

Adjacent suites (`symbol-iterator-protocol`, `symbol-async-iterator`,
`issue-2610`, `issue-1732`, `issue-1830`, `issue-2161`, `issue-2378`,
`issue-1916`): 70 passed / 2 failed — and those same 2
(`symbol-async-iterator` › `for await...of with let binding` / `with
accumulation`) fail **identically on the merge base**. Verified by reverting.

### React 19 — verified by reverting

|                                        | merge base                                                   | with fix                            |
| -------------------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| compiles                               | yes, 46,449 bytes                                            | yes, 46,339 bytes                   |
| instantiates                           | **no** — `TypeError` at `__module_init` (wasm-function[158]) | **yes**, 137 exports (136 callable) |
| `createElement("div", {id:"a"}, "hi")` | unreachable                                                  | returns an object                   |
| `isValidElement(<that element>)`       | unreachable                                                  | **1**                               |
| `isValidElement({}) / (null) / ("s")`  | unreachable                                                  | **0 / 0 / 0**                       |

`isValidElement` is the load-bearing row: it is React's **own** check of
`$$typeof === REACT_ELEMENT_TYPE`, i.e. of the very `Symbol.for` value this
change repairs, and it discriminates (three negatives return 0), so it is not
vacuous.

## What this does NOT fix (honest scope)

**React instantiates; React does not "work".** Three separate walls remain, all
outside this change:

1. **Host→module Symbol direction is still broken.** Passing a host object
   carrying a real JS Symbol _into_ the module
   (`isValidElement({ $$typeof: Symbol.for("react.transitional.element") })`)
   throws the same `__unbox_number` TypeError. This change fixed the
   **producer** side (module-internal symbols); the **inbound** `externref` host
   Symbol → i32 id bridge does not exist. `type-coercion.ts:1741` has exactly
   this bridge but gated `(ctx.standalone || ctx.wasi) && to.symbol === true`,
   and `mapTsTypeToWasm` deliberately does not set the `symbol` brand (#2792).
   Closing this is the #2610 symbol-as-any value-rep work — a value-substrate
   change, deliberately not attempted here.

2. **`Object.getOwnPropertySymbols(o)` → a symbol slot** throws the same
   TypeError. Same class, same missing inbound bridge; **pre-existing and
   source-independent** — it fails identically for `Symbol()` and `Symbol.for()`
   on the merge base. Verified by reverting.

3. **Returned objects are opaque to the host.** `Object.keys(element)` is `[]`,
   `element.type` / `element.$$typeof` read `undefined` — the element is a
   WasmGC struct, not a host-readable object. Separate struct↔host interop axis.
   `React.version` (a non-function export) is likewise `undefined`, and
   `Children` is missing.

`useState()` throwing outside a renderer is **correct** React behaviour (no
dispatcher installed), not a defect.
