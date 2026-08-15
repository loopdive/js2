---
id: 4449
title: "standalone: TypedArray.prototype ES6 semantics residual (~556 non-reflection tests) — species protocol, detached-buffer checks, custom-ctor paths"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [4444, 2159, 2175]
---

# #4449 — TypedArray.prototype standalone semantics residual

## Problem

556 non-passing ES2015-classified standalone tests under `built-ins/TypedArray*`
remain after excluding the reflection files (`length.js`/`name.js`/
`prop-desc.js`/`not-a-constructor.js`/`invoked-as-func.js` — those are
#2159/#2175's lane). Measured 2026-08-15 (`.tmp/es6-standalone-clusters.ts`,
baseline_sha `734fab88`):

| ~Tests | Sub-bucket | Symptom |
|---|---|---|
| 55 | `speciesctor-*` | `@@species` / custom-constructor protocol not consulted (`Expected a TypeError…`, `same constructor Expected SameValue(«undefined», «true»)`) |
| 41 | detached-buffer | operations must throw TypeError on a detached ArrayBuffer; no exception thrown |
| 22 | `custom-ctor` | result-constructor selection on map/slice/filter/subarray |
| 438 | other | per-method semantics under "Testing with FloatNArray and makeArray" — validation order, `ToInteger` coercion, callbackfn protocol observability, `arraylength-internal` |

Heaviest methods: `set` (37), `map` (35), `slice` (34), `filter` (32),
`subarray` (31), `copyWithin` (27), `fill` (20), `reduce`/`reduceRight` (38).

## Direction (not yet a full plan)

- **Triage-first slice** like #4447: pick one representative per sub-bucket,
  identify where the standalone TypedArray methods live (grep TypedArray under
  `src/codegen/`), and confirm which failures are (a) missing protocol steps in
  otherwise-working methods vs (b) blocked on #2175 reflective receivers.
- The `speciesctor`/`custom-ctor` buckets need a SpeciesConstructor lookup on a
  runtime receiver — check whether that genuinely requires #2175's prototype
  objects or can key off the receiver's brand struct.
- Detached-buffer checks are likely a bounded, high-yield first slice: one
  `IsDetachedBuffer` guard emitted at each method entry.
- Write the full `## Implementation Plan` (fable lane) before dispatching an
  implementation agent, per the plan/implement split.

## Acceptance

- Sub-bucket counts above driven to zero (or re-attributed to #2175 with
  evidence) with scoped-run measurements
  (`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/TypedArray"`).
