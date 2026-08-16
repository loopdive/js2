---
id: 4528
title: "axios: module init crashes with 'Cannot convert a Symbol value to a number' — 49 tests in 10 utils modules never run"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: symbols, coercion
goal: npm-library-support
related: [3995, 1434, 3511, 3676]
files:
  - src/runtime.ts
  - tests/dogfood/axios-upstream-suite.mjs
---

# axios: compiled module init routes a Symbol through ToNumber

## Problem

10 axios test modules (all the `tests/unit/utils/*` and several `helpers/*`
files) compile, validate, and then **crash during `__module_init`**:

```text
module init: TypeError: Cannot convert a Symbol value to a number
    at Number (<anonymous>)
    at src/runtime.ts:15866 (any_to_number / __unbox_number)
    at __module_init (wasm-function[454])
```

49 tests never execute. Measured 2026-08-16 on `a9b20d4c`; matches the
npm-compat card. Files: `formDataToJSON` (8), `parseHeaders` (3),
`progressEventReducer` (2), `endsWith` (1), `extend` (3), `forEach` (5),
`isX` (14), `kindOf` (1), `kindOfTest` (1), `merge` (9), `trim` (2).

The throwing site is the **correct** #1434 behavior (`Number(Symbol)` must
throw). The defect is upstream of it: axios's `utils.js` module scope never
calls `Number()` on a Symbol natively (75/75 of these callbacks pass in
Node), so the **compiler inserted a numeric coercion on a Symbol-valued
expression** during module init. axios's `utils.js` top level builds
`kindOfTest` tables and touches `Symbol.iterator` / `Symbol.toStringTag` /
`Symbol.asyncIterator` — a Symbol read is flowing into an `any_to_number`
unbox that the source never requests.

## Reproduction

```bash
node --import tsx tests/dogfood/axios-upstream-suite.mjs --json
# results.tests[*].wasmError startsWith "module init:" on the files above
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Get the exact expression**: instrument locally — wrap the
   `any_to_number` closure in src/runtime.ts (~15840) to print a stack and
   the wasm frame on Symbol input, run the smallest affected module
   (`endsWith.test.js`, 1 test). The wasm-side frame index identifies the
   emitting site; correlate with the generated `.axios-upstream-suite*`
   module's WAT (`--wit`-free `emitWat` compile of the same generated file,
   grep the caller of the unbox import around the reported function index).
2. **Expected shapes to check** (axios `utils.js` top level):
   - `const iterator = obj && obj[Symbol.iterator]` guarded reads where the
     compiler's dynamic-index probe ToNumber-probes the key — #3511 fixed
     this for element access; verify the *property-read-by-known-Symbol*
     path (`obj[Symbol.iterator]`) and the `typeof thing[Symbol.x]` shapes
     also use the Symbol-safe probe rather than `__unbox_number`.
   - comparison/arithmetic on `.length`-like fields whose inferred type
     collapsed to `any` and whose runtime value is a Symbol-keyed method.
3. **Fix at the emitting site**, not in the runtime: whatever coercion path
   sends a possibly-Symbol `any` into `any_to_number` for a *probe* (not a
   user-visible ToNumber) must use the Symbol-safe variant (`any_to_index`
   family, #3511) or a `ref.test`/typeof guard first. User-visible ToNumber
   on Symbol must keep throwing (#1434 tests pin this).
4. **Validation gates**: (a) reduction in `.tmp/` compiled+run (module init
   completes; Symbol-keyed reads return the method); (b) axios harness:
   the 10 modules initialize, 49 blocked tests surface their real results —
   record the new pass/total here; (c) `npm test -- tests/issue-3511` and
   the #1434 coercion tests stay green (both directions protected).

## Acceptance criteria

- [ ] All 10 affected modules complete `__module_init`.
- [ ] Committed reduction covering the identified Symbol-into-ToNumber shape.
- [ ] `Number(Symbol())` still throws (no regression on #1434).
