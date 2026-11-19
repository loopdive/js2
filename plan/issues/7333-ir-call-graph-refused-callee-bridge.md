---
id: 7333
title: "IR: a call-graph-closure caller should call a selection-refused callee as it calls a withdrawn one"
status: in-progress
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7324, 7147]
loc-budget-allow:
  # 2026-11-19 (S8, WIP) — the callee-direction bridge: select.ts +16 and
  #   select-identity.ts +26 (one shared predicate at three gates, and the
  #   published legacyCallees set); codegen/index.ts +36 (the override
  #   computation moves into resolveIrFunctionOverride, now shared by claimed
  #   units and legacy callees). Re-measured before the PR leaves WIP.
  - src/ir/select.ts
  - src/ir/select-identity.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-11-19 (S8, WIP) — planIrCompilationByIdentity +5: the callee test of
  #   the closure loop and the published legacyCallees field; the set itself
  #   is built by collectLegacyCallees.
  - src/ir/select-identity.ts::planIrCompilationByIdentity
---

# #7333 — a selection-refused callee should not cascade to its IR callers

## Problem

#7324 makes the call-graph gate (`buildLocalCallGraph`) check calls inside
lifted closures. Before #7324, a unit whose closure called an unlowerable
callee was claimed and then withdrawn by from-ast. #7324 refuses it at
selection instead, which is the honest answer under the
[#7147 standard](https://github.com/loopdive/js2/pull/7147).

The earlier refusal cascades to callers. A caller of the refused unit fails
the call-graph-closure gate, because the callee is no longer in the claimed
set. On main, the same caller stayed IR: it called the withdrawn unit
through the bridge a withdrawal already gets.

Synthetic shapes, measured on #7324 (PR #7175) head `f39c6a0dc5` against
main `b631a4bc`, on all three targets (gc, standalone, wasi):

```ts
function f(o: any): number { const { w: { x } = {} as any } = o; return 1; }
function t(x: number): number { const c = (y: number): number => f(y); return c(x); }
t(1);
```

```ts
function t(x: number): number { const c = (y: number): number => { RegExp("a"); return y; }; return c(x); }
t(1);
```

| Unit | Main | #7324 |
| --- | --- | --- |
| `t` | claimed, then withdrawn ("no exact AST-site plan in t__closure_0") | refused at selection |
| `<module-init>` (`t(1)`) | IR | refused (`call-graph-closure`) |

On the wrapped test262 stride-40 corpus this does not occur: no file loses a
unit there.

Since #7287 (PR #7164, test fixed in PR #7185), an uninitialized or dynamic
module-var callee no longer refuses: its statement call lowers as the dynamic
module call. This follow-up therefore concerns only non-dynamic callees
(ambient functions, unclaimed declarations, non-callable module values).

## Goal

A caller of a selection-refused function should take the same route as a
caller of a withdrawn one: call the legacy-compiled callee through the
existing dynamic / legacy-call bridge. Then an honest refusal costs only the
refused unit, not its callers.

## Acceptance criteria

- [ ] In both shapes above, `t` is refused at selection and the
      `<module-init>` is IR on gc, standalone and wasi, with values matching
      JS.
- [ ] Wrapped stride-40 ledger: no unit lost against main; gc bytes are
      identical wherever the route set is unchanged.
- [ ] The rule lives in the call-graph gate or the callee-resolution seam it
      shares with from-ast. There is no per-shape special case.

## Implementation Plan

Reproduced on main `ee3fcdd6` (2026-11-19): both shapes give `t` refused and
`<module-init>` refused (`call-graph-closure`) on gc, standalone and wasi.

**Rule.** The caller direction of the call-graph closure already has a
per-declaration certificate, `legacyCallerAbiIsProjected`: the callee's
legacy callable has exactly the ABI the IR projects for it. The same fact
makes the callee direction safe: an IR caller's `call` to a refused callee
lands in the callee's pre-allocated legacy slot with a matching signature.
So an unclaimed callee whose declaration carries the certificate is not a
blocking edge; it is a *legacy callee* the caller calls through its legacy
body. Host-free lanes only (`legacyCalleeBridgePolicy`, next to the
caller-direction policy), so gc output stays byte-identical.

**Where it lives (no new mechanism, three existing seams):**

1. Selection — `src/ir/legacy-caller-policy.ts` gains the lane policy; the
   three gates that read callee edges consult it with the existing
   certificate: the structural closure (`select.ts` step 2), the identity
   closure (`select-identity.ts`) and the module-init gate
   (`assessModuleInit`, shared by both). The identity selection publishes
   the admitted edges as `legacyCallees` (unit ids).
2. Signatures — the per-function override computation in
   `src/codegen/index.ts` moves out of the 200-line planning function into
   `resolveIrFunctionOverride`, and serves claimed units and legacy callees
   alike (no second copy of the signature rules).
3. Direct-call plans — `projectIrIntegrationLoweringPlans`
   (`src/codegen/ir-overlay-identity.ts`) adds the legacy callees as call
   targets (never owners); `collectIrDirectCallLoweringPlansByIdentity`
   takes the target set separately from the owner set. Integration already
   binds a planned unit target to its registered slot
   (`bindPlannedUnitTarget`), so nothing changes below.

**Quality acceptance.** One predicate decides both directions; no per-shape
case; no new file; the planning function shrinks.

**Measurement.** 700-file seeded ES5 sample (seed 7106, the census
population), `--target standalone`, original harness, compiled and run:
base main `ee3fcdd6` vs head.
