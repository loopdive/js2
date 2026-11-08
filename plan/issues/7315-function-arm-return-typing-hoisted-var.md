---
id: 7315
title: "function-arm return typing: a function reading a hoisted for-head var is claimed then withdrawn on typeIdx parity (IR f64 vs legacy externref)"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7288, 7157]
---

# #7315: a function returning a module `var` the loop writes is claimed, then withdrawn

## Problem

```js
function f() { return i; }
for (var i = 0; i < 3; i++) {}
if (f() !== 3) throw "fn";
```

The selector claims `f`; the build then withdraws it:

```
f: function typeIdx parity mismatch: IR=315, legacy=44 — keeping legacy body
<module-init>: body references f, whose claim was withdrawn on a typeIdx
  parity mismatch — the call ABI baked from calleeTypes no longer matches;
  keeping legacy body
```

The IR types `f`'s return as `f64`; legacy's signature returns `externref`
(the module slot of `i`). The verdict stays correct (both units fall back to
legacy), but the withdrawn IR attempt leaves an extra type in the binary on
standalone, WASI and gc, and a claim-then-withdraw is a defect by the IR rules.

| Source form                             | main             | after #7288      |
| --------------------------------------- | ---------------- | ---------------- |
| `for (var i = 0; …)` (for-head)         | refused at select | claimed, withdrawn |
| `var i = 0; for (; i < 3; i++)` (statement) | claimed, withdrawn | claimed, withdrawn |

Measured 2026-11-07 (`irPostClaimErrors`, standalone). The statement form
withdraws on main already; #7288 makes the for-head form reach the same
function arm, which is new exposure for that form.

## Where the fix belongs

In the function arm's return typing, not in #7288: the IR must type a
function that returns a module binding with the binding's own slot type (the
type legacy gives `f`'s signature), or the selector must refuse the function
before the claim. Either way the selector and from-ast read one fact.

## Acceptance criteria

- Both source forms produce no `irPostClaimErrors` on standalone, WASI and gc.
- Verdicts unchanged; gc output byte-identical where the IR does not claim.
- `tests/issue-7288-module-init-for-head-var.test.ts` drops its
  `knownPostClaimWithdrawal` case marker.
