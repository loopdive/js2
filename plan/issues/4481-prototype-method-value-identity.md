---
id: 4481
title: "ES5 standalone: prototype-method VALUE identity — `x.toString === X.prototype.toString` family across Object/Array/Number literals (~20 rows)"
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
language_feature: method-identity
goal: standalone-gap
related: [4442, 3006, 4426]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. language/expressions/array (8 rows), language/expressions/object (7), plus Array/Number/Boolean scattered rows all assert `instance.method === Builtin.prototype.method`."
---

# #4481 — prototype-method value identity

## Problem

The `S15.x` corpora assert method IDENTITY, not behavior:
`var a = []; a.toString === Array.prototype.toString`,
`({}).toString === Object.prototype.toString`, `array.join === Array.prototype.join`.
Standalone answers false (or null on one side): reading a builtin method off
an INSTANCE and off the PROTOTYPE produce different carriers (or a fold on
one side and a runtime value on the other). ~20 measured rows: all 8
`language/expressions/array` failures, 6 of 7 `language/expressions/object`,
plus `x.toString() must return "[object Array]"` rows where the transferred
identity matters.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`).
   Probe matrix first: for each of {Object,Array,Number,Boolean,String} ×
   {toString,valueOf,join,hasOwnProperty}: `inst.m === Proto.m`,
   `Proto.m === Proto.m` (self-stability), `typeof Proto.m`. Record which
   cells are false/null — the fix is per-cell routing, not one hammer.
2. #4442's `function-intrinsic-carrier.ts` is the PROVEN pattern: ONE
   module-level emitter per intrinsic value, dispatched on a module-level
   fact, so both sides of `===` route through the same singleton. #3006's
   `BUILTIN_CTOR_ARITY` carriers and `tryCompileStandaloneBuiltinProtoMemberMeta`
   (property-access.ts) are the existing read sites that currently answer
   with per-site values — unify them onto per-(builtin,method) singletons.
3. Mind the call side: the singleton must still be CALLABLE through the
   existing reflective dispatch (`array-object-proto.ts` arms) — identity
   must not trade a working call for a passing `===` (the #4442 lesson:
   provider-linked vs self-contained arms, module kind is the switch).
4. Controls: the reflective String/Array method call suites stay green
   (issue-4427/4439/4465 pins); byte-identity on modules that never read a
   builtin method as a value.

## Acceptance criteria

- ≥12 of the ~20 identity rows flip; `Proto.m === Proto.m` stable for every
  probed cell; zero regressions in reflective-dispatch pins.
