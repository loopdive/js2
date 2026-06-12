---
id: 2019
title: "static property ++/-- is a silent no-op (write dropped, NaN pushed) — compileMemberIncDec has no staticProps arm"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [1643, 1379]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2019 — A.c++ vanishes

## Problem

```ts
class A { static c = 0; }
A.c++; return A.c;
// wasm: 0   node: 1
```

Same inside static methods (`this.c++` / `A.c++`). `A.c += 1` and
`A.c = v` work correctly.

## Root cause

`src/codegen/expressions/unary-updates.ts:83-112` — `compileMemberIncDec`
has no `ctx.staticProps` arm (plain assignment at assignment.ts:2194 and
compound at assignment.ts:4946 both have one); the class-typed receiver
resolves to no struct, so it takes the "unresolvable → emit
`f64.const NaN`" fallback (lines 107-111) and the write vanishes.

## Fix direction

Mirror the staticProps arm from compound assignment into
compileMemberIncDec (pre/post value semantics included).

## Acceptance criteria

- `A.c++`/`A.c--`/`++A.c` read-modify-write the static and yield correct
  pre/post values, at top level and inside static methods

## Dupe check

#1379 is inc/dec on null/undefined/string; #1643 is static init order.
New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1333; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
