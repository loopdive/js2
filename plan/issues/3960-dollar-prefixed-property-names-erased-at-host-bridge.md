---
id: 3960
title: "User properties named `$…` / `__…` are erased from the host bridge — Object.keys and JSON.stringify silently drop them"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: objects
goal: core-semantics
# The insertion-order recorder lives inside compileObjectLiteralForStruct and
# cannot be moved out: it walks that function's own `expr.properties` and
# `spreadSources`. The growth is the written-vs-spread distinction plus the
# comment explaining why spread keeps the old heuristic.
loc-budget-allow:
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileObjectLiteralForStruct
---

# `$`-prefixed user properties are erased at the host bridge

## Problem

The compiler's own hidden struct slots (`$shape`, `$arity`, `$func`, `__tag`, …)
are all `$`/`__` prefixed, so the host-bridge exports used a bare **name-prefix
test** to decide which fields the JS host may see:

```ts
if (field.name.startsWith("$") || field.name.startsWith("__")) continue;
```

That prefix is legal in a real property name, and the ecosystem uses it. Any
user property so named was dropped from `__struct_field_names` and never got an
`__sget_<name>` getter — so once the object crossed to the host it simply did
not have that key.

Minimal repro:

```js
export function json() {
  const o = { $$a: 1, b: 2 };
  return JSON.stringify(o);
}
// wasm:   {"b":2}
// native: {"$$a":1,"b":2}
```

Same for `Object.keys`, `for…in`, and every other host-side enumeration.

The failure is silent in the worst way: no diagnostic, no trap, just a key that
is absent. Nothing reports that a property was dropped.

## Why it matters beyond the repro

**React stamps `$$typeof` on every element it creates.** With the key erased,
`Object.keys(element)` returned `type,key,ref,props`, `JSON.stringify` dropped
the tag, and — because the in-Wasm `element.$$typeof === REACT_ELEMENT_TYPE`
comparison is statically folded from the known literal shape — a direct
comparison still read `true` while the dynamic reads disagreed. That
inconsistency is exactly why this went unnoticed: the cheap check passed.

It reproduces on any CommonJS package whose public API is reached through
`exports.f(...)`, which is how the entire npm corpus is consumed.

## Fix

`isInternalStructFieldName(ctx, structName, fieldName)` replaces the prefix test
at all four sites in `src/codegen/struct-field-exports.ts` (getters, setters,
shape-collision names, the field-name CSV).

`ctx.structInsertionOrder` already records the keys an object literal literally
wrote, so it is the authority when present: a recorded name is a user property
no matter how it is spelled. Structs with no recording (named classes, IR-fresh
structs) keep the prefix heuristic unchanged, so this is not a blanket
loosening.

The recorder in `src/codegen/literals.ts` had the same filter and had to stop
applying it to **written** keys. It still applies to **spread-derived** names:
those come from the source struct's slot list, which genuinely mixes user keys
with hidden slots, and there is no way to tell them apart at that point. That
path keeps its previous conservative behaviour.

## Known limitation (deliberate)

A `$`-prefixed property on a **named class** is still erased — class layouts do
not go through `structInsertionOrder`, so the prefix heuristic still governs
them. The object-literal case is what the npm corpus actually hits; extending
the same authority to class layouts is follow-up work, not a silent gap.

## Acceptance criteria

- [x] `Object.keys({ $$a: 1, b: 2 })` and `JSON.stringify` include `$$a` after
      the object crosses the host bridge.
- [x] Compiler-internal slots (`$shape`, `$arity`, `__tag`) stay hidden.
- [x] Structs with no recorded insertion order are unchanged.

## Permanent test reference

`tests/dogfood/react-upstream-suite.test.ts` — React's own
`ReactCreateElement › is indistinguishable from a plain object` and
`ReactJSXTransformIntegration › identifies valid elements` read the element's
own keys through the host bridge and depend on `$$typeof` being present. They
are part of the 32 → 39 pass move recorded in #3958.
