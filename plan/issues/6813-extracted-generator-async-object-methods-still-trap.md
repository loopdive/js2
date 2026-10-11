---
id: 6813
title: "codegen: an extracted object-literal generator or async method (`const g = obj.gen; g()`) still traps uncatchably — #6789 only gave the plain-method trampoline a catchable null-receiver arm"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen
language_feature: closures
goal: core-semantics
related: [6789, 2025]
requested_by: ttraenkler/claude-review
origin: "left out of the #6789 scope and reported by its implementation (2026-10-01/02); not re-measured by the filer"
---
# #6813 — the generator/async trampolines need the same null-`this` arm as #6789

## Problem

#6789 changed `src/codegen/closures/method-trampolines.ts` so that an
extracted object-literal method called without a receiver throws a catchable
`TypeError` instead of trapping on `ref.null` inside `__obj_meth_tramp_*`.
The generator and async method shapes have their own trampolines (the
generator planner and the async wrapper build their receiver differently) and
the report says they still trap:

```ts
const obj = {
  *gen() { yield this.v; },
  async am() { return this.v; },
  v: 1,
};
export function run(): string {
  const out: string[] = [];
  try { const g = obj.gen; [...g()]; out.push("gen-ok"); } catch (e) { out.push("gen-caught"); }
  try { const a = obj.am; a(); out.push("async-ok"); } catch (e) { out.push("async-caught"); }
  return out.join(",");
}
```

JS (strict module): `this` is `undefined` inside both, so `gen` throws a
`TypeError` when the body first runs (`[...g()]`) and `am()` returns a rejected
promise — the probe prints `"gen-caught,async-ok"`. The compiled module traps
(`dereferencing a null pointer`) and the instance is lost.

## Correction

Route the generator and async trampolines through the helper #6789 added for
the plain arm (the `__new_TypeError(...)` throw when `currentThisGlobalIdx < 0`
and the receiver is null) — for the async shape the TypeError must become the
returned promise's rejection, not a synchronous throw.

## Acceptance

- The probe prints `"gen-caught,async-ok"` and a second export called after
  the catches still works (instance survives).
- Rows added to `tests/issue-6789.test.ts`; `pnpm run -s test:guard` unchanged.
