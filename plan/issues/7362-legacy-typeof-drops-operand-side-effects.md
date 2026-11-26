---
id: 7362
title: "Legacy `typeof` drops its operand's side effects when the answer is static"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7361]
---

# #7362 — Legacy `typeof` drops its operand's side effects when the answer is static

## Problem

When a function compiles through the legacy (direct AST→Wasm) path, `typeof <operand>` whose answer is known at
compile time answers the tag but never runs the operand. ECMAScript evaluates the operand first
(`UnaryExpression : typeof UnaryExpression`, step 1), so calls and assignments inside it must happen.

Found in the adversarial review of [#7361](7361-typeof-static-answer-from-hinted-operand.md) (review round 3), which
fixes the same shapes on the IR path only.

## Reproduction (2026-11-19, `origin/main` `ee3fcdd6`)

Each program is `export function g() { <body> }` in a `.js` file, compiled with the default target and with
`--target standalone`; both give the same wrong answer. The function goes to legacy in all three.

| Declarations | Body | node | js2wasm |
| --- | --- | ---: | ---: |
| `var n = 0;` | `var t = typeof (n = 5, void 0); return t === "undefined" ? n : -1;` | 5 | 0 |
| `var n = 0; function f() { n = n + 1; return 1; }` | `var t = typeof (n = 5, void f()); return t === "undefined" ? n : -1;` | 6 | 0 |
| `var n = 0; function f() { n = n + 1; return 1; }` | `var t = typeof void f(); var u = (n = n + 10, 1); return t === "undefined" ? n : -1;` | 11 | 10 |

A statement-position `typeof (n = 5, void 0); return n;` keeps the effect (answers 5); the loss is in the value
position.

## Acceptance criteria

- The three programs answer like node on both targets.
- The operand still runs exactly once (pin a call counter).
- JS-environment output for programs whose `typeof` operand has no side effects stays byte-identical.
