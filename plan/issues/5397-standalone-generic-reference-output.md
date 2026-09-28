---
id: 5397
title: "Preserve generic reference values in standalone console output"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: bug
area: compiler
goal: correctness
parent: 5393
assignee: "ttraenkler/codex-anyref-output"
---

## Measured defect

`const m = new Map(); m.set("x", 1); console.log(m.get("x"));`
prints `1` in Node and the host target, but a blank line in standalone with
both optimization settings. Symbol-keyed string reads have the same defect.
The stdout sink drops the generic `anyref` carrier returned by native Map.get,
even though its existing stringifier accepts that carrier.

## Acceptance criteria

- [x] Pass generic references to the existing native stringifier.
- [x] Compare numeric, string, missing, and boolean-valued reads against Node.
- [x] Preserve boolean and scalar controls with zero standalone imports.
- [x] Verify normal and optimized execution.

This change covers primitive values carried in generic references. It does not
claim that standalone object inspection matches every Node console formatting rule.

## Implementation and validation

The native console sink now admits the generic reference carrier and invokes
its existing stringifier. Eight focused tests pass across unoptimized and
optimized standalone execution, asserting zero imports. These primitive-value
controls do not certify Node-style inspection of arbitrary nested objects.

Exact baseline/candidate rows and final validation are recorded in the
[general JavaScript audit](../audit/javascript-soundness-2026-09-08/README.md).
