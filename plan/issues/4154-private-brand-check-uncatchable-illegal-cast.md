---
id: 4154
title: "private access on a foreign receiver traps `illegal cast` instead of throwing the §7.3.28 PrivateBrandCheck TypeError"
status: ready
sprint: Backlog
priority: medium
goal: error-model
feasibility: medium
horizon: m
created: 2026-08-04
requested_by: ttraenkler/claude-bench
related: [4149, 3189]
---

# #4154 — PrivateBrandCheck traps instead of throwing

## Problem

`o.#m = v` where `o` does not carry the class's private brand emits an
unguarded cast of the receiver. On a foreign object that is an **uncatchable
`illegal cast` trap**, where §7.3.28 PrivateBrandCheck requires a **catchable
TypeError**.

The canonical shape is test262's own brand-check tests:

```js
class C {
  set #m(v) { this._v = v; }
  access(o, v) { return o.#m = v; }
}
let c = new C();
c.access(c, 'test262');          // fine — c has the brand

let o = {};
assert.throws(TypeError, function () {
  c.access(o, 'foo');            // must throw TypeError; today: illegal cast trap
});
```

Because the trap is uncatchable, `assert.throws` cannot catch it and the whole
module dies — so the test cannot pass even in principle until this is fixed.

## How it surfaced

It is **latent**, not new. It was masked by a second defect: `this._v = v`
inside the setter targeted a field with no declaration, and the generic
struct-write path dropped that write outright (`fieldIdx === -1 → return null`).
So the test failed at its FIRST assert (`Test262Error: Expected
SameValue(«undefined», «"test262"»)`) and never reached the brand check.

#4149 made undeclared-field writes land (routing them to the dynamic terminal).
The tests now get past the first assert and reach the brand check — where they
hit this trap. Measured by A/B on a single file, both tests:

| tree | result |
| --- | --- |
| `upstream/main` | `Test262Error: Expected SameValue(«undefined», «"test262"»)` |
| #4149 branch | `RuntimeError: illegal cast in C_access() at source L33` |
| #4149 branch, `assignment.ts` reverted | back to `Test262Error` |

Both files are `fail` in the baseline in every arm — this is a change of
failure MODE (fail → fail), never a pass→fail. It was caught by the #3189
uncatchable-trap ratchet in the merge queue (`illegal_cast` 48 → 50) and
declared under `trap-growth-allow` in `plan/issues/4149-*.md`.

## Affected tests (the two the ratchet named)

- `test/language/statements/class/elements/private-setter-brand-check.js`
- `test/language/statements/class/elements/static-private-setter-access-on-inner-class.js`

Fixing this should make both **pass**, not merely stop trapping: each one's
remaining assertion is exactly the `assert.throws(TypeError, …)` that the
catchable throw would satisfy.

## Fix sketch

The private-accessor / private-field write paths in
`src/codegen/expressions/assignment.ts` coerce the receiver to the declaring
class's struct type before calling the setter. That coercion must become a
`ref.test`-guarded branch: on failure, emit the spec TypeError via
`emitThrowTypeError` instead of letting `ref.cast` trap. The read side
(`compilePropertyAccess`) needs the symmetric treatment — check it before
assuming only the write is affected.

## Acceptance

- The repro above throws a catchable TypeError on both lanes.
- Both named test262 files pass.
- `illegal_cast` trap population does not grow; ideally it drops by 2 and the
  `trap-growth-allow` declaration in #4149 can be retired.
