---
id: 2174
title: "standalone: `arguments` captured by a nested function under async emits invalid Wasm (__closure fallthru i32 vs externref)"
status: ready
sprint: Backlog
created: 2026-06-16
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: fix
area: codegen
language_feature: closures
goal: core-semantics
related: [2106, 1503]
origin: "2026-06-16 — surfaced while diagnosing the recurring standalone-guard false positive on the value-rep PRs (#1503/#1511)"
---

# #2174 — standalone async + `arguments`-in-nested-closure → invalid Wasm

## Problem

In **standalone/WASI** mode, an async function (or async method) that captures
the `arguments` object into a nested function emits an **invalid Wasm binary**
(compile_error at instantiate), not a runtime failure.

A 23-test cluster in test262 hits this single signature:
`language/{statements,expressions}/{async-function,class/async-method,...}/
returns-async-{arrow,function}-returns-arguments-from-{own,parent}-function.js`.

**Error signature (verified on main @ 24e520df8, `--target wasi`):**
```
WebAssembly.compile(): Compiling function #NN:"__closure_0" failed:
  type error in fallthru[0] (expected i32, got externref) @+...
```
i.e. a generated `__closure_*` body leaves an `externref` on the stack where the
function signature's fallthrough result expects `i32` — a stack/type mismatch in
the closure that captures `arguments` under the async lowering.

## Reproduces

`language/statements/async-function/returns-async-function-returns-arguments-from-own-function.js`
compiles to invalid Wasm in standalone. Source shape:
```js
async function asyncFn(x) {
  let a = arguments;
  return async function () { return a === arguments; };
}
```
A hand-minimized `async function f(x){ let a=arguments; return async function(){return a===arguments;}; }`
does NOT yet reproduce in isolation — the bug needs the fuller test262 harness
shape (procedurally generated with the async `assert.sameValue` continuation), so
the trigger is an interaction between the async state-machine lowering, the
`arguments`-object capture, and the nested-closure return. **First task: bisect
the test262 file down to a minimal repro.**

## Why it matters beyond conformance (the meta-bug)

This cluster is recorded as `pass` in the standalone baseline
(`test262-standalone-current.jsonl`) but **fails to compile on current main** —
i.e. the baseline is stale here. That stale entry makes the standalone
regression guard (#1897) fire a `Net: -19 / 23 wasm_compile` **false positive on
every unrelated value-rep PR** (#1503, #1511, #1514 all hit the identical
fingerprint; #1503 had to be admin-overridden). Fixing this bug (so main can
compile these, then the baseline promotes them to a real `pass`) removes both the
conformance gap AND the recurring guard noise. (Short-term, the baseline should
be refreshed off a green main run so the guard stops blocking PRs.)

## Root cause (hypothesis — needs confirmation)

A `__closure_*` generated for the nested function captures `arguments` (an
externref / boxed args object) but the closure's emitted body or its declared
result type disagree on `i32` vs `externref` at the fallthrough. Likely the
`arguments`-object capture under the async lowering writes the wrong ValType into
the closure env field or the closure func-type, so the final value left on the
stack (externref) doesn't match the declared i32 result. Candidate areas:
`closures.ts` (env capture + `__closure_*` emission), the async state-machine
lowering (`async-scheduler.ts` / async function-body), and how `arguments` is
materialized + captured (`arguments`-object builder).

## Acceptance criteria

- `language/statements/async-function/returns-async-function-returns-arguments-from-own-function.js`
  and its 22 sibling cluster tests compile to **valid Wasm** in standalone and
  pass; host mode unchanged.
- A minimized repro test in `tests/` guarding the closure/async/`arguments`
  interaction.

## Notes

- Independent of the value-rep lane (#2106 etc.) — pure closure/async codegen.
- `feasibility: hard` / `reasoning_effort: max`: async state machine + closure
  capture + `arguments` is a three-way interaction; route to a senior dev after
  the bisect narrows the site.
