---
id: 7373
title: "Loose `b == 1n` answers `false` for a BigInt held in an `any`"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [6642, 7371]
---

# #7373 — loose equality against a BigInt loses a dynamic BigInt operand

## Problem

Found while fixing #7371. On `origin/main` (ee3fcdd610), default and `--target standalone` alike:

```ts
function g(k: boolean): any { return k ? 1n : 2; }
g(true) == 1n;   // node true; we answer false
g(true) === 1n;  // true — strict equality is right (#6642)
```

The same holds for a `number | bigint` operand. A number on the dynamic side compares correctly
(`g(false) == 1n` with `g` returning `1` is true).

## Cause (as read, not yet traced to the line)

In `compileBinaryExpression` (`binary-ops.ts`) a BigInt against a statically non-BigInt operand takes the mixed
BigInt × Number loose-equality arm. That arm converts the dynamic side with ToNumber, so a BigInt value held in an
`externref` never reaches a BigInt comparison. The strict arm has the #6642/#7371 escape to the runtime
strict-equality helper; the loose arm has none.

## Acceptance criteria

- `==` / `!=` between a BigInt and an `any` / `unknown` / `number | bigint` operand answer like node, for a
  BigInt value and a number value on the dynamic side, on gc and standalone.
- Loose equality between statically BigInt and number operands (#1827) keeps its bytes.
