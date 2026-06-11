---
id: 2010
title: "{...null} / {...undefined} in an object literal silently drops ALL named properties (externref fallback skips PropertyAssignment)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [987, 2009]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2010 — error-typed spread routes to a fallback that ignores named props

## Problem

```ts
const o: any = { a: 1, ...null, b: 2 };
o.a + "," + o.b
// wasm: "undefined,undefined" (JSON.stringify → {})   node: "1,2"
```

Spec §13.2.5.5 CopyDataProperties: null/undefined spread is a no-op; named
props must survive.

## Root cause

`src/codegen/literals.ts:230-233` — TS gives the literal an error type
(null isn't spreadable), so it falls to
`compileObjectLiteralAsExternref`, whose loop explicitly states
"PropertyAssignment and ShorthandPropertyAssignment are not handled in
this fallback … let them be silently skipped."

## Fix direction

Handle PropertyAssignment/ShorthandPropertyAssignment in the externref
fallback (compile value, `__extern_set`), and treat null/undefined spread
sources as no-ops.

## Acceptance criteria

- Repro returns "1,2"; `{...undefined}` likewise
- Error-typed literals never silently drop members

## Dupe check

#987 (done) was the CE-shaped fallback issue. New.

## Investigation (2026-06-11, dev-spec-b2) — mostly fixed upstream; narrow residual

`compileObjectLiteralAsExternref` now handles PropertyAssignment AND
ShorthandPropertyAssignment (literals.ts:241), so the main repro
`{ a: 1, ...null, b: 2 }` → `"1,2"` already works (host + the variants I
tested: `...null` first, nested obj spread, `{...undefined}`).

**Residual:** `{ x, ...null, y: 6 }` with a *leading shorthand* still drops `x`
(returns `"undefined,6"`). Cause: a `: any` literal with an error-typed spread
falls through the `any`-context gate (no struct maps for `any`) to the
inferred-type branch at literals.ts:817, where the error-typed literal's
inferred `{x,y}` shape resolves a struct name and routes to
`compileObjectLiteralForStruct` — the STRUCT path — which mishandles the
shorthand under the error-typed spread. `{ a:5, ...null, b:6 }` (propassign)
works there; only the shorthand leg drops. Fix belongs in the struct path's
shorthand handling for error-typed literals (or routing error-typed `any`
literals to the externref fallback regardless of inferred struct).
