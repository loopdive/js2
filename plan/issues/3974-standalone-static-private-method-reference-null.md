---
id: 3974
title: "Issue 3974: standalone — a STATIC private method reference (`C.#f` / `this.#f` in a static method) evaluates to `null`"
status: ready
created: 2026-08-01
updated: 2026-08-01
goal: standalone-gap
sprint: current
priority: medium
horizon: m
feasibility: hard
---

# Issue 3974: standalone — static private method reference evaluates to `null`

## Status: ready

## Summary

In `--target standalone`, reading a **static** private method as a VALUE — `C.#f`,
or `this.#f` inside a `static` method — yields something that stringifies to
`"null"`. The instance case (`this.#f` in an instance method) is a different,
also-wrong value but at least a callable: it stringifies to the native-code
placeholder.

Split out of the untagged standalone triage; **independent of #3973** (the
`any`-typed string element-read defect). #3973's fix does not move these.

## Evidence

Baseline standalone, `built-ins/Function/prototype/toString/`:

```
private-static-method-class-expression.js  Conforms to NativeFunction Syntax: "null"
private-static-method-class-statement.js   Conforms to NativeFunction Syntax: "null"
```

versus the instance siblings, which render the placeholder instead:

```
private-method-class-expression.js   Conforms to NativeFunction Syntax: "function () { [native code] }"
private-method-class-statement.js    Conforms to NativeFunction Syntax: "function () { [native code] }"
```

Direct probe (standalone):

```js
class C {
  static #f() {}
  static get2() { return C.#f; }
}
var m = C.get2();
// typeof m === "function"  BUT  ("" + m) === "[object Object]"
```

Note the probe and the test262 files disagree on the exact wrong value
(`"[object Object]"` vs `"null"`), so there are plausibly two adjacent bugs
here: the static private **slot read** and the **string conversion** of whatever
it returns. `typeof` reporting `"function"` while `String(...)` falls through to
`Object.prototype.toString` says the value is not being recognised as a function
by the string-conversion path.

The same four files also fail in the **host (gc)** lane with the identical
messages, so unlike #3973 this is **not** standalone-specific — it is a
private-static-member lowering defect that both lanes share.

## Probe

Reproduce with (standalone lane):

- `test262/test/built-ins/Function/prototype/toString/private-static-method-class-statement.js`
- `test262/test/built-ins/Function/prototype/toString/private-static-method-class-expression.js`

A permanent `tests/issue-3974.test.ts` should be added by whoever fixes this;
the two paths above are the authoritative repro until then.

## Acceptance criteria

- `C.#f` (and `this.#f` inside a `static` method) evaluates to the actual method
  function object.
- `typeof` and `String(...)` agree — i.e. the value routes through
  `Function.prototype.toString`, not `Object.prototype.toString`.
- `built-ins/Function/prototype/toString/private-static-method-class-{statement,expression}.js`
  reach the same verdict as their instance siblings.

## Notes

Measuring this needs a paired per-file A/B and an in-sweep control, per the
standing measurement discipline — the two files are a population GATED, not a
flip forecast.
