---
id: 4177
title: "IR-first hard-fails on lattice-narrowed `+`: selection claims a function off the fixpoint's f64 param fact, but from-ast `+` provability does not consume lattice facts"
status: done
completed: 2026-08-06
assignee: ttraenkler/claude-fable-5
loc-budget-allow:
  - src/ir/from-ast.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerFunctionAstToIr
sprint: 78
created: 2026-08-06
updated: 2026-08-18
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

- [x] The fixture above compiles standalone under default IR-first and
      returns 43 for `top(42)`.
- [x] `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1` and `JS2WASM_DTS_ENTRYPOINT_SEEDS=1`
      no longer steer additional functions into the trap (spot-check the
      #4140 test fixtures flag-on).
- [x] The "#743 flag stays OFF" blockers list in #4140's notes is updated
      (the note lives in `plan/issues/743-whole-program-type-flow-analysis.md`
      "Known pre-existing issues" — marked RESOLVED by #4177).
- [x] No `check:ir-fallbacks` unintended-bucket growth.

## Results (2026-08-06, ttraenkler/claude-fable-5)

**Fix direction 1 implemented** — from-ast's `+` provability consumes the
fixpoint's facts. New module `src/ir/lattice-param-facts.ts` (kept out of the
from-ast god-file per the LOC budget); `proveAdditiveOperand` falls back to
`latticeAdditiveFact` when the checker says "unprovable".

### Why it is sound (the WHY, not just the WHAT)

Two fact sources, both exactly "the same map selection used" — no new
inference:

1. **Param facts** (`collectLatticeParamFacts`): a parameter's RESOLVED IR
   type from `lowerFunctionAstToIr`'s own `resolveIrType` call, which forces
   any explicit annotation to `irTypeEquals`-agree with the
   `paramTypeOverrides` entry (= `latticeToIr` of the fixpoint atom:
   f64 atom → val f64, string atom → `IrType.string`; the bool atom is
   i32-branded and deliberately unmapped — the Row-7 boolean trap). So
   val-f64 ⇒ "the claim was made on a number-typed param", period.
   - **Keyed by the parameter DECLARATION node, looked up through the
     checker's symbol** — a shadowing local resolves to a different
     declaration and can never match (pinned by test).
   - **Only never-written params**: the fixpoint atom describes INCOMING
     call-site values (propagate.ts's walk does not model reassignment), so
     the exclusion scan (`collectWrittenNamesIncludingNested`) sees through
     nested-function boundaries — a closure-mediated write also drops the
     fact. Over-approximation is conservative.
   - **Outer function only**: lifted-closure contexts omit the map because a
     captured param could be written by a sibling closure between outer read
     sites.
2. **Direct-call return facts**: `cx.directCalls` plan signatures exist only
   for CLAIMED callees whose overrides resolved (`signaturesByUnitId` =
   `overrideMapByUnitId`), and suspending-async/generator/Promise-delay
   returns are already projected to externref/extern there — so a val-f64
   plan return is the certified numeric fulfillment the call lowering itself
   emits. This is what fixes the recursion shape (`fib(n-1) + fib(n-2)`),
   which also hard-failed on main (unprovable/unprovable).

### Evidence

- Fixture: compiles standalone default IR-first, `top(42) === 43`; fib
  recursion `top(10) === 55`; string-lattice param concat works standalone
  (`length` 3) and host (`"hi!"`). Conflicting-sites param: union atom → not
  claimed → clean legacy fallback preserved (`ta(41) === 44`, concat + add
  both correct). Mutated-param and shadowing-local variants pinned. All in
  `tests/issue-4177-lattice-plus-provability.test.ts` (7 tests, green).
- `check:ir-fallbacks`: exit 0, **zero deltas** (no unintended growth; no
  reduction either — the playground corpus doesn't contain the trap shape).
- #743/#4140 flag-on: `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1
  JS2WASM_DTS_ENTRYPOINT_SEEDS=1 vitest issue-743-dts-entrypoint-seeds +
  issue-743-ctor-sites-in-fixpoint` — 12/12 green.
- Acorn dogfood: canaries 2, 3, 4, 5; `functionImports: []`; IR-FALLBACK
  count exactly **3 (unchanged)**; optimized binary **byte-identical
  (874,138 B)** to a baseline compile in the same container.
- **Parity-fallback verdict (#1712 adjacent): NOT resolved, as predicted.**
  The 3 "function typeIdx parity mismatch" fallbacks
  (parse/parseExpressionAt/tokenizer, IR 466/467 vs legacy 101/102/104) are
  identical before/after — that defect is signature-level (`options` shape
  struct vs externref), not body provability. Bounded look only.
- **A/B (`standaloneDynamic`): not run — wash by construction.** The
  benchmark corpus (acorn) compiles to a byte-identical binary with the fix
  (same claim set, same 3 fallbacks), so the two lanes would measure the
  same artifact. Routing changes only for programs that previously
  HARD-FAILED (they didn't have perf before) or fell back in
  non-IR-first modes.
- Gates by exit code: tsc 0, lint 0, oracle-ratchet 0, loc-budget 0 (grant
  `src/ir/from-ast.ts`, +27 net after extraction), func-budget 0 (grant
  `lowerFunctionAstToIr`, +3 wiring), dead-exports 0, coercion-sites 0,
  stack-balance 0, check:ir-fallbacks 0, prettier 0.
- Suites: equivalence/ir-* 45/45; tests/ir-* 295 passed, **14 pre-existing
  failures in 4 files (`ir-bytecode-wasmgc-vm`, `ir-scaffold`,
  `ir-vec-new-fixed`, `ir-nullish-coalesce`) — A/B-verified identical on
  baseline from-ast in this container**, not from this change. #4155 suites +
  propagation identity: 29/29.

### Known remaining gap (candidate follow-up)

`const m = n; return m + 1;` (a LOCAL initialized from a proven param) still
hard-fails — the local's fact would require flow inference the name-keyed
TypeMap does not carry, explicitly outside this fix's "only facts the
fixpoint proved" scope. One hop from the fixed shape; worth its own issue if
it shows up in corpora.

## Also recorded nearby (separate defect, needs its own issue)

`tests/issue-3486-fnctor-constructor-identity.test.ts` ("own fields and
enumeration are untouched…") fails on untouched `origin/main` (`ownKeys`
returns `''`) — unrelated mechanism, listed here only so it is not lost.
