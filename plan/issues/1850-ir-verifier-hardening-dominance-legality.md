---
id: 1850
title: "Harden the IR verifier into a hard between-pass contract (cross-block dominance + per-backend legality + fail-CI)"
status: in-progress
sprint: 61
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ir
language_feature: compiler-internals
goal: correctness
related: [1844, 1798, 1131, 1376, 1530]
---
# #1850 — Harden the IR verifier into a hard between-pass contract

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R1** (P1).

## Problem

`src/ir/verify.ts` (`verifyIrFunction`) already enforces a strong subset —
SSA single-definition, use-before-def *within* a block, one terminator per
block, branch-arg arity against target signatures, symbolic-refs-only — and
is already invoked pre/post-pass in `integration.ts`. This is the right
backbone, but it has documented gaps that let whole bug classes through:

1. **Cross-block use / dominance is a Phase-2 TODO.** The header comment in
   `verify.ts` explicitly defers "every use is dominated by its def" across
   blocks. Until it lands, an SSA value used on a path where it isn't
   dominated by its definition is invisible to the verifier.
2. **No nested-buffer recursion** — already filed as **#1844** (verify
   doesn't recurse nested `if`/`try`/`loop` buffers; return-type gate + SSA
   holes, residual of #1798). This issue is the umbrella; #1844 is one slice.
3. **No per-backend legality check.** The verifier validates "is this valid
   IR" but not "is this IR legal for *this* target." A node legal under the
   WasmGC backend but illegal under linear memory (or vice versa) is only
   caught downstream as a malformed-Wasm validation failure, far from the
   producing pass.
4. **Verifier failure feeds the fallback, but isn't gated.** A verify
   failure on a claimed function silently demotes to legacy; it should also
   surface as a hard-error (see #1853 / R6) so it can't mask a real IR bug.

## Recommendation

Treat the verifier as a hard contract: every pass assumes valid input and
must produce valid output; a verify failure is attributed to the producing
pass. Keep checks **local** (don't walk def-use chains for unrelated
invariants); when many passes re-check the same thing, push it into the
verifier or into the `IrType` (see #1851/R2).

## Acceptance criteria

- [x] `verifyIrFunction` checks **cross-block dominance** (every use is
      dominated by its def along all CFG paths), closing the Phase-2 TODO.
- [x] Nested if/try/loop buffer recursion lands (absorbs **#1844**). *(Already
      landed in #1844 — `nestedBuffers`/`forEachInstrDeep` in `verify.ts`; the
      new dominance pass reuses that traversal for the def-block map.)*
- [ ] A **per-backend legality pass** runs at the emit boundary for each
      `BackendEmitter` (WasmGC / linear / bytecode), rejecting IR that uses
      ops/types not legal for that target with a clear, localized error.
      *(Deferred — separate follow-up slice; spans all three emitters.)*
- [ ] In test/CI builds, a verifier failure on a **claimed** function fails
      the build (lands in the hard-error stability bucket of #1853), rather
      than silently demoting. *(Deferred — depends on #1853 / R6; separate
      slice.)*
- [x] Equivalence + test262 suites stay green; no new fallback-budget growth.
      *(Full IR test directory: zero new failures vs. main; multi-block
      experimentalIR compiles verify clean — no spurious demotions.)*

## Resolution — Slice 1: cross-block dominance (AC#1)

This PR lands **AC#1**, the headline Phase-2 TODO, in `src/ir/verify.ts`:

- **`computeDominators(func)`** — classic iterative dominator-set fixpoint over
  the block CFG (successors derived from each block's terminator). `dom[b]` is
  the set of blocks dominating `b` (b dominates itself); the entry block is
  `blocks[0]`; unreachable blocks keep the conservative full set (never a false
  violation). O(blocks²) — fine for the small functions the IR path claims.
- **`buildDefBlockMap(func)`** — maps every SSA value (instruction result, incl.
  nested-buffer results via the existing `forEachInstrDeep`, and block args) to
  the id of its defining/binding block.
- **`verifyBlock`** now accepts both and, for any use whose value is defined in a
  *different* block, accepts it iff that def-block dominates the using block;
  otherwise it reports `use of SSA value N ... is not dominated by its def in
  block M`. Applied to both instruction uses and terminator uses. Params,
  block args, and same-block earlier defs are handled by the existing local
  check (unchanged). Skipped only when block ids aren't contiguous (the id
  error already fires).

### Test Results

- `tests/issue-1850.test.ts` (6, all pass): dominated cross-block use accepted
  (diamond join); non-dominating def rejected with a dominance error;
  chained-dominator use accepted; single-block functions unaffected;
  block-arg-threaded values accepted.
- Full `tests/ir/` directory + `issue-1844` + frontend-widening + bytecode-proof:
  **zero new failures** vs. clean main (the 7 pre-existing failures —
  `__box_number`/`string_constants` harness link errors and a malformed-`func`
  scaffold test — are identical with and without this change, verified by
  stash-diff).
- Multi-block `experimentalIR` compiles (`if/return`, `if/else`, `for`-loop sum)
  all succeed — no function is spuriously demoted by the new check.

### Follow-up slices (remaining ACs, separate PRs)

- Per-backend legality pass at each `BackendEmitter` emit boundary.
- Fail-CI on verifier failure of a *claimed* function (ties to #1853 / R6).
