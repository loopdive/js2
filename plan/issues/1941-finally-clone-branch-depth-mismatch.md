---
id: 1941
title: "cloned finally branch depths not adjusted for nesting of the abrupt-completion site (return/break inside if inside try)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: try-finally
goal: core-semantics
related: [1378, 1858, 1169]
origin: "2026-06-10 deep-audit sweep (control-flow agent): verified miscompile on main"
---

# #1941 — finally clone inlined at wrong branch depth

## Problem

When a `return`/`break`/`continue` sits **deeper than the try frame** (inside
an `if`, `switch`, or inner `try` within the `try` block), the finally body
cloned at that abrupt site has its outer-label branches off by the extra
nesting: a `break` in the finally lands on the wrong block. Observable as a
swallowed pending `return`, extra loop iterations, and double-executed inner
finallys.

## Repro (verified on main)

```ts
export function t1(): number {
  let r = 0;
  while (true) {
    r = r + 1;
    try {
      if (r === 1) { return 100; }   // return nested one level deeper than try
    } finally {
      break;                          // branch to an outer label
    }
  }
  return r;
}
export function nestedFinallyBreak(): number {
  let log = 0;
  while (true) {
    try { try { if (log === 0) { log = 1; return 100; } } finally { log = log*10 + 2; } }
    finally { break; }
  }
  return log;
}
```

| fn | wasm | node |
|----|------|------|
| `t1` | `2` (loops a 2nd time) | `1` |
| `nestedFinallyBreak` | `122` (inner finally ran twice) | `12` |

Control without extra nesting (`try { return 100 } finally { break }` directly)
is correct in both (`5`), proving it's the nesting delta.

## Root cause

`src/codegen/statements/exceptions.ts:202-238` pre-compiles the finally body
with break/continue stacks bumped by exactly **+1** (the try frame).
`compileReturnStatement` (`src/codegen/statements/control-flow.ts:187-205`),
`compileBreakStatement` (:864-871) and `compileContinueStatement` (:893-901)
inline `entry.cloneFinally()` — the raw +1 clone — at the abrupt site. When
that site is nested deeper than the try frame, any `br` inside the clone
targeting an outer label is short by the extra nesting. The compensation
machinery exists (`cloneFinallyAtDepth`/`bumpOuterBranchDepths`,
exceptions.ts:57-82, 253-258) but is only invoked for the two hardcoded +2
catch_all insertion sites (exceptions.ts:442, 488), never for
return/break/continue inline sites.

## Fix direction

Record on each `finallyStack` entry the breakStack-depth baseline at try entry
(e.g. a `labelDepthAtPush`), compute the delta at the inline site from the
current (already-bumped) stacks, and route all inlines through
`cloneFinallyAtDepth(delta)` with the site-computed delta instead of
`cloneFinally()`.

## Acceptance criteria

- Both repros match Node
- `#1858` C6 cases (branches nested inside the finally body) stay fixed
- Matrix test: abrupt site at nesting depth 0/1/2 × finally containing
  break/continue/return × 1-2 finally levels

## Dupe check

Grepped `finally`, `cloneFinally`, `bumpOuterBranchDepths`: #1378 (completion
override itself — works), #1858 C6 (the dual defect: branches inside the
finally body, fixed), #1169h (IR port notes). The insertion-site-depth defect
is unfiled.
