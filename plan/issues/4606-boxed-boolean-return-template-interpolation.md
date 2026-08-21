---
id: 4606
title: "Boxed boolean returned from a mixed-return function prints as 1 in template interpolation"
status: ready
sprint: current
created: 2026-08-21
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: template-literals
goal: core-semantics
related: [4121]
origin: "#4121 slice 2 (PR #4720) negative-test writing; reproduces at the branch base and with every JS2WASM_NUMERIC_* kill switch off — pre-existing, unrelated to that slice"
# id 4606 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: the only open PR was 4720, which introduces
# no new issue files.
---

# #4606 — boxed boolean from a call prints `1` under template interpolation

## Problem

A function whose return sites mix `boolean` and `number` returns a boxed
(dynamic-carrier) value. Interpolating that value in a template literal
stringifies it as its numeric payload, not its boolean identity:

```js
function m(x) {
  if (x > 5) return true;
  return x + 1;
}
var v = m(9);
console.log(`${v}`.length);
```

| engine | `${v}` | `.length` |
| --- | --- | ---: |
| node | `"true"` | 4 |
| js2 | `"1"` | **1** |

This is NOT the usual f64-carrier trap: `v` is boxed (the mixed return
forces the dynamic carrier), and a direct `var v = true; \`${v}\`` prints
`true` correctly. The loss happens when the boxed value flows from a call
result into template stringification — the boolean tag is dropped and the
payload is stringified as a number.

Found while writing negative tests for #4121 slice 2 (PR #4720). Reproduces
identically at that branch's base commit and with `JS2WASM_NUMERIC_RETURNS=0`
and `JS2WASM_NUMERIC_ADMISSION=0` — so it is pre-existing and independent of
the numeric-return inference work.

## Acceptance criteria

- [ ] The repro above prints `4` (matching node) in JS-host mode.
- [ ] A regression test pins the repro plus the near-miss cases that already
      work (`var v = true` interpolated directly; a boolean-only-return
      function's result interpolated).
- [ ] Root cause recorded here: where the boolean tag is dropped
      (box/unbox path vs the template-literal ToString lowering).
- [ ] No equivalence regressions.
