---
id: 6806
title: "codegen: `String(boolArr)` → the array itself / `boolArr + \"\"` → \"1,0\"; `[1, undefined, 3]` joins as \"1,NaN,3\"; tuples pass through `String()` and templates untouched"
status: ready
sprint: Backlog
created: 2026-10-01
updated: 2026-10-01
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [6788, 6805, 2358]
requested_by: ttraenkler/claude-review
origin: "measured on the parent by the #6788 implementation (2026-10-01) and left out of its scope"
---

# #6806 — the value-level join loses the element type

## Problem

```ts
export function run(): string {
  const b = [true, false];
  const u = [1, undefined, 3];
  const t: [number, string] = [1, "x"];
  return JSON.stringify([String(b), b + "", String(u), String(t), `${t}`]);
}
```

| lane | result |
|---|---|
| wasm (JS host, 2026-10-01, `9d977a7e`) | `[[1,0], "1,0", [1,null,3], [1,"x"], [1,"x"]]` |
| JS | `["true,false", "true,false", "1,,3", "1,x", "1,x"]` |

- `boolean[]` is an i32 vec; the host element stringifier (`__extern_join_str`,
  reused by #6788) formats i32 elements as numbers.
- `[1, undefined, 3]` is an f64 vec with the undefined sentinel; `__vec_get`
  boxes the sentinel as NaN, so the join prints `NaN` where §23.1.3.18 prints
  the empty string. (`String(u)` also returns the array unconverted, as the
  `String()` arm of #6788 only covers carriers it recognises.)
- Tuples (`[number, string]`) are structs, not vecs, so neither `String()` nor
  a template substitution converts them (#6805 covers the general struct case;
  tuples additionally need the array-style join).

The static `arr.toString()` lowering sees the element type and is right for
all three — the defect is confined to the value-level host path.

## Correction

- Thread the element kind into the host join (a tag on the carrier, or a
  per-element-type stringifier chosen at the call site) so i32-boolean vecs
  print `true`/`false` and the undefined/null sentinels print `""`.
- Treat tuple structs as array carriers in `isHostArrayCarrier` (or a sibling
  predicate) so `String()`, templates and `+` join them.

## Acceptance

- The probe matches JS on the JS-host lane; standalone lane asserted
  unchanged.
- Rows added to `tests/issue-6788-array-carrier-toprimitive.test.ts`.
