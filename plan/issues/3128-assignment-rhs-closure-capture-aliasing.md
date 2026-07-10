---
id: 3128
title: "Assignment lost when the RHS contains a closure capturing the assigned var (`p2 = p1.then(() => p2)`)"
status: ready
sprint: current
created: 2026-07-10
updated: 2026-07-10
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: closures
goal: standalone-mode
related: [3121, 3125, 2980]
origin: "#3125 per-file drill — the resolve-settled-{fulfilled,rejected}-self.js widen regressions attributed to thenable assimilation in plan/log/2980-carrier-widen-tradeoff.md are actually THIS bug: p2 is null before .then() semantics ever matter"
---

# #3128 — assignment lost when the RHS closure captures the assigned var

## Problem (minimal repro, `--target standalone`, main@b6691942bd8)

```ts
export function test(): number {
  var p2: any;
  p2 = <RHS containing a closure that captures p2>;
  if (p2 === null || p2 === undefined) return 9; // ← returns 9
  return 1;
}
```

Measured (`.tmp`-style probes, 2026-07-10, standalone + `JS2WASM_ASYNC_CARRIER_WIDEN=1`
for the then-shapes — but the object shape reproduces WITHOUT any widen):

| RHS | result |
| --- | --- |
| `p1.then(function() { return 42; })` (no capture) | 1 ✔ |
| `p1.then(function() { return p2; })` (captures p2) | **9 ✗** |
| `(function(){ return { a: (function(){ return p2; }) }; })()` (captures p2, no Promise at all) | **9 ✗** |
| sibling closure capturing p2 NOT in the assignment RHS | 1 ✔ |

So this is a general assignment/closure-capture aliasing bug, not a Promise
bug: when compiling `p2 = RHS` and the RHS **contains a closure capturing
`p2`**, the capture-boxing (ref-cell promotion) happens mid-expression and the
assignment's write lands in the stale slot (or vice versa) — the subsequent
read of `p2` sees null. Same family as the #3121 closure-capture aliasing
fixes (objlit method vs arrow), different site (assignment whose RHS triggers
the promotion of its own LHS).

## Impact

- `test262/test/built-ins/Promise/prototype/then/resolve-settled-fulfilled-self.js`
  and `resolve-settled-rejected-self.js` on the widened-standalone lane
  ("Cannot read properties of null (reading 'then')" — `p2.then(...)` on the
  null-read after `p2 = p1.then(function() { return p2; })`). These two were
  mis-attributed to thenable assimilation in the #2980 tradeoff doc; #3125
  landed the §27.2.1.3.2 self-resolution reject (verified via the executor
  shape) but these files stay blocked on THIS bug.
- Any `var x; x = expr-with-closure-over-x` pattern (deferred/lazy self
  references), host and standalone alike (verify host lane too — the probe
  above ran standalone).

## Repro harness

`.tmp/compile-self4.mts` in the #3125 worktree (recreate: compile the table
rows above with `target: "standalone"`, instantiate with env-stub, expect 1).

## Acceptance

- All four table rows return 1.
- `resolve-settled-fulfilled-self.js` / `resolve-settled-rejected-self.js`
  flip to pass on the widen arm (`JS2WASM_ASYNC_CARRIER_WIDEN=1`,
  `runTest262File(..., "standalone")`) — the #3125 self-resolution reject then
  fires and the tests' TypeError assertions hold.
- No regressions in tests/issue-3121* and the closure capture suites.
