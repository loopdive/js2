---
id: 1930
title: "a?.[i] compiled as plain a[i]: index side effects fire and no undefined result on nullish base"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: optional-chaining
goal: core-semantics
related: [1929, 1931]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #1930 — optional element access `a?.[i]` is lowered identically to `a[i]`

## Problem

`ElementAccessExpression` with `?.` ignores the optional marker entirely. On a
nullish base, the index expression (and its side effects) still evaluates, and
the result is not `undefined` — violating
[§13.3.9 Optional Chains](https://tc39.es/ecma262/#sec-optional-chains).

## Repro (verified on main)

```ts
let log = 0;
function mark(k: number): number { log = log * 10 + k; return k; }
function getArr(b: boolean): number[] | null { return b ? [4, 5, 6] : null; }
export function t4(): number {
  log = 0; const a = getArr(false);
  const r = a?.[mark(2)];   // spec: a nullish → undefined, mark NOT evaluated
  return log;
}
```

| probe | wasm | node |
|-------|------|------|
| `t4` (side-effect trace) | `2` (index evaluated) | `0` |
| `log*10 + (r===undefined?1:0)` | `20` | `1` |

## Root cause

`compileElementAccess` (`src/codegen/property-access.ts:3590` onward) never
consults `expr.questionDotToken` — the only optional handling in that file is
for PropertyAccessExpression (line 1258). An optional element access is lowered
identically to `a[i]`: base compiled, then either `emitNullCheckThrow`
(3770-3777) or the externref read; the index expression is compiled
unconditionally either way.

## Fix direction

At the top of `compileElementAccess`, branch on `expr.questionDotToken`: tee the
base into a local, `ref.is_null`/undefined-check, and compile the index + read
only in the non-null arm — mirroring `compileOptionalPropertyAccess`. The
short-circuit result value shares #1931's undefined-representation question.

## Acceptance criteria

- `a?.[i++]` with nullish `a` does not evaluate `i++`
- Result of short-circuited `a?.[i]` is undefined-equivalent (with #1931)
- Non-nullish bases unchanged; equivalence suite green
- test262 `optional-chaining` element-access cases net positive

## Dupe check

Grepped `?.\[`, `optional element` over plan/issues/ — zero hits.
