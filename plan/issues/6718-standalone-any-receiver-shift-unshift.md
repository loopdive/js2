---
id: 6718
title: "standalone: `shift` / `unshift` on an `any` Array receiver do not mutate (`id([1,2,3]).unshift(0)` leaves length 3)"
status: ready
sprint: current
created: 2026-09-27
updated: 2026-09-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6701, 6447, 2927]
---

# #6718 — standalone: `shift` / `unshift` on an `any` Array receiver

## Problem

Found while fixing [#6701](./6701-standalone-any-receiver-array-residuals.md).
Measured 2026-09-27 on the #6701 branch, `--target standalone`, zero imports:

```ts
function id(v: any): any { return v; }
var a = id([1, 2, 3]); a.unshift(0); a.length * 10 + a[0];   // 31  (expected 40)
var b = id([1, 2, 3]); var x = b.shift(); b.length * 10 + x;  // 30  (expected 21)
```

`push`/`pop` have a `$__vec_base` mutator arm in the closed-method dispatcher
(#2927) and `splice` a producer arm (#6701); `shift`/`unshift` have neither.
The reflective `Array.prototype.unshift.call(a, 0)` is right (40), so the
array-like body in `array-like-native.ts` already exists — only the dynamic
method-call route is missing.

## Acceptance

- Both rows answer the Node values in `--target standalone`, no new host import.
