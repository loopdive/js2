---
id: 5371
title: "`await` of a compiled async function that returns a HOST promise hands back the Promise itself — hono `verifySignature` passes a pending Promise where `getCryptoKey` should have resolved to a CryptoKey"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-12
completed: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# (#5371, 2026-09-12) The one ABI rule this fix adds — "a legacy-pass-through
# async function whose body can return a thenable keeps its result on the
# externref carrier" — has to be applied at every site that registers an async
# callable's wasm result, or the declaration and its call sites disagree and
# the module fails validation. Each of the five is a one-to-three-line call to
# the shared helper in the new src/codegen/async-thenable-return.ts; the rule
# itself lives entirely in that module.
func-budget-allow:
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/declarations.ts::collectDeclarations
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/class-bodies.ts
  - src/codegen/declarations.ts
  - src/codegen/literals.ts
---

## Problem

Found by #5362's instrumentation of hono's signed-cookie path and left
unfixed there. hono does

```js
const getCryptoKey = async (secret) => {
  const secretBuf = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  return await crypto.subtle.importKey("raw", secretBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};
const verifySignature = async (base64Signature, value, secret) => {
  const secretKey = await getCryptoKey(secret);
  return await crypto.subtle.verify({ name: "HMAC" }, secretKey, signatureBinary, dataBinary);
};
```

and the probe shows `crypto.subtle.verify` receiving a **`Promise`** as
`secretKey`: `await getCryptoKey(secret)` hands back the promise instead of
the `CryptoKey` it resolves to. The compiled async function's return value is
a host promise (from `importKey`); the promise the compiled function itself
returns must **adopt** it (§27.2.1.3.2 Promise Resolve Functions: a thenable
result schedules a PromiseResolveThenableJob), and/or the `await` must
unwrap a host thenable. One of those two steps is not happening for a host
promise flowing through a compiled async function.

This is what keeps hono's `cookie.test.ts` at 24/35 after #5362 (the signed
`getSignedCookie` / `verifySignature` tests), and the shape — an async
wrapper around a host async API — is universal in library code.

## Acceptance criteria

1. Probe matches Node: `async function gk() { return crypto.subtle.importKey(...) }` (with and without the inner `await`) followed by `const k = await gk(); return k.type` returns `"secret"`, in an untyped `.js` two-file project. Also `async function w() { return Promise.resolve(7) }` → `await w()` is `7`, and `async function w2() { return hostAsyncFn() }` for a host function that returns a promise.
2. Regression test under `tests/` for those shapes, failing on the parent, passing with the fix, exact counts both ways, anti-vacuity control (an async function returning a plain value already works).
3. A/B at one HEAD, 17 suites, per file — hono `cookie.test.ts` expected up; jest/axios (promise-heavy) watched; no regressions.
4. Both lanes: the host lane's promise resolution and the standalone/native-first promise implementation must both adopt thenables; record the standalone status explicitly.

## Implementation Plan

1. **Reduce** with the four shapes in AC 1 (standalone `.mjs`, `compileAndRunUpstreamModule`). Determine which step fails: (a) the async function's *return* — does the compiled promise resolve with the host promise as a plain value? (b) the *await* — does `await <host promise>` unwrap? Shape `await w2()` vs `await hostAsyncFn()` directly separates them.
2. **Read the async lowering's return path** (grep `async` in `src/codegen/statements/` and `src/codegen/async*.ts`; the resolve import — `__promise_resolve` / `__async_return` — in `src/runtime.ts`) and the `await` lowering. In the host lane the resolve function should be `Promise.resolve`-adopting (`resolve(value)` on a real Promise capability adopts thenables for free — if the runtime resolves via a hand-rolled settle that stores the value, that is the defect). In the standalone/native-first lane, the promise implementation's resolve must check `typeof value?.then === "function"` and adopt.
3. Fix at the resolve function (or the await unwrap), not at call sites. Do not special-case host promises: the rule is "a thenable result adopts".
4. Regression tests, both lanes; A/B; one PR.

## Dispatch

Model: **opus**. One reduction separates the two candidate steps; the fix is at a single resolve/await site per lane.

## Resolution

**Status: fixed for the JS-host lane; the named hono symptom was already gone
before this change. Standalone/WASI is UNCHANGED and is the residual.**

### What was still broken (re-measured on `upstream/main` cf82f78d6d, 2026-09-12)

#5823 had already repaired the half the issue title names: the hono shape
(`getCryptoKey` → `crypto.subtle.importKey`) now returns a real `CryptoKey`
through `await`, with and without the inner `await`. That was verified before
touching anything — all four AC-1 `importKey` shapes PASS on the parent.

What remained is the same defect for a different **carrier**. Measured on the
parent, untyped `.js` two-file projects through `compileAndRunUpstreamModule`:

| shape (host lane) | parent | with fix |
| --- | --- | --- |
| `async function f() { return Promise.resolve(7) }` → `await f()` | `NaN` | `7` |
| `async function f() { return hostFn() }` (hostFn returns a promise) | `NaN` | `11` |
| `async function f() { const p = hostFn(); return p }` | `NaN` | `11` |
| `async function f(x) { if (x) return hostFn(); return 3 }` | `NaN` / `3` | `11` / `3` |
| `const f = async () => hostFn()` (arrow) | `NaN` | `11` |
| `{ async m() { return hostFn() } }` (object-literal method) | `NaN` | `11` |
| `async function f() { return compiledAsync() }` | `NaN` | `7` |
| `async function f() { return Promise.resolve("hi") }` | `"hi"` | `"hi"` |
| `async function f() { const v = await hostFn(); return hostFn() }` | `11` | `11` |
| `async function f() { return 5 }` (control) | `5` | `5` |

### Mechanism

An async function that genuinely suspends is drive-lowered and settles its
result promise through the adopting path — that is why the two bottom rows
already passed. Every other async shape stays on the legacy **synchronous
pass-through**, whose wasm result is the *unwrapped* `T`
(`unwrapPromiseType(Promise<number>)` → `f64`); the Promise itself is minted at
the call site by `wrapAsyncReturn`.

That is where the value died. The body's `return hostFn()` leaves a Promise
**externref** on the stack, and the return coercion ran `externref → f64` —
`Number(Promise{11})` — so the caller's `await` read **NaN**. Nothing was wrong
with adoption: `wrapAsyncReturn` is `Promise.resolve`, which adopts a thenable
for free. The loss was purely in the **carrier**, which is exactly why the
identical body was already correct for `Promise<string>` (`string` is
externref-carried, so the promise flowed out intact and the call site's
`Promise.resolve` adopted it — the `"hi"` row).

So the fix is one rule at the ABI, in the new leaf module
`src/codegen/async-thenable-return.ts`: **a legacy-pass-through async function
whose own body can `return` a thenable keeps its result on the externref
carrier**; the existing adopting `Promise.resolve` at the call site then does
the §27.2.1.3.2 work. "Can return a thenable" is `ctx.oracle.propertyFactOf(<return
operand>, "then")` over the function's own returns (concise arrow bodies count;
nested function scopes are skipped, since their returns settle their own
promise), memoised per declaration.

The rule has to be applied wherever an async callable's wasm result is
registered, or the declaration and its call sites disagree and the module fails
validation — five sites, each a one-to-three-line call into the helper:
`declarations.ts` (×2, right after `prepareAsyncCallableAbi` so that helper's
own inputs are unchanged), `closures.ts` (`computeClosureWrapperSig`, arrows and
function expressions), `statements/nested-declarations.ts`, `literals.ts` (×2,
the object-literal method placeholder and its real registration — they must
agree or the method trampoline forwards the wrong type), and `class-bodies.ts`.
Call sites need no change: they already read the real signature via
`getWasmFuncReturnType`. The widening never fires on a `void` or
already-externref result, so an async function returning a plain value — the
overwhelming majority — is byte-identical.

### Regression test

`tests/issue-5371-await-async-returning-thenable.test.ts` — one untyped `.js`
two-file project, eight cases. **Parent: 6 failed | 2 passed. With the fix: 8
passed.** The two that pass on the parent are the anti-vacuity controls (an
async function returning a plain value, and one that `await`s before
returning); without them a change that simply made every async result externref
would be indistinguishable.

### A/B — 17 dogfood suites, one HEAD (cf82f78d6d), per file

| suite | base | fix | Δ | suite | base | fix | Δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | 0 | jsdom | 6/6 | 6/6 | 0 |
| three | 17/18 | 17/18 | 0 | styled-components | 9/9 | 9/9 | 0 |
| clsx | 32/32 | 32/32 | 0 | uuid | 75/75 | 75/75 | 0 |
| cookie | 63740/63740 | 63740/63740 | 0 | marked | 16/30 | 16/30 | 0 |
| lodash | 59/62 | 59/62 | 0 | moment | 10/10 | 10/10 | 0 |
| redux | 67/82 | 67/82 | 0 | prettier | 105/151 | 105/151 | 0 |
| axios | 202/231 | 202/231 | 0 | jest | 335/356 | 335/356 | 0 |
| stylelint | 108/108 | 108/108 | 0 | hono | 258/324 | 258/324 | 0 |
| tailwindcss | 13/13 | 13/13 | 0 | | | | |

**Zero regressions and zero improvements — not one test flipped in either
direction, at file or individual-test granularity.** That is the honest result
and it is worth stating plainly: the admitted dogfood corpus does not currently
exercise the repaired shape. hono's `src/utils/cookie.test.ts` stays at 24/35
with a byte-identical failure list, so its signed-cookie failures are a
*different* defect (the HMAC signature comes back as all-zero bytes —
`macha.AA%3D%3D` — and `serialize` emits a spurious `Max-Age=0`), not this one.
The value of this change is the correctness rule and the eight-case guard, not a
suite delta.

### Both lanes (AC 4)

**Standalone / WASI: unchanged, still wrong, measured both ways.** With the
native `$Promise` carrier the same five shapes return `NaN` on the parent AND
with the fix (controls `return await Promise.resolve(7)` and `return 7` pass in
both). The widening does reach those lanes — the callee now hands back a real
`$Promise` — but the standalone consumer in reach of an exported entry point is
the #1727 raw-value sink (`f() as unknown as number`), which unboxes a
`$Promise` to `NaN` exactly as it unboxed the host promise before. Closing that
needs the value-sink half of the async contract, not another ABI rule here; it
is filed as a residual rather than papered over.

### Residuals

1. **Standalone/WASI `return <thenable>` still reads `NaN`** through the
   raw-value sink (above). Filed as [#6428](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6428-standalone-async-return-thenable-value-sink).
2. **hono signed cookies (`src/utils/cookie.test.ts`, 11 failures)** are a
   separate defect — zero-valued HMAC output plus a spurious `Max-Age=0` in
   `serialize`. Filed as [#6430](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6430-hono-signed-cookie-hmac-zero-signature).
3. **Ordering.** `return p` and `return await p` differ by a microtask tick in
   the spec; this fix routes the first through the call-site
   `Promise.resolve`, which matches `return p`'s *value* semantics but does not
   attempt to reproduce the exact tick count. No test in the corpus observes it.
