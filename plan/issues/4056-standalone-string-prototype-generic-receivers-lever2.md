---
id: 4056
title: "LEVER 2 — `String.prototype` generic receivers in standalone: 218/630 ≤ES5 failures (34.6%)"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: standalone
language_feature: n/a
goal: standalone-mode
---
# LEVER 2 — `String.prototype` generic receivers in standalone: 218/630 ≤ES5 failures (34.6%)

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Measured 2026-08-01**, standalone lane, ≤ES5 scope (`es5id:` frontmatter). `built-ins/String/prototype`: **218 fail / 630 run = 34.6%**.

Top signature: 31× `TypeError: Cannot access property on null or undefined at N:N`, e.g. `test/built-ins/String/prototype/match/S15.5.4.10_A2_T17.js`.

**Likely the standalone twin of an already-solved default-lane problem.** Task #21 (`#2742` + the `missing_builtin` family — `String.prototype` generic receivers, 87 + 58 failures) is marked **completed** for the DEFAULT lane. This is the same feature area failing in standalone, so the first move is to establish whether #2742's fix simply never reached the standalone path, or whether standalone needs a different lowering.

**Do that check before writing code** — if it is a routing gap the fix may be small, and sizing it as fresh work would be wrong.

**Sizing caution:** 218 is the failing population in this directory, not a flip estimate. Sample and measure the flip ratio before quoting a number.

Cross-check #3571 (task #11) — `Function.prototype.call/apply/bind` on builtin methods, the uncurryThis/propertyHelper blocker — since generic-receiver dispatch and uncurried builtin methods touch the same seam.
