---
id: 6850
title: "standalone: loop bounded by `.length` of an any-typed parameter returns the pre-loop value (silent miscompile)"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: loops
goal: standalone
requested_by: ttraenkler/wave9-prettier-intl
related: [6839]
---

# #6850 — `for (…; i < s.length; …)` over an untyped parameter loses the loop's effects

## What you will see

Found while writing the #6839 `Intl.ListFormat` prelude. `--target standalone`,
`.js` (also `.ts` with untyped params), measured 2026-10-05 on `b6324ee6d1`:

```js
function first(tag) { return tag.split("-")[0]; }          // returns `any`
function L(s) { let i = 0; for (; i < s.length; i++) {} return i; }
export function t() { return L(first("ab_c")) * 100 + L("xyzw"); }
// expected 404, standalone returns 0
```

Same result (0) for `let n = 0; for (let i = 0; i < s.length; i++) n++; return n;`,
for `const m = s.length;` / `const m = +s.length;` as the bound, and for a
`while (i < m)` loop. In every case:

- `s.length` itself is right (`s.length === 4 ? 1 : 0` → 1; `typeof` number);
- `s.charCodeAt(i)` is right;
- the loop body DOES run (`if (i === 2) return 9;` inside it returns 9);
- a constant bound (`i < 3`) works, and so does the same loop when every call
  site passes a typed string (the parameter is then specialised to `string`).

So the trigger is a parameter whose inferred type widens to `any` because one
call site passes an `any`; the loop's writes to function locals (`i`, `n`) are
then lost after the loop. A variant with an early `return false` from inside the
loop (an `isAlpha` predicate) returned `true` for `"en_US"`, i.e. the same
defect also defeats early returns guarded by compound relational tests.

## Repro variants

Each with `first` as above and `t()` = `L(first("ab_c")) * 100 + L("xyzw")`:
failing — the counting loop, `const m = s.length` bound, `const m = +s.length`
bound, `const s = "" + s0` re-binding, `while (i < m)`, `for (; i < s.length;)`
returning `i`; passing — early `return` inside the loop, `s.length === 4`,
a numeric second parameter as the bound, a constant bound.

## Workaround in tree

`src/intl-listformat-prelude.ts` coerces every helper input with a template
literal and compares `| 0`-typed numbers; remove those once this is fixed.
