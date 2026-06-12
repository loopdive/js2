---
id: 2004
title: "codePointAt out-of-range returns NaN instead of undefined — ?? / === undefined guards never fire"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [2003, 1931, 1852]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2004 — f64 result kind erases the undefined return

## Problem

```ts
"ab".codePointAt(5) ?? -1   // wasm: NaN (?? does not trigger)   node: -1
```

## Root cause

`src/codegen/index.ts:6322` — `STRING_METHODS.codePointAt` result is
`{kind:"f64"}`; the host returns `undefined`, which becomes NaN at the
externref→f64 boundary, so position ≥ length can never produce `undefined`
(§22.1.3.4 step 5). Family: undefined-erased-to-numeric-default (#1931,
#1852 representation decision).

## Fix direction

Return externref (boxed number | undefined) when the call site needs
undefined-observability, or special-case `??`/`=== undefined` guards over
codePointAt. Coordinate with the #1852 representation work.

## Acceptance criteria

- Repro returns -1; in-range code points unchanged (incl. surrogate pairs)

## Dupe check

#1445 (arg coercion), #1381 (substring/slice) don't cover return-value
representation. New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1329; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
