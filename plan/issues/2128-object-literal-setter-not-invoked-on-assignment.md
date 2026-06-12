---
id: 2128
title: "object-literal setter not invoked on property assignment — the write silently no-ops"
status: ready
sprint: 61
created: 2026-06-12
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [1239, 2017]
renumbered_from: "residual of #1239 (done) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2128 — assignment to an object-literal `set` accessor does not call the setter

## Problem

A `set` accessor defined inline on an object literal is not invoked when the
property is assigned; the write silently does nothing.

```ts
let captured = 0;
const o: any = { set v(x: number) { captured = x; } };
o.v = 9;
captured                  // wasm: 0    node: 9
```

## Scope / relationship to neighbours

- **Getter/setter pair on a module-level const with compound assign**
  (`o.x += 3`) now works — verified FIXED on main (`#1971` item 3b), so this
  issue is narrowed to the **setter-invocation-on-write** path.
- The **getter-only** write case (`o.x = 99` where `x` has only a getter)
  trapping `illegal cast` instead of a strict-mode TypeError is already
  tracked by **#2017** — distinct from this issue (here the setter *exists*
  and just isn't called).

## Root cause (pointer)

The assignment-codegen path for `o.prop = v` treats `prop` as a plain struct
field write and does not consult the accessor registry for an inline-literal
`set` accessor (`classAccessorSet`). It needs the same setter-dispatch that
class instance setters use. See member-assignment lowering in
`src/codegen/expressions.ts` / `src/codegen/statements.ts` and accessor
registration in `src/codegen/object-ops.ts`.

## Acceptance criteria

- `let c=0; const o:any={set v(x){c=x}}; o.v=9; c` → `9`
- Getter+setter pair: `set` fires on write, `get` fires on read
- No regression on plain data-property writes
- An equivalence test under `tests/`

## Notes

Verified on main `c19a2e9c1` via `.tmp/triage.mts` (branch `po-1971-triage`).
JS-host mode, default options.
