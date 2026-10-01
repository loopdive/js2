---
id: 6778
title: "linear backend: `string + number` emits `f64.add` on an i32 string pointer — invalid binary with `success: true`, zero diagnostics"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: string-concat
goal: crash-free
related: [6776, 6793, 1868, 1976, 3908]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C2"
---

# #6778 — linear `+` with one string operand compiles to numeric addition

## Problem

```ts
export function f(): number { const s = "1" + 2; return s.length; }
```

`compile(src, { target: "linear" })` → `success: true`, `errors: []`.
`WebAssembly.compile(binary)` →
`Compiling function #50:"f" failed: f64.add[0] expected type f64, found if of type i32`.
Reproduced against the built `dist/index.js` on 2026-09-30.

## Root cause

`src/codegen-linear/index.ts:2510`:

```ts
if (isStringExpr(ctx, fctx, expr.left) && isStringExpr(ctx, fctx, expr.right))
```

The string-concat path requires **both** operands to be strings; a mixed `+`
falls through to the numeric path, which emits `f64.add` on whatever the
string side left on the stack (an i32 pointer). Nothing between codegen and
the result checks the binary (#6776), and `collectLinearCodegenErrors`
(`src/compiler.ts:1025-1027`) does not see this class because no error was
ever pushed.

#1976 fixed the compound-assignment variant of the same bug (`s += 1`) but
not the plain binary form.

## Correction

Change the test to **either** operand being a string (spec §13.15.3 step 3:
if either ToPrimitive result is a String, concatenate). Coerce the other side
with the backend's existing number→string helper (the one `toFixed`/template
literals use), then emit the concat. If the non-string side is an object
carrier the backend cannot stringify, push a linear codegen error rather than
falling through.

## Acceptance

- The probe returns `2` on `target: "linear"`; also `2 + "1"`, `` `${1}` + "x"
  ``, `"a" + true`, `"a" + null`, `"a" + undefined` match Node.
- Regression test under `tests/linear/` (or the existing linear test file
  family) compiles, validates with `WebAssembly.validate`, instantiates, and
  checks the runtime value.
- A `cross-backend-parity` corpus entry for mixed `+`.
