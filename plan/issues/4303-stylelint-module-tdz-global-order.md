---
id: 4303
title: "Stylelint plans module TDZ global noop before its value global"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: modules, temporal-dead-zone
goal: npm-library-support
related: [3798, 4000, 4001, 4018, 4302]
---

# Stylelint plans module TDZ global `noop` before its value global

## Problem

Once Stylelint's explicit Node filesystem capability is enabled by #4000, the
real 17.14.1 entry graph reaches code generation and reports:

```text
Codegen error: module TDZ global noop was observed before its value global
  at src/codegen/program-abi-global-planning.ts
```

This is one of six compile errors from the bounded entry run; the other five
are the async shapes owned by #4302. No binary is emitted.

Reproduce:

```bash
node tests/dogfood/npm-compat-catalog-harness.mjs --package stylelint --json
```

The measured run completed in 82.319 seconds with `allowFs: true`.

## Suspended handoff (2026-08-09)

The error is source-order/program-ABI evidence only. It has not yet been
reduced, and it must not be conflated with #4018's already-fixed ambient
declaration owner or #4001's already-fixed repeated module initializer.
Resume by locating the declaration/value observations for `noop`, reducing the
same ordering from Stylelint's resolved graph, and fixing the generic registry
ordering without package-specific renaming or initializer deletion.

## Resolution

The three `css-tree` modules in Stylelint's graph declare the same bare name,
`noop`, using two module-level function expressions and one function
declaration. Compatibility maps still expose that shared name, so a later
declaration could find an earlier declaration's value global and attach its TDZ
observation to a declaration that did not own that value. Program ABI planning
then saw the TDZ observation before the matching value observation and aborted.

Module TDZ registration now records an observation only when the exact
declaration already owns the value global. The reduced four-module fixture
keeps the value global before the TDZ global, emits valid Wasm, and executes to
`42`. The real Stylelint graph no longer emits the `noop` TDZ diagnostic: it
continues past the former 42.352 second abort and remained actively compiling
beyond the 120 second catalog budget. The remaining package frontier is tracked
separately by [#4302](./4302-package-async-await-inside-try-shapes.md).

## Acceptance criteria

- [x] A reduced multi-source fixture reproduces the `noop` ordering failure.
- [x] The program ABI registers a TDZ global and its value in a stable order.
- [x] Stylelint no longer reports this error when the #4302 diagnostics are
      measured independently.
- [x] Existing module-global identity, ambient declaration, and init-order
      suites remain green.
