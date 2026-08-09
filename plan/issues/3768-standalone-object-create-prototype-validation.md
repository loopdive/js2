---
id: 3768
title: "standalone Object.create accepts primitive prototype arguments"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: s
complexity: S
feasibility: high
task_type: bugfix
area: codegen
language_feature: object-create
es_edition: es5
goal: es5
assignee: ttraenkler/codex-es5-object-create-proto-validation
---

# Standalone `Object.create` prototype validation

## Problem

The standalone `Object.create` helper treated every non-object externref carrier
like `null`. As a result, statically known primitive prototype arguments created
a null-prototype object instead of throwing the `TypeError` required by ES5
§15.2.3.5.

On `origin/main` at `3cb6b8ac6f3649e05a24ed51fb7347bb33795669`,
the exact ES5 `built-ins/Object/create` lane passed 240/314 in host mode and
158/314 in standalone mode. Four standalone failures formed this disjoint root:

- `15.2.3.5-1.js` (`0`)
- `15.2.3.5-1-1.js` (`undefined`)
- `15.2.3.5-1-3.js` (`true`)
- `15.2.3.5-1-4.js` (`2`)

## Scope

Validate statically known primitive first arguments at the `Object.create`
entrypoint in standalone mode, preserving argument evaluation and continuing to
accept `null`.

This slice intentionally excludes dynamic primitive carriers, second-argument
property descriptors, generic `Object.defineProperty`/`Object.defineProperties`
behavior, and general prototype-chain behavior.

## Acceptance

- All four targeted ES5 cases pass in standalone mode.
- The host lane remains unchanged.
- `Object.create(null)` continues to work.
- Focused regression tests cover the thrown error and argument side effects.
- The full `built-ins/Object/create` comparison has zero pass-to-fail
  transitions in either target.

## Result

On the same compiler SHA and with the same authoritative runner:

- standalone exact ES5 lane: 158/314 → 162/314
- standalone full directory: 162/320 → 166/320
- host exact ES5 lane: unchanged at 240/314
- host full directory: unchanged at 246/320
- status changes: exactly the four targeted fail-to-pass transitions
- regressions: zero pass-to-fail transitions and zero residual
  error-signature changes in either target
