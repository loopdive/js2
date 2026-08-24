---
id: 4608
title: "Wire a production producer for IrModule.declaredGlobals (verifier global.* declaration rules end to end)"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-22
assignee: ttraenkler/codex-ir-lead
branch: codex/4608-declared-globals-producer
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
model: gpt-5.6-sol
files:
  - src/codegen/program-abi-declared-globals.ts
  - src/ir/integration.ts
  - tests/issue-4608-declared-globals-production-producer.test.ts
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

## 2026-08-22 grounded implementation plan

The post-R1 prerequisite is now present. `planProgramAbiGlobal` records each
global's exact binding ID, structural key, physical carrier, mutability,
structured contract, and allocator locator. The final retained-global
publication is intentionally too late for the two IR verification sites, but
the live Program ABI draft and locator population is authoritative for every
IR-visible global at both sites. Inlining and monomorphization copy these exact
refs; DCE and type-layout remapping run later.

### Producer and fail-closed contract

Add `src/codegen/program-abi-declared-globals.ts` and keep the integration edit
to one import plus the two existing module-verification calls in
`src/ir/integration.ts` (post-inline and post-monomorphization/tagged-union).
The integration diff must remain below the issue's 30-line stop rule and may
not restructure a Prepared transaction.

The producer deep-scans the module's functions with `forEachInstrDeep` for
`global.get` and `global.set`. For each referenced binding it must:

1. use `binding.bindingId` as the Program ABI identity and require a live draft
   whose intent is exactly `kind: "global"` with the same origin;
2. validate the complete physical payload with `irGlobalBindingKey(binding)`;
3. call `ProgramAbiSession.resolveCurrentIndex` with that binding ID,
   structural key, kind `global`, and the current module;
4. resolve the returned combined index to the exact nth global import or
   defined module global, then convert that allocator object's current
   `ValType` through `irVal`; and
5. publish the result under `irBindingKey(binding)`, rejecting any duplicate
   declaration key whose carrier differs.

Do not parse `draft.intent.valueType`: structured `ref`/`ref_null` type indices
can be remapped while that diagnostic string remains stale. Do not consume or
seal the final Program ABI publication at either verifier site.

With no Program ABI session, return `undefined` so compatibility and focused
test callers retain #4605's conservative behavior. With a session, an unknown
or forged binding, wrong structural payload, non-global intent, missing or
eliminated locator, invalid index, or conflicting duplicate is a typed Program
ABI invariant. Never omit or guess a carrier. Same-named global imports remain
distinct because identity and the full structural payload, not spelling, drive
the lookup.

### Measured anti-vacuity and controls

A real-session probe using `planProgramAbiGlobal`, current-index resolution,
and the production verifier is base-red in exactly the intended way:

- a declared `f64` global with a lone coherent `i32 global.set` produces zero
  verifier errors without `declaredGlobals`;
- the same module produces one declaration contradiction with the projected
  table; and
- a matching `f64` use remains clean.

The focused test must reproduce that shape end to end, then cover a nested
instruction reference, unknown/forged identity failures, conflicting duplicate
declarations, and two same-named globals with distinct ABI identities. It must
also prove the absent-session conservative path.

False-positive controls are part of acceptance. Lazy/deferred initialization
does not change a Wasm global's static carrier. Function-value caches use
`externref`; their later logical `callable` reads, along with logical dynamic,
extern, string, class, and vector globals, remain outside the current
`ValType.kind` comparison when they are non-`val`. Async-frame/runtime globals
that never appear as symbolic IR `global.*` are also outside this producer.
This slice does not claim ref type-index, brand, or mutability verification.

Run the new focused test with #4605, #3520 global-population, and #3520
module-global-integration coverage. Then require unchanged verbose IR fallback
buckets, hybrid and strict IR-only reports, the linear gate, typecheck, lint,
Prettier, LOC/function/oracle gates, and all eight equivalence shards in fresh
processes. Do not rewrite a shared baseline.

### Coordination

The current #3523 scalar-statement slice owns only
`src/codegen/index.ts::preparedExactLexicalModuleInit` and its focused test; it
is explicitly forbidden from editing `src/ir/integration.ts`. The orchestrator
may therefore serialize or run this producer beside that bounded slice, but no
other R4/R1 worker may claim the integration sites concurrently. PR #4747
touches Program ABI planning, but this design reads its established contract
and deliberately does not edit that file. The fast-`any[]` #4615 slice is
confined to `index.ts::resolvePositionType` and has no file overlap.
