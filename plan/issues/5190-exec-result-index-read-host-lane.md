---
id: 5190
title: "`exec()` result `.index`/`.input` read is broken in the HOST lane — the second #5204 defect behind the 224-row cluster"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
feasibility: hard
task_type: bugfix
area: codegen
goal: core-semantics
related: [5187, 5204, 5180]
---

# #5190 — the exec-result property read that #5187 does not fix

## Problem

Reading `.index` / `.input` off a `RegExp.prototype.exec` result is wrong in the
**host (JS-host target) lane**, and has been since #5204 (`8f161cbf15`).

```js
/*--- test262 harness lane ---*/
var m = /b/.exec("abc");
assert.sameValue(m.index, 1); // main: 0   (constant, regardless of the match)
```

* **Pre-#5204 (`4dfedbdc92`)**: correct — the row passes.
* **`main` today**: `m.index` reads a **constant `0`**. Rows whose match happens
  to be at offset 0 therefore *pass by accident*.
* **`main` + #5187's fix**: `m.index` reads **`NaN`**. Still wrong, and it makes
  the accidental passes fail honestly.

The **standalone** lane is correct in all three states — this is host-lane only.

## Relationship to #5187

#5187 (carrier-name fallback naming a vec that lacks the member) is a *different*
defect in the same commit. Its fix is measured net **+5** across 252 rows
(146 → 151 pass), and one of its 6 wins is offset by
`RegExp/prototype/exec/regexp-builtin-exec-v-u-flag.js`, which flips from
accidentally-passing (`0` where `0` was expected) to failing (`NaN`). That row is
this issue, not a #5187 regression.

The 224-row `__executed.index` cluster needs BOTH: with #5187 alone the rows get
past their `.index` assertion and stop at the next one, `__executed.input`
(`undefined`).

## What has already been ruled out (do not repeat)

Localization was attempted and failed; the cause is **not** isolatable by
single-file revert:

* Per-file revert scan over all 71 `src/` files `8f161cbf15` touches, run
  **on the coherent tree at `8f161cbf15` itself** (so later PRs cannot
  interfere): **no single file** flips the probe to pass. Ten files crash the
  compile when reverted alone (import-level coupling): `index.ts`,
  `type-coercion.ts`, `declarations.ts`, `native-construct.ts`, `binary-ops.ts`,
  `expressions/assignment.ts`, `expressions/identifier-module-storage.ts`,
  `registry/imports.ts`, `analysis/mixed-assignment-carrier.ts`,
  `walk-instructions.ts`. Reverting those ten **together** still crashes.
* Reverting `property-access.ts` + `property-access-dispatch.ts` together on
  current `main`: still `NaN`. So it is not in the property-access pair.
* Applying #5187's fix at `8f161cbf15` itself gives the same `NaN`, so the second
  cause is inside that commit too, not a later PR.

The next method to try is **per-hunk** reverts inside the coupled ten, or a
WAT diff of the reading function between `8f161cbf15^` and `8f161cbf15`.

## Reproduce

Harness lane (fails), ~8 s:

```bash
node --import tsx .tmp/probe.mjs   # runTest262File on a file containing:
#   var m = /b/.exec("abc");
#   assert.sameValue(m.index, 1, "index");
#   assert.sameValue(m.input, "abc", "input");
```

Standalone lane (passes — the contrast is the point):

```js
export function test() { var m = /b/.exec("abc"); return m.index; } // → 1
```

## Acceptance

* `m.index` / `m.input` on an exec result are correct in the host lane.
* `built-ins/RegExp/prototype/exec` recovers the `__executed.input` assertion,
  and `regexp-builtin-exec-v-u-flag.js` passes for the right reason.
* A regression test that asserts a **non-zero** match index, so a constant-`0`
  read cannot pass it.
