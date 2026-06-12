---
id: 2006
title: "`${null}` in a template literal traps 'illegal cast' — externref spans assumed to be strings"
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
language_feature: template-literals
goal: core-semantics
related: [2005, 2007]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2006 — null externref span passed raw to js-string concat

## Problem

```ts
const o = null;
`x${o}`   // wasm: RuntimeError: illegal cast   node: "xnull"
```

## Root cause

`src/codegen/string-ops.ts:285` — externref template spans are "assumed to
be string already" and passed raw to `wasm:js-string concat`; a
`ref.null extern` trips the builtin's cast. Binary concat handles null
explicitly (string-ops.ts:1472-1480, emits "null" constant); the template
path doesn't.

## Fix direction

Null-guard externref spans: `ref.is_null ? "null" constant : span` (and
share the binary-concat helper).

## Acceptance criteria

- Repro returns "xnull"; string spans unchanged

## Dupe check

#1918/#1922 unrelated (standalone). New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1321; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
