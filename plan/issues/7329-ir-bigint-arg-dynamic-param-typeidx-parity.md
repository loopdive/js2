---
id: 7329
title: "IR: a BigInt argument to a claimed dynamic-parameter callee withdraws the callee on typeIdx parity"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7305, 2949, 7106]
---

# #7329: a BigInt argument makes a claimed callee fail ABI parity

## Problem

When a claimed top-level function with a dynamic parameter is called with a
BigInt, the callee itself is withdrawn after the claim:

```
u: function typeIdx parity mismatch: IR=178, legacy=61 — keeping legacy body
```

The IR and legacy compilers resolve different function types for `u` once a
BigInt flows into its parameter, so the IR body is dropped. Output is
correct (legacy runs), but this is a post-claim withdrawal
(`irPostClaimErrors`).

## Repro (main; base 63018c49; bare compile)

```js
function u(g) { return typeof g; } u(1n);
```

```js
function u(g) { return typeof g; } var b = 1n; u(b);
```

Both give the error on standalone and gc. With #7305,
`function u(g) { g(1); } u(1n);` reaches it too.

## Next step

Find which side types the parameter from the BigInt call-site evidence: the
legacy slot (likely a BigInt/i64-aware ABI) or the IR's dynamic. Then either:

- refuse at selection when a call site passes a BigInt to a dynamic
  parameter;
- or align the IR signature with legacy's.

Pin both repros with `irPostClaimErrors` empty.
