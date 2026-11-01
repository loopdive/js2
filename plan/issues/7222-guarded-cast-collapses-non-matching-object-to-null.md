---
id: 7222
title: "A failed guarded cast turns a non-matching object into null (`{}` passed as `C | null` reads as null)"
status: ready
sprint: Backlog
created: 2026-11-01
updated: 2026-11-01
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: types
goal: correctness
related: [7163]
---

# #7222 — lossy guarded cast at typed boundaries

Root cause behind #7163 (PR #7013, parked). When an `any` value reaches a
`C | null` parameter, field or local, the shared guarded cast
(`emitGuardedRefCast` / `guardedRefCastInstrs` in
`src/codegen/type-coercion.ts`) runs `ref.test $C` and, on failure, produces
`ref.null`. A real object that is not a `C` becomes indistinguishable from JS
`null`:

```ts
class C { #v = 1; f = 0; static has(o: C | null) { return o === null; } }
console.log(C.has(JSON.parse("{}")));   // node: false — we: true
```

The same collapse blocks #7163 (`#x in o` must throw on null but not on a
non-`C` object).

## Options (from the #7163 analysis)

- **A.** A failed guarded cast keeps the original value, or traps, instead of
  becoming null. Touches every `coerceType`/`coercionInstrs` site; bytes change
  on all lanes.
- **B.** Lower `C | null` / `C | undefined` as externref, as
  `C | null | undefined` already is. Touches `resolveWasmType` and the type
  APIs; performance cost.

Both change shared contracts, so this needs session A's agreement under the
#6583 constraint (flagged there, comment 6547290241) before implementation.
