---
id: 2982
title: "Tagged-template regression: `strings: string[]` first-param trips a fatal TS2345 (idiomatic tag fns fail to compile)"
status: done
completed: 2026-07-02
assignee: ttraenkler/opus-4
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: m
feasibility: medium
task_type: fix
---

## Problem

11 tagged-template-literal equivalence tests (plus the whole
`tests/issue-141.test.ts` tagged-template suite) fail to compile on clean main.
Surfaced by fable-6 during #2965 validation, framed as a "recent merge-wave
regression."

A tag function declared with an idiomatic first parameter:

```ts
function tag(strings: string[], a: number, b: number): number { ... }
tag`hello ${10} world ${20}`;
```

fails compilation with:

```
Argument of type 'TemplateStringsArray' is not assignable to parameter of type 'string[]'.
```

## Root cause (bisected)

Not a recent-wave regression — **latent since 2026-04-17**. `git bisect`
pinpointed **`d8cfbb7a7` "fix(compiler): fail on incompatible TypeScript
annotations"**, which added TS **2345** to `HARD_TS_DIAG_CODES` in
`src/compiler.ts`. fable-6 merely surfaced it while running the equivalence
suite on a clean base.

A tagged template implicitly passes a `TemplateStringsArray` (ECMA-262 §13.2.8.4
GetTemplateObject — a frozen `ReadonlyArray<string> & { raw }`) as the tag's
first argument. TS rejects assigning that to a **mutable** `string[]` parameter,
so every such call trips TS2345. Before d8cfbb7a7 that diagnostic was non-fatal,
so these programs compiled (as they do at runtime — the tag simply receives an
array of strings). The gate promoted it to a hard error, breaking a runtime-
correct, idiomatic pattern used throughout the corpus.

## Fix

Fix forward (not a test edit — `strings: string[]` is idiomatic, runtime-correct
user code that compiled for months). Added a tightly-scoped false-positive
suppressor `isTaggedTemplateStringsArrayFalsePositive` in `src/compiler.ts`,
wired into `isHardTypeScriptDiagnostic` alongside the existing
`isProxyHandlerTrapDiagnostic` / `isInOperatorOperandDiagnostic` / `#862`
downgrades of "TS stricter than ES runtime semantics."

Downgrades a 2345 to a warning **only** when ALL hold:

1. it sits inside a `TaggedTemplateExpression`;
2. its diagnostic **source type is literally `TemplateStringsArray`** — i.e. the
   synthesized first (template-object) argument, NOT a `${…}` substitution
   argument (TS checks arg0 first and, when `string[]` is annotated, reports that
   and never reaches substitutions; when arg0 is well-typed a substitution error
   surfaces with its own source type, e.g. `string`, and stays fatal); and
3. the resolved first parameter is an array / readonly-array whose element type
   is string-like (`string` / string-literal / `any` / `unknown`) — so
   `number[]` first params stay a hard error.

## Test Results

- `tests/issue-2982.test.ts` (new): 5/5 pass — 3 positive (`string[]`,
  `readonly string[]`, `.raw` access) + 2 negative (`number[]` first param and a
  genuine substitution mismatch both stay fatal TS2345).
- `tests/equivalence/ts-wasm-equivalence.test.ts` "tagged template" subset: 13/13
  pass (previously 11 compile-errors).
- `tests/issue-141.test.ts` tagged-template suite: all pass.

Runtime equivalence (wasm ↔ js) verified — the change only downgrades a
compile-gate false positive; codegen was already lowering these tag calls.
