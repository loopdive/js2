---
id: 7423
title: "arguments.length is 1, not 0, in a class iterator's next()/return() called by for-of / spread / destructuring / Array.from"
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
related: [7413]
---

# #7423: `arguments.length` in padded iterator calls

## Problem

Found by RV7342's review of PR #7342 (#7413), measured on main `89e47482`; details in https://github.com/loopdive/js2/pull/7342#issuecomment-7019348242. The probe encodes the argument as undefined→1, null→2, other→3, plus `10 * arguments.length`.

A class iterator's `next` / `return`, called by for-of, spread,
destructuring or `Array.from`, sees `arguments.length === 1`. Node sees
`0`: these protocol calls pass no argument. The `__call_next` /
`__call_return` dispatchers pad to the method's fixed arity, so the callee
cannot tell an omitted argument from a passed `undefined`. Object-literal
spread shows the same.

Probe answers (the tens digit is `arguments.length`):

| shape | node | base (gc, standalone, wasi) | after #7413 |
| --- | ---: | ---: | ---: |
| class for-of | 101 | 1212 | 1111 |
| class spread / destructuring / `Array.from` | 101 | 1212 | 1111 |
| object-literal spread | 101 | 1111 | 1111 |

## Acceptance

`arguments.length` is 0 in these calls on gc, standalone and wasi. A test
pins node's answers.
