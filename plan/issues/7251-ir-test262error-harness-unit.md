---
id: 7251
title: "IR: the harness `Test262Error` unit (sta.js) — refusal chain and the string-lattice `message || \"\"` slice"
status: in-progress
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
parent: 7106
related: [7242, 7243, 2949, 7240]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-05 (#7251): +2 lines, the `||`/`&&` entries in the existing IR_IMPLICIT_PARAM_PROJECTION_BINARY_OPS table (prettier puts one element per line)
  - src/codegen/index.ts
---

# #7251: the harness `Test262Error` unit

## Problem

`ir_only_pass` (a standalone test262 pass with zero legacy units, harness
included) is 1088/48232 and flat. Every test262 file links `harness/sta.js`:

```js
function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}
Test262Error.prototype.toString = function () { … };
Test262Error.thrower = function (message) { throw new Test262Error(message); };
```

The wrapped ledger (#7240) reports this unit refused
`return-type-unresolved(lattice=dynamic)` ×72 harness rows. A file whose
`Test262Error` unit is legacy can never reach zero legacy units.

## Refusal chain (measured 2026-11-05, base `e73e190c`)

Method: every stride-40 test262 file (the ledger's sample) compiled as
`scripts/ir-claim-ledger.mts --wrapped` does
(`assembleOriginalHarness(...).primary` +
`originalHarnessCompileOptions(meta, "standalone")`), `trackIrOutcomes`,
`JS2WASM_IR_SHAPE_DIAG=1`; the `Test262Error` unit's outcome recorded per file
(scratch script, not committed). Throwaway stubs in `src/ir/select.ts` and
`src/codegen/index.ts` peeled each refusal; none committed.

"IR" below means `irBodyEmitted` — the unit the test262 worker
(`summarizeIrRoute`, `scripts/test262-worker.mjs`) does NOT count as legacy.
In the default case the unit is IR with `r2Withdrawal:
function-value-reference` (the direct body is also emitted for the function
value, `legacyBodyEmitted: true`); the worker counts that as IR.

| bucket | share of the sample | outcome |
| --- | --- | --- |
| default | most files | **already IR** (#7106 S3c route) |
| A. runtime eval may share the realm | ~14 % | `select:return-type-not-resolvable` — `return-type-unresolved(lattice=dynamic)` |
| B. the call-site lattice narrows `message` to `string` | ~3 % | `select:logical-value-unsupported` — `expr-logical-value-family «message \|\| ""»` |

(final counts: see Results.)

### Bucket A — runtime eval may share the realm (out of scope)

1. `selfGuardedConstructorsLeaveFnctor(ctx)` is false
   (`src/codegen/helpers/self-guarded-constructor.ts`: a runtime-eval boundary
   plan whose shared realm may contain canonical values). S3c stands down on
   purpose: through the global-binding adapter `e.constructor ===
   Test262Error` fails (merge group pr-6844).
2. Legacy therefore keeps the **fnctor** lowering: `Test262Error`'s body is
   the allocator and its callable return slot is the `__fnctor_Test262Error`
   struct. The selector has no pre-ABI return evidence and the lattice says
   `dynamic`; the standalone lane has no `fallbackReturnType`, so the return
   is unresolvable → `return-type-unresolved(lattice=dynamic)`.
3. Every other harness unit in these files is legacy too:
   `late-preparation-unsupported` ("the linked runtime-eval callable carrier
   is still owned by the direct frontend") for `isNegativeZero`,
   `isPrimitive`, `formatIdentityFreeValue`, `formatSimpleValue`,
   `$DONOTEVALUATE`; `expr-ident-not-in-scope «assert»` for `assert`,
   `compareArray`. So none of these files can reach zero legacy units by
   fixing `Test262Error` alone.

Making `Test262Error` IR here needs either the fnctor-struct return ABI in IR
(the #3521 seam, a new ABI) or S3c in a shared realm (the pr-6844 identity
bug, which is the runtime-eval callable carrier owned by session A). Both are
out of this issue's bounds.

### Bucket B — `message` narrowed to `string` (the slice)

Reproducer: any file whose includes call `new Test262Error("literal")` from a
top-level function, e.g. `includes: [isConstructor.js]`
(`throw new Test262Error("isConstructor invoked with a non-function value")`)
or `asyncHelpers.js`.

1. The IR propagation lattice joins `assert`'s opaque `message` (`unknown`, no
   evidence) with the string literal → `Test262Error(message: string)`.
2. Legacy (`inferParamTypeFromCallSites`,
   `codegen/declarations/param-return-inference.ts`) sees an opaque `any`
   argument (`assert`'s `message`) and withdraws: the registered signature is
   `(func (param externref) (result externref))` — the same type as in the
   default case (WAT checked on both reproducers).
3. The IR's implicit-parameter projection
   (`makeIrImplicitParamTypeResolver`, `src/codegen/index.ts`), which both the
   selector (`resolveParamType`, `currentSelectionOptions.resolveImplicitParamType`)
   and the IR resolver (`resolveIrOverrideParamType`) consult to mirror
   legacy's ABI, only projects parameters that feed a listed operator
   (`IR_IMPLICIT_PARAM_PROJECTION_BINARY_OPS`: comparisons and `- * / %`),
   unary `+`/`-`, `.length`, an element access or a conditional test. `message
   || ""` is none of these, so the projection answers nothing and both sides
   fall back to the lattice's `string`.
4. With `message: string`, `string || string` is not a family the selector
   admits (`expr-logical-value-family`; from-ast only lowers the boolean and
   dynamic-carrier forms). Peeled with a stub that forces the selector to say
   `dynamic`: the builder then demotes at the same `||`
   (`requires bool operands`), because the resolver still says `string` —
   proof that the selector and resolver must change together, through the
   shared projection.
5. Peeled with the projection taught `||`/`&&` (the change below): the
   projection runs legacy's call-site inference, finds the opaque argument,
   answers `dynamic` on both sides, and the unit lowers exactly like the
   default case (`emitted`, `r2Withdrawal: function-value-reference`).

No further refusal: `this` as a receiver (`dyn.current_this`), `this
instanceof Test262Error` (`dyn.instanceof_fn`), `return new
Test262Error(message)` (`dyn.construct`), `this.message = …` (sloppy
`dyn.member_set`) and the dynamic return are all #7106 S3c arms that already
ship in the default case.

### ABI the IR unit must match

Legacy: `(func $Test262Error (param externref) (result externref))` on the
S3c lane (native construct driver, no `__fnctor_Test262Error`). The IR unit
with a dynamic param and dynamic return is that signature; the
`abi-signature-parity` guard stays as the backstop.

## Implementation Plan

- **Module:** `src/codegen/index.ts`, the implicit-parameter projection
  candidates (`IR_IMPLICIT_PARAM_PROJECTION_BINARY_OPS`). Add `||` and `&&`.
  The selector and the IR resolver already share this projection, so they
  keep agreeing by construction; no new predicate, no new ABI.
- **Reuses:** legacy's own `inferParamTypeFromCallSites` /
  `inferImplicitAnyParamType` verdict (the projection's existing body).
- **Not touched:** `dynamicUsesAreMoveOnly`, the Shepherd's getter-callable
  files, the runtime-eval callable carrier, the lattice core
  (`src/ir/propagate.ts`).
- **Code-quality criterion:** a two-token change to an existing table; no new
  arm, helper or branch.
- **Correctness:** never worse than base on gc, standalone, wasi
  (probes below); typed corpus byte-identical or explained; wrapped ledger
  A/B; raw ledger identical; standalone test262 A/B with no pass→fail.
