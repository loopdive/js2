---
id: 4523
title: "checkInstr type rules cover 16/78 IR kinds by construction — decide the opt-in→opt-out question and own the roadmap"
status: ready
sprint: current
created: 2026-08-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: hardening
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [4070, 3518]
origin: "opus-ir-1's #4070 writeup + tech-lead IR review, 2026-08-16"
files:
  - src/ir/verify.ts
  - plan/agent-context/opus-ir-1.md
---

# #4523 — per-instruction type-rule coverage is an undecided policy, not a hole

## Problem

The #4070 sweep (PR #4623) hardened every IR-union switch that could fail
silently, but deliberately left `checkInstr` in `src/ir/verify.ts` unguarded:
it implements type rules for **16 of 78** IR kinds and is partial BY
CONSTRUCTION — an opt-in policy where a kind without a rule is simply not
type-checked. Adding a `never` guard there would mean 62 empty cases and
would flip the policy to opt-out. That is a design decision, and the #4070
dev correctly wrote it up (`plan/agent-context/opus-ir-1.md`) rather than
deciding it unilaterally. Undecided, it has a real cost: a new IR kind gets
NO type verification and nothing reminds its author that the omission was a
choice. Meanwhile the rest of verify.ts (def-use, dominance, branch arity/
types) IS total, so the partial region is easy to mistake for covered.

## Acceptance criteria

- [ ] A decision, recorded in this file: (a) opt-out — every kind needs a
      rule or an explicit `case: skip` with a reason, enforced by the switch;
      or (b) opt-in stays — but a generated coverage table (kinds with/
      without rules) is emitted and ratcheted so coverage can only grow; or
      (c) a hybrid (e.g. new kinds require a rule; the 62 legacy kinds are a
      grandfathered baseline that ratchets down).
- [ ] The chosen mechanism implemented; deliberately removing one existing
      rule must fail loudly (prove the gate fires, per the #4070 method).
- [ ] The 62 uncovered kinds triaged at least into "type rule meaningful" vs
      "nothing to check" (e.g. kinds whose operands are untyped by design),
      so the roadmap has a real denominator.
