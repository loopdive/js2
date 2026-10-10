---
id: 6902
title: "`(a || b)(…)` calls `b` unconditionally — hono `testClient` ignores its custom `fetch` (fetch failed)"
status: done
sprint: current
created: 2026-10-07
updated: 2026-10-09
completed: 2026-10-07
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
related: [6900]
loc-budget-allow:
  # 2026-10-09 (#6902): logical-callee dynamic dispatch before the right-operand fallback (+18)
  - src/codegen/expressions/calls.ts
---

## Problem

hono `src/helper/testing/index.test.ts` was 1/5 with three rows failing
`fetch failed`. Not infra: native passes, and the Wasm lane really called the
global `fetch` against `http://localhost`. hono's client does

```js
return (opt?.fetch || fetch)(url, { … });
```

Reduced (untyped `opt`):

| callee | main | expected |
| --- | --- | --- |
| `(opt?.fetch \|\| fetch)("u")` | global fetch | `opt.fetch` |
| `(opt?.f \|\| other)("u")` | `other` | `opt.f` |
| `(opt?.fetch ?? fetch)("u")` | global fetch | `opt.fetch` |
| `const fn = opt?.fetch \|\| fetch; fn("u")` | `opt.fetch` | `opt.fetch` |

`compileExpressionCallee` (`expressions/calls.ts`) handles a non-LHS binary
callee. With no checker call signature (an `any` result), its last resort
compiled the whole callee for side effects, dropped the value, and then called
the RIGHT operand by a synthetic call — correct only for `(x = f)()`.

## Implementation Plan

Before the last resort, for `||` / `&&` / `??` callees, dispatch on the value the
expression actually produces via `tryEmitInlineDynamicCall` (the path a local
`fn(...)` already takes). Keep the old fallback when no dynamic dispatch can be
built.

## Resolution

Implemented as planned. hono `testing/index.test.ts` 1/5 → 4/5. The remaining
row (`$ws()` with `vi.stubGlobal('WebSocket', class {})`) is a separate defect.
Regression: `tests/issue-6900-hono-accepts-concurrent-client.test.ts`
(`pick({ fetch })`, with `pick({})` as the both-trees control).
