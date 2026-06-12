---
id: 2013
title: "JSON.parse reviver argument silently ignored (parse arm compiles only arguments[0]; host import drops it)"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: host-interop
language_feature: json
goal: core-semantics
related: [787]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2013 — reviver never invoked, side effects lost

## Problem

```ts
JSON.parse('{"a":1,"b":2}', (k, v) => typeof v === "number" ? v * 10 : v)
// wasm: {"a":1,"b":2}   node: {"a":10,"b":20}
```

## Root cause

`src/codegen/expressions/calls.ts:5516-5604` — the `JSON.parse` arm
compiles only `arguments[0]` (the stringify arm handles extra args; the
parse arm doesn't), and the host import `src/runtime.ts:4938` is
`(s) => JSON.parse(s)`, dropping the reviver entirely.

## Fix direction

Compile the reviver through the closure→host-callback bridge (same
machinery as array HOF callbacks) and forward it in the import.

## Acceptance criteria

- Repro matches Node; reviver `this`/key/value per §25.5.1
- No-reviver calls unchanged

## Dupe check

Only #787 (done, one test262 reviver test in a wrong-values bucket). New.
