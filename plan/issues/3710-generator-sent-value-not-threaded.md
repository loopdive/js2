---
id: 3710
title: "Generator two-way yield: value passed to .next(x) is not threaded back into the generator body"
status: blocked
sprint: current
blocked_on: 1687
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: generators
goal: generator-model
origin: "#3690 — new tests/differential/corpus/generators/04-sent-values.js surfaced this on first run"
related: [3690]
---

# #3710 — `x = yield y` does not receive the value passed to `.next(x)`

## Repro

```js
function* echo() {
  let received = [];
  let x = yield "ready";
  while (x !== "stop") {
    received.push(x);
    x = yield received.length;
  }
  return received;
}
const g = echo();
console.log(g.next().value); // "ready"
console.log(g.next("a").value); // 1
console.log(g.next("b").value); // 2
const last = g.next("stop");
console.log(last.value.join(",")); // "a,b"
console.log(last.done); // true
```

## Symptom

- V8: `ready\n1\n2\na,b\ntrue`
- js2wasm: `ready\n1\n2` then a runtime error `join is not a function` on
  the 4th line.

The `1` and `2` outputs happen to be right (since `received.length` only
depends on the push count, not the value), but `received` itself does not
actually contain `["a", "b"]` — the final `.join(",")` fails, meaning `x`
(the value bound from `yield "ready"` / `yield received.length`) is not
being correctly assigned from the argument passed to `.next()`, so
`received.push(x)` is pushing something that isn't a string (or `received`
itself is wrong). This is the two-way generator communication protocol
(`x = yield y`), separate from simple `yield`-only generators which already
work (see #3690's `01-basics.js`/`02-for-of.js`, both matching).

## Repro file

`tests/differential/corpus/generators/04-sent-values.js` (see #3690).

## Root cause (investigated 2026-07-27) — duplicate of #1687

This is the exact root cause #1687 already documents: generators compile
through an **eager-buffer** model (`src/runtime.ts` `__gen_push_*` /
`__EAGER_GEN_LIMIT`, see #3712 for the smoking-gun evidence). The generator
body runs to completion (up to a 1,000,000-yield safety cap) at *creation*
time, buffering every yielded value into an array; `.next(v)` only ever
drains the next buffered entry — it can never feed `v` back into a `yield`
expression that already executed. `x = yield y` therefore always observes
`x = undefined`, matching #1687's exact framing.

**#1687's `blocked_on: 1665` is stale**: #1665 (Wasm-native generator
lowering, foundational) shipped 2026-06-03, but only Phase 1/2 of the
native lowering (`src/codegen/generators-native.ts`) — simple sequential
yields and yields in loops/conditionals. Per that file's own header
comment, sent-values / `yield*` / `.return()`/`.throw()` injection
("Phase 3" in the `generator-model` goal doc) are explicitly **not yet
modeled** and bail to the legacy eager-buffer host path — which is exactly
what this repro hits. The real remaining blocker is that Phase 3 work, not
#1665.

**Not fixed here** — this is architecturally significant (a multi-phase
compiler-lowering project, not a local patch) and already tracked with
more context at #1687. Keeping this issue open as an additional minimal,
verified repro + differential-corpus regression pin for whoever picks up
Phase 3, rather than closing as a duplicate outright.
