---
id: 1164
title: "Dynamic eval via JS host import — compile eval string to ad-hoc Wasm module (~416 tests)"
status: done
created: 2026-04-22
updated: 2026-08-13
completed: 2026-08-13
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval
goal: spec-completeness
sprint: 45
depends_on: [1163]
required_by: [1066, 1165]
loc-budget-allow:
  - src/codegen/declarations/import-collector.ts
  - src/codegen/index.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/select.ts::isPhase1Expr
  - src/runtime.ts::resolveImport
---
# #1164 — Dynamic eval via JS host import: compile eval string to ad-hoc Wasm module

## Problem

416 test262 tests use `eval` with a dynamic (non-constant) argument. These
cannot be inlined at compile time (#1163). In JS-host mode, they need a
runtime eval path.

The existing #1006 implementation routes `eval(src)` to `(0, eval)(src)` in
the JS host — calling the browser/Node `eval` builtin directly. This works
but has two significant problems:

### Problem 1: JS globals are fully exposed

`(0, eval)(src)` runs in JS global scope. The eval'd string gets unrestricted
access to the entire host JS environment: `window`, `document`, `fetch`,
`require`, `process`, `localStorage`, the `Function` constructor (allowing
further dynamic codegen), and any globally-assigned variables. The compiled
Wasm module is sandboxed, but as soon as it calls `__eval`, that string
escapes into the full JS environment with no capability restrictions.

### Problem 2: CSP compatibility

`(0, eval)(src)` is blocked by `Content-Security-Policy: script-src` without
`'unsafe-eval'`. Many production deployments and browser extensions cannot
grant this directive.

## Strategy: compile to ad-hoc Wasm module via the Wasm JS API

When `eval(src)` is called at runtime in JS-host mode, the host-side import
function should:

1. Call `js2wasm.compileSource(src, { filename: "__eval__.js", allowJs: true })`
   to compile the eval string through the full js2wasm pipeline
2. Instantiate the resulting Wasm binary using `WebAssembly.compile` +
   `WebAssembly.instantiate`, forwarding only the imports the child module
   explicitly declares — **not** the full JS global scope
3. Call the child module's entry export and return the result
4. Forward any thrown exceptions back across the boundary

```js
// host-side import implementation
async function __eval_import(src, isDirect) {
  const { binary } = js2wasm.compileSource(
    `export function __eval_result() { return (${src}); }`,
    { filename: "__eval__.js", allowJs: true }
  );
  const mod = await WebAssembly.compile(binary);
  // Only forward explicitly declared imports — no JS global leakage
  const inst = await WebAssembly.instantiate(mod, selectiveImports);
  return inst.exports.__eval_result();
}
```

### Security model comparison

| | `(0, eval)(src)` (#1006) | Wasm-module compilation (#1164) |
|---|---|---|
| JS globals accessible | **All** (`window`, `fetch`, `require`, …) | **None** unless explicitly forwarded |
| `Function(...)` / further codegen | **Yes** | No (trapped in Wasm sandbox) |
| `document`, `localStorage`, etc. | **Yes** | Only if forwarded as imports |
| CSP requirement | `unsafe-eval` | `wasm-unsafe-eval` (separate, narrower) |
| Semantics consistency | JS engine | js2wasm pipeline (same as parent) |

The Wasm-module approach enforces a proper capability boundary: the child
module can only do what you explicitly grant it via the `selectiveImports`
object. A host that wants maximum isolation passes `{}` — the child module
gets a pure Wasm sandbox with no JS surface at all.

**The `__eval` import is a capability that hosts can withhold.** If a host
does not link the `__eval` import, eval calls trap at the Wasm boundary
rather than escaping into JS. This must be documented in the runtime shim.

This approach:
- Enforces a capability boundary — no implicit JS global leakage
- Works without relying on host `eval` (CSP-safe: only `wasm-unsafe-eval` needed)
- Produces semantics consistent with the rest of the compiled module
- Reuses the existing js2wasm compiler pipeline

## Compiler-side changes

- Detect `eval(expr)` where `expr` is not a string literal
- Lower to a host import call: `__eval(src: externref, isDirect: i32) -> externref`
- Provide a reference JS-host shim in `src/runtime.ts` (or a new
  `src/runtime-eval.ts`) that implements `__eval` using the Wasm JS API
- The shim is tree-shaken out if no dynamic eval calls exist in the module

## Scope

- `eval(expr)` with any dynamic expression — JS-host mode only
- Direct vs indirect eval flag passed to the host (`isDirect: i32`)
- Exception round-trip: host catches thrown values and re-throws via the
  module's exception tag
- Synchronous eval only (async eval strings are a separate concern)

## Optional hardened mode: Worker isolation

For deployments that control their HTTP headers, the shim can run the Wasm
child module inside a **Web Worker** for true process isolation:

```js
// evalMode: "worker" — stronger isolation, requires Cross-Origin-Isolation
const worker = new Worker("eval-worker.js");
worker.postMessage({ src, isDirect });
worker.onmessage = ({ data }) => resolve(data.result);
```

**What this adds:** The Worker global scope has no `window`, `document`,
`localStorage`, or parent-page state — even if `selectiveImports` accidentally
forwarded something, the Worker context doesn't have it to forward.

**What it breaks / requires:**

| Constraint | Detail |
|---|---|
| Sync eval impossible | `postMessage` is async; requires `Atomics.wait` + `SharedArrayBuffer` for sync bridge |
| Cross-Origin-Isolation headers | `COOP: same-origin` + `COEP: require-corp` — breaks third-party iframes, OAuth popups, CDN scripts |
| Return value serialization | Results must be structured-clone serializable (no functions, Wasm instances, DOM nodes) |
| Worker startup latency | ~10–50ms first call; requires persistent Worker pool to amortize |
| Direct eval scope | Worker has zero access to parent scope — direct eval behaves as indirect eval |

**Sync bridge via SharedArrayBuffer** (for sync eval in Worker mode):
```js
const sab = new SharedArrayBuffer(8);
const signal = new Int32Array(sab);
worker.postMessage({ src, sab });
Atomics.wait(signal, 0, 0); // block until Worker signals
```
Requires `Cross-Origin-Isolation`. Not available in all deployment contexts.

**Recommendation:** Ship the default same-thread Wasm-module approach first.
Provide `evalMode: "worker"` as an opt-in for security-sensitive contexts that
already have Cross-Origin-Isolation headers. Document both modes in
`src/runtime-eval.ts`.

## Out of scope for the original host increment

- The original implementation did not provide Standalone/WASI eval; #1165
  owns that provider. Standalone eval is nevertheless inside the current
  `plan/goals/es5.md` completion boundary and must be counted by the full-lane
  acceptance gate below.
- Scope capture (caller variables visible inside eval string) — see #1073
- `new Function(...)` — follow-up, also inside the current ES5 goal boundary

## Acceptance criteria

- `eval(someVar)` at runtime calls the host shim and returns the evaluated result
- The shim compiles the eval string through js2wasm and instantiates via
  `WebAssembly.compile` / `WebAssembly.instantiate`
- Thrown exceptions inside the eval string propagate correctly to the caller
- Reference shim ships in `src/runtime-eval.ts` with documentation
- Meaningful reduction in the 416 dynamic-eval test failures
- No regressions in `tests/equivalence.test.ts`

## Long-term native path: `func.new` (Wasm JIT interface proposal)

The [Wasm JIT interface proposal](https://github.com/WebAssembly/jit-interface/blob/main/proposals/jit-interface/Explainer.md)
introduces a `func.new` instruction that creates a callable function reference
directly from Wasm bytecode stored in linear memory — no JS host required.
Once it ships, the eval path collapses to:

1. Compile eval string → Wasm bytes (using js2wasm compiled to Wasm, #1058)
2. Write bytes to linear memory
3. `func.new` → `funcref`
4. Call it, return result

The host-import shim in this issue is a **direct polyfill** of that semantics
using `WebAssembly.compile` / `WebAssembly.instantiate` from the JS boundary.
When `func.new` is available (tracked in #1165), the shim can be replaced with
a pure-Wasm implementation and eval will work in standalone runtimes too.

## ECMAScript spec reference

- [§19.2.1 eval(x)](https://tc39.es/ecma262/#sec-eval-x)
- [§19.2.1.1 PerformEval](https://tc39.es/ecma262/#sec-performeval)

## Implementation Notes

Landed in:
- `src/runtime-eval.ts` (new) — reference shim that compiles eval strings via
  `js2wasm.compileSource` and instantiates them as ad-hoc Wasm modules.  Exposes
  `createEvalShim({ selectiveImports?, sandbox?, filename?, onCompiled? })`.
- `src/codegen/expressions/calls.ts` — `__extern_eval` signature widened from
  `(externref) -> externref` to `(externref, i32) -> externref`.  The new
  `i32 isDirect` flag (1 = direct call `eval(...)`, 0 = indirect
  `(0, eval)(...)`) is forwarded to the host shim for ECMA-262 §19.2.1
  scope-distinction support.
- `src/runtime.ts` — `__extern_eval` import wired through `createEvalShim()`
  as the primary path; legacy `(0, eval)(jsSrc)` host fallback retained for
  test262 harness-aware sources that depend on text-rewritten harness
  identifiers (per #1073, kept until that issue is closed).

Flow (default `sandbox: false`, the production path):

1. `__extern_eval(src, isDirect)` first runs a strict TS parse of `src` to
   catch syntax errors that the lenient compiler tolerates (e.g. stray `@`
   tokens parsed as decorators).  Parse errors throw `SyntaxError`.
2. Wrap `src` as `export function __eval_result() { return (${src}); }` and
   `compileSource(...)` it.  On compile failure, retry as a statement-form
   wrapper `export function __eval_result() { ${src}; return undefined; }`
   to support eval strings that are statements rather than expressions.
3. `new WebAssembly.Module(binary)` → `new WebAssembly.Instance(mod, imports)`
   synchronously (matches JS `eval`'s sync semantics).
4. The child's import object is built by re-entering `buildImports` with the
   child's own manifest, giving it the standard js2wasm helpers.
   `selectiveImports` (caller-provided) layer on top.  The child's
   `__extern_eval` slot is wired recursively to the same shim.
5. Call `instance.exports.__eval_result()` and return.  Throws inside the
   child propagate normally back to the parent module's `try`/`catch` frame.

Sandbox mode (`sandbox: true`) skips the auto-fill — only `selectiveImports`
plus minimal `string_constants` / `wasm:js-string` shims are forwarded.  Any
declared import the caller didn't provide becomes a trapping stub.

The legacy host-eval fallback (`runtime.ts::_legacyHostEval`) is invoked only
when the Wasm-module path fails *non-syntactically* (e.g. unsupported builtin,
mismatched import signature, unresolved test262 harness identifier).  This
preserves the ~107 harness-visibility passes from #1073 until that issue is
properly closed.

## Test Results

- New tests: `tests/issue-1164.test.ts` — 17 / 17 pass
  - 10 dynamic-eval Wasm-path tests (arithmetic, string return, indirect
    eval, non-string passthrough, syntax error, runtime throw, nested eval,
    multiplication, ternary, repeated calls)
  - 7 `createEvalShim` API tests (non-string passthrough, expression eval,
    string eval, SyntaxError on malformed source, telemetry callback,
    recursive eval, sandbox mode)
- Existing eval suites unchanged:
  - `tests/issue-1006.test.ts` — 7 / 7 pass (host-import fallback works)
  - `tests/issue-1163.test.ts` — 8 / 8 pass (static inlining unaffected)
- Equivalence suite: 1186 / 1291 pass, 105 fail (pre-existing baseline; the
  pre-#1163 baseline was 1185 / 1291 — so this branch is net +1 with no new
  regressions)

## Implementation Plan — 2026-08-13 ES5 residual

### Architecture verdict

Candidate `64b8f831151efe4c11f241b2889cc7eedbebd7f7` is a useful reference,
not a merge-ready patch. Its two changes solve different problems and must be
measured separately:

1. The Test262 gain comes from making the existing legacy host-eval fallback
   install its already-defined raw `assert.*` object.
2. The IR change gives one exact **indirect**, result-discarded host eval shape
   explicit import ownership. It does not implement direct-eval lexical scope,
   value-producing eval, or standalone eval.

The candidate's 121-row result is head-only evidence against an older
baseline. Re-run both arms from the same current-main population before
crediting any flip. In particular, do not describe the 88 direct-eval rows as
IR wins: they continue through the legacy/reified dynamic-code path.

### Root causes

`wrapTest` cannot rewrite identifiers embedded in source strings. When such a
string reaches `src/runtime.ts::_legacyHostEval`, raw calls such as
`assert.sameValue(...)` are invisible to the current `needsShim` detector,
even though the generated shim already defines `assert`. The fallback then
executes the source in the global realm and throws `ReferenceError`.

Separately, an IR-emitted body skips the legacy body emitter that used to
register `env.__extern_eval`. An exact `(0, eval)(source);` statement can only
be owned by IR if selection, call-graph classification, early import
collection, lowering, and provider resolution agree on one certified shape.
The candidate selector accepts any Phase-1 argument while the lowerer later
rejects non-strings; that is a post-claim demotion and must be removed.

### Changes

**File: `src/runtime-eval.ts` — beside `createEvalShim` (line ~133)**

- Add a small exported classifier for Test262 raw-assert syntax. Parse the
  eval source with the existing `ts` import and return true only for an active
  unshadowed `assert(...)`, `assert.<method>(...)`, or
  `assert["<known method>"](...)` reference.
- Treat any binding declaration named `assert` as a conservative no-match.
  Comments and string/template text containing `assert.` must not match.
- Keep this classifier harness-only; it must not change ordinary
  `PerformEval` semantics or select an execution engine.

**File: `src/runtime.ts` — `resolveImport` / `_legacyHostEval` (lines
~8431 / ~9505)**

- In `resolveImport`, inside the `name === "__extern_eval"` branch and
  `_legacyHostEval`, include the raw-assert classifier in `needsShim` beside
  the existing rewritten harness identifiers.
- Reuse the existing shim body. Do not add another `assert` implementation,
  expose host globals, or change the `dynamicCode` policy.
- Preserve ES5.1 §15.1.2.1: a non-string eval argument returns unchanged.
  This follow-up's IR statement slice may reject that shape, but the runtime
  import must retain the general rule.

**File: `src/eval-call-shape.ts` — `exactIndirectEvalIdentifier` (candidate
line ~10; new file)**

- Keep `exactIndirectEvalIdentifier` as the syntax recognizer for only the
  canonical comma form `(0, eval)(source)` after parentheses are stripped.
  The left operand must be the numeric literal zero and the right operand the
  identifier `eval`.
- Add or expose one shared shape check for: expression-statement position,
  exactly one non-spread argument, and the exact callee above. Semantic checks
  (ambient binding, host capability, proven string carrier) remain at the
  phases that own those facts.

**File: `src/ir/select.ts` — `isPhase1Expr` / `buildLocalCallGraph`
(candidate lines ~6351 / ~7669)**

- In `isPhase1Expr`, claim the exact indirect-eval statement only when all of
  these are true: JS-host externs are enabled; `eval` resolves to the ambient
  intrinsic and is not in the current scope; there is one non-spread argument;
  the call's value is discarded; `expressionIsProvenString(argument)` is true;
  and the argument is otherwise Phase-1 lowerable.
- In `buildLocalCallGraph`, exempt the call from `hasExternalCall` only under
  that same certified predicate. A broader graph exemption can incorrectly
  admit a body the lowerer cannot build.
- Direct `eval(source)`, result-producing indirect eval, shadowed eval,
  optional/spread calls, and non-proven-string arguments must demote before an
  IR claim.

**File: `src/codegen/declarations/import-collector.ts` —
`UnifiedCollectorState`, `unifiedVisitNode`, `finalizeUnifiedCollector`
(candidate lines ~87 / ~228 / ~1355)**

- Extend `UnifiedCollectorState` with the exact host-indirect-eval need and set
  it in `unifiedVisitNode` only for the same statement/arity/ambient/string
  slice. Use checker-backed string classification; do not arm the import for
  every syntactic comma-eval in the module.
- In `finalizeUnifiedCollector`, reserve
  `env.__extern_eval : (externref, i32) -> externref` before body planning.
  Reuse an existing function-map entry if one was already registered.

**File: `src/ir/from-ast.ts` — `lowerCall` (candidate line ~5266)**

- In `lowerCall`, repeat the certified checks defensively and lower the source
  as a host-backed string. A failed invariant is a selection bug, not an
  expected post-claim fallback.
- Emit the symbolic call below with `isDirect = 0`. The expression statement
  discards the returned `externref`; do not invent a result coercion contract
  in this slice.

**File: `src/ir/integration.ts` — `makeFromAstResolver` /
`resolveAndObserveCallableProvider` (candidate lines ~4055 / ~4486)**

- In `makeFromAstResolver`, expose only the existing host-extern, ambient
  binding, and host-string facts needed by selection/lowering. Resolve the
  symbolic import through the finalized function map; do not mutate import
  indices while materializing an IR body.

### Wasm IR ownership

```text
%source = lower_string(source)
%boxed  = coerce_to_externref(%source)
%result = call @env.__extern_eval(%boxed, i32.const 0)
drop %result
```

This is a host-only IR path because the import is the capability. Direct eval
must use the reified-binding path from #2925/#1073: a plain host import cannot
observe the caller's lexical and variable environments. Standalone still
needs #1165's runtime/compiler provider. Neither lane is excluded from the
ES5 goal or from the full 9,029-row gate.

### Semantic boundaries and controls

- Positive IR probe: ambient `(0, eval)(source);` with a proven host string;
  require `irBodyEmitted: true`, `legacyBodyEmitted: false`, one symbolic
  `env.__extern_eval` import, and successful `assert.sameValue` execution.
- Demotion controls: direct eval; used return value; non-string/dynamic union;
  zero/two/spread arguments; shadowed `eval`; nonzero comma lhs; optional call.
- Runtime controls: raw `assert.sameValue`, `assert.throws`, and callable
  `assert`; rewritten `assert_sameValue`; a local `let assert`; and inert
  `"assert."`, template text, and comments. The last three must not activate
  or collide with the shim.
- Preserve indirect global-scope behavior and direct lexical-scope behavior.
  A passing Test262 assertion-visibility row is not evidence for either scope
  rule unless the test actually observes it.
- Preserve non-string passthrough, syntax/runtime exception identity, strict
  caller behavior, nested eval, and dynamic-code deny/native/evaluator modes.

### Same-population A/B and zero-loss gates

At implementation start, record the exact latest `origin/main` SHA and use it
as the base arm. The comparison arm is the exact implementation SHA. Both
arms must use Test262 corpus gitlink
`b363f29d3c43c626dc852744ad64a0b48a003693`, the same oracle revision,
harness, target flags, timeout, and maintained file list.

Run four focused arms on the maintained 120-file `assert is not defined`
population plus passing and negative controls:

1. current-main base;
2. runtime raw-assert classifier only;
3. full implementation;
4. full implementation with the raw-assert classifier disabled as an
   attribution kill switch.

Require exact row accounting. Expected attribution is that the runtime-only
arm owns the Test262 flips; the IR arm owns the inventory probe and must add no
unexplained row changes. Report pass/fail/compile-error/timeout/skip totals and
every transition, including unchanged runner errors.

Finally run all **9,029** `<= ES5` tests in each lane through the authoritative
original harness:

- host/gc: 9,029 pass, zero fail/compile error/timeout/skip for goal closure;
- standalone: 9,029 pass, zero fail/compile error/timeout/skip for goal closure;
- for an incremental PR, at minimum zero `pass -> non-pass` in either lane and
  no newly unmeasured rows.

Eval, `Function`, and `with` rows are included. For standalone dynamic-code
measurement, rebuild the compiler/runtime bundle and the configured evaluator
provider, clear any provider cache, and report the provider tier; a trap-only
instrumentation stub is not a passing eval implementation.

### Candidate disposition and implementation handoff

- Rebase/rederive from current main; use candidate `64b8f831...` only as a
  reference.
- Retain the narrow import-first IR design after aligning every predicate and
  adding negative controls.
- Replace the raw `jsSrc.includes("assert.")` heuristic with the syntax-aware
  classifier above.
- Do not claim direct eval, value-producing eval, or standalone eval from this
  increment. Record their remaining exact rows under #2925/#1165 and keep them
  inside the ES5 completion denominator.

## 2026-08-13 ES5 residual implementation record

### Delivered slice

This increment has two deliberately narrow, independently attributable parts:

1. The legacy host-eval fallback recognizes an *active, unshadowed* raw Test262
   `assert(...)`, `assert.<known method>(...)`, or known bracket-method call by
   parsing the eval text and resolving its receiver in a no-lib checker. It does
   not activate for comments, strings/template text, optional calls, unknown
   members, or a local `assert` binding.
2. IR owns only an ambient, JS-host, proven-string, result-discarded
   `(0, eval)(source);` statement. Collection reserves the existing
   `env.__extern_eval : (externref, i32) -> externref` capability before body
   planning; lowering emits `isDirect = 0` and drops the `externref` result.

Direct eval, a used indirect-eval result, non-proven strings, optional/spread
calls, shadowed `eval`, native-string mode, and standalone remain legacy-owned.

### Exact same-population host A/B

The maintained population is the 120 ES5 `annexB/language/eval-code` rows that
reported `assert is not defined` from same-SHA base
`1fcb363695415ff3a09e338feade66132c93dd50`. Every arm used the same local
harness, file list, host target, timeout, corpus gitlink
`b363f29d3c43c626dc852744ad64a0b48a003693`, and mandatory passing/negative
controls. The ignored per-row records are retained as
`.tmp/issue-1164-{base,runtime,full,killswitch}-host.jsonl`.

| arm | pass | fail | compile error | timeout | skip | runner error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| base | 0 | 120 | 0 | 0 | 0 | 0 |
| raw-assert runtime classifier only | 30 | 90 | 0 | 0 | 0 | 0 |
| full implementation | 30 | 90 | 0 | 0 | 0 | 0 |
| full with `JS2WASM_DISABLE_RAW_TEST262_ASSERT_SHIM=1` | 0 | 120 | 0 | 0 | 0 | 0 |

- Base → runtime-only is exactly **30 fail → pass** and 90 unchanged.
- Runtime-only → full is 120 unchanged: the IR ownership slice does not claim
  an unexplained Test262 gain.
- Full → kill switch is exactly those 30 pass → fail rows; kill-switch → base
  is 120 unchanged.
- The failing negative control and the passing control settled in every chunk.
  This is focused attribution evidence only; the full 9,029-row lane was not
  run and is not claimed here.

### Real standalone zero-loss check

The exact same 120 files were run from clean base and the full implementation
with the real QuickJS evaluator, not a trap stub. Both arms were **120 / 120
pass**, with every one of the 120 rows unchanged and zero entered/left/status
transitions. The retained ignored records are
`.tmp/issue-1164-{base,full}-standalone.jsonl`.

The provider was GitHub Actions run `31660362908`, artifact
`9165959972` (`quickjs-wasi-7f939fdc`), locally verified from
`/private/tmp/js2wasm-quickjs-wasi-7f939fdc`: QuickJS
`954dc53628e36891f93c359aa60895c2ae3dac6b`, wasi-libc
`8d8348ec24253d0638a693b8af82445c13d92d32`, artifact SHA-256
`b0662069c241d0430d91c53a3b0e2d1281fd9eb78dd1c93490b0a9dfa70eec5b`, and
adapter key `1429ec7ecf2163fd`. This proves no targeted standalone regression;
it does not close standalone eval or substitute for its full-lane gate.

### Post-rebase focused validation

The implementation was rebased cleanly onto `origin/main`
`5cbbd881148171595265f06775989d1212573c6b` as implementation commit
`21dcc859a50438785dd23c1e7904f2b22277f592` before this focused validation:

- `pnpm exec vitest run tests/issue-1164-es5-eval-slice.test.ts` — **29 / 29**
  pass, including scope-correct raw-assert controls, host-import inventory,
  and standalone demotion.
- `pnpm exec vitest run tests/issue-1164.test.ts` — **17 / 17** pass for the
  pre-existing dynamic-eval Wasm-module path.
- `pnpm exec vitest run tests/issue-1163.test.ts` — 7 / 8 pass; the unchanged,
  pre-existing `eval()` no-argument fallback returns `0` rather than
  `undefined`. Clean `origin/main` at
  `993a6d9f2c08a2a788eec9c830b8eb6a57a15b64` produces the identical 7 / 8
  result. The only intervening main change is the #671 planning markdown, so
  the tested compiler/runtime tree is unchanged. This slice accepts exactly
  one argument and cannot select that shape.
- `pnpm run typecheck` — pass.
- `pnpm run check:ir-fallbacks` — pass.
- `pnpm run check:ir-adoption` — pass.

These are implementation checks, not a substitute for the deferred 9,029-row
ES5 acceptance lane.

### Exact 90-row residual disposition

All 90 remaining host failures parse cleanly and each contains one outer eval
literal. The classifier resolves all **295** raw `assert` receivers as
unbound harness globals; none is a lexical-shadow false negative. No remaining
row reports `assert is not defined`: each reaches the shim and then fails its
actual Annex B/eval assertion.

- 68 are `direct` rows: 49 function-scope and 19 global-scope. The 49
  function-scope rows remain with
  [#2925](2925-direct-eval-scope-reification-host.md), whose reified caller
  environment is the required direct-eval substrate.
- 22 are indirect global rows, and the 19 direct-global rows also exercise the
  unresolved Annex B declaration/visibility boundary documented in
  [#3633](3633-extern-eval-cannot-see-compiled-module-bindings.md). Its
  resolution explains why assertion visibility is only an unmasking gate;
  these rows now need their actual B.3.3/EvalDeclarationInstantiation
  semantics, not another `assert` heuristic.
- The real-QuickJS standalone comparison has no residual in this 120-row host
  population. It is therefore not evidence to close or broaden
  [#2929](2929-interpreter-direct-eval-with-proxy-mop.md), which owns the
  standalone direct-eval environment model.

The failure signatures are 43 function-scope `assert.throws` assertions, 12
global `assert.throws` assertions, 15 `undefined` expectations, 14 function
expectations, and 6 function-scope `sameValue` assertions. Candidate
`64b8f831151efe4c11f241b2889cc7eedbebd7f7`'s reported +120 is not
reproducible: its raw `"assert."` substring heuristic cannot solve rows that
already reach the shim and fail their semantic assertion.
