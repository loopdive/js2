---
id: 7131
title: "Legacy wrong answers: Array.prototype.<m>.call on a string receiver, and join of null elements on a dynamic receiver"
status: ready
created: 2026-10-22
sprint: Backlog
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: codegen
goal: core-semantics
related: [7106, 7119]
---

# Legacy wrong answers in generic Array.prototype methods (measured 2026-10-22)

Both were found while planning the #7106 `compareArray.format` arm. They were
measured on standalone and default gc. IR and legacy-only compiles give the
same answers, because no unit here is claimed by the IR.

## 1. `Array.prototype.<m>.call(<string>, …)` with dynamic arguments

```js
function gmap(r, f) { return Array.prototype.map.call(r, f); }
function gjoin(r, s) { return Array.prototype.join.call(r, s); }
function gslice(r, a, b) { return Array.prototype.slice.call(r, a, b); }
function gforEach(r, f) { return Array.prototype.forEach.call(r, f); }
```

| call | node | legacy |
| --- | --- | --- |
| `gmap("ab", String).join(",")` | `a,b` | wrong (check fails) |
| `gjoin("xyz", ".")` | `x.y.z` | wrong |
| `gslice("abc", 1, 2).join(",")` | `b` | wrong |
| `gforEach("pq", f)` collecting values | `pq` | wrong |

The same four methods answer like node for an array-like
(`{ length: 2, 0: "a", 1: "b" }`), a real array and `arguments`.

Why it matters for #7106: the planned IR arm wraps exactly this legacy emission
(a detached template `Array.prototype.<m>.call(recv, a0, …)` over externref
parameters, #7119's technique). It would inherit this bug for string
receivers, at parity with legacy.

## 2. `join` of a null element through a dynamic receiver

`function f9(r) { return "[" + r.join(", ") + "]"; }` called with
`[1, null, "y"]` does not answer node's `"[1, , y]"`. Join must map
null/undefined elements to the empty string (§23.1.3.18 step 7.c).

## Acceptance criteria

- Every row above answers as node on standalone and default gc, with tests
  that compare against node.
