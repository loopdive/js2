---
id: 5330
title: "Namespace import of a bare Node builtin binds an empty object"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`import * as path from 'path'` (bare builtin specifier, **namespace** form)
bound an **empty object**: `typeof path.join === 'undefined'`,
`path.sep === undefined`, `String(path) === '[object Object]'`. Calls surfaced
as `TypeError: join is not a function`. The same import written
`from 'node:path'` worked, as did the bare **default** form
`import path from 'path'`.

Production witness: jest's `jest-haste-map` `fast_path.test.js` (0/5) and
`get_mock_name.test.js` (0/1), plus `jest-util` `isError.test.ts` (3 tests using
`import * as vm from 'vm'`).

## Root cause — NOT the specifier normalisation it looks like

The obvious suspect is `src/checker/index.ts`, whose Node-emulation scan gates
on `spec.startsWith("node:")` while `src/cjs-rewrite.ts` normalises bare
builtins for `require()`. **Measured: extending that gate to bare specifiers
changes nothing** — every one of the failing probes still failed. Recorded here
so it is not re-tried.

The real site is `tryEmitCompiledModuleNamespaceObject`
(`src/codegen/module-namespace-value.ts`), the optimizer that materializes a
namespace object out of a module's compiled exports. It asks the **checker** for
those exports. With no `@types/node` in the program, a **bare** builtin
specifier resolves to nothing at all, so `getExportsOfModule` answers `[]` — an
empty array, which is **truthy**. The optimizer therefore built
`__new_plain_object()` with no properties and published it as the namespace,
shadowing the `__node_path` host module thunk the module was still importing.
(The compiled module's import list is the tell: the bare row imports
`__new_plain_object` where the `node:` row imports `__node_path`.)

`node:path` escaped only by **accident**: the injected ambient
`declare module "node:path"` gives it one export whose only declaration lives in
a `.d.ts`, which trips the optimizer's "mutable value → decline the whole
object" arm and falls through to the host binding.

## Fix

Decline up front, for the real reason: a namespace import **of** a Node builtin
is served by the host module object and must never be synthesized. One guard at
the top of `namespaceFunctionExports`.

Scope: this does not touch a user module that **re-exports** builtin members
(`export { join } from 'node:path'`) — that namespace belongs to the user
module and keeps its `host-member` lowering. Asserted in the regression test.

## Evidence

- jest dogfood: **320/356 → 329/356** (+9). `fast_path.test.js` 0/5 → 5/5,
  `get_mock_name.test.js` 0/1 → 1/1, and — not predicted by the original triage,
  which had filed it as a missing host builtin — `isError.test.ts` 17/20 → 20/20,
  because `import * as vm from 'vm'` was binding `{}` the same way.
- `tests/issue-5330-bare-builtin-namespace-import.test.ts`: **1 failed / 2 passed
  → 3 passed**.
- Probe matrix (dogfood harness), before → after:
  `import * as path from 'path'` join/sep/relative/resolve: all broken → all
  correct; `node:path` namespace, bare default import: correct → correct
  (unchanged).

## Residual (measured, out of scope)

`import { join } from 'path'` — and `from 'node:path'` — still answers `null`.
That is a defect in the #1791 path shim's NAMED bindings
(`buildPathNamedBinding` emits a rest-forwarding stub that returns null), it
affects both spellings equally, and no jest test uses that form.
