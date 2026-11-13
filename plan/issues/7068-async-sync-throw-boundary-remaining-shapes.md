---
id: 7068
title: "standalone async: an async function body that throws BEFORE its first `await` throws synchronously out of the call in two more shapes — a no-await async declaration called through its function-value trampoline (`call(f)`), and the `Array.fromAsync` / `AsyncDisposableStack` built-ins; standalone `import()` rejects with a TypeError instead of resolving — 12 ES2017+ test262 rows passed only because #6995 swallowed the rejection"
status: ready
sprint: current
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: async-await, promises, trampolines, import
goal: standalone-gap
related: [6995, 6996]
---
# Remaining synchronous throws from async bodies on standalone

Found while repairing PR #6700 (#6995): once awaited rejections are delivered honestly, these rows stop passing vacuously. They are ES2017+ (not in a completed edition), so they did not park the PR, but they are wrong.

## Shapes

1. **Function-value trampoline**: `async function f(){ throw new Error("x"); } function call(g){ return g(); } call(f).then(_, e => console.log("rejected"))` — on standalone the call throws synchronously instead of returning a rejected promise. Site: `src/codegen/method-trampolines.ts` settle points (two); PR #6700's implementer measured that a tag-only catch at those two sites fixes it. The owner's #6700 repair covered only the already-Promise-promoted native void-closure boundary (`src/runtime/wasmgc/async/native-await.ts`).
2. **Built-ins**: `Array.fromAsync(...)` and `AsyncDisposableStack` methods throw synchronously where the spec returns a rejected promise (six test262 rows under `built-ins/Array/fromAsync` and `built-ins/AsyncDisposableStack`).
3. **Dynamic import**: standalone `import()` rejects with a TypeError (six rows under `language/expressions/dynamic-import` and `module-code`).

## Implementation Plan

1. One shared "async entry boundary" in the runtime: every async-function entry (declaration, expression, arrow, method, trampoline, built-in async entry) catches the compiler JS-value exception tag around the synchronous prefix and rejects its own `$Promise` with the reason (§27.7.5.1 AsyncBlockStart abrupt completion). Reuse the #6700 repair's boundary helper rather than adding per-site catches.
2. `import()` on standalone: decide refuse-at-compile vs resolve-with-module-namespace for the supported cases; today's TypeError rejection is neither.
3. Tests: the trampoline shape and one `Array.fromAsync` shape in `tests/equivalence/issue-7068-async-sync-throw-boundary.test.ts`; list the 12 test262 rows in this file and confirm each flips to a genuine pass or a typed refusal.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.
