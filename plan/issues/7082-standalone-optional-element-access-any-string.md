---
id: 7082
title: "standalone: `s?.[i]` on an `any` string answers undefined — `__extern_get_idx` has no String exotic arm (hono `mergePath` builds `//book`)"
status: done
sprint: current
created: 2026-10-18
updated: 2026-10-18
completed: 2026-10-18
assignee: ttraenkler/wave17-hono-residual
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
goal: standalone-gap
language_feature: optional-chaining, strings
related: [7013, 2166]
loc-budget-allow:
  # 2026-10-18 (#7082) object-runtime.ts +10 / object-runtime-enumeration.ts +2:
  #   one optional `anyStrTypeIdx` parameter OR-ed into the existing `$Object`
  #   arm condition of `buildExternGetIdxBody`.
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-enumeration.ts
func-budget-allow:
  # 2026-10-18 (#7082) +2: the `anyStrTypeIdx` argument.
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
---

# `?.[i]` on a dynamic string

hono `mergePath` reads `base?.[0] === "/"`; standalone answered undefined, so
every merged path gained a second slash (`mergePath("/", "book")` → `//book`).
`s[0]` worked: it lowers through the dynamic member read; the optional chain's
non-null arm uses `compileElementAccessBody`, whose standalone numeric-index
path is `__extern_get_idx` — which has `$Object`, `$Proxy`, `$ObjVec` and
typed-vec arms but nothing for a string.

## Implementation Plan

§10.4.3 String exotic [[Get]] of an integer index is `Get(O, ToString(i))`,
which `__extern_get` already serves for strings. Add `$AnyString` to the
`$Object`/`$Proxy` arm condition of `buildExternGetIdxBody` (standalone only),
so every caller of `__extern_get_idx` sees string elements.

## Resolution

Implemented; hono `mergePath` tests pass.

Regression: `tests/issue-7059-hono-standalone-residuals.test.ts` (the `#7082` block).
