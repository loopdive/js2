---
id: 4055
title: "LEVER 1 — property-descriptor model in standalone: 835 ≤ES5 failures across defineProperty/defineProperties/create/gOPD"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: standalone
language_feature: n/a
goal: standalone-mode
---
# LEVER 1 — property-descriptor model in standalone: 835 ≤ES5 failures across defineProperty/defineProperties/create/gOPD

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Measured 2026-08-01** from the standalone baselines JSONL (`test262-standalone-current.jsonl`, run `20260801-010858`), scoped to ≤ES5 via `es5id:` frontmatter in the test262 corpus (8,262 files carry it; 8,115 official ran).

**Instrument validated first**: the same script reproduces the published default-lane figure exactly (30,500/43,096 = 70.8%), so the scoping and `scope_official` filter are correct. ≤ES5 standalone baseline = **5,652 pass / 8,115 run (69.6%)**, 2,463 failures.

**This lever, by area (fail/run):**

| area | fail/run | rate |
|---|---|---|
| `built-ins/Object/defineProperty` | 337/1113 | 30.3% |
| `built-ins/Object/defineProperties` | 272/620 | 43.9% |
| `built-ins/Object/create` | 152/314 | 48.4% |
| `built-ins/Object/getOwnPropertyDescriptor` | 35/305 | 11.5% |
| `built-ins/Object/prototype` | 23/103 | 22.3% |
| `built-ins/Object/isExtensible` | 16/36 | 44.4% |
| **total** | **835** | |

**Top signatures:** 67× `TypeError: Object.defineProperties unsupported descriptor shape in standalone mode (#N)` — an explicit codegen refusal, so the standalone descriptor path is deliberately incomplete rather than subtly wrong. Then 55× `accessed !== true`, 44× `Expected true but got false` (preventExtensions), 42× `data Expected SameValue`, 29× `Expected obj[N] to be writable, but was not`, 26× `desc.writable Expected SameValue`.

**Why this is the biggest lever:** it is 34% of all ≤ES5 standalone failures, concentrated in ONE subsystem, and the largest single signature is a named refusal — meaning the work is "implement the missing descriptor shapes", not "hunt an unknown bug".

**⚠️ Sizing caution — 835 is the population GATED, not the number that will FLIP.** Many of these tests assert several descriptor properties; fixing the refusal may expose a second-order failure in the same test. Before quoting a flip estimate, take a sample of ~40, fix, and measure the actual flip rate — then extrapolate with that ratio and state it.

**Check for overlap first** with tasks #28/#29/#30 (#3661/#3662/#3663 — writable/configurable read wrong in the DEFAULT lane) and #19 (#739 S2 descriptor `[[Get]]` fidelity, which has a validated fix already parked on a branch). Those are default-lane descriptor defects; this is the standalone refusal. They may share a root cause — establish that before doing the work twice.
