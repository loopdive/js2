---
id: 3955
title: "Standalone: a generator FUNCTION EXPRESSION with a binding-pattern parameter compiles host-free and traps at runtime — no default needed; the function DECLARATION form is correct"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: medium
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: generators, destructuring, default-parameters
es_edition: multi
goal: standalone-mode
umbrella: 3178
related: [3952, 3893, 3386, 3948, 3178]
origin: "2026-08-01: surfaced as the control that justified #3952's fn-expr-host exclusion. The control was meant to show the trap was closure-independent; narrowing it further showed it does not need a default at all."
---

# #3955 — generator function expressions with binding-pattern params trap

## What it is

A generator **function expression** whose parameter is a binding pattern
compiles host-free in the standalone lane and then traps at runtime. The
equivalent function **declaration** is correct.

Measured 2026-08-01, `target: "standalone"`, instantiated with `{}`:

| arm                                                                | result                      |
| ------------------------------------------------------------------ | --------------------------- |
| `const g = function*({ n = 41 }: {n?: number}) {…}` · `g({})`      | **`WebAssembly.Exception`** |
| `const g = function*({ n = 41 }: {n?: number} = {}) {…}` · `g()`   | **`WebAssembly.Exception`** |
| `const g = function*({ n }: {n: number} = {n: 41}) {…}` · `g()`    | **`WebAssembly.Exception`** |
| same, default used before any suspension                           | **`WebAssembly.Exception`** |
| **`function* g({ n = 41 }: {n?: number} = {}) {…}`** (DECLARATION) | **42 ✓**                    |

The third arm is the load-bearing one: it has **no element default at all**, only
a whole-param default. So the variable is neither the default nor the closure —
it is the **function-expression host with a destructured parameter**. Every arm
is host-free, so this is a silent wrong-behaviour trap, not a leak.

## How it was found, and the correction it forced

This began as the **control** for #3952's fn-expr-host exclusion: to show that
lane's trap was closure-_independent_, I ran the same shape with a plain numeric
element default, and it trapped. Narrowing further removed the element default
entirely and it still trapped. The exclusion in #3952 is therefore correct but
under-described in its own comment — it says "element default", and the real
condition is "binding-pattern parameter".

## Sizing — measured, and the honest answer is ZERO corpus rows

Denominator: `language/expressions/generators/*` = **290** standalone rows
(200 pass / 51 fail / 39 compile_error). Of those, **82** carry an element
default (`-init-`):

| bucket                                          |  rows |
| ----------------------------------------------- | ----: |
| standalone `pass`                               |    60 |
| standalone `fail`                               |     6 |
| standalone `compile_error` (still bail to host) |    16 |
| **host-free + standalone-not-pass + host-pass** | **0** |

**So this defect has no measured test262 surface.** The 60 host-free rows in that
lane already pass. Two plausible reasons, both worth checking before anyone
sizes work here:

1. The test262 runner wraps every file in `export function test(){}`, so corpus
   generator function expressions are **nested**, not at module scope inside a
   `const` as in the repro. Nesting may route through a different lowering.
2. The corpus is untyped JS; the repro carries a TS type annotation on the
   pattern (`{n?: number}`), which changes the parameter's wasm rep (struct ref
   vs externref). The typed path may be the broken one.

**Do not quote a row count for this issue.** It is a real soundness bug for
typed-TS users with 0 currently-measured conformance rows — which is exactly the
kind of thing that stays invisible until someone writes that shape.

## Acceptance

- [ ] First, settle which factor is real (nesting vs TS typing) by reproducing at
      module scope, nested, typed and untyped. That is a measurement, not an
      implementation, and it decides whether this is worth fixing now.
- [ ] All four repro arms return 42, host-free.
- [ ] Then re-measure the 8 `*-init-fn-name-{arrow,fn}` rows in this lane that
      #3952 deliberately excluded, and lift `ts.isFunctionExpression(decl)` from
      the bail in `buildNativeGeneratorPlan` — with the pinning test in
      `tests/issue-3952.test.ts` ("generator FUNCTION-EXPRESSION host keeps the
      host path for closure defaults") deleted in the same commit.
- [ ] `prove-emit-identity check` IDENTICAL (lane-shared plan builder).

## Note

Until this is fixed, #3952's exclusion is doing real work: it keeps those 8 rows
on a **loud** host-import leak (a `compile_error` someone can see) instead of a
**silent** runtime trap. That trade is deliberate and should not be reversed
without fixing the underlying trap first.
