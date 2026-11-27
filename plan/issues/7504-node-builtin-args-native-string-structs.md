---
id: 7504
title: "node: builtin arguments receive native string structs since native-first"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: runtime
goal: core-semantics
related: [7501, 6708, 2701, 1795, 2699]
loc-budget-allow:
  # 2026-11-26: +2 lines in the platform-capability context literal. The
  # adapter needs the runtime's existing native-primitive converter
  # (`_nativePrimitiveToHost`) and its miss sentinel (`_MISS`), and both live
  # only in runtime.ts. The conversion itself is in
  # src/runtime/platform-capability-adapter.ts.
  - src/runtime.ts
---

# #7504: `node:` builtin arguments receive native string structs since native-first

## Problem

Since native-first became the default (#6708 S6, 612cea9864), a string that a
Wasm module passes to a `node:` builtin is a native string struct.
`src/runtime/platform-capability-adapter.ts` forwarded every argument through
the closure wrapper only, so Node received the struct itself and read it as an
empty options object:

- `fs.readFile(struct)` / `fs.stat(struct)` throw `The "path" argument must be
  of type string ... Received [Object: null prototype] {}`;
- `https.get(struct)` connects to `127.0.0.1:443` and raises an unhandled
  `ECONNREFUSED`.

Both errors surface outside any test, so vitest reports them as unhandled
errors. Each one makes the post-merge `issue-tests` gate refuse the whole run
at its integrity step (#7501).

## Fix

The adapter converts each argument with the runtime's existing
`_nativePrimitiveToHost` (strings, symbols, boxed numbers, booleans and
bigints) before it falls back to the closure wrap. There is no new host import
and no new host feature: this repairs the existing argument boundary.

Wasm output is unchanged: the change is runtime JS only. Checked A/B on three
sources (`node:fs/promises` readFile, `node:http` get, plain string code), each
compiled for the JS target and for `--target standalone`. All six sha256 values
are identical before and after.

## Before and after

Unhandled errors per file, measured locally with
`JS2WASM_EVAL_ENGINE=interpreter`, main 1a726b3e64 vs this change:

| file | unhandled errors before | after | remaining failures |
|---|---|---|---|
| `tests/issue-2701.test.ts` | 2 (fs `path` type) | 0 | 2, raw-exports harness (class B, root-test triage) |
| `tests/issue-1795.test.ts` | 1 (`ECONNREFUSED 127.0.0.1:443`) | 0 | 3, raw-exports harness (class B) |
| `tests/issue-2699.test.ts` | 0 | 0 | 5, raw-exports harness (class B) |

## Acceptance criteria

- No `node:` builtin receives a native string struct as an argument.
- `tests/issue-5748-counted-adapter-factoring.test.ts` pins the conversion.
- Compiled Wasm bytes are unchanged.
