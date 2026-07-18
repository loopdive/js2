---
id: 3365
title: "Assignment semantics: strict failures throw non-object values instead of TypeError instances"
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, exceptions
language_feature: assignment, strict-mode, error-identity
goal: test262-conformance
assignee: codex/root
related: [3362, 3364]
files:
  - src/codegen/expressions.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/index.ts
---
# #3365 — assignment failures throw the wrong payload representation

## Problem

Two original-harness tests observe a throw, but upstream `assert.throws`
reports `Thrown value was not an object!` rather than recognizing a
`TypeError` instance:

- `language/expressions/assignment/11.13.1-4-27-s.js`
- `language/expressions/assignment/11.13.1-4-3-s.js`

## Acceptance criteria

- Fetch and cite the relevant strict assignment failure steps.
- Identify whether the thrown value originates in compiler lowering or the
  host bridge and make it a catchable, branded `TypeError` object.
- Both sampled tests pass without weakening upstream `assert.throws`.

## Diagnosis (2026-07-17)

Both tests start with `var global = this`. The module-init function had no
local `this` binding and fell through to the generic function-body
`undefined` fallback, even though Test262 compiles these files as Script goal.
The subsequent `global.Infinity = 42` / `global.undefined = 42` therefore
threw a nullish-access payload, which the literal upstream `assert.throws`
correctly rejected as a non-object.

Per [ECMA-262 PutValue §6.2.5.6](https://tc39.es/ecma262/#sec-putvalue), a
property reference calls `[[Set]]` with the reference's strict flag, and a
failed strict set throws `TypeError`. Script top-level `this` must first denote
the global object so these writes reach that property-set path. The source-goal
fix is implemented here; #3364 owns the shared strict-vs-sloppy host-set
selection needed for the final branded `TypeError`.

## Implementation summary

Codegen now records whether the input is Script or Module goal. Script
top-level `this` resolves to the global object, while Module top-level `this`
remains `undefined`; module variables initialized from Script `this` retain an
`externref` representation so later property writes reach the host global
object. Combined with #3364's strict setter, failures now carry real
`TypeError` objects through the Wasm exception bridge.

This matches [ECMA-262 Global Environment Records](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records),
whose `[[GlobalThisValue]]` supplies global-scope `this`, and
[Module Environment Record `GetThisBinding`](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-module-environment-records-getthisbinding),
which returns `undefined`.

### Verification

- `tests/issue-3365.test.ts`: Script/Module top-level `this` behavior passes.
- Original harness: both wrong-thrown-payload tests pass.
