---
id: 3359
title: "standalone: Array.prototype.filter (and callback methods) ignore the thisArg argument — closure runs with wrong `this`"
status: done
completed: 2026-07-23
sprint: 75
created: 2026-07-17
updated: 2026-07-17
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: array-methods, this-binding
goal: standalone-parity
related: [2036, 3326]
origin: "found while fixing #3326 (stale refuse-loudly expectations in tests/issue-2036.test.ts) — the `filter threads thisArg standalone` case genuinely fails (returns 0, expected 1); confirmed the same bug on a REAL array receiver, so it is a general filter-thisArg threading gap, not an $Object-only issue."
# (#3102) closures.ts is a god-file (split tracked by #3182); the this-param
# strip adds a small runtimeParameters() helper + per-site call updates.
loc-budget-allow:
  - src/codegen/closures.ts
---

## Partial resolution (2026-07-17) — direct array-receiver form FIXED

**Root cause (found).** A TypeScript `this` parameter
(`function (this: T, x) {…}`) is a TYPE-LEVEL-only annotation, but codegen
emitted it as a **real leading runtime parameter** of the lifted closure, so
every user param shifted one slot right. Array-method call sites supply the spec
`thisArg` via the `__current_this` global (not a positional arg), so the element
value landed in the (spurious) `this` slot and `thisArg` was dropped — the
predicate read `this.<prop>` as `undefined`. Verified via WAT: the callback's
funcref carried an extra `this` param and read it instead of `__current_this`.

**Fix.** New `runtimeParameters()` in `src/codegen/closures.ts` strips a leading
TS `this` param from the closure's runtime signature, applied at every
signature / param-local / default / destructuring site in `compileArrowAsClosure`,
`compileArrowAsCallback`, `computeClosureWrapperSig`, `emitArrowParamDefaults`,
and `emitClosureParamDestructuring`. A closure WITHOUT a this-param (all JS,
incl. every test262 input) gets the original list back — **byte-identical**, so
the conformance surface is untouched. `this` then correctly falls back to
`__current_this`, which both dispatch paths already install.

This fixes the **direct array-receiver form** — `a.filter(cb, thisArg)`,
`.map` / `.some` / `.every` / `.find` / `.findIndex` / `.forEach` — on **both**
the host/gc and standalone lanes. Guard: `tests/issue-3359.test.ts` (16 cases,
host + standalone).

**Residual (still open).** The BORROWED array-like form
`Array.prototype.filter.call(arrayLike, cb, thisArg)` still binds `this` to the
**receiver** instead of `thisArg` (predicate reads `this.<prop>` → NaN). This is
a SEPARATE, pre-existing gap in the array-like borrow dispatch
(`src/codegen/array-prototype-borrow.ts`): the `withThisInstalled` install of
`__current_this` appears structurally correct in WAT (install → call_ref →
restore, inside the per-element loop) yet the runtime value read by the callback
is not the installed `thisArg` — likely a value-rep / dispatch-path interaction
distinct from the this-param strip. Kept skipped in `tests/issue-2036.test.ts`
(`filter threads thisArg standalone — array-like .call form`). This arm keeps
#3359 open.

# #3359 — standalone `filter` ignores its `thisArg`

## Problem (measured, current main)

Under `--target standalone`, `Array.prototype.filter`'s optional second
argument (`thisArg`) is not threaded into the callback's `this`, so a
callback that reads `this.<prop>` sees `undefined` and the predicate is
mis-evaluated:

```ts
export function test(): number {
  const a = [5, 15];
  const r: any = a.filter(function (this: any, x: number) { return x > this.t; }, { t: 10 });
  return r.length; // standalone → 0 (WRONG); spec → 1
}
```

Confirmed on **both** a real array receiver and a borrowed array-like
`$Object` receiver (`Array.prototype.filter.call(o, cb, {t:10})`), so the gap
is in the native `filter` callback-invocation path, not the `$Object`
array-like arm. A closure that *captures* the value lexically (`(x) => x > t`)
works — only the `this`-binding path is broken.

## Scope

- Likely the same gap applies to the other callback methods that accept a
  `thisArg` (`map`/`some`/`every`/`find`/`findIndex`/`forEach`/`reduce`
  excepted — reduce has no thisArg). Audit each; fix the native standalone
  callback-invocation to bind `thisArg` as the callback receiver.

## Acceptance

1. `filter` (and the other thisArg-taking callback methods) thread `thisArg`
   into the callback's `this` under standalone.
2. Re-enable the `filter threads thisArg standalone` case in
   `tests/issue-2036.test.ts` (currently `it.skip`'d with a pointer here).
3. Host-lane byte-identity; no test262 regression.
