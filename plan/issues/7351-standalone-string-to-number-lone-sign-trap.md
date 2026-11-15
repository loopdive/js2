---
id: 7351
title: "Standalone: converting the string \"-\" or \"+\" to a number traps instead of giving NaN"
status: ready
sprint: current
created: 2026-11-15
updated: 2026-11-15
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: runtime
goal: core-semantics
depends_on: []
related: [7340]
---

# #7351 — string-to-number conversion of a lone sign traps

## Problem

On `--target standalone`, converting a string that is only a sign to a number
traps with "array element access out of bounds". JavaScript answers `NaN`.

```js
var w = new Number("-");
if (w + 1 === w + 1) throw "x";   // node: NaN !== NaN, no throw; standalone: trap
```

The same happens for `"+"`. Found on 2026-11-15 by the adversarial review of
PR #7243 (main `36e87d6dc7`). It is not caused by that PR: main traps the same
way for `Number("-")`, `"-" * 1` and `+s` with `s = "-"`, all of which the IR
already claims.

## Implementation Plan

- The native string-to-number routine reads the character after the sign
  without checking the length. Find it (the standalone ToNumber helper for
  strings), add the bound check, and return `NaN` for a sign with no digits.
- One fix in the shared routine; no per-caller guard.
- Check the neighbours in the same routine with probes against node: `""`,
  `" "`, `"-"`, `"+"`, `"."`, `"-."`, `"e"`, `"1e"`, `"1e+"`, `"0x"`,
  `"-0x1"`, `"Infinity"`, `"-Infinity"`, `"+Infinity"`, `"infinity"`.

## Acceptance criteria

1. Every probe above answers as node does through `Number(s)`,
   `new Number(s)`, `+s`, `s * 1` and `parseFloat(s)` where applicable,
   compiled standalone on both the legacy and the IR route.
2. No test262 verdict regresses in any edition.
3. JS-environment output is byte-identical unless the same routine serves
   that lane; if it does, say so in the PR and show the verdicts.
