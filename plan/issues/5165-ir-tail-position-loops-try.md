---
id: 5165
title: "IR: adopt tail-position loops and try/catch that return from the body (`tail-unhandled` residual of #2952)"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: adoption
area: ir
language_feature: statements
goal: ir-full-coverage
related: [2952, 3583, 3518]
origin: "2026-08-28 IR-takeover session — tail-unhandled residual; scout probes in .tmp/tailcf-*.ts"
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# #5165 — IR adoption of tail loops and try/catch with body returns

## Problem

Measured 2026-08-28 (probes `.tmp/tailcf-*.ts`):

| shape | result |
| --- | --- |
| function ENDS in for/while/do whose body returns | REJECT `tail-unhandled:For/While/DoStatement` |
| same loop + trailing return AFTER it (nontail) | CLAIMS+EMITS — body early-returns already lower via early.return; ONLY the loop-as-last-statement case rejects |
| return at if-depth-2 inside a nontail loop | CLAIMS+EMITS — nesting depth is not a factor |
| tail try/catch or try/finally where try returns | REJECT `tail-unhandled:TryStatement` (the tail gate has NO Try arm) |
| NONTAIL try/catch where the catch returns | REJECT `body-return-context:ReturnStatement` — a different arm: the try barrier at select.ts:3865 is UNCONDITIONAL, even finally-less |
| `catch {}` no binding, no returns | CLAIMS+EMITS — the adoption table's "catch clause with no binding" residual is STALE |

KEY MEASURED FACT: the tail-loop residual is NOT a CFG problem — body-position
early returns inside loops already claim, lower (early.return → Wasm `return`,
which natively unwinds loop blocks), and emit. What is missing is (a) a tail
arm in `isPhase1Tail`, and (b) completion semantics for the after-loop
position.

### Gate sites (read 2026-08-28)

- `src/ir/select.ts:3757` — tail/nontail partition (only the LAST statement is the tail).
- `src/ir/select.ts:4952-5100` — `isPhase1Tail` handled kinds: Return (4959), Block (4970), If (4973; void-only no-else guard 4974-4982), Throw (5002), void ExpressionStatement (5009), Switch (5091, #2952 6a). Catch-all `shapeNo("tail-unhandled")` at 5100.
- `src/ir/select.ts:4941-4942` — body-buffer return guard: returns admitted only inside a C-style loop with no enclosing barrier.
- `src/ir/select.ts:3865` — `isPhase1TryStatementInScope` increments `earlyReturnBarrierDepth` UNCONDITIONALLY; its own comment only justifies barring finally-CROSSING returns.
- `src/ir/from-ast.ts:2169-2172` — tail-switch lowering pattern (lowerStmt + terminator) to copy; `noEarlyReturn: true` at 14073/14103 (14127 finally-cx stays barred); `switchAllPathsTerminate` at select.ts:5121 and `thenArmTerminates` are the termination-proof models.
- Constructor field-init and module-init contexts reset `earlyReturnBarrierDepth=1` (select.ts:1356, 9846).

## Implementation Plan

**Fable lane, 2026-08-28.** Opus implements slice-by-slice; three mechanical
slices on existing machinery, one real slice split out, one docs fix.

### S1 (S) — tail for/while/do

`isPhase1Tail` arm delegating to the existing
`isPhase1ForStatement`/`isPhase1WhileStatement`/`isPhase1DoStatement` (they
already increment `earlyReturnLoopDepth`, so body returns are admitted for
free). Void functions: accept unconditionally — fall-through lowers to
`return []`, mirroring the tail-if-noelse void arm at 4974-4982. Non-void:
require a new ~30-line `loopNeverFallsThrough` proof modeled on
`switchAllPathsTerminate`:5121 — condition absent (for) or literal `true` AND
no break binding THIS loop. THE BREAK SCAN MUST RESPECT NESTING: `while(true){
if(x) return 1; break; }` falls through; a condition-only check would emit
`{kind:'unreachable'}` on a reachable path — a runtime trap where JS returns
undefined (silent correctness bug under Wasm validation). Unlabeled break binds
the innermost loop/switch. `lowerTail` arm copies the tail-switch pattern at
2169-2172 exactly: lowerStmt(loop) then terminate(void ? {return,[]} :
{unreachable}).

### S2 (S/M) — returns inside finally-LESS try/catch (nontail)

Make the selector barrier at 3865 conditional on `stmt.finallyBlock !==
undefined` (Wasm `return` is not intercepted by exception handlers; only
finally-crossing returns need barring). Generalize the 4941 guard so a return
directly inside a try/catch body buffer at loop depth 0 is admissible (a
bufferDepth counter the try checker increments, or an explicit
in-try-no-finally allowance). Mirror in the lowerer: relax `noEarlyReturn:
true` at from-ast 14073/14103 to only-when-finally-present-or-already-barred.
DEPTH SEMANTICS must hold: a no-finally try nested inside a finally-bearing try
(or a for-of iterator body — increments at 9991/10068/10163) stays barred
because barrier is a depth counter.

### S3 (M, after S2) — tail try/catch

`isPhase1Tail` Try arm delegating to `isPhase1TryStatement`; void may fall
through; non-void needs an all-paths-terminate proof (last statement of try
block AND catch block terminates, via the existing `thenArmTerminates` — same
shape as switchAllPathsTerminate). `lowerTail` arm = lowerTryStatement + the
2171 terminator.

### S4 (M-L) — SEPARATE follow-up issue, not this one

Return crossing a finally: stash value in a slot + inline crossed finally
bodies innermost-out before early.return, reusing the break/continue
crossed-finally machinery; reject finallys with their own abrupt completion.

### S5 (trivial) — docs

Delete the stale catch-no-binding residual from the TryStatement row in
scripts/gen-ir-adoption.mjs + regen (`pnpm run gen:ir-adoption`).

### Constraints

- `isPhase1Tail` is reached recursively via Block tails and the early-return if
  rewrite (3652); `earlyReturnLoopDepth/BarrierDepth` are module-level mutable
  counters — new tail arms must use the same increment / try-finally-decrement
  discipline or nested selection state corrupts.
- Constructor field-init and module-init contexts (barrier preset to 1) must
  keep rejecting returns — the new arms must route body returns through the
  existing 4941 guard, never around it.
- Selector⇄builder parity: every guard relaxed in select.ts mirrors in
  from-ast.ts (generator rejection at 4940 STAYS); lowerEarlyReturn's defensive
  demotes fire at stage=patch into the warning channel — watch for them.

## Acceptance criteria

1. Per slice: targeted FALLBACK lines disappear from `.tmp/tailcf-*` probes; no
   new arms appear in the controls; probes 3/7/9 (already claiming) stay
   kind:emitted.
2. Equivalence tests: tail for/while/do with body return (value correctness);
   VOID tail loop with genuine fall-through (returns undefined); the
   break-falls-through NEGATIVE shape (must stay legacy in non-void — assert it
   still falls back; if ever claimed, it must return undefined, not trap);
   try-returns / catch-returns / both with and without trailing return;
   throwing AND non-throwing executions of each try shape.
3. `pnpm run check:ir-fallbacks` bare — unintended buckets must not grow.
4. Ratchet gates chained bare before commit; CI merge_group is the conformance
   gate.
