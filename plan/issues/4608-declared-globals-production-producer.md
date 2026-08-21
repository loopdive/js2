---
id: 4608
title: "Wire a production producer for IrModule.declaredGlobals (verifier global.* declaration rules end to end)"
status: ready
sprint: current
created: 2026-08-21
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: hardening
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3518
depends_on: [3520]
related: [4605, 4603, 3030]
origin: "#4605 (PR #4725) landed the declared-table mechanism with a production producer for call signatures only; declaredGlobals had no record to read — its natural source is #3520 R1's globals table"
# id 4608 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs were 4725 (introduces the issue file
# for id 4605) and none near 4608.
---

# #4608 — production producer for `declaredGlobals`

## Problem

#4605 (PR #4725) gave `IrModule` optional declared-type tables and upgraded
the verifier's `call` / `global.get` / `global.set` rules to check against
declarations when present. In production, only `call` is wired end to end:
`integration.ts` populates `declaredSignatures` from the per-function results
it already accumulates, but **nothing records a declared IrType per global**,
so `declaredGlobals` is only exercised by test fixtures and `global.*`
verification still falls back to intra-function coherence.

## Implementation Plan (Fable, 2026-08-21)

The record to read comes from #3520 R1's ABI work: module globals get
identity + planned carrier there. Once R1's completion PR lands, wire the
producer at the same two module-level verify sites #4605 used in
`integration.ts` (post-inline, post-mono/TU — the sites take a
`declarations` argument already, so this is filling the second map, not new
plumbing). Keyed by the same `irBindingKey` from `src/ir/declared-types.ts`.

Steps:
1. Locate where module-global bindings get their planned carrier
   (post-R1 `ProgramAbiMap` / global ABI tables — verify the anchor at
   implementation time; R1 is in flight as of filing).
2. Project `bindingKey → IrType` from that record into the
   `declaredGlobals` map passed at the two verify sites. Same stop-rule as
   #4605: if this needs >30 changed lines in `integration.ts` or fights the
   prepared-pipeline transactions, record the blocker here instead.
3. Prove end to end with a real-module negative: a module whose one
   `global.set` uses a wrong carrier must be caught with the table present
   (the "one mistaken reference, coherent with itself" shape) — per the
   #4070 method, plus the async-style false-positive check: run
   `check:ir-fallbacks` and confirm buckets identical to base (the #4605
   wiring caught a real false-positive class this way; expect the same
   diligence for globals, e.g. deferred/lazy-initialized globals whose
   carrier legitimately differs before first write).

## Acceptance criteria

- [ ] `declaredGlobals` populated in production at the two verify sites,
      sourced from the post-R1 global ABI record.
- [ ] End-to-end negative fixture caught only with the table present;
      conservative skip proven unchanged when absent.
- [ ] `check:ir-fallbacks` buckets identical to base (zero new demotions);
      `check:ir-only` both lanes unchanged; `check:linear-ir` at baseline.
- [ ] Any false-positive class found (à la async result carriers) recorded
      here with its guard.
