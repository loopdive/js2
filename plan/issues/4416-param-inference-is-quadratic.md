---
id: 4416
title: "Call-site param inference is quadratic — 4.35x on a 512-function module"
status: done
sprint: 78
created: 2026-08-14
updated: 2026-08-18
completed: 2026-08-14
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: performance
area: codegen
goal: velocity
---

## Problem

`inferParamTypeFromCallSites(ctx, funcName, paramIndex, sourceFile)` walked the
**entire source file** with `forEachChild` looking for calls to one function,
and it is invoked once per (function, parameter) from three call sites
(`codegen/index.ts`, `fnctor-ctor-param-types.ts`, and
`inferImplicitAnyParamType` in its own module).

That is O(functions × params × programSize). Instrumented:

| units | `inferParamTypeFromCallSites` calls | AST nodes visited |
| ----- | ----------------------------------- | ----------------- |
| 32    | 128                                 | 184,448           |
| 128   | 512                                 | 2,949,632         |
| 512   | 2,048                               | **47,187,968**    |

4× the input, 16× the work — textbook quadratic. 47 million node visits for a
61 KB input.

## How it was found

Compile time was measured against input size, warm process, one synthetic unit
= one 2-param function plus one call:

| units | bytes  | ms   | ms/KB | implied exponent |
| ----- | ------ | ---- | ----- | ---------------- |
| 32    | 3,663  | 226  | 63.1  | —                |
| 64    | 7,375  | 385  | 53.5  | 0.77             |
| 128   | 14,940 | 688  | 47.2  | 0.84             |
| 256   | 30,428 | 1930 | 65.0  | **1.49**         |
| 512   | 61,404 | 6041 | 100.8 | **1.65**         |

The tell is `ms/KB`: it falls while the compiler is amortising fixed cost, then
**rises again** past ~128 units. A CPU profile of the 512-unit compile put a
single `visit` in this module at **25.2% of total compile time**, with
TypeScript's `forEachChild`/`visitNode` underneath it accounting for most of
the next 20%.

Fixed cost is not the issue and was ruled out separately: an empty program
compiles in **6.8 ms**, 1% of the 512-unit compile.

## Fix

Build a `Map<calleeName, (CallExpression | NewExpression)[]>` **once per source
file**, cached in a `WeakMap` keyed on the `SourceFile` object.
`inferParamTypeFromCallSites` then iterates its own bucket instead of walking
the program. O(programSize + functions × params).

The node test it replaces was already exactly indexable:

```ts
(ts.isCallExpression(node) || (ctorSitesEnabled && ts.isNewExpression(node))) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === funcName;
```

Only the `ctorSitesEnabled` half stays at the call site, because that is a
runtime flag rather than a property of the node — both kinds are indexed and
`NewExpression`s are filtered on lookup.

Three properties are preserved deliberately:

- **Coverage.** The index is built with the same `forEachChild(sourceFile, …)`
  traversal the old code used, so it sees exactly the same node set.
- **Order.** Buckets keep document order, so the order-dependent
  `agreed` / `conflict` / `sawUnderApplied` accumulation resolves identically.
- **Invalidation.** Keying on the `SourceFile` object means a new program — or
  a rewritten file, e.g. cjs-rewrite — gets a fresh index automatically. There
  is nothing to invalidate and no cross-compile leak.

## Result

| units | before  | after   | speedup   |
| ----- | ------- | ------- | --------- |
| 32    | 226 ms  | 207 ms  | 1.09×     |
| 64    | 385 ms  | 337 ms  | 1.14×     |
| 128   | 688 ms  | 454 ms  | 1.52×     |
| 256   | 1930 ms | 750 ms  | 2.57×     |
| 512   | 6041 ms | 1388 ms | **4.35×** |

The implied exponent drops from **1.65 to 0.89**, and `ms/KB` now falls
monotonically (58.0 → 23.1) instead of turning back up. It is linear.

**Small inputs are unchanged** (test262 bench: 429 ms before and after). A
harness-wrapped test262 file has too few distinct functions for the quadratic
term to dominate, which is exactly why this never showed up in the test262
profile and only appeared once compile time was measured *against input size*.
The win is on real-world code — the same code that measured 51 KB/s in the
self-hosting sweep.

## Verification

22 files covering the param-inference surface (`743`, `3548`, `3961`, `fnctor`,
`param`, `inference`, `ctor-param`, `4155`, `4235`), run on this change and on
`origin/main`: **131 passed / 19 failed on both**, identical. Those 19 are
pre-existing on `origin/main` (`i32-loop-inference` and others).

## Follow-up

The same shape may exist elsewhere — any `inferX(name, …, sourceFile)` that
scans the file per query is a candidate. `inferNumericReturnTypes` and
`inferBindingAwareNumericReturnTypes` in this module take a whole `sourceFile`
and should be checked for the same pattern. Worth a sweep with the same
instrument: measure compile time against input size and look for `ms/KB`
turning back up.
