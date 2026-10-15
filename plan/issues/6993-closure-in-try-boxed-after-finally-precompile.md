---
id: 6993
title: "codegen: a closure first constructed inside a `try` block boxes its capture AFTER the `finally` body was pre-compiled, so the finally's write (`x = 5`, `x++`) lands in the dead raw slot and the closure reads the stale value (exceptions.ts pre-compiles finally before the try body; closures.ts boxes lazily)"
status: done
completed: 2026-10-15
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
func-budget-allow:
  # 2026-10-15 (#6993): +3 lines — the pre-box call before the finally
  # pre-compile and the matching post-statement finish call. The logic itself
  # lives in src/codegen/closures/try-capture-prebox.ts.
  - src/codegen/statements/exceptions.ts::compileTryStatement
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

## Implementation notes (2026-10-15)

**Fix.** `compileTryStatement` now calls `preBoxTryFinallyCapturedBindings`
(new `src/codegen/closures/try-capture-prebox.ts`) BEFORE it pre-compiles the
finally body, while `fctx.body` is still the statement's outer body. Each
admitted binding is boxed into a fresh ref cell there and `localMap` is
re-aimed at the cell, so the finally clones, the try block, the catch clause
and every closure built in them share one cell. After the statement,
`finishTryFinallyPreBox` records the raw slot (`boxedCaptures.rawLocalIdx`) for
the lazy repair in `closures/conditional-capture-box.ts` — the same
function-wide contract as the #6960 loop pre-box, so a path that skipped the
try (try in a conditional arm) still reads the right value.

**Admission** (narrow — every other try statement compiles byte-identically):
the statement has a finally; the name is captured by a nested closure anywhere
in the statement, referenced from the finally block, written somewhere in the
statement, is a value-typed local of this frame, not already boxed, not a
`__module_init` shadow, not a mapped-`arguments` parameter, and not lexically
redeclared inside the statement (block `let`/`const`/class/function, catch
param). A TDZ-flagged `let`/`const` is admitted only when its declaration ends
before the try statement (its flag cannot change inside the statement, so the
finally's TDZ checks against the raw flag stay exact; the closures still box
the flag themselves).

**Shared analysis, no third scan.** Capture detection reuses the loop pre-box
walker, extracted as `collectNamesCapturedByClosures` in
`src/ir/analysis/loop-shape.ts` (`findAllNamesCapturedByClosuresInLoop` now
delegates to it). The write scan reuses `findNamesWrittenInLoop`, whose
parameter is widened from `ts.IterationStatement` to `ts.Node` (its body was
already node-generic). `statements/loops.ts` and `closures/arrow-phases.ts`
are untouched (#6991/#6992 are in flight there).

**Intended consolidation (follow-up, after #6991/#6992 land):** route the write
scan through the shared written-bindings helper #6992 introduces, and merge the
cell minting in `try-capture-prebox.ts` with `preBoxLoopCapturedBindings`
(`statements/loops.ts`) into one `closures/` helper. A TODO in
`try-capture-prebox.ts` names this.

**Measured.**
- All issue repros + the catch-clause variant and 11 more shapes (closure built
  in catch / in finally, read-in-finally, parameter, `var` in try, try in a
  conditional arm, block-scoped shadow in try, string capture, module-level
  try) match node on standalone AND gc:
  `tests/equivalence/issue-6993-closure-try-finally-write.test.ts` (32/32).
  Before the fix 11 of the first 13 probe shapes differed on both lanes (the
  two that matched: the catch-write control and a read-only capture).
- Byte-identity spot check: every backtick source mentioning `finally` in
  `tests/equivalence/*.test.ts` that compiles (8 sources × 2 lanes) hashes
  identically with base `exceptions.ts` vs the fix, including a closure built
  BEFORE the try.
- Related suites: the 12 `tests/equivalence` files matching
  `finally|try|closure|shadow|block-scope|tdz` (or containing `finally`) — only
  the 6 known `tdz-reference-error` baseline failures fail. 29 `tests/*.test.ts`
  files matching `finally|try-|capture-box|1589|6960…`: 47 failures in
  `finally-block`, `issue-1589a`, `issue-6866-finally-main-inventory-successor`,
  identical on base (pre-existing harness/import failures).

**Generator variant — NOT fixed here, separate root cause.** The native
generator symptom from the audit is not a try/finally ordering problem: it
reproduces with no `try` at all, whenever a closure capture is boxed after a
`yield` has already fixed the spill plan:
- `function* g(){ var k = 7; var f = function(){ return k; }; yield 1; k = 8; log(f()); }` → node 8, wasm 7 (both lanes).
- `function* g(){ let k = 7; yield 1; const f = () => k; k = 8; log(f()); }` →
  invalid Wasm in `__gen_resume_g` (`struct.set expected (ref null N), found f64`),
  the same signature #6991 lists for its generator variant.
- try/finally inside a generator without a `yield` inside the try matches node
  (`gen-try-noyield`, `gen-try-yield-after`), so this PR's fix covers the try
  half; the async-function variant also matches node.
The spill planning (`src/codegen/generators-native.ts`, ~7k lines) needs its own
issue (shared with #6991's generator note); it is not small.

