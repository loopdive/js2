---
id: 7642
title: "Direct-eval state-pool tests: a shadowed global copied into a local reads 0, and a provider throw escapes AOT catch"
status: ready
sprint: current
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime-eval
goal: runtime-eval
related: [2928, 7633]
---

# #7642: the two failing rows of `tests/issue-2928-direct-eval-state-pool.test.ts`

Both rows fail on main (ea628a78). Both use `runWithStubProvider`: a provider compiled inside the test that has no
parser, so #7634's stale-stub cause does not apply. They are two different bugs.

## Row 1: "does not let the ambient Object miss arm poison the fallback after eval delete"

The test expects 911 and gets 11. Probes on the same stub provider:

| `run()` body, after `eval(join(["var ignored = ", "0"]))` | result |
| --------------------------------------------------------- | ------ |
| `Object = 9; return Object;` (the sibling test)            | 9      |
| `Object = 9; var before = Object; return before;`         | 0      |
| `Object = 9; let before = Object; … return before;`       | 0      |
| `Object = 9; var removed = delete Object; return removed ? 1 : 0;` | 1 |

So the write lands and the delete works. What is lost is the value copied into a local.

**Unverified hypothesis.** The local takes `Object`'s static type (`ObjectConstructor`), although a direct eval may
have rebound the name. Coercing the externref `9` into that type yields 0. This is not a tag issue, and not the
stub.

## Row 2: "stores an AOT callable carrier that a later provider entry can invoke"

`run()` throws an uncaught `WebAssembly.Exception`. The probe checks which module's tag it carries:

- it is the **provider's** `__exn_tag`, not the user module's;
- a `try { … } catch` around the `eval` in the AOT code does not catch it (the probe returns the exception, not the
  catch value).

This is the cross-module tag mechanism of #7633, in the other direction: provider → AOT instead of AOT → interpreter.

**Open question.** Why the provider throws at all. The stub's `call-made` arm calls the AOT carrier as
`callable(41)`, and its entry does not catch. A conforming provider returns `[false, error]` through the result
envelope (`emitRuntimeEvalResultUnwrap`), which rethrows under the caller's tag. So the fix may belong to the stub (it
must route a failure through the envelope) or to the carrier (the provider must be able to call it). That is not
decided here.

## Acceptance

- Both rows pass.
- Row 2's resolution says whether the stub or the carrier was wrong. If it was the tag, it cites #7633.
