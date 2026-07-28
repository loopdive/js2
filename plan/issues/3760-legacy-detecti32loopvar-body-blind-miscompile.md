---
id: 3760
title: "legacy detectI32LoopVar promotes a for-counter without inspecting the loop body — a non-integer assignment to the counter silently truncates and changes the iteration count (wrong answer, not a crash)"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: correctness
area: codegen
language_feature: loops
goal: core-semantics
depends_on: []
related: [1120, 1236, 3734, 3741]
---

# #3760 — legacy `detectI32LoopVar` is body-blind: assigning a non-integer to the counter miscompiles

## Summary

`detectI32LoopVar` (`src/codegen/statements/loop-analysis.ts:20-78`) decides to
store a `for` counter in a native i32 local based **entirely on the loop
head's syntactic shape** — initializer is an integer literal, condition is
`i < EXPR`, incrementor is `i++`/`i--`/`i += INT`. It never inspects the loop
**body**. If the body assigns a non-integer value to that same counter, the
value is silently truncated to i32 on every write, which changes how many
times the loop runs.

This is a **wrong-answer** bug in the legacy AST-direct codegen path, not a
crash or a compile error.

## Reproduction

```ts
export function part(n: number): number {
  let t = 0;
  for (let i = 0; i < 10; i++) {
    i = i + n; // non-integer write to the promoted counter
    t = (t + 1) | 0;
  }
  return t;
}
```

Measured directly (compile → instantiate → call), 2026-07-28 against
`origin/main`:

| input       | JS (correct) | IR path | legacy path  |
| ----------- | ------------ | ------- | ------------ |
| `part(0.5)` | 7            | 7 ✅    | **10** ❌    |
| `part(0.25)`| 8            | 8 ✅    | **10** ❌    |
| `part(0.1)` | 10           | 10 ✅   | 10 ✅        |
| `part(1.5)` | 4            | 4 ✅    | **5** ❌     |

Legacy is wrong on 3 of 4 inputs. The IR path is correct on all of them
(#3741's `planI32Slots` rejects this binding because its producibility check
requires every write to lower to an exact i32 — `i + n` for a `number` `n`
cannot, so it simply isn't promoted).

`part(0.1)` agreeing is a coincidence, not a partial correctness: `0.1`
accumulates slowly enough that both truncated and untruncated runs happen to
reach the bound in 10 iterations.

## Why it happens

`detectI32LoopVar` returns `{name, initValue}` purely from the head shape:

- initializer: single decl, identifier, integer-literal init in i32 range
- condition: `i </<= EXPR` or `EXPR >/>= i`
- incrementor: `i++`, `++i`, `i--`, `--i`, `i += INT`, `i -= INT`

Nothing in it walks `stmt.statement`. Once the counter is in an i32 local,
the body's `i = i + n` compiles as a truncating store, so the fractional part
is discarded each iteration and the counter advances faster than JS
semantics require.

This is the same class of gap #1236 already hardened `collectI32CoercedLocals`
against for regular locals (that analysis *does* examine every write and
excludes `+`/`-`/`*` from the safe-to-promote set precisely because a
non-truncated sum is not i32-safe). The **counter** path never got the same
treatment — it predates / sits beside that hardening.

## Scope of impact

Legacy is still the fallback path for every function the IR selector rejects,
so this is live in shipped output, not dead code. The shape required to hit it
is narrow (a body that assigns a *non-integer* to the loop counter itself,
rather than to a separate variable), which is presumably why it has gone
unnoticed — but when hit it produces a silently wrong result with no
diagnostic.

## Suggested fix

Make `detectI32LoopVar` body-aware: reject the promotion when the loop body
contains any assignment to the counter whose RHS is not provably an exact
int32. The machinery already exists — `collectI32CoercedLocals`'s
`isI32SafeExpr` is exactly this predicate, and #3741 extracted it into a pure,
dependency-free module (`src/codegen/analysis/i32-coerced-locals.ts`), so
`loop-analysis.ts` can import it without an import cycle.

Conservative alternative if that proves fiddly: reject whenever the body
assigns to the counter at all (beyond the incrementor). Loops that reassign
their own counter mid-body are rare enough that the lost optimization is
cheap, and correctness is the priority.

## Acceptance criteria

- [ ] `part(0.5)` / `part(0.25)` / `part(1.5)` above return the same values on
      the legacy path as on the IR path and real JS.
- [ ] A regression test asserting legacy == IR == JS for a counter mutated
      in-body with a non-integer, including `+=`, direct assignment, and a
      compound-assign form.
- [ ] Loops that do *not* mutate their counter in-body still get the i32
      promotion (no perf regression on the common shape — check the emitted
      `.wat` still uses `i32.lt_s`/`i32.add`, not just that tests pass).
- [ ] Equivalence suite shows no new failures.

## Provenance

Surfaced while writing regression tests for #3741 (native i32 slot storage on
the IR path). Independently reproduced against `origin/main` before filing.
Deliberately **not** fixed as part of #3741 — that PR changes the IR path and
this is a legacy-path defect with its own blast radius; bundling them would
mix a performance change with a correctness fix in one review.
