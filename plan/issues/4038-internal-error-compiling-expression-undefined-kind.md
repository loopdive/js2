---
horizon: m
id: 4038
title: "Internal error compiling expression: Cannot read properties of undefined (reading 'kind')"
status: done
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
assignee: ttraenkler/claude
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, observability
goal: npm-library-support
sprint: 78
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 4030, 4033]
---

# #4038 — a `TypeError` inside expression compilation is reported as a diagnostic

## Problem

Two occurrences on the ESLint package entry, blocking emission:

```text
Internal error compiling expression: Cannot read properties of undefined (reading 'kind')
```

This is a **compiler crash**, not a user diagnostic: some code path reads
`.kind` off an `undefined` type/node. It is caught and reported as a compile
error, so the user sees an unactionable message and no binary.

## Why this needs the #4030 treatment first

Like #4019's `Maximum call stack size exceeded`, the message carries **no
location** — no file, no function, no frame — so it cannot be acted on as
reported. #4030 (attach the innermost `src/` frame to internal exceptions) is
effectively a prerequisite for diagnosing this one efficiently; without it the
next person pays the same instrumented-re-run cost on a ~16-minute compile that
#4019 already cost once.

## Acceptance criteria

- The throwing site is identified (do #4030 first, or hand-instrument the catch).
- A reduced fixture reproduces it without ESLint.
- The underlying `undefined` is fixed — not defended against with an `?.`, which
  would convert a crash into a silently wrong lowering.
- ESLint's package entry no longer reports this diagnostic.

## Root cause (2026-08-02) — a JSDoc function-type parameter has no name

Localised in one run using #4030, which reported
`(at src/codegen/expressions/call-identifier.ts:1071:17)`.

That line asks `ts.isObjectBindingPattern(paramDecl.name)` to decide whether a
signature parameter is a destructuring pattern. `ParameterDeclaration.name` is
typed **non-optional**, but it is genuinely absent for a parameter declared
through JSDoc function-type syntax: `@param {function(string): void} cb` models
*its own* parameters as nameless `ParameterDeclaration` nodes. Passing that
`undefined` into the predicate threw `Cannot read properties of undefined
(reading 'kind')`.

Reproduced in eight lines:

```js
/**
 * @param {function(string): void} cb
 * @returns {number}
 */
export function run(cb) { cb("x"); return 1; }
```

imported and called from another module. `@callback`-tag and `@type` variants do
NOT reproduce — only the inline `function(...)` type form.

## Fix

A nameless parameter is definitionally **not** a binding pattern — a binding
pattern *is* a name node (`{a}` / `[a]`) — so it takes the ordinary
`resolveWasmType` path every other named non-pattern parameter takes.

This satisfies the issue's own criterion that the underlying `undefined` be
fixed rather than defended against: the predicate is now total over the real AST
shape, and no case silently changes lowering. The TypeScript type is wrong about
optionality, so the cast is deliberate and commented.

## Verification

`tests/issue-4038-jsdoc-nameless-param.test.ts` — passes with the fix, **fails
on the unfixed base**. ESLint's two occurrences are gone.
