---
id: 5332
title: "REGRESSION on main: `export default <identifier>;` in a multi-file project fails to compile"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Symptom (live on `main`, not introduced by any open PR)

Any project of two or more files in which a **dependency** uses the
`export default <identifier>;` statement form fails to compile outright:

```
Codegen error: multi-prepared-module-init-census:terminal-join:
executable source ir-source:v1:0000000000000000:source:dep.js
lost its exact module-init terminal
```

Minimal reproduction (`allowJs`, `target: "gc"`, `platform: "node"`, via
`compileProject`):

```js
// dep.js
function g(input) { return 42; }
export default g;

// main.js
import g from './dep.js';
export function a() { return g(5); }
```

Measured shapes (same harness, one run each):

| shape | compiles |
| --- | --- |
| `export default g;` in a `.js` dep | **NO** |
| `export default g;` in a `.ts` dep | **NO** |
| `export default function g(…)` (inline) | yes |
| `export function g(…)` (named) | yes |
| `export { g as default }` | yes |

The return type is irrelevant — a dep that never returns `undefined` fails
identically.

## Cost, measured

jest dogfood suite, same machine, same day:

- `4946cf70fe` — **299/356**; `packages/jest-config/src/__tests__/stringToBytes.test.ts` **6/28**
- `6d0ae7531d` — **293/356**; `stringToBytes.test.ts` **0/28**, because
  `packages/jest-config/src/stringToBytes.ts` ends in `export default stringToBytes;`
  and the module no longer compiles at all.

So this is a **−6 regression on the jest suite by itself**, and it additionally
**masks** [#5328](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5328-dynamic-dispatch-extern-result-dropped)
(worth a further +21 on the same file), whose only reproducing shape is exactly
the one that now fails to compile.

## Root cause — two sides disagree about what an `ExportAssignment` is

- `src/ir/identity.ts` (~line 903): an `ExportAssignment` gets an
  `addSupportUnit("export-assignment", …)` and is **NOT** pushed into
  `modulePopulation`. A source whose only module-level work is
  `export default g;` therefore gets **no `module-init` terminal unit**, so
  `planning-identity.ts` never records it in `moduleInitUnitIdBySourceFile`.
- `src/ir/module-init-plan.ts` (~line 453): every `ExportAssignment` **is**
  pushed as an `evaluation` (`kind: "export-assignment"`), so
  `executable = evaluations.length > 0` is **true**.
- `src/codegen/multi-prepared-module-init-census.ts` (~line 448) then asserts
  that an `executable` source has an exact module-init terminal, finds none, and
  raises `terminal-join`.

Introduced by the #3525 census work (`feat(ir): retain ordered multi-source
module-init census`, commit `2c18cd7a6f`) — the invariant is new; the underlying
disagreement between the two files is what it caught.

## Two candidate fixes (not attempted here — this belongs to the #3525 lane)

1. **Make the plan agree with identity.** Stop counting an `ExportAssignment` as
   a module-init evaluation, keeping the `pushExportIntent` call that follows it.
   Narrowest variant: only when the expression is a bare `Identifier`
   (a hoisted-binding reference that performs no runtime work), leaving
   `export default someCall()` alone. Risk to check: whether anything downstream
   relies on that evaluation existing to emit the expression.
2. **Make identity agree with the plan.** Push the `ExportAssignment` into
   `modulePopulation` so a module-init terminal is minted. More conservative for
   emission (it adds a unit rather than removing an evaluation), wider in its
   effect on the unit inventory.

The census's own re-check (`~line 626`) only compares `plan.unitId` against
`moduleInitUnitIdBySourceFile` and the terminal denominator, so either
reconciliation keeps it self-consistent; no evaluation COUNT is compared.

## Related

`tests/issue-5328-dynamic-dispatch-extern-result.test.ts` detects this exact
compile error and **skips with a pointer to this issue**, so #5328's fix can
land now and its assertions start enforcing the moment this is fixed.
