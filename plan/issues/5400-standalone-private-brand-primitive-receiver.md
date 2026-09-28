---
id: 5400
title: "Throw TypeError for primitive receivers of standalone private-brand checks"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
parent: 5393
func-budget-allow:
  - src/codegen/binary-ops-in.ts::compileInOperator
assignee: "ttraenkler/codex-native-private-brand"
---

## Measured defect

At `f816631c2ee108bd75ae916f94aac4f9ef9abcf5`, the differential corpus
`private-fields/05-brand-checks.js` prints `true`, `false`, `true` in Node.
Standalone prints only `true`, `false`: `#v in null` returns false, so the
expected TypeError handler does not run. The result reproduces with IR disabled.

```js
class Box {
  #v;
  static isBox(obj) { return #v in obj; }
}
console.log(Box.isBox(new Box()));
console.log(Box.isBox({}));
try { Box.isBox(null); } catch (e) { console.log(e instanceof TypeError); }
```

## Implementation

The private-name lowering already distinguishes a matching brand from a wrong
object brand, but runs the primitive-receiver Object check only on the host.
Standalone now uses the shared native Object predicate. It excludes null and
other primitives while accepting callable objects. Helper registration and the
TypeError constructor occur before instruction arrays capture function indices.

## Acceptance criteria

- [x] Null, undefined, and other primitive receivers throw a catchable TypeError.
- [x] Matching instances return true and other object/function receivers return false.
- [x] Host and standalone agree with Node, with optimization on and off.
- [x] Standalone adds no host imports.
- [x] Relevant private-brand regression tests pass without widening baselines.

## Validation

The new receiver regression suite passes 8/8 checks across host/standalone and
optimization disabled/enabled. Every standalone module has zero imports. It
checks nine primitive values and matching/unrelated class instances, plain
objects, arrays, and functions. Node supplies the expected JavaScript behavior.

The adjacent private-access suite passes 1/4; the three failures reproduce
unchanged on the exact baseline commit above (one null-pointer trap and two
missing TypeError results in `.call()` on private-access receivers). This repair
covers the private-name `in` operator, not private-property access.
