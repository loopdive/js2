---
id: 3384
title: "standalone/wasi: member access on a wrapped JSON.parse() call crashes codegen"
status: done
completed: 2026-07-17
assignee: dev-2961
sprint: current
created: 2026-07-17
updated: 2026-07-17
priority: medium
horizon: s
feasibility: easy
task_type: bug
area: codegen
language_feature: json
goal: standalone-mode
related: [2961]
origin: "2026-07-17 found while sweeping #2961 enumeration: JSON.parse('{...}') member-access under --target standalone hard-crashes codegen."
---

# #3384 — member access on a wrapped `JSON.parse()` call crashes codegen (standalone/wasi)

## Problem

Under `--target standalone` (and `--target wasi`), a property/element access
directly on a `JSON.parse(<literal>)` call whose call node is wrapped in a
**transparent expression** (`as any`, parentheses, `!`) hard-crashes codegen:

```ts
export function test(): number {
  return (JSON.parse('{"a":5}') as any).a; // Internal error compiling expression:
  // Cannot read properties of undefined (reading '0')
}
```

The `as any` (or parens, or `!`) is the trigger — `const o = JSON.parse(...); o.a`
and a bare `JSON.parse(...)` call both compile fine, and `--target gc` is
unaffected (the static-fold path is standalone/wasi-only).

## Root cause

`tryEmitJsonParsePropertyAccess` / `tryEmitJsonParseElementAccess`
(`src/codegen/json-standalone.ts`) guard with
`isJsonParseCall(expr.expression)`, then read
`expr.expression.arguments[0]`. But `isJsonParseCall` **unwraps transparent
expressions internally** (`unwrapTransparentExpression`: parens / `as` /
type-assertion / `satisfies` / `!`) and carries a type predicate
`expr is ts.CallExpression`. So when the call is wrapped
(`(JSON.parse(s) as any).a`), the guard passes while `expr.expression` is still
the `AsExpression` — which has **no `.arguments` field**. Reading
`expr.expression.arguments[0]` is `undefined[0]` → `TypeError: Cannot read
properties of undefined (reading '0')`, caught by the speculative-compile
wrapper and surfaced as `Internal error compiling expression`. The predicate is
sound in the type system but **lies at runtime**.

## Fix

Unwrap `expr.expression` to the real `CallExpression` **before** reading
`.arguments`, in both `tryEmitJsonParsePropertyAccess` and
`tryEmitJsonParseElementAccess`:

```ts
const call = unwrapTransparentExpression(expr.expression);
if (!(ctx.standalone || ctx.wasi) || !isJsonParseCall(call)) return undefined;
const value = parsedJsonLiteral(ctx, call.arguments[0]!);
```

`isJsonParseCall` is now always passed an already-unwrapped node, so its
predicate is sound in practice.

## Acceptance criteria

- `(JSON.parse('{"a":5}') as any).a` (and parens / `!` / element-access
  variants) compile under `--target standalone` and `--target wasi` with no
  internal error, statically folding to the correct value, host-free (empty
  imports).
- `--target gc` and the assigned-then-accessed forms remain unaffected.

## Test Results

`tests/issue-3384.test.ts` — property/element access on wrapped `JSON.parse`
(as/parens/`!`), object and array, standalone + wasi, each instantiates with an
empty import object and returns the statically-folded value. All pass.
