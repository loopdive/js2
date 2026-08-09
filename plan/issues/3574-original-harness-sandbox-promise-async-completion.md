---
id: 3574
title: "js2-test262 (originalHarness mode): async completion never observed for real Promise/await tests — likely cross-realm Promise identity from the vm.createContext sandbox"
status: ready
sprint: current
created: 2026-07-17
priority: high
feasibility: medium
model: opus
horizon: m
reasoning_effort: high
task_type: bugfix
area: test-infrastructure, runtime
language_feature: promises, async-await
goal: test262-conformance
related: [3284, 3285, 3349]
---

# #3574 — `originalHarness` sandbox's async-completion detection never fires for real Promise timing

## Context

Found while switching [test262.fyi](https://test262.fyi)'s js2wasm integration
from a hand-rolled compile+instantiate harness (this project's own
`compile()`/`WebAssembly.instantiate` API) to the npm-shipped `js2-test262`
CLI (`dist/test262-fyi-cli.js`, backed by `dist/test262-worker.js`) — the
purpose-built executor this project ships specifically for running the real,
unmodified `test262/harness/*.js` files (see #3284/#3285/#3349 for that
broader context). It's a clear upgrade over the hand-rolled approach for most
cases (proper fixture-graph resolution, real negative phase/type
verification instead of string-matching) — but async-flagged tests reliably
fail to signal completion through it.

## Repro

Minimal case, run via the shipped `js2-test262` bin directly (no test262
checkout content needed beyond the file itself):

```js
// trivial-async.js2wasm
function print(x) {
  console.log(x);
}
/*---
flags: [async]
---*/
function $DONE(err) {
  if (err) print("Test262:AsyncTestFailure:" + err);
  else print("Test262:AsyncTestComplete");
}
Promise.resolve(42).then(function (v) {
  $DONE();
}, $DONE);
```

```
$ js2-test262 --target gc --test262-root ./test262 --engine-suffix js2wasm trivial-async.js2wasm
async completion marker not observed
$ echo $?
1
```

**A synchronous, immediate `$DONE()` call (no Promise involved) works
correctly** through the exact same CLI invocation — confirming the
`print`/`console.log`-interception plumbing itself (`consoleProxy` →
`appendHarnessOutput` → the worker's marker-search loop) is fine in general:

```js
// same file, but $DONE() called immediately, no Promise
function $DONE(err) {
  /* ... */
}
$DONE(); // -> exits 0, "Test262:AsyncTestComplete" observed correctly
```

The failure is specific to completion signaled from inside a `.then()`
callback (confirmed with both plain `Promise.resolve().then()` and a real
`async function` + `await` + `.then()`), i.e., anything requiring the
compiled code's promise machinery to actually run a microtask before
`$DONE()` fires.

## Where this diverges from the already-fixed #3284 RC2

#3284 RC2 fixed a related-sounding "`Promise.then()` callback never fires"
issue by wiring `__setExports`/`deferToExports` in `src/runtime.ts`'s
`callback_maker` host bridge. **That fix is not the gap here** — I confirmed
`dist/test262-worker.js` already calls the exports-wiring hook correctly:

```js
if (typeof importObj.setExports === "function") {
  importObj.setExports(instance.exports);
}
```

and independently verified `buildImports(...).setExports` is a real,
present function on the object `dist/runtime.js`'s `buildImports` returns
(checked directly: `Object.keys(buildImports(...))` includes `'setExports'`).
So the RC2 wiring is present and correct in this path — this is a second,
different gap.

## Root-cause hypothesis: cross-realm `Promise` from the harness sandbox

`buildOriginalHarnessSandbox` (`dist/test262-worker.js`) creates a genuine,
separate `node:vm` context for `originalHarness` mode:

```js
function buildOriginalHarnessSandbox(consoleProxy) {
  const sandbox = Object.create(null);
  const context = createContext(sandbox);
  for (const name of ORIGINAL_HARNESS_SANDBOX_GLOBALS) {
    try { sandbox[name] = runInContext(name, context); } catch {}
  }
  ...
}
```

`ORIGINAL_HARNESS_SANDBOX_GLOBALS` (= `SANDBOX_GLOBAL_NAMES`) **includes
`"Promise"`** alongside `Array`/`Object`/`Map`/etc. This sandbox is then
passed into `buildImports(..., { globalSandbox: harnessSandbox })` for
`originalHarness` runs. That means compiled test code's `Promise` resolves
to the **sandboxed `vm.Context`'s own `Promise` constructor** — a distinct
realm from the worker process's real, outer `Promise` — while the
async-completion detector itself polls using the **worker's own native
Promise/timer** (`await new Promise(r => setTimeout(r, 10))` in the
`findMarker` polling loop).

My working hypothesis (not fully root-caused — this needs someone with
direct visibility into `resolveImport`'s `Promise_then`/`Promise_resolve`
bridge functions in `src/runtime.ts` to confirm precisely, since it's a
cross-realm identity question I can observe the symptom of but can't fully
trace through minified/bundled dist code): the compiler's `Promise_then`/
`Promise_resolve`/`Promise_new` runtime bridges
(`src/runtime.ts`, e.g. `if (name === "Promise_resolve") return (val) =>
Promise.resolve(val);`) close over whichever `Promise` is lexically visible
at the point those bridge functions are constructed — likely the runtime
module's own native (outer-realm) `Promise` — while other parts of the
pipeline (TypeScript's own type resolution of the global `Promise` type, or
any `instanceof Promise`/`typeof x.then === 'function'` identity check done
against the _sandboxed_ constructor) may resolve to the **sandbox's**
`Promise` instead. A cross-realm mismatch there (native `Promise` instance
vs. sandboxed `Promise` constructor reference) is a well-known way for
promise-shaped dispatch logic to silently stop matching without throwing —
consistent with the symptom here: no error is raised, no unhandled
rejection, the callback just never observably fires within the 1-second
polling deadline.

## Blast radius

```
grep -rl "flags:.*async\|^\s*- async" test262/test/ | wc -l
5616
```

**5,616 of 53,406 test262 files (10.5%) carry the `async` flag.** If this
gap is as broad as the minimal repro suggests (both plain `.then()` and
`async function`/`await` chains affected), essentially all of them would
currently fail through `js2-test262`'s `originalHarness` path regardless of
whether the underlying async logic being tested is otherwise correct —
comparable in scale to #3349's `propertyHelper.js` finding.

## Suggested approach

1. Confirm precisely whether `Promise` (and by extension `.then` identity)
   crosses the sandbox boundary inconsistently — instrument
   `buildOriginalHarnessSandbox`'s `sandbox.Promise` vs. the outer
   `globalThis.Promise` the worker itself runs under, and check whether the
   compiled test's `Promise.resolve(...)` return value is `instanceof` the
   _sandbox's_ `Promise` or the _outer_ one.
2. If confirmed, the likely fix is making the compiled code's promise
   identity consistent with whichever `Promise` the worker's own
   `findMarker` polling loop (and Node's real microtask queue) actually
   drains against — either by not sandboxing `Promise` at all (real
   `Promise` semantics don't meaningfully differ per-realm the way,
   say, poisoned-prototype isolation for `Array`/`Object` does — the
   sandboxing of `Promise` specifically may not have been a deliberate
   choice so much as an artifact of including it in the same blanket
   `SANDBOX_GLOBAL_NAMES` list as everything else), or by ensuring the
   `Promise_then`/`Promise_resolve`/etc. bridge functions explicitly use
   `harnessSandbox.Promise` when `originalHarness` mode is active.
3. Re-run the minimal repro above and a representative sample of the 5,616
   async-flagged test262 files once changed.

## Acceptance criteria

- The minimal repro above (plain `Promise.resolve().then($DONE)`) passes
  through `js2-test262 --target gc`.
- A real `async function` + `await` + `.then()` chain (the second repro
  variant) also passes.
- A representative sample of async-flagged test262 files run through
  `js2-test262` shows a material pass-rate jump for that category
  specifically, not just the synthetic repros.
- No regression in the already-passing synchronous `$DONE()` case.

## Implementation Plan (Fable, 2026-07-25)

### Measured scoping — the CI baseline is NOT affected; this is a CLI-lane bug

Joined the 2026-07-24 baseline JSONL (47,858 rows) against test262
metadata (all 5,473 async-flagged rows in the run set):

| async-flagged rows (CI baseline, gc lane)         | count     |
| ------------------------------------------------- | --------- |
| pass                                              | **2,735** |
| fail                                              | 2,527     |
| — of which `async completion marker not observed` | **59**    |
| compile_error / compile_timeout / skip            | 211       |

So the sharded-CI worker (`scripts/test262-worker.mjs`) observes async
completion fine — 2,735 real async passes, and only 59 "marker not
observed" rows. Those 59 are **deterministic** (2/2 sampled reproduce
byte-identically through `runTest262File` on an idle box:
`built-ins/Promise/race/resolve-non-callable.js`,
`built-ins/Promise/race/iter-returns-false-reject.js`) and cluster on
rejection paths (`Promise/race` 19, `for-await-of` 9, `top-level-await` 5)
— genuine promise-machinery gaps where the reject continuation never runs
`$DONE`, not harness artifacts.

**Consequence for this issue:** the "blast radius: 5,616 async files"
estimate holds only for the **npm-shipped `js2-test262` CLI /
test262.fyi lane** (`dist/test262-worker.js`), NOT for the CI conformance
numbers. The divergence between the two lanes (CI worker observes markers;
CLI does not) is itself the strongest root-cause clue: diff what
`dist/test262-worker.js` does differently from `scripts/test262-worker.mjs`
around the sandbox + `setExports` + marker-poll sequence.

### Plan

1. **Bisect the lane divergence, not the symptom.** Both lanes build a
   `vm.createContext` sandbox including `Promise` and poll
   `harnessOutput` for the marker with host timers. The CI lane works, so
   "sandboxed Promise is cross-realm" cannot alone be the mechanism.
   Instrument the CLI worker (`src/test262-worker.ts`, the source of
   `dist/test262-worker.js`) with the trivial repro from this issue and log:
   (a) does `__module_init` run? (b) does `Promise_resolve`'s bridge get
   called? (c) does the `.then` callback fire (add a counter in
   `callback_maker`)? (d) does `consoleProxy.log` receive the marker but
   the poll loop miss it (output-array identity)?
2. **Compare the exact `buildImports` call** in both workers: options
   object, `setExports` timing relative to `__module_init`, and whether the
   CLI lane calls `__module_init` at all under `deferTopLevelInit` (the CI
   worker's #3049 C1 arm). A CLI that still relies on the `(start)` section
   while `compile()` now defers top-level init would produce exactly
   "sync $DONE works, microtask-dependent $DONE never fires" if the drain
   ordering differs.
3. Fix in the CLI worker (or `src/runtime.ts` bridge if (b)/(c) localize it
   there), keeping the CI worker byte-identical.
4. Regression test at the CLI level: extend
   `tests/test262-fyi-runner.test.ts` (or `tests/issue-3574.test.ts`) with
   the trivial `Promise.resolve().then($DONE)` repro run through the
   shipped worker entry, plus the sync-`$DONE` control.
5. Re-verify the 59 CI-lane "marker not observed" rows are untouched
   (they are genuine rejection-path gaps — file/keep them under a separate
   promise-machinery issue if this fix doesn't move them; do NOT count them
   toward this issue's acceptance).
