---
id: 2874
title: "Standalone: Object.getOwnPropertyDescriptor (and defineProperty) numeric/object property-key → string coercion drops the lookup"
status: done
completed: 2026-06-30
assignee: ttraenkler/dev-standalone
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2860, 2870, 2862]
umbrella: 2860
---

# Standalone: property-key coercion in Object.getOwnPropertyDescriptor / defineProperty

## Problem

In `--target standalone`, `Object.getOwnPropertyDescriptor(obj, key)` (and the
`defineProperty` / `create` / `defineProperties` family) fail to find a property
when the **key is not already a native string** — a number, `+Infinity`, an
object with a `toString`, etc. The §7.1.19 `ToPropertyKey`/`ToString` coercion on
the key is not applied (or applied differently) on the standalone path, so the
lookup misses, returns `undefined`, and the test then null-derefs on
`desc.value` → throws.

This cluster was previously **masked** by the exception-formatter bug (#2870);
de-masking surfaced it as a concrete, isolated standalone gap.

### Impact (host-pass / standalone-fail, measured 2026-06-30)

~**164** `built-ins/Object/getOwnPropertyDescriptor/**`, plus large adjacent
counts in the same key-coercion family:
`Object/defineProperty` 93, `Object/create` 97, `Object/defineProperties` 69.

## Representative repro

```js
// test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-14.js
var obj = { Infinity: 1 };
var desc = Object.getOwnPropertyDescriptor(obj, +Infinity); // key +Infinity → "Infinity"
assert.sameValue(desc.value, 1); // standalone: desc is undefined → throws
```

Host mode passes; standalone throws (a Wasm exception, recorded post-#2870 as
`uncaught Wasm-GC exception`).

## Root cause (to confirm)

The standalone lowering of `Object.getOwnPropertyDescriptor` / `defineProperty`
passes the key argument to the native `$Object` lookup without the
`ToPropertyKey` → `ToString` coercion that host mode applies (number → its string
form, e.g. `+Infinity` → `"Infinity"`, `0` → `"0"`). Inspect the standalone
descriptor/define lowering in `src/codegen/` (grep
`getOwnPropertyDescriptor`/`defineProperty`/`__obj_define`/`__obj_get_descriptor`)
and route the key through the native number→string (`__num_to_string`) / general
`ToPropertyKey` path before the `$Object` probe.

## Test plan

Standalone fail/CE → pass:

- `test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-*.js`,
  `15.2.3.3-4-*.js`
- `test/built-ins/Object/defineProperty/15.2.3.6-3-*.js`
- `test/built-ins/Object/{create,defineProperties}/**` (shared coercion)

Verify-first with `runTest262File(file, cat, undefined, "standalone")`. Full
`merge_group` + standalone high-water. Pure correctness — `ctx.standalone` only.
