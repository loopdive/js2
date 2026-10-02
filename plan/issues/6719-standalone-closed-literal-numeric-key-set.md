---
id: 6719
title: "standalone: a generic Array method writing an index of a closed object literal (`{0:0, length:1}`) does not update its `0` field"
status: ready
sprint: current
created: 2026-09-27
updated: 2026-09-27
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6701]
---

# #6719 — standalone: index store into a closed object literal misses its field

## Problem

Found while fixing [#6701](./6701-standalone-any-receiver-array-residuals.md).
A transferred `Array.prototype.splice` now works on an array-like built by
assignment, but not on one written as a literal with numeric keys (measured
2026-09-27, `--target standalone`):

```js
var obj = {0: 0, 1: 1, 2: 2, 3: 3}; obj.length = 4;
obj.splice = Array.prototype.splice;
obj.splice(0, 3, 4, 5);
obj[0];   // 0 (expected 4)
```

The literal compiles to a closed struct with fields `0`…`3`; the generic
bodies store through `__extern_set_strict(obj, <boxed number>, v)`, which does
not reach the struct's `"0"` field, while `obj[0]` reads it. The same numeric
index key is right on an open `$Object` and on a vec. test262:
`built-ins/Array/prototype/splice/S15.4.4.12_A2_T1`…`_T4` (the
`S15.4.4.10`/`push`/`unshift` genericity rows are likely the same).

## Acceptance

- The row answers 4 in `--target standalone`; the four `S15.4.4.12_A2_T*`
  rows pass with no loss in `built-ins/Array/prototype`.
