---
id: 6450
title: "node lane: `createHash` imported from `'crypto'` compiles to null — hono `src/utils/crypto.test.ts` 'Should create hash for Buffer' reads `update is not a function`"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: correctness
---

## Problem

On the `--platform node` lane a named import from the `crypto` builtin compiles
to a **null** binding. Measured on `3e92241ecc` with the
[#6425](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6425-hono-crypto-textencoder-not-a-constructor)
fix applied (`.tmp/6425/probe2.mjs`, a two-test module with
`DOGFOOD_PLATFORM: "node"`):

```js
import { createHash } from "crypto";
createHash("sha256")            // → null   (native: a Hash object)
createHash("sha256").update(…)  // → "Cannot access property on null or undefined"
```

Native lane 2/2, Wasm lane 0/2. The compile succeeds with zero errors — the
provider simply hands back null, so every failure surfaces one call later as a
property access on null.

## Why it is filed now

It is the **last remaining failure** in hono's `src/utils/crypto.test.ts` after
#6425. That file went 0/4 → 3/4; the fourth test, `Should create hash for
Buffer`, still reads `update is not a function`.

Two distinct things are probably in play there and this issue covers both:

1. **The builtin provider returns null** (the reduction above, independent of
   hono).
2. **A same-name local export may shadow the import.** hono's own
   `src/utils/crypto.ts` exports an `async function createHash`, and the file
   under test imports from both. The message the suite reports is `update is
   not a function` rather than the null-property message the bare reduction
   gives, which is what you would see if the binding resolved to the local
   async export (whose return is a Promise) instead of the builtin. Confirm
   which binding the compiled code picked before fixing either half.

## Acceptance criteria

1. `import { createHash } from "crypto"` (and `"node:crypto"`) on the node lane
   yields a working hash object: `.update(…)`/`.digest(…)` round-trip against
   the native oracle.
2. If the shadowing half is real, a named import and a same-name local export
   in one module resolve to the correct binding at each use site, with a
   regression test that fails on the parent.
3. hono `src/utils/crypto.test.ts` reads 4/4.
4. A/B over the 17 upstream suites at one HEAD: hono up, nothing else down.

## Notes

- Reduction to start from: `.tmp/6425/probe2.mjs` in the #6425 worktree — a
  standalone two-test module, no hono checkout needed.
- Check the `node:` builtin provider table first: the compile reports no
  diagnostic, so the name is being resolved to *something* that evaluates to
  null rather than being rejected, which points at a registered-but-empty
  provider entry rather than a missing one.
- `src/utils/buffer.test.ts` (same node lane) sits at 5/10 after #6425; its
  remaining failures are `Response is not defined` and friends, a separate
  host-global gap — do not bundle those here.
