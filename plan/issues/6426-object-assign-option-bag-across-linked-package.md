---
id: 6426
title: "`Object.assign(this, options)` in a base class drops the value when the class lives in a separately-linked package"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

A base class that copies its constructor options onto `this` reads those
properties back as `null` (objects) or the wrong `typeof` (functions) — but
**only** when the class is compiled as a separately-linked package
(`linkPlan.mode === "separate"`). The identical source in a single compilation
unit is correct.

```js
// router5366/index.js  (a separately-linked package)
export class RegExpRouter { constructor() { this.name = "RegExpRouter"; } }
export class Base {
  router;
  getPath;
  constructor(options = {}) {
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
  }
}

// main.js
new Base({ router: new RegExpRouter() }).router;          // node: the instance   wasm: null
typeof new Base({ getPath: (r) => "/p" }).getPath;        // node: "function"     wasm: "object"
```

Measured 2026-09-12 on `main` at `24411b6763`, in the three lanes of
`tests/issue-5366-nullish-join-carrier.test.ts`:

| lane                            | `baseObjectAssign` | `otherOptionKey` |
| ------------------------------- | ------------------ | ---------------- |
| single module                   | `"RegExpRouter"` ✓ | `"function"` ✓   |
| two modules, one unit           | `"RegExpRouter"` ✓ | `"function"` ✓   |
| separately-linked package       | `"null"` ✗         | `"object"` ✗     |

Found while fixing
[#5366](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5366-class-instance-field-from-constructor-option-reads-null),
whose `??` join defect it is **not**: neither row contains a `??`, and both are
identical before and after that fix. The two are pinned as `LINKED_RESIDUALS`
in that test, so this issue's fix is observable as those assertions flipping.

## Hypotheses

- The declared-but-uninitialised fields (`router;`, `getPath;`) get a struct
  slot typed from the package's own view, and the cross-module `Object.assign`
  writes through a guarded store that substitutes null — the same
  null-substituting-downcast family as #5366 and #5376, one seam further out.
- `Object.assign`'s own lowering may take a different (host-reflection) path
  when the receiver's struct type is owned by another linked module, and lose
  the callable/struct identity on the way through.

`typeof … === "object"` for a copied **function** is the sharper clue of the
two: the value survives the copy but arrives as something other than a
callable, which points at the copy, not at the field slot.

## Acceptance criteria

1. Both rows answer as node does in the separately-linked lane.
2. The `LINKED_RESIDUALS` override in
   `tests/issue-5366-nullish-join-carrier.test.ts` is deleted and that lane
   asserts the shared `EXPECTED` table.
3. A/B over the 17 dogfood suites, per test file.
