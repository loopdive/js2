---
id: 6429
title: "`.name` on a statically known closure folds to the STORAGE key, not the declaration's name"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: compiler
goal: correctness
---

## Problem

Split out of [#5365](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5365-host-closure-bridge-loses-length-and-name)
step 6, because it is a compile-time FOLD and has nothing to do with the
boundary carrier that #5365 slice 1 and
[#6427](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6427-host-mode-closure-name-carrier)
are about.

`.name` read on a closure whose declaration the compiler can see statically is
folded at compile time, and the fold uses the STORAGE SITE's key instead of the
declaration's own name. Measured (`target: gc`, `platform: node`, on both `main`
and the #5365 slice-1 branch — unchanged by it):

```js
const f = (a, b) => a + b;
const o = { h: f };
const arr = [f];
```

| read           | wasm   | spec  |
| -------------- | ------ | ----- |
| `f.name`       | `"f"`  | `"f"` |
| `o.h.name`     | `"h"`  | `"f"` |
| `arr[0].name`  | `""`   | `"f"` |

§8.4 NamedEvaluation assigns a name from the storage site only for an
**anonymous** function definition, and only at the NamedEvaluation sites
(variable declaration, property definition, assignment). A function that was
already named at its own declaration keeps that name wherever it is stored, and
an array element is never a NamedEvaluation site at all.

## Implementation Plan

1. Find the fold: grep `"name"` in `src/codegen/property-access*.ts` /
   `member-get-dispatch.ts`. The two wrong answers come from different arms
   (property key vs. the empty-string default for an element), so expect two.
2. Use the declaration's own name when the function HAD one. Only an anonymous
   function expression / arrow takes the storage key, and only at a
   NamedEvaluation site — never for an array element, which keeps `""` for an
   anonymous function and takes the declaration's name otherwise.
3. Regression test with untyped `.js` two-file fixtures: named arrow in an
   object and in an array; anonymous arrow assigned to a `const` (`"g"`);
   anonymous in an array (`""`); anonymous as a property value (the key).
   Counts both ways plus an anti-vacuity control.
4. A/B the 17 dogfood suites — a compile-time fold, so the blast radius is any
   package that reads `.name` off a stored function (jest, redux).

## Acceptance criteria

1. `o.h.name` and `arr[0].name` answer `"f"` for a named declaration.
2. An anonymous arrow keeps its NamedEvaluation name at a variable declaration
   and at a property definition, and `""` as an array element.
3. No suite regresses.
