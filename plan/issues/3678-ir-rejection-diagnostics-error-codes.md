---
id: 3678
title: "Stable, actionable compiler diagnostics — code, source frame, and remediation"
status: backlog
sprint: Backlog
created: 2026-07-26
updated: 2026-08-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: feature
area: compiler, cli
language_feature: compiler-internals
es_edition: n/a
goal: developer-experience
required_by: [4382]
related: [1376, 1590, 1928, 1929, 2135, 2855, 3518, 3519, 3526, 4382]
---

# #3678 — Stable, actionable compiler diagnostics

## Objective

Give every compiler capability failure a stable, source-located, structured
diagnostic that tells a user what happened and what they can do next. Expected
unsupported source, compiler invariants, target-policy failures, runtime-
provider gaps, and backend-legality failures must remain distinguishable from
TypeScript's own numeric diagnostics.

## Problem

Today, several internal systems expose reason strings or aggregate buckets,
while `CompileError.code` primarily reflects optional TypeScript numeric codes.
Fallback telemetry is useful for CI budgets, but a developer compiling one file
still may not learn which source site failed, whether the failure is an
intentional target limitation or compiler defect, or which rewrite or target
would make progress.

This becomes a release blocker for the IR-only transition: once temporary
hybrid demotion is removed, every expected capability gap becomes a hard error.
A bare internal reason such as `body-shape-rejected` is accurate enough for a
counter but not an acceptable public diagnostic.

## Diagnostic contract

Define a typed diagnostic registry with stable project codes such as
`JS2W-IR-001`. The mnemonic/internal reason may evolve independently; the code
and documented meaning follow compatibility rules.

Each diagnostic carries:

- `code`, `category`, and `severity`;
- a primary file/line/column span plus related spans where needed;
- a concise message that states the failed capability or invariant;
- the selected target/backend and typed outcome (`Unsupported` or `Invariant`);
- an optional actionable hint, alternative target/provider, and tracking issue;
- structured details safe for JSON output without parsing human prose.

The initial registry covers every reason in the #1376 fallback census and the
typed preparation/legality outcomes introduced by #3519/#3518. Hints are
specific and conditional: for example, a parameter-shape rejection can suggest
moving destructuring into the function body, while a missing host capability
can name targets that intentionally provide it. A compiler invariant never
pretends a source rewrite is the remedy.

Human-readable output includes a compact source frame. JSON output uses the
same typed object and stable codes. `check:ir-fallbacks --verbose`, compile
results, CLI errors, and #4382's `explain` workflow all consume the registry;
none maintains its own code/message table.

## Compatibility and completeness

- Codes are never reassigned. Retired codes remain documented as retired.
- Unknown internal reasons map to a dedicated invariant diagnostic and fail the
  registry-completeness test; they are not printed as unstructured strings.
- TypeScript numeric codes remain available in a separate field rather than
  sharing the project-code namespace.
- Adding a fallback, typed outcome, host-capability rule, or backend-legality
  rejection requires a diagnostic registry entry in the same change.
- Presentation must not change fallback or target-selection behavior. Behavior
  changes belong to their semantic owner and are validated independently.

## Acceptance criteria

- [ ] Every #1376 rejection reason and every production typed compiler outcome
      has a stable project diagnostic code and category.
- [ ] Every source-caused `Unsupported` includes file/line/column and a compact
      source frame; multi-site errors include deterministic related locations.
- [ ] All known actionable gaps have a tested hint or alternative target;
      invariants clearly identify compiler defects without blaming source.
- [ ] Compile results expose project codes separately from TypeScript numeric
      codes, with one documented JSON schema used by CLI and tooling.
- [ ] `check:ir-fallbacks --verbose` includes the stable codes and locations.
- [ ] Registry completeness fails on an unregistered reason/outcome, duplicate
      code, reassigned code, or message-table drift.
- [ ] Human and JSON snapshots cover Unsupported, Invariant, host-policy,
      runtime-provider, and backend-legality examples.
- [ ] Baseline selection, fallback counts, emitted artifacts, and Test262
      results are unchanged by the presentation-layer landing.

## Out of scope

- Claiming that a diagnostic category is a conformance result.
- Hiding unsupported source by silently changing the requested target.
- Preserving legacy fallback after the IR-only retirement boundary solely to
  avoid emitting a diagnostic.
