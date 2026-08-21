---
id: 4528
title: "axios: Symbol module-init coercion fixed; reference callback ABI remains"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-21
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
  - src/codegen/index.ts
  - tests/dogfood/axios-upstream-suite.mjs
---

# axios: compiled module init routes a Symbol through ToNumber

## Historical problem (fixed)

10 axios test modules (all the `tests/unit/utils/*` and several `helpers/*`
files) compile, validate, and then **crash during `__module_init`**:

```text
module init: TypeError: Cannot convert a Symbol value to a number
    at Number (<anonymous>)
    at src/runtime.ts:15866 (any_to_number / __unbox_number)
    at __module_init (wasm-function[454])
```

At the 2026-08-16 checkpoint, 49 tests never executed. That historical result
matched the npm-compat card on `a9b20d4c`; the Symbol-specific failure is now
fixed as recorded below.
The affected files were `formDataToJSON` (8), `parseHeaders` (3),
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

## Current checkpoint (2026-08-21)

The original Symbol-to-number defect is fixed at the codegen boundary. `resolveWasmType` now preserves the ESSymbol brand for module globals and destructured bindings, so the affected modules no longer call `Number(Symbol.iterator)` during initialization. The fresh Axios slice compiles and validates all 33 selected modules.

The next failure is distinct: 208/231 callbacks stop during module initialization because the existing numeric `__call_1_f64`/`__call_2_f64` bridge invokes a Wasm closure with a reference-valued array element. The runtime now wraps WasmGC closures at that boundary, exposing the real `toLowerCase is not a function` type mismatch instead of the misleading `fn is not a function`. A reference-preserving bridge needs a separate focused reduction; do not weaken `Number(Symbol())` semantics.

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

## Status

The Symbol regression criterion is satisfied and the existing coercion tests remain the guard. The unresolved criterion is the reference-valued callback bridge; it is tracked with exact denominator data in issue 4527 and is not reclassified as unavailable infrastructure.

- [ ] All 10 affected modules complete `__module_init`.
- [ ] Committed reduction covering the identified Symbol-into-ToNumber shape.
- [ ] `Number(Symbol())` still throws (no regression on #1434).
