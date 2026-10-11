---
id: 6881
title: "S3-k: the regime still reaches `env::__js_array_new` / `__js_array_push` (legacy-semantic) for `Array.prototype.includes` sparse-array rows — only inside the linked test262 harness"
status: done
created: 2026-10-06
updated: 2026-10-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays
goal: architecture
sprint: current
assignee: ttraenkler/opus-6881
completed: 2026-10-07
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

## Implementation notes (2026-10-07, opus-6881)

**The "linked harness" framing was wrong.** The nightly regime lane
(`test262-native-first`) runs with `TEST262_ORACLE_MODE` unset, i.e. the
honest whole-assembly lane, and the leak reproduces there — and in a plain
`compile()` of the assembled row (`assembleOriginalHarness`) with
`semanticProviders: "native-first"`. The isolated shapes compiled clean
because they had no `eval` in them.

**Root cause.** The assembly's `$262.evalScript` shim mentions `eval`, so the
module is a runtime-eval consumer. `index.ts` (`runtimeEvalConsumer`, the
pre-pass that collects reassigned bindings) then retypes every eval-visible
script `var` global to externref, because eval may store a value of a
different representation (correct, and shared with standalone). `var sample =
[, , , 42, , ]` therefore reaches `compileArrayMethodCall` with an externref
receiver, and the `includes` arm sent every externref receiver to
`compileArrayMethodExtern` (`array-method-host.ts`), which builds the argument
list with `env::__js_array_new` / `env::__js_array_push`. Found with a
temporary stack capture in `ensureLateImport` (not committed). None of the
emitters listed above were involved.

**Fix.** The `includes` arm takes the host bridge only when `!ctx.standalone`
(the regime predicate); the regime and standalone take the native vec loop
(`compileArrayIncludes`), which is what `at`, `indexOf`, `slice` and `reverse`
already do for the same receivers. gc and wasi have `ctx.standalone === false`,
so their bytes are unchanged. Verified at runtime under the regime:
`sample.includes(undefined | 42, fromIndex)` on the eval-widened global, plus
SameValueZero (`NaN`, `-0`).

**Relation to #6898.** With the #3418 dead-binding elision re-keyed to the
regime (the one-line experiment at `src/compiler.ts` ≈ L1823, not committed
here), the unused shim is elided, the module is no longer an eval consumer,
`sample` keeps its vec type, and `sparse.js` compiles clean without this fix.
This fix is still needed: any program with a live `eval` reaches the arm.

**Rows.** Plain `compile()` of the 30 `includes/` assemblies under
native-first: before, 11 rejected by the policy gate
(`fromIndex-equal-or-greater-length-returns-false`, `fromIndex-infinity`,
`fromIndex-minus-zero`, `length-zero-returns-false`,
`return-abrupt-tointeger-fromindex`, `samevaluezero`,
`search-found-returns-true`, `search-not-found-returns-false`, `sparse`,
`tointeger-fromindex`, `using-fromindex` — the nightly counted ten); after, 0.
The other 19 binaries are byte-identical. gc / standalone / wasi: sha256 of 8
probes per lane (3 eval/no-eval sources + 5 assemblies) identical before/after.

**Local runner caveat.** `TEST262_ORACLE_MODE=linked` with
`TEST262_SEMANTIC_PROVIDERS=native-first` fails EVERY row locally with
`imported mutable global must be a WebAssembly.Global object`
(`__js2wasm_link_error_ctor_Error`): the worker compiles the harness provider
without `semanticProviders` (`harnessProviderCompileOptions` in
`scripts/test262-worker.mjs`), so the provider is not the regime and does not
export the #6723 D4 carrier cells the regime body imports. CI does not run
that combination today; filed as a finding, not fixed here.

**Executed (not just compiled), regime, eval provider stubbed:** 10 of the 11
rows pass after the fix. `length-zero-returns-false` compiles but fails at
runtime, and fails identically with the #6898 elision instead of this fix, so
it is a separate defect in the native `compileArrayIncludes` (likely
`ToIntegerOrInfinity(fromIndex)` runs before the `len === 0` early return,
§23.1.3.16 step 3 vs 4 — the row counts `valueOf` calls). Not addressed here.
