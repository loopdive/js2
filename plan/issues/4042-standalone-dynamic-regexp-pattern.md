---
id: 4042
title: "Standalone refuses a dynamic RegExp pattern — 'Unsupported dynamic regular expression pattern' plus the RegExp.prototype residual"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-mode
related: [1781, 4040]
---

# Standalone refuses a dynamic RegExp pattern — 'Unsupported dynamic regular expression pattern' plus the RegExp.prototype residual

## Problem

**~35 goal-scope host-pass ∧ standalone-fail files** (part of #4040). Signature:

```
 10  TypeError: Unsupported dynamic regular expression pattern
 35  (area) built-ins/RegExp/prototype
```

The standalone RegExp backend handles statically-known patterns but refuses one
built at run time.

## ⚠ This is NOT the search-value refusal — that one is fixed

**#4016 landed (PR #3996, merged `68d74d66d`, +35 goal-scope flips)** and covered
`String.prototype.{search,match,split,…}` falling through to the spec's `ToString`
path. Its proof that a runtime-built pattern *can* work is directly relevant here:
a standalone probe of `new RegExp("A"+"B").exec("ssABB")` returns `["AB"]` at
index 2 — **the backend has supported runtime-string patterns since #2161**.

So "dynamic pattern" refusals may be over-broad in the same way #4016's gate was:
the compiler treating *"not a statically-known backend RegExp"* as *"needs a JS
host"*. **Check whether the refusal is still load-bearing before implementing
anything** — it may be removable, as #4016's partly was.

Related landed/known: #1474 (RegExp standalone, `done` but still cited 43× in
goal scope — see the regression note in #4040), #1539, #682 dual RegExp backend.

## ⚠ Sizing

Two cuts already measured on the adjacent cluster, **stated separately and never
summed**: the search-value refusal was ~98 all-official / 51 goal-scope by two
independent methods. Expect the same divergence here; report both.
