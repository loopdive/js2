---
id: 7401
title: "`m?.size` on a typed Map/Set returns the receiver instead of the size (NaN, or invalid Wasm) on the native lanes"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7370, 7395]
---

# #7401: optional-chain `.size` on a typed Map / Set

## Problem

Measured on main `89e47482`, on gc, standalone and wasi:

```ts
export function main(): number {
  const s: Set<number> | undefined = new Set([1, 2]);
  return s?.size ?? -1;
}
```

- **Returns `NaN`. Node gives `2`.** The same happens for a `Map` (`1`
  expected) and for a `?:` parameter (`f(new Set([1, 2, 3]))`).
- **The untyped JS form is correct** (`function f(m) { return m?.size; }`),
  and so is plain `s.size`.
- **Invalid Wasm**, measured by the #7395 lane on gc and standalone: the
  receiver flows on as an `externref` result, so these three fail
  validation with `type error in fallthru[0] (expected externref, got
  (ref null 47))`:
  - a parameter:
    `function h(r: Map<string, number> | undefined) { return r?.size; }`
    called as `h(new Map([["k", 7]]))!`;
  - a module global: `let r: Set<number> | undefined = new Set([5]);`
    then `r?.size`;
  - an `undefined` class field: `class W { r: Map<string, number> | undefined = undefined; }`
    then `w.r?.size`.

## Root cause

`compileOptionalPropertyAccess` (`src/codegen/property-access.ts`) pushes the
receiver and, for an extern-declared or host-map class, calls
`compileExternPropertyGetFromStack`. That helper only knows the host getter
import (`Set_get_size` / `Map_get_size`).

On the native lanes that import does not exist, so the helper emitted
nothing. The caller still declared the result `externref`, so the
**receiver** stood in for the property. The final coercion then turned the
Set into a number (`__to_primitive` + `__unbox_number` → `NaN`).

## Fix

- `compileExternPropertyGetFromStack` returns whether it emitted the getter
  call.
- When it did not, the optional arm falls to the dynamic member read below
  it (`__extern_get` / member-get dispatch). That read already exists, and
  its native `$Map` arm answers `size`.

## Acceptance

- `tests/issue-7401-optional-collection-size.test.ts` pins node's answer on
  gc, standalone and wasi for these cases:
  - a Map;
  - a Set;
  - a Set grown after construction;
  - a short-circuited `?:` parameter (`?? -1`);
  - `=== undefined`.
- The test also pins the three invalid-module shapes above.
- On the base code, four of the five wrong-answer cases fail, and the three
  invalid-module shapes fail validation.
- Byte identity: 1,200 files × {gc, standalone}, so 2,400 outputs, with
  0 differences. The files are test262 `built-ins/Map`, `built-ins/Set`,
  `language/expressions/{optional-chaining,compound-assignment,addition,conditional}`,
  plus the playground, benchmarks and examples. These are untyped JS, so none
  of them reaches the typed arm.

## Found on the way (not fixed here)

Optional **method calls** on a typed Map/Set are silent no-ops on all three
lanes:

- `s?.add(5)` does not add;
- `m?.set('a', 1)` leaves the size at 0;
- `s?.has(1)` is `false`.

The non-optional `s!.add(5)` works. This is the optional-call arm in
`calls-optional.ts`, and was reported to the lead for S7's lane.
