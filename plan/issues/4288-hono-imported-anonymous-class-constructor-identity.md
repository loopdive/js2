---
id: 4288
title: "codegen: preserve imported anonymous-class constructor identity"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, modules
goal: dogfood
related: [1244, 3993, 4286]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/class-expression-identity.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/index.ts
  - src/codegen/property-access.ts
oracle-ratchet-allow:
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  - src/codegen/class-expression-identity.ts::exactClassExpressionTypeName
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/property-access.ts::resolveStructName
---

# codegen: preserve imported anonymous-class constructor identity

## Problem

The pinned Hono 4.12.16 entry compiles and validates after #4286, but its first
runtime route workload overflows the stack while constructing `new Hono()`.
Hono imports `SmartRouter`, `RegExpRouter`, and `TrieRouter`, each published as
`var X = class { ... }`. TypeScript exposes the anonymous class type under the
internal symbol name `__class`; the compiler's global string-keyed
`classExprNameMap` resolves that repeated name to the last registered class.
Consequently all three `new` expressions are lowered to Hono's own constructor,
recursing through `__anonClass_16_init` instead of constructing their distinct
import bindings.

Resolve direct constructor callees through their exact symbol/declaration
identity, including import aliases, before using display-name compatibility
fallbacks. Do not special-case package or class names.

## Acceptance criteria

- [x] A reduced multi-module regression fails before the fix and returns the
      same primitive result as JavaScript afterward.
- [x] The Hono workload constructs the published router classes without the
      recursive `__anonClass_16_init` stack overflow.
- [x] Existing class-expression, import-alias, and constructor suites remain
      green.

## Result

Constructor lowering now follows the exact checker declaration behind a direct
callee or import alias before consulting compatibility name maps. The reduced
multi-module case returns `42`, and Hono advances beyond its recursive
constructor overflow into the independently tracked heterogeneous-router array
carrier in #4290.
