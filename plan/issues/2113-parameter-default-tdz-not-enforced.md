---
id: 2113
renumbered_from: 1954
title: "parameter-default TDZ not enforced: f(a = a) yields NaN and f(a = b, b = 2) reads later params instead of throwing ReferenceError"
status: wont-fix
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: default-parameters
goal: error-model
related: [1128]
origin: "2026-06-10 deep-audit sweep (closures agent): verified on main"
---

# #2113 — parameter defaults ignore the TDZ for self/forward references

## Problem

Per [§10.2.11 FunctionDeclarationInstantiation](https://tc39.es/ecma262/#sec-functiondeclarationinstantiation),
parameter bindings are initialized left-to-right; a default referencing its own
parameter or a later one must throw ReferenceError.

## Repro (verified on main)

| probe | wasm | node |
|-------|------|------|
| `function f(a: number = a) { return a; } f()` | `NaN` | ReferenceError |
| `function f(a = b, b = 2) { return "" + a + b; } f()` | `"22"` | ReferenceError |

## Root cause (area)

Parameter-default lowering reads the (zero-initialized / later-bound) local
directly with no TDZ poisoning for not-yet-initialized parameter bindings.
Sibling of #1128 (destructuring TDZ, done) for plain parameters.

## Fix direction

During default-value compilation, treat parameters at index ≥ current as
TDZ-poisoned identifiers (compile reads to a ReferenceError throw), matching
the mechanism #1128 added for destructuring.

## Acceptance criteria

- Both repros throw ReferenceError (catchable as the compiled error model
  allows)
- Valid earlier-param references (`f(a, b = a)`) keep working

## Dupe check

Grepped `param.*tdz`, `default.*reference`: #1128 (destructuring TDZ, done).
Plain-parameter case untracked.

## Closed as duplicate (2026-06-12)

Duplicate of #2121 — the same audit batch was filed twice (#2110–#2117 ≡ #2118–#2125). The high series is canonical: merged/open PRs reference #2120–#2125. No work was lost; see #2121.
