---
id: 6749
title: "S3-h: npm-compat regime lane parity — packages that measure on the host lane must measure, with the same checksum, on the native regime"
status: in-progress
assignee: ttraenkler/fable
created: 2026-09-29
updated: 2026-10-06
priority: critical
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, runtime, host-interop, testing
language_feature: npm-compat
goal: architecture
loc-budget-allow:
  # 2026-10-06 (#6749 part A): +1 line in calls.ts — the regime arm that
  # marshals the host UUID string (helper lives in standalone-crypto.ts).
  - src/codegen/expressions/calls.ts
func-budget-allow:
  # 2026-10-06 (#6749 part A): +1 line, same arm.
  - src/codegen/expressions/calls.ts::compileCallExpression
sprint: current
parent: 5385
depends_on: [6686, 6707]
related: [3988, 4398, 4401, 6708]
---

# #6749 — S3-h: npm-compat parity for the native regime

Slice S3-h of the #5385 "Implementation Plan v2" and the **product bar**
for S6 (#6708 evidence item 3). `benchmarks/results/npm-compat.json`
generated 2026-09-28T23:58Z (after S5 made the regime the default for
native-first) — perf lanes `jsHost` (host-assisted) vs `jsHostNative`
(regime):

| package | host lane | regime lane | diagnostic |
| --- | --- | --- | --- |
| clsx | measured | **measured** | — |
| uuid | measured | compile-error | policy rejected `env::__crypto_get_random_values`, `env::__crypto_random_uuid` (unknown, #4401) |
| moment | measured | runtime-error | `WebAssembly.instantiate(): Import #20 "js2wasm:runtime-eval": module is not an object or function` |
| react | measured | runtime-error | `ReferenceError: require is not defined` |
| cookie | measured | **result-mismatch** | `cookie checksum mismatch: 0 !== 1` |
| hono | measured | **result-mismatch** | `checksum mismatch: Wasm 1, Node 9` |
| redux | measured | **result-mismatch** | `checksum mismatch: Wasm NaN, Node 7` |
| acorn | measured | runtime-error | `TypeError: Cannot access property on null or undefined at 438:67` |
| marked | measured | runtime-error | `[object WebAssembly.Exception]` |
| lit | measured | runtime-error | `[object WebAssembly.Exception]` |

test262 is not representative of these packages' shapes (dynamic
`require`, crypto, checksum workloads over real object graphs); this slice
is where the "merge, don't lose capability" promise is actually tested.
Order by kind, cheapest and most diagnostic first:

## A. Wiring and classification (mechanical, do first)

1. **uuid** — `__crypto_get_random_values` / `__crypto_random_uuid` are
   platform capabilities (randomness), not semantics: classify them in
   `src/host-import-policy.ts` as `platform-capability`/`randomness`
   (owner 4398, no native fallback), like `Math.random` and WASI
   `random_get`. Verify the runtime binds them through the capability
   adapter under native-first.
2. **moment** — the npm perf harness instantiates the regime module
   without attaching `js2wasm:runtime-eval`; reuse the test262 seam's
   feature-detected attachment (`scripts/test262-import-object.mjs`
   `attachConditionalImportNamespaces`) in
   `scripts/generate-npm-compat-report.mjs`'s regime lane, linking the
   same QuickJS provider the test262 lane uses.
3. **react** — `require` under the regime: the host lane satisfies it via
   the `node_builtin` capability; find why the regime build resolves
   `require` as a bare global read instead of the declared Node capability
   (a `ctx.standalone`-gated arm in the CJS rewrite / `declared_global`
   path, probably `src/cjs-rewrite.ts` or `src/codegen/expressions/identifiers.ts`)
   and re-key it to `hostFreeEnvironment(ctx)`.

## B. Wrong results (correctness — the serious ones)

4. **cookie**, **hono**, **redux** produce a *different value* than Node
   (`0 !== 1`, `1 vs 9`, `NaN vs 7`). For each: run the perf workload's
   sample operation (`perf.sampleOp` in the JSON) under the regime and
   under host-assisted, bisect the divergence to the first differing
   intermediate (print statements in a copy of the workload are fine),
   and fix the provider arm. Expect the #5385 v2 "which provider" arms
   that the standalone lane never exercised with these shapes (string
   coercion in `cookie`'s parser, `hono`'s router map/regex, `redux`'s
   reducer arithmetic → `NaN` suggests a boxed-number unbox miss on the
   admitted-object path from S2). File a child issue per root cause if it
   is not a one-liner; do not batch three unrelated fixes in one PR.

## C. Runtime throws

5. **acorn** null-deref at `438:67`, **marked** and **lit** uncaught Wasm
   exceptions: render the exception (`__exn_render_*`, hostBridge is on),
   name the throw site, and route to the owning family; these are likely
   the same class as the test262 `Cannot access property on null or
   undefined` bucket (47 rows) and may share a fix.

## Acceptance

- [ ] Every package that is `measured` on `jsHost` is `measured` on
      `jsHostNative` with an identical checksum, in the CI-generated
      `npm-compat.json` after the refresh (no hand-committed artifact).
- [ ] Byte-identity for default `gc`/`standalone`/`wasi` output; host-lane
      npm numbers unchanged.
- [ ] Each B-item fix has a focused test with the exact diverging value.
- [ ] #6708's evidence item 3 can be ticked with the run id.

## Progress — 2026-10-06 (part A, Fable lane; spawn gate blocked at load 27–33)

Starting state re-derived from `benchmarks/results/npm-compat.json`
(generatedAt 2026-10-06T06:19Z): identical to the table above, plus
**prettier** host-measured / regime `compile-error` ("emitted WebAssembly
failed validation … `__closure_538` … expected (ref null 38), got (ref 2)") —
a codegen validation bug, filed under part C, not A.

| package | before (regime) | after (local, focused lane) | change |
| --- | --- | --- | --- |
| uuid | compile-error (unknown `__crypto_*`) | links and runs; `randomUUID()` marshals to a native string | `src/host-import-policy.ts` classifies `__crypto_get_random_values` / `__crypto_random_uuid` as `platform-capability/randomness` (owner 4398, no native fallback); `src/capability-registry.ts` js-host `randomness` provider contract carries both; `src/codegen/expressions/calls.ts` marshals the UUID through `emitHostExternrefToNativeString` on the regime (`ctx.standalone`, bridge gated by environment) |
| uuid sample op | — | still blocked: `.length` / RegExp on the UUID reads `NaN` | **#6868** — template-literal types (`crypto.randomUUID()`'s lib type) are not strings in `oracle.ts` / `type-mapper.ts`; reproduces under plain standalone; separate PR (not byte-identical for default gc) |
| moment | runtime-error (`js2wasm:runtime-eval` not an object) | **measured** (3.0 ms vs Node 6.6 µs) | `scripts/generate-npm-compat-report.mjs` `npmCompatHostImportObject` attaches the seam via `attachConditionalImportNamespaces` before linked providers; `npm-compat-refresh.yml` prebuilds the refusal provider (6 s) and sets `JS2WASM_EVAL_ENGINE=interpreter` on both measure jobs |
| react | `require is not defined` | unchanged — diagnosed | host lane never compiles react: `package/index.js` is `process.env.NODE_ENV === 'production' ? require('./cjs/…') : require('./cjs/…')`, a shape the CJS rewrite leaves alone, so the host lane reads the bare `require` global (`__get_builtin`) and Node executes react natively. On the regime the read throws because every declared-global import (`src/codegen/extern-declarations.ts` ≈ L1613/L1657/L1757, `global_<name>`) and the host-global materialization (`src/codegen/expressions/identifiers.ts` ≈ L1744: `Buffer`, `process`, `crypto`, `Intl`, TA ctors) are gated on `ctx.standalone` rather than `hostFreeEnvironment(ctx)`. Two honest options: (a) re-key those platform-shaped gates to the environment so a Node-environment `require`/`process` binds as the `global:<name>` platform capability (reads must go through the value-adapter MOP, not `__extern_get`); (b) hoist in-branch relative `require` literals in the CJS rewrite so BOTH lanes compile react. (a) is the #5385 design rule; do (a) first, consider (b) as a separate improvement |

Byte identity (sha256, default `gc` / `--target standalone` / `--target wasi`
on a crypto + string probe), base vs after: see PR body.

### react, corrected (2026-10-06, later): the host-lane row is vacuous

Disassembly of a minimal `if (flag) { module.exports = require("./a.js") }
else { module.exports = require("./b.js") }` on the host lane (`wasm-opt -all
--print`): both branches lower to `global.set $exports (ref.null noextern)` —
the in-branch `require` call is dropped to the graceful-null default, not
resolved and not delegated to Node. So on the host lane react's
`package/index.js` evaluates to `undefined`, `import { version }` reads
`undefined`, and the driver's sample op (`__pkg ? input.length + 1 : …`) never
touches react at all. "measured" there means "the driver ran", not "react
ran". On the regime the same bare `require` read throws ReferenceError
(`identifiers.ts` "truly undeclared variable" arm), which is the only reason
the rows differ.

Consequence for parity: re-keying declared-global gates (the earlier plan) is
NOT the fix — there is no `require` binding on either lane. The honest fix is
in the CJS rewrite (`src/cjs-rewrite.ts`): hoist relative-literal `require`
calls that sit inside statement bodies (the `process.env.NODE_ENV` ternary /
if-else idiom every React-family package uses) into module-scope imports, so
BOTH lanes compile react for real and the row measures something. That is a
separate slice with its own byte-identity story (it changes the host lane too,
deliberately); file it under #6749 part B' and do it before cookie/hono/redux,
since those rows at least execute their packages.

### Part B, first finding (2026-10-06): cookie was the harness, not codegen

`parseCookie(header)` on the regime returns `{a:"1",…,h:"8"}` through
`buildCompiledImports` + `wrapCompiledExports` (the #6686 adapter entry), but
`{}` through `wrapExports(instance, { signatures })` — the per-package perf
functions and the generic lane wrapped exports WITHOUT the compile result's
`exportBoundaryPolicies`, so a returned regime object reached JS empty and the
`parsed.a === "1"` checksum read 0. Four shapes probed (null-proto ctor,
`Object.create(null)`, literal, class instance): all `{}` via the legacy
wrapper, all correct via the compiled adapter. `npmCompatWrapExports` now uses
the compiled adapter for native-first results only (host lane keeps the exact
legacy wrapper). Re-measured, regime lane: **cookie measured** (ratio 0.0089),
clsx still measured; **hono** still `Wasm 1, Node 9`, **redux** still
`Wasm NaN, Node 7` — those two are real.

### Part B, second finding (2026-10-06): hono is a codegen gap shared with standalone → #6875

hono's `input.length` (untyped driver param) is `undefined`: an `externref`
parameter's member read goes through `__extern_get`, which has no
native-string RECEIVER arm (the `$AnyString` test near its top is on the key).
Reduced and reproduced under plain `--target standalone`
(`len(JSON.parse('"abcd"')) == 4` → 0), so it is pre-existing, not a regime
regression; filed as #6875 with the arm to add. redux (`Wasm NaN, Node 7`)
not yet bisected — same lane recipe; `Number(input)` alone is fine in
isolation, so look at the reducer's default parameter / `action.amount` read
on a dynamic object next.

### redux, first bisect (2026-10-06)

Reduced shapes all compute 1 for `op("1")` on the regime: a hand-written
`createStore` with a default-parameter reducer, the reducer without the
default, `Number(input) + 6`, and `a.type === "add" ? a.amount : -1`. So the
`Wasm NaN, Node 7` is inside redux's real `createStore` (`redux.mjs`): the
`ActionTypes.INIT` string built from `Math.random().toString(36)`, the
`isPlainObject` `Object.getPrototypeOf` walk, `typeof action.type ===
"undefined"` guards, `Symbol.observable`. Next step: copy `redux.mjs` into
`.tmp/`, add prints at `dispatch` entry (`action.type`, `typeof
action.amount`) and after `currentReducer(currentState, action)`, run the lane
with the copied entry, and bisect from there.
