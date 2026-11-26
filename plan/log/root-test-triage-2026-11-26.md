# Root `tests/` triage — failing on main (2026-11-26)

Source: CI `issue-tests` run [45760154331](https://github.com/loopdive/js2/actions/runs/45760154331)
on main@76c8adf (2026-11-26 05:13 UTC), all 12 shard partials merged. Main has
since moved to c3b7be66 (58 commits); a full local run on c3b7be66 will update
this file with the delta.

- **4,287 failing tests in 1,280 of 4,872 root files.**
- 1,403 of them are in the post-merge known-failures baseline
  (`loopdive/js2wasm-baselines` `issue-tests-baseline.json`). 3,674 tests in
  1,117 files are not.

## Why this matters for every PR

The required `quality` check runs every root test file a PR adds or modifies:
the `Changed root test files must pass (#3008)` step, `pnpm run test:changed-root`,
in `.github/workflows/ci.yml`. It is not only the advisory
`issue-tests-changed` job; `quality` run 45797279959 on PR #7440 (observed by the C lead) shows the step
running them. So every file listed below blocks every PR that touches it, for a
reason that PR did not cause.

## The post-merge detector has not gated since 2026-07-19

`.github/workflows/issue-tests.yml` is meant to turn main red within one run of
any merge that breaks a previously green root test. It has not done so since its
last green run on main, run 29689686622 (2026-07-19).

- **Until 2026-10-16:** the shards crashed. One vitest fork per shard ran out
  of heap, no report was written, and the gate job never ran. #7014
  (82e59cfc39, 3f7f4fd150) fixed this with per-file forks.
- **Since then:** every completed run fails at the gate's run-integrity step
  (`scripts/issue-tests-gate.mjs`: "issue-tests run integrity failed", exit 2)
  before it diffs anything against the baseline. Example: run 45760154331,
  where the gate job refused with 13 errors.
- **The integrity errors are unhandled errors vitest cannot attribute to a
  file.** The gate refuses those by design. The errors were:
  - 9 × `[vitest-worker]: Timeout calling "onTaskUpdate"`: worker RPC
    starvation, with batches of 150 files on 2-core runners;
  - 1 × `ECONNREFUSED`;
  - 1 × an unhandled rejection from `tests/issue-1151-gap-b.test.ts` (fixed
    by S23);
  - 2 × `tests/issue-2701.test.ts` (JS-host node:fs adapter; see below).
- **Consequence:** the baseline never ratchets, nothing goes red, and new
  breakage accumulates unseen. Most of the 3,674 un-baselined failures arrived
  during this window.
- **Process failure:** a gate that refuses every run reports the same as a gate
  that is not wired up. Nobody was alerted, because the workflow is post-merge
  and is not a required check.

## Classes

The class comes from a heuristic on the first error line of each failing test.
A file is classed by its dominant class.

| class | meaning | files | tests |
|---|---|---|---|
| B | stale harness: the test calls raw `instance.exports`. Since #6708 S6 (612cea9864, 2026-10-14; native-first is the default), string and object results are native refs and must cross `wrapCompiledExports`. Symptoms: `expected {} to be 'hello'`, `Cannot convert object to primitive`, `type incompatibility`. Note: `wrapCompiledExports` alone was not enough in the one file probed (`issue-147` returned `''`); routing through `tests/equivalence/helpers.ts` `compileToWasm` / `instantiateWithRuntime` gave the right answer. | 217 | 1053 |
| M | stale harness: hand-rolled imports lack `__str_from_mem` / `__boundary_object_get` (LinkError) | 45 | 249 |
| R | stale API: `nativeStrings: false` / `semanticProviders: "host-assisted"` (both removed by #6979 S7), the boolean `standalone` option, `toNative` | 17 | 98 |
| I | Intl now needs `--host-accelerator intl` (#6978) | 3 | 32 |
| V | env: runtime-eval provider not linked | 12 | 44 |
| E | env or timeout (for example, `wat2wasm` missing from PATH) | 20 | 59 |
| C | compile or runtime error (illegal cast, null deref, `Codegen error`): likely real regressions or new refusals | 49 | 121 |
| A | plain assertion mismatch: a mix of stale expectations and real regressions | 917 | 2631 |

## Status of named files (2026-11-26)

- `issue-7364-prepared-named-refusals`, `issue-3522-private-method-admission`,
  `issue-1151-gap-b`: stale; repaired by S23 (branch
  `s23-named-root-test-repairs`).
- `issue-3518-runtime-projection-owner` (async attachment): stale since #7354
  Perf6; S16 is fixing it in PR #7440.
- `issue-6656-bigint-wide-carrier` `narrowedString`: **real regression**,
  #7497. Bisected to 89bd4bd78a (PR #6182, #5883).
- `issue-3632-eval-early-errors`: S22 owns it (#7491).
- `issue-2701` (node:fs/promises): **JS-host only.** A native string argument
  reaches the host fs adapter as a GC struct (`The "path" argument must be of
  type string ... Received [Object: null prototype] {}`). Per the standalone-only
  direction there is no id and no fix. It also produces 2 of the detector's
  integrity errors.

## Per-file list

Columns:
- **failing:** failing tests in the file.
- **new:** failing tests not in the known-failures baseline.
- **class:** dominant class, from the table above.
- **first error:** the first error line of the file's first failing test.

| file | failing | new | class | first error |
|---|---|---|---|---|
| `anon-struct.test.ts` | 1 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `array-capacity.test.ts` | 4 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `array-oob-bounds-check.test.ts` | 1 | 0 | C | RuntimeError: array element access out of bounds |
| `arraybuffer-dataview.test.ts` | 6 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `arrays-enums.test.ts` | 5 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `async-await.test.ts` | 3 | 3 | A | TypeError: You must provide a Promise to expect() when using .resolves, not 'object'. |
| `async-frame-host-throw-rejects.test.ts` | 2 | 2 | A | AssertionError: expected 'STRANDED' to be 'rejected:kaboom' // Object.is equality |
| `class-method-own-property-shadow.test.ts` | 5 | 5 | A | AssertionError: expected 'a' to be 'Ca' // Object.is equality |
| `class-vararg-bridge-export.test.ts` | 2 | 2 | A | AssertionError: expected 'undefined' to be 'function' // Object.is equality |
| `cli-imports-helper-export-metadata.test.ts` | 1 | 1 | A | AssertionError: expected {} to deeply equal { x: 1, y: 2 } |
| `closed-imports.test.ts` | 7 | 7 | A | AssertionError: expected undefined to be defined |
| `control-flow.test.ts` | 2 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `create-codegen-context.test.ts` | 1 | 0 | A | AssertionError: expected 3 to be +0 // Object.is equality |
| `date-native.test.ts` | 1 | 0 | A | AssertionError: expected 1795671943593 to be +0 // Object.is equality |
| `default-params.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'Hello Bob' // Object.is equality |
| `deno-safe-promise-constructor.test.ts` | 1 | 1 | A |  |
| `dom-containment.test.ts` | 4 | 0 | A | AssertionError: expected MockElement{ tagName: 'body', …(4) } to be null |
| `dom-style-assignment.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'schnucki' // Object.is equality |
| `dynamic-import-fixture-skip.test.ts` | 1 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `error-reporting.test.ts` | 3 | 0 | A | AssertionError: expected undefined to be defined |
| `es5-computed-harness-method-regression.test.ts` | 3 | 3 | A | AssertionError: expected 'fail: Test262Error: Expected SameValu…' to be 'pass: ' // Object.is equality |
| `es5-function-call-apply-null.test.ts` | 2 | 2 | A | AssertionError: Test262Error: #1: Function.prototype.apply can't be used as [[Construct]] caller \\| at L15: throw new Test262Error('#1: Func |
| `es5-function-constructor-residuals.test.ts` | 1 | 1 | A | AssertionError: Test262Error: The result of evaluating (e instanceof SyntaxError) is expected to be true \\| at L19: throw new Test262Error(' |
| `es5-standalone-annexb-global-script-eval.test.ts` | 6 | 6 | A | AssertionError: annexB/language/global-code/block-decl-global-existing-global-init.js: TypeError: dynamic code evaluation is not supported i |
| `es5-standalone-callable-tostring.test.ts` | 1 | 1 | A |  |
| `es5-standalone-ctor-identity.test.ts` | 8 | 8 | A | AssertionError: expected { num: 1, str: 1, bool: 1, …(3) } to deeply equal { num: 1, str: 1, bool: 1, cross: +0 } |
| `es5-standalone-wrapper-exotics-index.test.ts` | 1 | 1 | A | AssertionError: expected { neg: 1, past: 1, …(6) } to deeply equal { neg: 1, past: 1, …(6) } |
| `es5-standalone-wrapper-prototype.test.ts` | 6 | 6 | A | AssertionError: expected { boolToString: 1, …(7) } to deeply equal { boolToString: 1, …(5) } |
| `es5-this-binding-quad.test.ts` | 2 | 2 | A | AssertionError: expected 'fail: TypeError: dynamic code evaluat…' to be 'pass: ' // Object.is equality |
| `export-declarations.test.ts` | 2 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `fast-arrays.test.ts` | 1 | 0 | C | Error: Compile failed: |
| `finally-block.test.ts` | 5 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `for-of-rest-review-repairs.test.ts` | 1 | 1 | A | AssertionError: expected 709 to be 4143 // Object.is equality |
| `for-of-string-generator.test.ts` | 1 | 1 | A | did not finish within the serial re-run timeout |
| `gen-call-579.test.ts` | 1 | 1 | A | TypeError: gen.next is not a function |
| `generator-yield-contexts.test.ts` | 1 | 1 | A | did not finish within the serial re-run timeout |
| `generators.test.ts` | 1 | 1 | A | did not finish within the serial re-run timeout |
| `host-destructuring-regressions.test.ts` | 1 | 1 | A | AssertionError: async completion marker not observed: expected 'fail' to be 'pass' // Object.is equality |
| `host-proxy-promise-class-regressions.test.ts` | 1 | 1 | A | AssertionError: built-ins/Proxy/set/trap-is-missing-target-is-proxy.js: Test262Error: Expected a TypeError to be thrown but no exception was |
| `i32-loop-inference.test.ts` | 1 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `identity-array-search-fast-path.test.ts` | 1 | 1 | A | AssertionError: expected '(func $run (result f64)\n    (local $…' not to contain 'array.get' |
| `illegal-cast-vec-tuple-648.test.ts` | 5 | 0 | A | TypeError: function is not iterable (cannot read property Symbol(Symbol.iterator)) |
| `import-resolver.test.ts` | 8 | 0 | A | AssertionError: expected [] to include 'declare namespace THREE' |
| `imported-string-constants.test.ts` | 8 | 6 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `ir-backend-emitter.test.ts` | 1 | 1 | A | AssertionError: expected [ { op: 'ref.null.extern' }, …(2) ] to deeply equal [ { op: 'struct.new', typeIdx: 43 } ] |
| `ir-bytecode-wasmgc-vm.test.ts` | 1 | 0 | A | Error: STACK_TRACE_ERROR |
| `ir-dynamic-null-module.test.ts` | 6 | 6 | A | AssertionError: {"key":"dynamic-null.js::module-init::<module-init>#0","sourceId":"ir-source:v1:0000000000000000:entry:dynamic-null.js","uni |
| `ir-nullish-coalesce.test.ts` | 2 | 2 | B | TypeError: type incompatibility when transforming from/to JS |
| `ir-scaffold.test.ts` | 1 | 1 | A | AssertionError: expected [ 'compound', 'nonNumeric', …(11) ] to deeply equal [ 'compound', 'nonNumeric', …(10) ] |
| `issue-1006.test.ts` | 2 | 1 | V | TypeError: WebAssembly.instantiate(): Import #21 "js2wasm:runtime-eval": module is not an object or function |
| `issue-1014.test.ts` | 6 | 6 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1015.test.ts` | 1 | 0 | E | Error: ENOENT: no such file or directory, open '/workspace/test262/test/language/module-code/instn-iee-err-dflt-thru-star-as.js' |
| `issue-1026.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1042.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 7 // Object.is equality |
| `issue-1047.test.ts` | 1 | 1 | A | AssertionError: expected 1110 to be 1100 // Object.is equality |
| `issue-1051.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1052.test.ts` | 4 | 4 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1058-ambient-performance-global.test.ts` | 5 | 5 | A |  |
| `issue-1058-closure-rest-host-dispatch.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 15 // Object.is equality |
| `issue-1058-contextual-node-array-factory.test.ts` | 1 | 1 | A |  |
| `issue-1058-deferred-callable-property-dispatch.test.ts` | 1 | 1 | A | TypeError: Cannot access property on null or undefined at 24:23 |
| `issue-1058-erased-vec-closure-arg.test.ts` | 1 | 1 | A | TypeError: Cannot access property on null or undefined at 19:16 |
| `issue-1058-generic-asserted-write-through.test.ts` | 1 | 1 | A |  |
| `issue-1058-generic-base-node-factory.test.ts` | 4 | 4 | A | TypeError: Cannot access property on null or undefined at 4:44 |
| `issue-1058-generic-callback-result.test.ts` | 6 | 6 | A | TypeError: Cannot access property on null or undefined at 12:10 |
| `issue-1058-generic-factory-finish-node-flags.test.ts` | 1 | 1 | A | AssertionError: expected '(func $finishNode (type 55)\n    (loc…' to contain 'ref.test (ref' |
| `issue-1058-host-builtin-function-value.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 123456789 // Object.is equality |
| `issue-1058-interface-callback-coercion.test.ts` | 1 | 1 | A | TypeError: Cannot access property on null or undefined at 72:14 |
| `issue-1058-multifile-generic-callback-registration.test.ts` | 7 | 7 | A | TypeError: Cannot access property on null or undefined at 3:10 |
| `issue-1058-nested-optional-parameter.test.ts` | 1 | 1 | A | TypeError: Cannot access property on null or undefined at 20:18 |
| `issue-1058-node-array-factory.test.ts` | 1 | 1 | A |  |
| `issue-1058-node-array-vec-projection.test.ts` | 1 | 1 | A | AssertionError: expected NaN to be 171591 // Object.is equality |
| `issue-1058-nullable-vec-projection.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 42 // Object.is equality |
| `issue-1058-optional-method-padding.test.ts` | 3 | 3 | A | TypeError: Cannot access property on null or undefined at 8:20 |
| `issue-1058-optional-slot-closure-arg.test.ts` | 2 | 2 | A | TypeError: Cannot access property on null or undefined at 18:16 |
| `issue-1058-parenthesizer-property-identity.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1058-property-access-chain-carrier.test.ts` | 1 | 1 | A | AssertionError: expected NaN to be 1193 // Object.is equality |
| `issue-1058-runtime-namespace-member-call.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'local.ts:module.ts' // Object.is equality |
| `issue-1058-scope-scan-cache.test.ts` | 5 | 5 | A | AssertionError: expected 96 to be 48 // Object.is equality |
| `issue-1058-sibling-projection-write-through.test.ts` | 4 | 4 | A | AssertionError: stack-balance (#2090): cannot supply a missing stack value in function "__module_init" — operand stack underflow by 4 in an |
| `issue-1058-union-type-carrier.test.ts` | 1 | 1 | A | TypeError: Cannot access property on null or undefined at 9:10 |
| `issue-1058-unmatched-closure-host-call.test.ts` | 1 | 1 | A | TypeError: Cannot access property on null or undefined at 6:28 |
| `issue-1070.test.ts` | 3 | 3 | I | Error: Compile error: Intl.NumberFormat has no native implementation on the native semantic regime: compile with --host-accelerator intl (ho |
| `issue-1073.test.ts` | 3 | 2 | V | TypeError: WebAssembly.instantiate(): Import #20 "js2wasm:runtime-eval": module is not an object or function |
| `issue-1091.test.ts` | 1 | 0 | A | AssertionError: Expected compile success for: public = 42 in sloppy mode: expected false to be true // Object.is equality |
| `issue-1104-phase1.test.ts` | 8 | 7 | A | AssertionError: expected [ '__str_from_mem', …(2) ] to include '__new_Error' |
| `issue-1104-phase2.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to contain '$Error_struct' |
| `issue-1104-phase3.test.ts` | 2 | 0 | A | TypeError: WebAssembly.instantiate(): Import #0 "wasi_snapshot_preview1": module is not an object or function |
| `issue-1105-charcodeat.test.ts` | 1 | 1 | R | TypeError: toNative is not a function |
| `issue-1111.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1116.test.ts` | 8 | 8 | A | AssertionError: expected {} to be 'no-throw' // Object.is equality |
| `issue-1118.test.ts` | 1 | 1 | A | AssertionError: expected 'undefined' to be 'object' // Object.is equality |
| `issue-1119.test.ts` | 1 | 0 | A | Error: STACK_TRACE_ERROR |
| `issue-1120.test.ts` | 2 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to match /\(local \$a i32\)/ |
| `issue-1127-samevalue.test.ts` | 3 | 3 | A | Error: Compilation failed: emitted WebAssembly failed validation — WebAssembly.Module(): Compiling function #69:"test" failed: struct.get[0] |
| `issue-1129.test.ts` | 8 | 8 | B | AssertionError: expected {} to be 'object' // Object.is equality |
| `issue-1130.test.ts` | 3 | 1 | A | AssertionError: expected NaN to be 1 // Object.is equality |
| `issue-1131.test.ts` | 2 | 0 | E | Error: ENOENT: no such file or directory, open '/home/runner/work/js2/js2/benchmarks/competitive/programs/fib-recursive.js' |
| `issue-1163.test.ts` | 1 | 0 | V | TypeError: WebAssembly.instantiate(): Import #0 "js2wasm:runtime-eval": module is not an object or function |
| `issue-1164.test.ts` | 4 | 4 | V | AssertionError: expected {} to be 'hi' // Object.is equality |
| `issue-1173.test.ts` | 1 | 0 | E | Error: ENOENT: no such file or directory, open '/home/runner/work/js2/js2/benchmarks/compare-runtimes.ts' |
| `issue-1179-followup.test.ts` | 3 | 3 | B | TypeError: Cannot convert object to primitive value |
| `issue-1179.test.ts` | 1 | 0 | A | Error: STACK_TRACE_ERROR |
| `issue-1180.test.ts` | 2 | 2 | A | AssertionError: expected [ '__str_from_mem', …(17) ] to include '__is_truthy' |
| `issue-1182.test.ts` | 10 | 10 | A | AssertionError: expected [ { kind: 'build', func: 'fn', …(1) } ] to deeply equal [] |
| `issue-1186.test.ts` | 1 | 1 | R | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-1211.test.ts` | 1 | 1 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1224.test.ts` | 1 | 1 | A | AssertionError: expected undefined to be 7 // Object.is equality |
| `issue-1229.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'i' // Object.is equality |
| `issue-1231.test.ts` | 5 | 5 | A | AssertionError: typed-struct declaration ordinal for point/gc: expected 140 to be 13 // Object.is equality |
| `issue-1232.test.ts` | 11 | 11 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1234.test.ts` | 1 | 1 | A | did not finish within the serial re-run timeout |
| `issue-1236.test.ts` | 3 | 0 | A | AssertionError: expected '$sumTo_type (func (result f64)))\n  (…' to match /\(local \$s f64\)/ |
| `issue-1238.test.ts` | 1 | 1 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1239.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'threw' // Object.is equality |
| `issue-1243.test.ts` | 8 | 8 | B | AssertionError: expected {} to be 'x,y' // Object.is equality |
| `issue-1248.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 'id' // Object.is equality |
| `issue-1252.test.ts` | 8 | 8 | A | Error: Compilation failed: emitted WebAssembly failed validation — WebAssembly.Module(): Compiling function #69:"test" failed: struct.get[0] |
| `issue-1253.test.ts` | 3 | 3 | B | AssertionError: expected [Function] to throw error matching /Cannot convert object to primitive/i but got '' |
| `issue-1257.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 1 // Object.is equality |
| `issue-1268.test.ts` | 1 | 1 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1269.test.ts` | 3 | 0 | A | Error: Command failed: /workspace/node_modules/.bin/wasm-dis /tmp/issue-1269-1795671880103/module.wasm |
| `issue-1270.test.ts` | 6 | 0 | A | Error: Command failed: /workspace/node_modules/.bin/wasm-dis /tmp/issue-1270-1795671960934-s2pp9q7ulm/module.wasm |
| `issue-1275.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 2.5 // Object.is equality |
| `issue-1280.test.ts` | 2 | 0 | E | Error: spawn /workspace/node_modules/.bin/wasm-dis ENOENT |
| `issue-1286.test.ts` | 10 | 10 | B | AssertionError: expected {} to be 'a,b' // Object.is equality |
| `issue-1293.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'b' // Object.is equality |
| `issue-1296.test.ts` | 1 | 1 | E | Error: ENOENT: no such file or directory, open '/home/runner/work/js2/js2/dashboard/analytics.ts' |
| `issue-1298.test.ts` | 10 | 10 | B | AssertionError: expected {} to be 'hi!' // Object.is equality |
| `issue-1299.test.ts` | 3 | 0 | A | AssertionError: expected {} to be 'base:sub' // Object.is equality |
| `issue-1300.test.ts` | 4 | 4 | B | AssertionError: expected {} to be '<a>end</a>' // Object.is equality |
| `issue-1304.test.ts` | 3 | 3 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-1306.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'hi?' // Object.is equality |
| `issue-1308.test.ts` | 1 | 1 | A | TypeError: Expected a function |
| `issue-1310.test.ts` | 3 | 3 | B | TypeError: WebAssembly objects are opaque |
| `issue-1311.test.ts` | 1 | 0 | A | TypeError: Cannot access property on null or undefined at 21:18 |
| `issue-1312.test.ts` | 4 | 3 | C | RuntimeError: dereferencing a null pointer |
| `issue-1313.test.ts` | 8 | 8 | B | AssertionError: expected {} to be '[x]' // Object.is equality |
| `issue-1319.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'got STR' // Object.is equality |
| `issue-1320.test.ts` | 2 | 2 | C | Error: promise rejected "Error: CE: Codegen error: '__get_builtin'…" instead of resolving |
| `issue-1321.test.ts` | 18 | 18 | B | AssertionError: expected {} to be '1.23e-4' // Object.is equality |
| `issue-1322.test.ts` | 1 | 1 | A | AssertionError: expected [] to include 'env.Math_random' |
| `issue-1324.test.ts` | 13 | 13 | B | AssertionError: expected {} to be 'null' // Object.is equality |
| `issue-1328.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'true\\|1\\|abcd\\|1\\|bc' // Object.is equality |
| `issue-1329-b3.test.ts` | 3 | 3 | B | AssertionError: expected {} to be '[toString value]' // Object.is equality |
| `issue-1332.test.ts` | 1 | 1 | A | TypeError: called value is not a function |
| `issue-1339.test.ts` | 5 | 5 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1342-json.test.ts` | 1 | 1 | A | AssertionError: expected '{"keep":"yes","drop":null}' to be '{"keep":"yes"}' // Object.is equality |
| `issue-1342.test.ts` | 5 | 4 | A | AssertionError: expected null to be 'false' // Object.is equality |
| `issue-1347.test.ts` | 5 | 5 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1347b.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 3 // Object.is equality |
| `issue-1362.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1363.test.ts` | 2 | 0 | E | Error: ENOENT: no such file or directory, open '/workspace/test262/test/language/expressions/class/dstr/async-gen-meth-static-dflt-obj-ptrn- |
| `issue-1364b-class-method-delete.test.ts` | 1 | 1 | A | AssertionError: expected 100 to be 1 // Object.is equality |
| `issue-1366a.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'hi' // Object.is equality |
| `issue-1366b.test.ts` | 2 | 2 | A | AssertionError: expected NaN to be 16 // Object.is equality |
| `issue-1367.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1372-ir-destructuring-params.test.ts` | 1 | 1 | A | AssertionError: expected '(func $dot (param (ref null 47) (ref …' to match /struct\.get/ |
| `issue-1375-slice-b.test.ts` | 1 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1375.test.ts` | 2 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1378.test.ts` | 1 | 0 | E | Error: ENOENT: no such file or directory, open '/workspace/test262/test/language/statements/try/dstr/ary-init-iter-get-err.js' |
| `issue-1382.test.ts` | 7 | 7 | A | TypeError: Cannot read properties of undefined (reading 'even') |
| `issue-1387-with-diagnostic.test.ts` | 2 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1389.test.ts` | 2 | 2 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-139.test.ts` | 1 | 1 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `issue-1395-phase1.test.ts` | 7 | 7 | A | AssertionError: expected {} to be falsy |
| `issue-1397.test.ts` | 5 | 5 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-142.test.ts` | 1 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `issue-1431.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'PASS' // Object.is equality |
| `issue-1433.test.ts` | 2 | 2 | A | AssertionError: expected 'undefined' to be 'function' // Object.is equality |
| `issue-1434.test.ts` | 5 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1436.test.ts` | 9 | 9 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1438.test.ts` | 1 | 0 | A | Cannot find module '/workspace/.claude/worktrees/issue-1438/src/index.ts' imported from '/home/runner/work/js2/js2/tests/issue-1438.test.ts' |
| `issue-1439.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'heXXo' // Object.is equality |
| `issue-1441.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1443.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'ab<X>c' // Object.is equality |
| `issue-1444.test.ts` | 2 | 2 | C | Error: Compile error: Codegen error: standalone RegExp engine does not support duplicate capture group name 'x' (#1539 Phase 2a). Use a supp |
| `issue-1445.test.ts` | 7 | 7 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1455.test.ts` | 1 | 0 | A |  |
| `issue-1461.test.ts` | 5 | 5 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1462.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1463.test.ts` | 4 | 3 | A | AssertionError: expected [] to include '/* a */' |
| `issue-1464.test.ts` | 5 | 5 | A |  |
| `issue-1466.test.ts` | 1 | 1 | A | AssertionError: expected 0 to be greater than or equal to 1 |
| `issue-1467.test.ts` | 7 | 7 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-147.test.ts` | 6 | 6 | B | AssertionError: expected {} to be 'Bar' // Object.is equality |
| `issue-1470-standalone-string-imports.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to contain 'NativeString' |
| `issue-1471.test.ts` | 1 | 1 | A | AssertionError: expected [] to include '__box_number' |
| `issue-1472-es5-getprototypeof.test.ts` | 1 | 1 | V | TypeError: WebAssembly.instantiate(): Import #20 "js2wasm:runtime-eval": module is not an object or function |
| `issue-1472-standalone-regexp-legacy-static.test.ts` | 1 | 1 | A |  |
| `issue-1472.test.ts` | 11 | 11 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1480.test.ts` | 1 | 0 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__wasi_write_string_fd' |
| `issue-149-patterns.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 15 // Object.is equality |
| `issue-149.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 15 // Object.is equality |
| `issue-1490.test.ts` | 6 | 6 | A | AssertionError: expected +0 to be 2 // Object.is equality |
| `issue-1491.test.ts` | 3 | 3 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1492.test.ts` | 5 | 4 | C | AssertionError: expected [ 'randomBytes', 'randomUUID' ] to include undefined |
| `issue-1494.test.ts` | 4 | 4 | A | AssertionError: expected null to be '/tmp/example' // Object.is equality |
| `issue-1500.test.ts` | 7 | 2 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1501.test.ts` | 2 | 2 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-1502.test.ts` | 7 | 7 | A | TypeError: called value is not a function |
| `issue-1503.test.ts` | 2 | 2 | A | AssertionError: expected 0 to be greater than 0 |
| `issue-1504.test.ts` | 2 | 2 | A | AssertionError: expected '{}' to be '{"id":7,"name":"Alice"}' // Object.is equality |
| `issue-1511.test.ts` | 4 | 1 | A | Error: Compile failed: |
| `issue-1516.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1517.test.ts` | 7 | 7 | A | Error: Property 'fromAsync' does not exist on type 'ArrayConstructor'. Do you need to change your target library? Try changing the 'lib' com |
| `issue-1530.test.ts` | 4 | 0 | A |  |
| `issue-1533.test.ts` | 6 | 5 | A |  |
| `issue-1534.test.ts` | 5 | 5 | A |  |
| `issue-1540.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'ul' // Object.is equality |
| `issue-1552.test.ts` | 11 | 11 | B | AssertionError: expected {} to be '1-1' // Object.is equality |
| `issue-1553e.test.ts` | 3 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1557.test.ts` | 1 | 1 | A | AssertionError: No overload matches this call. |
| `issue-1564.test.ts` | 25 | 17 | B | AssertionError: expected {} to be 'eq-true' // Object.is equality |
| `issue-1575.test.ts` | 3 | 1 | A | AssertionError: expected Set{ 'http', 'https', 'http2', …(33) } to deeply equal Set{ 'http', 'https', 'http2', …(30) } |
| `issue-1588-str-to-utf8.test.ts` | 10 | 10 | C | RuntimeError: unreachable |
| `issue-1592.test.ts` | 2 | 2 | A | AssertionError: expected NaN to be 1034 // Object.is equality |
| `issue-1594a.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'function' // Object.is equality |
| `issue-1594b.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1596.test.ts` | 1 | 1 | C | AssertionError: Compile failed: |
| `issue-1597-standalone-reference-error.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1599-json-standalone-refuse.test.ts` | 2 | 2 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-1599.test.ts` | 1 | 0 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-1607.test.ts` | 1 | 1 | C | AssertionError: expected '(func $f (result f64)\n    unreachabl…' not to contain 'unreachable' |
| `issue-1613.test.ts` | 2 | 2 | C | RuntimeError: illegal cast |
| `issue-1617.test.ts` | 1 | 0 | E | Error: ENOENT: no such file or directory, open '/home/runner/work/js2/js2/playground/examples/dom/calendar.ts' |
| `issue-1620.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__iterator_next' |
| `issue-1629-S1.test.ts` | 6 | 6 | A | AssertionError: expected undefined to deeply equal {} |
| `issue-1629-S3.test.ts` | 2 | 2 | A | AssertionError: expected {} to deeply equal [ Array(4) ] |
| `issue-1629a.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'TypeError' // Object.is equality |
| `issue-1634.test.ts` | 5 | 5 | A | AssertionError: expected +0 to be 2 // Object.is equality |
| `issue-1636-json-stringify.test.ts` | 1 | 1 | A | AssertionError: expected '{"keep":"yes","drop":null}' to be '{"keep":"yes"}' // Object.is equality |
| `issue-1636-s1-tojson-this.test.ts` | 1 | 1 | B | AssertionError: expected {} to be undefined // Object.is equality |
| `issue-1637.test.ts` | 3 | 3 | A |  |
| `issue-1638.test.ts` | 8 | 8 | B | AssertionError: expected {} to be 'Invalid Date' // Object.is equality |
| `issue-1639.test.ts` | 1 | 1 | A | Error: The host-semantic implementation was removed (#6979); this module would need retired host imports: env::__get_async_generator_prototy |
| `issue-1645-detached-view-validate.test.ts` | 2 | 2 | A | AssertionError: gc-lane verdicts must be unchanged (all 0): expected false to be true // Object.is equality |
| `issue-1654-wasi-dataview-arraybuffer.test.ts` | 3 | 0 | C | RuntimeError: illegal cast |
| `issue-1655-wasi-arraybuffer-write.test.ts` | 1 | 0 | C | RuntimeError: illegal cast |
| `issue-1663.test.ts` | 1 | 1 | A | AssertionError: expected [] to deeply equal [ 'parseFloat', 'parseInt' ] |
| `issue-1667.test.ts` | 2 | 1 | B | TypeError: Cannot convert object to primitive value |
| `issue-1669-trampoline-externref-coercion.test.ts` | 1 | 1 | A | AssertionError: L99: generator-no-host-free-lowering: this generator has no host-free lowering yet (#7010). Neither the native generator sta |
| `issue-1672-async-gen-method-trampoline.test.ts` | 8 | 8 | A | AssertionError: expected 'fail' to be 'pass' // Object.is equality |
| `issue-1690b-var-shadows-module-global.test.ts` | 2 | 2 | B | AssertionError: expected {} to be undefined // Object.is equality |
| `issue-1695-propkey.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-1695.test.ts` | 1 | 1 | A | Error: No dependency provided for extern class "AsyncDisposableStack" |
| `issue-1698.test.ts` | 7 | 0 | C | RuntimeError: illegal cast |
| `issue-1700.test.ts` | 8 | 7 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1702-strict-this.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'undefined' // Object.is equality |
| `issue-1712-acorn-stack.test.ts` | 1 | 1 | A | RangeError: Maximum call stack size exceeded |
| `issue-1712-dynamic-dispatch.test.ts` | 7 | 7 | A | AssertionError: expected {} to deeply equal { input: 'inner' } |
| `issue-1712-exactfield-lane-guard.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'b' // Object.is equality |
| `issue-1712-reflection-identity.test.ts` | 5 | 5 | A | AssertionError: expected 'TypeError: dynamic code evaluation is…' to contain 'TypeError: Cannot access property on …' |
| `issue-1712-standalone.test.ts` | 1 | 1 | A | AssertionError: expected [ …(5) ] to deeply equal [] |
| `issue-1712.test.ts` | 1 | 1 | A | AssertionError: expected { inputs: 22, equal: +0, …(5) } to match object { inputs: 22, equal: 22, …(5) } |
| `issue-1716.test.ts` | 5 | 5 | B | AssertionError: expected null to be 'hit2' // Object.is equality |
| `issue-1719-cpr.test.ts` | 6 | 0 | C | Error: Compile failed: L2: Type '() => Generator<any, void, unknown>' is not assignable to type '() => ArrayIterator<any>'. |
| `issue-1727.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 100 // Object.is equality |
| `issue-1732-ns-call.test.ts` | 12 | 0 | R | Error: Unknown compile option 'standalone' — the standalone codegen regime is selected via target: "standalone", not a 'standalone' boolean. |
| `issue-1732-s1.test.ts` | 4 | 4 | A | AssertionError: expected 'Exception' to be 'TypeError' // Object.is equality |
| `issue-1735.test.ts` | 6 | 6 | B | AssertionError: expected {} to be '0e+0' // Object.is equality |
| `issue-1740.test.ts` | 6 | 6 | B | AssertionError: expected {} to be 'x121' // Object.is equality |
| `issue-1744.test.ts` | 2 | 2 | A | AssertionError: expected '(module\n (type $0 (sub (struct (fiel…' not to contain 'call $__str_charAt' |
| `issue-1749.test.ts` | 5 | 0 | C | Error: Compile failed: L2: Type '() => Generator<5 \\| 6, void, unknown>' is not assignable to type '() => ArrayIterator<any>'. |
| `issue-1753.test.ts` | 3 | 0 | A |  |
| `issue-1755.test.ts` | 1 | 1 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1764.test.ts` | 1 | 0 | A | AssertionError: expected '<!doctype html>\n<html lang="en">\n  …' to contain 'fetch(src, { cache: "no-store" })' |
| `issue-1767.test.ts` | 4 | 0 | A |  |
| `issue-1768.test.ts` | 1 | 0 | C | RuntimeError: dereferencing a null pointer |
| `issue-1769.test.ts` | 2 | 2 | A | AssertionError: expected 7 to be -1 // Object.is equality |
| `issue-1778.test.ts` | 1 | 1 | A | AssertionError: expected '<!doctype html>\n<html lang="en">\n  …' to match /updateHeadlineStat\(\s*\{ pass, fail,…/ |
| `issue-1780.test.ts` | 8 | 0 | A | AssertionError: expected +0 to be 3 // Object.is equality |
| `issue-1792.test.ts` | 7 | 7 | A |  |
| `issue-1793.test.ts` | 7 | 7 | A | ReferenceError: Buffer is not defined |
| `issue-1794.test.ts` | 1 | 1 | A |  |
| `issue-1795.test.ts` | 3 | 3 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1805.test.ts` | 5 | 0 | E | Error: ENOENT: no such file or directory, open '/workspace/test262/test/language/statements/switch/scope-lex-async-function.js' |
| `issue-1817.test.ts` | 1 | 1 | A | AssertionError: expected -1 to be 4294967295 // Object.is equality |
| `issue-1819.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'viaClosurezzz' // Object.is equality |
| `issue-1821-delete-struct-fastpath.test.ts` | 1 | 0 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-1828.test.ts` | 2 | 2 | A | AssertionError: expected 30 to be 1 // Object.is equality |
| `issue-1829.test.ts` | 4 | 4 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-1830.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'sp=true idx=true' // Object.is equality |
| `issue-1833.test.ts` | 2 | 2 | A |  |
| `issue-1837.test.ts` | 1 | 1 | B | AssertionError: expected {} to be '12ba' // Object.is equality |
| `issue-1862.test.ts` | 2 | 0 | A | AssertionError: expected -1 to be greater than -1 |
| `issue-1886.test.ts` | 1 | 0 | A | AssertionError: expected 'header' linear-safe: expected false to be true // Object.is equality |
| `issue-1897.test.ts` | 1 | 0 | A | AssertionError: expected '# CI Policy: branch protection and re…' to contain 'no branch-protection change is needed' |
| `issue-190.test.ts` | 1 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `issue-1900.test.ts` | 1 | 0 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-1905.test.ts` | 2 | 2 | A | AssertionError: expected [ '__str_from_mem', …(17) ] to include '__reflect_get' |
| `issue-1921.test.ts` | 1 | 0 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-1923.test.ts` | 1 | 1 | A | Error: STACK_TRACE_ERROR |
| `issue-1930-i32-safety.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'neg-zero' // Object.is equality |
| `issue-1930-oracle-slice2.test.ts` | 5 | 5 | B | TypeError: Cannot convert object to primitive value |
| `issue-1930-oracle.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'threw:Cannot convert a Symbol value t…' // Object.is equality |
| `issue-1933.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'desc-X' // Object.is equality |
| `issue-1965-super-ctor-body.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'fA;cA;fB;cB;fC;cC;' // Object.is equality |
| `issue-1969.test.ts` | 3 | 3 | B | AssertionError: expected {} to be '4:10:99' // Object.is equality |
| `issue-1970.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'x:10;y:20;' // Object.is equality |
| `issue-1988.test.ts` | 2 | 2 | A | AssertionError: expected '[object Object]1' to be '1,21' // Object.is equality |
| `issue-1989.test.ts` | 2 | 2 | A | AssertionError: expected '1,NaN' to be '8,101' // Object.is equality |
| `issue-1995.test.ts` | 8 | 8 | B | AssertionError: expected {} to be '[1,2,3,4,[5]]' // Object.is equality |
| `issue-1997.test.ts` | 10 | 10 | B | AssertionError: expected {} to be '1,2,3' // Object.is equality |
| `issue-1999.test.ts` | 7 | 6 | B | AssertionError: expected {} to be 'ab' // Object.is equality |
| `issue-2001-s1-hole-literal.test.ts` | 22 | 22 | B | AssertionError: expected {} to be 'undefined' // Object.is equality |
| `issue-2001-s2-hof-hole-skip.test.ts` | 3 | 3 | A | AssertionError: expected -1 to be 1 // Object.is equality |
| `issue-2005.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 'b=false' // Object.is equality |
| `issue-2008.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'a1b2c' // Object.is equality |
| `issue-201.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'foo' // Object.is equality |
| `issue-2011.test.ts` | 2 | 2 | B | AssertionError: expected {} to be '105,105' // Object.is equality |
| `issue-2012.test.ts` | 5 | 4 | B | AssertionError: expected {} to be 'false,1,false' // Object.is equality |
| `issue-2017.test.ts` | 4 | 2 | B | AssertionError: expected {} to be 'threw' // Object.is equality |
| `issue-2018.test.ts` | 1 | 1 | A | AssertionError: expected -1 to be +0 // Object.is equality |
| `issue-2021.test.ts` | 1 | 1 | A | AssertionError: expected 2 to be 13 // Object.is equality |
| `issue-2023.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'direct\\|sub' // Object.is equality |
| `issue-2025.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'threw' // Object.is equality |
| `issue-2026-constructor-identity-any.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2026-dynamic-new.test.ts` | 1 | 1 | B | AssertionError: expected {} to be '1:hi:true' // Object.is equality |
| `issue-2028.test.ts` | 4 | 4 | A | TypeError: You must provide a Promise to expect() when using .resolves, not 'object'. |
| `issue-2039.test.ts` | 3 | 3 | A | Error: compile failed: generator-no-host-free-lowering: this async generator has no host-free lowering yet (#7010). Neither the native gener |
| `issue-2040-tag5-field4-eq.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-2042-s3.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2045-escape-demotion.test.ts` | 1 | 0 | A |  |
| `issue-2051-optional-element-undefined.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'x' // Object.is equality |
| `issue-2063-switch-strict-equality.test.ts` | 3 | 3 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-2065.test.ts` | 2 | 0 | A | AssertionError: expected 3 to be 6 // Object.is equality |
| `issue-2066.test.ts` | 6 | 6 | B | AssertionError: expected {} to be 'ab' // Object.is equality |
| `issue-2069.test.ts` | 1 | 1 | B | AssertionError: expected {} to be '103,107' // Object.is equality |
| `issue-2086.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'rex' // Object.is equality |
| `issue-2089-fallback-telemetry.test.ts` | 2 | 0 | A | AssertionError: expected undefined to be 3 // Object.is equality |
| `issue-2104-value-tags.test.ts` | 1 | 1 | B | AssertionError: expected {} to be '42' // Object.is equality |
| `issue-2105.test.ts` | 1 | 1 | A | AssertionError: expected '1,0' to be 'true,false' // Object.is equality |
| `issue-2106-any-array-element-tag.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'boolean' // Object.is equality |
| `issue-2109.test.ts` | 7 | 7 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-2121.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'RE' // Object.is equality |
| `issue-2122.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'hi!' // Object.is equality |
| `issue-2124.test.ts` | 9 | 9 | R | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-2131.test.ts` | 6 | 6 | B | AssertionError: expected {} to be '12ba' // Object.is equality |
| `issue-2138-multi-module-ir-overlay.test.ts` | 5 | 5 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-2138.test.ts` | 1 | 1 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-2160-number-array-coercion.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2160-number-tolocalestring-standalone.test.ts` | 1 | 1 | A | AssertionError: expected [] to include '__extern_toLocaleString' |
| `issue-2161-b1-boxed-string.test.ts` | 1 | 1 | A |  |
| `issue-2161-undefined-sentinel-families.test.ts` | 1 | 1 | A | AssertionError: expected 102 to be 1 // Object.is equality |
| `issue-2163.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2164-iso.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2166-objvec-element-index.test.ts` | 1 | 0 | A | AssertionError: expected NaN to be +0 // Object.is equality |
| `issue-2166.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2173-yieldstar-generic-iterable.test.ts` | 9 | 9 | A |  |
| `issue-2175-null-proto-toprimitive.test.ts` | 1 | 1 | A | AssertionError: expected 5 to be 1 // Object.is equality |
| `issue-234.test.ts` | 7 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `issue-2375-object-is-native.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-241.test.ts` | 1 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-243.test.ts` | 1 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `issue-2500-uri-encoding.test.ts` | 1 | 1 | A | AssertionError: expected [ '__str_from_mem', …(2) ] to include 'encodeURIComponent' |
| `issue-2501.test.ts` | 2 | 2 | B | AssertionError: expected {} to be '[object String]\\|[object Number]\\|[obje…' // Object.is equality |
| `issue-2502-sort-externref.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'apple,banana,cherry' // Object.is equality |
| `issue-2505-anyarray-join.test.ts` | 1 | 1 | A | AssertionError: expected 5 to be 15 // Object.is equality |
| `issue-2515.test.ts` | 1 | 0 | B | AssertionError: expected {} to be 'v=null' // Object.is equality |
| `issue-2520-host-import-gate.test.ts` | 2 | 0 | A | AssertionError: expected '' to contain '"env.global_Date"' |
| `issue-2520-host-import-warning-verbosity.test.ts` | 2 | 0 | A | AssertionError: expected '/tmp/issue-2520-cli-Tv22SS/input.wasm…' to match /\d+ host import\(s\) not on the dual-…/ |
| `issue-2526-atomic-frame-writes.test.ts` | 2 | 0 | A |  |
| `issue-254.test.ts` | 5 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `issue-2551.test.ts` | 1 | 0 | A | AssertionError: expected NaN to be +0 // Object.is equality |
| `issue-2552-annexb-phase2.test.ts` | 4 | 4 | A | ReferenceError: f is not defined |
| `issue-2554-ir-tail-call.test.ts` | 1 | 1 | C | AssertionError: Codegen error: IR path failed for test: IR alloc-provenance check failed (#1586): |
| `issue-2573.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-2574.test.ts` | 1 | 1 | A | AssertionError: expected NaN to be 9 // Object.is equality |
| `issue-2580-any-length.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'undefined' // Object.is equality |
| `issue-2580-m3-bacc-defineproperty-accessor.test.ts` | 3 | 3 | B | AssertionError: expected {} to be '1=99;' // Object.is equality |
| `issue-2580-m3-protoextend.test.ts` | 1 | 1 | B | AssertionError: expected {} to be '0:a;1:b;' // Object.is equality |
| `issue-2596.test.ts` | 1 | 0 | A | AssertionError: expected 32 to be 16 // Object.is equality |
| `issue-2612.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2615.test.ts` | 1 | 1 | A | AssertionError: expected '    (local $p externref)' not to match /externref/ |
| `issue-2616.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-2617.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2623-capture-box-depth.test.ts` | 2 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-2623-p7-finally-bridge.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 41 // Object.is equality |
| `issue-2623-p7b-observable-resolve.test.ts` | 3 | 3 | A | AssertionError: expected 2 to be 1 // Object.is equality |
| `issue-263.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'MyClass' // Object.is equality |
| `issue-2632-phase3-stdin-prelude.test.ts` | 1 | 0 | A | AssertionError: expected 'declare function __wasiStdinReadByte(…' not to contain 'process.stdin' |
| `issue-2637-b1-executor-unwrap.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 7 // Object.is equality |
| `issue-2652.test.ts` | 3 | 3 | A |  |
| `issue-2660-s2-fnctor-prototype-object.test.ts` | 2 | 2 | A | AssertionError: expected NaN to be 7 // Object.is equality |
| `issue-2660-s3-fnctor-reconstruct.test.ts` | 5 | 5 | A | AssertionError: expected NaN to be 7 // Object.is equality |
| `issue-2666.test.ts` | 5 | 5 | A | AssertionError: expected 7 to be 110 // Object.is equality |
| `issue-2668-length-result.test.ts` | 2 | 2 | C | RuntimeError: requested new array is too large |
| `issue-2668.test.ts` | 1 | 1 | C | Error: Compile failed: L2: emitted WebAssembly failed validation — WebAssembly.Module(): Compiling function #68:"test" failed: struct.set[0] |
| `issue-2671-json-replacer.test.ts` | 5 | 5 | A | AssertionError: expected '{"a":{"b":2,"c":3}}' to be '{"a":{"c":3,"b":2}}' // Object.is equality |
| `issue-2671-promise-capability.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'entered\\|returned\\|all-ok' // Object.is equality |
| `issue-2671-promise-executor.test.ts` | 4 | 4 | A | AssertionError: expected +0 to be 2 // Object.is equality |
| `issue-2675.test.ts` | 12 | 12 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2676.test.ts` | 1 | 0 | A |  |
| `issue-2678.test.ts` | 1 | 1 | C | RuntimeError: array element access out of bounds |
| `issue-2679-toprimitive-this.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2682.test.ts` | 7 | 7 | R | TypeError: toNative is not a function |
| `issue-2688.test.ts` | 1 | 1 | A | AssertionError: [{"message":"Cannot find name 'Directive'.","line":37,"column":21,"severity":"warning","code":2304,"file":"apply-disable-dir |
| `issue-2689.test.ts` | 1 | 1 | A | AssertionError: Namespace '"eslint-scope@9.1.2/node_modules/eslint-scope/dist/eslint-scope"' has no exported member 'Variable'. |
| `issue-2693-host-delegated-select.test.ts` | 2 | 2 | A | Error: Cannot find module 'espree' |
| `issue-2693-linter-verify-demo.test.ts` | 1 | 1 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-2699.test.ts` | 5 | 5 | A | TypeError: The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received [Object: null prototype] {} |
| `issue-2701.test.ts` | 2 | 2 | A | TypeError: You must provide a Promise to expect() when using .resolves, not 'object'. |
| `issue-2702.test.ts` | 2 | 2 | A | AssertionError: expected 99 to be 1 // Object.is equality |
| `issue-2703.test.ts` | 1 | 0 | A |  |
| `issue-2704.test.ts` | 7 | 7 | A | Error: CE: Expected 0 arguments, but got 2. \\| generator-no-host-free-lowering: this async generator has no host-free lowering yet (#7010). |
| `issue-2712-bool-brand-total.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'T' // Object.is equality |
| `issue-2713-ir-legacy-parity.test.ts` | 13 | 13 | R | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-2717.test.ts` | 4 | 4 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-2724.test.ts` | 1 | 1 | C | RuntimeError: illegal cast |
| `issue-2726.test.ts` | 1 | 0 | A |  |
| `issue-2728.test.ts` | 1 | 1 | A | AssertionError: expected null to be 'hi' // Object.is equality |
| `issue-2736-target-axis.test.ts` | 1 | 1 | A | Error: Command failed: npx tsx /home/runner/work/js2/js2/src/cli.ts /tmp/issue-2736-D0o75v/input.ts -o /tmp/issue-2736-D0o75v --no-wat --no- |
| `issue-2739.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'skipped' // Object.is equality |
| `issue-2740.test.ts` | 6 | 6 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2742.test.ts` | 1 | 1 | A | Error: promise resolved "1" instead of rejecting |
| `issue-2750-s1.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-2760.test.ts` | 1 | 1 | B | AssertionError: expected {} to be undefined // Object.is equality |
| `issue-2766.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-2770.test.ts` | 1 | 1 | A | TypeError: called value is not a function |
| `issue-2773-arraylike-call-thisarg.test.ts` | 7 | 7 | B | AssertionError: expected {} to be '2\\|22,18' // Object.is equality |
| `issue-2773-hof-dynamic-index.test.ts` | 4 | 4 | A | AssertionError: stack-balance (#2090): cannot supply a missing stack value in function "run" — operand stack underflow by 2 in an empty-type |
| `issue-2773-oob-length-bound.test.ts` | 8 | 8 | B | AssertionError: expected {} to be 's,7,true,undefined' // Object.is equality |
| `issue-278.test.ts` | 5 | 5 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `issue-2781.test.ts` | 5 | 4 | A | AssertionError: expected {} to be 'foobar' // Object.is equality |
| `issue-2782.test.ts` | 3 | 1 | A | AssertionError: function IS IR-claimed (the local reaches lowerVarDecl): expected false to be true // Object.is equality |
| `issue-2785.test.ts` | 1 | 1 | B | AssertionError: expected {} to be undefined // Object.is equality |
| `issue-2789.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-2790.test.ts` | 5 | 1 | A | AssertionError: function IS IR-claimed (the local reaches lowerVarDecl): expected false to be true // Object.is equality |
| `issue-2791.test.ts` | 10 | 0 | R | Error: Unknown compile option 'standalone' — the standalone codegen regime is selected via target: "standalone", not a 'standalone' boolean. |
| `issue-2792.test.ts` | 4 | 4 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2794.test.ts` | 1 | 1 | A | AssertionError: expected 'undefined' to be 'object' // Object.is equality |
| `issue-2798.test.ts` | 5 | 5 | B | AssertionError: expected {} to be undefined // Object.is equality |
| `issue-28-promise-executor-invocation.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'object' // Object.is equality |
| `issue-2804.test.ts` | 7 | 7 | B | AssertionError: expected {} to be '1,2,3' // Object.is equality |
| `issue-2806.test.ts` | 3 | 3 | A | AssertionError: expected undefined to be 'Identifier' // Object.is equality |
| `issue-2818.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'outer' // Object.is equality |
| `issue-2841-arrow-param-name-type-marshalling.test.ts` | 4 | 4 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-2844.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 708 // Object.is equality |
| `issue-2846.test.ts` | 2 | 2 | A | AssertionError: expected 'object' to be 'bigint' // Object.is equality |
| `issue-285.test.ts` | 1 | 0 | C | RuntimeError: illegal cast |
| `issue-2850.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 'yz' // Object.is equality |
| `issue-2851.test.ts` | 4 | 4 | A | AssertionError: Target cannot be null or undefined. |
| `issue-2853.test.ts` | 1 | 1 | B | AssertionError: expected {} to be falsy |
| `issue-2856-async-delay-ir.test.ts` | 12 | 12 | A | AssertionError: expected [ 'delay' ] to deeply equal ArrayContaining{…} |
| `issue-2856-builtins-component.test.ts` | 5 | 5 | A | AssertionError: expected [ 'fixed' ] to not include 'fixed' |
| `issue-2856-calendar-residuals.test.ts` | 11 | 11 | A | AssertionError: expected [ 'Date_new', 'helper', 'years' ] to not include 'helper' |
| `issue-2856-inline-small-buffer-caller.test.ts` | 1 | 1 | A | AssertionError: expected '  (func $run (type 41)\n    (local $$…' to match /\bcall \d+/ |
| `issue-2856-module-bindings.test.ts` | 14 | 14 | A | AssertionError: expected [ 'numberString', …(4) ] to not include 'boolTemplateBad' |
| `issue-2856-shape-attribution.test.ts` | 1 | 1 | A | AssertionError: expected 'objectlit-spread:SpreadAssignment «..…' to be 'objectlit-spread:SpreadAssignment' // Object.is equality |
| `issue-2857.test.ts` | 1 | 0 | A | AssertionError: expected undefined to be 'class-method' // Object.is equality |
| `issue-2863-standalone-groupby.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-2863-standalone-tolocalestring.test.ts` | 1 | 1 | A | AssertionError: host mode must still route Array.toLocaleString to the host import: expected false to be true // Object.is equality |
| `issue-287.test.ts` | 1 | 1 | A | did not finish within the serial re-run timeout |
| `issue-2875-prototype-installed-tostring.test.ts` | 1 | 1 | A |  |
| `issue-2875-slice2-num.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2875.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2886.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'abc def' // Object.is equality |
| `issue-2895-async-frame.test.ts` | 3 | 3 | A | TypeError: (0 , isAsyncDriveActive) is not a function |
| `issue-2899.test.ts` | 1 | 1 | A | AssertionError: expected '[]' to contain '"__extern_set"' |
| `issue-2900.test.ts` | 1 | 1 | A | AssertionError: expected 'WebAssembly.instantiate(): Import #22…' to contain 'sameValue is not a function' |
| `issue-2902.test.ts` | 3 | 1 | A | AssertionError: expected [ '__str_from_mem', …(2) ] to include '__new_Test262Error' |
| `issue-2903-finally.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_call', …(17) ] to include 'Promise_finally' |
| `issue-2903-iter-helpers.test.ts` | 4 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2903-r1.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_get', …(21) ] to include 'Promise_new' |
| `issue-2903-r3.test.ts` | 1 | 1 | A |  |
| `issue-2903.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_call', …(17) ] to include 'Promise_then2' |
| `issue-2916.test.ts` | 1 | 1 | A | AssertionError: expected [ '__str_from_mem', …(2) ] to include '__instanceof' |
| `issue-2917-standalone-extends-builtin.test.ts` | 1 | 1 | A | AssertionError: expected [ 'env::__boundary_object_get', …(17) ] to include 'env::__new_Array' |
| `issue-2921.test.ts` | 1 | 1 | A | AssertionError: expected [ { …(5) } ] to deeply equal [] |
| `issue-2923-eval-const-broaden.test.ts` | 9 | 9 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-2928-direct-eval-state-pool.test.ts` | 2 | 2 | A | AssertionError: expected 11 to be 911 // Object.is equality |
| `issue-2928-runtime-acorn.test.ts` | 1 | 1 | A | AssertionError: expected [ { …(2) }, { …(2) }, { …(2) }, …(7) ] to deeply equal [ { …(2) }, { …(2) }, { …(2) }, …(6) ] |
| `issue-2928-runtime-link.test.ts` | 1 | 1 | A | AssertionError: expected [ Array(1) ] to deeply equal [] |
| `issue-2929-annexb-eval-lifecycle.test.ts` | 1 | 1 | V | TypeError: WebAssembly.instantiate(): Import #20 "js2wasm:runtime-eval": module is not an object or function |
| `issue-2949-direct-member-equality.test.ts` | 1 | 1 | A |  |
| `issue-2949-implicit-array-param.test.ts` | 1 | 1 | A | AssertionError: expected [ 'isInAstralSet', 'callAstral' ] to not include 'callAstral' |
| `issue-2949-module-var-scalars.test.ts` | 1 | 1 | A | AssertionError: expected [ 'functionFlags', 'callFlags' ] to not include 'callFlags' |
| `issue-2949-recursive-boolean-dynamic.test.ts` | 4 | 4 | A | AssertionError: [ |
| `issue-2949-s5-5-dyn-arith.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-2949-slice3b-any-dynamic.test.ts` | 1 | 1 | A | AssertionError: constructing from an any param: expected [ 'f' ] to not include 'f' |
| `issue-2951.test.ts` | 4 | 4 | A | AssertionError: expected [] to include 'g' |
| `issue-2952-slice3.test.ts` | 3 | 3 | A | TypeError: type incompatibility when transforming from/to JS |
| `issue-2952-slice5.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2952-slice6.test.ts` | 16 | 16 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-2956.test.ts` | 4 | 4 | A | AssertionError: expected [ { func: 'vecAlias', …(2) }, …(3) ] to deeply equal [] |
| `issue-2957.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 101 // Object.is equality |
| `issue-2959.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_get', …(18) ] to include 'Promise_new' |
| `issue-2962.test.ts` | 1 | 1 | A | AssertionError: expected [ 'test', '__sget_length', …(21) ] to not include '__exn_render_prepare' |
| `issue-2967-engine-convergence.test.ts` | 22 | 22 | A | invalid type: distinct rec groups would be identical after binary writing (to resolve this, use --enable-gc) at index 4 |
| `issue-2970.test.ts` | 2 | 2 | A | AssertionError: async completion marker not observed: expected 'fail' to be 'pass' // Object.is equality |
| `issue-2972.test.ts` | 5 | 5 | B | AssertionError: expected {} to be '3' // Object.is equality |
| `issue-2973.test.ts` | 1 | 0 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-2976.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'true\\|true\\|true' // Object.is equality |
| `issue-2978-forawait-rejected.test.ts` | 4 | 4 | A | AssertionError: lane {}: async shape not supported: this suspension point (await / for-await) sits inside a 'try' whose overall body shape t |
| `issue-2984-alias-receivers.test.ts` | 1 | 1 | A | AssertionError: expected 3 to be 1 // Object.is equality |
| `issue-2988.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_get', …(20) ] to include '__get_globalThis' |
| `issue-2992-accessor-widening.test.ts` | 3 | 3 | A | AssertionError: expected 0 to be greater than 0 |
| `issue-2993.test.ts` | 1 | 1 | A | AssertionError: expected NaN to be 7 // Object.is equality |
| `issue-2996.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_get', …(21) ] to include '__get_globalThis' |
| `issue-2998.test.ts` | 1 | 1 | A | AssertionError: expected [ '__str_from_mem', …(2) ] to include '__instanceof_check' |
| `issue-300.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3000-1b.test.ts` | 2 | 2 | R | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-3000-c.test.ts` | 2 | 2 | R | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-3000-e.test.ts` | 2 | 2 | R | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-3000.test.ts` | 2 | 2 | B | TypeError: Cannot convert object to primitive value |
| `issue-3006-builtin-constructor-identity.test.ts` | 1 | 1 | A | AssertionError: expected [ 'env::__boundary_object_get', …(20) ] to include 'env::Object_get_constructor' |
| `issue-3009.test.ts` | 1 | 0 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-3014.test.ts` | 2 | 2 | A |  |
| `issue-3017-function-poison-pill.test.ts` | 2 | 2 | C | RuntimeError: dereferencing a null pointer |
| `issue-3032-w6-host-lane-laziness.test.ts` | 1 | 1 | A | AssertionError: expected 'undefined' to be 'function' // Object.is equality |
| `issue-3037-cs1biii-descriptor-value-carrier.test.ts` | 2 | 0 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-3037-cs1c-getprototypeof-carrier.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-3046.test.ts` | 1 | 1 | A | AssertionError: expected 32 to be 12 // Object.is equality |
| `issue-3049.test.ts` | 5 | 5 | A | TypeError: Cannot read properties of undefined (reading 'call') |
| `issue-3051.test.ts` | 14 | 14 | B | Error: Compile failed: |
| `issue-3052.test.ts` | 1 | 1 | R | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-3053-u1-ir-member-read.test.ts` | 1 | 0 | A | AssertionError: expected 2097453 to be undefined |
| `issue-3053-u2-claim-flip.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 42 // Object.is equality |
| `issue-3058-dyn-view-proto-methods.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 100 // Object.is equality |
| `issue-3058-host-resizable-ab.test.ts` | 11 | 11 | B | TypeError: WebAssembly.instantiate(): Import #20 "js2wasm:runtime-eval": module is not an object or function |
| `issue-3063-escape-unescape-host.test.ts` | 8 | 8 | B | AssertionError: expected {} to be '%7E' // Object.is equality |
| `issue-3078-number-undefined-arg.test.ts` | 7 | 7 | B | AssertionError: expected {} to be '1.23456e+2' // Object.is equality |
| `issue-3081-number-namespace-const-receiver.test.ts` | 6 | 6 | B | AssertionError: expected {} to be 'ff' // Object.is equality |
| `issue-3097.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3118-new-object-primitive.test.ts` | 10 | 10 | B | AssertionError: expected NaN to be 5250 // Object.is equality |
| `issue-3123.test.ts` | 4 | 3 | A | AssertionError: expected +0 to be 11 // Object.is equality |
| `issue-3133-instance-constructor-identity.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-3134-promise-value-slot-rep.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 42 // Object.is equality |
| `issue-3137.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_get', …(17) ] to include 'Promise_allSettled' |
| `issue-3139.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 3 // Object.is equality |
| `issue-3142.test.ts` | 3 | 3 | B | AssertionError: expected null to be 'body-shape-rejected' // Object.is equality |
| `issue-3144-ir-class-claims.test.ts` | 3 | 3 | A | AssertionError: legacy value: expected {} to strictly equal 'Animalia \\| Animalia (canine)' |
| `issue-3156.test.ts` | 3 | 3 | A | AssertionError: expected [ { module: 'env', …(2) }, …(2) ] to deep equally contain ObjectContaining{…} |
| `issue-3160.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3163.test.ts` | 5 | 5 | B | TypeError: Cannot convert object to primitive value |
| `issue-3177-fromof.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3177.test.ts` | 1 | 0 | A |  |
| `issue-3186.test.ts` | 1 | 1 | B | AssertionError: expected {} to be '"a""b"' // Object.is equality |
| `issue-3192.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3199.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'initialValue is present' // Object.is equality |
| `issue-320.test.ts` | 6 | 5 | A | TypeError: WebAssembly.instantiate(): Import #0 "env": module is not an object or function |
| `issue-3201-expando-method.test.ts` | 5 | 5 | B | TypeError: Cannot convert object to primitive value |
| `issue-3214-callable-abi.test.ts` | 4 | 4 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3214-imported-hof.test.ts` | 8 | 8 | A | AssertionError: expected [ 'fortyOne' ] to include 'main' |
| `issue-3214-void-host-callback.test.ts` | 6 | 6 | R | Error: Compile option semanticProviders: "host-assisted" selected the host-assisted semantic profile, which #6979 removed (last accepted by |
| `issue-3227-s2.test.ts` | 6 | 6 | A | AssertionError: expected +0 to be 7 // Object.is equality |
| `issue-3231-standalone-native-disposablestack.test.ts` | 2 | 2 | A | AssertionError: expected [ '__boundary_object_get', …(17) ] to include 'DisposableStack_new' |
| `issue-3234-standalone-suppressederror.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3239-standalone-subclass-typedarray-native-ctor.test.ts` | 1 | 1 | A | AssertionError: expected [ 'env::__boundary_object_get', …(19) ] to include 'env::__new_Uint8Array' |
| `issue-325.test.ts` | 6 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `issue-3266.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'abcde' // Object.is equality |
| `issue-3276.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be 11 // Object.is equality |
| `issue-328.test.ts` | 7 | 0 | C | Error: Compile failed: |
| `issue-3280.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'foobar' // Object.is equality |
| `issue-3284-rc2.test.ts` | 2 | 2 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3287.test.ts` | 1 | 1 | V | TypeError: WebAssembly.instantiate(): Import #23 "js2wasm:runtime-eval": module is not an object or function |
| `issue-3288.test.ts` | 4 | 4 | A | AssertionError: expected [ 'local.get:0', 'local.get:1', …(64) ] to deeply equal ArrayContaining{…} |
| `issue-3301.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 'gi' // Object.is equality |
| `issue-3323.test.ts` | 6 | 6 | B | AssertionError: expected {} to be '0,1,' // Object.is equality |
| `issue-3343.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 13 // Object.is equality |
| `issue-3344.test.ts` | 1 | 1 | A | AssertionError: expected 'merge-base(origin)' to be 'merge-base' // Object.is equality |
| `issue-3366.test.ts` | 1 | 1 | A | AssertionError: expected undefined to be 42 // Object.is equality |
| `issue-3370.test.ts` | 1 | 0 | A | AssertionError: expected undefined to be '"use strict";\n// Host globals suppli…' // Object.is equality |
| `issue-3371-r4-reflect-construct-newtarget.test.ts` | 2 | 2 | A | AssertionError: expected 2 to be +0 // Object.is equality |
| `issue-3371.test.ts` | 1 | 1 | A | Error: promise rejected "TypeError: WebAssembly.instantiate(): Imp…" instead of resolving |
| `issue-3387-asyncgen-forawait-dstr.test.ts` | 5 | 5 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3390.test.ts` | 1 | 1 | A | AssertionError: expected [ …(20) ] to include 'env.Promise_all' |
| `issue-3418.test.ts` | 2 | 2 | A | AssertionError: expected [ '__boundary_callback_call_0', …(23) ] to include 'console_log_externref' |
| `issue-342.test.ts` | 4 | 0 | C | Error: Compile failed: |
| `issue-3420-standalone-array-own-property.test.ts` | 1 | 1 | A | AssertionError: expected { env: {}, …(7) } to deeply equal {} |
| `issue-3422.test.ts` | 1 | 1 | A | AssertionError: built-ins/Math/PI/prop-desc.js: Test262Error: PI should be an own property: expected 'fail' to be 'pass' // Object.is equali |
| `issue-3426-realm-canary-log-baseline.test.ts` | 1 | 1 | A | AssertionError: expected [] to have a length of 1 but got +0 |
| `issue-3426-realm-canary.test.ts` | 5 | 5 | A | AssertionError: built-ins/AsyncDisposableStack/prototype/defer/prop-desc.js must have a strict rerun: expected undefined to be defined |
| `issue-3426.test.ts` | 2 | 0 | A | AssertionError: step "Compile-time regression guard (#1942)" not found: expected -1 to be greater than -1 |
| `issue-3427-isprimitive-dedup.test.ts` | 2 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3428.test.ts` | 2 | 0 | A | AssertionError: expected 'fail' to be 'pass' // Object.is equality |
| `issue-3430.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'TypeError:10' // Object.is equality |
| `issue-3433.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3435.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3436-standalone-prelude-leak.test.ts` | 1 | 1 | A | AssertionError: expected [] to include 'structuredClone' |
| `issue-344.test.ts` | 12 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `issue-3451-linked-harness-lane.test.ts` | 2 | 2 | A | AssertionError: expected '/**\n * Shared infrastructure for tes…' to contain 'const ORACLE_LANE = test262OracleLane…' |
| `issue-3451-linked-harness-substrate.test.ts` | 4 | 4 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-3460.test.ts` | 1 | 1 | B | AssertionError: expected {} to be '1,2,3' // Object.is equality |
| `issue-347.test.ts` | 8 | 8 | B | AssertionError: expected {} to be 'Bar' // Object.is equality |
| `issue-3481-cause2-error-message-tostring.test.ts` | 16 | 16 | A | AssertionError: expected 'NO-THROW' to be 'T262' // Object.is equality |
| `issue-3481-step2-symbol-arg-revalidation.test.ts` | 1 | 1 | A | AssertionError: expected undefined to be 'hi' // Object.is equality |
| `issue-3481-step3-toprimitive-field-number-hint.test.ts` | 2 | 2 | A | AssertionError: expected '5' to be 's' // Object.is equality |
| `issue-3481-symbol-keyfor-narrowed-any.test.ts` | 10 | 10 | A | AssertionError: expected 'null' to be 'regkey' // Object.is equality |
| `issue-3481-symbolarr-vec-brand.test.ts` | 7 | 7 | A | AssertionError: expected 'number\\|false' to be 'symbol\\|true' // Object.is equality |
| `issue-3481-toprimitive-wrapper-unwrap.test.ts` | 38 | 38 | A | AssertionError: expected undefined to be 'TypeError' // Object.is equality |
| `issue-3486-fnctor-constructor-identity.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-349.test.ts` | 12 | 12 | B | AssertionError: expected {} to be 'true' // Object.is equality |
| `issue-3494-standalone-literal-dynamic-import.test.ts` | 1 | 1 | A | AssertionError: expected [ 'env.__boundary_object_get', …(17) ] to include 'env.__dynamic_import' |
| `issue-3497-linear-jsdoc-landing-signatures.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-3499-porffor-typed-bitwise-composites.test.ts` | 2 | 2 | A | AssertionError: expected [] to strictly equal [ 'js.bitor', 'js.bitor' ] |
| `issue-3500-linear-ir-recursive-call-graph-type-evidence.test.ts` | 3 | 3 | A | AssertionError: emitted WebAssembly failed validation — WebAssembly.Module(): Compiling function #53:"recur" failed: f64.le[0] expected type |
| `issue-3502-string-contract.test.ts` | 1 | 1 | A | AssertionError: expected [ 'elseJoin', 'shortCircuitJoin' ] to strictly equal [ 'elseJoin' ] |
| `issue-3504-test262-fyi-module-goal.test.ts` | 1 | 1 | A | AssertionError: language/module-code/early-dup-top-function-async-generator.js: expected true to be false // Object.is equality |
| `issue-3505-host-compilemulti-harness-callable-init.test.ts` | 2 | 2 | A | AssertionError: expected { pass: false, phase: 'runtime', …(3) } to match object { pass: true, phase: 'runtime', …(1) } |
| `issue-3509.test.ts` | 1 | 1 | A | AssertionError: expected [ 'env.__str_from_mem', …(2) ] to include 'env.__dynamic_import' |
| `issue-3511.test.ts` | 4 | 4 | A | AssertionError: stack-balance (#2090): cannot supply a missing stack value in function "test" — operand stack underflow by 2 in an empty-typ |
| `issue-3512.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3517-map-module-init.test.ts` | 4 | 4 | A | AssertionError: expected [] to deeply equal [ 'Map_get', 'Map_new', 'Map_set' ] |
| `issue-3518-allocation-runtime-seam.test.ts` | 1 | 1 | A | AssertionError: expected [ 'alias', 'annotate', …(15) ] to deeply equal [ 'alias', 'annotate', …(13) ] |
| `issue-3518-bench-array-prepared-cutover.test.ts` | 1 | 1 | A | AssertionError: expected [ …(13) ] to deeply equal [ …(13) ] |
| `issue-3518-bench-string-prepared-cutover.test.ts` | 2 | 2 | A | AssertionError: expected Set{ …(105) } to deeply equal Set{ 'TypeError', …(106) } |
| `issue-3518-certified-delay-source-admission.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3518-closure-coordinate-audits.test.ts` | 5 | 5 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-extensible-self-root.test.ts` | 3 | 3 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-host-coercion-get-abrupt.test.ts` | 10 | 10 | A | AssertionError: expected NaN to be 7 // Object.is equality |
| `issue-3518-ir-math-switch-retirement.test.ts` | 1 | 1 | C | AssertionError: Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 |
| `issue-3518-native-async-resource-declarations.test.ts` | 2 | 2 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-authentication-performance.test.ts` | 1 | 1 | A | Error: replaced probe called |
| `issue-3518-native-boolean-boxes.test.ts` | 3 | 3 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-clock-projection.test.ts` | 12 | 12 | A | AssertionError: expected [Function] to throw error matching /clock projection / but got 'IR async runtime attachment for main …' |
| `issue-3518-native-family-source-identity.test.ts` | 2 | 2 | A | AssertionError: expected [Function lower] to throw an error |
| `issue-3518-native-getter-resource-join.test.ts` | 1 | 1 | A | Error: WasmGcEmitter: string.const runtime is unavailable |
| `issue-3518-native-getter-results.test.ts` | 2 | 2 | A | Error: WasmGcEmitter: string.const runtime is unavailable |
| `issue-3518-native-invocation-substrate.test.ts` | 7 | 7 | A | AssertionError: expected [Function] to throw error matching /altered/ but got 'native argument vectors: noncanonical…' |
| `issue-3518-native-mixed-object-access.test.ts` | 2 | 2 | A | Error: WasmGcEmitter: string.const runtime is unavailable |
| `issue-3518-native-number-format-resources.test.ts` | 3 | 3 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-object-access-resources.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-promise-inventory-emission.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-promise-inventory.test.ts` | 1 | 1 | A | AssertionError: expected { program: { …(12) }, …(7) } not to be { program: { …(12) }, …(7) } // Object.is equality |
| `issue-3518-native-realm-object-layouts.test.ts` | 1 | 1 | A | Error: WasmGcEmitter: string.const runtime is unavailable |
| `issue-3518-native-realm-source-integration.test.ts` | 3 | 3 | A | AssertionError: expected 3 to be +0 // Object.is equality |
| `issue-3518-native-ref-cell-resources.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-string-create.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-string-define-own.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-string-equality.test.ts` | 5 | 5 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-string-number-resources.test.ts` | 9 | 9 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-string-number-source-admission.test.ts` | 3 | 3 | A | AssertionError: expected [] to have a length of 1 but got +0 |
| `issue-3518-native-string-output-resources.test.ts` | 9 | 9 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-string-own-keys.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-string-types-split.test.ts` | 5 | 5 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-string-value-abi-planning.test.ts` | 8 | 8 | A | AssertionError: expected [Function] to throw error matching /changed/ but got 'native string values: demand/plan mis…' |
| `issue-3518-native-string-value-materialization.test.ts` | 4 | 4 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-native-value-resources.test.ts` | 3 | 3 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-object-create-null-source-admission.test.ts` | 1 | 1 | A | AssertionError: expected 'accepted' to be 'unsupported' // Object.is equality |
| `issue-3518-program-abi-seam.test.ts` | 1 | 1 | A | Error: STACK_TRACE_ERROR |
| `issue-3518-program-codec-replay.test.ts` | 1 | 1 | A | AssertionError: expected [ 'acceptPreparedIrProgram', …(9) ] to deeply equal [ 'acceptPreparedIrProgram', …(7) ] |
| `issue-3518-provider-verification-ownership.test.ts` | 1 | 1 | A | AssertionError: expected [ { …(7) }, { …(7) }, { …(7) }, …(17) ] to have a length of 8 but got 20 |
| `issue-3518-reservation-completion-assertion.test.ts` | 4 | 4 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-runtime-producers-import-boundaries.test.ts` | 1 | 1 | A | AssertionError: |
| `issue-3518-runtime-projection-owner.test.ts` | 1 | 1 | A | AssertionError: expected function to throw an error, but it didn't |
| `issue-3518-string-exotic-own-descriptors.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-type-reservation-auth.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-3518-typed-program-preparation.test.ts` | 2 | 2 | A | AssertionError: expected 0 to be greater than 0 |
| `issue-3518-typed-program-source-free.test.ts` | 4 | 4 | A | AssertionError: expected 2 to be 1 // Object.is equality |
| `issue-3518-wat-type-index-preservation.test.ts` | 1 | 1 | E | AssertionError: expected Error: spawnSync wat2wasm ENOENT { …(5) } to be undefined |
| `issue-3520-callable-provider-abi.test.ts` | 1 | 1 | A | AssertionError: expected { …(7) } to match object { …(3) } |
| `issue-3520-class-support-callable-abi.test.ts` | 1 | 1 | B | TypeError: Cannot convert object to primitive value |
| `issue-3520-compiler-support-abi.test.ts` | 1 | 1 | A | AssertionError: expected 1543 to be +0 // Object.is equality |
| `issue-3520-data-struct-host-bridge-abi.test.ts` | 12 | 12 | A | AssertionError: expected [ { …(7) } ] to deeply equal [] |
| `issue-3520-date-host-bridge-export-provenance.test.ts` | 5 | 5 | A | AssertionError: provider-before-entry/host/auto/untracked complete export names: expected [ '$c1', '$c2', '$c3', '$c4', …(59) ] to deeply eq |
| `issue-3520-host-class-callable-abi.test.ts` | 1 | 1 | A | Error: missing callable ABI entry ir-binding:v1:support:ir-class%3Av1%3Air-source%253Av1%253A0000000000000000%253Aentry%253Ahost-class-calla |
| `issue-3520-imported-callable-abi.test.ts` | 1 | 1 | A | AssertionError: expected [] to include 'main' |
| `issue-3520-imported-global-abi.test.ts` | 2 | 2 | R | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-3520-ir-first-identity.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-3520-ir-unit-identity.test.ts` | 5 | 5 | A | AssertionError: expected [ …(7) ] to deeply equal [ …(7) ] |
| `issue-3520-module-init-callable-abi.test.ts` | 2 | 2 | A | AssertionError: wasm-start legitimate source __module_init: expected [ { …(5) } ] to deeply equal [] |
| `issue-3520-overlay-finalize-identity.test.ts` | 2 | 2 | A | TypeError: Cannot read properties of undefined (reading 'nativeRegime') |
| `issue-3520-program-abi-import-callable-planning.test.ts` | 1 | 1 | A | AssertionError: expected function to throw an error, but it didn't |
| `issue-3520-runtime-consumer-wiring.test.ts` | 2 | 2 | A | AssertionError: expected 2 to be +0 // Object.is equality |
| `issue-3520-source-callable-abi.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-3520-struct-field-accessor-abi.test.ts` | 2 | 2 | A | AssertionError: expected Set{ '__sget_length', …(9) } to deeply equal Set{ '__sget_visible', …(6) } |
| `issue-3520-support-callable-abi.test.ts` | 1 | 1 | A | AssertionError: expected [ 'fortyOne' ] to include 'main' |
| `issue-3520-vec-support-callable-abi.test.ts` | 2 | 2 | A | AssertionError: expected 30 to be greater than 30 |
| `issue-3520-vec-writeback-abi.test.ts` | 1 | 1 | A | AssertionError: a compiler-support callable is still on the positional fallback: expected [ '__str_copy_tree', …(386) ] to deeply equal [] |
| `issue-3521-linked-string-parser-abi.test.ts` | 2 | 2 | A | AssertionError: expected [] to deeply equal ArrayContaining{…} |
| `issue-3521-prepared-free-function-routing.test.ts` | 1 | 1 | A | AssertionError: expected { …(18) } to match object { kind: 'unsupported', …(2) } |
| `issue-3521-r2-withdrawal-multi-source.test.ts` | 1 | 1 | A | AssertionError: expected 0 to be greater than 0 |
| `issue-3521-r2-withdrawal-shapes.test.ts` | 5 | 5 | A | AssertionError: expected { prepareAttempts: 1, …(4) } to deeply equal { prepareAttempts: 1, …(4) } |
| `issue-3521-whole-program-projections.test.ts` | 2 | 2 | A | AssertionError: expected [ { id: +0, blockArgs: [], …(3) } ] not to be [ { id: +0, blockArgs: [], …(3) } ] // Object.is equality |
| `issue-3522-ir-builtins-retirement.test.ts` | 2 | 2 | A | AssertionError: expected [ '__str_from_mem', …(2) ] to deeply equal ArrayContaining{…} |
| `issue-3522-ir-class-compile-once.test.ts` | 3 | 3 | A | AssertionError: expected '(func $Animal_init (param (ref null 6…' to match /^\(func \$Animal_init \(param externr…/ |
| `issue-3522-ir-closure-destructuring-ownership.test.ts` | 2 | 2 | A | AssertionError: expected [ 'env::__unwrap_for_wasm' ] to deeply equal [] |
| `issue-3522-ir-closure-literal-ownership.test.ts` | 2 | 2 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to contain '__is_data_struct' |
| `issue-3522-ir-cross-owner-free-function.test.ts` | 6 | 6 | A | AssertionError: expected {} to be 'hello world' // Object.is equality |
| `issue-3522-ir-nested-class-expression-ownership.test.ts` | 3 | 3 | A | AssertionError: expected { …(14) } to match object { kind: 'emitted', …(2) } |
| `issue-3522-ir-nested-class-ownership.test.ts` | 4 | 4 | A | AssertionError: expected [ { …(19) }, { …(19) }, …(3) ] to have a length of 4 but got 5 |
| `issue-3522-ir-object-method-call-ownership.test.ts` | 11 | 11 | A | AssertionError: expected [ 'env::__str_extern_len', …(2) ] to deeply equal [ 'env::__box_boolean', …(2) ] |
| `issue-3522-ir-object-method-ownership.test.ts` | 1 | 1 | A | AssertionError: expected [ 'env::__str_extern_len', …(2) ] to deeply equal [ 'env::__box_number' ] |
| `issue-3522-ir-recursive-closure-ownership.test.ts` | 4 | 4 | A | AssertionError: Internal error compiling function 'run': injected direct function-body poison: run: expected false to be true // Object.is e |
| `issue-3522-nested-class-static.test.ts` | 5 | 5 | C | AssertionError: Codegen error: IR path failed for run: prepared ABI binding ir-binding:v1:class:ir-class%3Av1%3Air-source%253Av1%253A0000000 |
| `issue-3522-private-method-admission.test.ts` | 4 | 4 | A | AssertionError: expected 'emitted' to be 'class-member-unsupported' // Object.is equality |
| `issue-3522-private-method-call-sites.test.ts` | 2 | 2 | A | AssertionError: expected 'emitted' to be 'class-member-unsupported' // Object.is equality |
| `issue-3522-super-accessor.test.ts` | 4 | 4 | A | AssertionError: IR path failed for Animal_new: prepared component prepared-component:ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3A |
| `issue-3523-ir-algorithms-retirement.test.ts` | 5 | 5 | A | AssertionError: concat call count: expected [] to have a length of 1 but got +0 |
| `issue-3523-ir-calendar-retirement.test.ts` | 14 | 14 | A | AssertionError: Internal error compiling function 'el': injected direct function-body poison: el |
| `issue-3523-ir-module-init-compile-once.test.ts` | 1 | 1 | A | AssertionError: expected { …(9) } to match object { executable: true, …(1) } |
| `issue-3523-module-init-discovery-static.test.ts` | 5 | 5 | A | AssertionError: h1-harness-print: $\$DONE must exist and dispatch typed: expected '\n  (func $$DONE (type 16)\n    unrea…' to contain 'call_ |
| `issue-3523-module-init-single-pass.test.ts` | 2 | 2 | A | AssertionError: expected { pass1: +0, pass2: +0 } to deeply equal { pass1: 1, pass2: +0 } |
| `issue-3523-r4m1-string-module-storage.test.ts` | 1 | 1 | A | AssertionError: expected '(global $__mod_greeting (mut (ref nul…' to contain '(mut externref)' |
| `issue-3525-emitted-physical-plan-observation.test.ts` | 6 | 6 | A | AssertionError: expected [Function] to throw an error |
| `issue-3525-prepared-mixed-presentation.test.ts` | 4 | 4 | A | AssertionError: { |
| `issue-3525-prepared-pipeline-boolean-presentation.test.ts` | 10 | 10 | A | AssertionError: expected [Function] to throw error matching /^physical module reservations:/ but got 'prepared validator (physical module):… |
| `issue-3525-prepared-zero-suspension-rejection.test.ts` | 6 | 6 | A | AssertionError: { |
| `issue-3525-source-map-builder-scopes.test.ts` | 5 | 5 | A | Error: unsupported: ir/from-ast: closure arg 0 type mismatch (expected f64, got dynamic) in build |
| `issue-3526-boolean-boundary-intrinsic.test.ts` | 2 | 2 | A | AssertionError: expected 'unsupported' to be 'emitted' // Object.is equality |
| `issue-3526-boundary-residuals.test.ts` | 4 | 4 | A | AssertionError: expected 'unsupported' to be 'emitted' // Object.is equality |
| `issue-3526-callable-boundary-schema.test.ts` | 2 | 2 | A | AssertionError: expected [ 'env.__str_from_mem', …(2) ] to include 'env.__call_function' |
| `issue-3526-f3s3-function-prototype-call-policy.test.ts` | 4 | 4 | A | AssertionError: expected 'emitted' to be 'call-resolution-unsupported' // Object.is equality |
| `issue-3526-number-boundary-intrinsics.test.ts` | 3 | 3 | A | AssertionError: expected [ '__boundary_object_get', …(18) ] to deeply equal [ 'Map_new', 'Map_get', …(4) ] |
| `issue-3526-string-boundary-charcodeat.test.ts` | 4 | 4 | A | TypeError: type incompatibility when transforming from/to JS |
| `issue-3526-string-boundary-compare.test.ts` | 2 | 2 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-3526-string-boundary-concat.test.ts` | 3 | 3 | A | TypeError: type incompatibility when transforming from/to JS |
| `issue-3526-string-boundary-eq.test.ts` | 3 | 3 | A | TypeError: type incompatibility when transforming from/to JS |
| `issue-3526-string-boundary-len.test.ts` | 3 | 3 | A | TypeError: type incompatibility when transforming from/to JS |
| `issue-3526-string-boundary-schema.test.ts` | 3 | 3 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3527-async-call-closure.test.ts` | 30 | 30 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3527-emitted-support-receipts.test.ts` | 2 | 2 | A | AssertionError: expected [Function] to throw an error |
| `issue-3527-linear-suspension-runtime.test.ts` | 6 | 6 | A | AssertionError: Internal error compiling function 'genericChain': direct async body poison reached genericChain |
| `issue-3527-owned-function-finalization.test.ts` | 1 | 1 | A | Error: output-failed: {"kind":"output-failed","errors":[{"message":"The host-semantic implementation was removed (#6979); this module would |
| `issue-3527-prepared-async-any-carrier.test.ts` | 8 | 8 | A | PreparedValidatorError: prepared validator (prepared program): body ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Aentry.ts:root:top |
| `issue-3527-prepared-promise-parameter.test.ts` | 1 | 1 | A | PreparedValidatorError: prepared validator (prepared program): body ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Aentry.ts:root:top |
| `issue-3527-settled-owner-runtime.test.ts` | 12 | 12 | A | AssertionError: expected { …(20) } to match object { kind: 'emitted', …(4) } |
| `issue-3527-snapshot-intrinsic-observations.test.ts` | 5 | 5 | A | AssertionError: expected 'accepted' to be 'physical module reservations: join re…' // Object.is equality |
| `issue-3528-frozen-body-handoff.test.ts` | 7 | 7 | A | AssertionError: expected '506ab1e06f98ef15' to be 'a17726aa05228257' // Object.is equality |
| `issue-3529-dataflow-outcomes.test.ts` | 5 | 5 | A | AssertionError: expected { …(20) } to match object { kind: 'unsupported', …(4) } |
| `issue-3529-equivalence-error-imports.test.ts` | 9 | 9 | A | AssertionError: expected [ { module: 'env', …(4) }, …(17) ] to deep equally contain { module: 'env', …(4) } |
| `issue-3529-integration-preflight.test.ts` | 3 | 3 | A | AssertionError: expected [ { func: '<module-init>', …(3) } ] to deeply equal [ ObjectContaining{…} ] |
| `issue-3537.test.ts` | 1 | 1 | A | AssertionError: expected 2 to be 1 // Object.is equality |
| `issue-3540-function-tostring-source-facade.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3548.test.ts` | 1 | 1 | C | AssertionError: Codegen error: IR path failed for d: ir/monomorphize: clone d$dyn:5 has 0 return values; V1 requires 1 [IR-FALLBACK] |
| `issue-355.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 'zam' // Object.is equality |
| `issue-3557-not-operator-bool-brand.test.ts` | 4 | 4 | B | AssertionError: expected {} to be '{"async":false,"generator":true}' // Object.is equality |
| `issue-3576.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'p:1,2,3/3;q:9/1;r:/0' // Object.is equality |
| `issue-3583.test.ts` | 1 | 1 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-3587-async-rejection-delivery.test.ts` | 21 | 21 | B | AssertionError: expected {} to be 205 // Object.is equality |
| `issue-3603-vec-mirror-writeback.test.ts` | 10 | 10 | B | AssertionError: expected {} to be 'a;b' // Object.is equality |
| `issue-3610-standalone-prototype-receiver-brand.test.ts` | 1 | 1 | A | AssertionError: expected 2 to be 1 // Object.is equality |
| `issue-3614.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-362.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 'number' // Object.is equality |
| `issue-3632-eval-early-errors.test.ts` | 3 | 3 | V | TypeError: WebAssembly.instantiate(): Import #21 "js2wasm:runtime-eval": module is not an object or function |
| `issue-3633-eval-annexb-bindings.test.ts` | 4 | 4 | V | TypeError: WebAssembly.instantiate(): Import #24 "js2wasm:runtime-eval": module is not an object or function |
| `issue-3637-vec-len-discriminator-vacuity.test.ts` | 1 | 1 | A | AssertionError: expected {} to deeply equal { a: 1 } |
| `issue-3638-reflective-instance-method-call.test.ts` | 6 | 6 | A | Error: promise resolved "1" instead of rejecting |
| `issue-3643-array-dstr-getiterator.test.ts` | 6 | 6 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3643-param-default.test.ts` | 1 | 1 | A | AssertionError: expected 'anull' to be 'az' // Object.is equality |
| `issue-3647.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3654.test.ts` | 1 | 1 | A |  |
| `issue-3655.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3656.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'This feature has been abandoned.' // Object.is equality |
| `issue-3657.test.ts` | 2 | 2 | B | TypeError: type incompatibility when transforming from/to JS |
| `issue-3663-object-define-property-ir.test.ts` | 2 | 2 | A | AssertionError: expected [] to include 'run' |
| `issue-3666.test.ts` | 1 | 1 | A | AssertionError: Test262Error: Expected SameValue(«null», «[object Object]») to be true \\| at L25: assert.sameValue(counter, 0);: expected 'f |
| `issue-3669.test.ts` | 3 | 3 | A | AssertionError: arm C.str>null: expected 'BROKEN' to be 'ok' // Object.is equality |
| `issue-367.test.ts` | 6 | 6 | B | AssertionError: expected {} to be 'hello world' // Object.is equality |
| `issue-3676-symbol-host-i32-rep.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__symbol_for_id' |
| `issue-368.test.ts` | 5 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `issue-3683-arity-padding.test.ts` | 2 | 2 | A | AssertionError: expected 152249 to be less than 150915 |
| `issue-3683-direct-calls.test.ts` | 2 | 2 | A | AssertionError: expected '(func $__dc_P_add_1_g (type 91)\n    …' to match /global\.get (\d+)\s+ref\.is_null\s+i3…/ |
| `issue-3683-numeric-fields.test.ts` | 2 | 2 | A | AssertionError: expected 31 to be 11 // Object.is equality |
| `issue-3683-typed-this-twin.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to match /__typed_this/ |
| `issue-3685-decline-stats.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3685-presence-tracked-proven-reads.test.ts` | 1 | 1 | A | AssertionError: expected 3 to be greater than or equal to 4 |
| `issue-375.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'hello world' // Object.is equality |
| `issue-3764-reference-array-oob-undefined.test.ts` | 1 | 1 | A | AssertionError: expected { env: {}, …(7) } to deeply equal {} |
| `issue-3766-string-indexof-receiver-coercion.test.ts` | 1 | 1 | C | AssertionError: SyntaxError: Cannot convert string to a BigInt in standalone mode \\| at L20: throw new Test262Error("unreachable");: expecte |
| `issue-3776-es5-isfrozen-intrinsics.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-3780-fast-leaf-host-imports.test.ts` | 2 | 2 | A | Error: Unhandled ImportIntent type: typeof_check |
| `issue-3786-reduction-unroll.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3787-ir-string-fromcharcode.test.ts` | 2 | 2 | B | AssertionError: expected {} to be '' // Object.is equality |
| `issue-3789-ir-dynamic-param-slots.test.ts` | 1 | 1 | A | AssertionError: expected NaN to be 7 // Object.is equality |
| `issue-379.test.ts` | 5 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `issue-3790-ir-dynamic-string-loop.test.ts` | 1 | 1 | A | AssertionError: [ |
| `issue-3793-ir-acorn-retained-parser-wrappers.test.ts` | 1 | 1 | A | AssertionError: [ |
| `issue-3794-ir-dynamic-replace.test.ts` | 3 | 3 | A | AssertionError: [ |
| `issue-3795-ir-dynamic-member-set.test.ts` | 2 | 2 | A |  |
| `issue-385.test.ts` | 14 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `issue-3899.test.ts` | 1 | 1 | A | did not finish within the serial re-run timeout |
| `issue-3903.test.ts` | 8 | 8 | B | AssertionError: expected {} to be 'spaced' // Object.is equality |
| `issue-3904.test.ts` | 2 | 2 | C | Error: promise rejected "RuntimeError: dereferencing a null pointer" instead of resolving |
| `issue-3909-3910-index-and-argcoerce.test.ts` | 2 | 2 | A | AssertionError: expected __str_trimStart to call its helpers: expected 0 to be greater than 0 |
| `issue-3912-fast-number-stringify.test.ts` | 2 | 2 | A | AssertionError: expected 8 to be 2 // Object.is equality |
| `issue-3920-standalone-closed-struct-reflection.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-3927-fnctor-cold-tail.test.ts` | 1 | 1 | A | AssertionError: expected '941d836ede33dbe6505cbdacc0d4ac192866c…' to be 'd8d529788dc39387f27a03e5eb065ffd1a4b2…' // Object.is equality |
| `issue-3927-fnctor-layout-emit.test.ts` | 1 | 1 | A | AssertionError: expected '417f97e183a58101b847c9e38fdd989e4c350…' to be 'cb5c98ed63c139a57049d0214ae130016003d…' // Object.is equality |
| `issue-3931.test.ts` | 12 | 12 | R | TypeError: toNative is not a function |
| `issue-3952.test.ts` | 2 | 2 | A | AssertionError: compile failed: [{"message":"generator-no-host-free-lowering: this generator has no host-free lowering yet (#7010). Neither |
| `issue-3961-symbol-valued-struct-field.test.ts` | 3 | 3 | A | AssertionError: expected undefined to be Symbol(react.transitional.element) // Object.is equality |
| `issue-3962-native-user-instanceof.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-3975.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_get', …(19) ] to include 'structuredClone' |
| `issue-3981-standalone-construct-function-value.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 11 // Object.is equality |
| `issue-3982.test.ts` | 8 | 8 | A |  |
| `issue-3992-transferred-native-proto-receiver.test.ts` | 1 | 1 | A | AssertionError: expected 5 to be 3 // Object.is equality |
| `issue-3995-hono-class-boundary.test.ts` | 15 | 15 | B | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__async_resume_fanon_' |
| `issue-3995-hono-js-default-object-param.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'application/vnd.apple.mpegurl' // Object.is equality |
| `issue-3996-redux-runtime.test.ts` | 2 | 2 | C | AssertionError: Codegen error: callable preflight found a non-exact graph edge ir-unit:v1:ir-source%3Av1%3A0000000000000002%3Aentry%3Aentry. |
| `issue-4016-standalone-search-value-tostring.test.ts` | 2 | 2 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-4025-apply-call-this-binding.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4034-standalone-prelude-size.test.ts` | 2 | 2 | A | AssertionError: export function run(n){return n;}: expected true to be false // Object.is equality |
| `issue-4062.test.ts` | 2 | 2 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-4102-ir-promise-delay-closure-compile-once.test.ts` | 3 | 3 | E | AssertionError: expected {} to be 99 // Object.is equality |
| `issue-4102-program-abi-closure-support.test.ts` | 1 | 1 | A | AssertionError: expected { kind: 'ref', typeIdx: 6 } to deeply equal { kind: 'externref' } |
| `issue-4104-ir-async-plan-runtime-consumer.test.ts` | 1 | 1 | A | AssertionError: expected [Function] to throw an error |
| `issue-4106-ir-async-fetch-user.test.ts` | 7 | 7 | E | AssertionError: expected [ 'setTimeout', 'delay' ] to include 'linearVoid' |
| `issue-4110-ir-fetch-all-parallel.test.ts` | 7 | 7 | E | AssertionError: Codegen error: IR path failed for setTimeout: IR async function fetchUser selected a native standalone runtime on the wrong |
| `issue-4113-ir-final-allocation-provenance.test.ts` | 3 | 3 | A | AssertionError: expected [ { …(19) }, { …(14) } ] to deeply equal [ ObjectContaining{…} ] |
| `issue-4121-interprocedural-proofs.test.ts` | 2 | 2 | A | AssertionError: expected '' to be 'externref' // Object.is equality |
| `issue-4121-numeric-return-carriers.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-4121-unboxing-admission.test.ts` | 1 | 1 | A | AssertionError: expected '' to be 'externref' // Object.is equality |
| `issue-4122-mixed-carrier-numeric.test.ts` | 6 | 6 | A | AssertionError: expected '(local $p (ref null 17))\n(local $s e…' not to match /call \$__unbox_number/ |
| `issue-4124-ir-final-async.test.ts` | 11 | 11 | A | AssertionError: [ |
| `issue-4130-npm-compat-promotion-fast-path.test.ts` | 1 | 1 | A | AssertionError:       - name: Preserve compiler boundary evidence (#3518): expected '      - name: Preserve compiler bound…' to contain 'ste |
| `issue-4150-fmod-integral-fast-path.test.ts` | 1 | 1 | A | AssertionError: expected '(func $guarded (type 42)\n    (local …' to match /\bcall\b/ |
| `issue-4154-private-brand-check-typeerror.test.ts` | 2 | 2 | A | AssertionError: unbranded class object must throw a catchable TypeError: expected +0 to be 1 // Object.is equality |
| `issue-4155-fnctor-field-provenance.test.ts` | 1 | 1 | A | AssertionError: expected 'ref' to be 'externref' // Object.is equality |
| `issue-4157-box-boolean-fuse.test.ts` | 3 | 3 | A | AssertionError: expected 0 to be greater than 0 |
| `issue-4157-ir-inline.test.ts` | 2 | 2 | A | AssertionError: expected '85d5c1b2b00009393060bb87799683f2394ab…' not to be '85d5c1b2b00009393060bb87799683f2394ab…' // Object.is equality |
| `issue-4157-member-get-inline-ic.test.ts` | 3 | 3 | A | AssertionError: JS2WASM_INLINE_PROP_IC=0: expected 776916489 to be 701843181 // Object.is equality |
| `issue-4167-async-rejection-identity.test.ts` | 6 | 6 | A | TypeError: You must provide a Promise to expect() when using .rejects, not 'object'. |
| `issue-4167-test262.test.ts` | 1 | 1 | A | AssertionError: async completion marker not observed: expected 'fail' to be 'pass' // Object.is equality |
| `issue-4177-lattice-plus-provability.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'hi!' // Object.is equality |
| `issue-4194-closed-struct-computed-write.test.ts` | 1 | 1 | A | AssertionError: computedWriteCtorField: standalone diverged from native: expected 1 to be 11 // Object.is equality |
| `issue-4206-with-closure-ir.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 7 // Object.is equality |
| `issue-4208-wrapper-loose-equality-ir.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_get', …(17) ] to deeply equal ArrayContaining{…} |
| `issue-4218-lib-scan-parity.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-4241-carrier-bag-slot.test.ts` | 1 | 1 | E | AssertionError: Codegen error: IR path failed for setTimeout: IR async function test selected a native standalone runtime on the wrong targe |
| `issue-4259-class-accessor-outer-writeback-ir.test.ts` | 4 | 4 | A | AssertionError: Internal error compiling nested class 'DeclInstance': injected direct class-body poison: DeclInstance_get_di: expected false |
| `issue-4260-prepared-provider-transaction.test.ts` | 3 | 3 | A | Error: Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed (last accepted by js2wasm 0.71.0 |
| `issue-4262-error-substrate.test.ts` | 3 | 3 | A | TypeError: type incompatibility when transforming from/to JS |
| `issue-4276-instanceof-object-family.test.ts` | 2 | 2 | A | AssertionError: the gc/JS-host lane must not take the standalone branch: expected [ 'env::__boundary_object_get', …(18) ] to include 'env::_ |
| `issue-4295-runtime-user-class-method-dispatch.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 322 // Object.is equality |
| `issue-4297-conditional-closure-parameter-boxing.test.ts` | 4 | 4 | A | AssertionError: expected NaN to be 3 // Object.is equality |
| `issue-4302-prettier-invalid-binary.test.ts` | 3 | 3 | B | AssertionError: generator-no-host-free-lowering: this async generator has no host-free lowering yet (#7010). Neither the native generator st |
| `issue-4362-test262-paths-compact.test.ts` | 5 | 5 | A | TypeError: Cannot read properties of undefined (reading 'dispatchEvent') |
| `issue-4367-jest-parenthesized-accessor-import.test.ts` | 1 | 1 | A | AssertionError: expected [ { module: 'env', …(4) }, …(18) ] to deep equally contain ObjectContaining{…} |
| `issue-4371-dynamic-class-static-method-bridge.test.ts` | 1 | 1 | A | TypeError: called value is not a function |
| `issue-4373-js-property-call-arguments.test.ts` | 4 | 4 | A | AssertionError: expected null to be 757 // Object.is equality |
| `issue-4376-callback-new-target.test.ts` | 3 | 3 | A | AssertionError: expected '(func $__apply_closure (type 74)\n   …' to match /\(try\b/ |
| `issue-4376-core-error-constructor.test.ts` | 7 | 7 | A | AssertionError: expected -4 to be 42 // Object.is equality |
| `issue-4377-multifile-exported-object-shorthand-callable.test.ts` | 5 | 5 | A | AssertionError: Host import leak (warning, #2961): host import "v8x:deno.op_len" survives into the finished --target standalone binary and w |
| `issue-4383-bigint-host-width.test.ts` | 10 | 10 | A | AssertionError: expected 123n to be 170141183460469231731687303715884105851n // Object.is equality |
| `issue-4383-cross-module-scalar-callable.test.ts` | 3 | 3 | A | AssertionError: expected [Function] to throw an error |
| `issue-4383-uuid-typed-array-identity.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4384-merge-group-regressions.test.ts` | 3 | 3 | A | AssertionError: generator-no-host-free-lowering: this async generator has no host-free lowering yet (#7010). Neither the native generator st |
| `issue-4384-moment-js-runtime-body.test.ts` | 3 | 3 | A | AssertionError: Function 'test' has implicit 'any' return type. Add a JSDoc annotation: /** @returns {number} */ |
| `issue-4394-ambient-error-ctor-value-read.test.ts` | 1 | 1 | A | AssertionError: expected [ 'same: false' ] to include 'same: true' |
| `issue-4394-test262-error-ctor-identity.test.ts` | 1 | 1 | A | AssertionError: expected [ 'name: undefined', …(2) ] to include 'name: Test262Error' |
| `issue-4394-test262-error-instanceof.test.ts` | 1 | 1 | A | AssertionError: expected [ 'isError: false', 'message: boom' ] to include 'isError: true' |
| `issue-4396-target-profile.test.ts` | 1 | 1 | A | AssertionError: expected { backend: 'wasmgc', …(4) } to deeply equal { backend: 'wasmgc', …(3) } |
| `issue-4398-capability-registry.test.ts` | 2 | 2 | A | AssertionError: expected { __date_now: 1 } to match object { __date_now: 1, Math_random: 1 } |
| `issue-4406-ret-unbox-default-on.test.ts` | 1 | 1 | A | AssertionError: expected 6 to be +0 // Object.is equality |
| `issue-4406-runtime-eval-host-leak.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-4412-generator-prototype-realm-isolation.test.ts` | 1 | 1 | A | TypeError: Cannot convert undefined or null to object |
| `issue-4420-emitted-binary-validation.test.ts` | 1 | 1 | A | AssertionError: expected 'WebAssembly.compile(): BufferSource a…' to be '' // Object.is equality |
| `issue-4434-vec-index-domain-sparse-tail.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4438-runtime-eval-construct.test.ts` | 1 | 1 | A | AssertionError: expected '(func $__construct_runtime_eval (type…' to be undefined |
| `issue-4440.test.ts` | 2 | 2 | A |  |
| `issue-4442.test.ts` | 1 | 1 | A | Error: promise resolved "42" instead of rejecting |
| `issue-4446-concat-dyn-standalone.test.ts` | 2 | 2 | A | AssertionError: expected [ '__boundary_object_get', …(20) ] to include '__array_concat_any' |
| `issue-4447-mg-regressions.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: TypeError: Cannot read properti…' to be 'pass: ' // Object.is equality |
| `issue-4451-cb-tuple-struct-f64.test.ts` | 1 | 1 | C | RuntimeError: illegal cast |
| `issue-4456.test.ts` | 10 | 10 | V |  |
| `issue-4457.test.ts` | 4 | 4 | A | AssertionError: expected undefined to be 6 // Object.is equality |
| `issue-4460.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4462.test.ts` | 2 | 2 | A | AssertionError: expected [ 'env.__str_from_mem', …(2) ] to include 'env.number_toString' |
| `issue-4470.test.ts` | 2 | 2 | A | AssertionError: expected 103 to be 3 // Object.is equality |
| `issue-4483.test.ts` | 3 | 3 | A |  |
| `issue-4484.test.ts` | 1 | 1 | A | AssertionError: expected 2 to be 1 // Object.is equality |
| `issue-4485.test.ts` | 2 | 2 | A | AssertionError: expected 'pass' not to be 'pass' // Object.is equality |
| `issue-4486.test.ts` | 8 | 8 | A | AssertionError: expected { …(20) } to match object { Object (kind, irBodyEmitted) } |
| `issue-4487.test.ts` | 15 | 15 | A | AssertionError: expected 'vardecl-shadow:Identifier «a»' to be 'vardecl-shadow:Identifier' // Object.is equality |
| `issue-4490-int8array-carrier.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4491-function-binding-widening.test.ts` | 2 | 2 | A |  |
| `issue-4493-object-entries-struct-cast.test.ts` | 5 | 5 | A | RuntimeError: illegal cast |
| `issue-4504-inherited-set.test.ts` | 14 | 14 | A | AssertionError: expected [ { …(3) } ] to have a length of 2 but got 1 |
| `issue-4516-es5-residuals.test.ts` | 1 | 1 | A | AssertionError: built-ins/eval/name.js: Test262Error: name descriptor value should be eval; name value should be eval: expected 'fail' to be |
| `issue-4517.test.ts` | 3 | 3 | R | TypeError: toNative is not a function |
| `issue-4520-abi-carrier-differential.test.ts` | 9 | 9 | A | AssertionError: IrType union not found in src/ir/nodes.ts: expected null to be truthy |
| `issue-4523-type-rule-coverage.test.ts` | 3 | 3 | A | AssertionError: expected [ Array(95) ] to deeply equal [ Array(79) ] |
| `issue-4526-redux-wave10.test.ts` | 5 | 5 | A | AssertionError: expected [ {}, {}, {} ] to deeply equal [ …(3) ] |
| `issue-4527-call-dyn-bridge.test.ts` | 8 | 8 | A | AssertionError: expected +0 to be 13120 // Object.is equality |
| `issue-4527.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__class_call_concat_vararg' |
| `issue-4529-typeof-narrowed-unknown.test.ts` | 1 | 1 | A | AssertionError: expected 'false,false,false,false,false,false' to be 'true,true,true,true,true,false' // Object.is equality |
| `issue-4530-import-alias-calls.test.ts` | 2 | 2 | C | RuntimeError: illegal cast |
| `issue-4536-jsdoc-optional-number.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-4542-pinned-shim-ownership.test.ts` | 1 | 1 | A | AssertionError: expected [ { …(2) }, { …(2) }, { …(2) }, …(6) ] to deeply equal [] |
| `issue-4564-carrier-addition.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4565-wasi-dynamic-writesync-linear-memory.test.ts` | 1 | 1 | A | AssertionError: expected [ { …(3) }, { …(3) }, { …(3) } ] to deep equally contain { module: 'env', …(2) } |
| `issue-4566-standalone-algorithms-module-init.test.ts` | 1 | 1 | A | AssertionError: expected [] to deeply equal [ '<module-init>', 'read' ] |
| `issue-4576-standalone-dom-builtins.test.ts` | 12 | 12 | A | AssertionError: missing production: exact Builtins terminal universe must be tracked: expected [ 'function:crd', 'function:el', …(3) ] to de |
| `issue-4577-dom-interaction-bridge.test.ts` | 1 | 1 | A | AssertionError: expected [ { …(19) }, { …(19) }, …(24) ] to have a length of 38 but got 26 |
| `issue-4577-standalone-clock-capability.test.ts` | 1 | 1 | A | AssertionError: expected [ { …(7) } ] to deeply equal [] |
| `issue-4584-standalone-prepared-class-cutover.test.ts` | 1 | 1 | A | AssertionError: expected [] to deeply equal [ 'Animal', 'Dog' ] |
| `issue-4585-npm-compat-refresh-resilience.test.ts` | 1 | 1 | A | AssertionError: syntactic: expected [] to have a length of 1 but got +0 |
| `issue-4588-standalone-timer-shim-cutover.test.ts` | 4 | 4 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-4589-multi-prepared-scalar-leaf.test.ts` | 2 | 2 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-4590-bench-loop-prepared-cutover.test.ts` | 3 | 3 | A | Error: raw diagnostics must equal the exact ordered #2961 authority: Prepared=[], direct=[] |
| `issue-4591-fib-pair-prepared-cutover.test.ts` | 2 | 2 | A | AssertionError: expected { space: 'function', index: 66 } to deeply equal { space: 'function', index: 76 } |
| `issue-4603-checkinstr-roadmap-rules.test.ts` | 1 | 1 | A | AssertionError: expected [ Array(1) ] to deeply equal [] |
| `issue-4612-fnctor-instance-return-parity.test.ts` | 1 | 1 | A | AssertionError: [ |
| `issue-4614-namespace-import-call.test.ts` | 3 | 3 | C | AssertionError: Compile failed: |
| `issue-4616-date-carrier-toprimitive.test.ts` | 1 | 1 | A | AssertionError: expected 'false' to be 'true' // Object.is equality |
| `issue-4616-evolving-array-hoist-type.test.ts` | 1 | 1 | A | AssertionError: expected 'false' to be 'true' // Object.is equality |
| `issue-4616-fnctor-getprototypeof.test.ts` | 1 | 1 | A | AssertionError: expected 'true,true' to be 'false,true' // Object.is equality |
| `issue-4616-node-builtin-named-value-import.test.ts` | 2 | 2 | A | TypeError: Error.isError is not yet implemented in --target standalone |
| `issue-4616-process-and-class-expr-name.test.ts` | 1 | 1 | A | ReferenceError: process is not defined |
| `issue-4616-rest-dispatch-inline-new.test.ts` | 2 | 2 | A | AssertionError: expected 'len=0 isArr=false' to be 'len=2 isArr=true' // Object.is equality |
| `issue-4616-shorter-arity-callback.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'n=2' // Object.is equality |
| `issue-4617-metadata-preparation.test.ts` | 2 | 2 | A | AssertionError: expected undefined to be +0 // Object.is equality |
| `issue-4618-async-boxed-capture-frame.test.ts` | 4 | 4 | A | TypeError: Cannot read properties of undefined (reading 'lib') |
| `issue-4618-boxed-destructure-store.test.ts` | 1 | 1 | C | RuntimeError: illegal cast |
| `issue-4618-class-capture-owner-isolation.test.ts` | 3 | 3 | A | TypeError: called value is not a function |
| `issue-4618-class-expression-assignment-bridge.test.ts` | 12 | 12 | A | TypeError: called value is not a function |
| `issue-4618-cps-liveness-nested-scope.test.ts` | 1 | 1 | A | Error: STACK_TRACE_ERROR |
| `issue-4618-host-class-ctor-bridge.test.ts` | 3 | 3 | A | TypeError: called value is not a function |
| `issue-4618-method-capture-promotion.test.ts` | 2 | 2 | A | AssertionError: expected 'ERR:TypeError: called value is not a …' to be 'SET:function' // Object.is equality |
| `issue-4618-proxy-freeze-invariants.test.ts` | 1 | 1 | A | AssertionError: expected [] to deeply equal [ 'key', 'props', 'type' ] |
| `issue-4618-scoped-same-name-classes.test.ts` | 7 | 7 | A | TypeError: called value is not a function |
| `issue-4618-spy-bridge-protocol.test.ts` | 1 | 1 | A | TypeError: log is not a function |
| `issue-4623.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4628-class-value-prototype.test.ts` | 6 | 6 | B | AssertionError: expected {} to be 'object' // Object.is equality |
| `issue-4628-temporal-global.test.ts` | 5 | 5 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-4645-dispatch-chain-size.test.ts` | 1 | 1 | A | AssertionError: expected 131563 to be less than 30000 |
| `issue-4647.test.ts` | 5 | 5 | A | AssertionError: refusal tier: the dynamic-body mint must reach the provider and throw: expected false to be true // Object.is equality |
| `issue-4660-driven-async-shadowed-ctor.test.ts` | 3 | 3 | A | AssertionError: expected [] to include 'same: true' |
| `issue-4668.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4682.test.ts` | 1 | 1 | A | AssertionError: expected [ …(22) ] to include 'env.Promise_all' |
| `issue-4705.test.ts` | 3 | 3 | A | AssertionError: async-func-decl-dstr-array-elem-init-evaluation.js: async completion marker not observed: expected 'fail' to be 'pass' // Ob |
| `issue-4713.test.ts` | 2 | 2 | A | AssertionError: {"file":"test/language/statements/for-of/scope-head-var-none.js","category":"issue-4713","status":"fail","error":"TypeError: |
| `issue-4732.test.ts` | 1 | 1 | A | AssertionError: expected [ '__boundary_object_get', …(17) ] to deeply equal ArrayContaining{…} |
| `issue-4736.test.ts` | 4 | 4 | A | AssertionError: async completion marker not observed: expected 'fail' to be 'pass' // Object.is equality |
| `issue-4737.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4739-function-hasinstance-descriptor.test.ts` | 2 | 2 | A | Error: promise rejected "TypeError: WebAssembly.instantiate(): Imp…" instead of resolving |
| `issue-4754-module-global-proxy-escape.test.ts` | 6 | 6 | A | AssertionError: expected '  (global $__mod_direct (mut externre…' to match /\(mut \(ref null \d+\)\)/ |
| `issue-4755-module-lexical-assignment-tdz.test.ts` | 9 | 9 | A | AssertionError: expected [] to deeply equal [ 'env.__throw_reference_error' ] |
| `issue-4757.test.ts` | 1 | 1 | A |  |
| `issue-4758-destructuring-compile-timeouts.test.ts` | 1 | 1 | A | AssertionError: expected undefined to be true // Object.is equality |
| `issue-4760.test.ts` | 8 | 8 | A | AssertionError: async completion marker not observed: expected 'fail' to be 'pass' // Object.is equality |
| `issue-4762.test.ts` | 2 | 2 | A | AssertionError: expected undefined to be true // Object.is equality |
| `issue-4763.test.ts` | 2 | 2 | A | AssertionError: expected 22252 to be 12252 // Object.is equality |
| `issue-4768-generator-call-boundary.test.ts` | 2 | 2 | A | AssertionError: expected 1 to be 2 // Object.is equality |
| `issue-4771-host-function-hasinstance.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4787-temporal-merge-group-regressions.test.ts` | 1 | 1 | A | AssertionError: expected 'hours:11:TypeError\\|minutes:29:TypeErr…' to be '' // Object.is equality |
| `issue-482.test.ts` | 3 | 3 | C | AssertionError: expected NaN to be 42 // Object.is equality |
| `issue-49-number-format-nonfinite.test.ts` | 6 | 6 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-4922-generator-arguments.test.ts` | 4 | 4 | A | AssertionError: language/arguments-object/async-gen-meth-args-trailing-comma-multiple.js: generator-no-host-free-lowering: this async genera |
| `issue-5093.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 21 // Object.is equality |
| `issue-5095-array-at-no-argument.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'a' // Object.is equality |
| `issue-5102-isnan-toprimitive.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-5104-boolean-prototype-tostringtag.test.ts` | 1 | 1 | A | AssertionError: expected 2 to be 1 // Object.is equality |
| `issue-5106-ir-math-derived-log.test.ts` | 2 | 2 | C | AssertionError: Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 |
| `issue-5110-ir-math-hyperbolic.test.ts` | 3 | 3 | C | AssertionError: Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 |
| `issue-5111-ir-math-cbrt.test.ts` | 1 | 1 | C | AssertionError: Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 |
| `issue-5114-ir-math-expm1.test.ts` | 1 | 1 | C | AssertionError: Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 |
| `issue-5122-es2015-proxy-symbol-targets.test.ts` | 4 | 4 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-5126-ir-math-imul.test.ts` | 1 | 1 | C | AssertionError: Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 |
| `issue-5132-ir-math-inverse-hyperbolic.test.ts` | 3 | 3 | C | AssertionError: Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 |
| `issue-5152-raw-readers.test.ts` | 4 | 4 | A | Error: promise resolved "131071" instead of rejecting |
| `issue-5159-error-options-cause.test.ts` | 23 | 23 | A | AssertionError: expected 'DIFFERENT' to be 'same' // Object.is equality |
| `issue-5160-padsundefined-siblings.test.ts` | 1 | 1 | A | AssertionError: expected 'ddb74219af958507eee80def18b7c6224364e…' to be 'b3ad2bd8e8764b39c4f0f67f855d34bf18dba…' // Object.is equality |
| `issue-5161-native-string-error-message.test.ts` | 6 | 6 | A | AssertionError: expected '' to be 'am' // Object.is equality |
| `issue-5163-mutating-statements.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'zz' // Object.is equality |
| `issue-5164-comma-and-in.test.ts` | 11 | 11 | R | Error: Compile option semanticProviders: "host-assisted" selected the host-assisted semantic profile, which #6979 removed (last accepted by |
| `issue-5165-tail-control-flow.test.ts` | 2 | 2 | A | AssertionError: legacy matches Node: expected 'THREW: TypeError: f(...).next is not …' to be 'THREW: b' // Object.is equality |
| `issue-5166.test.ts` | 5 | 5 | A | AssertionError: expected { …(20) } to match object { Object (kind, irBodyEmitted) } |
| `issue-5169-immutable-global-class-object.test.ts` | 1 | 1 | A | AssertionError: expected 0 to be greater than 0 |
| `issue-5194-es2015-typedarray-r2.test.ts` | 2 | 2 | A | AssertionError: expected 10 to be +0 // Object.is equality |
| `issue-5195-r3-heritage-check.test.ts` | 1 | 1 | C | AssertionError: L0: Codegen error: IR path failed for Base_v: prepared ABI scope prepared-component:ir-unit:v1:ir-source%3Av1%3A000000000000 |
| `issue-5195-r3-review.test.ts` | 1 | 1 | A |  |
| `issue-5196-r3-4-revoker-fn.test.ts` | 1 | 1 | A | AssertionError: expected 10 to be +0 // Object.is equality |
| `issue-5198-regexp-compile-syntax.test.ts` | 2 | 2 | A | AssertionError: expected 3 to be 2 // Object.is equality |
| `issue-5199-generator-prepared-admission.test.ts` | 1 | 1 | A | AssertionError: expected [] to include 'values' |
| `issue-5199-native-generator-prototype.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-5202-init-window-class-dispatch.test.ts` | 1 | 1 | A | AssertionError: expected { atInit: +0, afterInit: +0 } to deeply equal { atInit: 3, afterInit: 3 } |
| `issue-5203-init-window-static-dispatch.test.ts` | 3 | 3 | A |  |
| `issue-5204-host-class-bridge-f64-params.test.ts` | 4 | 4 | A | AssertionError: expected { atInit: +0, afterInit: +0 } to deeply equal { atInit: 6, afterInit: 6 } |
| `issue-5205-fromentries-init-marshal.test.ts` | 6 | 6 | A | AssertionError: expected { atInit: {}, afterInit: {} } to deeply equal { atInit: 'one\\|true\\|null\\|8', …(1) } |
| `issue-5206-intl-global.test.ts` | 7 | 7 | A | AssertionError: Intl has no native implementation on the native semantic regime: compile with --host-accelerator intl (hostAccelerators: ["i |
| `issue-5208-compiled-date-host-bridge.test.ts` | 14 | 14 | B | AssertionError: Intl.DateTimeFormat has no native implementation on the native semantic regime: compile with --host-accelerator intl (hostAc |
| `issue-5211-invoke-method-callable-arg.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 3 // Object.is equality |
| `issue-5221-plaindate-from-null-deref.test.ts` | 17 | 17 | B | AssertionError: expected {} to be 'inner1' // Object.is equality |
| `issue-5222-linked-namespace-members.test.ts` | 2 | 2 | A | AssertionError: expected { typeofF: {}, typeofH: {}, …(9) } to deeply equal { typeofF: 'function', …(10) } |
| `issue-5223-instance-tostring-dispatch.test.ts` | 3 | 3 | A | AssertionError: expected 'function' to be 'undefined' // Object.is equality |
| `issue-5225-consumer-literal-seam.test.ts` | 2 | 2 | A | AssertionError: expected { pReadX: 7, pTypeofX: {}, …(5) } to deeply equal { pReadX: 7, pTypeofX: 'number', …(5) } |
| `issue-5226-provider-error-identity.test.ts` | 4 | 4 | A | AssertionError: expected { fnRange: {}, fnType: {}, …(5) } to deeply equal { …(7) } |
| `issue-5237-cross-module-class-members.test.ts` | 2 | 2 | A | AssertionError: expected { protoMethodType: {}, …(7) } to deeply equal { protoMethodType: 'function', …(7) } |
| `issue-5239-object-create-class-prototype.test.ts` | 2 | 2 | A | AssertionError: expected { dynTypeofMethod: {}, …(9) } to deeply equal { dynTypeofMethod: 'function', …(9) } |
| `issue-5241-parametered-bridge-method-calls.test.ts` | 2 | 2 | A | AssertionError: expected { Object (staticZero, staticAdd, ...) } to deeply equal { staticZero: 'Z1', …(14) } |
| `issue-5242-class-value-construct-bridge.test.ts` | 2 | 2 | A | AssertionError: expected { viaRegistryLabel: {}, …(12) } to deeply equal { …(13) } |
| `issue-5243-bridge-object-arg-null.test.ts` | 1 | 1 | A | AssertionError: expected { Object (s1, s2, ...) } to deeply equal { s1: '3/1', s2: '5/4', …(3) } |
| `issue-5244-dynamic-new-argc-and-setter-guard.test.ts` | 9 | 9 | B | AssertionError: expected {} to be '1,2,0' // Object.is equality |
| `issue-5247-export-throw-boundary.test.ts` | 3 | 3 | A | AssertionError: expected WebAssembly.Exception{} to be 'bare-string' // Object.is equality |
| `issue-5250-sget-numeric-shape-miss.test.ts` | 8 | 8 | B | AssertionError: expected {} to be 'undefined' // Object.is equality |
| `issue-5251-temporal-value-seam.test.ts` | 10 | 10 | B | AssertionError: expected {} to be 'x\\|x' // Object.is equality |
| `issue-5253.test.ts` | 1 | 1 | A | AssertionError: block-local forward lexical read (#5154) must not enter #5253's TDZ exception: expected WebAssembly.Exception{} to be undefi |
| `issue-5254.test.ts` | 1 | 1 | A | AssertionError: built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js: expected undefined to be '"use strict";\n// Host glo |
| `issue-5267-finally-reentry.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-5268-es2015-array-object-r2.test.ts` | 3 | 3 | A | AssertionError: expected [ 'values:1' ] to deeply equal [ 'values:NaN' ] |
| `issue-5269-symbol-description.test.ts` | 1 | 1 | A | AssertionError: expected 3 to be 7 // Object.is equality |
| `issue-5271-es2015-statements-r2.test.ts` | 1 | 1 | A | AssertionError: host lane keeps the folded constant: expected '(module\n  (type $__vec_base (sub (st…' to contain '"kern:"' |
| `issue-5272-runner-standalone-leak.test.ts` | 3 | 3 | A | AssertionError: expected 'pass' to be 'compile_error' // Object.is equality |
| `issue-5308-r3-r4-body-accounting.test.ts` | 1 | 1 | A | AssertionError: expected 'unsupported' to be 'emitted' // Object.is equality |
| `issue-5312-uninitialised-field-reads-undefined.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'undefined' // Object.is equality |
| `issue-5313-with-scan-gating.test.ts` | 1 | 1 | A | AssertionError: expected 244105 to be less than 150774 |
| `issue-5316-r5-attribute-model.test.ts` | 1 | 1 | A | AssertionError: expected 10 to be +0 // Object.is equality |
| `issue-5318-r4-computed-accessor-keys.test.ts` | 4 | 4 | A | AssertionError: expected 8 to be +0 // Object.is equality |
| `issue-5318-r5-objlit-computed-accessor-keys.test.ts` | 5 | 5 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-5321-namespace-host-reexport.test.ts` | 3 | 3 | A | AssertionError: expected 'undefined:threw:throws' to be 'function:quiet:throws' // Object.is equality |
| `issue-5324-lifted-frame-fn-name-scope.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 't' // Object.is equality |
| `issue-5325-getprototypeof-wasmgc-carriers.test.ts` | 2 | 2 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-5328-dynamic-dispatch-extern-result.test.ts` | 1 | 1 | B | AssertionError: expected {} to be NaN |
| `issue-5329-tuple-rest-carrier.test.ts` | 3 | 3 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-5330-bare-builtin-namespace-import.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-5334-rest-param-callable-runtime-bridge.test.ts` | 7 | 7 | B |  |
| `issue-5337-exported-function-identity.test.ts` | 1 | 1 | A | Error: Invalid JavaScript adapter manifest: incoherent target profile semantic provider policy 'host-assisted' |
| `issue-5338-tagged-template-call-site-arity.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'chunks=3 cooked0=3 raw0=4 vals=2 v=X/Y' // Object.is equality |
| `issue-5340-tagged-template-extra-substitutions.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'n=3 vals=4,7 len0=4 len1=7' // Object.is equality |
| `issue-5342-module-global-capability-probe.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'function' // Object.is equality |
| `issue-5342-object-literal-host-builtin-property.test.ts` | 1 | 1 | A |  |
| `issue-5342-own-toprimitive-name-property-call.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'v:x' // Object.is equality |
| `issue-5345-absent-property-i32-narrowing.test.ts` | 7 | 7 | B | AssertionError: expected {} to be 'function' // Object.is equality |
| `issue-5347-getprototypeof-compiled-class-instance.test.ts` | 4 | 4 | A | AssertionError: instance → C.prototype: expected +0 to be 1 // Object.is equality |
| `issue-5349-species-r5.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '(type $__vec_i32_byte (sub final ' |
| `issue-5350-r2-super-property-write.test.ts` | 2 | 2 | A | AssertionError: expected [ { …(4) } ] to deeply equal [] |
| `issue-5351-lib-dom-shadow.test.ts` | 1 | 1 | A | AssertionError: expected [] to deeply equal [ 'env::queueMicrotask' ] |
| `issue-5354-linked-class-instanceof.test.ts` | 2 | 2 | A | AssertionError: expected { instOf: true, …(14) } to deeply equal { instOf: true, …(14) } |
| `issue-5355-intl-datetimeformat-bridge.test.ts` | 8 | 8 | I | AssertionError: Intl.DateTimeFormat has no native implementation on the native semantic regime: compile with --host-accelerator intl (hostAc |
| `issue-5358-runtime-key-class-method-read.test.ts` | 9 | 9 | B | AssertionError: expected {} to be 'preprocess=function,provideLexer=func…' // Object.is equality |
| `issue-5360-undefined-default-param.test.ts` | 6 | 6 | B | AssertionError: expected {} to be 'number:12' // Object.is equality |
| `issue-5361-splice-spread-argument.test.ts` | 2 | 2 | A | AssertionError: expected 3 to be 4 // Object.is equality |
| `issue-5362-compiled-typed-array-host-boundary.test.ts` | 9 | 9 | A | AssertionError: expected undefined to be 'secret' // Object.is equality |
| `issue-5363-thrown-error-seam.test.ts` | 3 | 3 | A | AssertionError: expected { throwsRange: {}, …(4) } to deeply equal { throwsRange: 'PASS', …(4) } |
| `issue-5366-nullish-join-carrier.test.ts` | 3 | 3 | A | AssertionError: expected { optionRouter: {}, …(18) } to deeply equal { optionRouter: 'RegExpRouter', …(18) } |
| `issue-5367-await-promise-all-inline.test.ts` | 1 | 1 | C | AssertionError: Codegen error: JSON.stringify of this value is not yet supported by the native JSON provider (#1599). Pure-Wasm JSON.stringi |
| `issue-5370-typed-array-carrier-host-boundary.test.ts` | 8 | 8 | A | TypeError: Cannot access property on null or undefined at 15:17 |
| `issue-5372-await-in-conditional-operand.test.ts` | 13 | 13 | A | AssertionError: expected '<p>post(undefined)</p>' to be '<p>post(lex(pre(m)))</p>' // Object.is equality |
| `issue-5373-array-subclass-tostring.test.ts` | 2 | 2 | A | AssertionError: expected { pDirect: {}, pDirectArg: {}, …(20) } to deeply equal { pDirect: 'B(3:undefined)', …(21) } |
| `issue-5374-valueof-across-seam.test.ts` | 2 | 2 | A | AssertionError: expected { pNum: {}, pPlus: {}, …(8) } to deeply equal { pNum: 7, pPlus: 7, pTrunc: 7, …(7) } |
| `issue-5375-host-getter-struct-return-cycle.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'range:1' // Object.is equality |
| `issue-5376-accessor-valueof-field-read.test.ts` | 3 | 3 | A | AssertionError: expected { rowA: 3, rowB: 3, rowD: {}, …(13) } to deeply equal { rowA: 3, rowB: 3, …(14) } |
| `issue-5377-class-constructor-identity.test.ts` | 3 | 3 | A | AssertionError: expected { pStructTyped: 1, …(20) } to deeply equal { pStructTyped: 1, …(20) } |
| `issue-5378-zoneddatetime-iso-reads.test.ts` | 2 | 2 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-5379-stale-export-map.test.ts` | 1 | 1 | A | TypeError: project.instance.builtInThisModule is not a function |
| `issue-5380-length-bounded-push-loop.test.ts` | 3 | 3 | A | AssertionError: expected { pPushLengthLoop: {}, …(8) } to deeply equal { …(9) } |
| `issue-5381-intl-options-bag.test.ts` | 21 | 21 | I | AssertionError: expected {} to be 'true' // Object.is equality |
| `issue-5384-standalone-exn-render-exports.test.ts` | 1 | 1 | A | AssertionError: expected [ 'run', '__sget_length', …(21) ] to not include '__exn_render_prepare' |
| `issue-5386.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'x1' // Object.is equality |
| `issue-542-negative-skip.test.ts` | 3 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-6411-host-bridge-concat-spread.test.ts` | 4 | 4 | A | AssertionError: expected 2 to be 4 // Object.is equality |
| `issue-6413-logical-or-assign-global-shift.test.ts` | 1 | 1 | A | AssertionError: no '\\|\\|=' site found — the lowering shape changed, update the matcher: expected 0 to be greater than 0 |
| `issue-6415-host-value-predicate-boolean-return.test.ts` | 2 | 2 | A | TypeError: Cannot access property on null or undefined at 25:17 |
| `issue-6417-axios-residual-mechanisms.test.ts` | 3 | 3 | A | AssertionError: expected 'THROW TypeError: Cannot access proper…' to be 'num:3' // Object.is equality |
| `issue-6421-static-builtin-spread-args.test.ts` | 11 | 11 | B | TypeError: Cannot convert object to primitive value |
| `issue-6422-array-from-host-typed-array-view.test.ts` | 4 | 4 | A | AssertionError: expected +0 to be 32 // Object.is equality |
| `issue-6425-node-lane-textencoder-construct.test.ts` | 3 | 3 | A | AssertionError: expected [ '__str_from_mem', …(17) ] to include 'TextEncoder_new' |
| `issue-6426-linked-object-rest-source.test.ts` | 3 | 3 | A | AssertionError: expected { restObj: {}, restFn: {}, …(10) } to deeply equal { restObj: 'R', …(11) } |
| `issue-6430-absent-field-empty-struct.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'undefined' // Object.is equality |
| `issue-6438-raw-exports-struct-decode.test.ts` | 6 | 6 | A | AssertionError: expected {} to deeply equal { type: 'Program' } |
| `issue-6440-promise-try-polyfill.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-6450-node-builtin-named-call.test.ts` | 6 | 6 | A | AssertionError: The host-semantic implementation was removed (#6979); this module would need retired host imports: env::__js_array_new (env |
| `issue-6460-standalone-static-spread-arity.test.ts` | 1 | 1 | A | AssertionError: expected '123' to be '1,2,3undefinedundefined' // Object.is equality |
| `issue-6464-standalone-object-create-class-instance.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to contain '__standalone_object_create_class_inst…' |
| `issue-6475-linked-provider-realm.test.ts` | 2 | 2 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6476-linked-async-marker.test.ts` | 2 | 2 | A | AssertionError: expected undefined to be defined |
| `issue-6480-codegen-hotspot-memo.test.ts` | 1 | 1 | A | AssertionError: expected 'AGFzbQEAAAAB6R/wAlAAXwF/AV5vAU8BAF8Cf…' not to be 'AGFzbQEAAAAB6R/wAlAAXwF/AV5vAU8BAF8Cf…' // Object.is equality |
| `issue-6482-linked-shape-brand.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6482-r3-sparse-vec-own-indices.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6482-r6-linked-uncurried-hasown.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6482-r7-pregrow-holes.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6482-r8-arguments-discriminator.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6485-concat-isconcatspreadable.test.ts` | 1 | 1 | A |  |
| `issue-6487-escaping-param-body-inference.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'foo:abcd' // Object.is equality |
| `issue-6491-linked-under-applied-consumer-call.test.ts` | 5 | 5 | A | AssertionError: expected [ 'VAL:null' ] to include 'VAL:n=0' |
| `issue-6492-linked-arraybuffer-brand.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6492-linked-async-callback-promise.test.ts` | 5 | 5 | A | AssertionError: expected '[object WebAssembly.Exception]' to be 'PROBE:thenable' // Object.is equality |
| `issue-6492-linked-class-value-crossing.test.ts` | 3 | 3 | A | AssertionError: expected [ 'NO-THROW' ] to strictly equal [ 'sameCtor=true' ] |
| `issue-6492-linked-method-trampoline-abi.test.ts` | 3 | 3 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6492-r28-trycatch-planner-checker.test.ts` | 3 | 3 | A | AssertionError: planWhileLoopCfg must forward the checker: expected '' to contain 'analyzeWhileAsync(fn, plan, checker)' |
| `issue-6492-r4-linked-iterator-binding.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6492-r4b-iterator-binding-statics.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6492-r5-sandbox-realm-instanceof.test.ts` | 2 | 2 | A | AssertionError: expected 'undefined' to be 'function' // Object.is equality |
| `issue-6492-r6-lib-globals-ambient-callables.test.ts` | 1 | 1 | A | AssertionError: expected 'fail: [object WebAssembly.Exception]' to be 'pass' // Object.is equality |
| `issue-6492-r6-undef-sentinel-canonical-undefined.test.ts` | 2 | 2 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__get_undefined' |
| `issue-6492-r9-linked-provider-free-global-call.test.ts` | 2 | 2 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__call_function' |
| `issue-6493-first-class-builtin-method-values.test.ts` | 1 | 1 | A | AssertionError: expected [ 'undef!throws', 'null!throws', …(8) ] to deeply equal [ 'undef!throws', 'null!throws', …(8) ] |
| `issue-6504-optional-chain-shortcircuit.test.ts` | 1 | 1 | A | AssertionError: expected '[object WebAssembly.Exception]' to contain 'CONTROL' |
| `issue-6504-spilled-call-await.test.ts` | 11 | 11 | A | AssertionError: expected [] to deeply equal [ '__6504_reached_end__' ] |
| `issue-6609-standalone-dynamic-callable-getprototypeof.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-6612-dynamic-new-is-constructor.test.ts` | 1 | 1 | A | AssertionError: expected '9/7/3/object/0' to be '9/7/3/object/undefined' // Object.is equality |
| `issue-6619-f64-arg-symbol-bigint.test.ts` | 2 | 2 | A | AssertionError: expected '0' to be 'true/true' // Object.is equality |
| `issue-6649-standalone-regexp-dynamic-capture-metadata.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-6651-c-class-expando-mop.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to contain '__cls_expando_recv' |
| `issue-6651-d3-class-receiver-combinator.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-6651-d6-promise-subclass-cell-read.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-6651-g2-dstr-default-drive.test.ts` | 1 | 1 | A | AssertionError: expected 110 to be 111 // Object.is equality |
| `issue-6651-gen1-nested-rest-binding-slot.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-6651-i7-rest-arguments.test.ts` | 1 | 1 | A | AssertionError: expected 55 to be 11 // Object.is equality |
| `issue-6651-namespace-instanceof-object.test.ts` | 1 | 1 | A | AssertionError: Type annotations can only be used in TypeScript files. |
| `issue-6651-promise-combinator-drive.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-6651-promise-custom-combinator.test.ts` | 1 | 1 | A | AssertionError: expected [ 'env.__boundary_object_get', …(22) ] to include 'env.Promise_all' |
| `issue-6651-rs1-cross-bucket-residuals.test.ts` | 1 | 1 | A | AssertionError: expected 11 to be 1 // Object.is equality |
| `issue-6651-sn1-reflective-singletons.test.ts` | 4 | 4 | A | AssertionError: expected 27 to be 29 // Object.is equality |
| `issue-6651-sy1-symbol.test.ts` | 4 | 4 | A | AssertionError: expected 15 to be 63 // Object.is equality |
| `issue-6651-with-object-env-record.test.ts` | 4 | 4 | A | AssertionError: expected [ {}, {}, {}, {} ] to deeply equal [ 'has:p', …(3) ] |
| `issue-6656-bigint-wide-carrier.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-6686-js-value-boundary-regime.test.ts` | 1 | 1 | A | TypeError: getUint8 is not a function |
| `issue-671-with-w1.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-6715-undefined-global-index-late-import-shift.test.ts` | 1 | 1 | A | AssertionError: expected undefined to be +0 // Object.is equality |
| `issue-6720-collection-ctor-value-construct.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be 2 // Object.is equality |
| `issue-6736-any-length-absent.test.ts` | 1 | 1 | A | AssertionError: expected 1020 to be 1023 // Object.is equality |
| `issue-675.test.ts` | 1 | 1 | A | AssertionError: expected undefined to be defined |
| `issue-6757-linked-closure-dispatch-bounce.test.ts` | 2 | 2 | A | AssertionError: expected 'fail: Maximum call stack size exceeded' to be 'pass' // Object.is equality |
| `issue-6769-typedarray-residue.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be 3 // Object.is equality |
| `issue-6772-class-residue.test.ts` | 3 | 3 | A | AssertionError: L3: Internal error compiling class 'C': prepared constructor C_new has no exact source init owner |
| `issue-6777-in-array-carrier.test.ts` | 4 | 4 | B | AssertionError: expected 31 to be 19 // Object.is equality |
| `issue-6779-eval-policy.test.ts` | 10 | 10 | V | TypeError: WebAssembly.instantiate(): Import #21 "js2wasm:runtime-eval": module is not an object or function |
| `issue-6780-await-static-suspends.test.ts` | 14 | 14 | B | AssertionError: expected false to be true // Object.is equality |
| `issue-6790-runtime-registries.test.ts` | 4 | 4 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-6791-promise-reject-unhandled.test.ts` | 5 | 5 | A | AssertionError: expected '' to contain 'dropped-6791' |
| `issue-6792-domroot-containment.test.ts` | 3 | 3 | B | TypeError: Cannot convert object to primitive value |
| `issue-6794-cli.test.ts` | 1 | 1 | A | AssertionError: expected 1 to be greater than or equal to 2 |
| `issue-6835-borrowed-find-miss.test.ts` | 1 | 1 | A | AssertionError: expected [ Array(2) ] to deeply equal undefined |
| `issue-6839-standalone-intl-listformat.test.ts` | 1 | 1 | A | AssertionError: expected [ '__str_from_mem', …(19) ] to include 'Intl_ListFormat_new' |
| `issue-684.test.ts` | 4 | 4 | B | TypeError: WebAssembly objects are opaque |
| `issue-6843-standalone-dts-shadowed-body.test.ts` | 1 | 1 | A | AssertionError: expected [ 'env.__str_from_mem', …(20) ] to include 'env.isDynamicPattern' |
| `issue-6844-error-subclass-field-initializers.test.ts` | 4 | 4 | A | AssertionError: expected 'Error\\|foo\\|Error: foo' to be 'ConfigError\\|foo\\|ConfigError: foo' // Object.is equality |
| `issue-6846-nested-leading-await-replay.test.ts` | 1 | 1 | A | TypeError: You must provide a Promise to expect() when using .resolves, not 'object'. |
| `issue-6847-async-for-of-continue-destructuring.test.ts` | 3 | 3 | A | TypeError: You must provide a Promise to expect() when using .resolves, not 'object'. |
| `issue-6848-vec-callback-method-host-delegation.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'a,b' // Object.is equality |
| `issue-6859-async-assigned-param-across-await.test.ts` | 1 | 1 | A | TypeError: You must provide a Promise to expect() when using .resolves, not 'object'. |
| `issue-6867-jest-optional-field-widening.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'lit' // Object.is equality |
| `issue-6872-marked-hooks-residual.test.ts` | 5 | 5 | B | TypeError: Cannot convert object to primitive value |
| `issue-6884-class-bridge-arg-unwrap.test.ts` | 2 | 2 | B | AssertionError: expected {} to be 'true:5' // Object.is equality |
| `issue-6885-host-heterogeneous-array-literal.test.ts` | 2 | 2 | B | AssertionError: expected {} to be '[{"a":1},"s"]' // Object.is equality |
| `issue-6893-linear-ir-read-forwarding.test.ts` | 1 | 1 | A | AssertionError: expected [] to include 'test' |
| `issue-6915-linear-owned-ascii-append-copy-kernel.test.ts` | 1 | 1 | A | Error: 6915 evidence: JS2WASM_APPEND_EXPECTED_PROVENANCE is required |
| `issue-6920-allocation-provenance-preservation.test.ts` | 3 | 3 | A | Error: allocation rule sharing successor: complete source pin current src/ir/analysis/encoding.ts |
| `issue-6920-allocation-rule-sharing-preservation.test.ts` | 12 | 12 | A | Error: allocation rule sharing successor: complete source pin current src/ir/analysis/encoding.ts |
| `issue-6921-ir-middle-end-pass-correctness.test.ts` | 5 | 5 | A | RuntimeError: illegal cast |
| `issue-6931-standalone-host-loose-eq.test.ts` | 2 | 2 | C | RuntimeError: illegal cast |
| `issue-6937.test.ts` | 3 | 3 | A | AssertionError: expected 'throw' to be NaN // Object.is equality |
| `issue-6939-for-head-boxed-var.test.ts` | 1 | 1 | C | RuntimeError: dereferencing a null pointer |
| `issue-6943-new-member-held-ctor.test.ts` | 11 | 11 | A | AssertionError: expected 0 to be greater than 0 |
| `issue-6944-proto-chain-fnctor-instance.test.ts` | 12 | 12 | B | TypeError: Cannot convert object to primitive value |
| `issue-6946-fnctor-reflection-class-ownership.test.ts` | 2 | 2 | B | TypeError: Cannot convert object to primitive value |
| `issue-6946-keys-leak.test.ts` | 11 | 11 | B | TypeError: Cannot convert object to primitive value |
| `issue-6946-own-write-shadows-proto-default.test.ts` | 5 | 5 | B | TypeError: Cannot convert object to primitive value |
| `issue-6969-parse-number-tostring.test.ts` | 8 | 8 | B | AssertionError: expected {} to be 72.5 // Object.is equality |
| `issue-700-test262-language-service.test.ts` | 1 | 1 | A | AssertionError: expected 'import {\n  capturePreparedJobRequest…' to contain 'return incrementalCompiler ? incremen…' |
| `issue-7020-literal-expando-bag-tuple-isarray.test.ts` | 2 | 2 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-708-func-index.test.ts` | 2 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-7104-dynamic-undefined-return.test.ts` | 1 | 1 | A | AssertionError: [ |
| `issue-7106-ambient-static-calls.test.ts` | 4 | 4 | A | AssertionError: expected { claimed: true, threw: false } to deeply equal { claimed: false, threw: false } |
| `issue-7106-borrow-nullish-receiver.test.ts` | 37 | 37 | A | AssertionError: {"key":"test.js::module-init::<module-init>#0","sourceId":"ir-source:v1:0000000000000000:entry:test.js","unitId":"ir-unit:v1 |
| `issue-7106-lever-v.test.ts` | 2 | 2 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-7106-member-closure-shapes.test.ts` | 6 | 6 | A | AssertionError: {"target":"standalone"}: expected { …(20) } to match object { irBodyEmitted: false, …(3) } |
| `issue-7106-module-init-string-position-args.test.ts` | 7 | 7 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-7106-module-init-value-assignment.test.ts` | 2 | 2 | A | AssertionError: expected { …(18) } to match object { Object (kind, stage) } |
| `issue-7106-prophelper-dyn-delete.test.ts` | 2 | 2 | A | AssertionError: expected [ 'notEnum' ] to not include 'notEnum' |
| `issue-7106-regexp-literal-host-free.test.ts` | 3 | 3 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-7106-script-var-reference-homes.test.ts` | 1 | 1 | A | AssertionError: expected { …(18) } to match object { Object (kind, stage) } |
| `issue-7106-wrapper-operands.test.ts` | 4 | 4 | A | AssertionError: stringNumber: expected { …(19) } to match object { irBodyEmitted: false, …(1) } |
| `issue-7124-module-init-all-rejects.test.ts` | 1 | 1 | A | AssertionError: expected [ …(2) ] to deeply equal [ …(4) ] |
| `issue-7126-void-method-return.test.ts` | 1 | 1 | A | AssertionError: expected [] to include 'C_m' |
| `issue-7129-literal-method-return.test.ts` | 4 | 4 | R | Error: Compile option semanticProviders: "host-assisted" selected the host-assisted semantic profile, which #6979 removed (last accepted by |
| `issue-7136-native-dynamic-console.test.ts` | 2 | 2 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-7144-operand-admissibility.test.ts` | 4 | 4 | A | AssertionError: standalone: var t = n - true; throw m;: expected false to be true // Object.is equality |
| `issue-7194-loose-equality-to-primitive.test.ts` | 1 | 1 | A | AssertionError: expected '0' to be 'trap' // Object.is equality |
| `issue-7195-ir-callback-argument-closures.test.ts` | 5 | 5 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-7281-throw-scalar-concat.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-7287-script-var-closure-call.test.ts` | 3 | 3 | A | AssertionError: <module-init>: expected false to be true // Object.is equality |
| `issue-7294-builtin-proto-member-provider.test.ts` | 4 | 4 | A | AssertionError: <module-init> rejected by IR selection (operand-coercion-unsupported): expected false to be true // Object.is equality |
| `issue-733.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-7354-o-objects.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-7354-t2-isnan.test.ts` | 1 | 1 | A | Error: STACK_TRACE_ERROR |
| `issue-7364-prepared-named-refusals.test.ts` | 1 | 1 | A | AssertionError: expected true to be false // Object.is equality |
| `issue-737.test.ts` | 1 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-739-s2-descriptor-pin.test.ts` | 12 | 12 | B | AssertionError: expected {} to be 'yes' // Object.is equality |
| `issue-743-dts-entrypoint-seeds.test.ts` | 1 | 1 | A | AssertionError: expected 'externref' to be 'f64' // Object.is equality |
| `issue-745.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-763.test.ts` | 6 | 6 | B | AssertionError: expected {} to be 'hello world' // Object.is equality |
| `issue-779c.test.ts` | 1 | 0 | E | Error: ENOENT: no such file or directory, open '/workspace/test262/test/built-ins/String/prototype/split/instance-is-string.js' |
| `issue-779e.test.ts` | 2 | 0 | A | AssertionError: expected 1 to be 99 // Object.is equality |
| `issue-797-batch1.test.ts` | 2 | 0 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `issue-797-wi5.test.ts` | 3 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-820.test.ts` | 3 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-820b.test.ts` | 7 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `issue-820d.test.ts` | 3 | 3 | A | AssertionError: expected 2 to be 1 // Object.is equality |
| `issue-820j.test.ts` | 2 | 2 | A | AssertionError: expected 'CE:The host-semantic implementation w…' to be 1 // Object.is equality |
| `issue-820k.test.ts` | 8 | 8 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-820m.test.ts` | 1 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-834.test.ts` | 3 | 3 | A | AssertionError: expected [] to include 'Set_union' |
| `issue-837.test.ts` | 3 | 3 | B | AssertionError: expected {} to be 'a=1;b=2;c=3;' // Object.is equality |
| `issue-838.test.ts` | 1 | 1 | A | AssertionError: expected NaN to be 4032 // Object.is equality |
| `issue-846-slice2.test.ts` | 2 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-849.test.ts` | 4 | 0 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-851.test.ts` | 4 | 0 | E | Error: ENOENT: no such file or directory, open '/workspace/test262/test/language/statements/for-of/iterator-close-via-break.js' |
| `issue-854-smoke.test.ts` | 2 | 1 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-855.test.ts` | 1 | 1 | A | AssertionError: expected 0 to be greater than 0 |
| `issue-863.test.ts` | 1 | 0 | A | No test suite found in file /home/runner/work/js2/js2/tests/issue-863.test.ts |
| `issue-864.test.ts` | 3 | 3 | A | AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-907.test.ts` | 1 | 0 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to contain '__init_done' |
| `issue-923.test.ts` | 2 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to be Promise{…} // Object.is equality |
| `issue-927-batch.test.ts` | 1 | 0 | E | ENOENT: no such file or directory, open '/tmp/current-neg-failures.txt' |
| `issue-945.test.ts` | 4 | 0 | E | Error: ENOENT: no such file or directory, open '/workspace/test262/test/built-ins/ArrayBuffer/isView/invoked-as-a-fn.js' |
| `issue-958-concat-chain.test.ts` | 7 | 5 | B | AssertionError: expected {} to be 'hello world' // Object.is equality |
| `issue-966.test.ts` | 2 | 2 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-983-opaque.test.ts` | 8 | 0 | A | AssertionError: expected 'fail' to be 'pass' // Object.is equality |
| `issue-984.test.ts` | 4 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-986.test.ts` | 4 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-987.test.ts` | 23 | 23 | A | AssertionError: CE in test/language/expressions/class/async-gen-method/yield-spread-obj.js: |
| `issue-990.test.ts` | 1 | 0 | A | AssertionError: expected false to be true // Object.is equality |
| `issue-dstr-requireobj.test.ts` | 1 | 0 | A | AssertionError: expected 1 to be 42 // Object.is equality |
| `issue-json-stringify-structs.test.ts` | 8 | 8 | B | TypeError: Cannot convert object to primitive value |
| `issue-private-access-brand.test.ts` | 3 | 0 | A | RuntimeError: dereferencing a null pointer |
| `iterators.test.ts` | 4 | 4 | B | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__iterator' |
| `json-parser-test.test.ts` | 1 | 1 | B | AssertionError: expected {} to be 'hello' // Object.is equality |
| `json.test.ts` | 5 | 4 | B | AssertionError: expected {} to be '"roundtrip"' // Object.is equality |
| `jwt-decode-test.test.ts` | 22 | 3 | B | AssertionError: expected {} to be '9333e54f89f4611adf85c74ef045d1c484554…' // Object.is equality |
| `local-set-type-mismatch.test.ts` | 2 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `lodash-compile.test.ts` | 38 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `logical-assignment.test.ts` | 2 | 0 | M | LinkError: WebAssembly.instantiate(): Import #1 "env" "__boundary_object_get": function import requires a callable |
| `map-set-basic.test.ts` | 1 | 0 | A | Cannot find module '../../src/runtime.js' imported from '/home/runner/work/js2/js2/tests/map-set-basic.test.ts' |
| `map-set.test.ts` | 3 | 0 | C | Error: Compile failed: |
| `misc-ce-patterns.test.ts` | 3 | 1 | C | AssertionError: Compile failed: |
| `module-eval-mirror-global-attributes.test.ts` | 4 | 4 | V | TypeError: WebAssembly.instantiate(): Import #19 "js2wasm:runtime-eval": module is not an object or function |
| `native-arrays.test.ts` | 8 | 2 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to contain 'f64.convert_i32_s' |
| `native-batched-string-concat.test.ts` | 1 | 1 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' not to contain '__str_concat_4' |
| `native-strings-roundtrip.test.ts` | 5 | 5 | A | Error: __test_str_from_externref export missing |
| `native-strings.test.ts` | 2 | 2 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain 'string_constants' |
| `new-non-constructor.test.ts` | 1 | 0 | A | Cannot find module '../../src/index.js' imported from '/home/runner/work/js2/js2/tests/new-non-constructor.test.ts' |
| `null-dereference-guards.test.ts` | 2 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `null-destructure-param-object.test.ts` | 3 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `null-pointer-deref.test.ts` | 3 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `null-property-access.test.ts` | 2 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `null-struct-get.test.ts` | 1 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `numeric-local-any-add.test.ts` | 3 | 3 | A | AssertionError: IR path failed for oneNumericLocal: ir/from-ast: '+' operands not provably both-number or string-concatenable (number/unprov |
| `object-file.test.ts` | 3 | 2 | A | AssertionError: expected 0 to be greater than or equal to 1 |
| `object-member-callable-param-host-callback.test.ts` | 4 | 4 | A | TypeError: Cannot access property on null or undefined at 5:36 |
| `object-methods.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'x' // Object.is equality |
| `optional-params.test.ts` | 3 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `package-linking.test.ts` | 3 | 3 | A | AssertionError: expected 'bundled' to be 'separate' // Object.is equality |
| `playground-acorn-artifact.test.ts` | 5 | 5 | A | Error: Invalid JavaScript adapter manifest: incoherent target profile semantic provider policy 'host-assisted' |
| `playground-full.test.ts` | 1 | 0 | E | ENOENT: no such file or directory, open '/home/runner/work/js2/js2/playground/main.ts' |
| `playground-vec.test.ts` | 3 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `private-arguments-registration.test.ts` | 10 | 10 | A | AssertionError: expected false to be true // Object.is equality |
| `promise-combinators.test.ts` | 6 | 6 | A | AssertionError: expected {} to be 7 // Object.is equality |
| `prototype-chain.test.ts` | 6 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `react-fiber-test.test.ts` | 8 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `real-world-web-apis.test.ts` | 4 | 4 | A | AssertionError: expected [ '__str_from_mem', …(2) ] to deeply equal ArrayContaining{…} |
| `ref-cast-peephole.test.ts` | 6 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `regexp-host-static-inheritance.test.ts` | 1 | 1 | A | AssertionError: expected error to be instance of ReferenceError |
| `report-error-patterns-edition-scope.test.ts` | 1 | 1 | A | AssertionError: 3298 proposal-scope record(s) reachable from a published edition: expected [ { …(2) }, { …(2) }, { …(2) }, …(7) ] to deeply |
| `runtime-host-eval-isolation.test.ts` | 1 | 1 | A | AssertionError: expected false to be true // Object.is equality |
| `sourcemap.test.ts` | 4 | 0 | A | AssertionError: expected 0 to be greater than 0 |
| `spec-gaps.test.ts` | 1 | 0 | A | AssertionError: expected 'FTF' to be 'FTT' // Object.is equality |
| `spread-rest.test.ts` | 13 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `stack-balance.test.ts` | 3 | 2 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `standalone-cutover-audit.test.ts` | 2 | 2 | A | AssertionError: expected [] to have a length of 3 but got +0 |
| `stdlib.test.ts` | 5 | 0 | C | AssertionError: Compile failed: |
| `string-enums.test.ts` | 5 | 5 | B | AssertionError: expected {} to be 'DOWN' // Object.is equality |
| `string-literal-cache.test.ts` | 9 | 9 | B | AssertionError: expected [ Array(1) ] to include 'hello' |
| `string-split.test.ts` | 4 | 4 | B | AssertionError: expected {} to be 'b' // Object.is equality |
| `strings.test.ts` | 4 | 3 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `struct-get-externref-cast.test.ts` | 2 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `struct-null-ref.test.ts` | 3 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `struct-proxy-wrappers.test.ts` | 8 | 7 | A | TypeError: Cannot convert object to primitive value |
| `symbol-async-iterator.test.ts` | 2 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `test-1022-regression.test.ts` | 13 | 0 | E | Error: ENOENT: no such file or directory, open '/workspace/test262/test/built-ins/Array/prototype/every/call-with-boolean.js' |
| `test262-errors.test.ts` | 1 | 1 | A | did not finish within the serial re-run timeout |
| `test262-fyi-runner.test.ts` | 2 | 2 | A | AssertionError: expected { Object (filters, pathsFile, ...) } to deeply equal { Object (filters, pathsFile, ...) } |
| `test262.test.ts` | 1 | 1 | A | did not finish within the serial re-run timeout |
| `ts-parser-test.test.ts` | 17 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `ts-statement-parser-test.test.ts` | 17 | 6 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `tuple-struct-match.test.ts` | 1 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__boundary_object_get": function import requires a callable |
| `typed-array-basic.test.ts` | 11 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `typed-export-signatures.test.ts` | 2 | 2 | A | AssertionError: expected '  (func $identity (type 44)' to contain 'externref' |
| `typeof-expression.test.ts` | 5 | 5 | B | AssertionError: expected [ 'TypeError', …(8) ] to include 'number' |
| `unified-collector-592.test.ts` | 1 | 0 | M | LinkError: WebAssembly.instantiate(): Import #0 "env" "__str_from_mem": function import requires a callable |
| `union-narrowing.test.ts` | 2 | 2 | B | TypeError: type incompatibility when transforming from/to JS |
| `v8x-compile-graph.test.ts` | 2 | 2 | A | Error: TypeError: called value is not a function |
| `v8x-js2wasm-spike.test.ts` | 1 | 1 | A | AssertionError: /home/runner/work/js2/js2/examples/v8x-js2wasm-spike/compile-graph.ts:1590 |
| `value-repr-tag5-abi.test.ts` | 3 | 1 | A | AssertionError: expected 1 to be +0 // Object.is equality |
| `wasi-environ.test.ts` | 3 | 0 | A | AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '"env" "__wasi_env_get_str"' |
