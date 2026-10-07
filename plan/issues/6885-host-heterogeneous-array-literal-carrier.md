---
id: 6885
title: "JS-host lane: `[obj, \"str\"]` (object BINDING first) stores the string as null; `[obj, 1]` traps — the #6613 carrier widening is standalone-only"
status: done
sprint: current
created: 2026-10-07
updated: 2026-10-07
completed: 2026-10-07
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

## Resolution

Implemented as planned:

- `src/codegen/struct-carrier-inhabits.ts`: `hasNonStructElementForStructCarrier`
  now also returns true for an `externref` element whose
  `ctx.oracle.staticJsTypeOf` is `string`/`number`/`boolean`/`bigint`/`symbol`.
  `any`/`unknown`/object-typed externref elements are still skipped.
- `src/codegen/literals.ts`: the `(ctx.standalone || ctx.wasi)` gate on the
  #6613 call is gone.

Measured 2026-10-07 on upstream/main `e24d111705`, base vs fix:

- Probes (JS host): `[o, "s"]` → `[{"a":1},"s"]` (base `[{"a":1},null]`),
  `[o, 5]` → `[{"a":1},5]` (base trap), the Temporal table → `object,object,string,string`.
- `Temporal/PlainDate/from/limits.js` with the CI Temporal provider: pass
  (base: fail, "null with reject … got a TypeError").
- JS-host test262 sample, 1,616 rows (every file matching
  `[ident, <primitive literal>` in `built-ins/` + `language/`, plus a shuffled
  1,300 from `Array/prototype`, `expressions/array`, `statements/for-of`,
  `Temporal/PlainDate`, `Temporal/PlainDateTime/from`): base 1,197 → fix
  1,198 pass, +1 (`WeakMap/iterator-items-keys-cannot-be-held-weakly.js`),
  0 regressions. 31 rows were excluded from both sides because they hang the
  in-process runner (lengths near 2^32).
- Standalone test262, 616 rows (the same targeted files + 300 of the pool):
  identical on both sides (364 pass / 219 fail / 32 compile_error).
- npm suites, base = fix for all eleven (prettier 111/151, hono 294/324,
  redux 76/82, lodash 60/62, axios 219/231, jest 344/356, marked 18/30,
  uuid 75/75, clsx 32/32, cookie 63740/63740, moment 10/10).
- `tests/issue-6885-host-heterogeneous-array-literal.test.ts`: fails on the
  parent (`[{"a":1},null] object`), passes with the fix; the related
  array-literal suites (#1021, #2021, #4289, #4290, #5269, #5327, #6613, #786)
  show the same two pre-existing failures on base and fix.
