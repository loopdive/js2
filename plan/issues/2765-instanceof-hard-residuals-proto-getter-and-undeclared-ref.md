---
id: 2765
title: "instanceof hard residuals: Function.prototype getter / WasmGC array proto-chain + undeclared-global ReferenceError"
status: in-progress
sprint: Backlog
created: 2026-06-28
updated: 2026-08-26
priority: low
horizon: l
feasibility: hard
model: gpt-5.6-luna
reasoning_effort: max
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

## ES2015 closeout correction (2026-08-26)

Cluster 4 is observable again once #4762 prevents the Test262 realm canary from
invoking the poisoned `Function.prototype.prototype` getter during cleanup.
The exact maintained host run `20260826-232826` no longer times out, but
`prototype-getter-with-object.js` fails because `[] instanceof
Function.prototype` is false after the getter runs. The authoritative
standalone run `20260826-194014` reports the same semantic failure. The throwing
and primitive sibling controls pass in the current host lane; standalone still
fails the throwing-object sibling because the expected abrupt completion is
lost.

Cluster 4 is therefore reopened. Its next checkpoint must pin getter count,
abrupt propagation, and the Array prototype-chain result in both lanes; it may
not restore the old cleanup timeout or treat a canary recycle as semantic
success.

## ES2015 cluster-4 implementation plan

1. Rerun the exact object, throwing-object, and primitive Test262 siblings in
   isolated host and standalone processes on the combined PR head. Record all
   six lane/path outcomes before changing code.
2. Reduce getter invocation, returned-prototype traversal, and abrupt
   propagation independently. Treat host cleanup/recycling as a control, not
   proof that compiled `instanceof` semantics passed.
3. Fix the shared OrdinaryHasInstance/prototype-chain path without a host
   oracle, fixture rewrite, skip, or special-case expected value. Do not touch
   cluster 5's undeclared-global behavior in this checkpoint.
4. Add permanent focused regressions requiring exactly one getter invocation,
   `true` for the Array-prototype object case, the original thrown object for
   the abrupt case, and `false` for the primitive control in both lanes.
5. Rerun the exact 3/3 rows in host and standalone and record the measured
   denominator in this issue before handing the commit to draft PR #5010.

## 2026-08-27 Luna/max handoff — cluster 4 remains open

The isolated `codex/2765-es2015-instanceof` worktree explored shared dynamic
`instanceof`, prototype reads/stores, closure dispatch, and runtime prototype
classification. The experiment did not converge to a verified checkpoint and
was stopped without integrating or pushing its uncommitted source edits.

The last completed exact three-row measurements were host run
`20260827-021225` at 2/3 and standalone run `20260827-030437` at 1/3. Both had
zero compile errors, compile timeouts, or skips. The host object case still
failed its true result after one getter call. Standalone still failed both the
object result and the throwing-object abrupt-completion case; only the
primitive control passed. These measurements are diagnostic only because the
worker continued editing afterward; they are not acceptance evidence for the
uncommitted experiment.

Handoff: restart from combined draft-PR commit `4e752a7f4`, reduce the object
prototype-chain result and throwing getter completion as separate mechanisms,
and add permanent focused coverage before widening shared prototype storage or
runtime classification. Do not reuse the isolated worktree's broad edits as a
checkpoint without first splitting and re-proving them. Cluster 4 and cluster
5 both remain open; no regression is claimed fixed by this handoff.
