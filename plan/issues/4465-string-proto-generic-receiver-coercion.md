---
id: 4465
title: "ES5 standalone: String.prototype generic-method family — non-string receivers and argument-coercion order (34-row bucket)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: string
goal: standalone-gap
related: [4426, 4427, 4439]
origin: "2026-08-15 ES5-standalone session — baseline bucket analysis after wave 11; 34/8115 ES≤5 rows fail under built-ins/String/prototype."
---

# #4465 — String.prototype generic-method receiver/argument coercion

## Problem

34 es5id rows under `test/built-ins/String/prototype/` fail standalone
(baseline 2026-08-15). §15.5.4 String methods are GENERIC: step 1–2 of each
is CheckObjectCoercible(this) + ToString(this), so a method transferred to
any receiver must work. Families from the baseline JSONL:

- **G1 — transferred/reflective receivers (~15 files, dominant)**:
  `__reg.toLowerCase = String.prototype.toLowerCase; __reg.toLowerCase()`
  (the `*_A1_T14` family ×4), `String.prototype.trim.call(child|argObj)`
  (trim 2-43/2-51), `new Boolean()` receivers (replace A1_T2, substring
  A3_T11), `Math` / `Number(1e21)` receivers (split instance-is-*),
  `Function()` receivers (slice A1_T5/A3_T4, substring A1_T5/A3_T10) —
  receiver must go through ToString, currently answers `[object X]`-shaped
  wrongness, null, or "called value is not a function".
- **G2 — argument ToInteger coercion + exception propagation (~4 files)**:
  charAt/charCodeAt `A5`/`A4` — `pos` argument with `valueOf`/`toString`
  throwing `'intostring'` must propagate the user exception; `A1.1` — extra
  args ignored, `eval("1")` as pos.
- **G3 — object-toString argument/receiver shapes in concat/replace (~6)**:
  `{toString(){return "A"}}` receivers/args; replace with undefined-returning
  toString; concat with 128 args (spread arity).
- **G4 — CE class (2 files)**: replace `A1_T5/T6` — explicit
  "String.prototype.replace(...) with a RegExp or symbol" codegen error on
  shapes the emitter declines; check what shape triggers it (likely
  replace(regexp, fn) via transferred method).
- **G5 — out of scope here**: `delete String.prototype.toString` prototype
  mutation (S15.5.4_A1/A3), eval-receiver toLocale* `A1_T3` rows if they
  reduce to the eval tier. Record as residuals with owners.

## Implementation Plan

1. Re-verify families live with the `.tmp/run-one.mts` driver (standalone).
2. Read the existing reflective String dispatch first:
   `src/codegen/array-object-proto.ts` (STRING_PROTO_METHOD_PARAM_SLOTS +
   dispatch arms), `src/codegen/string-proto-concat.ts` (#4426 session's
   reflective concat — the pattern to follow), `string-proto-match-search.ts`
   (#4439), `string-compound-lane.ts` (#4427). G1 is likely ONE fix in the
   reflective dispatch's receiver path: coerce the receiver via the
   ToString/`__to_primitive` route (mirror #4429's string-hint discipline —
   `__current_this` save/install/restore if a user toString runs) instead of
   assuming an anyStr receiver.
3. G2: the arg path for charAt/charCodeAt — route `pos` through the real
   ToNumber (user valueOf/toString called, exceptions propagate). Check the
   #4434 vec-index-domain and #4426 length-set toNumber idiom
   (`__to_primitive` + `__unbox_number`) for the shared instrs.
4. G4: reproduce the CE, decide decline-vs-support; a CE is worse than a
   wrong answer only if the shape is reachable — if support is large, leave
   declined but file the residual.
5. Sweep `built-ins/String/prototype/` standalone before/after from your own
   runs; string-family pins (issue-4427/4439 tests + equivalence string
   subset) green.

## Acceptance criteria

- ≥15 of the 34 rows flip to pass; zero regressions in the scoped sweep and
  string-family pins.
- Residual rows (G5 + anything declined) recorded with owners.
