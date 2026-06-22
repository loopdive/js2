---
id: 2146
title: "Retire the registration-indirection layer in codegen/shared.ts"
status: done
sprint: 65
created: 2026-06-12
updated: 2026-06-21
completed: 2026-06-21
assignee: senior-dev-shared
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: maintainability
related: [1916, 1899]
origin: "2026-06-12 sprint-62 architecture analysis (pipeline workstream N3)"
---

# #2146 — function-pointer DI slots make call order a runtime trap

## Problem

`flushLateImportShifts` / `registerAddStringImports` /
`registerAddUnionImports` are function-pointer slots that throw
"not yet registered" until index.ts wires them
(`src/codegen/shared.ts:242-264`) — a circular-import workaround that
hides the real dependency graph and turns initialization order into a
runtime trap.

## Approach

Extract the shared state these functions close over into a module both
sides can import — or fold into #1916's handle resolver, which deletes
most callers. Sequence AFTER the #1916 A2 spec is ratified so this doesn't
churn twice.

## Acceptance criteria

- Zero `register*` DI slots in shared.ts; or the issue is explicitly
  absorbed into #1916 phase 1 with a pointer.

## Notes

Routine dev, S-size, sprint 63 (sequenced behind #1916's spec).

## Resolution (2026-06-21, senior-dev)

This issue's acceptance criterion is binary: **zero `register*` DI slots, OR
absorb the residual into #1916 with a pointer.** Empirical analysis (below)
showed full-zero is infeasible without the module-graph restructuring that
#1916 owns, so this PR takes **both** available branches: it retires the one
slot that can be removed safely *today*, fixes the actual reported defect (the
runtime trap), and points the residual at #1916.

### Why "zero slots" is not a standalone refactor

The `register*` slots are not gratuitous — `shared.ts` is the deliberate
**acyclic sink** that every codegen module may import. I built a static
import-graph prober (throwaway) and tested, for each delegate, whether
converting its consumers to a direct import of the impl module would introduce
an ESM cycle. **Almost every conversion cycles** (e.g. `coerceType`,
`compileExpression`, `ensureLateImport`, `materializeStructAsObject`,
`ensureBindingLocals`, `hoistFunctionDeclarations`, `compileSuperPropertyAccess`
all re-form a cycle through `literals.ts`/`type-coercion.ts`/`property-access.ts`/
`statements.ts`). In ESM a cycle means a binding is *transiently `undefined`* —
a strictly **worse** trap than the current explicit throw. The two impls that
live in `index.ts` (`addUnionImports`, `addStringImports`) genuinely cannot be
direct-imported because `index.ts` imports the would-be consumers
(`late-imports.ts`, `any-helpers.ts`) — an irreducible cycle given today's
layout. Retiring those requires extracting the recursion hubs / the
`addImport`+index-shift machinery into leaf modules, which **is exactly
#1916's** scope. #1916 is currently `blocked` (`blocked_by: [2167]`).

### What this PR did

1. **Retired one slot fully, zero cycle risk** — `resolveEnclosingClassName`
   (+ `registerResolveEnclosingClassName`) had a self-contained body that reads
   only `fctx`, so it now lives *directly* in `shared.ts`. The delegate, the
   registrar import in `new-super.ts`, and the module-scope `register…()` call
   are gone. Consumers already imported it from `shared.ts`; no consumer import
   changed. DI slots: 21 → 20.

2. **Fixed the actual reported defect — the runtime trap.** The remaining 18
   throwing stubs no longer throw a bare `"X not yet registered"` deep inside
   codegen; each now names the module that owns its registration. A new
   `assertCodegenRegistrationsComplete()` runs **once at compile entry**
   (`compiler.ts::compileSourceSync`, the single production chokepoint that
   statically pulls every registrar) and fails fast listing *every* unwired
   delegate + its owning module. An obscure mid-codegen
   `undefined-is-not-a-function`-class error is now an actionable load-order
   diagnostic at the front door. Verified: a normal compile passes the
   assertion and runs; importing `index.ts` in isolation (which does not pull
   `expressions.ts`/`new-super.ts`) fails with the precise 5-delegate
   diagnostic. Regression test:
   `tests/issue-2146-registration-hardening.test.ts`.

### Residual → #1916 (pointer, per acceptance criterion branch 2)

The remaining 20 `register*` slots cannot be removed without the symbolic-ref
+ module-graph restructuring tracked by **#1916** (and its prerequisite
#2167). When #1916 lands `FuncHandle`-based late imports and lifts
`addUnionImports`/`addStringImports`/the recursion hubs out of `index.ts` into
leaf modules, the cycles dissolve and the slots can be replaced by direct
imports. The fail-fast guard added here is forward-compatible: it simply
becomes dead (and removable) once the slots are gone. **#1916 owns the residual
of #2146.**
