---
id: 5284
title: "A single `export const` declines the whole module namespace object — `ns.CONSTANT` traps while `ns.fn()` works"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`tryEmitCompiledModuleNamespaceObject` publishes a namespace object only when
**every** runtime export of the imported module is an immutable top-level
function declaration. `namespaceFunctionExports` declines the whole object
otherwise:

```ts
// Mutable values require live-binding getters. Decline the entire object
// rather than publishing a semantically-wrong snapshot.
return undefined;
```

`export const` falls into that decline. The binding then goes through the
identifier fallback and the member read traps:

```ts
// mod.ts
export function f(s: string): number { return s.length; }
export const N = 7;

// entry.ts
import * as m from "./mod.js";
m.f("abc");   // → 3      (works)
m.N;          // → [object WebAssembly.Exception]
```

Measured on `main` (e1285c756c) with `compileProject`, both when the exporting
module is `.ts` and when it is `.js`; the named-import twin
(`import { N } from "./mod.js"`) has always worked.

## Fix

`const` is the one binding form whose value is fixed once module
initialization has run, so a snapshot of the exporting module's global is a
correct namespace property — which is exactly the carve-out the
"mutable values require live-binding getters" rule leaves open. The export
scan now accepts a top-level `export const` whose binding name is an
identifier backed by a `moduleGlobals` entry, and the namespace-object getter
emits a `global.get` for it instead of a cached function-closure access.

`let`, `var` and reassigned function declarations still decline the entire
object, unchanged.

The emitted `global.get` indices are re-resolved after the getter body is
built, next to the existing cache-global recompute: reserving function-value
caches and string constants adds import globals, which shifts the
module-global range (`ctx.moduleGlobals` is shifted with it).

## Acceptance criteria

- [x] `ns.CONST` reads a numeric and a string `export const` on both `gc` and
      `standalone`.
- [x] A function export in the same namespace still calls.
- [x] A module exporting `let` still declines the object (no snapshot).
- [x] Regression test: `tests/module-namespace-const-export.test.ts` — 6 of
      its 7 cases fail on the parent commit, all 7 pass with the fix.

## Provenance

Found while re-measuring the npm-compat upstream unit suites against current
`main`. It is not itself a corpus blocker — the packages that were failing for
this reason have since been fixed — but it is a live wrong-answer defect on a
shape every ESM consumer writes.
