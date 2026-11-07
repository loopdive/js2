---
id: 7319
title: "Standalone `in`: own properties of functions and Error instances (fn `length`/`name`, Error `message`) answer false"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: runtime
goal: core-semantics
related: [7304]
---

# #7319: `in` misses own properties of non-`$Object` receivers

## Problem

On standalone, `__extern_has`'s non-`$Object` arms do not see some **own**
properties of function and Error carriers.

- A function's `length` and `name` (§20.2.4.1 / .2) are own data properties.
- An Error instance's `message` (§20.5.1.1 step 3) is an own data property.

`in` answers `false` for them, both through a literal key (the IR's native
`in`) and through a dynamic key. Reads of the same keys are right, so `in` and
`p.k` disagree.

This is separate from #7304. That issue is the inherited %Object.prototype% and
builtin-prototype names, not own properties.

## Repro (main `b631a4bc`, `--target standalone`, vs node)

`function h(p, k) { return "<key>" in p; }` (literal key) and
`function h(p, k) { return k in p; }` (dynamic key):

| receiver | key | node | standalone |
|---|---|---|---|
| `(function (a, b) {})` | `length` | true | false |
| `(function f() {})` | `name` | true | false |
| `((a) => a)` | `length` | true | false |
| `new Error('m')` | `message` | true | false |
| `new TypeError('m')` | `message` | true | false |

Both key forms give the same wrong answer.

## Notes

- These are OWN properties, so `hasOwnProperty` / `Object.hasOwn` may share the
  gap. Measure them before widening the own-only predicates: #4017 tried that
  and cost 684 passes through `propertyHelper.js`.
- A fix belongs in the non-`$Object` arms of `__extern_has` (closure carrier:
  arity/name metadata; `$Error_struct`: the message field). It must not change
  what ToPrimitive or descriptor reads see beyond these exact own keys. #7304's
  first cut showed that `__extern_has` is shared with ToPrimitive, where an
  extra `true` breaks `String(obj)`.
