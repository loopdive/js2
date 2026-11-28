---
id: 7623
title: "IR-on compile error 'callable preflight found a non-exact graph edge' for a namespace member call"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: core-semantics
related: [7620, 7622]
---

# #7623 — `d.f()` through `import * as d` fails the callable preflight

## Problem

With the IR path on (the default), a namespace member call whose value is used fails to compile when the namespace's
module exports only functions. Found while planning #7620 (side finding R2).

### Repro

```ts
// entry.ts
import * as d from "./dep";
export function main(): number { return d.f() + 1; }
// dep.ts
export function f(): number { return 4; }
```

```
Codegen error: callable preflight found a non-exact graph edge
ir-unit:v1:ir-source%3Av1%3A0000000000000001%3Aentry%3Aentry.ts:root:top-level-function:0000000000000000
-> ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Asource%3Adep.ts:root:top-level-function:0000000000000000
(at src/codegen/multi-prepared-callable-orchestration.ts:580:13)
```

### Measured

Measured on 2026-11-28 on `ada18e6bb6` (head of PR #7558) and on origin/main `01c9284f78`, with node v22.23.5. The
two bases give identical answers. Probe: `.tmp/p7620/side.mts` in the c8-7620 worktree.

| program (dep as above unless noted) | node | IR on | IR off | IR off + `trackIrOutcomes` |
| --- | --- | --- | --- | --- |
| `return d.f() + 1;` | 5 | compile error | throws (#7622) | 5 |
| `const r = d.f(); return r + 1;` | 5 | compile error | throws (#7622) | 5 |
| `return d.f();` | 4 | compile error | throws (#7622) | 4 |
| `d.f(); return 5;` (value unused) | 5 | 5 | throws (#7622) | 5 |
| dep also exports `let g = 1`; `return d.f() + 1;` | 5 | 5 | throws (#7622) | 5 |
| `import { f }`; `return f() + 1;` | 5 | 5 | 5 | 5 |

Each cell is the same on standalone and on gc.

- The IR-off column is #7622, not this issue.
- With IR off and `trackIrOutcomes`, the compile succeeds and answers correctly. The preflight is reached only with
  `experimentalIR` on.

### Cause (partly measured)

- `preflightMultiPreparedCallableComponents` (`src/codegen/multi-prepared-callable-orchestration.ts:410`) throws at
  580 when any of about 18 conditions on a graph use fails.
- A throwaway instrumentation of that condition on main, for the repro, showed which ones fail:
  `record.sourceId !== ownerRecord.sourceId` and `record.sourceId !== use.sourceId`. Every other condition held.
- So the binding record of the `d.f()` use belongs to a different source than the call's owner. Most likely it is
  the exporting module dep's record, because a namespace member has no import record in the caller. The preflight
  requires the record to come from the caller's own source.
- Not measured: why the value-unused and the "dep also exports a `let`" shapes do not reach this check. The likely
  reason is that the Prepared program is declined before the preflight, but that is unverified.

## Acceptance criteria

- **Pin test.** A new `tests/issue-7623-*.test.ts` holds the six rows above with IR on, on standalone and gc, and
  compares each with node.
  - It is red on the base: the first three rows fail to compile.
  - It is green after the fix: every row compiles and matches node.
- **The preflight still rejects a really inexact edge.** A test keeps one non-exact edge rejected, to show the fix
  did not drop the check.
- **No test262 regression** in the scoped `language/module-code|import|export` per-test diff, on standalone and with
  `TEST262_COMPILER_PATH=ir`.
