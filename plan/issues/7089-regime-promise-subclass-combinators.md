---
id: 7089
title: "Regime gap: Promise combinators called on a subclass (`Promise.all.call(SubPromise, …)`, `withResolvers.call`) throw instead of constructing through the subclass"
status: ready
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler, runtime
language_feature: Promise
goal: architecture
sprint: current
parent: 5385
related: [6708, 6979, 2637]
---

# #7089 — Promise combinators on a subclass under the native regime

Found during the #6708 flip (2026-10-16): under the native-first default in
a JavaScript environment, and on standalone, these calls throw a Wasm
exception instead of building the result promise through the subclass
constructor:

- `Promise.all`, `Promise.race`, `Promise.any`, `Promise.allSettled`,
  `Promise.try` with `.call(SubPromise, …)`;
- `Promise.withResolvers.call(SubPromise)`.

Under the retired `host-assisted` profile the same programs pass all four
checks of `tests/issue-2637-b2-ctor-closure-registration.test.ts` ("runs the
user body on the capability promise", asserts #1–#4). The flip's follow-up
(PR 6758) pinned that test file to the explicit `host-assisted` spelling, so
no CI row tracks the regime behaviour today. S7 (#6979) deletes that
spelling, at which point the test must either assert the regime or be
retired with this issue as its replacement.

## Plan

1. Reproduce with a `.tmp` probe compiled with `semanticProviders:
   "native-first"` (JS environment, through `wrapCompiledExports`) and with
   `target: "standalone"`: `class Sub extends Promise {}`;
   `Promise.all.call(Sub, [])` → result is a `Sub`, executor ran, resolution
   observable; the same for `race`/`any`/`allSettled`/`try`/`withResolvers`.
   Record which step traps (NewPromiseCapability on a non-%Promise%
   constructor, the executor callback bridge, or the species read).
2. Implement NewPromiseCapability(C) on the native path (`src/codegen/
   async-scheduler.ts` / the native promise provider): call `C` with a fresh
   executor, capture `resolve`/`reject`, validate callable, and route the
   combinator result through it; `withResolvers` returns `{ promise, resolve,
   reject }` from the same capability. Keep the fast path for `C ===
   %Promise%` byte-identical.
3. Tests: re-point `tests/issue-2637-b2-ctor-closure-registration.test.ts`
   at the default profile (and standalone) once green; add the
   `withResolvers.call` case; the test262 `built-ins/Promise/{all,race,any,
   allSettled,withResolvers}/` rows that exercise a subclass must not regress
   on standalone (quote before/after counts).
4. Acceptance: equivalence gate "No new equivalence regressions"; no new host
   import (the promise provider stays native); the direct-AST freeze
   (`plan/method/ir-only-development-freeze.md`) is respected — the fix is
   shared runtime/provider code, not new AST body lowering.
