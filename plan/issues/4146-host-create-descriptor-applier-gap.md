---
id: 4146
title: "Object.create's dynamic descriptor route neither honours nor validates accessors in the JS-host lane (mirror gap in standalone defineProperty)"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-04
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: core-semantics
related: [4061, 1906, 4047]
---

# `Object.create`'s dynamic descriptor route neither honours nor validates accessors in the JS-host lane

Split out of #4061 on 2026-08-04. #4061 fixed `Object.create`'s **static**
descriptor expansion and routed everything it could not model to the dynamic
applier. In the **standalone** lane that applier
(`__obj_define_from_desc`) implements ToPropertyDescriptor correctly and all 17
of #4061's test262 rows land. In the **JS-host** lane the same route goes
through the `__defineProperty_desc` import, which does neither the accessor
install nor the §6.2.5.6 validation.

## Measured — `Object.defineProperty` is the control, and it works in BOTH lanes

Compiled and run at `376b40923` via `buildImports` + `instantiateWasm`:

| Source | host | standalone |
| --- | --- | --- |
| `Object.defineProperty(o, "p", {get: () => 9}); o.p` | **9** ✓ | **9** ✓ |
| `Object.create({}, {p: {get: () => 9}}).p` | **NaN** ✗ | **9** ✓ |
| `Object.defineProperty(o, "p", {get: true})` | **throws** ✓ | **does not throw** ✗ |
| `Object.create({}, {p: {get: true}})` | **does not throw** ✗ | **throws** ✓ |

Two independent gaps, in opposite lanes, which is why the control row matters —
neither lane is simply "behind" the other:

1. **Host, via `Object.create`** — the accessor is not installed (`NaN`) and a
   non-callable `get`/`set` does not throw. `Object.defineProperty` in the same
   lane does both correctly, so the defect is in what `Object.create` routes
   into, not in the host descriptor machinery generally.
2. **Standalone, via `Object.defineProperty`** — a non-callable `get` does not
   throw, while `Object.create` in the same lane does. Mirror image of (1).

## Not a regression from #4061

Before #4061 these descriptors took `Object.create`'s static expansion, which
read `get`/`set` only to set the ACCESSOR flag and then called
`__defineProperty_value` with a NULL value — so the accessor was dropped just as
silently and nothing threw. #4061 makes the gap **reachable by more shapes**;
it neither causes nor fixes it. Its test file therefore asserts these cases in
the standalone lane only, with the measurement above recorded inline, rather
than encoding the bug in a host-lane assertion.

## Acceptance

- [ ] `Object.create(proto, {p: {get: fn}})` installs a working accessor in the
      **host** lane — asserted by CALLING it (`o.p === 9`), never by "did not
      throw"; the pre-#4061 behaviour also did not throw.
- [ ] A non-callable `get`/`set` through `Object.create` throws TypeError in the
      host lane (§6.2.5.6 steps 7.b / 8.b).
- [ ] A non-callable `get`/`set` through `Object.defineProperty` throws
      TypeError in the **standalone** lane — gap (2) above.
- [ ] `Object.defineProperty` + accessor keeps working in both lanes (the
      control must not regress while (1) is fixed).
- [ ] The eight standalone-only cases in `tests/issue-4061.test.ts` move back
      into the both-lanes loop, and the host-gap note there is deleted.
- [ ] Report test262 flips with denominators, per lane.
