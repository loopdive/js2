---
id: 7328
title: "IR: `var nv = null` in the script dynamic home is claimed, then rejected by from-ast"
status: done
completed: 2026-11-07
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7106, 7287, 7127, 7305]
---

# #7328: a `null` script var claims `<module-init>`, then from-ast refuses it

## Problem

`writeValueMatches`' dynamic-home arm (`src/ir/module-bindings.ts`) accepts
any value into a script var's dynamic home. Its comment says "the IR lowers it
to the dynamic carrier or refuses the unit when it has no boxing producer".

That does not hold for `null`. from-ast's `lowerExpr` null arm only lowers
`null` into a reference consumer (`nullValueAdmissible`). The dynamic carrier
has no `null` producer, so the selector claims `<module-init>` and from-ast
rejects it afterwards. That is a post-claim build error (`irPostClaimErrors`).

## Repro (main; base 63018c49; bare compile)

```js
var nv = null; nv;
```

On standalone, wasi and gc this gives `<module-init>: ir/from-ast: bare 'null' in non-reference context (dynamic) is not supported in IR`.

The unit falls back to legacy, so the output is correct, but the IR
invariant is broken. #7305 can newly reach this through
`var nv = null; function u(g) { g(1); } u(nv);`, because `u` no longer keeps
`<module-init>` unclaimed.

## Fix (owner: the module-bindings dynamic-home arm)

There are two options:

- refuse a `null` initializer in the dynamic-home arm, with the same rule
  from-ast applies (`nullValueAdmissible` of the consumer);
- or give the carrier a `null` producer (a `dyn.null`, like #7104's
  `dyn.undefined`).

Either way, pin a bare compile of the repro with `irPostClaimErrors` empty.

## Resolution (2026-11-07)

Fixed by #7164 (`c0dcb01a`, review round 3), which this branch now merges. The
selector's var-declaration arm (`src/ir/select.ts`) refuses a `null`
initializer into a script var's dynamic module home (`vardecl-module-value-flow`),
the same rule from-ast applies: the IR has no dynamic `null`. The unit keeps the
legacy body instead of claiming and withdrawing. Both repros give
`irPostClaimErrors` `[]` on standalone, wasi and gc:

```js
var nv = null; nv;
var nv = null; function u(g) { g(1); } u(nv);
```

The `null` producer option (`dyn.null`) is not taken. The related literal
`null` into an `f64` context is #7332.

