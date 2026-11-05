---
id: 7239
title: "IR: admit parameters with a compile-time-constant default (functions and class members)"
status: ready
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [869, 1372, 7233, 2949]
assignee: "ttraenkler/c-lead"
---

# #7239: default parameters still force the legacy path

## Problem

`src/ir/select.ts` refuses every parameter that has an initializer with
`param-shape-rejected`, whether the parameter is an identifier or a binding
pattern. #1372 (done) admitted plain destructured parameters, but not
defaults.

On the stride-40 standalone ledger (main `6a89ad6534`):
- `select:param-shape-rejected` accounts for 22 units;
- after #7233, default/destructured parameters are the first refusal for 18
  class-member units.

Legacy already has two default mechanisms:
- **#869 constant defaults.** A numeric, boolean, `null` or `undefined`
  literal, or a folded constant. `extractConstantDefault` /
  `foldConstantNumericDefault` in `src/codegen/index.ts` resolve these so a
  missing argument takes the constant.
- **Runtime defaults.** `paramDefaultNeedsArgc`, `param-tdz.ts`, and
  `paramDefaultsReferenceArguments` handle these with an argument count and
  TDZ checks.

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

1. **Measure and attribute first.**
   - Instrument a throwaway copy of the refusal at `select.ts` (~L2173 and
     L2199). Do not commit it.
   - Classify every stride unit refused for an initializer:
     - constant default (the #869 forms);
     - non-constant default (call, identifier, `this`, an earlier parameter);
     - rest parameter;
     - optional `?`;
     - default inside a binding pattern.
   - For the constant class, find where legacy supplies the constant: at the
     call site (the caller pushes the constant for a missing argument) or in
     the callee (sentinel test plus argc).
   - Write the answer down in this file before coding. The rest of the plan
     depends on it.
2. **Slice: constant defaults only**, on identifier parameters with a type
   the IR already resolves (number, boolean, string literal if legacy folds
   it).
   - **If the caller fills the constant:** the IR body can treat the
     parameter as an ordinary parameter. Admit it in the selector, keep the
     function's signature and ABI byte-identical to legacy, and make sure
     every IR call site that omits the argument emits the same constant.
     Route this through the existing call-lowering helper; do not write a
     second copy of the fold.
   - **If the callee tests a sentinel or argc:** emit the same test in the IR
     body through the existing `paramDefaultNeedsArgc` contract, or refuse
     and report back. Do not invent a new ABI.
   - The slice applies to plain functions, class methods, static methods and
     constructors alike. Each placement must pass its existing ABI-parity
     guard (#1370 for class methods).
3. **Stays on legacy:**
   - non-constant defaults (TDZ, `arguments`, earlier-parameter references);
   - rest parameters;
   - defaults inside binding patterns;
   - `async` and generator functions;
   - anything whose missing-argument value is `undefined` in a non-nullable
     slot.
4. **Do not touch** `dynamicUsesAreMoveOnly` (#2949; coordinate on #6583),
   or the getter-callable files of the Shepherd's in-flight repair:
   `class-bodies.ts`, `closures/method-trampolines.ts`,
   `program-abi-class-callable-planning.ts`, `method-receiver-this.ts`,
   `property-access-exact-shapes.ts`. If the #869 contract lives in one of
   those files, read it, but do not edit it.
5. **Never worse than legacy.** Every newly claimed unit must give the
   legacy-observable result on gc, standalone and wasi. Probe:
   - calls with and without the argument, an explicit `undefined`, and `null`;
   - `f.length`;
   - `.call`, `.apply` and spread calls;
   - a default overridden by `NaN` or `-0`;
   - methods called through subclasses and as values;
   - mixed IR and legacy callers of the same function.

## Acceptance criteria

- **Ledger A/B** (stride 40, standalone) in the PR body: IR units rise;
  `param-shape-rejected` falls; 0 invariants; `compileOk` is not lower.
- **Typed corpus:** byte-identical on gc, standalone and wasi, or every
  changed binary is explained and correct.
- **test262 A/B** on the route-changed files plus a sample: no test that
  passes on base fails on head (standalone).
- **Test:** `tests/equivalence/issue-7239-ir-default-parameters.test.ts` asserts,
  for each placement, the IR route (`trackIrOutcomes`) and the node/base
  result on 3 lanes.
