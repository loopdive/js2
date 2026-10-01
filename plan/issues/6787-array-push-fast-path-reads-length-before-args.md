---
id: 6787
title: "codegen: `Array.prototype.push` fast path reads the length before evaluating its arguments — re-entrant mutation in the argument is lost"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1143, 840]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H1"
---

# #6787 — `push` evaluates receiver, snapshots `len`, then evaluates the argument

## Problem

Reproduced 2026-09-30 (JS-host lane, diffed against Node):

| source | wasm | JS |
|---|---|---|
| `const a: number[] = []; const f = () => { a.push(1); return 2 }; a.push(f())` | `[2]` | `[1, 2]` |
| `const b = [1]; b.push(b.pop()!)` | `[1, 1]` | `[1]` |
| `const c = [5]; c.push(c.length, c.push(7))` | `[5, 7, 2]` | `[5, 7, 1, 2]` |

Spec order (§23.1.3.23): the receiver and **all arguments** are evaluated
before `push` runs; `len` is read inside `push`.

## Root cause

`src/codegen/array-methods.ts:4293-4299`: receiver compiled, then
`struct.get len → lenTmp`, then the argument expression is compiled. Any
argument that mutates the same array (or any array, via aliasing) sees the
stale `lenTmp` and its own writes are overwritten.

## Correction

Compile every argument into a temp local first (or in stack order before the
receiver's length read), then read `len`. For the single-scalar fast path
this is one extra `local.set`/`local.get` pair; the peephole already elides
`local.set x; local.get x` sequences where safe. Apply the same ordering
review to the other in-place fast paths that snapshot length before
arguments: `unshift`, `splice`, `fill`, `copyWithin`, `set`-style typed-array
writes (grep `lenTmp` / `struct.get.*len` in `array-methods.ts`).

## Acceptance

- The three rows above match Node.
- `tests/equivalence/array-push-reentrancy.test.ts` with the three cases plus
  a `push` inside a getter argument and a `push` from a `valueOf` on a boxed
  argument.
- `analyze-wat` on `a.push(x)` with a scalar `x` shows no extra call or
  allocation versus today (the fast path stays fast).
