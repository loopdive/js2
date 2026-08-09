---
id: 3551
title: "IR ABI-parity withdrawal must cascade to committed IR callers — #3503 partial-commit broke tests/issue-3471.test.ts on main (invalid Wasm: expected f64, found externref)"
status: done
created: 2026-07-23
updated: 2026-07-24
completed: 2026-07-23
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: ir
goal: ir-full-coverage
sprint: 76
horizon: m
assignee: ttraenkler/senior-dev-3551
related: [3503, 3536, 3471, 3552, 1370, 3142]
# The growth is the fix itself, in the owning module: the cascade must sit
# between the pendingPatches collection loop and the apply loop (both in
# integration.ts's Phase 3), the fresh-slot ledger beside the allocation loop
# it annotates, and the stub pass beside the apply loop whose skipped patches
# it repairs. ~55 of the +81 lines are the rationale comments the parity
# guard's existing style requires.
loc-budget-allow:
  - src/ir/integration.ts
---

# IR ABI-parity withdrawal must cascade to committed IR callers

## Problem

`tests/issue-3471.test.ts` ("numeric args to isSameValue still compare
correctly (no over-fix)") went red ON MAIN with:

```
CompileError: Compiling function "check" failed: call[0] expected type f64, found call of type externref
```

Bisected (definitive): green at `6f95f9855fa5e6`, red at the #3503 merge
(`8507682f516375`). No required check runs untouched root test files, so the
regression landed silently (the CI-gap half is #3552).

## Root cause — half (b) of #3503, the abi-signature-parity withdraw

#3503 had two halves: (a) standalone-gated object-literal `expectedType`
routing in `literals.ts` (`ctx.standalone &&` — verified NOT implicated in
this host-lane failure), and (b) extending the IR patch-time typeIdx-parity
guard to top-level FunctionDeclarations with a soft "withdraw the claim"
fallback. (b) is responsible — but the withdrawal itself is correct; what was
missing is that it must not be **per-function**:

- Every IR body is compiled against `calleeTypes` — the IR's **shared view**
  of every claimed function's signature (built from the Phase-2 TypeMap
  overrides, `src/codegen/index.ts` ~line 2258 → `src/ir/integration.ts`
  ~line 318).
- The IR TypeMap legitimately types DEEPER than legacy inference: in the
  repro, `check(1, 1)` narrows `check`'s params to f64, and the TypeMap
  propagates f64 through `isSameValue(a, b)` → IR view `(f64, f64)`. Legacy
  (post-#3471) keeps the polymorphic comparator boxed: `(externref,
externref)`. The divergence is by design, not a bug.
- Pre-#3503, top-level functions were patched UNCONDITIONALLY, so the whole
  IR cluster committed together — mutually consistent (that unconditional
  patch is what broke legacy callers in #3536).
- Post-#3503, `isSameValue` withdraws on the typeIdx mismatch (legacy
  externref ABI kept) while `check` — whose OWN typeIdx matched — still
  committed its IR body, whose call args were baked for the now-dead
  `(f64, f64)` IR view. The stack-balance repair then mangled the call
  (observed final body: `local.get 0; call $__box_number; call $__box_number;
local.get 1; return_call $isSameValue` — arg 0 double-boxed, arg 1 raw f64)
  and instantiation failed.

**Invariant**: a pending IR patch may commit only if every function its body
references still carries the ABI the body was compiled against.

## Fix (this PR)

`src/ir/integration.ts`, patch phase:

1. Collect every name withdrawn by the typeIdx-parity guard (all three arms:
   class-member/module-init invariant, top-level soft withdraw) in
   `abiDivergentNames`.
2. **Cascade** (after the collection loop, before applying patches): withdraw
   any still-pending patch whose IR body references a withdrawn name — `call`
   targets and `closure.new` lifted-func refs, the only two `IrFuncRef`
   carriers. One level is a fixpoint: a cascade-withdrawn caller passed the
   guard itself (IR typeIdx == legacy typeIdx), so keeping its legacy body
   changes nothing about the ABI its own callers compiled against.
3. **Stub orphaned empty slots**: two slot families can be stranded bodyless
   when their owner fails after allocation — fresh slots (mono clones /
   lifted fns) and pre-allocated slots with an empty legacy body (a
   branch-hoisted nested declaration, the guard's empty-slot fall-through
   case, e.g. cascade-withdrawn because its body called a parity-withdrawn
   function). An empty body is invalid Wasm for any signature WITH results
   and can be reachable from a healthy owner's committed body. Fill with a
   lone `unreachable` — validates against every signature, localizes the
   failure to paths that actually enter the orphan. Empty VOID bodies are
   valid fall-through Wasm and are left as-is (no silent-no-op → trap
   conversion). This mitigates the one hazard class the cascade makes more
   frequent (it pre-exists for ordinary lower-stage owner failures).

Why not revert #3503: it fixed a real standalone defect (#3536) that stays
fixed (its guard + tests are untouched and still green). Why not withdraw at
overrideMap-build time instead: comparing IrType-vs-ValType signatures early
would need the Phase-3 resolver/registries (not yet built) and would
re-implement the canonical comparison `addFuncType` dedup already gives the
patch loop for free.

## Residual (pre-existing, NOT introduced here; follow-up candidate)

A claim that fails at **build/verify/lower** stage (not the parity guard)
also leaves `calleeTypes`-baked callers committed. If that function's IR-view
signature diverges from legacy, the same inconsistency arises — but at those
stages the IR typeIdx is unknown (never lowered), so the cascade can't know
whether the ABI diverged without lowering the `calleeTypes` signature via the
resolver (side-effectful type interning). This hole predates #3503 (it has
existed since `calleeTypes` was introduced) and did not cause this
regression; closing it should be its own issue if it ever fires.

Also observed while diagnosing (separate, masked): the stack-balance repair
pass "fixed" the two-arg coercion mismatch by inserting BOTH `__box_number`
calls after the first `local.get` (double-box + raw pass-through) instead of
one per operand — a positional-insertion bug in the repair, moot for this
regression once the cascade fires, relevant to #1918's strict-mode ambitions.

## Validation

- `tests/issue-3471.test.ts` — 7/7 green (was 6/7 on main).
- `tests/issue-3536.test.ts` — 5/5 green (the #3503 fix is preserved).
- `tests/issue-3551.test.ts` (new) — cascade fires, module instantiates,
  values correct, no over-withdrawal of healthy callees.
- `pnpm run check:ir-fallbacks` — OK, no bucket growth (the corpus has zero
  parity withdrawals, so the cascade adds nothing there).
- IR suites: ir-frontend-widening, ir-backend-emitter, ir-propagate-i32,
  ir-vec-two-backend, issue-1372/1374/1982, ir-if-else/let-const/numeric-bool/
  ternary/algorithms — green. (ir-scaffold 2 fails + ir-nullish-coalesce 3
  fails are PRE-EXISTING on main — verified by control run with unmodified
  `src/ir/integration.ts`.)
- Equivalence function/closure shards (10 files, 120 tests) — green.

Note: `tests/call-arg-type-coercion.test.ts` has 2 pre-existing failures on
main (present at #3503's parent) — deliberately NOT absorbed here.
