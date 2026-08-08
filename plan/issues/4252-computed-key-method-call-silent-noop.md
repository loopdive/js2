---
id: 4252
title: "obj[runtimeKey]() on a plain-object receiver is a silent no-op (drop-everything call fallback); standalone Proxy trap support matrix"
status: in-progress
sprint: current
created: 2026-08-08
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: es5
related: [1100, 1306, 1355, 1472, 2963, 3031, 3166, 4232]
---

## Summary

Assigned as "minimal standalone Proxy trap machinery" for the two harness
self-tests `test262/test/harness/proxytrapshelper-default.js` and
`proxytrapshelper-overrides.js`.

**The premise did not survive contact with the tests.** Neither file constructs
a `Proxy`. Both only exercise `allowProxyTraps` — a plain factory returning an
object literal of 14 functions — and call them *directly*:

```js
var traps = allowProxyTraps();
function assertTrapThrows(trap) {
  var failedToThrow = false;
  try { traps[trap](); failedToThrow = true; } catch (e) {}   // <-- the whole test
  if (failedToThrow) { throw new Test262Error('trap ' + trap + ' did not throw an error'); }
}
```

`Proxy` appears nowhere in either file, nor in `harness/proxyTrapsHelper.js`.
The word "proxy" is in the filename only. Both tests fail for a reason with
nothing to do with proxies, documented below.

## Root cause: `obj[runtimeKey]()` never invokes the callee

Bisected with `.tmp/probe-b1.js` / `.tmp/probe-b2.js` (standalone, node 25).
Counting side effects rather than relying on the throw:

| form | invoked? |
| --- | --- |
| `o.alpha()` — static property call | OK |
| `o['alpha']()` — computed call, **string-literal** key | OK |
| `var k='alpha'; o[k]()` — computed call, **variable** key | **NOT INVOKED** |
| `var g = o[k]; g()` — extract, then call | OK |
| `arr[i]()` — array receiver, variable index | OK |
| `o[7]()` where `var nk = 7` | **NOT INVOKED** |
| `obj3[fk](5)` — computed call with arguments | **NOT INVOKED** |
| `holder.inner[gk]()` — nested receiver | **NOT INVOKED** |

So the *property read* is correct (`typeof traps[trap] === 'function'` passes,
and extract-then-call throws as it should). Only the **call form** is broken,
and only when the receiver is a plain object and the key is not a literal.

The site is the drop-everything fallback in
`src/codegen/expressions/call-tail-dispatch.ts:1446-1467`: when the element-access
key does not resolve to a static string, it compiles the receiver, the key and
every argument purely for side effects, drops each, and pushes
`ref.null.extern`. The call evaluates to `undefined` and the callee is never
entered.

Two escape hatches already sit above it and both decline here:

- `compileCallableElementAccessCall` (#1306) — needs a callable *element type*,
  which a JS object literal under the test262 harness does not supply.
- `tryEmitInlineDynamicCall` (#3166 S1) — the general dynamic dispatch, but it
  is gated on `elemAccessReceiverIsUserClass(ctx, elemAccess)`. A plain object
  literal is not a user class, so the gate is false and the call falls through
  to the drop.

`tryEmitInlineDynamicCall` is exactly the right machinery — it already carries a
Proxy `[[Call]]` arm (#3031), a bound-function arm (#3140), a TypedArray-ctor
arm (#3177) and a dynamic-apply fallback. The bug is the *gate*, not the
dispatch.

### Why this class of bug is expensive

The failure is **silent**. There is no compile error, no trap, no diagnostic —
the call simply evaluates to `undefined` and execution continues. In the
`proxytrapshelper` tests that turns a throwing trap into a non-throwing one. In
`.tmp/probe-computed-call2.js` it terminated module execution early and the
runner reported the file as **`pass`** — a vacuous pass of the exact kind the
harness self-tests exist to detect (cf. #4209).

## Standalone Proxy support matrix (measured, not inferred)

Requested as stage 1 and worth recording independently of the above. Measured
per-trap with `.tmp/proxy-matrix.mts` — **one module per trap**, because a Wasm
trap is not catchable from JS and a shared module aborts the whole matrix at the
first bad arm. Each case installs a handler that sets a flag, performs the
operation that should invoke the trap, and fails if the flag is unset.

| trap / feature | standalone | note |
| --- | --- | --- |
| `new Proxy(t, h)` | works | `__proxy_create`, `$Proxy` struct |
| `get` | dispatches | |
| `set` | dispatches | |
| `has` | dispatches | |
| `deleteProperty` | dispatches | #1355 Slice A |
| `getOwnPropertyDescriptor` | dispatches | #1355 Slice B |
| `defineProperty` | dispatches | #1355 Slice F |
| `getPrototypeOf` | dispatches | #1355 Slice C |
| `setPrototypeOf` | dispatches | #1355 Slice C |
| `preventExtensions` | dispatches | #1355 Slice D |
| trap `throw` propagates to caller | works | user throw crosses the driver correctly |
| `isExtensible` | **trap not invoked** | `Object.isExtensible(p)` does not reach the dispatch; slot `TRAP_ISEXT` is wired at `__proxy_create` but the caller-side operation forwards to the target |
| `ownKeys` | **trap not invoked** | `Object.keys(p)` does not route through `TRAP_OWNKEYS` |
| `construct` | **trap not invoked** | no `[[Construct]]` driver reserved in `ensureProxyRuntime`; `new p()` forwards |
| `apply` | **runtime trap** | `p()` on a callable proxy dereferences a null pointer |
| `Proxy.revocable` | **compile error** | `Codegen error: Proxy not supported in standalone mode (#1472 Phase C)` |

So `ensureProxyRuntime` / `fillProxyDispatch` in
`src/codegen/object-runtime-proxy.ts` are substantially further along than the
"deferred-feature" label in the IR fallback table suggests: **10 of 13 traps
already dispatch through real trap closures**, with the handler threaded as
`this` per §10.5.x. The gaps are `isExtensible`, `ownKeys`, `construct`,
`apply`, and `Proxy.revocable`.

**None of these gaps is on the path to the two assigned self-tests**, which is
why this issue does not implement them. They are recorded here so the next
session starts from measurement rather than from the filename.

## Scope of this issue

1. Assessment above (matrix + root cause). — done
2. Fix `obj[runtimeKey]()` for plain-object receivers by widening the
   `tryEmitInlineDynamicCall` gate, demand-gated so a module without a
   dynamic-key call on a non-class receiver stays byte-identical.
3. Blast radius: `built-ins/Proxy/` sampled before/after, plus the harness
   self-test suite.

Proxy trap gaps (`isExtensible` / `ownKeys` / `construct` / `apply` /
`revocable`) are explicitly **out of scope** and left for a follow-up.
