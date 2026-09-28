---
id: 5402
title: "Reject Number parameter calls that incorrectly dispatch to the builtin"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: compiler
goal: correctness
parent: 5393
assignee: "ttraenkler/codex-generator-safety"
---

## Reproduction

```js
function f(Number) { return Number([1]); }
console.log(f(x => 7));
```

At f816631c2ee108, Node 24.4.1 prints 7. The host and optimized host
print NaN; standalone and optimized standalone print 1. Renaming the
parameter to `convert` preserves 7 on all four targets.

## Implementation

Add a source diagnostic for a direct call whose callee is the identifier
Number and whose resolved binding is a parameter declaration. The compiler
currently chooses the intrinsic by name instead of calling that binding.
The diagnostic recommends renaming the parameter and is independent of
TypeScript error suppression. Other local declarations and unknown bindings
are outside this detector; it is not a general builtin-shadowing verifier.
Parent #5393 integrates the new collector and compiler inventory entry.

## Scope tradeoff

`function f(Number){return Number(1)};f(x=>x)` happens to return 1 on all four
targets but is also refused. That agreement does not show that the backend
honors the parameter binding: changing the callback to return 7 exposes the
wrong dispatch. This is an explicit unsupported-binding restriction, without
whole-program callback analysis. Renaming the binding is the supported remedy.

## Validation

Four-target baseline and renamed-control observations are recorded in the
isolated task's `.tmp/number-shadow-four-lanes.jsonl`. Unit tests check source
locations, resolved parameter identity, nested shadowing, ordinary builtin
calls, renamed callbacks, and the documented coincidental-agreement case.
