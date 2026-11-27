---
id: 7422
title: "Fold the iterator dispatcher's padMissingArg into zero-arg-method-pad.ts absentArgInstrs (also fixes a trapping `ref` pad and an invalid anyref pad)"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: refactor
area: codegen
goal: core-semantics
related: [7413, 4644]
---

# #7422: one missing-argument pad for the iterator dispatchers

## Problem

Found by RV7342's review of PR #7342 (#7413), measured on main `89e47482`; details in https://github.com/loopdive/js2/pull/7342#issuecomment-7019348242. The probe encodes the argument as undefined→1, null→2, other→3, plus `10 * arguments.length`.

`padMissingArg` (`src/codegen/index.ts`, in `emitIteratorMethodExport`)
duplicates `absentArgInstrs` / `zeroArgPadInstrs` in
`src/codegen/zero-arg-method-pad.ts` (#4644). The two share one convention:

- f64 → absence sentinel;
- `ref_null` → `ref.null`;
- externref → `canonicalUndefinedExternInstrs` (since #7413).

The copy in `index.ts` carries two defects that `zero-arg-method-pad.ts`
already handles:

- **The `ref` arm traps.** It emits `ref.null` followed by
  `ref.as_non_null`. That validates, but traps at run time;
  `zero-arg-method-pad.ts`'s own doc rejects this idiom.
- **An `anyref` / `eqref` formal produces an invalid module.** It falls to
  `default` and is padded with an externref where an anyref is expected.

## Direction

Call `absentArgInstrs` from the dispatcher. Keep the host `__get_undefined`
branch when that import exists, so that gc output stays byte-identical.
This makes it a fold rather than a straight swap.

## Acceptance

- `padMissingArg` is gone; the dispatcher uses the shared pad.
- Tests cover a class iterator `next(v: SomeClass)` (the `ref` param) and an
  anyref formal, on gc, standalone and wasi, against node's answers.
- Byte identity: only the affected shapes change.
- Implement after #7342 (#7413) lands.
