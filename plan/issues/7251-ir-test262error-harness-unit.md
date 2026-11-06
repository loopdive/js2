---
id: 7251
title: "IR: the harness `Test262Error` unit (sta.js) — refusal chain and the string-lattice `message || \"\"` slice"
status: done
sprint: current
created: 2026-11-05
updated: 2026-11-06
completed: 2026-11-06
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

| bucket | files | outcome |
| --- | ---: | --- |
| default | 1056 | **already IR** (#7106 S3c route) |
| A. runtime eval may share the realm | 72 | `select:return-type-not-resolvable` — `return-type-unresolved(lattice=dynamic)` |
| B. the call-site lattice narrows `message` to `string` | 22 | `select:logical-value-unsupported` — `expr-logical-value-family «message \|\| ""»` |
| C. the S3c `instanceof` arm is off | 2 | `select:body-shape-rejected` — `expr-binary-op-instanceof «this instanceof Test262Error»` (`Iterator/zip/proto.js`, `Atomics/wait/value-not-equal.js`) |
| D. `.caller` observed | 6 | `resolve:late-preparation-unsupported` — "the source observes a current function's legacy caller activation" (`forbidden-ext/b2/*`, `Function/15.3.5.4_2-*gs.js`) |
| E. `new.target` threading | 1 | `resolve:new-target-threading` |
| no unit row (compile failed / unit absent) | 137 | — |

Of the 1296 compiled stride-40 files (1340 sampled, 44 skipped by
`shouldSkip`). Buckets
C–E are recorded, not chased: each is a different owner's arm (S3c instanceof
admission, the legacy caller-activation model, `new.target`).

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
- **Second change, found by the #7242 test:** once a self-guarded
  constructor with a `union` lattice param is claimed (e.g. `MyErr(7)` and
  `make("hi")` callers), the S3c value-use planner
  (`planIrImportedCalls`, `src/codegen/ir-imported-call-planning.ts`) resolved
  the claim's raw lattice signature and rethrew the `IrUnsupportedError` as a
  hard compile error (`no concrete type (mapped=union)`). A self-guarded value
  use never reads that signature (`dyn.construct` takes the carrier,
  `dyn.instanceof_fn` the unit target), so it now takes the opaque signature,
  exactly as receiver and stored uses already did in the same `catch`.
- **Not touched:** `dynamicUsesAreMoveOnly`, the Shepherd's getter-callable
  files, the runtime-eval callable carrier, the lattice core
  (`src/ir/propagate.ts`).
- **Code-quality criterion:** a two-token change to an existing table; no new
  arm, helper or branch.
- **Correctness:** never worse than base on gc, standalone, wasi
  (probes below); typed corpus byte-identical or explained; wrapped ledger
  A/B; raw ledger identical; standalone test262 A/B with no pass→fail.

## Results (2026-11-06, base `e73e190c`)

**Wrapped ledger** (`--wrapped --stride 40 --target standalone --jobs 2`,
`JS2WASM_IR_SHAPE_DIAG=1`):

| | base | head |
| --- | ---: | ---: |
| files / compileOk / compileFail / skipped | 1296 / 1118 / 178 / 44 | same |
| units | 14448 | 14448 |
| body route ir / both / legacy | 1137 / 8530 / 4781 | 1137 / **8552** / **4759** |
| harness legacy units | 3225 | **3203 (−22)** |
| test-origin routes | legacy 1556 / both 54 / ir 36 | same |
| `select:logical-value-unsupported` | 308 | 286 |
| `expr-logical-value-family «message \|\| ""»` | 22 | **0** |
| invariants | 0 | 0 |

No other `unsupportedByStageCode` or `unsupportedDetails` key moves. The 22
files are exactly bucket B: `Test262Error` becomes IR in each, harness legacy
units −1 per file. None of them had `Test262Error` as its only legacy unit
(they keep 1–5 other legacy units), so the
per-file zero-legacy count is unchanged (161 of the sample on base; no file
loses it).

**Raw ledger** (stride 40, standalone): identical JSON apart from
timing/commit fields.

**Typed corpus bytes** (playground examples, `examples/`,
`benchmarks/suites/`, interpolation-free program literals from
`tests/equivalence/`; gc / standalone / wasi; 6861 compiles, 4854
successful): byte-identical.

**Standalone test262 A/B** (`scripts/run-test262-paths.mts --standalone`,
296 files: the 22 bucket-B files + every 4th compiling file of the sample):
base and head both 210 pass / 83 fail / 3 compile_error, identical non-pass
set. 16 fails on both sides are "quickjs provider is not built" (no eval
engine in this container). 13 of the 22 bucket-B files pass on both.

**Probes** (`tests/equivalence/issue-7251-test262error-ir-unit.test.ts`, 27
cases on gc / standalone / wasi, sta.js verbatim + a literal-only caller):
throw + `instanceof` / `.message` / `String(e)` / `.constructor`; call
without `new`; `Test262Error.thrower`; `message` undefined / null / number;
`assert.throws`-shaped constructor check; prototype chain and own
`message`; plain `string ||` / `&&` functions and mixed callers. gc and
standalone equal node on every case; WASI differs from node on 6 of them on
base already, with identical values on head (pinned). On base 12 cases fail
the route assertion only.

**Related suites:** `issue-7242`, `issue-7243`, `issue-3471`,
`issue-2949-implicit-array-param`, every `tests/issue-7106-*`,
`issue-7240`: 4 failures on head, the same 4 on base (gc host-lane
expectations in `issue-7106-ir-dyn-instanceof`, `-module-init-chunks`,
`-prophelper-gopd-alias`, `-s3a-dynamic-construct`).

### Left open

- Bucket A (72/1296): needs the fnctor-struct return ABI in IR or S3c in a
  shared realm (runtime-eval callable carrier, session A). Those files keep
  ~8 other legacy harness units anyway.
- Buckets C–E (9/1296), see the chain table.
