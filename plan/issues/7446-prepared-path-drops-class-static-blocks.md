---
id: 7446
title: "Prepared path silently drops class static blocks: wrong value instead of a refusal"
status: ready
sprint: current
created: 2026-11-21
updated: 2026-11-21
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
goal: backend-agnostic-ir
related: [7354, 7364]
---

# Prepared path silently drops class static blocks

## Problem

On the Prepared whole-program path (`wholeProgram: {kind: "prepared-program-required", version: 1}`,
`src/test262/test262-prepared-entry.ts`) the code of a class static block is not compiled and not refused. The
program compiles, validates and runs with the block missing, so it returns a wrong answer.

```js
var n = 2;
class C { static { n = 7; } }
if (n !== 2) throw 0;   // node throws 0; the Prepared path returns normally
```

The path's rule is: JavaScript's answer or a named refusal, never a wrong value. Found by the review of PR 7370
(slice S of #7354) on 2026-11-21; it reproduces on main at b8a0553f80, so that PR did not cause it. 7 of 13 probe
programs with a static block gave a wrong answer (6 a wrong value, 1 ran where node throws).

A consequence: a call the path refuses by name elsewhere (`Object.defineProperty(o, …)`) is not refused inside a
static block, because from-ast never meets it.

## Acceptance criteria

- A class static block on the Prepared path is either lowered with JavaScript's semantics (runs once at class
  definition evaluation, in order with static field initializers, `this` = the class) or refused by name at compile
  time. No program with a static block compiles to a module that skips the block.
- Probes against node: assignment to an outer `var`, a throw inside the block, several blocks in order, a block
  beside static fields, a block that reads `this`, a nested class with its own block, a class expression.
- The ordinary pipeline's output is unchanged.

## Notes

- Not an ES5 construct: no ES5 test262 row depends on it. It is filed because it breaks the path's soundness rule.
- Where to look first: how the Prepared resolver (`src/ir/program-source.ts`) collects a class's members into units;
  a `ClassStaticBlockDeclaration` is probably not a unit and nothing refuses the class for having one.
