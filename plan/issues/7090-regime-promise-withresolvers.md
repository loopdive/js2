---
id: 7090
title: "Regime gap: `Promise.withResolvers()` has no native implementation (refused on gc, standalone and WASI)"
status: done
completed: 2026-10-19
assignee: ttraenkler/opus-7090-withresolvers
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: Promise
goal: architecture
sprint: current
parent: 5385
related: [6979, 7089]
loc-budget-allow:
  # 2026-10-19 (#7090): the 3-line routing call into the native provider; the
  # semantics live in src/codegen/promise/ + src/runtime/wasmgc/promise/
  - src/codegen/expressions/call-namespace-static.ts
func-budget-allow:
  # 2026-10-19 (#7090): same routing call, inside the namespace-static dispatcher
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
import-cycles-allow:
  - largestSccSize: 717 # 2026-10-19 (#7090): codegen/promise/with-resolvers.ts joins the codegen SCC (called from call-namespace-static.ts, uses async-scheduler/object-runtime/shared.js compileExpression like promise-executor.ts); the pure body builder runtime/wasmgc/promise/with-resolvers-bodies.ts stays outside it
---

# #7090 — `Promise.withResolvers()` on the native regime

Found by the S7-c slice of #6979 (2026-10-16, branch
`issue-6979-s7c-collapse-standalone-arms`, WASI flip verdict): after WASI
moved onto the native regime, test262 `built-ins/Promise/withResolvers/
promise.js` fails on every WasmGC lane because the regime refuses
`Promise.withResolvers()`. The old WASI lowering produced a binary with no
`withResolvers` at all (it silently compiled the call away), so this is a
pre-existing hole that the flip made visible, not a regression of a passing
row. It is the only GAP the S7-c directory folds found.

## Plan

1. Measure: which refusal diagnostic fires, on which lanes (default gc,
   native-first, standalone, WASI), and which test262 rows under
   `built-ins/Promise/withResolvers/` pass/fail before the fix (standalone
   lane, `TEST262_PATH_FILTER=built-ins/Promise/withResolvers/`).
2. Implement on the native promise provider: `withResolvers` = create a
   pending native promise, return a plain object `{ promise, resolve, reject }`
   whose `resolve`/`reject` are the capability functions (same machinery as
   `new Promise(executor)` without running an executor). The `.call(Sub)`
   subclass form is #7089's scope; here `this === %Promise%` only, with a
   TypeError for a non-constructor `this` per spec step 1.
3. Tests: a focused test under native-first (JS environment) and standalone
   comparing with Node; the test262 subset count before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; direct-AST freeze respected (provider/runtime code only).

## Measurements (2026-10-19)

Probe: `const { promise, resolve, reject } = Promise.withResolvers(); resolve(1); await promise;`
compiled per lane (`.js`, `skipSemanticDiagnostics`).

| Lane | Before | After |
| --- | --- | --- |
| default (`gc`, native-first since #6708) | CE `'__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 Phase B)` | compiles, runs, `1` |
| `semanticProviders: "native-first"` | same CE | compiles, runs, `1` (JS environment, matches Node) |
| `host-assisted` | compiles (host `Promise`) | unchanged |
| `--target standalone` | same CE + `env.__get_builtin` leak warning | compiles, zero imports, runs, `1` |
| `--target wasi` | compiles with a warning (`Host import "env.__get_builtin" requested under --no-host-imports / WASI strict mode`) and the call stubbed out of `main` | compiles, no warning, only `wasi_snapshot_preview1` imports, calls `__promise_with_resolvers` |

test262 `TEST262_PATH_FILTER=built-ins/Promise/withResolvers/`, `TEST262_WORKERS=2`,
`JS2WASM_EVAL_ENGINE=interpreter`, local honest lane (6 rows):

| Lane | Before | After |
| --- | --- | --- |
| standalone | 2 pass (`ctx-non-ctor`, `ctx-non-object`); `promise`/`resolvers`/`result` CE (`__get_builtin`); `ctx-ctor` fail | 4 pass (+`resolvers`, +`result`); `promise` fail; `ctx-ctor` fail |
| gc (semantic providers `auto`) | 2 pass, 3 CE, 1 fail (same rows) | 4 pass, `promise` fail, `ctx-ctor` fail |

## Implementation notes

- **Owner.** `Promise.withResolvers` is a `%Promise%` intrinsic, so it lives in
  the native promise provider, not in the direct-AST emitters
  (plan/method/ir-only-development-freeze.md). The body is a pure builder,
  `src/runtime/wasmgc/promise/with-resolvers-bodies.ts`, next to the other
  `$Promise` runtime bodies. `src/codegen/promise/with-resolvers.ts` registers
  it once per module as `__promise_with_resolvers() -> externref`, after every
  dependency (settle closures, object runtime, key strings) is registered.
- **Why it is the `new Promise(executor)` capability.** For `C = %Promise%`,
  NewPromiseCapability is exactly what the native executor lowering
  (`promise-executor.ts`) builds before it runs the executor: a pending
  `$Promise`, one shared resolving-pair latch, and the two
  `$__promise_settle_cap` closures from `ensurePromiseExecutorClosures`. The
  new function reuses those pieces (`buildPromiseSettleClosureValue`), so
  `resolve`/`reject` are the same §27.2.1.3 function objects (`length` 1,
  `name` ""), and "only the first settlement counts" holds through the shared
  latch. No executor runs.
- **Result object.** `__new_plain_object` + `__extern_set` in spec order
  `promise`, `resolve`, `reject`: an ordinary object with writable,
  enumerable, configurable data properties (`result.js` passes). This is the
  same construction the native `allSettled` status objects use.
- **Call site.** The only direct-AST change is a 3-line routing call at the top
  of the Promise block in `compileNamespaceStaticCall`. The provider decides:
  it claims `Promise.withResolvers(...)` only when the native carrier is on
  (`isStandalonePromiseActive`) and the receiver (through parentheses / `as` /
  `!`) is the ambient `Promise`. Arguments are evaluated and dropped. A spread
  argument declines to the old path.
- **Non-constructor `this`.** `withResolvers` joins the statically-proven
  IsConstructor TypeError arm in `promise-static-call-typeerror.ts`
  (`Promise.withResolvers.call(86 | "s" | true | Symbol() | eval)`). Those two
  rows already passed before, through the generic "not yet implemented"
  TypeError of the value closure; the arm keeps them passing on a real
  IsConstructor throw.

## Left out (and why)

- **Subclass receivers — #7089.** `Promise.withResolvers.call(SubPromise)`
  (`ctx-ctor.js`) needs NewPromiseCapability through a user constructor. It
  still reaches the first-class value closure, which throws the generic
  "not yet implemented" TypeError. The value closure was deliberately not given
  a body: it has no `this` in its ABI, so a body would wrongly succeed for
  `const f = Promise.withResolvers; f()` (spec: TypeError, `this` undefined)
  and for `.call(Sub)`.
- **`promise.js` still fails, for a reason that is not withResolvers.** It now
  compiles and fails on `instance.promise.constructor` reading `undefined`.
  The same read answers `undefined` for `(new Promise(() => {}) as any)
  .constructor` before and after this change: the `$Promise` arm of
  `__extern_get` (`promise-dynamic-member-read.ts`) answers only
  `then`/`catch`/`finally`, not the inherited `%Promise.prototype%.constructor`.
  That is a separate dynamic-member gap; it needs its own issue.
- **Pre-existing standalone await ordering.** On `--target standalone` a
  `.then` reaction registered before an `await` of the same promise does not
  run before the `await` resumes (13 instead of 123). It reproduces identically
  with `Promise.resolve(0)` and `new Promise(r => …)`, so the focused test
  checks that ordering in the JS environment only.

## Test

`tests/issue-7090-regime-promise-withresolvers.test.ts` — 16 cases: resolve,
reject, first-settlement-wins, a chained `then`, result shape (keys in order,
`instanceof Promise`, `typeof`/`length` of the functions), fresh capability per
call, and the non-constructor TypeError, each on native-first (JS environment,
compared with Node) and standalone (zero imports, compared with Node); the
ordering case on native-first; WASI and default-lane compiles.
