---
id: 5372
title: "`const u = cond ? await f() : v` inside an async function leaves `u` holding the Promise — the await in a conditional-expression operand is not suspended on (marked Hooks cluster B, the 10 async tests)"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
---

## Problem

Split out of #5358 after its agent measured that marked's 10 async
`Hooks.test.js` failures are NOT the runtime-key read the issue was filed for.

Inside an async function, an `await` that sits in a branch of a conditional
expression used as a variable initializer is not suspended on for most
callee shapes — the binding receives the **Promise** itself:

```js
function later(v) { return new Promise((r) => setTimeout(() => r(v), 1)); }
async function laterAsync(v) { await later(0); return v; }

async function f(cond) {
  const u = cond ? await later("A") : "B";     // u is a Promise, not "A"
  ...
}
```

Measured on `a22e2d2623` + #5672 (standalone `.mjs` through
`compileProject`, `target: "gc"`, untyped `.js` fixture), every variant an
async function with `cond === true`:

| initializer                                              | `u` reads   |
| -------------------------------------------------------- | ----------- |
| `cond ? await later("A") : "B"` (plain fn → `new Promise`) | **Promise** |
| `cond ? "B" : await later("A")` (await in the else branch)| **Promise** |
| `cond ? await laterAsync("A") : "B"` (async fn callee)   | **Promise** |
| `cond ? await fn("A") : "B"` (any-typed callee param)    | **Promise** |
| `cond ? await hooks.pre("x") : "B"` (object-literal `async pre()`) | `"Px"` ✓ |
| `await later("A")` (no conditional)                      | `"A"` ✓     |
| `let u = "B"; if (cond) u = await later("A");`           | `"A"` ✓     |

Only the object-literal async-method operand suspends. A direct call to a
function declaration, an async function declaration, or an `any` callee does
not — the await is dropped and the Promise flows on as the value.

## Why marked cares (this is Hooks cluster B)

marked's `parseMarkdown` async arm is exactly this shape:

```js
return (async () => {
  let u = i.hooks ? await i.hooks.preprocess(n) : n,
      c = await (i.hooks ? await i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(u, i),
      ...
  return i.hooks ? await i.hooks.postprocess(h) : h;
})().catch(o);
```

With `u` a Promise, the lexer receives `"[object Promise]"`-shaped input and
the pipeline degrades until `parse` resolves `undefined`; the test then reads
`html.trim()` and dies with `Cannot read properties of null (reading 'trim')`
— the error #5345/#5358 attributed to the hook read. A marked-free bisect of
that shape (`asyncParse` in the #5358 notes) answers
`html="<p>[object Promise]</p>"`; the hook wrapper `use()` installs works on
its own (`wrapperOnly` → `"Wmd"`), and the sync arm works (`syncParse` →
`"<p>St</p>"`).

The 10 tests: `should preprocess async`, `should preprocess options async`,
`should postprocess async`, `should process all hooks in reverse`, `should
provide lexer async`, `should provide lexer async hook`, `should provide async
lexer from async hook`, `should provide parser async`, `should provide parser
async hook`, `should provide async parser from async hook` — `Hooks.test.js`
stays 9/30 with #5358 merged.

## Where to look

`src/codegen/async-cps.ts` has a conditional-initializer arm (~L1747:
`if (ts.isConditionalExpression(initializer))`) that recognizes exactly this
shape, gated on `awaitSet.has(initializer.whenTrue|whenFalse)`. The table
above says the arm (or the fallback it returns `null` into) treats the operand
differently by callee shape, so the first question is how `awaitSet` is built
— whether an `await` whose operand is not a checker-visible `Promise<T>` (an
`any` call, a `new Promise` return) is left out and the await then compiled as
a no-op. Also check the `let u = …, c = …` multi-declarator form marked uses
(`seen === decls.length`).

## Acceptance criteria

1. Every row of the table reads the awaited value; the two `✓` rows and the
   `if`-form stay as they are.
2. A regression test under `tests/` with the table as untyped `.js` fixtures
   (each an async function; `.then` the exported promise on the host), failing
   on the parent for the four Promise rows.
3. marked `Hooks.test.js` ≥ 19/30 (the 10 tests above), measured through
   `tests/dogfood/marked-upstream-suite.mjs`; A/B over the 17 suites at one
   HEAD, per test file.
4. Standalone lane: byte-identical unless the change is deliberately shared.

## Also seen, not this issue

Reducing marked's shape with the async IIFE placed inside an async FUNCTION
(`async function g() { const p = (async () => {...})().catch(o); await p; }`)
produced a module that codegens but fails `WebAssembly.instantiate`
(`__async_resume_fasyncIifeOnly: not enough arguments on the stack for
local.set`) — on the parent too, so it is pre-existing and separate. marked's
real module validates because its IIFE sits inside a plain arrow. Worth its
own issue once reduced further.
