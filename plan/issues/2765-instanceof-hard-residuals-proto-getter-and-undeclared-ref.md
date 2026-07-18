---
id: 2765
title: "instanceof hard residuals: Function.prototype getter / WasmGC array proto-chain + undeclared-global ReferenceError"
status: ready
sprint: Backlog
created: 2026-06-28
updated: 2026-07-02
priority: low
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: instanceof
goal: core-semantics
parent: 2740
depends_on: []
---

# #2765 — instanceof hard residuals (two unrelated deep gaps)

Hard split of the #2740 umbrella — two distinct deep gaps grouped here per
tech-lead routing. Both surface through instanceof tests but are general
semantics gaps. Verified on current `main` 2026-06-28.

## Cluster 4 — `Function.prototype` "prototype" getter + WasmGC array prototype chain

`language/expressions/instanceof/prototype-getter-with-object.js`:

```js
Object.defineProperty(Function.prototype, "prototype", {
  get() {
    return Array.prototype;
  },
});
var result = [] instanceof Function.prototype; // expect true
```

`Function.prototype` is itself callable; OrdinaryHasInstance must read its
`prototype` (firing the installed getter → `Array.prototype`), then walk
`[]`'s prototype chain and find `Array.prototype` → `true`. Requires (a) the
getter on `Function.prototype.prototype` to fire through the dynamic instanceof
path, and (b) a WasmGC array (`[]`) to expose a real `[[Prototype]]` chain
reaching `Array.prototype`. We currently return false. This is a
prototype-chain / accessor-on-builtin-proto gap.

## Cluster 5 — undeclared-global read should throw `ReferenceError`

`language/expressions/instanceof/S11.8.6_A2.1_T3.js`:

```js
({}) instanceof OBJECT; // OBJECT undeclared → must throw ReferenceError
```

We treat an undeclared global read as `undefined`, so the instanceof returns
`false` instead of throwing `ReferenceError`. This is a **broad, cross-cutting**
semantic (it affects _every_ undeclared identifier read, not just instanceof
RHS) and is risky to change narrowly — scope carefully. May be wont-fix /
deferred depending on the cost-benefit of strict undeclared-reference semantics
in the WasmGC backend.

## Acceptance criteria

- Cluster 4: `[] instanceof Function.prototype` with a `prototype` getter
  returning `Array.prototype` → `true`; the getter fires exactly once.
- Cluster 5: `({}) instanceof <undeclared>` throws `ReferenceError`
  (or documented wont-fix with rationale if strict undeclared-read semantics are
  out of scope for the backend).
- No regression in the 28 instanceof tests currently green.

## Notes

- These are the two lowest-priority / hardest residuals of #2740; cluster 5 in
  particular may be deferred. Filed for tracking completeness.

## Reground (2026-07-02, dev-2912f, task #22)

Re-verified against current main (baseline jsonl + probes):

- **Cluster 4 is RESOLVED on main**:
  `language/expressions/instanceof/prototype-getter-with-object.js` now
  **passes** (landed with the recent instanceof/prototype-chain work — the
  `Function.prototype.prototype` getter fires and the WasmGC array reaches
  `Array.prototype`). No work remains here.
- **Cluster 5 still stands**: `S11.8.6_A2.1_T3` — `({}) instanceof OBJECT`
  with undeclared `OBJECT` returns `false` instead of throwing
  `ReferenceError` (probe-confirmed: undeclared reads still yield
  `undefined`). Unchanged assessment: broad cross-cutting semantic, candidate
  wont-fix; also interacts with #2763's undeclared-global assignment path
  (`A2.4_T4` needs the non-strict CREATE-on-assign to work while the bare
  read throws — the two must be designed together).

This issue now tracks ONLY cluster 5.
