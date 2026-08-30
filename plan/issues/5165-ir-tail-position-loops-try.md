---
id: 5165
title: "IR: adopt tail-position loops and try/catch that return from the body (`tail-unhandled` residual of #2952)"
status: done
completed: 2026-08-29
assignee: ttraenkler/opus-5165
sprint: current
created: 2026-08-28
updated: 2026-08-29
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

## Outcome (2026-08-29, Opus lane)

**S1, S2, S3, S5 landed. S4 deferred as planned** (a separate follow-up issue —
returns crossing a `finally`; nothing in this change-set touches it, and the
`body-return-context` bar that keeps it on legacy is pinned by four probes and
four tests).

### Probe matrix — measured before/after (`.tmp/tailcf-*.ts`, `.tmp/ir-probe.mts`)

| probe | shape | before | after |
| --- | --- | --- | --- |
| 1 | tail `for (;;)` , body returns | `tail-unhandled:ForStatement` | **emitted** |
| 2 | tail `while (true)`, body returns | `tail-unhandled:WhileStatement` | **emitted** |
| 4 | tail `do … while (true)`, body returns | `tail-unhandled:DoStatement` | **emitted** |
| 5 | tail `try`/`catch`, both arms return | `tail-unhandled:TryStatement` | **emitted** |
| 6 | NONTAIL finally-less `try`, catch returns | `body-return-context:ReturnStatement` | **emitted** |
| 10 | VOID tail loop, genuine fall-through | `tail-unhandled:ForStatement` | **emitted** |
| 3 | control — loop + trailing return | emitted | emitted (unchanged) |
| 7 | control — `catch {}` no binding | emitted | emitted (unchanged) |
| 9 | control — return at if-depth-2 in a nontail loop | emitted | emitted (unchanged) |
| 16 | control — module-level finally-less try | emitted | emitted (unchanged) |
| 8 | NEGATIVE — `while (true) { if (x) return 1; break; }`, non-void | `tail-unhandled` | `tail-loop-falls-through` (still legacy) |
| 11 | S4 — return inside `try`/`finally` | `body-return-context` | unchanged (still legacy) |
| 12 | S4 — catch returns, finally present | `body-return-context` | unchanged (still legacy) |
| 13 | DEPTH — finally-less try inside a finally-bearing try | `body-return-context` | unchanged (still legacy) |
| 14 | DEPTH — finally-less try inside a for-of body | `body-return-context` | unchanged (still legacy) |
| 15 | DEPTH — finally-less try inside a CONSTRUCTOR | `body-return-context` | unchanged (still legacy) |

Emission bar met for every flip: `compile({ trackIrOutcomes: true })` reports
`kind: "emitted"` + `irBodyEmitted: true`, zero post-claim demotions.

### Extra rejection found by measurement, NOT in the plan: generators are OUT

Probing the new arms against generators (the plan only required the existing
`body-return-generator` guard to stay) surfaced a shape that guard does not
cover — a generator tail loop with **no** `return` in it:

```ts
function* g(n: number) { let i = n; while (true) { yield i; i = i + 1; } }
```

`loopNeverFallsThrough` proves it correctly, so the S1 arm claimed it — and the
IR generator lowering is **eager** (the body runs to completion into a yield
buffer), so a loop with no normal completion never terminates. Measured
2026-08-29: legacy/Node yield `5, 6, 7`; the claimed IR build threw
`RangeError: Eager generator buffer exceeded 1000000 yields`. The tail-try arm
had the twin defect (a generator tail `try { throw "a" } catch { throw "b" }`
surfaced a raw `WebAssembly.Exception` instead of the string `"b"`). Both arms
now reject generators outright (`tail-loop-generator` / `tail-try-generator`),
pinned by two runtime tests. Async functions were probed the same way and ARE
equivalent, so they stay in.

### Validation

- `tests/issue-5165-tail-control-flow.test.ts` — 31 tests, all green. Every
  adopted case is checked three ways (Node oracle / legacy / IR) and asserts the
  IR body was genuinely emitted, so a silent demote fails instead of passing
  vacuously. Throwing AND non-throwing executions of every try shape.
- `pnpm run check:ir-fallbacks` — OK, no unintended/post-claim/module-level growth.
- Ratchet chain (loc / func / coercion-sites / oracle-ratchet / dead-exports) —
  all green, plus the `LOC_GATE_BASE=origin/main` CI-base simulation
  (`select.ts` +153, `from-ast.ts` +33, both under this file's grant).
- `node scripts/gen-ir-adoption.mjs --check` — OK.
- Fix-on-touch: `tests/issue-3583.test.ts` (its tail-`for (;;)` negative is the
  shape S1 adopts — flipped to a positive, and a still-valid negative added in
  its place) and `tests/issue-1169q.test.ts` (its `body-shape-rejected` marker
  was a whole tail try/catch, now adopted — swapped for a destructuring catch
  param; while there, its stale `non-export-modifier` async expectation, red on
  `origin/main` since the #1373 async/async-generator split, was corrected to
  `async-function`). Both files fully green.
