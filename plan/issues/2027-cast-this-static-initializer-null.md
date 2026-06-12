---
id: 2027
title: "(this as any).prop in a static field initializer yields null — static-context arm matches bare ThisKeyword only"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: low
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [1643]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2027 — AsExpression wrapper skips the static-this path

## Problem

```ts
class B { static a = 1; static b = (this as any).a + 1; }
B.b   // wasm: null   node: 2
```

Plain `static b = this.a + 1` works — only cast/parenthesized `this` falls
off the path.

## Root cause

`src/codegen/property-access.ts:1795+` / assignment.ts:2219-2221 — the
static-context arm matches `target.expression.kind === ThisKeyword`
exactly; an `AsExpression`/parens wrapper around `this` skips it and the
generic path returns null.

## Fix direction

Unwrap AsExpression/ParenthesizedExpression before the ThisKeyword match
(shared `skipOuterExpressions` helper).

## Acceptance criteria

- Repro returns 2; `(this).a` and `(this as any).a` both work in static
  and instance contexts

## Dupe check

#1643 (static init umbrella, in-review) — could fold there, filed
separately to keep #1643's scope stable. New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1333; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
