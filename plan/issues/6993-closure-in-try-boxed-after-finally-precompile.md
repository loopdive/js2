---
id: 6993
title: "codegen: a closure first constructed inside a `try` block boxes its capture AFTER the `finally` body was pre-compiled, so the finally's write (`x = 5`, `x++`) lands in the dead raw slot and the closure reads the stale value (exceptions.ts pre-compiles finally before the try body; closures.ts boxes lazily)"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: closures, try-finally, capture-boxing
goal: core-semantics
related: [993, 6991, 6992]
---

# Closure created in `try`, variable written in `finally` → stale read

Found by the 2026-10-15 audit (control-flow lane). Both lanes.

## Repro (node → wasm)

```js
function f(){ var x = 0; try { return function(){ return x; }; } finally { x = 5; } }
console.log(f()());            // node 5, wasm 0
```
`let x = 0; try { return () => x } finally { x++ }` → 1 vs 0; two-level nesting → 0. Writes in `catch` are fine (catch is compiled after the try body) and closures declared BEFORE the `try` are fine. Inside a loop it is also fine (loops snapshot boxed captures).

Related symptom, native generators: `function* g(){ var k = 7; var f = function(){ return k; }; yield 1; k = 8; log(f()); }` → node 8, wasm 7 (the generator frame spills `k` across the yield while the closure holds the pre-spill cell). Treat as the same class: a capture boxed at a point the earlier-emitted code did not know about.

## Root cause

- `src/codegen/statements/exceptions.ts:350-392` — `compileTryStatement` pre-compiles the finally body ONCE before the try body (`pushBody(fctx)` at :384) so it can be cloned at every exit.
- `src/codegen/closures.ts:1012-1025` — capture boxing is lazy: the first closure construction promotes the mutable captured local to a ref cell and rebinds `localMap`. A closure first constructed inside the try block boxes `x` after the finally clone was emitted against the raw local.

## Implementation Plan

1. Pre-box before pre-compiling finally: in `compileTryStatement`, before `pushBody` at :384, compute the set of mutable bindings that (a) are written in the finally block (or anywhere in the try statement) AND (b) are captured by a closure constructed anywhere inside the `try`/`catch`/`finally` blocks and not yet boxed. Reuse the loop pre-box machinery: `preBoxLoopCapturedBindings`-style helper from `statements/loops.ts` (consider lifting it to `closures/` so loops and try share one helper). Box them `functionWide` exactly like #6960, so the finally clone and the closure agree on the cell.
2. For capture detection reuse `planClosureCaptures`'s walker or the shared write helper being introduced by #6992; do not add a third identifier-only scan.
3. Generator variant: check `src/codegen/generators-native.ts` spill planning (~:3033) for the same ordering problem (closure boxed after the spill plan decided the slot); if the fix is separate, do it in this PR only if small, else file an issue and note it here.
4. Tests: the three try/finally repros, a catch-block variant (`catch { x = 9 }` with a closure first built in the try body), and the generator repro.

## Acceptance

- Repros match node on standalone and gc.
- `tests/equivalence/*finally*`, `*try*`, `*closure*` pass; no change to code size on files without closures in try (byte-identical WAT for one existing finally test as a spot check).

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6993-closure-in-try-boxed-after-finally-precompile.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
