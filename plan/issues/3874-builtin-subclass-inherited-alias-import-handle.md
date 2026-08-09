---
id: 3874
title: "Subclassing a builtin whose plain form is also used registers an import handle as an inherited class callable — ProgramAbiInvariantError"
status: ready
created: 2026-07-31
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
goal: compilable
sprint: current
related: [3672, 3687, 2620, 3798]
origin: "2026-07-31 dev-eslint-ir, reducing the ESLint linter-graph compile abort"
---

# #3874 — inherited-alias lookup matches host-import handles by textual prefix

## Why this has no home yet

This is the defect that aborts the real ESLint `linter.js` graph compile after
~12 s (`inherited class callable LazyLoadingRuleMap_has has no exact defined
function for handle 676`). PR #3687 claims a fix on a branch that is DIRTY, held,
and self-reports a regression — so **the reduced repro below is currently the only
executable artefact for it**.

## Root cause

`src/codegen/class-bodies.ts` sets `parentClassName = baseExpr.text`, then scans
`ctx.funcMap` for **every key with the textual prefix `${parentClassName}_`**. A
separate *plain* use of the same builtin registers host-**import** entries under
exactly those keys. That import handle reaches `observeInheritedAlias`, which
requires a **defined** function, and throws `ProgramAbiInvariantError`
(`src/codegen/program-abi-class-callable-planning.ts:246`, `definedFuncAt` returns
undefined).

## Minimal repro (six lines, plain `main`)

```ts
class Registry extends Map<string, number> {}
const plain = new Map<string, number>();
plain.set("x", 1);
const r = new Registry();
export function test(): number { return (plain.has("x") ? 1 : 0) + (r.has("a") ? 1 : 0); }
```
→ `Codegen error: inherited class callable Registry_set … handle 13`

**The discriminator is the separate plain use — `extends Map` alone compiles
clean.** That defeated five earlier reduction attempts. Also reproduces with
`extends Set`, in plain JS/CJS, and on `--target gc` without `platform: node`
(handle 54).

## Scope — this does NOT move the standalone score

On `--target standalone` / `wasi` this pattern is caught first by the explicit
**#2620** "native collection subclass not yet supported" guard — loud and correct.
**The standalone lane is protected by design here.** This is a host-lane /
npm-dogfood defect: it is what blocks a real 149-file ESLint graph from compiling.
Do not size it against the standalone ES5 objective.

## Related measurement worth keeping

#3672's premise (2 GB / 45-min OOM) does **not** reproduce: 12.5 s/572 MB,
11.6 s/592 MB, 18.6 s/633 MB at the issue's own `--max-old-space-size=2048`, and
16.4 s/717 MB at 8 GB — all exit 0 with a structured report. `--trace-gc`:
1 mark-compact, peak heap 439 MB, `average mu = 0.996`. `--cpu-prof`: 54.2 %
TypeScript, ~14 % `stat`/`read`/`open`, no `src/` module above 3.5 %. It is fast
because codegen **aborts** on this defect ~12 s in — so any budget measured today
is a budget on an early abort.

## Acceptance

- The six-line repro compiles.
- The inherited-alias lookup distinguishes a **defined** function from a host
  **import** handle rather than matching on textual key prefix.
- A permanent regression test covering both `extends Map` and `extends Set`, with
  and without a separate plain use of the builtin.
- The ESLint `linter.js` graph gets past this abort (it will surface whatever is
  next; that is expected and should be recorded, not treated as a failure of this
  fix).
