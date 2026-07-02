---
id: 3005
title: "Compiler stack-overflow on `(eval as any)()` — cast/parenthesized callee re-wrap recurses infinitely"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: eval
related: [2960]
origin: "2026-07-02 — found while implementing #2960 (dynamic eval / new Function diagnostics, PR #2548); noted but not investigated. Filed as tracked triage."
---

## Problem

Compiling `(eval as any)()` crashes the compiler with an internal
`RangeError: Maximum call stack size exceeded` (infinite recursion), rather
than producing the graceful eval diagnostic that the plain-`eval()` path emits.
The crash is caught by the `#1919` speculative wrapper in
`compileExpression` and surfaced as a (duplicated) diagnostic:

```
error: Internal error compiling expression: Maximum call stack size exceeded
error: Internal error compiling expression: Maximum call stack size exceeded
```

but it is a genuine unbounded-recursion crash in codegen, not an intended error.

## Reproduction

Crashes (both forms):

```ts
(eval as any)();
```

```ts
(eval as any)("1+1");
```

Does **NOT** crash (compiles to an 8-byte module) — the `any`-typed *alias*
form:

```ts
const x: any = eval;
x();          // ok
x("1+1");     // ok
```

So the trigger is specifically the **cast-in-parenthesized-callee** shape
`(eval as any)(...)`, not "eval reached through `any`" in general. (The alias
form goes through the identifier-callee path and never hits the re-wrap loop.)

Run: `npx tsx src/cli.ts <file>.ts`

## Root cause

Captured stack trace (via temporary instrumentation of the catch in
`src/codegen/expressions.ts:757`):

```
RangeError: Maximum call stack size exceeded
    at Object.isOptionalChain (typescript.js)
    at compileCallExpression (src/codegen/expressions/calls.ts:3948:10)
    at compileCallExpression (src/codegen/expressions/calls.ts:4226:14)
    at compileCallExpression (src/codegen/expressions/calls.ts:4226:14)
    at compileCallExpression (src/codegen/expressions/calls.ts:4226:14)
    ... (repeats to stack exhaustion)
```

The parenthesized-callee unwrap in `compileCallExpression`
(`src/codegen/expressions/calls.ts:4186`) unwraps `(eval as any)` to the inner
`AsExpression` (`eval as any`), then — because `AsExpression` is not matched by
any of the special-cased inner shapes (conditional at 4201, comma/binary at
4210, prefix/postfix unary at 4215) — falls through to the generic synthetic-call
path at 4219:

```ts
const syntheticCall = ts.factory.createCallExpression(
  unwrapped as ts.Expression as ts.LeftHandSideExpression, // = `eval as any`, an AsExpression
  expr.typeArguments,
  expr.arguments,
);
...
return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression); // line 4226
```

`AsExpression` is **not** a `LeftHandSideExpression`, so
`ts.factory.createCallExpression` re-wraps the callee in a
`ParenthesizedExpression` to preserve precedence. The synthetic call's callee is
therefore again a `ParenthesizedExpression` wrapping the same `AsExpression`, so
the re-entry at line 4226 hits the exact same 4186 branch and rebuilds an
identical synthetic call — unbounded recursion.

This is precisely the hazard the existing comments at lines 4198-4212 warn
about for conditional / binary / unary callees ("ts.factory ... would re-wrap
them in ParenthesizedExpression, causing infinite recursion") — but
`AsExpression` (and, by the same reasoning, `SatisfiesExpression` and the
old-style `TypeAssertion` `<any>eval`) is missing from that guarded set, so it
falls through to the recursion.

## Suggested direction (not implemented here — triage only)

Handle type-only callee wrappers before the generic synthetic-call path in
`compileCallExpression`: for `ts.isAsExpression` / `ts.isSatisfiesExpression` /
`ts.isTypeAssertionExpression`, strip the type wrapper and recurse on the inner
expression (so `(eval as any)()` becomes `eval()` and reaches the normal eval
special-casing), or route it through `compileExpressionCallee` like the other
non-LeftHandSideExpression callees at 4211/4216. Likely candidates to verify:
`<any>eval()`, `(fn satisfies F)()`, `(obj.m as any)()`.

## Acceptance criteria

- `(eval as any)()` and `(eval as any)("1+1")` compile without a compiler
  crash, producing the same graceful eval diagnostic as bare `eval()`.
- No infinite recursion for other type-wrapped callees:
  `<any>eval()`, `(someFn as any)()`, `(obj.method as any)()`.
- A regression test in `tests/issue-3005.test.ts` covering the cast-callee
  shapes.

## Notes

- Discovered during #2960 (dynamic eval / `new Function` diagnostics, delivered
  via PR #2548). Not blocking that work; filed so it isn't lost.
- The duplicate diagnostic line is a side effect of the `#1919` speculative
  wrapper catching the `RangeError` and re-compiling; the underlying issue is
  the recursion, not the double-report.
