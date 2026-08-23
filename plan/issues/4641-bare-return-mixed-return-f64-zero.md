---
id: 4641
title: "value-rep: bare `return;` in a mixed-return function emits f64.const 0 instead of undefined — every `if (!x) return;` in every compiled program"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: return-completion
goal: value-rep
related: [4640, 4489]
origin: "dev-4640 escalation (2026-08-23): pinned it.fails in tests/issue-4640.test.ts (statements/return/S12.9_A5). Filed against the value-rep lane per its recommendation."
---

# #4641 — bare `return;` renders 0 in mixed-return functions

## Problem (measured by dev-4640)

```js
function f(c) { if (c) return; return 5; }
f(true)   // → 0     spec: undefined
```

The function's inferred wasm return type is `f64`, so a bare `return;`
emits `f64.const 0`. This is not one test262 row — it is every
mixed-return function in every compiled program (`if (!x) return;` is
ubiquitous). Pinned `it.fails` at `statements/return/S12.9_A5` in
tests/issue-4640.test.ts.

## Extended family (wave-4 sweep, 2026-08-23, lead-measured on campaign HEAD)

The same representation gap — a numeric slot cannot carry
`undefined`/`null` distinctly — accounts for the largest remaining
`built-ins/Array/prototype` block (17 rows, all re-verified failing on
the campaign head by the lead's sweep):

- `concat/S15.4.4.4_A{1_T2,1_T4,2_T1,2_T2,3_T1,3_T2,3_T3}.js` — an
  `undefined` element crosses concat as `NaN`
  (`Expected SameValue(«NaN», «undefined»)`), and
  `Array.prototype.concat` read as a VALUE throws "not yet callable as a
  value" (A2 pair — reflective-carrier arm, may route to #4647's lane if
  it turns out provider-side).
- `toString/S15.4.4.2_A1_{T2,T4}.js` —
  `Array(undefined,1,null,3).toString()` renders `",1,0,3"`: the `null`
  element materializes as `0` in the f64 slot.
- `toLocaleString/S15.4.4.3_A{1_T1,3_T1}.js` — same, via toLocaleString.
- `filter/15.4.4.20-{5-7,9-b-2,9-b-14,9-b-15,9-b-16}.js`,
  `forEach/15.4.4.18-3-23.js` — callback/hole semantics on arrays whose
  elements were defined via descriptor MOP (verify live: these may
  belong to #4491's lane if the root is the descriptor mirror, not the
  element representation — decide by measurement, hand over whichever
  half is not yours).

The decision matrix below must therefore cover BOTH positions: function
RETURN slots and array ELEMENT slots. A fix that widens only returns
leaves the 17 rows; one that widens only elements leaves the pin.

## Implementation Plan (sketch — architect-level decision required)

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). This is a
   value-representation change with real perf and call-site blast radius:
   the honest fix widens a mixed-return function (some `return;`/fall-off
   + some `return <number>`) to an externref/anyref return carrying the
   #4489 tag-1 undefined singleton, with call sites unboxing.
2. FIRST measure the population: how many functions in the ES≤5 corpus
   (and the perf-benchmark suite) are mixed-return? The decision between
   (a) widen only mixed-return functions (a per-function signature
   decision, cache/ABI implications at call sites), (b) an f64 NaN-boxing
   sentinel for undefined (collides with real NaN semantics — likely
   unsound, measure why), or (c) decline + document, must be made on that
   measurement plus a perf A/B on the benchmark lanes (#1888 floor).
3. The corpus-instrument requirement applies in full (≥500-row stratified
   paired A/B) — this is the hottest ABI in the compiler.
4. Record the decision matrix in this file (#4506's format) BEFORE
   implementing.
