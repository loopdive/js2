---
id: 7049
title: "standalone: awaited async results never arrive in marked's async Hooks tests (`await marked.parse(…)` → null; 15 of 30) and a minimal `out = await Promise.resolve('v')` never resumes after `__drain_microtasks`"
status: ready
sprint: current
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: async-await, promises
goal: standalone-gap
related: [7013, 7021]
---

# Awaited async results in standalone (marked async Hooks)

Found after [#7021](./7021-standalone-call-m-dispatch-illegal-cast-marked.md)
stopped marked's Hooks tests from trapping. With #7021 the standalone lane
passes 15/30 of `test/unit/Hooks.test.js`; **every one of the 15 remaining
failures is an `async` test** (JS-host lane: 30/30):

```
should preprocess async          assertion 2: strictEqual mismatch actual=null expected=<h1>preprocess async</h1>…
should provide parser async      assertion 1: strictEqual mismatch actual=null expected=test parser
should not have race condition … Cannot destructure 'null' or 'undefined'
```

marked's async path is `return (async () => { … await i.hooks.preprocess(n) … })().catch(o)`
inside `parseMarkdown`; the test awaits that promise. `promise instanceof
Promise` holds (assertion 1 of "should preprocess async" passes), but the
awaited value is `null`.

## Minimal probe (standalone, not yet reduced to the marked shape)

```ts
let out: any = "unset";
async function a4(): Promise<void> { out = await Promise.resolve("v"); }
export function t4(): number { out = "unset"; a4(); return 0; }
export function r(): number { return out === "v" ? 1 : out === "unset" ? -2 : -3; }
```

Host loop: `t4(); for (50×) __drain_microtasks(); r()` → `-2` — the
continuation after `await` never ran (or wrote a different binding). This may be
a probe-harness misuse rather than the marked defect; confirm with the
upstream lane's own drain sequence (`tests/dogfood/upstream-standalone-lane.mjs`)
before fixing.

## Acceptance

marked standalone Hooks: the 15 async tests pass; JS-host lane unchanged.
