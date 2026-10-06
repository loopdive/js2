---
id: 6881
title: "S3-k: the regime still reaches `env::__js_array_new` / `__js_array_push` (legacy-semantic) for `Array.prototype.includes` sparse-array rows — only inside the linked test262 harness"
status: ready
created: 2026-10-06
updated: 2026-10-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays
goal: architecture
sprint: current
parent: 5385
related: [6750, 4401, 6709]
---

# #6881 — a host array materialisation the policy gate still catches

Ten ES2016 rows (`built-ins/Array/prototype/includes/{sparse,fromIndex-equal-or-greater-length-returns-false,…}.js`)
fail on the regime lane with `Native-first semantic-provider policy rejected
… env::__js_array_new (legacy-semantic), env::__js_array_push`. The gate is
doing its job: some arm materialises a host JS array on the regime. Every
isolated shape probed on 2026-10-06 compiles clean (`[, , ,].includes(undefined)`
as a literal, as a call argument, inside an `assert.sameValue`-like method,
with `fromIndex`), so the emission depends on the linked-harness context
(`TEST262_ORACLE_MODE=linked`, the compile-once harness module + test body).

Known emitters of that pair: `src/codegen/array-like-hof-arms.ts` ≈ L270
(gated `ctx.standalone || ctx.wasi` → objvec; else host), `array-methods.ts`
`compileExternReceiverPushPop` (gated `!ctx.standalone && … !== "native-first"`),
`dyn-ops.ts` `ensureDynamicStringReplace` ≈ L546 (UNGATED: `__js_array_new`
hard-coded after the native early return at ≈ L335 — check whether the
regime reaches it), `closure-exports.ts` ≈ L1242 (`funcMap.get`), and
`array-methods.ts` ≈ L4180.

## Plan

1. Reproduce with the runner, one row, regime lane, `TEST262_ORACLE_MODE=linked`;
   dump the import list of the failing module (the runner prints it with the
   policy error) and the harness include set of the row.
2. Set `JS2WASM_TRACE_LATE_IMPORTS=1` (or add a one-line stack capture in
   `ensureLateImport` for the two names, under `.tmp/`) to find the emitter.
3. Re-key that emitter to the regime (`ctx.standalone`) with the objvec
   builders, exactly as `array-like-hof-arms.ts` does; byte identity for
   default gc.

## Acceptance

- [ ] The ten rows pass on the regime lane; `check:host-import-policy` 0/0.
- [ ] Focused test compiling the harness-shaped source under native-first
      asserts no `__js_array_*` import.
