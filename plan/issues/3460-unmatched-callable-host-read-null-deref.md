---
id: 3460
title: "Uncatchable null_deref trap when a typed callable var (no matched closure sig) read off a host object is direct-called"
status: done
assignee: ttraenkler/dev-opus-arrayhof
completed: 2026-07-24
loc-budget-allow:
  # +8 lines: the fix broadens one guard condition in this god-file's
  # closure-recast-skip block and documents WHY (matched vs no-match externref
  # slot, #1941 dual-mode gating). The god-file was already at its ratchet
  # limit, so the necessary explanatory comment needs an explicit allowance.
  - src/codegen/statements/variables.ts
func-budget-allow:
  # Same +8 explanatory-comment lines land inside compileVariableStatement,
  # which was already at its per-function ceiling (#3400 / R-FUNC). The guard
  # broadening itself is net-zero; only the comment grows the function.
  - src/codegen/statements/variables.ts::compileVariableStatement
sprint: 76
created: 2026-07-19
updated: 2026-07-24
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: closures, host-callable-dispatch
es_edition: multi
goal: test262-conformance
related: [3432, 1941, 1712, 2873]
origin: "2026-07-19 fable-dev flag while fixing #3432/#3370 null_deref (CI-FIX #16). Pre-existing on main, NOT introduced by #3370."
---

# #3460 — direct-call of an unmatched typed callable var host-read null-derefs (uncatchable)

## Problem

Discovered while fixing the #3432/#3370 `null_deref` regression (CI-FIX #16).
That fix addressed the case where the decl-site closure-recast is **skipped
because a `matchedClosureInfo` was found** but the slot stays externref. There
is a **sibling residual, pre-existing on `main`** (NOT introduced by #3370 —
verified identical on a clean main checkout):

When a **typed callable variable has NO matching registered closure signature**
at its declaration, the recast is *also* skipped (the old code path). If that
variable holds a foreign/bridge-wrapped callable read off a **host object
property** and is then **direct-called**, the guarded root cast at the call
site nulls and `struct.get` executes on the null → `RuntimeError: dereferencing
a null pointer` — an **uncatchable** wasm trap where the spec wants a catchable
`TypeError`.

This is the same trap *shape* the #3370 fix repaired for the matched-sig case,
via a different decl path, so the #3370 `skippedClosureRecastDecls` mechanism
does not currently cover it.

## Root cause pointers (from the CI-FIX #16 investigation)

- Decl-site recast skip (no-match branch): `src/codegen/statements/variables.ts`.
- Direct-call host-dispatch gate: `calleeMayBeHostCallable` (#1941),
  `src/codegen/expressions/calls.ts:2352`; the missing `__call_function`
  host-fallback arm (#1712) is what leaves the null path reachable.
- The #3370 fix records **matched** skipped decls in
  `skippedClosureRecastDecls` (`src/codegen/context/types.ts`) so their
  call sites emit the #1712 arm. Extend the same per-decl mechanism to the
  **no-match** skip path (still `!standalone && !wasi`-gated to preserve the
  #1941 dual-mode / no-host-imports-in-pure-closure guarantee).

## Repro

A typed callable `var f` assigned from a host-object property whose value is a
bridge-wrapped function with no registered closure signature, then `f(...)`
direct-called. Expect a catchable `TypeError`; currently traps uncatchably.
(3-line repro to be distilled from the #3432 investigation notes.)

## Acceptance criteria

- [ ] The direct-call of an unmatched typed callable host-read yields a
      catchable `TypeError`, not a null-deref wasm trap.
- [ ] The #1941 dual-mode guarantee holds (no host imports pulled into pure
      closure programs).
- [ ] A scoped test covers the no-match direct-call path.

## Notes

Medium priority — it's a correctness/robustness gap (uncatchable trap where a
catchable error is required), but pre-existing and narrow. Extends the #3432
(#3370) fix. See CI-FIX #16 for the matched-sig sibling that is already fixed.

## Resolution (2026-07-24, dev-opus-arrayhof)

Fixed in `src/codegen/statements/variables.ts`: the #3432
`skippedClosureRecastDecls` recording fired only for the **matched-sig +
externref-slot** case. Broadened it to also record the **no-match** case — both
leave a raw externref in the slot that can hold a foreign / bridge-wrapped /
null callable, so both need `calleeMayBeHostCallable` to emit the #1712
`__call_function` host arm at direct-call sites. Without it the closure-struct
dispatch nulled the guarded root cast and `struct.get`-trapped "dereferencing a
null pointer" (uncatchable) where the spec wants a catchable TypeError.

- Repro (`const obj:any={}; const f:(x:number)=>number=obj.missingFn; f(10)`)
  now throws a **catchable** TypeError (was: uncatchable null-deref trap).
- #1941 dual-mode verified: pure-closure programs pull byte-identical host
  imports to clean main (the arm emission is `!standalone && !wasi`-gated, and
  pure local closures produce a closure STRUCT, not an externref, so they never
  enter this block). Zero new host imports.
- Scoped test: `tests/issue-3460.test.ts` (null-deref→TypeError flip + valid
  method/alias/bound-fn/pure-closure guards). Regression tests
  issue-3432/1712/2028/3488/2934 all pass.
