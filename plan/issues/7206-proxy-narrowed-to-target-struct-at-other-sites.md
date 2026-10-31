---
id: 7206
title: "A Proxy over a struct-backed target is still nulled where other sites narrow it to the target's struct"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: proxy
goal: correctness
related: [7161]
---

# #7206 — Proxy narrowing to the target struct, beyond call-site parameters

#7161 (PR #7008) fixed one site, call-site parameter inference. TypeScript gives
`new Proxy(t, h)` the type of its target, so other sites still narrow the
Proxy to the target's struct and get `ref.null` when the cast fails. All of
the following are already wrong on main, on gc native-first, standalone and
wasi:

- **Helper return.** In `function mk() { return new Proxy(new C(), {}); }`,
  the return is narrowed to `$C`.
- **Literal stores.** A Proxy stored in an array or object literal is nulled.
  The object case traps with a null dereference, and so does passing the
  array to `.map(cb)`.
- **`this`.** For `p.m()`, method dispatch casts the receiver to `$C`.
- **`let` reassigned to a Proxy**, and a Proxy chosen by a ternary.
- **An aliased constructor.** `const P = Proxy; new P(...)` gives
  `C.has(p) === true`, where node gives false.

## Plan

1. Reuse `tracesToProxyValue` / `proxyArgDefeatsRefNarrowing` from
   `src/codegen/proxy-value-provenance.ts`. Apply it at return-type inference,
   at literal element and field typing, at receiver dispatch, and at local
   variable typing.
2. Extend the predicate to cover `const P = Proxy` aliases.
3. Tests: one row per form, on 3 lanes against node. Programs without a Proxy
   must stay byte-identical.
