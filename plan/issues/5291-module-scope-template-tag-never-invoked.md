---
id: 5291
title: "A module-scope template tag is never invoked — `` tag`abc` `` silently evaluates to `undefined`"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
loc-budget-allow:
  - src/codegen/string-ops.ts
func-budget-allow:
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
---

## Problem

`compileTaggedTemplateExpression`'s closure arm resolved the tag through
`fctx.localMap` only:

```ts
const closureInfo = ctx.closureMap.get(tagName);
if (closureInfo) {
  const localIdx = fctx.localMap.get(tagName);
  if (localIdx === undefined) {
    reportError(ctx, expr, `Tagged template: closure variable '${tagName}' not found`);
    return null;
  }
```

A top-level `const tag = (s) => …` is registered in `ctx.closureMap`, so the arm
is entered — but the binding is a module GLOBAL, not a local of the calling
frame, so the lookup misses. Returning `null` means "no value produced", which
makes the enclosing `return` answer `undefined`. Two lines reproduce it:

```ts
const tag = (s: any): any => s[0];
export function test(): any { return tag`abc`; }   // → undefined, expected "abc"
```

The tag is never invoked, and the module compiles clean — `success: true`,
`errors: []`. The whole expression lowers to a single `call __get_undefined`.
The **identical** arrow declared inside the function works, as does a function
DECLARATION tag, which is what hid this.

## Fix

Read the closure from `ctx.moduleGlobals` / `ctx.capturedGlobals` when it is not
a local. A module global is always the widened `externref` carrier, so it takes
exactly the normalization the arm already performs for an externref local
(`any.convert_extern` + guarded cast into a correctly-typed self local).

A `...rest` tag is deliberately **not** claimed by this arm: it marshals one
positional slot per substitution, which is not the rest ABI, and the mismatch
traps. Leaving that shape to the generic arms below keeps its pre-existing
behaviour rather than trading a silent `undefined` for a null-pointer trap.

## Measured

`tests/module-scope-template-tag.test.ts`: 5 of its 7 cases fail on the parent
commit; all 7 pass with the fix. The two that already passed are the guards —
a function-declaration tag and a function-local tag.

Upstream npm suites re-run after the change: every package identical to the
pre-change numbers (webpack 16/16, cookie 63740/63740, lodash 53/62, redux
60/82, three 17/18, clsx 32/32, …). Nothing regressed.

## Not the lit blocker

Found while chasing lit's 106 `dereferencing a null pointer` traps. It is
**not** their cause — lit's generated tests declare `branding_tag` as a
function-LOCAL const, which always worked, and the lit suite is unchanged at
0/151 after this fix. The two remaining gaps in the same function are recorded
below; lit's trap is elsewhere and still open.

## Adjacent, still open

- A `...rest` tag (`` const tag = (s, ...v) => …; tag`a${x}b` ``) still answers
  `undefined` — the arm declines it on purpose, and no later arm claims it.
- `s.raw[0]` inside a module-scope tag still answers `undefined`.
