---
id: 7622
title: "IR planning identity context is built only with experimentalIR or trackIrOutcomes, so a diagnostic flag changes the answer"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7620, 7558]
---

# #7622 — the IR identity context gate makes IR-off namespace calls throw

## Problem

With `experimentalIR: false`, a call through a namespace (`d.bump()` behind `import * as d`, or `N.f()` on a
TypeScript `namespace`) throws a `WebAssembly.Exception`. Adding `trackIrOutcomes: true`, a diagnostic flag, makes the
same program return the right answer. Found while planning #7620 (side finding R1, also reported by S7).

### Repro

```ts
// entry.ts
import * as d from "./dep";
export function main(): number { d.bump(); return d.g * 10 + 3; }
// dep.ts
export let g = 1; export function bump(): void { g = 2; }
```

### Measured

Measured on 2026-11-28 on `ada18e6bb6` (head of PR #7558) and on origin/main `01c9284f78`, with node v22.23.5. The
two bases give identical answers. Probe: `.tmp/p7620/side.mts` in the c8-7620 worktree (`compileMulti` or `compile`,
then `main()`).

| program | node | IR on | IR off | IR off + `trackIrOutcomes: true` |
| --- | --- | --- | --- | --- |
| the repro above | 23 | 23 | throws | 23 |
| `import * as d; d.f(); return 5;` (dep exports only `f`) | 5 | 5 | throws | 5 |
| single file: `namespace N { export function f() { return 4; } }`, `return N.f() + 1` | 5 (TS semantics) | 5 | throws | 5 |
| `import { f } from "./dep"; return f() + 1;` (named import) | 5 | 5 | 5 | 5 |

Each cell is the same on standalone and on gc.

### Cause (read from the code, confirmed by the `trackIrOutcomes` column)

- `generateMultiModule` (`src/codegen/index.ts:9767`, condition at 9769-9777) and `generateModule` (`index.ts:5435`)
  build the IR planning identity context, and with it the Program ABI session, only when
  `options.experimentalIR || options.trackIrOutcomes`.
- Four exact callable lookups resolve a declaration to its function through
  `ctx.programAbiSourceCallables.identityContext`, and decline without it:
  - `tryRuntimeNamespaceMemberCall` (`src/codegen/expressions/calls.ts:2800`);
  - the function arm of `moduleSymbolNamespaceExports` (`src/codegen/module-namespace-value.ts:498-509`), which then
    declines the whole namespace object;
  - `currentNamespaceFunctionHandle` (`module-namespace-value.ts:756`);
  - `exactImportedTopLevelFunction` (`src/codegen/expressions/identifiers.ts:858`).
- With IR off, the static member call declines, the namespace object declines, and the receiver compiles to the null
  fallback, so the call throws. A named import survives because its call takes the name-keyed `funcMap` path.
- The lines are at `ada18e6bb6`.

Not measured: whether any other reader of `programAbiSourceCallables` or `programAbiSession` changes behaviour under
the same gate, and the gc byte effect of building the context unconditionally.

## Acceptance criteria

- **Pin test.** A new `tests/issue-7622-*.test.ts` holds the four rows above, × standalone/gc × {IR on, IR off,
  IR off + `trackIrOutcomes`}, and compares each with node's answer (TS semantics for the `namespace` row).
  - It is red on the base: the IR-off rows throw.
  - It is green after the fix.
  - Every row answers the same with and without `trackIrOutcomes`.
- **gc output byte-identical** for programs that use no namespace call, on the #7470 single-file corpus (389 files)
  and its multi-file graphs, base vs new.
- **No test262 regression** in the scoped `language/module-code|import|export` per-test diff, on standalone.
