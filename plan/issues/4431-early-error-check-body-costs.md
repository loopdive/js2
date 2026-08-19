---
id: 4431
title: "early-error check-body costs — isStrictMode memoization, class private-name cache, hoisted per-visit allocations"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
goal: velocity
loc-budget-allow:
  - src/compiler/early-errors/predicates.ts
  - src/compiler/early-errors/node-checks.ts
---

# #4431 — early-error check-body costs (the ~60% left by #4425)

Follow-up to #4425 (PR #4525, merged): the kind-indexed dispatch removed the
guard-chain overhead (~40% of detect CPU); this issue targets the fired check
BODIES — the larger prize #4425 deliberately left out of scope.

## Measurements (2026-08-15, quiet 4-core box, this session)

Per-block instrumentation (each `on()` registration wrapped with a
`performance.now()` accumulator; 1-in-9 corpus sample = 2,874 files,
in-block total 1,668 ms):

| share | block | cost driver |
| ----- | ----- | ----------- |
| 34.3% | PrivateIdentifier enclosing-class check | `isInsideClassWithPrivateName`: re-scans EVERY member of EVERY enclosing class per private-name reference |
| 14.2% | strict reserved words (every Identifier) | `isStrictMode` ancestor re-walk + `new Set([...7 strings])` allocated per identifier |
| 10.1% | `checkTDZInStatements` (SourceFile/Block/Case/Default) | not addressed here — see open follow-ups |
|  6.7% | `checkVarLexicalConflicts` (Block/SourceFile) | not addressed here — see open follow-ups |
|  ~9%  | other `isStrictMode` consumers (eval/arguments, octal literals, legacy escapes) + static-block walks | ancestor re-walks |

`isStrictMode` is queried by 4 hot blocks (every Identifier ×2, every
String/NumericLiteral in strict scans) plus `duplicates.ts` / `module-rules.ts`
— each call re-walked the full ancestor chain re-scanning directive prologues.

## Fix (this change-set)

1. **`isStrictMode` memoized** (`predicates.ts`): strictness is a pure
   function of the ancestor chain, so cache per node in a `WeakMap` — walk up
   only to the first cached ancestor or terminal (SourceFile / class /
   function with `"use strict"`), then backfill the visited chain. O(1)
   amortized; semantics preserved exactly (module ≠ strict rule untouched).
2. **Class private-name cache** (`predicates.ts`): `WeakMap<ClassLike,
   ReadonlySet<string>>` built once per class; `isInsideClassWithPrivateName`
   consults the set instead of re-scanning members per reference. Heritage-
   clause exclusion (§15.7.14 outer-PrivateEnvironment rule) unchanged.
3. **Hoisted per-visit allocations** (`node-checks.ts`):
   `COMPOUND_ASSIGNMENT_OPS`, `STRICT_RESERVED_WORDS`,
   `STRICT_RESERVED_ASSIGN_TARGETS` moved to module consts (were rebuilt per
   matching node — the reserved-word Set on every identifier in strict code).

## Validation

- Differential (same harness as #4425, corpus 25,862 files = test262
  `language`+`annexB` + `src/**/*.ts`): unmodified HEAD vs optimized —
  23,983 diagnostics each, 0 exceptions, **byte-identical JSONL**.
- Detect CPU A/B (1-in-3 sample = 8,621 files, parse-once/time-detect-only,
  3 iters × 2 interleaved rounds): HEAD ~6.0–6.6 s CPU steady-state →
  optimized ~2.4–2.9 s — **~2.5× faster**. Combined with #4425:
  detectEarlyErrors ~11.9 s → ~2.5 s on this box (**~4.7× total**).
- Early-error suites (issue-4417 / 1931 / 2929 / 3632): 65/67 — the 2
  issue-3632 failures are the standalone `js2wasm:runtime-eval` wasm-import
  environment issue, reproduced identically on unmodified base (pre-existing).
- `pnpm run typecheck` (TS7) clean.

## Open follow-ups (measured, not addressed here)

- `checkTDZInStatements` 10.1% + `checkVarLexicalConflicts` 6.7% +
  `checkDuplicateLexicalDeclarations` 3.0%: each re-collects binding names
  over the same statement lists per scope node. A per-scope collected-names
  cache is the next lever; needs care because these mutate ctx error state.
- `isInsideClassStaticBlock` / `isInsideAsyncFunction` /
  `isInsideGeneratorFunction` ancestor walks (~3.4% combined across the
  await/yield identifier blocks) — same WeakMap pattern would apply.
