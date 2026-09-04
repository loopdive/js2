---
id: 5311
title: "A closed struct crossing into an `any` position is opaque — no property read, no enumeration"
status: ready
created: 2026-09-03
updated: 2026-09-03
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: object-representation, for-in, Object.keys, property-access
goal: npm-library-support
sprint: current
horizon: l
related: [1243, 1271, 2584, 2837, 2992, 5310]
---

# #5311 — a closed struct crossing into an `any` position is opaque

## Problem

An object literal that lowers to a closed WasmGC struct becomes **completely
unreadable** once it is passed into a parameter typed `any`. Not just
enumeration — an ordinary property read returns `NaN`.

```ts
function get(o: any): number { return o.a; }
export function n(): number { const o = { a: 7, b: 2 }; return get(o); }
// host mode: NaN   (expected 7)
```

```ts
function count(o: any): number { return Object.keys(o).length; }
export function n(): number { const o = { a: 1, b: 2 }; return count(o); }
// host mode: 0     (expected 2)
```

```ts
function names(o: any): string { let out = ""; for (const k in o) out += k + ","; return out; }
export function keys(): string { const o = { a: 1, b: 2 }; return names(o); }
// host mode: ""    (expected "a,b,")
```

`const o: any = { a: 1, b: 2 }` at the declaration site behaves the same way.
The value is a `struct.new`; `extern.convert_any` hands it to the callee, and
every dynamic accessor — property get, `Object.keys`, `for...in`, `in` — sees an
opaque WasmGC reference.

## Why this matters right now

It is what holds **marked at 0/30**. `Marked.use()` installs hooks with

```js
if (n.hooks) {
  let r = this.defaults.hooks || new P();
  for (let i in n.hooks) { /* wrap and install */ }
  s.hooks = r;
}
```

`n.hooks` arrives through a rest parameter, so the enumeration is over an `any`.
It yields nothing, no hook is installed, and the default pipeline runs — which is
exactly the observed failure shape: every test asserts a hook's effect and gets
the un-hooked output (`actual=<p>text</p> expected=<h1>text</h1>`), or reads a
property the hook should have set and gets `undefined`. All 30 upstream Hooks
tests fail this way, and none of them crash.

## Not the same defect as #5310

[#5310](5310-forin-closed-struct-host-enumerates-nothing.md) is a *strategy
selection* bug at the for-in site: the receiver's closed type was visible and
was ignored. It is fixed. This issue is a *representation* bug at the call
boundary: by the time the callee runs, the closed type is gone, so no
site-local decision can recover it. Fixing #5310 does not move any of the three
snippets above.

## Note on #1271

[#1271](1271-for-in-object-keys-enumeration.md) was closed in sprint 47 with a
smoke test reporting "for-in over any-typed object: OK". That result is not
reproducible in the form above, and the distinction is the point: what works is
a value whose representation was **open from the start**; what fails is a
**closed struct widened at a boundary**. A re-check should use the snippets in
this issue rather than the ones in that note.

## Direction (not yet chosen)

Two candidates, both with real costs — neither should be picked without an
A/B across all 24 curated packages:

1. **Widen at the boundary.** Have the object-shape-widening pre-pass
   (`src/codegen/declarations/object-shape-widening.ts`) treat "flows into an
   `any`/externref parameter" as an escape that forces the open `$Object`
   carrier, the way it already treats `o[k]`, `k in o`, `Object.keys(o)` and
   `for (k in o)`. Contained and reuses existing machinery, but it will widen a
   great many objects that are currently closed structs — a size and speed
   regression that has to be measured, not assumed.

2. **Make the dynamic accessors struct-aware.** Emit a per-struct-type shape
   descriptor and teach the `$Object` accessors and enumerators to consult it.
   Keeps the closed representation (and its performance), but adds metadata to
   every struct type and a branch to every dynamic access.

## Repro

The three snippets above, compiled with `compileAndRunHost`. Standalone shares
the defect for the `any`-parameter cases; only the direct-receiver case (#5310)
differed between targets.
