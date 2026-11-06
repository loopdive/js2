---
id: 7279
title: "IR: default-initialised parameters (`function f(a, b = \"\")`) refused as `param-shape-rejected`"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7254, 7268]
assignee: "ttraenkler/c-lead"
---

# #7279: default-initialised parameters refused as `param-shape-rejected`

## Problem

The harness function `formatPropertyName(propertyKey, objectName = "")`
(`test262/harness/temporalHelpers.js:12`) refuses as `param-shape-rejected`
(a default-initialised parameter). On main's wrapped stride-40 standalone
ledger it is the second of exactly two legacy units in 66 files (paired with
the test's module-init storage refusal; 69 parts overall).

## Measurement

(in progress)
