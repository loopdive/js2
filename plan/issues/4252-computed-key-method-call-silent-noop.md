---
id: 4252
title: "obj[runtimeKey]() on a plain-object receiver is a silent no-op (drop-everything call fallback); standalone Proxy trap support matrix"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: es5
related: [1100, 1306, 1355, 1472, 2963, 3031, 3166, 4232]
loc-budget-allow:
  # +27: both element-access fallback sites in the tail dispatch now route
  # through tryEmitInlineDynamicCall behind the narrow plain-object oracle
  # gate, replacing the ref.null.extern drop. The routing must live at the
  # two fallback sites themselves — they ARE the dispatch's default arms.
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  # Same change at function granularity: the two fallback arms are inside
  # compileTailDispatch (+26); the predicate lives in the oracle.
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
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

## The fix

Both drop sites now route through `tryEmitInlineDynamicCall` — the same
ref.test-guarded dispatch the user-class arm (#3166) uses — behind a new
oracle-based predicate `elemAccessReceiverIsPlainObject`
(`src/codegen/expressions/calls.ts`), which is simply
`ctx.oracle.typeFactOf(receiver).kind === "object"`.

The predicate was chosen by **measuring** the receiver fact at both drop sites
rather than guessing: every one of the six failing shapes reported exactly
`{"kind":"object"}`. That makes the gate narrow by construction — `array`/`tuple`
(already working), `string`/`number`/`boolean`, `builtin`, `function`, `class`,
and the deliberately-excluded `any`/`unknown`/`unresolvable` all stay on their
existing paths. Admitting `any` would have been the tempting wide gate; it is
excluded precisely because an unresolvable receiver could be anything.

The dispatch's default arm reproduces the historical `ref.null.extern`, so a
read value that is not callable keeps today's behaviour rather than trapping.

### Demand gate (the #4232 lesson)

Byte-identity measured by hashing compiled standalone output, file-copy A/B:

| module shape | before → after |
| --- | --- |
| no element access at all | **identical** |
| element access READ, never called | **identical** |
| array receiver, variable index (`fs[i]()`) | **identical** |
| primitive receiver (`s[k]()`) | **identical** |
| `any`-typed receiver | **identical** |
| plain-object receiver, runtime key (the target) | changed |

## Blast radius (measured, both directions)

| suite | before | after | gained | lost |
| --- | --- | --- | --- | --- |
| harness self-tests (**all 116**) | 44 pass | **46 pass** | 2 | **0** |
| `built-ins/Proxy/` (30 sampled of 311) | 4 pass | 4 pass | 0 | 0 |
| `language/` (60 sampled of 23,724) | 46 pass | 46 pass | 0 | 0 |
| `built-ins/` (60 sampled of 23,809) | 25 pass | 25 pass | 0 | 0 |

The two harness flips are the assigned files. **Proxy movement is zero**, which
is the honest result: the fix has nothing to do with Proxy, so nothing in that
corpus should move, and nothing did. ES5-bucket impact is likewise ~0.

Caveat on the sampled rows: a 60-of-23,724 stride sample is sparse and is a
regression *smoke* check, not a conformance measurement. The load-bearing
evidence is the **complete** 116-file harness self-test suite (zero regressions)
plus the byte-identity table above — a module that cannot reach the new arm
cannot be affected by it.

### Equivalence suite (the gc/host lane)

The gate is deliberately **lane-agnostic** — the drop-everything fallback
mis-compiled the host lane too — so the equivalence suite is the relevant check
there.

- **Every equivalence test file containing a call-through-brackets**
  (`]` followed by `(` — 14 files incl. `proxy-traps`, `super-element-access`,
  `optional-element-access`, `computed-property-class`,
  `issue-3205-property-call-wrapper-root`): **153/153 pass.** These are the only
  files whose emitted code the change can reach.
- A fixed 43-file (1-in-5) slice of the suite was run **at HEAD and at
  baseline** by file-copy A/B: both produce `2 failed | 407 passed | 1 todo`
  and the failing-file sets are **byte-for-byte identical**
  (`arguments-nested-and-loops.test.ts`, `delete-sentinel.test.ts`). Those two
  are **pre-existing on this branch and untouched by this change**
  (`arguments-nested-and-loops` fails `expected 30 to be 33` on both sides).

A full 214-file equivalence run was started but abandoned after ~50 min without
completing; the subset A/B above supersedes it and is the stronger evidence
because it is differential. The authoritative check remains CI's
`equivalence-gate`.

## Out of scope

Proxy trap gaps (`isExtensible` / `ownKeys` / `construct` / `apply` /
`revocable`) are left for a follow-up. The matrix above is the starting point.

Also observed while bisecting, **not fixed here** and not caused by this change:
`this` is not bound for an object-literal method call — both `obj.m()` and
`obj[k]()` leave `this !== obj` (`.tmp/probe-b2.js`, `static-this-bound=BAD`
before and after). That is a separate defect worth its own issue.
