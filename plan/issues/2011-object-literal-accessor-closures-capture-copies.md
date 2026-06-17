---
id: 2011
title: "object-literal getter/setter closures capture copies — writes through accessors never reach the outer scope, getter pairs don't share state"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-17
completed: 2026-06-17
assignee: ttraenkler/cs-2161
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [1971, 1239, 1999, 2128]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2011 — accessor callbacks get private ref cells; no resync on property access

## Problem

```ts
let count = 0;
const o: any = { get x() { count++; return count; } };
const a = o.x; const b = o.x;
a + "," + b + "," + count
// wasm: "1,2,0"   node: "1,2,2"
```

Also: getter+setter pair over a shared `let backing` don't see each other's
writes ("1,1" vs "105,105"); `set x(v){captured = v*2}` leaves captured=0.
Setters ARE invoked (`this.y` side-effect probes pass) — only
closure-captured outer state diverges.

## Root cause

`src/codegen/closures.ts:~2740-2768` — each `compileArrowAsCallback`
allocates its own ref cells per callback (getter, setter, and outer frame
don't share one cell per binding), and the "persistent writebacks" that
re-sync outer locals only run after CallExpressions — accessor-triggering
property reads/writes (`o.x`, `o.x = 5`) never trigger a resync.

## Fix direction

Share one ref cell per captured binding across all callbacks in the same
scope (the general closure-environment model), and treat accessor-invoking
property access as a sync point — or migrate accessors onto the shared
environment used by ordinary closures.

## Acceptance criteria

- All three repros match Node
- Getter/setter pairs share captured state; outer scope observes writes

## Dupe check

Overlaps #1971 item 3 (#1239 residual "setters not invoked") but refines
it: setters fire, capture sharing is what's broken. Filed separately with
cross-ref.

## Resolution (2026-06-17, cs-2161)

The original symptoms (`"1,2,0"`, getter/setter pair not sharing a cell)
were already fixed at **function scope** by #2128 (shared per-literal ref
cells in `compileArrowAsCallback` + writeback re-sync at property-access /
assignment sites in `expressions.ts`). Re-verifying on main showed the
function-local repros all pass once the runtime harness wires `setExports`.

The residual that remained was a **module-scope-only** regression with a
different root cause: a top-level `const o = { get x() {...} }` returned
`NaN` and never observed captures even for a *read-only* capture of a
module-level variable.

**Root cause — representation/routing asymmetry between scopes.** Object
literals carrying get/set accessors are always compiled through the
JS-host plain-object (externref) path (`compileObjectLiteral` →
`compileObjectLiteralWithAccessors`, #1239/#1433). The **function-local**
let/const/var pre-pass (`index.ts` `walkStmtForLetConst` / `hoistVarDecl`,
~12573-12586) recognises this and forces the receiving local to
`externref` *and* tags `ctx.externrefAccessorVars` so later `o.x` reads
route to host `__extern_get`. The **module-level** registration path
(`declarations.ts registerModuleGlobal` callers, ~3338-3429) did **not**:
it typed the global via `resolveWasmType`, which infers the WasmGC *struct*
type. Result: the host externref object produced by the literal was stored
into a struct-typed global, and `o.x` mis-routed to `__extern_get` against
a struct (or a stub struct getter that read field 0) → `undefined`/`NaN`,
and no capture writebacks ran.

**Fix.** `src/codegen/declarations.ts`: added `moduleInitForcesExternref`
(detects accessor / `[Symbol.dispose]` / `[Symbol.asyncDispose]` literal
initializers) and `moduleGlobalWasmType` (returns `externref` + tags
`ctx.externrefAccessorVars` for those, else the prior
standalone-regexp/inferred type). Routed both module-global registration
sites (the `var`-hoist `registerVarDeclListGlobals` and the source-order
let/const loop) through it. This mirrors the function-local override
exactly, so the two scopes now agree on representation.

Scoped to accessor/dispose literals only — plain data-property module
literals keep the struct path (regression-guarded).

**Tests.** `tests/issue-2011.test.ts` (7 cases: read-only let/const
capture, mutate+observe, setter, get/set pair shared backing, the
multi-read repro, and a plain-struct guard). Pre-existing accessor suites
(`accessor-side-effects`, `issue-2128`, equivalence object-literal getter)
stay green. `tsc --noEmit` clean; biome clean on changed files.

NOTE: a *separate* pre-existing bug — `this._val` data-field access inside
an object-literal accessor (`tests/equivalence/object-literal-getters-setters.test.ts`
"setter stores value") — is out of scope here (not a closure capture) and
was failing on main before this change.
