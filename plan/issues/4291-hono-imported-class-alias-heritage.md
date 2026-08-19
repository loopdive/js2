---
id: 4291
title: "codegen: resolve imported class aliases in extends clauses"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, modules, inheritance
goal: dogfood
related: [1244, 3993, 4288, 4290]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/class-bodies.ts
oracle-ratchet-allow:
  - src/codegen/class-bodies.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
---

# codegen: resolve imported class aliases in extends clauses

## Problem

After #4290, Hono constructs its router list and reaches `basePath()`, but the
inherited `Hono_basePath` body traps before calling `#clone`. The published base
class is exported and imported under aliases (`Hono` -> `HonoBase`). Class
collection records the local heritage spelling `HonoBase`, which has no struct,
instead of following the import to the exact anonymous class expression.

The derived Hono struct is therefore emitted as an unrelated root containing
only `router`. An inherited base method receives that derived ref, guard-casts
it to the base struct, gets null, and `ref.as_non_null` traps. Resolve heritage
identifiers through their checker declaration identity and register the derived
struct as an actual subtype of the exact base class.

## Acceptance criteria

- [x] A reduced multi-module alias/re-export regression traps before the fix
      and returns `42` afterward through an inherited method.
- [x] Hono's derived class is emitted with its base fields/subtyping and
      `basePath()` advances beyond the inherited-receiver null cast.
- [x] Existing class-expression, inheritance, and import-alias suites pass.

## Result

Class heritage resolution now follows an imported alias to the exact anonymous
class-expression declaration. The derived struct retains its base fields and
subtyping, the reduction returns `42`, and Hono's `basePath()` clone completes;
the workload then advances to later route-dispatch defects.
