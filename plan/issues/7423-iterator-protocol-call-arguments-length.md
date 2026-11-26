---
id: 7423
title: "arguments.length is 1, not 0, in a class iterator's next()/return() called by for-of / spread / destructuring / Array.from"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-26
completed: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7413, 7424]
---

# #7423: `arguments.length` in padded iterator calls

## Problem

Found by RV7342's review of PR #7342 (#7413), measured on main `89e47482`; details in https://github.com/loopdive/js2/pull/7342#issuecomment-7019348242.

A class iterator's `next` / `return`, called by for-of, spread,
destructuring or `Array.from`, sees `arguments.length === 1`. Node sees `0`:
these protocol calls pass no argument. Object-literal iterators were already
correct.

Re-measured on main `6694a8b8` (2026-11-26). Each probe returns
`arguments.length * 10 + kind(arguments[0])`, where kind is 1 for undefined:

| call | node | gc / standalone / wasi |
| --- | ---: | ---: |
| for-of `next()` | 1 | 11 |
| spread `next()` | 1 | 11 |
| `Array.from` `next()` | 1 | 11 |
| for-of `break` → `return()` | 1 | 11 |

## Root cause

The `__call_@@iterator` / `__call_next` / `__call_return` dispatchers
(`emitMethodDispatch` in `src/codegen/index.ts`) call the class method with
its declared formals padded with `undefined` (#7413). A method that reads
`arguments` takes its length from the `__argc` global, and these dispatchers
left `__argc` at its `-1` "unknown caller" sentinel, which means "use the
formal count". The callee therefore saw one argument.

## Fix

`zeroArgCallInstrs` in `src/codegen/zero-arg-method-pad.ts` is the module for
synthesized zero-argument method calls (#4644). It wraps the dispatcher's
`call`: when the callee is in `funcUsesArguments`, it sets `__argc` to 0
before the call and resets it after, using the same reset the other call
sites use (`buildArgcResetNoLazyExtras`). Methods that do not read
`arguments` get exactly the call they had before.

## Acceptance

- `tests/issue-7423-iterator-call-arguments-length.test.ts` pins node's
  answer (1) on gc, standalone and wasi for the four calls above. All four
  fail on main `6694a8b8`.
- Destructuring is covered by #7424, which routes array destructuring of a
  user iterator through the same `__call_next` / `__call_return` dispatchers.
