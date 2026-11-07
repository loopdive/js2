---
id: 7304
title: "native `in`: a dynamic receiver that is not an open `$Object` misses the implicit `%Object.prototype%` terminal (`\"toString\" in {x:1}` → false)"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: core-semantics
related: [7276, 7142]
---

# #7304: native `in` misses `%Object.prototype%` for non-`$Object` dynamic receivers

## Problem

`key in obj` with a key that `%Object.prototype%` owns answers false when the
receiver reaches the IR's native `in` as a dynamic value that is not an open
`$Object` (a closed struct literal, a null-prototype object, …):

```js
function h(p) { return "toString" in p; }
if (h({ x: 1 }) !== true) throw "in";
```

| Lane       | IR route (`h` claimed)      | legacy (IR off) | node      |
| ---------- | --------------------------- | --------------- | --------- |
| standalone | throws (`in` answers false) | completes       | completes |
| wasi       | throws                      | throws          | completes |

Measured 2026-11-07 on the #7276 branch (c5afee57); identical on main for this
shape, so it predates #7276. On WASI legacy is wrong too.

## Cause

The IR's native `in` (`__extern_has`) walks only the receiver's own chain and
does not reach the implicit `%Object.prototype%` terminal of an ordinary
object. Legacy's fixed-name helper `__extern_has_with_implicit_object_proto`
answers it for the receivers legacy knows to be an open `$Object`, but its
fallback for every other receiver is the constant 1, which is wrong for a
null-prototype receiver (`Object.create(null)`). Neither helper can stand in
for the other (PR #7142 review, the reviewer's 55/50-case table:
https://github.com/loopdive/js2/pull/7142#pullrequestreview-6698801419).

#7276 does not change either `in`; it refuses any unit whose `in` may reach an
inherited key (`unitInKeysAreOwnOnly`, `src/ir/object-create-call.ts`).

## Acceptance criteria

- `"toString" in p` answers per §13.10.1 (`HasProperty` up the real
  prototype chain) for every dynamic receiver kind on standalone, gc and WASI:
  closed struct literal, open `$Object`, `Object.create(null)`,
  `Object.create({})`, array, function, class instance.
- The reviewer's table re-run shows zero divergences from node.
- gc output byte-identical where the IR does not claim.
- Once fixed, `unitInKeysAreOwnOnly` can be dropped from #7276 / #7280.
