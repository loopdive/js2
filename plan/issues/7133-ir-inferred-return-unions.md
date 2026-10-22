---
id: 7133
title: "IR: seed homogeneous literal return unions with their primitive kind"
status: in-review
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/codex-session-b"
# 2026-10-22: classify pure inferred numeric/string literal unions at the
# return seed only; parameter and general union inference remain unchanged.
loc-budget-allow:
  - src/ir/propagate.ts
---

## Problem

On upstream main `0240742898df045800d3be3715e6ee62215467a5`, the
early-return example documented in **IR test262 harness units** (#7106)
still withdraws at `abi-signature-parity`:

```js
function g(a,b,c,d) { if (a > 2) return 1; return 0; }
```

TypeScript infers `1 | 0`. The outer Union flag is not NumberLike, so
`seedReturnType` seeds `dynamic`, which absorbs the numeric body evidence.
Legacy registers an f64 result. Pure string literal unions have the same
problem. Callers can then withdraw at `return-type-legacy-coupling` too.

## Scope and coordination

The atomic allocator verified this claim on upstream/issue-assignments with
a complete open-PR scan. PR #6863, **unannotated class methods returning one
literal kind resolve f64/string**, changes method selection; this task changes
checker-backed free-function return seeding, not that method selector.
Mixed, nullable, undefined-bearing and object unions keep their existing
inference. Parameter inference and explicit annotations keep their behavior.

## Acceptance and validation

- [x] Pure inferred numeric/string literal unions seed f64/string.
- [x] Mixed, nullish, fall-out and object unions keep dynamic seeds.
- [x] The documented four-argument example and signed fractional/string
      branches emit actual IR bodies and match legacy runtime values.
- [ ] Normal source gates and hooks pass; ready PR links this record.

Base regression test: 9 failures / 18 tests (3 return seeds and 6 body-emission
checks); all 9 boolean/mixed/nullish/object/enum/annotation controls pass. Both legacy and
fallback-enabled compiled execution already return the expected values.
No test262 population gain is measured by this small regression suite.

Candidate validation (Node 25.9.0): **176/176 tests pass across 8 files**,
including the final 18 tests in
`tests/issue-7133-inferred-return-unions.test.ts`, dynamic producers, integer
inference, dynamic undefined/string returns, and both fnctor fixpoint suites
that share `seedReturnType`. Both `g` and its caller `run` now emit IR bodies
in all six compile/run cases; legacy execution gives the same values.
The extra controls preserve numeric/string enums and explicit TS annotations.

The pre-push numeric-local suite exposed one stale shape assertion: a switch
with literal-union returns now emits IR, whose copy propagation replaces the
named `$ch` local with the unboxed switch slot. On the exact base compiler the
original suite passes 18/18; on the candidate only that name assertion fails.
The updated test in `tests/issue-3765-numeric-locals.test.ts` checks actual IR
emission, the existing f64/no-boxing operations, and all four runtime branches.

Typecheck, changed-file lint/format, LOC/function budgets, coercion and oracle
ratchets pass. The dead-export preservation gate passes its configured
contract; its existing open runtime graph still does not certify retirement.

Local Node 24.4.1 requires an exception-reference flag for existing try/catch
tests; those environment-only failures disappear on the installed Node 25.9.0.
The workspace mode of `check-issue-ids.mjs` has an existing path decoding
failure on this volume's space, and its committed mode reports an empty index.
The actual `check-committed-issue-integrity.mjs HEAD` gate scans 4981/4981
frontmatter-bearing files and passes. The allocator's full PR scan and the
separate against-main collision check also pass.
