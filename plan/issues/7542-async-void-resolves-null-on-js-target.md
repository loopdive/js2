---
id: 7542
title: "An `async` function returning `Promise<void>` resolves to `null` after an `await` on the JS target"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7533, 4106, 4574]
---

# #7542 — `Promise<void>` resolves to `null` after an `await` on the JS target

## Problem

Found while planning [#7533](7533-ir-async-native-runtime-rejected-on-js-target.md). On the default JS target, an
`async` function declared `Promise<void>` whose body awaits resolves to `null`; JavaScript resolves it to `undefined`.
It happens with the IR on and off, so it is not an IR bug. It blocks the value assertion of
`tests/issue-4106-ir-async-fetch-user.test.ts` (row "linear final-void owner", ~L239), which stays red in the #7533 PR.

## Reproduction (2026-11-26, `origin/main` `a9cdc8857a`)

Each program is compiled with `compile(src, { fileName: "p.ts" })`, instantiated with `buildImports` and
`setInstance`, and read through `wrapCompiledExports`. "IR off" is `experimentalIR: false, disableIrFirst: true`.

| Program | node | IR default | IR off |
| --- | --- | --- | --- |
| `export async function f(): Promise<void> { const x = await Promise.resolve(1); }` | `undefined` | `null` | `null` |
| `export async function f(): Promise<void> { return; }` | `undefined` | `undefined` | `undefined` |
| `export async function f(): Promise<void> { throw new Error("boom"); }` | rejects with the Error | same | same |

## Also record: the native rejection reason

In #7533 the #4110 row that makes a timer registration fail checks only that the JS-facing promise rejects. The
native runtime rejects with `null` (the sentinel documented in #4574), where JavaScript rejects with the thrown
`Error`. The rejection reason must be the thrown Error; fix it here or in a split-off issue, and then pin the reason
in that #4110 row.

## Acceptance criteria

- The first row resolves to `undefined` on the JS target, IR on and off; standalone answers the same.
- The #4106 void-owner value assertion passes.
- The rejection reason of a failed timer registration is the thrown Error, and #4110 pins it.
