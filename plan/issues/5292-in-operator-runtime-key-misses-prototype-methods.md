---
id: 5292
title: "`key in instance` with a RUNTIME key misses prototype methods — marked's `use({hooks})` always throws"
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
func-budget-allow:
  - src/codegen/binary-ops-in.ts::compileInOperator
---

## Problem

§7.3.12 [[HasProperty]] is prototype-inclusive. `compileInOperator`'s
dynamic-key arm compares the key against `structFieldNames` — the receiver's
**physical struct fields** — and a class's instance methods live on the
prototype with no field of their own. So a runtime key naming a method matched
nothing and the operator answered `false`.

A string-**literal** key takes the checker-backed static fold above and answers
correctly, which is exactly what hid this:

```js
class P { pre(e) { return e; } }
const d = new P();
"pre" in d                              // → true   (literal, folded)
for (const i in { pre() {} }) i in d     // → false  (runtime key)   ✗
```

marked's `use()` is that loop verbatim:

```js
let r = this.defaults.hooks || new _Hooks();
for (let i in n.hooks) {
  if (!(i in r)) throw new Error(`hook '${i}' does not exist`);
  …
}
```

so **every** `marked.use({ hooks })` threw `hook 'preprocess' does not exist`.

## Fix

Extend the dynamic-key comparison set with the receiver class's instance method
names, walked up `ctx.classParentMap` so inherited methods count too
(`ctx.classMethodNames` already records them per class). Adding names can only
turn a `false` into a `true`, and every name added is one the prototype
genuinely carries, so no currently-correct answer moves.

## Measured

- `tests/in-operator-prototype-methods.test.ts`: 3 of its 5 cases fail on the
  parent commit; all 5 pass with the fix. The two that already passed are the
  guards — a runtime key the prototype does NOT carry still answers `false`,
  and the literal-key answer is unchanged.
- Through the upstream-suite harness (`compileAndRunUpstreamModule`), a marked
  bisect goes from `hook 'preprocess' does not exist` to passing for
  `m.use({hooks})`, `use + parse`, and `use + parse` with a concatenating hook.
- Sixteen upstream npm suites re-run: no package number changed.

**Note on sources:** the regression test's fixtures are plain untyped `.js`,
matching how the upstream suites feed package code in. Annotating the receiver
`: any` routes the operator to the externref `__extern_has` arm instead and
does not exercise this path at all — an earlier draft of the test did that and
passed identically with and without the fix.

## marked is still 0/30 — a second defect follows this one

With this fixed, `const m = new Marked(); m.use({hooks}); m.parse(…)` works.
The suite still fails because its tests build the instance in a hook:

```js
let m;
beforeEach(() => { m = new Marked(); });
it("…", () => { m.use({ hooks: { preprocess(md) { … } } }); … });
```

That form still throws `Cannot convert object to primitive value`, while the
identical code with a function-LOCAL `m` now passes.

Bisected to **three lines, with no marked involved**:

```js
class C { use(...e) { return e.length; } }
let g; g = new C();
g.use({});          // → "Cannot convert object to primitive value"
```

The ingredients are exactly two, and both are required:

| receiver binding | method | result |
| ---------------- | ------ | ------ |
| `let g; g = new C()` | `use(...e)` | **throws** |
| `const g = new C()`  | `use(...e)` | ok |
| `let g; g = new C()` | `use(e)` (no rest) | ok |
| `let g; g = new C()` | `use(e)` with `forEach` + `this` | ok |

A `let` binding puts the receiver in a live-binding global, so it reads back as
`externref` rather than the concrete struct. `call-receiver-method.ts` then
*deliberately* declines the closed method dispatcher for it — `hasUserRestMethod`
clears `hasUniformUserMethodAbi`, with the comment "a rest vec would be mistaken
for one positional argument" — and the call falls to the generic
`__extern_method_call` host path. That path passes the arguments positionally,
but the compiled callee's ABI expects the rest **vec**, so the callee reads a
plain object where the vec belongs and the first thing that stringifies it
throws.

marked's `use(...e)` is that method, and its tests hold the instance in a
`beforeEach` closure, so every one of the 30 hits it. Teaching the host bridge
the rest ABI (or giving the closed dispatcher a rest arm) is the fix; it is
squarely runtime-bridge work, not a narrowing of this issue.
