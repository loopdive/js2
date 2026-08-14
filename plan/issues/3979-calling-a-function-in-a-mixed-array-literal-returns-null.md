---
id: 3979
title: "Calling a function stored in a MIXED-type array literal silently returns `null` instead of invoking it"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures
goal: core-semantics
related: [3977]
---

# Calling a function held in a mixed-type array literal returns `null`

## Problem

When an array literal holds elements of more than one type, calling a function
element through a subscript does not invoke it — the call evaluates to `null`,
with **no trap and no diagnostic**.

```js
export function run() {
  const p = [1, () => 7];
  return p[1]();
}
//  native: 7
//  wasm:   null
```

The array being **heterogeneous** is the trigger, not the subscript and not the
closure:

| program                                            | native | wasm     |
| -------------------------------------------------- | -----: | -------- |
| `const p = [1, () => 7]; p[1]()`                    |      7 | `null`   |
| `const p = ["x", () => 7]; p[1]()`                  |      7 | `null`   |
| `const pairs = [[1, () => 7]]; pairs[0][1]()`       |      7 | `null`   |
| `const p = [() => 5, () => 7]; p[1]()`              |      7 | 7 — OK   |
| `const fns = [() => 7]; fns[0]()`                   |      7 | 7 — OK   |
| `const o = { f: () => 7 }; o.f()`                   |      7 | 7 — OK   |

A homogeneous array of functions is fine; an object property holding a function
is fine. Only the widened element type of a mixed array loses the callable.

## Why this matters more than the shape suggests

**It is a silent wrong answer.** Nothing traps, nothing is reported at compile
time, and `null` is a perfectly ordinary value for a caller to receive — so the
error surfaces arbitrarily far from its cause, or not at all. Every other
callable-through-a-container form in the table works, which makes the failure
easy to mistake for a bug in the program under compilation.

The `[value, callback]` tuple is also an extremely common JS idiom — dispatch
tables, `Object.entries`-shaped pairs, `Map` initialisers, option lists — so
this is not an exotic corner.

## Where it came from

`lit-html`'s published `choose` directive, via lit's own upstream test suite
(#3977):

```js
var r = (r2, o2, t) => {
  for (const t2 of o2) if (t2[0] === r2) return (0, t2[1])();
  return t?.();
};
```

`cases` is an array of `[value, () => result]` tuples — exactly the failing
shape. All three of `choose`'s upstream tests fail, each reporting `null` where
a value was expected:

```
choose › no cases          expected null to strictly equal undefined
choose › matching cases    expected null to strictly equal "A"
choose › default case      expected null to strictly equal "C"
```

The `(0, f)()` comma-expression indirect call in lit's minified output is **not**
implicated — plain `t2[1]()` fails identically, and `(0, f)()` on a plain local
works.

## Acceptance criteria

- [ ] Calling a function element of a heterogeneous array literal invokes it
      and returns its result.
- [ ] All six rows in the table above match native.
- [ ] `lit-html`'s `choose` directive passes its three upstream tests in the
      #3977 suite.
- [ ] An equivalence test covers the `[value, callback]` tuple dispatch idiom,
      including the nested `[[value, callback]]` form.
- [ ] The fix does not convert the silent `null` into a trap — the call must
      work, not merely fail loudly.

## 2026-08-12 upstream-suite measurement

The generic upstream runner now proves that closure properties in records
pushed into an initially empty heterogeneous array execute correctly, which is
enough for the selected Lodash QUnit registry. The literal tuple forms above
remain broken: both `[1, () => 7][1]()` and `[[1, () => 7]][0][1]()` return 0
instead of 7. The regression file records those two as explicit expected
failures; this issue is not resolved by the npm-suite integration work.
