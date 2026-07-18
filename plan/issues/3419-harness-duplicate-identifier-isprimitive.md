---
id: 3419
title: "Concatenated harness: duplicate function decl (isPrimitive) errors instead of last-wins — blocks ~3.4k tests both lanes"
status: ready
created: 2026-07-18
priority: high
feasibility: medium
task_type: bugfix
area: compiler-early-errors
goal: test262-conformance
model: fable
sprint: current
horizon: m
related: [3370, 3417, 3188]
---

# #3419 — duplicate top-level function declaration in concatenated harness is a hard error

## Problem
The literal-harness assembler concatenates runtime-shim + includes + `assert.js` +
`sta.js` + test body into ONE compilation unit. `assert.js` defines
`function isPrimitive(value)` (line ~104) and the `propertyHelper.js` harness include
ALSO defines `isPrimitive`. In sloppy-mode script concatenation this is legal JS
(function redeclaration, last-wins). The js2wasm compiler rejects it as a hard
**`Duplicate identifier 'isPrimitive'`** early error.

Measured (oracle-v8, run 29634290540):
- `Duplicate identifier isPrimitive` = **2,055** rows (dominant name).
- Default lane: ~1,373 `compile_error::other` reclassifications are Duplicate
  identifier; standalone: ~510 reclassifications + counts folded into the leak set.
- Also seen (smaller): duplicate `__func`, `compareArray`, test-local redeclarations.

Because it is a compile error, it kills the test on BOTH lanes.

## Root cause
`src/compiler/early-errors/duplicates.ts:63` raises `Duplicate identifier '${name}'`
for two top-level `function` declarations sharing a name. Per Annex B / sloppy script
semantics, duplicate top-level **function** declarations (and `var`) are legal and the
last declaration wins. The compiler applies module/TS-strict duplicate-binding rules
to concatenated sloppy scripts.

## Implementation Plan
**File: `src/compiler/early-errors/duplicates.ts`** (~line 63)
- When two colliding declarations are both **function declarations** (or both `var`,
  or a `var`+`function`) at the **top level of a Script** (not a module, not a lexical
  `let`/`const`/`class`), suppress the error and apply last-wins: the later
  declaration's binding shadows the earlier. Only `let`/`const`/`class` redeclaration
  and lexical/param collisions remain hard errors (those ARE real SyntaxErrors).
- Gate on script vs module: modules keep strict duplicate-export/binding rules
  (relevant to #3188). Use the same script/module signal the harness assembler uses
  (non-`module` flag → sloppy script).
- Ensure codegen emits only the last definition (or both with the last overwriting the
  binding) so no duplicate function-index/symbol is created downstream.

### Edge cases
- `let`/`const`/`class` duplicate at top level → still a SyntaxError (correct).
- Duplicate `function` in the SAME lexical block (inside a function body) in strict
  mode → still an error.
- A `var` shadowing a `function` of the same name → legal (last-wins by execution
  order); keep the function's hoisted definition unless reassigned.

## Verification
- Repro: concatenate `propertyHelper.js` + `assert.js` (both define `isPrimitive`) +
  a trivial body → currently errors; after fix compiles clean on both targets.
- Scoped: ~30 `built-ins/**/propertyHelper`-using tests compile on both lanes.
- Zero-regression: real duplicate-`let`/`class` negative tests
  (`language/**/redeclaration`) still reject.
