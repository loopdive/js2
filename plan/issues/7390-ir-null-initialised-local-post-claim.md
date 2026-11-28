---
id: 7390
title: "IR: a function-local `var z = null` is claimed, then withdrawn (null initialiser into an f64 slot)"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7332]
---

# #7390: a null-initialised local withdraws its function

## Problem

PR #7316 (#7332) covers two literal forms. It lowers a literal `null`
operand of prefix `-`/`+`/`!` as 0, and it refuses a literal-null field in
an object literal. A **local binding** that holds `null` is not covered. The
withdrawal comes from the declaration itself, not from the use: the local's
slot resolves to `f64`, and the `null` initialiser then reaches the
`NullKeyword` arm of `lowerExpression` in `src/ir/from-ast.ts`, which throws.
Every program below is claimed and then withdrawn (a post-claim error in
`irPostClaimErrors`), with the same message for `h`:

`ir/from-ast: bare 'null' in non-reference context (f64) is not supported in IR (h)`

```js
var o; function h() { var z = null; o = -z; } h();
var o; function h() { var z = null; o = { a: z }; } h();
var o; function h() { var z = null; o = z; } h();
function h() { var z = null; return 1; } h();      // z unused
function h() { let z = null; return 1; } h();
```

- **Where it reproduces:** gc, standalone and wasi, on main `89e47482` and on
  branch `claude/7332-null-into-number` `52954db4`. On that branch the
  literal forms `o = -null` and `o = { a: null }` no longer withdraw.
- **These forms do not withdraw:** `function h() { var z = null; return { a: z }; }`
  and `... return z;` are refused at select (`return-type-not-resolvable`);
  `var z; z = null;` is refused at select (`body-shape-rejected`); and a
  script-level `var z = null` is fine.
- **Runtime values are correct**, because legacy runs the unit: `o = -z`
  gives `-0` on standalone and gc, as in node.

## Direction

- **Option 1: the selector refuses it.** It refuses a local whose
  initialiser is `null` when the local's resolved slot type is scalar (the
  same family test `nullValueAdmissible` applies in from-ast).
- **Option 2: from-ast gives it a reference slot.** It types a
  null-initialised local as a reference or dynamic slot instead of `f64`,
  and then lowers the uses (`-z`, `{ a: z }`) the way #7332 lowers the
  literal.
- **Test:** pin the five repros with `irPostClaimErrors` empty.
