---
id: 2848
title: "compiled-acorn THROWS parsing `new.target`, `yield <expr>`, and `for await…of` — additional parser-execution walls beyond the #2838 return wall"
status: done
completed: 2026-06-30
sprint: current
priority: medium
horizon: m
feasibility: hard
created: 2026-06-29
task_type: bugfix
area: codegen, runtime
language_feature: meta-property, generators
goal: acorn-dogfood
related: [1712, 2838, 2837, 2325]
depends_on: [2838]
umbrella: 1712
---

> **RESOLVED 2026-06-30 (verified, not separately fixed).** These three
> constructs were filed from the corpus's pre-return-wall run. A re-run of
> `tests/dogfood/acorn-corpus.mjs` after the **#2838 / #2325** return-wall +
> dynamic-prototype-accessor-dispatch family landed shows `corpus/new-target.js`,
> `corpus/generators-async.js`, and `corpus/for-await.module.js` all
> **`equal±quirks`** — they parse correctly. As suspected, they were the same
> dynamic-dispatch family as the `return` wall and cleared with it. Kept as a
> regression record; the repros below are good regression pins.

# #2848 — compiled-acorn throws on `new.target` and `yield <expr>`

Surfaced by the wider acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella). Beyond the **`return` wall**
already tracked by **#2838** (`status: in-progress`, "acorn return wall"),
the corpus localized **three more** value-carrying parser constructs on which
compiled-acorn throws a `WebAssembly.Exception` mid-parse, while node-acorn
produces a valid AST:

1. **`new.target` (MetaProperty)** — `function F() { new.target; }` throws.
   (No `return` involved — distinct from the #2838 path.)
2. **`yield <expr>` (YieldExpression with an argument)** —
   `function* g() { yield 1; }` throws, but bare `function* g() { yield; }`
   parses fine. The _argument_ is the trip.
3. **`for await … of` (ForOfStatement `await: true`)** —
   `async function f() { for await (const x of s) {} }` throws even with an
   empty loop body (no `return` involved).

## Minimal repros

```js
function F() {
  new.target;
} // THROWS (node-acorn: MetaProperty)
function* g() {
  yield 1;
} // THROWS (node-acorn: YieldExpression{argument})
function* g() {
  yield;
} // OK     (bare yield parses)
async function f() {
  for await (const x of s) {
  }
} // THROWS (node-acorn: ForOfStatement await:true)
```

## Localization (from `.tmp/probe-throws*.mjs`, current main with #2837/#2838/#2325 landed)

The dominant throw class is the `return` statement (`return x;` AND bare
`return;` both throw → #2838). The corpus discriminator run additionally
isolates `new.target`, `yield <expr>`, and `for await…of` as throwing
**independently of `return`**. The exact thrown payload is opaque (the compiled `__exn` tag carries
an externref and is not exported, so the host sees only
`[object WebAssembly.Exception]`), so root cause is not yet pinned — but the
shape strongly suggests the **same dynamic prototype-accessor-dispatch family**
as #2838 (a `this.<accessor>` read inside acorn's `parseExprAtom`/`parseNew` /
`parseYield` that returns null → trap), just on different acorn parser methods.

## Action

- Verify after #2838 (return wall) lands whether its fix subsumes these — they
  may clear for free. If not, fix the residual parser-method dispatch.
- This issue exists so the two non-`return` walls are not lost when #2838 closes.
  Hence `depends_on: [2838]`.

## Acceptance

- `tests/dogfood/acorn-corpus.mjs`: `corpus/new-target.js`,
  `corpus/generators-async.js`, and `corpus/for-await.module.js` no longer
  `compiled-parse-threw`.
- Focused regression checks for `new.target`, `yield <expr>`, and
  `for await…of` parsing.
- No test262 regression.
