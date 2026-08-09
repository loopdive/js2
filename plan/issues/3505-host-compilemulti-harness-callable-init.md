---
id: 3505
title: "Host compileMulti must initialize harness callables after exports wiring"
status: done
sprint: 73
completed: 2026-07-20
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: bug
area: test262-runner
goal: test262-conformance
lane: A
assignee: ttraenkler/codex-fyi-compilemulti-init
related: [3188, 3284, 3491, 3496]
files:
  - scripts/test262-worker.mjs
  - src/codegen/declarations.ts
  - tests/issue-3505-host-compilemulti-harness-callable-init.test.ts
loc-budget-allow:
  - src/codegen/declarations.ts
---

# #3505 — Host compileMulti must initialize harness callables after exports wiring

## Problem

The completed serial FYI GC run at project commit
`422608b2d021fc474b4b5b1b607d71c47d363e1b` has one remaining
initialization-timing verdict gap:

```text
language/module-code/instn-uniq-env-rec.js
```

The project/CI runner passes the identical path, while the literal FYI harness
fails with `sameValue is not a function`. The path has a static fixture graph,
so FYI selects host `compileMulti`. Literal `assert.js` assigns
`assert.sameValue` and invokes it at top level, but graph initialization starts
during WebAssembly instantiation, before the worker can call `setExports` and
make exports-backed callable-property dispatch usable.

## Verified evidence (2026-07-20)

- FYI GC completed **52,995** tests at `422608b2`: **30,722 pass** and
  **22,273 fail**.
- Comparison against the current project runner found **19** identical-path
  CI-pass/FYI-fail verdict gaps. This path is the only member of group G3; the
  other 18 gaps have different causes tracked separately.
- Both runs use pinned Test262 commit
  `63829c6d925e24a3f5f307b08754aaa1c412c6a6`.
- The path also passed project baseline commit `2f274075`, an ancestor of the
  FYI project commit. Test source drift and later compiler-only changes are
  therefore excluded.
- The failure is specific to the graph-linked host path. Single-source FYI GC
  already defers top-level initialization until after `setExports`; host
  `compileMulti` does not.
- The observed FYI signature is exactly `sameValue is not a function`, matching
  the exports-backed callable timing failure diagnosed in #3284 RC1.

## Root-cause hypothesis to verify

`compileMulti` already synthesizes a dependency-ordered, exactly-once graph
initializer. The FYI fixture branch intentionally omitted the host
`deferTopLevelInit` option because an earlier implementation generated a second
`__module_init` export for Module-goal graphs. The current compiler must be
checked directly: if the graph initializer can now be exported once, the
worker should run that same initializer only after `setExports`, without
wrapping or rewriting the literal harness or fixtures.

## Root cause

The hypothesis split into two verified layers:

1. The FYI worker's fixture-graph branch omitted `deferTopLevelInit`, so host
   `compileMulti` installed the graph initializer as the Wasm start function.
   Literal `assert.js` therefore tried to call its newly assigned
   `assert.sameValue` closure during instantiation, before `setExports` made
   the exports-backed closure wrapper callable.
2. Merely enabling the established deferred-init option was not sufficient.
   `generateMultiModule` calls `compileDeclarations` once per source file with
   an accumulating declaration/init context. Each pass emits a progressively
   more complete `__module_init`. With deferral enabled, every pass added the
   same export name, so V8 rejected the result because `__module_init` was
   exported more than once. The last emitted initializer is the authoritative
   one: it contains every dependency and the entry in resolver order. Earlier
   partial initializers must remain unexported and uncalled.

The fix replaces any earlier compiler-owned `__module_init` export when the
next cumulative initializer is emitted, then applies host deferral to the FYI
graph branch. The worker instantiates first, wires `setExports`, and invokes the
single retained initializer through its existing call site. Standalone keeps
its `_start` model and receives no new option.

## Acceptance criteria

- A reduced multi-file host graph assigns a callable to an object property and
  calls that property at top level without failing before exports wiring.
- The exact unmodified Test262 FYI GC path passes with its literal `assert.js`
  and fixture graph.
- Initialization stays dependency ordered and exactly once, including cycles.
- No test, harness, fixture, property name, or expected value is rewritten.
- Standalone behavior is unchanged.
- #3284 RC2 and #3491/#3496 controls remain green.

## Validation plan

- Add a focused reduced graph regression and the exact FYI path.
- Run the affected #3284 RC2, #3491, and #3496 suites.
- Run TypeScript typecheck, Prettier, issue-ID/spec-coverage, Test262 hard-error,
  and oracle-version gates.

## Implementation summary

- Retained only the newest cumulative `__module_init` export across
  `compileMulti` source passes. This preserves the existing dependency-ordered
  body rather than choosing an earlier partial initializer.
- Passed the existing host-only `deferTopLevelInit` option through the FYI
  static-fixture branch. No Test262 source, harness include, fixture, or
  expected value is rewritten.
- Added a reduced two-file graph that proves all three timing invariants: the
  graph has not run immediately after instantiation, its dependency runs before
  the entry's top-level callable-property assertion, and each body runs once.
- Added the exact literal FYI GC path and its unchanged standalone verdict as
  regressions.

### Rejected approach

Passing `deferTopLevelInit` without changing cumulative export handling was
tested first and failed at instantiation with two `__module_init` exports. A
call-dispatch special case or harness rewrite would only mask the ordering bug
and was not used.

### Test results

- New reduced/exact/standalone suite: **3/3 pass**.
- Combined #3284 RC2, #3491, #3496, and #3505 controls: **21/21 pass**.
- Exact FYI GC result changed from `sameValue is not a function`,
  `reachedTest: false` to runtime pass with `reachedTest: true`.
- Exact standalone result remains a runtime pass with `reachedTest: true`.
- TypeScript typecheck and changed-file Prettier check pass.
- Issue-ID collision, issue-spec coverage, verdict-oracle, oracle-ratchet, LOC
  budget, and Test262 hard-error gates pass. The hard-error gate reports zero
  hard errors; the intentional seven-line `declarations.ts` invariant is
  covered by this issue's scoped LOC allowance.
