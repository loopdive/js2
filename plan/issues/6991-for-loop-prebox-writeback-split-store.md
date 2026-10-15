---
id: 6991
title: "codegen: C-style `for` loop pre-box writeback splits a value-typed captured variable into two stores — closure mutations after the loop are lost, post-loop writes are invisible to the closure (for-statement still on the #1589 writeback, not the #6960 function-wide branch)"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: closures, loops, capture-boxing
goal: standalone-gap
related: [1589, 6960, 1617, 996]
# 2026-10-15: audit finding; loops.ts may grow a few lines if the writeback helper needs a ForStatement arm.
loc-budget-allow:
  - src/codegen/statements/loops.ts
---

# `for` loop pre-box writeback splits a captured variable into two stores

Found by the 2026-10-15 compiler audit (scoping lane). Reproduces identically on `standalone` and `gc`; the IR selector rejects every repro (`body-shape-rejected`), so this is the direct path.

## Repro (node → wasm)

```ts
export function test(): number {
  let total = 0; const fs: (() => void)[] = [];
  for (let i = 1; i <= 3; i++) fs.push(() => { total += i; });
  for (const f of fs) f();
  return total;            // node 12, wasm 0
}
```
Also: `let base = 100; for (let i...) fs.push(() => base + i); base = 200; fs[0]()` reads 100 (node 201); a `cache` variable assigned by the closure never updates after the loop; `for (var i...)` and head-less `for (; i < 3; i++)` behave the same. Only value-typed slots (i32/f64/externref/ref_null) are affected — a `let s = ""` or object-ref capture passes because non-null `ref` captures skip pre-boxing. `while`/`do`/`for-of` are correct (#6960 function-wide branch).

## Root cause

- `src/codegen/statements/loops.ts:338` — `writeGated = isParam || !ts.isForStatement(stmt)`; for a plain local in a `ForStatement` the pre-box is created with `functionWide = false`.
- `src/codegen/statements/loops.ts:388-419` `writeBackPreBoxedBindings` — for a non-`functionWide` entry it copies the cell value back to the raw slot and re-aims `localMap` to the raw slot. The closure keeps the ref cell; the frame goes back to the raw local. Two stores for one binding from that point on.
- Call site `src/codegen/statements/loops.ts:1148`.

## Implementation Plan

1. In `preBoxLoopCapturedBindings` (loops.ts ~330-380) make the `ForStatement` arm take the same `functionWide: true` path as while/do/for-of (#6960): a pre-boxed binding stays boxed for the rest of the function; `fctx.boxedCaptures.set(name, { refCellTypeIdx, valType, rawLocalIdx })` so the lazy repair in `closures/conditional-capture-box.ts` covers paths that skipped the loop. Remove the `!ts.isForStatement(stmt)` special case in `writeGated` ONLY if measurement shows the write-gating is what kept for-loops cheap; otherwise keep gating on `findNamesWrittenInLoop` for all loop kinds (a binding never written in the loop and never written after it does not need a cell, but a binding written by a closure inside the loop MUST count as written — check that `findNamesWrittenInLoop` descends into nested closures; if not, that is the second half of this bug).
2. Keep the type filter at loops.ts:350-358 as is for this PR (do not widen to `ref`); note in this file whether the `ref` exclusion still matters once the writeback is gone.
3. Delete the writeback arm of `writeBackPreBoxedBindings` if no caller still produces `functionWide: false`; otherwise leave it and make the for-statement never produce it. Prefer deletion (dead code fails `check:dead-exports` only for exports; an unreachable branch is fine but misleading).
4. Order-preservation: the pre-box must still be emitted BEFORE the loop head's initializer so a closure created in the head/condition sees the cell; keep the existing `#1453` per-iteration `let` handling untouched (those are already boxed and skipped at :333).
5. Tests: the three repros above, plus the generator variant from the audit (`function* gen(){ for (let i=0;i<3;i++) yield () => i; }` — currently emits invalid Wasm `struct.set expected (ref null N), found f64`; if it is a separate root cause, file it and reference here instead of fixing).

## Acceptance

- All repros match node on standalone and gc.
- `tests/equivalence/` files touching loops/closures still pass (`closure-*`, `loop-*`, `issue-6960*`, `issue-1589*` if present).
- No new `IR-FALLBACK` warnings; the IR path is not involved.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6991-for-loop-prebox-writeback-split-store.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
