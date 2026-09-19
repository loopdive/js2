---
id: 6498
title: "A global-lexical TDZ ReferenceError caught by the script's own `try/catch` binds `null` — both lanes"
status: ready
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: tdz
goal: core-semantics
related: [6492, 5226]
---

# #6498 — the caught value of a global-lexical TDZ throw is `null`

Found while working #6492 round 7 on the `rethrowing null value` trap row.
**Not a linked-lane bug** — it reproduces IDENTICALLY in both test262 lanes,
which is why it is filed separately.

## Repro (3 lines, real runner, both lanes)

```js
var got = "none";
try { (function () { return x + 1; })(); } catch (e) { got = e && e.name; }
assert.sameValue(got, "ReferenceError", "consumer-side catch");
const x = 1;
```

Measured 2026-09-17:

| lane | verdict |
| --- | --- |
| honest | `fail: Expected SameValue(«null», «"ReferenceError"»)` |
| linked | `fail: Expected SameValue(«null», «"ReferenceError"»)` |

So the TDZ check DOES fire (control reaches the `catch`), but the bound
exception value is `null` rather than a `ReferenceError` instance. Anything that
inspects the caught error — `e.name`, `e instanceof ReferenceError`,
`e.message`, rethrow — sees nothing.

## What is already known

- It is specific to a **global lexical** (`const`/`let` at script top level).
  The BLOCK-lexical TDZ shape is fine: after #6492 round 6,
  `var f; for (let x of (f = function () { typeof x; }, [])) ;` followed by
  `assert.throws(ReferenceError, f)` passes in both lanes.
- It is not the #6492 round-6 "last host exception" latch. That fix made a
  host-thrown error's VALUE recoverable across the linked boundary and is
  measured; this value is null on the single-module path too.
- The nested and direct forms behave identically
  (`function f() { return x + 1; }` called from the closure, or the closure
  reading `x` itself), so the closure boundary is not the trigger.

## The adjacent linked-lane row this came from

`test/language/statements/const/global-closure-get-before-initialization.js`
fails the LINKED lane with an uncatchable
`rethrowing null value [in __closure_62() ← __call_fn_method_3 ← __ js2_call_fn_method_argc_3]`
and passes the honest lane. "rethrowing null value" is V8's message for
`throw_ref` on a null `exnref`, so the two are very likely the same missing
payload seen from two sides — but that row is a linked-lane trap and is tracked
in #6492; this issue is the lane-independent half, which is reproducible in two
minutes and should be fixed first.

## Acceptance

- [ ] The repro above binds a real `ReferenceError` (`e.name`,
      `e instanceof ReferenceError`, a non-empty `e.message`).
- [ ] `assert.throws(ReferenceError, …)` over the same shape still passes.
- [ ] Measured on BOTH test262 lanes with the real runner; a scoped honest
      slice over `language/statements/const/` + `language/statements/let/`
      shows no losses.
- [ ] Re-check `const/global-closure-get-before-initialization.js` in the
      linked lane afterwards — if the null payload was the cause, the
      `rethrowing null value` trap goes with it.
