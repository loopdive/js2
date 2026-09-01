---
id: 5184
title: "`__Date` registers its field metadata as a SECOND array — the growable-struct invariant is unenforced"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: s
feasibility: easy
task_type: bugfix
area: codegen
goal: core-semantics
related: [5180, 5204]
---

# #5184 — one builtin carrier registers two field arrays; nothing enforces that it doesn't

## Problem

`ctx.structFields.get(<name>)` is expected to BE the array the emitted struct
type carries. Most producers honour that by construction — they hand the same
array to `mod.types.push` and to `structFields.set`.

`ensureDateStruct` does not. Both copies of it build two separate literals:

* `src/codegen/expressions/builtins.ts:195-202`
* `src/codegen/index.ts:11539-11548`

so `mod.types[<__Date>].fields !== ctx.structFields.get("__Date")`.

Nothing checks this. Any pass that grows a struct through the metadata array
silently desynchronises the two, and the failure surfaces far away as a wrong
field index against the emitted type.

## Evidence

This is not hypothetical: it is the mechanism behind #5180, where the dynamic
field auto-registration in `finalizeStructAndDynamicMemberGet` appended
`valueOf` to `__Date`'s metadata array, the emitted struct stayed at one field,
and `struct.get $__Date 1` cost the whole @js-temporal/polyfill bundle its
binary. Measured at the auto-add site on `main` @ `ddab1b0743`:

```
[js2:addfield] typeName=__Date prop=valueOf sameArray=false
```

#5180 fixed the *sink* — the growth site now refuses when the arrays differ
(`structGrowsWithMetadata`, `src/codegen/struct-carrier-growth.ts`). This issue
is the *source*: remove the second array so the carrier is not a special case,
and make a future carrier that reintroduces one fail loudly instead of silently.

## Scope

* Have both `ensureDateStruct` sites build the field list ONCE and register the
  same array with `mod.types` and `ctx.structFields`.
* Audit the other `ctx.structFields.set` producers for the same shape (~40 call
  sites; most already share the array — this is a read, not a rewrite).
* Add a cheap invariant check for the codegen debug/test lane rather than a
  per-compile cost: for every `name` in `ctx.structFields`, assert
  `mod.types[structMap.get(name)].fields === fields` where the type is a struct.
  **Take the measurement AFTER the registration phase and BEFORE dead-type
  elimination** — DCE rebuilds `mod.types` via `remapTD`, so a naive check
  placed at emit time compares against a compacted array and reports dozens of
  false positives.

## Acceptance

* `ensureDateStruct` (both copies) registers one array.
* The #5180 guard becomes dead for `__Date` specifically — its regression test
  (`tests/issue-5180-builtin-carrier-field-growth.test.ts`) still passes, and the
  guard stays as the general protection.
* An invariant check that fails on a deliberately re-split carrier.
