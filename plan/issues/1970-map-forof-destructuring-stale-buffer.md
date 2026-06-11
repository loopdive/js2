---
id: 1970
title: "for (const [k,v] of map) yields the FIRST entry on every iteration — stale destructuring conversion buffer not reset per iteration"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring
goal: iterator-protocol
related: [1258, 1146, 859, 1847, 2065]
origin: "2026-06-10 deep-audit sweep (objects agent): verified miscompile on main, WAT-proofed"
---

# #1970 — destructure-in-loop reuses iteration 1's materialized vec

## Problem

The canonical Map iteration idiom yields the first entry forever:

```ts
const m=new Map(); m.set("a",1); m.set("b",2);
let r=""; for (const [k,v] of m) r+=k+"="+v+";"; return r;
```

wasm: `"a=1;a=1;"` — node: `"a=1;b=2;"`. Iteration *count* is right; values
are stale. Same for the body form (`const [k,v] = e as any`). Non-destructured
access (`e[0]`, `e[1]`) is correct.

## Root cause

`destructureParamArray`'s externref branch
(`src/codegen/destructuring-params.ts:891`) allocates `resultLocal`
(`__dparam_cvt_*`); the materialization fallbacks at :1195-1203 and
:1217-1229 are gated on `local.get resultLocal; ref.is_null` ("only run
fallback if still null"). The local is **never reset to null at the start of
the emitted sequence**, so inside a loop (for-of-over-Map head lowers through
`compileForOfIterator` → `compileExternrefArrayDestructuringDecl` → this
helper, executed per iteration) iteration 2 finds iteration 1's vec non-null,
skips re-materializing, and destructures the stale vec. WAT confirms
(`$__dparam_cvt_14` only written inside the gated branches). Host JS arrays
(Map entries, any host-returned array) are exactly the values that reach this
fallback.

## Fix direction

Emit `ref.null <extVecIdx>; local.set resultLocal` (and reset any other
branch-written state the gates read) at the top of the externref destructure
sequence, making the emitted code idempotent under re-execution.

## Acceptance criteria

- Repro matches Node; 3+ entries correct
- `for (const [a,b] of hostArrayOfPairs)` correct
- Object-pattern equivalents checked for the same gate pattern
- Single-execution destructuring unregressed

## Dupe check

#1258 (boxedCaptures routing), #1146 (rest patterns), #859 (Map.forEach
snapshots), #1847 (localMap rollback) — all done, none cover this. Unfiled.
