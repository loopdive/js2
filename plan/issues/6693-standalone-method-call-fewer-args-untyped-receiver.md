---
id: 6693
title: "standalone: a class method called with FEWER arguments than it declares, through an untyped receiver, throws `called value is not a function` — marked's Parser (`this.parser.parseInline(e)`)"
status: ready
sprint: Backlog
created: 2026-09-26
updated: 2026-09-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
goal: standalone
related: [3507, 6672, 6677]
---

# #6693 — method call with fewer args than params, untyped receiver

## Problem

Found by [#6677](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6677-standalone-runtime-regexp-compiler-full-grammar),
which moved marked's npm-compat **standalone-dynamic** lane past
`TypeError: Unsupported dynamic regular expression pattern`. The lane now fails
at the checksum call with:

```
TypeError: called value is not a function
```

Narrowed on marked 18 compiled standalone: `Lexer.lex("a")` is correct (one
`paragraph` token whose inline tokens match Node), `new Parser().parseInline(tokens)`
is correct, but `renderer.paragraph(token)` throws. `Renderer.paragraph` is
`` paragraph({tokens:e}){return`<p>${this.parser.parseInline(e)}</p>\n`} `` and
`Parser.parseInline` is declared `parseInline(e, t = this.renderer)` — TWO
parameters, called with ONE argument through `this.parser`, a class field whose
static type is erased.

Minimal repro (untyped `.js`, `target: "standalone"`; Node answers `1`):

```js
var R = class { p; go(e) { return this.p.inl(e); } };
var P = class { r; constructor() { this.r = new R(); this.r.p = this; } inl(e, t) { return "n" + e.length; } };
export function test() { try { return new P().r.go([1, 2]) === "n2" ? 1 : 0; } catch (e) { return -1; } }
// standalone: -1 (TypeError: called value is not a function)
```

The same call with both arguments (`this.p.inl(e, 0)`) answers `1`, and so does
a one-parameter method. A free function receiving the object
(`function go(o, e) { return o.inl(e); }`) fails the same way, so the defect is
the arity match in the untyped method-call dispatch (`__call_m_<name>_<argc>`,
#3507), not the class field.

## Acceptance criteria

- The repro answers 1 under `--target standalone`, and a call with MORE
  arguments than parameters keeps working (extra arguments are evaluated and
  dropped, §10.2.1).
- marked's standalone-dynamic lane moves past `called value is not a function`.
