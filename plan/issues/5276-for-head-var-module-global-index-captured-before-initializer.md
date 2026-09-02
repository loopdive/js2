---
id: 5276
title: "for-head `var` at module scope captures its module-global index before compiling the initializer — stale `global.set` after a mid-body global insertion"
status: ready
created: 2026-09-02
updated: 2026-09-02
sprint: current
priority: medium
horizon: s
feasibility: easy
task_type: bug
area: codegen
goal: core-semantics
requested_by: claude/fable-ir-takeover
related: [3523, 5474, 5480, 2023, 2001, 3032, 3933, 4648]
---

## Problem

`compileForStatement` (`src/codegen/statements/loops.ts:322`) handles a
for-head `var` declaration at module scope by reading the variable's
module-global index into a local **before** compiling the initializer and
pushing the `global.set` **after** it:

```ts
// src/codegen/statements/loops.ts:416-422 (origin/main 33ea8606aa)
const moduleGlobalIdx = hasLocalShadow || blockScopedInsideFunction ? undefined : ctx.moduleGlobals.get(name);
…  // compileExpression(initializer) runs here
fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
```

Compiling the initializer can insert a module global mid-body — e.g. `a[0]`
adds the bounds-check error path's string constant, `addStringConstantGlobals`
runs `fixupModuleGlobalIndices`, and that fixup shifts `ctx.moduleGlobals`,
every already-emitted `global.get/set` reachable from a live body, and ~20
cached index maps. It cannot shift a number sitting in a caller's local that
has not pushed its instruction yet. Measured in emitted WAT (gap-6a census,
[#3523](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3523-ir-r4-module-init-compile-once)
"gap-6a v2 repair record", family A): the for-head writes `global.set 107`
while every other reference to the same variable in the same function reads
`global.get 108` — the initializer lands in the PRECEDING global and the loop
variable keeps its default. On a neighbouring shape the same off-by-one writes
an `f64` into an `externref` slot, which is
`global.set[0] expected type externref, found if of type f64` at
`WebAssembly.instantiate`.

Reduced repro (4 lines, inside the test262 harness):

```js
var a = [1, 2];
var n = 0;
for (var j = a[0]; j <= 2; j++) { n = n + 1; }   // n === 4, expected 2
```

This is the **sixth instance** of the staleness family documented inside
`fixupModuleGlobalIndices` (#2023, #2001, #3032, #3933, #4648). The first five
all fixed a *cache*; this one is a value in flight on the stack, which no fixup
can reach.

## Why it is invisible on `main` today

The default two-pass module-init route compiles the whole initializer once in
pass 1, which creates every string-constant import the emitting compile would
have needed, so the second compile inserts no global mid-body and nothing goes
stale. PR #5474 (gap-6a, skipping pass 1 when discovery is static) removed the
mask and regressed 76 test262 rows (16 decodeURI/decodeURIComponent OOB traps,
the `do-while` single, part of cluster 2) before it was reverted (#5477). The
re-land [PR #5480](https://github.com/loopdive/js2/pull/5480) keeps the skip
behind `JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC=1` and deliberately does
NOT carry this fix, so that a byte-neutral repair PR does not also change
emitted code. Any future change that moves work out of pass 1 hits this again.

## Implementation Plan

One-line fix, no-op whenever no shift happened:

1. In `compileForStatement`, re-read `ctx.moduleGlobals.get(name)` **after**
   `compileExpression(initializer)` returns and use that index for the
   `global.set` (`loops.ts:416` → read at :422). Keep the `hasLocalShadow ||
   blockScopedInsideFunction` guard as the decision, not the captured index.
2. Audit the sibling arms in the same file for the same capture-then-compile
   shape (the `for-in`/`for-of` module-global heads around `:969`, which
   registers `liveBodies` the same way) and apply the same re-read where an
   initializer or iterable expression is compiled between the read and the
   push.
3. Pin: `tests/issue-5276-for-head-module-global-stale-index.test.ts` compiles
   the 4-line repro with the pass-1 skip enabled
   (`JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC=1`, available once #5480 lands)
   and asserts `n === 2`; a second case with a string-typed loop variable
   (`for (var s = a[0] + "", …)`) asserts the module instantiates. Without the
   seam the pin must still compile and pass (the mask hides the bug, the
   assertion holds either way) — state that in the test header so a later
   pass-1 retirement cannot silently un-pin it.
4. Byte neutrality on the default route: file-copy A/B (`cmp`) on the
   `playground/examples` host corpus, expected 100 % identical — the re-read
   returns the same index whenever no insertion happened.

## Acceptance criteria

1. The repro yields `n === 2` with the pass-1 skip enabled; the string-variable
   shape instantiates.
2. Default-route corpus bytes unchanged (A/B evidence in the checkpoint note).
3. The fix is cited from `fixupModuleGlobalIndices`'s staleness-family comment
   as instance six, so the next reader of that comment finds it.
