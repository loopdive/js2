---
id: 6695
title: "standalone: direct call of a callable variable whose runtime signature differs from its static type throws TypeError / null-derefs"
status: ready
sprint: Backlog
created: 2026-09-26
updated: 2026-09-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6690, 2873, 1712]
---

# #6695 — direct call of a signature-narrowed callable variable (standalone)

**Surfaced by** #6690 (the array-method-callback twin, fixed there).

```ts
function f(x: number): number { return x * 2; }
export function test(): number {
  const cb: (x: number) => number | string = f; // runtime funcref (self, f64) -> f64
  return cb(3) as number;                        // standalone: throws TypeError (expected 6)
}
```

```js
export function test() {                          // untyped: cb's type comes from its FIRST init
  let n = 0;
  let cb = (x) => { n += x; return x; };
  if (n === 0) cb = (x) => { n += 1; return "s"; };
  cb(1);                                          // standalone: "dereferencing a null pointer" (expected n === 1)
  return n;
}
```

## Mechanism

The callable-param dispatch in `src/codegen/expressions/call-identifier.ts`
(~L2770–3200) enumerates candidate funcref types for the STATIC signature
(`resultTypes` / externref / void, prefix arities). A value whose funcref has a
different result carrier (`f64` for a `number | string` static return) matches
no candidate and falls into the terminal `throw TypeError` arm; the untyped
`let` reassignment case null-derefs. The only signature-agnostic fallback
(`runtimeApplyFallback` → `__apply_closure`) is gated on
`ctx.runtimeEvalCallableBoundaryEnabled`.

## Fix direction

Same as #6690: when no candidate funcref matches (and the struct cast missed),
invoke through the native `__apply_closure(fn, undefined, argsVec)` bridge with
the args boxed into the canonical `__vec_externref` (no object runtime), and
coerce the boxed result to the static return carrier (`$AnyValue` via
`__any_from_extern`). Standalone-gated; JS-host keeps `__call_function`.
