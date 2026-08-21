---
id: 4607
title: "(typeof u).length answers NaN instead of 9 for an undefined variable"
status: ready
sprint: current
created: 2026-08-21
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: typeof
goal: core-semantics
related: [4121]
origin: "#4121 slice 2 (PR #4720) negative-test writing; reproduces at the branch base and with every JS2WASM_NUMERIC_* kill switch off — pre-existing, unrelated to that slice"
# id 4607 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: the only open PR was 4720, which introduces
# no new issue files.
---

# #4607 — `.length` on a `typeof` result is `NaN` for `undefined`

## Problem

```js
var u;
console.log((typeof u).length);
```

| engine | `typeof u` | `.length` |
| --- | --- | ---: |
| node | `"undefined"` | 9 |
| js2 | — | **NaN** |

No call and no boolean is involved — the `typeof` result (a string) fed
directly into `.length` produces `NaN`, which suggests the member access is
lowered against a non-string carrier for the `typeof`-of-undefined case
(the other `typeof` results may or may not share the defect; the fix should
census all of them).

Found while writing negative tests for #4121 slice 2 (PR #4720). Reproduces
identically at that branch's base commit and with `JS2WASM_NUMERIC_RETURNS=0`
and `JS2WASM_NUMERIC_ADMISSION=0` — pre-existing and independent of that work.

## Acceptance criteria

- [ ] The repro prints `9` (matching node) in JS-host mode.
- [ ] A regression test covers `.length` on `typeof` of: an undeclared-value
      `var`, a number, a string, a boolean, an object, a function — all
      matching node.
- [ ] Root cause recorded here (where the `typeof` result loses its string
      carrier before the member access).
- [ ] No equivalence regressions.
