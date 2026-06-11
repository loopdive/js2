---
id: 2061
title: "cloned finally branch depths not adjusted for nesting of the abrupt-completion site (return/break inside if inside try)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
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

## Resolution (2026-06-11)

Implemented the fix-direction approach. The key invariant that makes the delta
cheap to compute: **every label-creating construct (`if`, `block`, `loop`,
`switch`, `try`) bumps ALL pre-existing outer break/continue stack entries by
+1, uniformly** (verified in `compileIfStatement` :449, `compileSwitchStatement`
:710/745, `compileTryStatement` :272, loops). So the extra nesting between an
abrupt-completion site and the try frame at which the finally body was
pre-compiled is a single scalar, readable from any outer entry as
`current depth − try-entry-baseline depth`.

Changes:
- `FunctionContext.finallyStack` entries (`context/types.ts`) gained
  `cloneFinallyAtDepth`, `breakDepthBaseline`, `continueDepthBaseline`. The
  baselines are snapshots of `breakStack`/`continueStack` taken when the entry
  is pushed (i.e. already at try-frame +1).
- The three push sites set the new fields: `exceptions.ts` try-body (:281) and
  catch-body (:379) entries forward the existing `cloneFinallyAtDepth`
  (already used for the +2 catch_all sites) and snapshot the stacks;
  `loops.ts` for-of iterator-close (:4098) uses the same closure for both clone
  variants (its body has no outer-targeting `br`, so the delta is a no-op).
- `control-flow.ts` gained `finallyInlineDelta(fctx, entry)` and routes all
  three inline sites — `compileReturnStatement` (:196), `compileBreakStatement`
  (:884), `compileContinueStatement` (:914) — through
  `entry.cloneFinallyAtDepth(finallyInlineDelta(...))` instead of the raw
  `entry.cloneFinally()`. When the site is at the try frame itself the delta is
  0 and `cloneFinallyAtDepth(0)` is identical to `cloneFinally()`, so the prior
  (correct) shallow-nesting behavior is preserved.

Regression coverage: `tests/issue-2061-finally-clone-depth.test.ts` (6 cases)
covers the two repros plus a depth-2 `return`, `continue`-in-finally nested in
`if`, a labeled-break-from-finally three `if`s deep, and a `break`-in-finally
where the abrupt site is inside a `switch` in the try. All match Node via
`assertEquivalent` (which also runs `WebAssembly.validate`). The #1858 C6 suite
(branches *inside* the finally body) stays green.
