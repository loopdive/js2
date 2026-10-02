---
id: 6805
title: "runtime: `_hostToPrimitive` reads the `__call_toString`/`__call_valueOf` dispatcher's `null` miss as a primitive result — once any struct in the module has a `toString`/`valueOf`, `String({a:1})` / `{a:1} + \"\"` evaluate to \"null\""
status: ready
sprint: Backlog
created: 2026-10-01
updated: 2026-10-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: runtime
language_feature: type-coercion
goal: core-semantics
related: [6788, 1716, 1319, 1090]
requested_by: ttraenkler/claude-review
origin: "measured on the parent by the #6788 implementation (2026-10-01) and left out of its scope"
---

# #6805 — a method-dispatch miss is not a primitive

## Problem

```ts
class T { toString() { return "T!"; } }
export function run(): string {
  const t = new T();
  const o = { a: 1 };
  return JSON.stringify([String(t), String(o), o + "", `${o}`]);
}
```

| lane | result |
|---|---|
| wasm (JS host, 2026-10-01, `9d977a7e`) | `["T!", {"a":1}, "null", {"a":1}]` |
| JS | `["T!", "[object Object]", "[object Object]", "[object Object]"]` |

Two defects in one probe:

1. `o + ""` → `"null"`. `_hostToPrimitive` (`src/runtime.ts:4204`) calls the
   module's `__call_toString` / `__call_valueOf` dispatcher, which returns
   `null` when the receiver's struct type has no such method; the walker
   treats that `null` as the method's primitive result (§7.1.1.1 step 6
   accepts any non-object) and stringifies it. The module-level
   `__call_toString_with_presence` variant exists in-module but is not
   exported, so the host cannot tell "method returned null" from "no
   method". With no struct carrying `toString`/`valueOf` the dispatcher is not
   emitted and the walker falls to the `"[object Object]"` sentinel — which is
   why the defect only appears once any class in the module defines one.
2. `String(o)` and `` `${o}` `` pass the struct through untouched (the JSON
   shows the object). #6788 added the ToString tail for **array** carriers
   only; a plain struct in `String()` / template position still skips
   ToPrimitive on the host lane.

## Correction

1. Export a presence-aware dispatcher (`__call_toString_with_presence` /
   `__call_valueOf_with_presence`, returning a `{found, value}` pair or a
   second i32) and make `_hostToPrimitive` use it; a miss continues the
   OrdinaryToPrimitive method order and ends in `"[object Object]"` /
   `TypeError` per spec.
2. Route struct operands of `String()` and template substitutions through the
   same walker (`emitHostCarrierToStringTail` from #6788 is the shape; the
   struct arm is the missing case).

## Acceptance

- The probe matches JS on the JS-host lane; the standalone lane is asserted
  unchanged (it reduces in-module).
- `tests/issue-6788-array-carrier-toprimitive.test.ts` gains the struct rows
  (with and without a `toString`-bearing class in the module).
