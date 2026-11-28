---
id: 7531
title: "Only the last compiled file's top-level vars get their undefined seed"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7470]
---

# #7531 — only the last compiled file's top-level `var`s get their `undefined` seed

## Problem

Found while planning #7470. `emitModuleVarUndefinedSeeds` walks only the source file passed to the module prologue,
which is the last one `compileMulti` compiles. Externref `var`s in every other file are never seeded with
`undefined`, so they read as `null`. Measured on 50bce1ba04 (2026-11-26); gc and standalone give the same answers:

| shape | node | now |
| --- | --- | --- |
| single file: `var v: any; typeof v === "undefined"` | 1 | 1 |
| `var v: any` in the entry file (compiled last) | 1 | 1 |
| `var v: any` in `dep.ts`, read through an exported function | 1 | 0 |

A `string | undefined` `var` in dep compares `=== undefined` correctly, because that comparison treats null as
undefined. `typeof` exposes the missing seed.

## Plan

Seed every module's `var`s. This is independent of name collisions, but it touches the same seed module
(`src/codegen/declarations/module-var-undefined-seed.ts`), which #7470 changes to record globals rather than names.
Land it after #7470 and resolve each module's globals through that module's binding view.

## Acceptance criteria

- The dep row and a third-file variant answer like node on gc and standalone. Pin them with `compileMulti` tests
  that fail on main.
- Single-file output stays byte-identical.
