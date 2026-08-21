---
id: 4605
title: "IR module-level declared-type table: give the verifier a signature/global source of truth for call/global.* rules"
status: ready
sprint: current
created: 2026-08-21
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: hardening
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3518
related: [4603, 4523, 3030, 3520]
origin: "#4603 finding 1 (PR #4704): call/global.* type rules could only be intra-function coherence checks because no declared-signature record exists in the verifier's scope"
# id 4605 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs 4703/4707 introduce no issue file
# with an id near 4605; the assignment book's prior reservation was #4603.
# Note: "#4605" also appears in old prose as a PULL REQUEST number (ids and
# PR numbers share one sequence); no issue FILE with id 4605 exists on main.
---

# #4605 — module-level declared-type table for the IR verifier

## Problem (from #4603's measured finding)

PR #4704 set out to give `call`, `global.get`, and `global.set` the type
rules #4523's triage sketched ("vs the target's resolved signature", "must
match the global's declared IrType") and found the records **do not exist**
anywhere the verifier can reach: `IrFuncRef`/`IrGlobalRef` carry only a debug
name plus a structural binding, both resolve lazily at lowering, and
`IrModule` holds *only* `functions` — no globals table, no signature table.
`verifyIrFunction` takes a single `IrFunction`, which carries neither.

The landed fallback is intra-function coherence (two references to one
binding must agree with each other), which catches the defect class but not
its most common shape: ONE mistaken call site, coherent with itself.

## Why this belongs on the #3518 spine

`ProgramAbiMap` (#3520 R1) is building exactly this vocabulary on the
codegen side — source-qualified identity with planned signatures, globals,
imports, and types. The verifier needing a declared-type table and the
prepared pipeline needing a whole-program ABI are the same fact stated
twice. The design question this issue owns: does the verifier consume a
projection of `ProgramAbiMap` (one source of truth, but couples verify to
preparation), or does `IrModule` grow its own declared tables that
preparation then cross-checks (verifier stays standalone, one more thing to
keep in sync)? #3030 (serializable interchange) wants the second shape —
a self-describing module — and its C2 thread (schema namespace) is the
natural place the table's serialized form lands.

## Acceptance criteria

- [ ] A decision, recorded here, on the table's home (ProgramAbiMap
      projection vs IrModule-owned declarations), with the #3030
      serialization consequence stated.
- [ ] `IrModule` (or the chosen carrier) exposes declared signatures for
      functions and declared IrTypes for globals reachable by
      `verifyIrFunction` (likely via an optional context parameter so
      existing single-function callers stay valid).
- [ ] The #4603 coherence rules for `call`/`global.*` upgrade to
      declared-type rules when the table is present, keeping the
      conservative skip when it is absent; positive + negative fixtures per
      the #4070 method, and the mutation proof that removing a rule fails
      loudly.
- [ ] No behavior change for valid IR; `check:ir-fallbacks` post-claim
      buckets and `check:ir-only` (both lanes) unchanged; the full corpus
      shows zero new demotions attributable to the upgraded rules.
