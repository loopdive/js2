---
id: 6885
title: "JS-host lane: `[obj, \"str\"]` (object BINDING first) stores the string as null; `[obj, 1]` traps — the #6613 carrier widening is standalone-only"
status: ready
sprint: current
created: 2026-10-07
updated: 2026-10-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: core-semantics
related: [6613, 4289, 6884]
---

## Problem

`compileArrayLiteral` (`src/codegen/literals.ts`) picks the vec element
carrier from element zero. #6613 widened `[obj, <non-struct>]` to the externref
vec when element zero is a closed data struct — but only under
`ctx.standalone || ctx.wasi`, on the stated premise that the JS-host lane does
not lose a string sibling. Measured on upstream/main `75252327a4` that premise
is wrong: the length is right, the VALUE is gone.

| literal (JS-host, one module) | js2wasm | node |
| --- | --- | --- |
| `const o = {a:1}; JSON.stringify([o, "s"])` | `[{"a":1},null]` | `[{"a":1},"s"]` |
| `const o = {a:1}; [o, 5]` | TRAP null deref | ok |
| `[{a:1}, "s"]` (inline literal) | ok | ok |
| `["s", o]` | ok | ok |

test262 row (unmasked by #6511, previously a vacuous pass):
`built-ins/Temporal/PlainDate/from/limits.js` —
`[tooEarly, tooLate, "-271821-04-18", "+275760-09-14"].forEach(…)` hands
`null` to `Temporal.PlainDate.from` for both strings ("null with reject …
got a TypeError"). The same failure reproduces with a plain `for…of` on the
#6511 parent, so the array literal, not the forEach, is the defect.

## Implementation Plan

1. `src/codegen/struct-carrier-inhabits.ts` `hasNonStructElementForStructCarrier`:
   an `externref` element is currently skipped ("the dynamic widenings own
   it"). On the host lane a string literal / string-typed binding IS
   `externref`, and no dynamic widening owns it. Return true for an
   `externref` element whose static JS type (`ctx.oracle.staticJsTypeOf`) is
   a primitive (`string`, `number`, `boolean`, `bigint`, `symbol`); keep
   skipping `any`/`unknown`/object-typed externref elements.
2. `src/codegen/literals.ts`: drop the `(ctx.standalone || ctx.wasi)` gate on
   the #6613 call so the scalar (`[o, 5]` trap) and string cases widen on the
   host lane too.
3. Tests: the four rows above against node, on both lanes.
4. A/B (host lane, with the Temporal provider): `built-ins/Temporal` +
   `built-ins/Array/prototype` + `language/expressions/array`; the npm suites
   (array literals are everywhere — this moves host-lane bytes, which #6613
   deliberately avoided, so the A/B is the acceptance gate, not a formality).
