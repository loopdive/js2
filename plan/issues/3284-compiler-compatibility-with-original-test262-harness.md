---
id: 3284
title: "Make the compiler compatible with the original (unmodified) test262 harness — assert.js property-call dispatch + Promise.then microtask gap"
status: in-progress
assignee: ttraenkler/sendev-3256
sprint: current
created: 2026-07-15
priority: high
feasibility: hard
model: opus
horizon: xl
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: promises, prototype-methods
goal: test262-conformance
related: [3285]
# Intentional +20 LOC in the host import-resolver: the RC2 `deferToExports`
# guard added to the `callback_maker` case of `resolveImport` mirrors the
# adjacent `getter_callback_maker` (#2128) host-glue bridge — extracting 20
# host-local lines into a subsystem module would balloon a deliberately-minimal
# bugfix. Grants THIS change-set the god-file growth (#3131).
loc-budget-allow:
  - src/runtime.ts
---

> **2026-07-15 — root cause DIAGNOSED. RC2 FIXED; RC1 fix DEFERRED to a next window (senior-dev).**
> The verify-first trace (below, `## Diagnosis (2026-07-15)`) refuted the original
> hypothesis: this is NOT a call-target type-inference bug. **Both** RC1 and RC2
> collapse to a single root cause — top-level code runs in the wasm `(start)`
> section, which executes _during_ `WebAssembly.instantiate`, **before** the host
> can wire `setExports(instance.exports)`; the host closure-wrap/dispatch glue
> then has no exports to work with. Standalone mode already dispatches RC1
> natively and is unaffected (it is the reference implementation for the fix).
>
> **RC2 (`Promise.then`) is FIXED** by the small, additive `deferToExports`
> change in the `callback_maker` host bridge (`src/runtime.ts`) — a top-level
> `.then` callback whose microtask drains before `setExports` is now parked and
> replayed the moment the instance is wired (mirrors the #2128 setter fix). See
> the RC2 sub-fix note in `## Diagnosis`.
>
> **RC1 remains a next-window big-rock.** Its real fix is broad-impact host-mode
> codegen (option A below), validatable only on `merge_group` — too large for the
> budget tail it was found in, so it is banked here (horizon xl). Do NOT attempt the
> `deferTopLevelInit`/init-contract route (option B) — it breaks the very
> external raw-`(start)` harness this issue is about.

# #3284 — compiler compatibility with the real, unmodified test262 harness

## Context

Our own test262 conformance number (JS-host: 76.6%) is measured through
`tests/test262-runner.ts`'s `wrapTest()`/`buildPreamble()`: the real upstream
`test262/harness/*.js` files (`assert.js`, `sta.js`, `compareArray.js`, etc.)
are **never used** — a hand-written synthetic TypeScript preamble replaces
them entirely, and every test body is mechanically rewritten (renamed assert
calls, stripped arguments, etc.) before compilation. See #3285 for the
correctness issues that rewrite introduces.

Independently, [test262.fyi](https://test262.fyi) (an external, third-party
conformance tracker for many JS engines) added a js2wasm integration that
compiles each test file with the **literal, unmodified upstream harness**
(`assert.js` + `sta.js` + `includes` concatenated verbatim ahead of the raw
test body — the same thing every other engine on that site gets), using our
public `compile()` API with `target: 'gc'`. That run measured **3,996 / 53,406
(7.48%)** — dramatically lower than our own 76.6%, because it hits compiler
bugs our rewrite pipeline was specifically built to route around.

This issue is about closing that gap **in the compiler**, not in the harness:
raw, un-rewritten test262 harness files should compile and run correctly.
That's a meaningfully different (and arguably more important) bar than "the
custom preamble scores well" — it's also what any other external tool,
sandbox, or user compiling ordinary code that happens to use these same
patterns will hit.

## Two confirmed root causes

Both were isolated directly against a freshly built `compiler-bundle.mjs`
(`esbuild src/index.ts --bundle --platform=node --format=cjs`, no other
scaffolding), independent of any test262-fyi-specific wrapping choices — so
these are compiler bugs, not artifacts of how that harness invokes us.

### 1. Calling a function assigned as a property after declaration fails

`assert.js`'s actual, real implementation shape is:

```js
function assert(mustBeTrue, message) {
  /* ... */
}
assert.sameValue = function (actual, expected, message) {
  /* ... */
};
assert.notSameValue = function (actual, expected, message) {
  /* ... */
};
assert.throws = function (expectedErrorConstructor, func, message) {
  /* ... */
};
```

i.e. `assert` is declared as a function, then given callable properties via
plain assignment afterward — the single most common pattern in the entire
harness. Minimal repro (target: `gc`). **[CORRECTED: the "same result either
way" claim is wrong — it reproduces ONLY at top-level; inside a wrapped
`export function test() {}` called after `setExports` it WORKS. See
`## Diagnosis`.]**

```js
function assert(mustBeTrue, message) {
  if (mustBeTrue === true) return;
  throw new Error("assert failed: " + message);
}
assert.sameValue = function (actual, expected, message) {
  if (actual === expected) return;
  throw new Error("sameValue failed: " + message);
};
console.log(typeof assert.sameValue); // prints "function" — property read + typeof are fine
assert.sameValue(1, 1, "should be equal"); // throws TypeError: sameValue is not a function
```

**[CORRECTED 2026-07-15 — this hypothesis was wrong; see `## Diagnosis`.]** The
original guess below (call-target type inference) is NOT the cause. The call
codegen is correct — the identical call works inside a post-`setExports`
`export function test(){…}`. The real cause is exports-timing during the wasm
`(start)` section (see the Diagnosis section). Original text kept for history:

> `typeof assert.sameValue` correctly reports `"function"` immediately before
> the failing call — so the property is stored and readable, but the compiled
> **call site** doesn't resolve/dispatch it as callable. Likely somewhere in
> how call-target type inference handles a property added to a function object
> after its declaration (as opposed to a method defined inline in an object
> literal, or a property known statically at the declaration site) — worth
> comparing against how `compileCallExpression`/`compileReceiverMethodCall`
> (see #3282's LOC table) resolve the callee's type for this exact shape.

This alone blocks the overwhelming majority of raw test262: `assert.js` is
concatenated ahead of nearly every test file test262-wide.

### 2. `Promise.prototype.then()` callbacks never fire

```js
console.log("before promise");
Promise.resolve(42).then(function (v) {
  console.log("in then, v=", v); // never printed — confirmed with an explicit
  // 500ms setTimeout wait afterward, not just
  // "hasn't happened yet by the next line"
});
console.log("after promise setup");
```

`src/runtime.ts` bridges `Promise_then`/`Promise_new`/`Promise_resolve` etc.
to the real host `Promise` (see the `Promise_then` case: `p.then(_maybeWrapCallable(cb, 1, callbackState))`
where `p` is a genuine native `Promise`), so in principle this should Just
Work via Node's own microtask queue — but the callback provably never runs,
even after the compiled function that scheduled it has returned and control
is back in plain host JS with time to spare. This breaks:

- the standard test262 async-test convention (`doneprintHandle.js`'s
  `$DONE`/`print('Test262:AsyncTestComplete')`, driven by a `.then()`/`.catch()`
  chain, not `async`/`await`)
- any real-world code using `.then()`-chained Promises rather than
  `async`/`await` (README lists async/await as "Solid" but doesn't
  distinguish `.then()` chaining — this suggests the CPS/state-machine path
  for `async function` works while the general `Promise.prototype.then`
  entry point does not, which is a narrower, more diagnosable bug than "async
  is broken").

Confirm this is specifically about _host-visible_ callback firing, not about
`.then()` being unimplemented — the promise itself resolves fine (no error,
no unhandled rejection surfaces either) and `#test262-worker.mjs`'s own
`testFn()` invocation model calls the wrapped test **synchronously and
expects a synchronous return value** (`const ret = testFn();` — see #3285),
so it's plausible our internal harness has simply never exercised this path
naturally, and the gap has been invisible internally.

## Why this matters beyond test262.fyi's number

Both patterns above are not test262 idiosyncrasies — "assign a method to a
function after declaring it" and "resolve a promise chain with `.then()`"
are extremely common, unremarkable JavaScript. A compiler that silently
produces wrong behavior for either (no compile error, no runtime error in
case 1 until the exact call site; complete silence in case 2) is a
correctness gap independent of any test-harness framing.

## Suggested approach

1. Reproduce both minimal cases above directly (no test262 needed) and get a
   WAT/codegen diff between "property assigned inline in an object literal"
   (works, presumably) vs. "property assigned via `obj.prop = fn` after
   declaration" (broken) for case 1.
2. For case 2, trace whether `Promise.resolve(x).then(cb)` written directly
   in source actually lowers to the `Promise_then` host import at all, or
   takes a different (GC-native, non-host) codegen path that never reaches
   `src/runtime.ts`'s bridge — the discrepancy between "the bridge looks
   correct" and "the callback never fires" suggests the compiled call site
   isn't reaching that import.
3. Once both are fixed, re-run the raw-harness case (unmodified
   `test262/harness/assert.js` + `sta.js`, no `wrapTest` rewriting) locally
   and measure the delta — this issue's acceptance bar is a large jump in
   that specific (non-rewritten) pass rate, not the existing rewritten-harness
   number.

## Acceptance criteria

- Both minimal repros above pass (no thrown error, `"in then, v= 42"` prints).
- The real, unmodified `test262/harness/assert.js` + `sta.js`, concatenated
  ahead of a test body with zero `wrapTest`-style rewriting, compiles and
  scores correctly for a representative batch of currently-failing-for-this-
  reason test262 files.
- No regression in the existing rewritten-harness JS-host pass rate.

## Diagnosis (2026-07-15, senior-dev)

Verified directly against `origin/main` (@ `9013d0b8`) by building a clean
`compile()` + `buildImports()` + `instantiateWasm()` driver with host-side
tracing (all repros compiled `target: 'gc'`).

### Both root causes are ONE bug: top-level `(start)` runs before `setExports`

Every top-level statement is compiled into the wasm `(start)` /
`__module_init` function (see `src/codegen/declarations.ts` ~L2279–2336). The
wasm `start` section runs **inside** `WebAssembly.instantiate`, so it executes
**before** the host can call `setExports(instance.exports)` (you cannot obtain
`instance.exports` until `instantiate` returns). During `(start)`, the host
runtime's `callbackState.getExports()` returns `undefined`, which disables
every exports-backed capability — including wrapping/dispatching Wasm closures
(needs the module's `__is_closure` / `__call_fn_*` exports).

The custom test262 preamble hides this because `wrapTest()` moves the whole
test body into an `export function test(){…}` the runner calls **after**
`setExports` (`tests/test262-runner.ts` L4104-4112). The raw upstream harness
runs `assert.js` etc. as real top-level code → `(start)` → the bug.

#### RC1 — `assert.sameValue(1,1)` ("… is not a function")

- The store `assert.sameValue = fn` and the call `assert.sameValue(1,1)` are
  **both** top-level → both run in `(start)` with `exportsWired=false`
  (confirmed by tracing `!!callbackState.getExports()` at the
  `__extern_method_call` entry).
- At store time, `__extern_set_strict` → `_maybeWrapCallableUnknownArity(val)`
  bails (no exports) and stores the **raw** `__fn_wrap_N` GC struct in the
  sidecar — traced as `val=(function, isWasm=true)` [raw struct] at top-level
  vs `(function, isWasm=false)` [real JS fn] when the same code is wrapped in a
  post-`setExports` `test()`.
- At call time, the host receiver is wrapped as a plain host `Proxy`
  (`isWasm=false`, not a function), its get-trap returns the raw `__fn_wrap`
  struct un-wrapped, `typeof fn !== "function"`, the `#1712` callable-closure
  arm is skipped (receiver is not a JS function), and dispatch falls through to
  `throw new TypeError(method + " is not a function")`.
- **Same code inside `export function test(){…}` (host-called after
  `setExports`) works perfectly** — proving the call codegen is correct; the
  only variable is exports-timing.
- **STANDALONE mode (`target:'standalone'`, stub `env`) dispatches the SAME
  repro correctly** — it uses the wasm-native object-runtime (`struct.get`
  funcref + `call_ref`, no host round-trip, no exports dependency) and runs via
  `(start)` with no problem. So the bug is **host-mode only**, and standalone is
  the reference implementation for the fix.

#### RC2 — `Promise.resolve(42).then(cb)` callback never fires

- The source DOES lower to the host bridge — imports include `Promise_resolve`,
  `Promise_then`, and `__make_callback` (so the issue's "does it even reach the
  bridge?" question is answered: yes, it reaches `src/runtime.ts`'s
  `Promise_then`). The callback is wrapped via
  `_maybeWrapCallable(cb, arity, callbackState)`.
- Exact lowering: `.then(cb)` compiles to `__make_callback(cbId, caps)` (a
  `callback_maker` host bridge that returns a JS function dispatching
  `exports.__cb_<id>`), which is passed to `Promise_then`. The
  `callback_maker` bridge ALREADY resolves `getExports()` lazily at fire time —
  so a naive "lazy wrap" is already in place and is NOT enough.
- **Precise timing (the subtlety):** the `.then` microtask does NOT wait until
  `setExports`. It drains while the async instantiate helper is still
  `await`-ing `WebAssembly.instantiate(...)` — i.e. AFTER `(start)` returns but
  BEFORE the caller's `setExports` line. So at fire time `getExports()` is STILL
  `undefined`, `exports.__cb_<id>` is missing, and the callback silently
  no-ops. Confirmed by tracing `exportsWired=false` at the `__cb` fire, printed
  before the driver's post-`setExports` marker.
- **FIX (landed in this issue's RC2 PR):** when the `callback_maker` callback
  fires with exports not yet wired, **park it via `deferToExports`** and replay
  it the instant `setExports` wires the instance — the exact #2128 mechanism
  used for `getter_callback_maker` setters. Additive: a callback whose reaction
  fires AFTER `setExports` (every `wrapTest`/equivalence body runs inside an
  exported function the host calls post-wiring) never hits the new branch, so no
  harness-executed callback changes. Verified: RC2 repro + top-level `async fn`
  `.then` both fire; 83 async/promise equivalence tests still green. (Baseline
  check: `new Promise(exec).then()` and chained `.then` producing data were
  ALREADY broken at top-level on main — not regressions; the deferred replay
  fires the callbacks, though a value-carrying top-level `.then` chain can still
  deliver a wrong chained value pre-wiring — an acceptable strict improvement
  over "silent", and never hit by the post-`setExports` harness path.)

### Fix options

- **(A) — THE fix for RC1 (next-window big-rock).** Make host-mode
  function-object member get/call dispatch **wasm-native**, the way standalone
  already does (route dynamic props on function-objects through the native
  object-runtime, or give function-objects a struct shape carrying assigned
  callable fields → `struct.get` funcref + `call_ref`). Works inside `(start)`,
  host+standalone uniform, and keeps EXTERNAL raw-`(start)` harnesses
  (test262.fyi) working with zero host cooperation. Broad-impact host-mode
  member-dispatch codegen; validatable only on `merge_group`
  (standalone-floor + full-CI). Horizon xl. Standalone is the reference.
- **(B) — REJECTED, do not re-propose.** Mode-aware `deferTopLevelInit`
  (export `__module_init`, drop the `(start)` section, host calls it after
  `setExports`; the mechanism already exists for the diff-test harness, #2796).
  It makes OUR repro pass but **breaks the motivating scenario**: test262.fyi
  uses raw `WebAssembly.instantiate` + `(start)` and does NOT call
  `__module_init`, so ALL top-level code — including currently-passing simple
  tests — would stop running (~7.48% → ~0). Also a broad init-contract change.
- **(C) — speculative.** Hand the host the module's dispatch funcrefs during
  `(start)` (new import `__wire_dispatch` at the top of `__module_init`) so the
  host can invoke closures without `getExports()`. Keeps `(start)` for all
  modes, but relies on funcref→JS-callable exposure and adds a new import +
  codegen + host-glue; broad-impact, unvalidated. Only if (A) proves infeasible.
- **RC2 sub-fix — DONE.** `deferToExports` park-and-replay in the
  `callback_maker` host bridge (`src/runtime.ts`); host-glue-local, additive,
  landed independently of RC1. Test: `tests/issue-3284-rc2.test.ts`.

### Reproduce (drop into a `.tmp/` driver)

```js
// RC1 — throws "sameValue is not a function" at top-level; works inside test()
function assert(x) {
  if (x === true) return;
  throw new Error("a");
}
assert.sameValue = function (a, e) {
  if (a === e) return;
  throw new Error("s");
};
console.log(typeof assert.sameValue); // "function"
assert.sameValue(1, 1);

// RC2 — "in then" never prints at top-level; prints inside test()
Promise.resolve(42).then(function (v) {
  console.log("in then, v=", v);
});
```

Driver: `compile(src, {target:'gc'})` → `buildImports(r.imports)` →
`instantiateWasm(...)` → `imports.setExports(instance.exports)`. The top-level
variants fail because the failure happens _during_ `instantiateWasm` (the
`(start)` run), before `setExports`.

The scoped invariant test lives at `tests/issue-3284-rc1.test.ts`
(`describe.skip`, with a pointer to this section) so a future implementer can
un-skip it to drive the fix.
