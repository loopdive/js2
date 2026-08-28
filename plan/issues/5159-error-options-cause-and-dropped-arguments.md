---
id: 5159
title: "Error/AggregateError options.cause never installed on the host lane, and the Error lowering drops (never evaluates) arguments after the message"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [1339, 1634, 3481]
---

# Two Error-family defects, measured during #3481 cause-2 (PR #5161)

Both were measured **identical with and without** that PR's change (file-copy
A/B on `origin/main` 2026-08-28), so they are pre-existing and independent of
the message-ToString fix.

## Defect 1 — `options.cause` does not work at all (host lane)

| expression | measured | spec (§20.5.1.1 step 4 / InstallErrorCause) |
| --- | --- | --- |
| `new Error("m", {cause: 1}).cause` | absent / `NaN` | `1` |
| `new AggregateError([], "m", {cause: 1}).cause` | absent / `NaN` | `1` |

#1339/#1634 ("AggregateError + SuppressedError errors-iterable + cause
coercion", both `done` 2026-06) addressed a cause-coercion slice, yet the
plain `Error` + `AggregateError` host-lane behavior above is broken today —
either those fixes covered a different lane/builtin subset or this regressed
since. The dispatched fix must first bisect which, and cite the answer here.

## Defect 2 — arguments after the message are compiled and DROPPED

The Error lowering compiles argument expressions past the message and then
discards them, so a side effect in the options position never runs:

```js
let hit = 0;
new Error("m", (hit++, {cause: 1}));
// hit is 0 — the expression never executes
```

Per spec every argument is evaluated. This is the same silent-collapse family
as #5095's swallowed diagnostic — the module is "successfully" compiled with
observably missing evaluation.

## Notes for the implementer

- The #5161 fix added a single-index message coercion at the host boundary
  (`_errorMessageToString` in `src/runtime.ts`, plus the `resolveImport`
  extern-class bridge); the `options` bag deliberately crosses uncoerced.
  Installing `cause` likely belongs beside that boundary — read the #3481
  issue file's cause-2 record first.
- `SuppressedError` is unimplemented in this host entirely (its whole test262
  directory fails); do not widen into implementing it here.
- Check the codex lane's claim ledger before dispatch: their es2015 residual
  lanes are active (#4785–#4789, #5122–#5137 at time of filing; none touched
  Error `options.cause`).

## Acceptance criteria

- `new Error("m", {cause: v}).cause === v` and the AggregateError twin, host
  lane; standalone behavior measured and either fixed or recorded.
- Argument expressions after the message evaluate exactly once, in order
  (side-effect probe pinned).
- test262 `built-ins/Error/cause*` / `AggregateError/cause*` rows measured
  before/after with the count stated plainly.
- Byte-identity for Error constructions without options; equivalence shards
  clean by name.
