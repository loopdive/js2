---
id: 6815
title: "codegen-linear: template-literal substitutions coerce a boolean to the empty string or 1 and an object to its string pointer (a number) — the linear ToString helper #6778 wired for `+` is not used by template spans"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen-linear
language_feature: template-literals
goal: core-semantics
related: [6778, 6804]
requested_by: ttraenkler/claude-review
origin: "reported by the #6778 implementation (2026-10-02) as out of its `+` scope; not re-measured by the filer"
---
# #6815 — template spans on the linear backend

## Problem

#6778 made the linear backend's mixed `string + x` concatenate via ToString.
The template-literal lowering in `src/codegen-linear/` still formats each
substitution by its static type: a `boolean` span prints `""`/`"1"` (an i32 run
through the number formatter), and an object span prints the numeric linear
pointer of its string representation.

```ts
export function run(): string {
  const b = true, o = { a: 1 };
  return `${b}|${false}|${o}`;
}
```

JS: `"true|false|[object Object]"`. Linear lane (per the report):
`"1||<pointer>"`.

## Correction

Route every template substitution through the ToString path #6778 introduced
(booleans → `"true"`/`"false"`, objects → ToPrimitive → `"[object Object]"`),
leaving the static-string and static-number fast paths byte-identical.

## Acceptance

- The probe matches JS on `--target wasi` (linear); the gc lane asserted
  unchanged.
- A row in `tests/linear-*.test.ts` next to the #6778 rows.
