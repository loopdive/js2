---
id: 4534
title: "jsdom: VirtualConsole loses inherited EventEmitter methods — 'on is not a function', 5 of 6 upstream tests fail"
status: in-progress
sprint: current
created: 2026-08-16
updated: 2026-08-20
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: classes, inheritance
goal: npm-library-support
related: [4299, 3995, 1533]
files:
  - tests/dogfood/jsdom-upstream-suite.mjs
  - src/codegen/closure-exports.ts
  - src/codegen/class-bodies.ts
loc-budget-allow:
  - src/codegen/closure-exports.ts
  - src/codegen/class-bodies.ts
---

# jsdom: `class VirtualConsole extends EventEmitter` has no `on`

## Current checkpoint (2026-08-20)

The focused upstream slice now compiles and passes **6/6 original tests in
Wasm** (and 6/6 in Node) on the working branch for draft PR #4660,
`codex/react-redux-infra`. The fix combines the host-backed subclass member
bridge with callback capture-slot preservation, dynamic array-method dispatch
for host-owned receivers, and distinct closure bodies for same-shaped object
literal methods. The measured run is:

```text
testsRegistered=6  nativePassed=6  wasmPassed=6  wasmFailed=0
compileSucceeded=1  compileValidated=1  runtimeFailed=0
```

The full upstream package still has 17 source files; this harness intentionally
selects the six tests from `test/api/virtual-console.js` and defers the other
16 files (312 callbacks). The issue remains open until the infrastructure is
landed and the reduction/regression coverage is committed; the draft PR is not
yet a claim that all jsdom APIs work.

## Problem

The jsdom pinned slice (`test/api/virtual-console.js`, 6 tests): **1/6 Wasm**
(6/6 Node), 2026-08-16 on `a9b20d4c`, matching the npm-compat card. All five
failures are the same message:

```text
on is not a function
```

`VirtualConsole extends EventEmitter` (node:events, supplied by the
harness's shim/host environment). Methods inherited from a base class whose
implementation lives **outside the compiled module** (host-provided or
shim-declared) are not reachable on the compiled subclass instance:
`vc.on(...)`, inherited from the extern base, resolves to nothing.

This is the narrow, measured slice of what #4299 (full jsdom API suite)
will hit everywhere; fixing it is prerequisite work for that issue and for
any package subclassing node builtins (#1533's host-import family).

## Reproduction

```bash
node --import tsx tests/dogfood/jsdom-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Establish the intended semantics first**: check how the harness
   provides `EventEmitter` (grep tests/dogfood/jsdom-upstream-suite.mjs for
   the events shim). Two legitimate designs: (a) EventEmitter is a
   *compiled* shim class → then `extends` over a same-module class losing
   methods is an ordinary heritage bug; (b) EventEmitter is a *host*
   constructor → then this needs the extern-heritage path (subclass whose
   proto chain hangs off a host object). Read the generated module to see
   which one the compiler actually saw.
2. **For (a)**: reduce to two compiled classes, `class A { on(){…} }`,
   `class B extends A {}`, instance created via `new B()` crossing the host
   bridge, then `b.on(...)` called dynamically. Compare with #4291 (imported
   class alias heritage) and #4288 (imported anonymous class constructor
   identity) — the fix likely lives in the same heritage/member-dispatch
   plumbing; extend whichever pass those landed.
3. **For (b)**: route the subclass's method lookup through the host bridge
   when the member is not found on compiled structs (the
   `__member_kind_<key>` discriminator path in src/codegen/index.ts already
   cascades struct types; it needs a host-proto fallback arm) — and state
   explicitly in the PR if this is host-lane-only, per the dual-mode rule
   (standalone needs at least an honest "unsupported" diagnostic, not a
   silent miss).
4. **Validation gates**: reduction test; jsdom slice 1/6 → ≥5/6 (the
   remaining test may hit the next missing emitter feature — record it);
   hono/react suites (heavy class users) unchanged.

## Acceptance criteria

- [x] Inherited methods callable on compiled subclass instances for the
      pattern jsdom uses.
- [x] jsdom pinned slice ≥ 5/6, residual named (the selected slice is now 6/6;
      16 upstream files remain intentionally deferred by the harness).
- [ ] Reduction test committed.
