---
id: 4407
title: "boolean-returning functions minted as f64 numeric twins — live standalone miscompile on string concatenation"
status: ready
sprint: current
created: 2026-08-14
priority: high
horizon: s
feasibility: medium
task_type: bug
area: codegen
related: [4406, 4405, 3754]
---

# #4407 — boolean returns treated as numeric: `("" + p.eat(5)).length` → 1, not 4

## Problem

Found during #4406's architect investigation (spec §1–§2 in
`plan/issues/4406-return-type-unboxing-abi.md`, commit `aedb0bb82`; full
repro and measurements there). **Default-ON on main, standalone lane:**

- `Prover.isNumeric` answers true for booleans, and the `numericFunctions`
  fixpoint loop (`src/codegen/numeric-property-analysis.ts:1267-1279`) has
  **no `isBooleanish` filter** — unlike the property loop (`:1319`) and the
  grounded-slot loop (`:1373-1379`), which both have it.
- Measured on acorn: all **83** boolean-returning functions
  (`inferBooleanFunctionNames`, `struct-field-boolean-brand.ts:147-172`) are
  swallowed into `numericFunctionNames` (102 total, intersection 83).
- Consequence: `refinedTwinReturnType` (`typed-this.ts:1054`) mints **f64**
  twins for boolean predicates (`eat`, `isContextual`, all 40
  `regexp_eat*`), and `true` crosses the call boundary as `1`.

Reproduced miscompile (standalone, default flags):

```ts
export function strlen() { var p = new P(5); return ("" + p.eat(5)).length; }
// node: 4 ("true")     standalone build: 1 ("1")
```

`JS2WASM_NUMERIC_TWINS=0` does NOT fix it — there is a second consumer with
the same missing filter: `provenNumericOperand`'s call rule
(`src/codegen/binary-ops.ts:993-999`).

acorn keeps checksum 422 only because its predicates are consumed
exclusively in boolean/condition context, where 1-vs-true is unobservable.
Any program that stringifies, strict-equals against `true`, or `typeof`s a
proven-boolean call result is miscompiled today.

## Fix shape

Thread `isBooleanish` into both consumers, mirroring the property loop:

1. `numericFunctions` loop (`numeric-property-analysis.ts:1267-1279`) —
   exclude boolean-returning functions from `numericFunctionNames` (or track
   them as a distinct set; #4406 Phase 1 wants exactly that set).
2. `provenNumericOperand` call rule (`binary-ops.ts:993-999`) — same filter.

Do NOT "fix" it by making the f64 twin box back to boolean at the edge —
#4406's spec defines the real i32/boolean return type for these; this issue
is only about stopping the wrong f64 verdict. Coordinate: #4406 Phase 1
builds on the set this fix separates out.

## Acceptance criteria

- The repro above returns 4 in standalone with default flags.
- Equivalence tests green; a new equivalence test covers
  boolean-return-stringification (and `=== true`).
- acorn lane: checksum 422, and report the twin-count delta (the 83 f64
  twins for predicates will disappear or change type — binary size and
  wall delta stated, regression tolerated since correctness wins).
- test262 standalone: no net regression (CI merge_group validates).

## Hazards (from #4406 spec — read it first)

- `unboxFromExternref`'s `i32 && boolean` arm (`typed-this.ts:1763-1768`)
  calls `__unbox_boolean`, which only recognises boxed-boolean carriers
  (`closure-exports.ts:552-561`) — currently a dead arm; do not activate it
  as part of this fix.
- `coerceType(externref → i32)` is ToNumber+truncate, not ToBoolean.
