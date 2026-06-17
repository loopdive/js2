---
id: 1922
title: "Shared IR traversal/use-collection module — fixes live defect: ordinary while loops demote off the IR path"
status: done
assignee: ttraenkler/sdev-1537
completed: 2026-06-16
sprint: 63
created: 2026-06-10
updated: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: compiler-internals
goal: correctness
---
# #1922 — Shared IR traversal; fix while-loop DCE demotion

## Problem

At least **five hand-rolled copies** of "walk nested instruction buffers /
collect uses" exist in `src/ir/`, each with its own buffer coverage, kept in
sync only by comments ("if a new buffer-bearing instr kind is added, extend
both", `verify.ts:33-34`):

- `verify.ts:459` + `nestedBuffers` (`verify.ts:35`)
- `lower.ts:2255` + `collectForOfBodyUses` (`lower.ts:2409`)
- `passes/dead-code.ts:285` with per-case inline walkers
- `passes/constant-fold.ts` const-map seeding
- alloc-discipline's walker

**Confirmed live defect** (probe-verified during the 2026-06 review):

```ts
export function f(n: number): number {
  const limit = n * 2; let i = 0;
  while (i < limit) { i = i + 1; }
  return i;
}
```

with `experimentalIR: true` emits `warning IR path failed for f:
post-hygiene verify: use of SSA value 2 before def in block 0 [IR-FALLBACK]`.
Root cause: DCE's `collectInstrUses` returns only `[condValue]` for
`while.loop`/`for.loop`, with a comment claiming the buffers "are already
walked separately by the dead-code analysis walker"
(`passes/dead-code.ts:489-494`) — **false**; no such walk exists in
`computeLiveValues` (`dead-code.ts:138-173`). DCE strips `limit` (its only
use is inside the condition buffer it never walks), the post-stage verifier
catches the dangling ref, and the function silently demotes to legacy. The
most ordinary loop shape in the language never compiles through the IR — and
because this is a post-claim demotion, no ratchet counts it (#1923).
`while.loop`/`for.loop` (#1280) updated some walker copies and not others —
exactly the failure mode the duplication invites.

## Proposed approach

1. Add to `src/ir/nodes.ts`: `forEachNestedBuffer(instr, fn)` and
   `collectUses(instr, { deep?: boolean })`, the single authority on which
   instr kinds carry buffers (`if`, `forof.vec/iter/string`, `while.loop`,
   `for.loop`, `try`, generator kinds…).
2. Port verify / lower / dead-code / constant-fold / alloc-discipline onto
   them; delete local copies (~600 lines).
3. Exhaustiveness test: for every `IrInstr` kind that has an `Instr[]`/
   nested-IR field (derive by construction in the test), assert
   `forEachNestedBuffer` visits it.
4. Regression test: the `while (i < limit)` function above compiles through
   the IR path with **zero** fallback warnings.

## Acceptance criteria

- The probe program (and a `for (let i = 0; i < limit; i++)` variant) stays
  on the IR path.
- One traversal module, five consumers; the false comment at
  `dead-code.ts:489-494` is gone.
- `check:ir-fallbacks` corpus shows the while-loop demotions disappear.

## Source

Compiler quality review 2026-06. Related: #1280 (introduced the loop kinds),
#1923 (would have made this visible), #1530.

## Implementation Notes (sdev-1537, 2026-06-16)

**Delivered.** Single traversal authority added to `src/ir/nodes.ts`; the four
genuinely-duplicating consumers now route through it; the while-loop DCE
demotion is fixed.

### New shared module (`src/ir/nodes.ts`)
- `forEachNestedBuffer(instr, fn)` — the authoritative list of which instr kinds
  carry nested `IrInstr[]` buffers (`if` then/else; `forof.vec/iter/string`
  body; `while.loop` cond/body; `for.loop` cond/body/update; `try`
  body/catch/finally). Written as an **exhaustive switch with a `never`
  binding**, so adding a new buffer-bearing kind is a compile error here — the
  one place that must know. Buffer order = evaluation order.
- `forEachInstrDeep(instr, visit)` — pre-order deep walk built on
  `forEachNestedBuffer`.
- `directUses(instr)` / `collectUses(instr, { deep? })` — canonical single-count
  SSA operands; `deep` recurses through the buffers. This is what DCE needed.

### Root-cause fix (`passes/dead-code.ts`)
`collectInstrUses` (225 lines of per-kind ad-hoc walkers) deleted. Liveness now
calls `collectUses(instr, { deep: true })`. `while.loop`/`for.loop` were also
added to `isSideEffecting` so they are **seeded** (they have `result: null`, so
the propagate phase never reached them, and they weren't side-effecting — their
buffers were *never* use-walked). Both gaps had to close: even a correct
`collectUses` wouldn't help if the loop instr is never visited. The false
comment ("buffers are already walked separately … see the forof.* pattern") is
gone.

### Why the playground gate / full-compile probe didn't catch it
The defect is post-claim (verify-stage demotion), so no selector ratchet counts
it (#1923), and the `check:ir-fallbacks` corpus happens not to contain a bare
`const limit = …; while (i < limit) …`. The deterministic regression guard is
therefore a **unit test** (`tests/issue-1922.test.ts`): build IR with a
loop whose cond/body/update reference outer values, run `deadCode`, assert the
values survive and the post-DCE verifier is clean. Verified this exact test
reports `use of SSA value N before def` against the pre-fix `deadCode` and is
clean against the fix.

### Other consumers
- `verify.ts` — local `nestedBuffers` + `forEachInstrDeep` deleted; uses the
  shared ones. (verify's list was already complete; this removes the duplicate.)
- `lower.ts` — `registerInstrDefs` and `collectForOfBodyUses` now recurse via
  `forEachNestedBuffer`. **Behavior preserved exactly**: `collectForOfBodyUses`
  keeps calling lower's own `collectIrUses` (which carries the intentional
  `closure.call` callee double-count for Wasm-local materialisation — that quirk
  is lowering-specific and deliberately NOT moved into the shared `directUses`),
  and still pushes the loop `condValue` / if `thenValue`/`elseValue` after the
  buffer walk, in the original order.
- `alloc-discipline.ts` — the reflection-based `nestedInstrs`/`fromValue`/
  `isInstrLike` walker replaced by the typed `forEachNestedBuffer`.
- `constant-fold.ts` — **intentionally unchanged.** Its const-map seed is
  top-level-only *by design*; a `const` inside a loop/if buffer does not
  dominate code after the buffer, so seeding nested consts into the global map
  would be a correctness bug. CF does no buffer traversal to consolidate.

### Validation
- `tests/issue-1922.test.ts`: 14 tests (unit DCE survival for while/for;
  exhaustiveness over every buffer-bearing kind + leaf-kind negative + deep/
  shallow `collectUses`; e2e `while`/`for` stay on IR with
  `irPostClaimErrors === []` and compute correctly).
- 173 existing IR tests green (selector/lowering #1280, if #1392, string for-of
  #1183, try #1169h, classes #1169d, backend emitter, bytecode proof, verifier
  #1844/#1850/#1924). `tsc` + `npm run lint` clean. IR fallback gate: no
  unintended/post-claim increases. Net −36 lines (≈600 lines of duplication
  removed, ~275 added as the shared authority + tests).
- Pre-existing unrelated failures: `labeled-loops`, `ir-*-equivalence`,
  `for-loop-computed-values` etc. fail identically on pristine origin/main
  (stale test harness passing empty imports to `WebAssembly.instantiate`) —
  not touched by this change.
