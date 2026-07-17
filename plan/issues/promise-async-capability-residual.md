---
id: promise-async-capability-residual
title: "Promise residual: NewPromiseCapability(C) for custom constructors + resolver-element-function object semantics (~163 fails)"
status: blocked
sprint: Backlog
created: 2026-06-17
updated: 2026-06-24
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: promises
goal: spec-completeness
related: [1368, 1382, 1042, 1326, 1116, 2614, 2623, 2637]
routing: senior-dev — fold into the #1042 async epic (shared async-capability machinery, broad blast radius)
reconcile_note: "2026-06-24 (PO reconcile vs upstream/main): FOLDED, NOT dev-claimable. The whole 163-fail residual converges on the NewPromiseCapability(C) async-capability substrate, which was escalated out of the dev lane. The landable combinator slice is #2614 (sdev); the deep substrate tail moved to #2623 → #2637 (Promise executor-body architecture epic, OPEN/unmerged, commit 13a0b7c7b). Gated on that substrate epic. → blocked (was ready)."
origin: "2026-06-17 dev-mech2 investigation of TaskList #28 [STANDING] Promise residual"
---

# Promise residual — async-capability machinery

## TL;DR for the senior-dev / #1042 owner

The remaining `built-ins/Promise` test262 residual is **not a grab-bag**. It
converges on a single area: the host-mode async-capability machinery in
`src/runtime.ts` (the `Promise_all` / `Promise_race` / `Promise_allSettled` /
`Promise_any` factories around `src/runtime.ts:9866-9949`, the `_resolveCtor`
helper, and the synthesized resolve/reject *element* functions). There is no
isolated low-risk plain-dev slice — every bucket touches `NewPromiseCapability(C)`
+ `@@species` + the resolve/reject element-function object protocol. This is why
it was escalated out of the dev lane and folded here.

This is the live residual **after** #1368 (sprint-51 combinator work, `done`) and
#1382 (`done`, the wasm-closure→JS-callable bridge that #1368 was blocked on).
Those landed, but the custom-constructor capability path still fails.

## Baseline (loopdive/js2wasm-baselines `test262-current.jsonl`, 2026-06-17)

163 `built-ins/Promise` fails, dominated by the 4 combinators:

| subdir      | fails |
|-------------|-------|
| allSettled  | 37    |
| all         | 28    |
| any         | 23    |
| race        | 18    |
| prototype   | 13    |
| (resolve/reject/try/keyed/…) | rest |

## Root-cause distribution (probe over 24 real failing combinator files)

1. **"Promise resolve or reject function is not callable"** — *13/24*.
   `Promise.all.call(NotPromise, …)` / `Promise.race.call(SubPromise, …)`.
   V8's `NewPromiseCapability(C)` does `Construct(C, «executor»)` for the
   custom constructor `C`; our combinators delegate straight to host
   `Promise.X.call(C, …)` (`runtime.ts:9931-9949`) and can't drive a
   compiled-class executor protocol, so V8 itself throws. Examples:
   `allSettled/resolve-element-function-{extensible,nonconstructor}.js`,
   `any/capability-executor-called-twice.js`, `any/species-get-error.js`.

2. **"illegal cast"** — *5/24*. Custom-thenable iteration
   (`*/invoke-resolve-on-{values,promises}-every-iteration-of-{custom,promise}.js`,
   `all/resolve-from-same-thenable.js`). The host bridge (`wasmClosureDynamicBridge`,
   `runtime.ts:1856`) casts a non-promise thenable through a promise-typed slot.

3. **ret=2 assertion-fail** — *6/24*. `Promise.race.call(SubPromise, [])` returns
   an instance whose `.constructor` / `instanceof` should be the user subclass
   (`*/ctx-ctor.js`) — species/capability not honoured.

4. **"Function.prototype.bind called on non-callable"** — *2/24*
   (`any/…-every-iteration-of-custom.js`, `race/…-every-iteration-of-custom.js`).

The non-combinator residual (`prototype/then`, `prototype/finally`, `resolve`,
`reject`, `try`, `withResolvers`) is the **same** cause: `ctx-ctor`,
`capability-executor-not-callable`, `species-constructor`, and synthesized
resolve/reject element functions needing the correct observable object shape
(`.length === 1`, `.name === ""`, `isConstructor() === false`, `new fn()` →
TypeError) — e.g. `prototype/finally/invokes-then-with-function.js`.

## Fix direction (senior-scale)

Implement a real `NewPromiseCapability(C)` for non-native `C`:
build the capability executor as a genuine wasm-closure→host-callable pair
(reuse the #1382 bridge), invoke `C`'s executor with callable resolve/reject,
and synthesize the resolve/reject **element** functions as host function objects
carrying the spec object shape. Honour `@@species` for the returned instance so
`Promise.race.call(SubPromise, …) instanceof SubPromise` holds. Standalone mode
needs the Wasm-native equivalent (coordinate with #1326/#1326c microtask work).

## Reproduction harness

A probe that compiles + runs a list of test262 files (reusing the runner's
`wrapTest`/`parseMeta` + `buildImports`) and prints per-file RAN/RUNTIME/COMPILE
classification was used for the bucketing above. Pattern (was at
`.tmp/promise-probe.mts`, gitignored):

```
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { wrapTest, parseMeta } from "../tests/test262-runner.js";
// for each file: wrapTest → compile({skipSemanticDiagnostics:true}) →
//   buildImports(result.imports, undefined, result.stringPool) →
//   WebAssembly.instantiate → instance.exports.test()
```

Run each file in its **own** subprocess — async rejections from the host
bridge (illegal-cast, bucket 2) escape try/catch onto the microtask queue and
kill the process otherwise. Failing-file list derived from the baseline JSONL
filtered to `test/built-ins/Promise` + `status != pass`.

---

## Implementation log (sdev-async2, 2026-06-18) — PR-A: executor invocation

Re-validated on upstream/main @ 916169c87 (after #2026 PR-1b landed). The
*first* concrete bug is narrower and more fundamental than the
NewPromiseCapability framing: **the inline `new Promise(executor)` executor was
never invoked at all** — independent of custom constructors / combinators.

### Root cause (precise)

`isHostCallbackArgument` (`src/codegen/closures.ts`) has a `NewExpression` arm
that returns `true` for any constructor argument whose callee is not a
user-defined class. So `new Promise((resolve, reject) => …)` routed its executor
through the `__make_callback` host-callback path. For an **inline** executor
that path emitted no `__call_fn_*` closure dispatcher export, so the host
`Promise_new` import (`new Promise(_maybeWrapCallable(executor, 2, …))`) could
not turn the wasm closure into a JS-callable — `_maybeWrapCallable` returned the
raw struct, the executor was never called, and `resolve`/`reject` were
`undefined`. This is the "executor param stripped + invocation elided" symptom.

Proof: the **pre-assigned** form (`const exec = …; new Promise(exec)`) already
worked, because the arrow is compiled as a first-class closure at the
*assignment* site (parent is a VariableDeclaration, not the NewExpression),
which emits `__call_fn_2`. Bucketed via probes:
`new Promise(inlineArrow)` → no `__call_fn`/`__is_closure` exports, executor
not invoked; `const e=…; new Promise(e)` → exports present, executor invoked
(captured write visible).

### Fix (PR-A — shipped)

In `isHostCallbackArgument`, return `false` for the `Promise` constructor so the
executor compiles as a first-class **closure** (same working path as the
assigned form). The host `Promise_new` then wraps it via `__call_fn_2`. Now:
executor invoked synchronously, captures mutate, `resolve`/`reject` are real
callable functions, `new Promise(...)` returns a genuine object. Tests:
`tests/issue-28-promise-executor-invocation.test.ts` (6 cases). No regression in
`promise-combinators` (its 2 pre-existing `Compile failed` cases fail identically
with/without this change — a worktree-harness artifact, not this fix).

### Out of scope / follow-ups (still open under this issue / #1042 / #1326)

- **await-resumption / microtask settling.** `resolve(v)` settles the host JS
  Promise, but a compiled `await p` does not yet resume from it (the async
  state-machine ↔ host-microtask wiring is #1042/#1326). PR-A fixes the
  *synchronous* executor protocol only.
- **Named inline executor** (`new Promise(function exec(resolve){…})`) still
  fails ("Promise resolver [object Object] is not a function") — a *named*
  function-expression is registered as a named func, not a first-class closure,
  so it skips the `__call_fn` path. Anonymous fn-expr and arrow both work.
  Narrow follow-up, separate from the closure-routing fix.
- **Standalone (`--target wasi`/`standalone`)** still emits the allowlisted
  `env.Promise_new` host import — `new Promise` is not yet pure-Wasm (that is the
  #1326 microtask-queue work). PR-A compiles in standalone (executor is now a
  proper closure) but a true no-host runtime needs the Wasm-native Promise.
- **NewPromiseCapability(C) for custom constructors + resolver-element-function
  object semantics** (the original ~163-fail combinator residual) — unchanged by
  PR-A; remains the senior-scale body of this issue.
