---
id: 7253
title: "IR: admit ambient parseInt / parseFloat / escape / unescape / isNaN calls (module-init `external-call`)"
status: in-progress
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [1371, 7240, 7106]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-06 (#7253): the shape, admission and lowering live in the new
  # src/ir/ambient-global-function-call.ts. select.ts +27: the call-graph arm
  # (+5) and the diag-only `callee:<name>` detail on `external-call`
  # (`markExternal`, +22, the census instrument). from-ast.ts +27: the
  # resolver method's typed doc, the import and the 16-line host adapter.
  # integration.ts +8: the resolver method (4) and the native-strings import
  # going multi-line (4). native-strings.ts +1: re-exports the provider-symbol
  # helper so the IR bridge adds no new ir -> codegen import edge
  # (check:ir-layering).
  - src/codegen/native-strings.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
func-budget-allow:
  # 2026-11-06 (#7253): +2 — the one dispatch line (and its guard) into the
  # shared lowering; +4 — the resolver's `ambientGlobalFunctionTarget` method.
  - src/ir/from-ast.ts::lowerCall
  - src/ir/integration.ts::makeFromAstResolver
---

# #7253: module-init units rejected as `select:external-call` by host-free global functions

## Problem

`ir_only_pass` (standalone test262 passes with zero legacy units) is flat at
1088/48232. A blocked-by-one census of the wrapped ledger (stride 40,
standalone) found 8 files whose only legacy unit is `<module-init>`,
rejected by `select:external-call`: the module-init call graph reaches an
ambient global function the IR has no lowering for, so `buildLocalCallGraph`
marks the synthetic unit external (`src/ir/select.ts`, `assessModuleInit`
Gate 2).

## Measurement (2026-11-05, base `e73e190c6c`)

Wrapped compile (`loadWrappedCompiler`, `assembleOriginalHarness` primary +
`originalHarnessCompileOptions`), stride 40, standalone,
`JS2WASM_IR_SHAPE_DIAG=1`. The `external-call` refusal now carries
`detail: callee:<name>` under the diag flag (first external callee of the
unit; default output unchanged).

1296 compiled files (44 skipped), 25 with zero legacy-only units. Every
`<module-init>` `external-call` row in the stride, by callee:

| callee       | files | blocked by this alone |
| ------------ | ----: | --------------------: |
| `isNaN`      |     3 |                     3 |
| `parseInt`   |     2 |                     2 |
| `parseFloat` |     1 |                     1 |
| `unescape`   |     1 |                     1 |
| `Boolean`    |     1 |                     1 |

The 8 files: `annexB/built-ins/unescape/two.js`,
`built-ins/parseFloat/S15.1.2.3_A4_T1.js`,
`built-ins/parseInt/S15.1.2.2_A7.3_T2.js`, `built-ins/parseInt/S15.1.2.2_A2_T1.js`,
`language/expressions/{division/S11.5.2_A4_T1.1,multiplication/S11.5.1_A3_T2.4,modulus/S11.5.3_A3_T2.4}.js`
(`isNaN`), `built-ins/Boolean/S15.6.1.1_A1_T2.js` (`Boolean`). All other
units in those files already take the IR body (7 `both` + 1 `ir`).

### What legacy emits on standalone / WASI

- `parseInt(s[, r])` / `parseFloat(s)` (`call-identifier.ts`,
  `resolveGlobalParseBuiltin`): a string operand is widened to externref
  (`extern.convert_any`); a scalar / nullish operand is first ToString'd
  (`emitToString`). `parseInt`'s radix is compiled to f64; a missing radix
  pushes `f64.const nan` (the sentinel). Then `call` the native scanner from
  `ctx.ambientBuiltinFuncMap` (`emitNativeParseNumber`: `parseInt
  (externref, f64) -> f64`, `parseFloat (externref) -> f64`).
- `escape(s)` / `unescape(s)` (`annexb-escape-call.ts`): operand → externref
  carrier, a runtime Symbol test (throws TypeError), `emitToString`, then
  `call __escape` / `__unescape` (`(externref) -> externref`, the native
  string as externref).
- `isNaN(n)`: a Symbol-typed operand throws; otherwise the operand compiled to
  f64, `local.tee; local.get; f64.ne` (an unbranded i32).

## Implementation

- `src/ir/ambient-global-function-call.ts` — the shape both sides share:
  callee name, arity, and the one primitive family each operand position
  accepts (`string` text; `number` radix / `isNaN` operand).
- One admission both sides read (`ambientGlobalFunctionCall`): the shape and
  every operand checker-classified (`classifyDeclaredPrimitiveExpression`) as
  its family. On top of it both sides require the checker-resolved ambient
  binding and the new `native-global-function-call` capability (wasmgc,
  non-fast, standalone / WASI profile).
- Selector (`admitAmbientGlobalFunctionCall`, consulted in
  `buildLocalCallGraph`'s identifier arm): admitted calls are a lowering, not
  a call edge.
- from-ast (`tryLowerAmbientGlobalFunctionCall`): returns null where the
  selector would not admit (so the older call arms keep their calls), else
  lowers each operand to its family, then the provider the resolver names
  (`ambientGlobalFunctionTarget`: `ambientBuiltinFuncMap` for the parsers,
  `NATIVE_STRING_TRANSFORM_HELPERS` — legacy's own table — for escape /
  unescape). A missing radix is `f64.const nan`;
  the escape result recovers the native string through
  `dyn.string_carrier`; `isNaN` is `f64.ne n n` (boolean-branded).
- `Boolean(x)` is out of scope (a ToBoolean of arbitrary values, not a fixed
  provider call); it stays the one file of the 8 not moved.

## Acceptance

- Wrapped ledger A/B: `external-call` rows fall, zero-legacy files rise,
  0 invariants, compileOk not lower.
- Raw ledger byte-identical apart from timing; typed corpus unchanged on the
  three lanes.
- Standalone test262 A/B on `built-ins/{parseInt,parseFloat}`,
  `annexB/built-ins/{escape,unescape}`, `built-ins/isNaN`: no pass→fail.
- `tests/equivalence/issue-7253-module-init-external-calls.test.ts`.
- Code quality: the shape/admission lives once in
  `src/ir/ambient-global-function-call.ts` and both the selector and from-ast
  read it (no second predicate); the capability arm sits with its siblings in
  `legality.ts`; adversarial review with fresh context finds no unrebutted
  must-fix.
