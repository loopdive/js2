---
id: 4251
title: "Standalone-compiled test262 harness fails 72 of its own 116 self-tests — harness fidelity"
status: in-progress
sprint: current
priority: high
horizon: xl
goal: standalone-gap
created: 2026-08-08
---

## Problem

`test262/test/harness/*.js` are the harness's **own self-tests**: each one
exercises a harness helper (`assert.throws`, `verifyNotWritable`,
`compareArray`, `asyncTest`, …) and fails if the helper misbehaves. Compiled
through `runTest262File(abs, tag, 30_000, "standalone")` — the authoritative
literal-upstream-harness path (`assembleOriginalHarness`, **not** the
`wrapTest` shim) — the score is:

```
harness self-tests (standalone): 44 pass / 116 total
```

A broken harness helper is worse than a broken feature: it silently changes
what every conformance test that includes it actually measures. The permanent
repro is `tests/es5-standalone-harness-selftests.test.ts`.

### Honest correction to the original framing

The commissioning brief assumed `verifyNotWritable` on a writable property
**does not throw**, i.e. that the negative property helpers are vacuous-pass
generators. **Measured, that is not what happens.** Probe
`.tmp/ph1.js` (a synthetic `includes: [propertyHelper.js]` test that reports
harness internals through a `Test262Error` message):

```
isWritable=true; isWritable(nw)=false; d2.writable=false;
vNW=threw:other:…            ← verifyNotWritable DID throw
```

`isWritable` / `isEnumerable` / `isConfigurable` all compute the right answers,
and `verifyNotWritable` on a writable property **does** throw a `Test262Error`.
What fails is the *self-test's* check on the thrown value:

```js
} catch (err) {
  threw = true;
  if (err.constructor !== Test262Error) {            // ← false-negative here
    throw new Error('Expected a Test262Error, but a "' +
      err.constructor.name + '" was thrown.');       // ← .name is undefined
  }
}
```

So the negative property helpers are **not** inflating the conformance number
by passing vacuously; they fail honestly. The real defect is one level down,
and it is bigger: **`Test262Error` instances have no working identity**.

## Root cause 1 (dominant): the `$Error_struct` interception of `new Test262Error()` discards the harness's own constructor

`src/codegen/expressions/new-builtin-globals.ts` intercepts `new
Test262Error(msg)` by NAME under `ctx.standalone || ctx.wasi` and lowers it to
`emitStandaloneTest262Error` → an `$Error_struct` tagged `Error` with
`$name = "Test262Error"` (#2902; it flipped ~2,779 tests host-free, so the
interception itself is load-bearing and must not simply be deleted).

The literal upstream harness, however, **declares** `Test262Error` — sta.js:

```js
function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}
Test262Error.prototype.toString = function () { … };
Test262Error.thrower = function (message) { throw new Test262Error(message); };
```

Because the `new` site never reaches that declaration, the user constructor's
prototype object and identity are never wired to the value that is actually
thrown. Measured (`.tmp/ph2.js`, `.tmp/ph4.js`, `.tmp/ph5.js`, `.tmp/ph7.js`):

| expression | standalone | correct |
| --- | --- | --- |
| `typeof Test262Error` | `"function"` | `"function"` |
| `Test262Error.name` | `"Test262Error"` | `"Test262Error"` |
| `new Test262Error("m").message` | `"m"` | `"m"` |
| `e.constructor === Test262Error` | **`false`** | `true` |
| `typeof e.constructor` | `"function"` | `"function"` |
| `e.constructor.name` | **`undefined`** | `"Test262Error"` |
| `e instanceof Test262Error` | **`false`** | `true` |
| `e.name` | **`undefined`** | `"Test262Error"` |
| `typeof Test262Error.prototype` | **`undefined`** | `"object"` |
| `typeof Test262Error.prototype.toString` | **`undefined`** | `"function"` |
| `String(e)` | **traps** (null deref) | `"Test262Error: m"` |

The `.constructor` back-pointer was *supposed* to be answered by the #3614 arm
in `fillExternGetErrorProps` (`src/codegen/registry/error-types.ts`, the
`USER_ERROR_CTOR_IDENTITY_NAMES` loop). It returns *a* function — `typeof` is
`"function"` — but not one that is `===` the `Test262Error` binding and with no
`.name`, so the identity comparison the harness performs still fails. Builtin
errors are fine (`new TypeError("t").constructor === TypeError` is `true`,
`.name === "TypeError"`, `instanceof` holds), which localises the defect to
this one user-declared-constructor path.

**Blast radius.** Every self-test in the `assert.throws` /
`verifyProperty` / `compareArray` families reduces to this. `assert.js`
compares `thrown.constructor !== expectedErrorConstructor` for *every* caught
value and renders `expectedErrorConstructor.name` in the message — which is
where the tell-tale `"Expected a undefined but got a different error
constructor with the same name"` in the evidence file comes from.

Self-tests gated on root cause 1 (≈15): `propertyhelper-verifynotwritable-writable`,
`-verifynotenumerable-enumerable`, `-verifynotconfigurable-configurable`,
`-verifyenumerable-not-enumerable`, `-verifywritable-not-writable`,
`-verifyconfigurable-not-configurable`, `verifyProperty-value-error`,
`verifyProperty-arguments`, `verifyProperty-noproperty`,
`verifyProperty-same-value`, `verifyProperty-undefined-desc`,
`verifyProperty-desc-is-not-object`, `compare-array-samevalue`,
`compare-array-different-elements`, `detachArrayBuffer-host-detachArrayBuffer`,
`sta.js`.

## Root cause 2: a user function's `.prototype` object is not materialised unless the function is `new`'d through the fnctor path

This is **general**, not `Test262Error`-specific. `.tmp/ph10.js`, a module with
no other prototype writes and no `new`:

```js
function G(m) { this.m = m; }
G.prototype.toString = function () { return "G"; };
typeof G.prototype              // → "undefined"   (want "object")
typeof G.prototype.toString     // → "undefined"   (want "function")
```

Add a single `new G(…)` and both become correct (`.tmp/ph3.js`: `F proto=object`,
`F ctor=true`). Add *any other* branded-builtin prototype write to the module
and `Test262Error.prototype.toString` starts reading back too (`.tmp/ph4.js`
reads `"function"`, `.tmp/ph5.js` reads `"undefined"` for the same expression) —
i.e. the write's survival is gated on `ctx.protoNamedDirty`
(`src/codegen/array-holes.ts` pre-scan → `shouldKeepBuiltinReceiverWrite`,
`src/codegen/builtin-write-keeps.ts`), which the harness's own
`Test262Error.prototype.toString = …` does not set because `Test262Error` is
not in `BUILTIN_BRAND_TABLE`.

This is why `sta.js`'s **second** assertion is the one that actually fails
(`assert(typeof Test262Error.prototype.toString === "function")`), not the
first — verified by replacing the four asserts with distinct return codes
(`.tmp/ph5.js`): `typeof Test262Error === "function"` is **true**, contradicting
the brief's item 2. `$DONOTEVALUATE`, `assert`, `assert.throws`,
`assert.sameValue` and `compareArray` all resolve as functions.

Consequence beyond the self-tests: `String(err)` / `err.toString()` on any
`Test262Error` **traps** with a null dereference, so a failing test's own
diagnostic can crash the run.

## Remaining buckets (not root-caused to the same depth)

| bucket | n | signature | note |
| --- | --- | --- | --- |
| asyncHelpers / `$DONE` | 15 | `Test262Error: asyncTest called without async flag`, `ReferenceError: $DONE is not defined` | the async-flag plumbing never reaches the literal harness path |
| `compareArray` shape | 7 | `Expected SameValue(«[object Object]», «function () { [native code] }»)` | `compareArray.format` / `assert.compareArray` binding resolves to the wrong value |
| `deepEqual` | 5 | `RuntimeError: illegal cast in __closure_85() at source L135` | compiler crash in the deepEqual closure |
| propertyHelper, symbol-keyed | 4 | `RuntimeError: float unrepresentable in integer range in __call_fn_method_2()` | symbol property key reaches an integer-typed path |
| `verifyProperty` restore/configurable | 6 | `prop descriptor should be configurable`, `TypeError: Object method called on null or undefined` | overlaps the in-flight descriptor-configurable work in `object-runtime-descriptors.ts` / `vec-props-key-source.ts` — **do not rewrite there; coordinate** |
| TypedArray | 3 | `typeof TypedArray === "function"` false; `illegal cast … at source L391` | needs `%TypedArray%` reachable as a callable |
| realm | 2 | `dereferencing a null pointer` at the `$262.createRealm` site | `-same-realm` variants |
| `wellKnownIntrinsicObjects` | 1 | `this implementation could not obtain %Array%` | `%`-intrinsic reification, structural |
| `fnGlobalObject` | 1 | `dynamic code evaluation is not supported` | needs the runtime-eval provider |
| Proxy | 2 | `trap … did not throw an error` | **out of scope** — owned by the Proxy-trap agent |

Two further compiler bugs found while probing, both reproducible standalone and
neither previously filed here:

* `new D(…)` where `D` returns an object literal → `RuntimeError: dereferencing
  a null pointer in __fnctor_D_new()` (`.tmp/ph3.js`, original form). §10.2.2
  step 13 says the returned object wins.
* sloppy-mode `delete o.a` on a non-configurable own property **throws a
  TypeError** instead of returning `false` (`.tmp/p5.mts`). propertyHelper's
  `isConfigurable` happens to tolerate it (it wraps the `delete` in
  `try/catch`), so it does not gate the self-tests, but it is a real §13.5.1.2
  divergence. Conversely `delete Math.PI` returns truthy where it must return
  `false`.

## Recommended fix for RC1, and why it is NOT in this PR

The interception site is `tryCompileBuiltinGlobalNew`
(`src/codegen/expressions/new-builtin-globals.ts`), reached from
`new-super.ts:3491` **before** any user-constructor resolution, and it claims
`Test262Error` purely by NAME with no shadow guard — unlike the
`GLOBAL_NON_CONSTRUCTOR_FUNCTIONS` arm forty lines above it, which does gate on
`!ctx.classSet.has(name) && !ctx.externClasses.has(name) &&
resolvesToAmbientGlobal(...)`. The obvious repair is to give the
`Test262Error` arm the same shadow guard, so a module that DECLARES
`Test262Error` (which the literal harness always does) falls through to the
fnctor path. A byte-identical constructor shape compiled under a different name
already behaves correctly there — `.tmp/ph4.js` compiles sta.js's exact
`function T262(m){ if (!(this instanceof T262)) return new T262(m); … }` plus
its prototype and static assignments and reports `T262 ctor=true; T262
inst=true; T262 proto=object` while the harness's own `Test262Error` reports
`false/false/undefined` in the same module.

Three things make this a measured change rather than a one-liner, and are why
it is deliberately not bundled with the diagnosis:

1. **Stack discipline.** The guard must go at the TOP of the ctor-name branch,
   before the message argument is compiled and before the #2969 `ToString`
   block. Falling through at the `emitStandaloneTest262Error` line leaves the
   already-compiled argument on the stack.
2. **The `oracle` ratchet.** "Does this module declare `Test262Error`?" wants
   `ctx.checker.getSymbolAtLocation(...).valueDeclaration`; a raw `checker.*`
   query trips the #1930/#3273 gate. Route it through `ctx.oracle`, or reuse
   the existing `ctx.classSet` / `ctx.fnctorEscapeGate.ctorDeclByName` state.
3. **Blast radius is the whole conformance number.** #2902 chose the
   interception to make ~2,779 tests host-free, and the standalone failure
   RENDERER keys on `$Error_struct` (#2962/#3468 F1 classify a message
   beginning with `Test262Error` by construction). Changing the payload
   representation of the single most-thrown value in the suite can move
   thousands of results in either direction. It needs the merge_group
   standalone floor/net guards, not a local sample, and it must be measured
   both ways per the honesty rule below.

## Acceptance criteria

- [ ] `e.constructor === Test262Error`, `e instanceof Test262Error`,
      `e.name === "Test262Error"`, and `String(e) === "Test262Error: <msg>"`
      hold in standalone, without reintroducing the `env::__new_Test262Error`
      host import.
- [ ] `typeof F.prototype === "object"` for a top-level `function F` whose
      prototype is written but which is never `new`'d.
- [ ] `tests/es5-standalone-harness-selftests.test.ts` ratchets: the recorded
      pass set may only grow.
- [ ] Any change is measured **both ways** on a conformance sample
      (`built-ins/Object/defineProperty`) and the deflation reported — a
      previously-"passing" test that flips to failing because a helper stopped
      lying is a **correct** outcome and must not be suppressed.

## Notes for whoever picks this up

- Use `runTest262File(abs, tag, 30_000, "standalone")`. The `wrapTest` shim
  path is a *different* harness (`buildPreamble` in `tests/test262-runner.ts`)
  whose `verifyEnumerable`/`verifyNotWritable`/`verifyConfigurable`/… are
  literal `{}` no-ops. Diagnosing against that path measures the shim, not the
  compiler — it cost this investigation an hour.
- The self-tests need the runtime-eval refusal provider prebuilt, or every
  `propertyHelper` test dies at instantiate on `js2wasm:runtime-eval`:
  `node --import tsx scripts/build-runtime-eval-provider.mjs --refusal-only`.
- In an agent worktree the `test262` submodule is not checked out. Symlink it:
  `rmdir test262 && ln -s <repo>/test262 test262`.
- The `| at L<n>` line annotations in runner failure messages are a text-search
  heuristic over the wrapped source and are frequently off by one assertion.
  Do not trust them; bisect with distinct return codes instead.
