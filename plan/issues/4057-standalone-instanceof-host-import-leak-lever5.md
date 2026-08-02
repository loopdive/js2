---
id: 4057
title: "LEVER 5 — `instanceof` leaks a host import in standalone: `env::__instanceof_check` refused, ~94 ≤ES5 failures"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: feature
area: standalone
language_feature: n/a
goal: standalone-mode
---
# LEVER 5 — `instanceof` leaks a host import in standalone: `env::__instanceof_check` refused, ~94 ≤ES5 failures

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Measured 2026-08-01**, standalone lane, ≤ES5 scope.

| area | fail/run | rate | top signature |
|---|---|---|---|
| `language/expressions/instanceof` | 24/34 | 70.6% | `standalone target emitted host imports: env::__instanceof_check (#N)` |
| `built-ins/RegExp/prototype` | 47/126 | 37.3% | `The result of evaluating (e instanceof TypeError) is expected to be true` |
| `built-ins/Number/prototype` | 23/72 | 31.9% | same `e instanceof TypeError` shape |

**36 records** carry the explicit refusal `standalone target emitted host imports: env::__instanceof_check`.

**Why this is smaller but high-leverage per unit of work:** it is a *single missing primitive*. `instanceof` currently routes through a JS host import, which the standalone leak guard (#2961, `status: done` — the guard is working correctly here) refuses. Implementing a Wasm-native `__instanceof_check` should clear the direct `instanceof` tests AND unblock the much larger population of tests that merely *assert* `e instanceof TypeError` inside an otherwise-unrelated test — which is why RegExp and Number prototype failures show this signature.

That second-order effect is the interesting part: **`instanceof` is used as an assertion primitive throughout test262**, so a native implementation may flip tests well outside `language/expressions/instanceof`. Conversely the ~94 figure may *undercount* the reachable population.

**Measure it properly:** implement, then diff the whole ≤ES5 standalone slice rather than just the instanceof directory — and prove attribution by reverting, since a change to a primitive this widely used will co-move with anything else landing concurrently.

Depends on nothing else in levers 1–4; safe to run in parallel.
