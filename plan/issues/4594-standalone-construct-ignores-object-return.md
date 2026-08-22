---
id: 4594
title: "STANDALONE: [[Construct]] ignores an object return — `new F()` answers `this` even when the constructor returns a different object (7 rows, one defect)"
status: blocked
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: constructors
goal: es5
related: [4464, 4480, 4563]
origin: "2026-08-21 wave-2 function lane, classifying the language/statements/function residue. Split from #4464's closed residual list into a live issue because it is ONE defect with seven rows and a written spec."
---

# #4594 — `new F()` must return the constructor's object return

## The defect

§13.3.5 / OrdinaryConstruct step: if the [[Call]] result is an Object, **it
replaces the freshly created `this`**. The standalone lowering keeps `this`
unconditionally.

Read-confirmed on two of the rows (not just failure text):

- `S13.2.2_A8_T1` — the constructor returns an inner function; the test asserts
  `__instance.first === undefined` (the returned function has no `first`). We
  answer `"one"`, i.e. the discarded `this`.
- `S13.2.2_A15_T1` — the constructor returns an object literal; the test asserts
  `__obj.prop === "A"` (the literal's). We answer `1` (`this.prop`).

## Rows (7, one defect)

`language/statements/function/S13.2.2_A7_T1`, `A8_T1`, `A8_T2`, `A15_T1..T4`.

## Scope boundary

The neighbouring **typed-field value-representation** rows (`A12`, `A17_T2/T3`,
`S13_A2_T2`, `S13_A6_T1` — a field inferred numeric silently drops a later
string write) are NOT this defect and stay with the value-representation
programme. Do not bundle them.

## Acceptance criteria

- All 7 rows pass, `target=standalone`.
- Controls: a constructor returning a **primitive** keeps `this` (§ step: only
  Object replaces); a constructor with no return keeps `this`; `new` on a
  builtin is untouched.
- Guard 551 clean; GC-lane suites relative to the merge base (constructor
  lowering is lane-shared).


## 2026-08-21 — RECLASSIFIED: blocked on value representation, not a bounded fix

The wave-2 function lane located the exact site, and it overturns this issue's
"bounded constructor-lowering fix" framing:

- `src/codegen/statements/control-flow.ts:341-366` — the construction result
  dispatch.
- **The runtime §10.2.1.3 step-13 probe already EXISTS**
  (`construct-return-value.ts`; its header even names `S13.2.2_A8_T1/T2`) — but
  it is only reached when the construction result is an **externref**.
- The **nominal-struct arm decides statically** with `ref.test <own struct>` and
  falls back to `this` in the else; its own comment records that a foreign
  object "cannot be represented by the struct-typed `new` result".

So the defect is confined to constructors whose `new` result is struct-typed,
and closing it means **widening that result to externref** — a representation
change with the usual blast radius (every consumer of the struct-typed result
loses its static shape). That is #4464/value-representation territory.

Recorded per the stop-and-report rule rather than forced. The 7 rows stay
classified blocked-on-representation; whoever takes the widening should start
from the existing probe, which is already correct for the externref arm.
