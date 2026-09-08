---
id: 5371
title: "`await` of a compiled async function that returns a HOST promise hands back the Promise itself — hono `verifySignature` passes a pending Promise where `getCryptoKey` should have resolved to a CryptoKey"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
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
