# Deep-marshaling contract (wasm ⇄ host boundary)

> Status: **architecture spec** (#2100). Defines the single conversion contract
> every wasm↔host bridge must route through. No implementation has landed yet;
> this is the target the F4 member issues (#1996, #1969, #1998, #2028, #2015,
> #2025) implement in phases. Verified against `origin/main` @ `516feec44`.

## Why this exists

Wasm↔host value conversion is currently decided **ad hoc per call site**. A
WasmGC vec crosses opaque through some bridges and deep-converts in others; a
closure is sometimes wrapped as a host callback and sometimes not; `this`
routing diverges per bridge; identity/round-trip is undefined. The symptom
issues are the visible faces of one missing abstraction: **there is no declared
conversion layer.** This doc declares it.

The fix is one entry point — `marshal(value, direction, depth, exports)` — with
a fixed rule per (value-family × direction) cell. Every bridge calls `marshal`
instead of its bespoke conversion.

## The conversion matrix

Directions: `OUT` = wasm → host, `IN` = host → wasm.

| Value family | `OUT` (wasm → host) | `IN` (host → wasm) | Identity / round-trip |
|---|---|---|---|
| **vec ⇄ Array** | deep-convert to a JS Array, **recursively to `depth`**; inner vec refs unwrap (never pass opaque) | recognize a JS Array (or `IsConcatSpreadable`, §23.1.3.1.1) and rebuild the vec | object elements preserve identity (cached by ref); a round-tripped vec keeps its backing store where possible |
| **closure ⇄ callback** | wrap the closure-struct as host-callable via `__fn_wrap` / `callback_maker` (`runtime.ts:8904`) | a host fn arriving as externref is invoked via `__call_extern_fn(fn, args)` — **never** `ref.cast` to a closure struct (the #2028 trap) | wasm closure wrapped OUT runs the original body when called from host; host fn passed IN dispatches to the host fn when called from wasm |
| **struct ⇄ object** | `_wrapForHost` Proxy (live-mirror over sidecar + `__sget_*`); registered proto/class objects present method-only keys | `_unwrapForHost` to the raw struct ref before handing to a compiled function | Proxy is a distinct JS object (caveat, `runtime.ts:3863`); identity comparisons MUST `_unwrapForHost`. `_hostProxyCache`/`_hostProxyReverse` keep one stable Proxy per struct |
| **primitive / boxed** | number→`__box_number`, string→host string, undefined→host undefined | ToNumber / ToString per the coercion plan (#1917) | value types; no identity concern |

## `this`-binding rule

One rule, applied by `marshal` at every method-dispatch bridge. The dispatch
site already knows whether it resolved a compiled `${Class}_method` funcidx;
that flag is the single gate.

- **Compiled wasm method** via extern dispatch → pass the **raw struct ref** as
  `this`, NOT the `_wrapForHost` mirror. (#2015: `calls.ts:7512` +
  `runtime.ts:~6815` pass the mirror today; the body's `this.<field>` reads the
  wrong object and traps.)
- **Genuine host method** on a wrapped wasm struct → pass the mirror (the host
  method only understands the Proxy surface).
- **Extracted method** (`const f = a.m; f()`) with no receiver → trampoline
  emits a **null-`this` prologue throwing a catchable `TypeError` exception
  tag**, never a `ref.null` deref. (#2025: `closures.ts:3264-3269` traps
  uncatchably today.)

## Depth policy

- **Enumeration / serialization sinks** (`JSON.stringify`, `Object.keys`,
  spread) — `OUT` to **full depth** (`depth = ∞`).
- **Structural splice** (`concat`) — `depth = 1`: recognize a vec arg as
  `IsConcatSpreadable` and splice one level, do not deep-flatten (#1969).
- **`flat(n)` / `flatMap`** — `OUT` inner vecs to the declared flatten depth
  `n` (#1996: `_toJsArray` must recurse, bounded by `n`).

## Identity policy

- `marshal` caches `OUT` conversions of **reference** values: structs in
  `_hostProxyCache`, vecs in a parallel vec→Array WeakMap, so the same wasm ref
  marshals to the same JS object within a call (preserves e.g.
  `arr.flat().includes(sameObjElem)`).
- `IN` resolves identity via `_hostProxyReverse` / `_unwrapForHost`.
- Primitives are never cached.

## The single layer

```ts
// runtime.ts — the one bridge every host import routes through.
// direction: "OUT" (wasm→host) | "IN" (host→wasm)
function marshal(value: any, direction: "OUT" | "IN", depth: number, exports): any
```

- `OUT`: vec→Array (recurse to `depth`), struct→`_wrapForHost`, closure→
  `__fn_wrap`, primitive→box. Identity-cached for reference values.
- `IN`: Array→vec (or IsConcatSpreadable splice), object→`_unwrapForHost`,
  host-fn→leave as externref tagged for `__call_extern_fn`, primitive→coerce.

`HOST_CALLBACK_METHODS` (`closures.ts:1060`) remains the closure-vs-host-callback
decision **input** (consumed by `isHostCallbackArgument`), feeding `marshal`'s
closure cell — it is not a parallel conversion path and is not dead code.

## Per-cell mode matrix (dual-mode, per CLAUDE.md)

| Cell | JS-host mode | Standalone mode |
|---|---|---|
| vec ⇄ Array | `marshal` deep-convert | representable (WasmGC vec ↔ native array) |
| primitive | `marshal` box/coerce | representable |
| closure ⇄ callback | `__fn_wrap` / `__call_extern_fn` | representable (closure struct + `call_ref`); host-fn IN is host-only |
| struct ⇄ object | `_wrapForHost` Proxy | **host-only** — standalone reads struct fields directly (the #2101/#2158 struct readers); no JS Proxy |

The struct-mirror cell is the single place a standalone fallback is mandatory.
M4 (below) audits and documents it.

## Migration order

Each phase routes a set of bridges through `marshal` and retires named member
issues. Phases are independently mergeable; M0 lands first.

| Phase | Scope | Bridges rewired | Retires |
|---|---|---|---|
| **M0** | Land this doc + `marshal` skeleton + identity caches; no rewires | (none) | — |
| **M1** | vec ⇄ Array cell | `_toJsArray` (recursive, depth-bound), `__array_concat_any` (IsConcatSpreadable), `compileArrayJoin` elemToStr | **#1996, #1969, #1998** |
| **M2** | `this`-binding + struct ⇄ object cell | `__extern_method_call` (raw struct ref for compiled methods), extraction trampoline (catchable-TypeError null-`this` prologue) | **#2015, #2025** |
| **M3** | closure ⇄ callback (host-fn IN) | closure call path → `__call_extern_fn` fallback when callee is externref / cast fails | **#2028** (unblocks the host-fn-param family; same trap as #1950, inverse of #1382) |
| **M4** | Sweep remaining bridges + standalone audit | every `_wrapForHost` / `extern.convert_any` call site routes through `marshal`; document per-cell mode matrix | — (hardening) |

## Relationships

- **#1917 (coercion engine)** owns the primitive cell; `marshal` delegates
  primitives to it, does not duplicate ToNumber/ToString.
- **#2101 (class object model)** — the struct-mirror cell consumes #2101's
  `$ClassMeta` / struct readers for the standalone fallback.
- **#1382 / #1950** — wasm-closure-as-JS-callable (the `OUT` closure cell) and
  its trap family; M3's `IN` host-fn bridge is the inverse direction.
