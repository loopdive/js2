---
id: 1983
title: "synthetic class-method names collide with user functions: class A { m() {} } + function A_m() breaks both paths"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: compilable
related: [1370]
origin: "2026-06-10 deep-audit sweep (IR agent, secondary observation): verified on main @ 0c753ea88, both paths"
---

# #1983 — `${ClassName}_${method}` funcMap keying is not collision-free

## Problem

A class method `A.m` is registered under the synthetic name `A_m`; a
user-defined top-level `function A_m()` collides with it. Legacy: runtime
null-ref trap; IR: module-wide CompileError (`argument type mismatch in
call`). Node: works (`12`).

```ts
class A { m(): number { return 10; } }
function A_m(): number { return 2; }
export function test(): number { return new A().m() + A_m(); }
```

## Root cause (area)

funcMap keys use the `${ClassName}_${method}` convention
(`src/codegen/class-bodies.ts`, #1370 keying) with no mangling/uniquing
against user identifiers.

## Fix direction

Use a non-collidable separator in synthetic names (e.g. `A#m` or a reserved
prefix that is not a valid TS identifier), or unique-ify on collision at
registration time. Audit other synthetic name factories (getters/setters,
statics, closure wrappers) for the same convention.

## Acceptance criteria

- Repro returns `12` on both paths
- Mangled names don't leak into exports/WIT
- Other `_`-joined synthetic name sites audited

## Dupe check

#1370 (class-method IR adoption — keying origin). No collision issue on file.

## Full root-cause + WIP status (2026-06-15, sdev5)

Repro confirmed on main `39a63edf0` (both wasm + standalone CompileError
`call[0] expected (ref null 6), found f64`). The defect is a **shared flat
funcMap namespace**: a class member `A.m` registers funcMap key `A_m`; the
user-function reservation (`ensureSiblingFunctionsRegistered`,
declarations.ts:3660) then **silently skips** `function A_m()` because
`funcMap.has("A_m")` is already true, so `A_m()` call sites resolve to the
class method's funcIdx (wrong signature → trap).

### The collision spans FOUR distinct name-spaces, not one

Pinned by exhaustive tracing. Any fix must keep all four consistent:

1. **`ctx.funcMap` funcIdx key** — `${className}_${member}` (the trap source).
2. **wasm display name** (`mod.functions[i].name`) — because the body-fill
   `funcByName` map (compileDeclarations) is built from display names; a
   collision there mis-fills bodies.
3. **`funcByName` body-fill lookups** in class-bodies.ts (ctor/init/method/
   getter/setter) AND the struct-method pre-registration in `ensureStructForType`
   (index.ts:10120) — three separate reservation sites.
4. **The DCE finalize funcIdx remap** (`dead-elimination.ts` Phase 4) — see
   "Remaining" below.

### Approach implemented (branch `issue-1983-funcmap-key`, commit 26f099222)

`classMemberFuncKey(ctx, fullName)` (new leaf module `class-member-keys.ts`):
returns the **byte-identical** legacy key for every non-colliding program, and
only on a real collision relocates the *class member's* funcMap key + display
name to `__cm$<name>` (a prefix no `${className}_${member}` join can emit). The
user function keeps the bare `A_m` key (it is no longer skipped, because the
class member vacated `A_m`), so its many bare-call / export / ref.func consumers
are untouched. `topLevelFunctionNames` is pre-scanned at `generateModule` start
(MUST precede all class registration — producers query it).

Routed through: producers (class-bodies.ts ctor/init/method/getter/setter +
inheritance copy; index.ts `ensureStructForType`; new-super.ts ctor) and the
class-method-dispatch consumers (calls.ts main + static + inheritance/override
scans; new-super.ts; closures.ts). Membership sets (`classMethodSet` etc.) and
per-name metadata (`funcOptionalParams`/`funcRestParams`/`funcUsesArguments`)
intentionally stay on legacy `fullName` (they answer "is this a class member",
collision-free; method-dispatch reads them by the same legacy name).

### Verified correct so far

- Typechecks clean. Both function **bodies** are now emitted correctly:
  `$__cm$A_m` = `(param (ref null 6))(result f64)` body `f64.const 10` (method,
  takes self); `$A_m` = `()→f64` body `f64.const 2` (user fn). They are now
  **separate** functions (was a single clobbered slot).
- The dispatch site **bakes the right compile-time funcIdx** (instrumented:
  `new A().m()` bakes `call <method funcIdx>`, fnName=`__cm$A_m`).

### SOLVED (2026-06-16, sdev5) — the real last consumer was the IR front-end

The earlier "DCE remap" hypothesis was WRONG. Root cause of the residual
`test() === 4`: the **IR front-end recompiles eligible top-level functions**
(`compileIrPathFunctions`, index.ts), and the IR backend has its **own**
class-member dispatch resolution that bypassed `classMemberFuncKey`:

- `src/ir/integration.ts` `ClassRegistry` — `methodFuncName` / `constructorFuncName`
  built the legacy `${className}_${member}` name, which the IR
  `class.call` lowering (`src/ir/lower.ts:1358`) resolved via `resolveFunc` →
  `funcMap`. For a colliding class that key resolved to the **user function's**
  funcIdx. Fixed: both route through `classMemberFuncKey(ctx, …)`.
- `src/codegen/property-access.ts` — the getter-read / method-reference paths
  resolve `${className}_get_${prop}` / `${className}_${method}` funcMap keys
  (~14 sites: `getterName` / `setterName` / `methodFullName` / `fullName`).
  All routed through `classMemberFuncKey`.

With those two, the fix is COMPLETE. `tests/issue-1983-funcmap-collision.test.ts`
(5 cases, standalone + empty importObject) all pass:

- method `A.m` vs `function A_m()` → `test()` = **12** ✓
- ctor `A_new` vs `function A_new()` → **10** ✓
- getter `B.v` vs `function B_get_v()` → **8** ✓ (acceptance criterion)
- non-colliding class → **15** ✓ (byte-identical / unchanged — safe-by-construction)
- user `A_m()` reachable on its own → **42** ✓

The existing class suites' `string_constants` instantiate failures are a
**pre-existing harness artifact** (`{ env: {} }` importObject), identical on
origin/main — verified by running `tests/inheritance.test.ts` on a base worktree
(7/7 fail there too). Not a regression: the module *compiles* successfully.

Status: implementation done; awaiting CI on the PR.

## Earlier scope note (2026-06-15, sdev5) — superseded by the SOLVED section above

The initial scope analysis (landed via #1498) estimated ~103 `${className}_${member}`
call sites and recommended deferring after #2158. The actual implementation
found the real consumer surface is far narrower once `classMemberFuncKey` is
made byte-identical for non-colliding programs (only the funcMap funcIdx key +
display name relocate, on collision only), and the last missing consumer was the
IR front-end (not a 103-site sweep). Kept for history.
