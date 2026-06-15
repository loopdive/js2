---
id: 2100
title: "architect spec: deep-marshaling contract at the host boundary (vec ⇄ array, closure ⇄ callback, struct ⇄ object)"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: max
task_type: analysis
area: host-interop
language_feature: compiler-internals
goal: core-semantics
related: [1996, 1969, 1998, 2028, 2015, 2025]
origin: "2026-06-11 analysis program (report 01 family F4 — unowned); stub 08-D15"
---

# #2100 — value conversion is decided ad hoc per call site

## Problem

Wasm↔host conversion has no declared contract — vecs cross opaque in some
bridges and converted in others (#1996/#1969/#1998), closures are
sometimes wrapped as host callbacks and sometimes not (host functions as
params trap, #2028), `this` routing diverges per bridge (#2015/#2025).
~14 June issues; the corpus marks this family entirely UNOWNED — the
upstream review graded the runtime on process and missed the semantics.

## Root cause

No conversion contract (vec ⇄ array, closure ⇄ callback, struct ⇄ object,
this-binding rules, depth/identity policy) with a single layer every
bridge routes through. `HOST_CALLBACK_METHODS` is dead code.

## Deliverable (spec only, no implementation)

`## Implementation Plan` here + a docs/architecture/ contract doc: the
conversion matrix, identity/round-trip rules, depth policy, one
`marshal(value, direction, depth)` layer, migration order over the
existing bridges, and which of the 14 member issues each phase retires.
Feeds sprint 64 consumers.

## Dupe check

Member issues filed individually; no family owner exists. New (analysis
program).

---

## Implementation Plan (architecture spec — 2026-06-15, arch1)

> Verified against `origin/main` @ `516feec44`. Spec-only — **no
> implementation** in this PR. Companion contract doc:
> [`docs/architecture/marshaling-contract.md`](../../docs/architecture/marshaling-contract.md).
> Feeds sprint-64 consumers; retires the F4 family member issues in phases.

### Correction to the issue's premise

`HOST_CALLBACK_METHODS` is **not dead code** — it is a live defensive
allowlist in `closures.ts:1060`, consulted by `isHostCallbackArgument`
(`closures.ts:1111`) to decide whether an arrow/function argument to a
HOF/Promise/replace method is bridged as a host callback vs a wasm closure
struct. The real defect the family shares is not "dead code" but **the absence
of a single declared conversion layer**: each bridge re-derives, ad hoc, (a)
whether to deep-convert a vec, (b) whether to wrap a closure, (c) which `this`
to pass, and (d) identity/round-trip policy. The fix is to route every bridge
through **one** `marshal(value, direction, depth)` layer with a declared matrix.

### The conversion matrix (the contract)

Two directions, four value families. Today each cell is decided per-call-site;
the contract fixes one rule per cell.

| Value family | wasm → host (`OUT`) | host → wasm (`IN`) | Identity / round-trip |
|---|---|---|---|
| **vec ⇄ Array** | deep-convert to a JS Array **recursively to `depth`** (default ∞ for enumeration sinks, bounded for `flat(n)`); inner vec refs unwrap, not pass opaque | recognize a JS Array (or `IsConcatSpreadable`) and rebuild the vec; spread per §23.1.3.1.1 | `OUT∘IN` must preserve element identity for object elements (cache by ref); a vec round-tripped through host stays the same backing store where possible |
| **closure ⇄ callback** | wrap the closure-struct as a host-callable via the `__fn_wrap`/`callback_maker` bridge (`runtime.ts:8904`) | a host function arriving as externref is invoked via `__call_extern_fn(fn, args)` — **never** ref.cast to a closure struct (that is the #2028 trap) | a wasm closure wrapped OUT then called from host runs the original wasm body; a host fn passed IN then called from wasm dispatches to the host fn |
| **struct ⇄ object** | `_wrapForHost` Proxy (live-mirror over sidecar + `__sget_*`); registered proto/class objects present method-only keys | `_unwrapForHost` back to the raw struct ref before handing to a compiled function | Proxy is a *different* JS object (documented caveat, `runtime.ts:3863`); callers that compare identity MUST `_unwrapForHost`. `_hostProxyCache`/`_hostProxyReverse` give a stable Proxy per struct |
| **primitive / boxed** | number→`__box_number`, string→host string, undefined→host undefined, etc. (the coercion engine, #1917) | ToNumber/ToString per coercion plan | value types; no identity concern |

### `this`-binding rules (the cell every bridge gets wrong differently)

A single rule, applied by `marshal` at every method-dispatch bridge:

- **Compiled wasm method** invoked via extern dispatch → pass the **raw struct
  ref** as `this`, NOT the `_wrapForHost` mirror (#2015 root cause:
  `calls.ts:7512` + `runtime.ts:~6815` pass the mirror; the body's
  `this.<field>` then reads the wrong object and traps).
- **Genuine host method** invoked on a wrapped wasm struct → pass the mirror
  (the host method only understands the Proxy surface).
- **Extracted method** (`const f = a.m; f()`) called with no receiver → the
  trampoline must emit a **null-`this` check prologue throwing a catchable
  `TypeError` exception tag**, never `ref.null` deref (the #2025 trap-vs-
  catchable divergence at `closures.ts:3264-3269`).

The discriminator "compiled wasm method vs host method" is already computable
(the dispatch site knows whether it resolved a `${Class}_method` funcidx); the
contract makes it the *single* gate for which `this` flows.

### Depth / identity policy

- **Depth.** Enumeration/serialization sinks (`JSON.stringify`, `Object.keys`,
  spread) marshal `OUT` to **full depth**. Structural array ops carry their own
  bound: `flat(n)`/`flatMap` marshal inner vecs to the declared flatten depth
  (#1996 — `_toJsArray` recurses, bounded by `n`). `concat` does **not** deep-
  flatten but MUST recognize a vec arg as `IsConcatSpreadable` and splice one
  level (#1969). Default `depth = ∞` for `OUT` enumeration, `depth = 1` for
  structural splice, explicit `n` for `flat`.
- **Identity.** `marshal` caches `OUT` conversions of *reference* values in
  `_hostProxyCache` (structs) and a parallel vec→Array WeakMap so the same wasm
  ref marshals to the same JS object within a call (preserves
  `arr.flat().includes(sameObjElem)`); `IN` uses `_hostProxyReverse` /
  `_unwrapForHost`. Primitives are never cached.

### The single layer

One module-level entry point in `runtime.ts` (host side) plus its codegen-side
emit helper:

```ts
// runtime.ts — the one bridge every host import routes through.
// direction: "OUT" (wasm→host) | "IN" (host→wasm)
function marshal(value: any, direction: "OUT" | "IN", depth: number, exports): any
```

- `OUT`: vec→Array (recurse to `depth`), struct→`_wrapForHost`, closure→
  `__fn_wrap`, primitive→box. Identity-cached.
- `IN`: Array→vec (or IsConcatSpreadable splice), object→`_unwrapForHost`,
  host-fn→leave as externref tagged for `__call_extern_fn`, primitive→coerce.

Every existing bridge (`__array_concat_any`, `_toJsArray`, `compileArrayJoin`'s
elemToStr, `__extern_method_call`, `Promise_new`'s executor, the HOF callback
bridges, `Object.assign`/spread) **calls `marshal` instead of its bespoke
conversion**. `HOST_CALLBACK_METHODS` stays as the closure-vs-host-callback
decision input but feeds `marshal`'s closure cell, not a parallel path.

### Migration order (each phase retires named member issues)

- **Phase M0 — land the contract doc + `marshal` skeleton (no rewires).**
  Define `marshal`, the matrix, identity caches; leave existing bridges intact.
  *Retires: none; establishes the layer.*
- **Phase M1 — vec ⇄ Array cell.** Route `_toJsArray` (recursive, depth-bound),
  `__array_concat_any` (IsConcatSpreadable), `compileArrayJoin` elemToStr
  through `marshal`. *Retires: **#1996, #1969, #1998**.*
- **Phase M2 — `this`-binding + struct ⇄ object cell.** `__extern_method_call`
  passes the raw struct ref for compiled methods (mirror only for host methods);
  extraction trampoline emits the catchable-TypeError null-`this` prologue.
  *Retires: **#2015, #2025**.*
- **Phase M3 — closure ⇄ callback cell (host-fn IN).** `__call_extern_fn`
  fallback in the closure call path when the callee is externref / the cast
  fails. *Retires: **#2028** (and unblocks the host-function-param family
  broadly — same trap as #1950, inverse of #1382).*
- **Phase M4 — sweep remaining bridges + standalone audit.** Audit every
  `_wrapForHost`/`extern.convert_any` call site to route through `marshal`;
  document which cells are host-only (the Proxy) vs standalone-representable
  (vec/primitive), feeding the dual-mode requirement.

### Standalone note (dual-mode, per CLAUDE.md)

The struct ⇄ object cell's `_wrapForHost` Proxy is **host-only** — standalone
mode has no JS Proxy. The contract must mark the struct-mirror cell as the one
place a standalone fallback is required: standalone enumeration/method-dispatch
reads struct fields directly (the same readers #2101/#2158 add for the class
model). The vec, primitive, and closure cells are representable in both modes.
M4 documents the per-cell mode matrix so #2158-style standalone work has a
declared target.

### What this spec does NOT do

- No implementation (member-issue PRs implement each phase).
- Does not change the coercion engine (#1917) — primitives delegate to it.
- Does not decide the class model (#2101) — the struct-mirror cell consumes
  #2101's `$ClassMeta` readers in standalone mode.

### Deliverables

1. This `## Implementation Plan`.
2. `docs/architecture/marshaling-contract.md` — the full matrix, identity/
   round-trip rules, depth policy, `marshal` signature, per-cell mode matrix,
   and the M0–M4 migration table mapping each phase to retired member issues.
