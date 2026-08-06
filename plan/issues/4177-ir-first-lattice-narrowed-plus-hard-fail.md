---
id: 4177
title: "IR-first hard-fails on lattice-narrowed `+`: selection claims a function off the fixpoint's f64 param fact, but from-ast `+` provability does not consume lattice facts"
status: in-progress
assignee: ttraenkler/claude-fable-5
loc-budget-allow:
  - src/ir/from-ast.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerFunctionAstToIr
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
goal: backend-agnostic-ir
related: [743, 4140, 2855, 1131]
origin: "2026-08-06 — found twice independently during the #743 seeding slice; reproduced on untouched origin/main"
---

# #4177 — IR-first hard-fails on lattice-narrowed `+`

## Problem

Reproduced on untouched `origin/main`, standalone target, default IR-first:

```ts
function addOne(n) { return n + 1; }
export function top(k: number): number { return addOne(k); }
```

hard-fails with **"'+' operands not provably both-number or both-string"**.

The mechanism is a split-brain between two IR stages:

- **Selection** admits `addOne` to the IR path because the interprocedural
  fixpoint (`src/ir/propagate.ts`, #1131) proves `n: f64` from the single
  call site (`k: number`).
- **from-ast's `+` provability** then re-derives operand types WITHOUT
  consuming the lattice's parameter facts — it sees an unannotated `n`,
  cannot prove both-number, and hard-fails — after the legacy body was
  already skipped, so there is no fallback.

One stage claims the function *because of* a fact the next stage refuses to
look at. Either from-ast must consume lattice param facts, or selection must
not claim on facts from-ast will not honor.

## Why it matters beyond the fixture

- The shape (`untyped helper called from a typed caller`) is ubiquitous in
  mixed TS/JS code and in every corpus the #743 program targets.
- **It blocks #743 flag-on adoption**: both the call-site narrowing flag and
  the `.d.ts` entrypoint-seeding flag (#4140) STEER MORE functions into this
  trap — each new lattice fact widens selection's claims without widening
  from-ast's provability. Recorded in #4140 as a reason its flag stays OFF.
- Hard-fail (not fallback) means a compile that used to succeed via the
  legacy body now fails outright — a regression class, not a perf issue.

## Fix directions (price both; the first is likely right)

1. **Feed lattice param facts into from-ast's provability** — the `TypeMap`
   is already computed before body lowering; from-ast's `+` proof should
   accept `param n` when the map's entry for the enclosing function types it
   f64. Aligns the two stages on one source of truth.
2. Alternatively, make selection's claim conditional on from-ast-provability
   (claim only what the weaker prover can re-derive). Cheaper but entrenches
   the weaker prover and forfeits fixpoint wins.

## Acceptance criteria

- [ ] The fixture above compiles standalone under default IR-first and
      returns 43 for `top(42)`.
- [ ] `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1` and `JS2WASM_DTS_ENTRYPOINT_SEEDS=1`
      no longer steer additional functions into the trap (spot-check the
      #4140 test fixtures flag-on).
- [ ] The "#743 flag stays OFF" blockers list in #4140's notes is updated.
- [ ] No `check:ir-fallbacks` unintended-bucket growth.

## Also recorded nearby (separate defect, needs its own issue)

`tests/issue-3486-fnctor-constructor-identity.test.ts` ("own fields and
enumeration are untouched…") fails on untouched `origin/main` (`ownKeys`
returns `''`) — unrelated mechanism, listed here only so it is not lost.
