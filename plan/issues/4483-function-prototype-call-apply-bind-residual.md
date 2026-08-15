---
id: 4483
title: "ES5 standalone: built-ins/Function residual — call/apply arg semantics, bind carrier surface, __get_builtin CE (~30 tractable of 58 rows)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-methods
goal: standalone-gap
related: [4442, 4437, 4440, 4480]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. built-ins/Function = 58 ES≤5 standalone failures after the #4442 wave (+19); signatures split into apply/call TypeErrors (8), bind-carrier reads (4), null-length (3), __get_builtin CE (3), tail."
---

# #4483 — built-ins/Function residual families

## Problem

After #4442's `%Function%` carrier (+19), `built-ins/Function` still holds 58
ES≤5 standalone failures. Measured signatures:

- **A — apply/call argument semantics (8 rows)**: "Expected a TypeError" —
  §15.3.4.3/4 require TypeError when `argArray` is neither object nor
  array-like, and when the callee is not callable; also `arguments`-object
  pass-through rows.
- **B — bound-function surface (4 rows)**: `typeof obj.touched` — bind's
  carrier loses own-property writes / target surface.
- **C — `.length` of null (3 rows)**: `cannot read property 'length' of
  null` — a Function.prototype method value read answers null then dies
  (identity family; overlaps #4481 — coordinate, do not double-fix).
- **D — `__get_builtin` CE (3 rows)**: dynamic-shape object/property on a
  builtin — compile error where a decline was possible.
- **E — tail** (`this["feat"]` rows, constructor.length): assorted.

`fn.prototype`-dependent rows belong to #4480, not here.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`);
   produce the per-family file list first.
2. Family A: the call/apply lowering (grep `"apply"`/`"call"` arms in
   `src/codegen/expressions/calls.ts`) — add the §15.3.4.3 step-2/3 guards
   with real TypeError instances (`buildThrowJsErrorInstrs`). Arity/spread
   semantics for `arguments` receivers exist in the #4436 work — read
   `function-expected-argument-count.ts` first.
3. Family D first among the rest (CE class beats wrong-answer class): find
   the `__get_builtin` emission site, make the unsupported shape DECLINE to
   a runtime miss instead of a compile error.
4. Family B: read the bind lowering; bound carriers are closures — the
   #4437 metadata pattern may carry the target/own-props surface.
5. Family C: coordinate with #4481 (identity singletons) — if #4481 lands
   first, C may already be fixed; re-measure before touching.
6. Controls: fn-family pins (4436/4437/4440/4442/4456/4460/4464); scoped
   sweep `built-ins/Function` before/after; byte-identity on modules not
   using apply/call/bind.

## Acceptance criteria

- ≥15 rows flip in `built-ins/Function`; zero regressions; families not
  taken recorded with owners.
