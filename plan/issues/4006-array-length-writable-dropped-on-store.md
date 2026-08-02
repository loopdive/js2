---
id: 4006
title: "Array length's writable attribute is silently DROPPED ON STORE (both lanes) — sits underneath the defineProperties routing gap"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: core-semantics
related: []
---

# Array length's writable attribute is silently DROPPED ON STORE (both lanes) — sits underneath the defineProperties routing gap

## Problem

Set `writable:false` on an array's `length`, then read it straight back via
`getOwnPropertyDescriptor` with **no intervening define** — it still reports
`writable: true`. The attribute is dropped at **store** time, not at read time.

Source confirms it: `maybeEmitVecLengthDefine` lists `writable` among its ignored
names, commented *"freeze deferred"*. Known-deferred, not a surprise.

Hits `Object.defineProperty` and `Object.defineProperties` **identically**, which
is why it is NOT the routing gap fixed earlier (that one was defineProperties-only).
Affects **both lanes** — not standalone-specific.

## ⚠ The obvious probe is CONFOUNDED — read before measuring

On the **standalone** lane `gOPD(arr,"length")` returns `undefined` even on a
**fresh, untouched** array (that is the sibling reflection defect filed alongside
this). So `writable` is **unanswerable** there, and a standalone probe cannot
distinguish "dropped on store" from "unreadable".

**Measure on the HOST lane**, where `gOPD` is fully functional and a control
correctly reports `{value:3, writable:true}` on a fresh array. That is what
settled it.

A **two-step** probe (set `writable:false`, then define `value`) is ALSO ambiguous
between a `[[DefineOwnProperty]]` gap and a failure to store — use the
**single-step** form.

Validate probes against Node first; an in-sweep control is what caught the
confound here, not the pass count.

Found by `g-arraylen` 2026-08-01 while closing the blocking question on the
array-`length` routing fix. Gates a large share of the files that fix did not flip.
