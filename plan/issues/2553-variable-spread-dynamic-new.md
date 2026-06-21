---
id: 2553
title: "variable-spread dynamic-new: new K(...someVar) where the spread source is a runtime array value"
status: in-review
sprint: 64
created: 2026-06-20
updated: 2026-06-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: spread, dynamic-new
goal: property-model
assignee: ttraenkler/dev-1769
related: [2026, 53, 2043, 1699]
parent: 2026
origin: "2026-06-20 — renumbered off the reused #2026 (which is cs-2158's done 'classes are not first-class values'). PR #1711 squatted #2026; this is its proper tracking issue."
---

# #2553 — variable-spread dynamic-new via runtime `$ObjVecArr` argv

## Problem

`new K(...someVar)` (host mode) where `K` is a runtime value (parameter/`any`)
and the spread source is a **runtime array value** (not an array literal) did
not work. PR-3a (#1699) flattened the array-*literal* spread case via
`flattenCallArgs` and **loudly compile-time-deferred** the variable-spread case
with a refuse. The flattenable case should compile and run.

This is a follow-up to #2026 ("classes are not first-class values" — the
dynamic-`new` fallback path, cs-2158, done). It extends that fallback to handle
a non-flattenable spread argument.

## Repro (was a compile-time refuse, host mode)

```ts
class P {
  x: number; y: number;
  constructor(a: number, b: number) { this.x = a; this.y = b; }
}
function make(K: any, a: number[]): any { return new K(...a); }
export function test(): number { const p = make(P, [4, 5]); return p.x + p.y; } // → 9
```

## Approach (implemented in PR #1711)

`emitDynamicNewFallback`: when args contain a non-flattenable spread, build a
runtime `$ObjVecArr` argv + argc (capacity = #non-spread + Σ spread-source-len;
per-spread copy loop via a structured block/loop/br_if). Each class tag-arm
reads `argv[i]` with a runtime `i < argc ? array.get : pushDefaultValue`.

**Type-stability fix (the crux, #2043 / subview type-idx stability):**
`$ObjVecArr` is RESERVED up-front (`reserveObjVecArrType` in the type-init
phase, gated on `sourceContainsClass`) so the body references a stable type
index — minting it lazily mid-expression baked an unresolved `-1` heap-type
ref. `ensureObjectRuntime` adopts the reserved slot. Zero new helpers/imports,
one self-contained array type, class-gated → no index shift for class-free
programs.

## Scope / non-goals

- Host mode only. **Standalone *running* of dynamic-`new` is a SEPARATE
  pre-existing gap** (reproduces with plain `new K(7)`, no spread — the #51/#55
  string-global sentinel) and is out of scope here.
- Array-literal spread + plain-args codegen unchanged.

## Acceptance criteria

- `new K(...a)` host: `[4,5]→9`, mixed `1,...[2,3]→6`, shape-collision
  tag-dispatch, and method calls on the constructed instance all work.
- The 13 existing #2026 dynamic-`new` tests stay green.
- `tsc` + prettier + biome clean.

## Tests

- `tests/issue-2026-dynamic-new-varspread.test.ts` (6 cases)
- `tests/issue-2026-dynamic-new-spread.test.ts`

(The test files retain their `2026` names — they were authored against the
reused number and the src is validated; renaming them is out of scope for this
tracking-ref cleanup.)

## PR

PR #1711 (branch `issue-2026-dynnew-argv` on the `ttraenkler` fork).
