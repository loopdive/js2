---
id: 6508
title: "#6504 Defect A split: the four residual rows are THREE unrelated defects, none of them the call-argument await erasure"
status: ready
sprint: current
created: 2026-09-18
updated: 2026-09-18
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: async-await
goal: test262-conformance
related: [6504, 6502, 6492]
---

# #6508 — splitting #6504's Defect A

#6504 listed five rows under one defect ("`await thenable` yields the thenable").
Round 29's spill continuation fixed **one** of them
(`language/expressions/await/await-awaits-thenables.js`, now passing on both
lanes). This issue carries the other four, which were grouped by co-occurrence,
not by cause: reduced individually they are **three different defects, and none
is the call-argument `await` erasure**.

Measured on the linked lane at `f30b8c6749` (round 29), then reduced with
`.tmp/r29/probe.mts` — a single linked compile plus an `unhandledRejection`
verdict channel, seconds per iteration.

## The three causes

### (a) `optional-chain-async-square-brackets.js` — await NESTED in an operand

```js
assert.sameValue([22, 33]?.[await Promise.resolve(1)], 33);   // declines
```

Reduced line by line. `await [11]?.[0]` (the await's OPERAND is an optional
chain) is fine and already passes — the awaited expression's shape is irrelevant
to the planner. What declines is the await **inside the index expression**: the
containing statement is `assert.sameValue(<expr containing await>, 33)`, so the
await is not the direct argument of the call, and `planSpilledCallAwait`
correctly refuses it.

This is the round-26 census's **`nested-operand`** bucket (12 events), not a new
one, and not an optional-chaining bug: `f(1 + await x)` has the identical
structure. The fix is the same spill ABI extended to spill the PARTIAL operand,
which #6504 already tracks. The optional-chain-specific part is only the last
assertion in the row:

```js
assert.sameValue(undefined?.[await Promise.reject(new Error('unreachable'))], undefined);
```

— the short-circuit must skip the await **entirely**, so the rejection is never
awaited. That ordering constraint is real and belongs with the nested-operand
work.

**Verdict signature when declined:** the probe reports NOTHING — neither the
assertion nor the sentinel. That silence is #6504's defect B (the legacy
pass-through's rejection never reaches an unhandled promise) and is how a
declined body looks from the outside.

### (b) `member-expression-async-identifier.js` — the #6502 null dispatch

Fails with `TypeError: Cannot read properties of null (reading 'then')` — i.e.
`asyncTest`'s `testFunc().then`, where `testFunc()` answered **null**. That is
#6502's exact signature (a cross-module closure dispatch returning null), not an
await problem.

The body's own await statements were reduced and **all pass**:

```js
var a = undefined;
var c = { d: Promise.resolve(11) };
assert.sameValue(await a?.b, undefined);     // passes
assert.sameValue(await c?.d, 11);            // passes
Promise.prototype.x = 42;
var res = await Promise.resolve(undefined)?.x;
assert.sameValue(res, 42);                   // passes
```

So the awaits are correct and the failure is at the `asyncTest(checkAssertions)`
seam. Note the sibling row (a) uses the SAME `asyncTest(checkAssertions)` shape
and gets a real assertion failure rather than the null — so the null is specific
to this body, and `Promise.prototype.x = 42` (mutating `Promise.prototype`
before the dispatch) is the obvious suspect and the first thing to instrument.

**Route to #6502**, do not treat as async-await.

### (c) `iteration-statement-for-await-of.js` — the async-iterator protocol

```js
for await (const num of obj?.iterable) { … }   // obj.iterable has [Symbol.asyncIterator]
```

Fails with `TypeError: [object Object] is not iterable`. The source object
implements **`Symbol.asyncIterator`** only; the error says the for-await head
looked for a SYNC iterator. Nothing to do with optional chaining (`obj?.iterable`
resolves fine) or with the spill ABI. Separate defect in the for-await-of
head's iterator-protocol selection.

### (d) `dynamic-import/assignment-expression/await-expr.js` — dynamic `import()`

Fails with `SameValue(«undefined», «"Test262"»)`: the dynamic import resolved to
`undefined` instead of the module namespace. Unrelated to all of the above.

## Why this matters beyond the four rows

The five rows were filed as one defect because they failed together on the same
lane in the same run. Co-occurrence in a failure list is not shared causation,
and here it produced a four-way mis-grouping that survived from round 6 to round
29 — including into a dispatch brief that asked for "the optional-chaining rows"
as if they were one shape with one fix. Two of them are not optional-chaining
defects at all, and the one that is is an instance of a bucket already tracked
elsewhere.

**Reduce before grouping.** Each of these took under a minute with the
single-compile probe.

## Acceptance criteria

- (a) tracked in #6504's nested-operand work, including the
  `undefined?.[await <rejecting>]` short-circuit-skips-the-await ordering.
- (b) re-attributed to #6502 with the `Promise.prototype` mutation instrumented.
- (c) new issue or existing for-await-of iterator-protocol work: the head must
  prefer `Symbol.asyncIterator`.
- (d) own diagnosis for dynamic `import()`.
- #6504 keeps ONLY the spill ABI and its remaining shapes.
