---
id: 3111
title: "Decompose compileCallExpression — a single 12,210-line function — into ordered call-shape modules"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [1172, 3102, 3105, 3112]
---

# #3111 — Decompose `compileCallExpression` (12,210-line function)

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

`src/codegen/expressions/calls.ts:4190–16400` — `compileCallExpression` is
**12,210 lines**, the largest function in the codebase and growing fast
(calls.ts overall: 15,292 → 17,246 LOC in the 12 days to 2026-07-09; the file
is 17,246 LOC with 200 functions, 134 `ensureLateImport` sites, 65
`ctx.standalone` branches). When #1172 audited it (2026-04-25) it was ~5,800
lines — it has **more than doubled in 10 weeks**.

It is one if-cascade dispatching on call shape (optional chain, RegExp, eval,
dynamic import, super.method, builtin statics — Object/JSON/Math/Number/
String/Date — array methods, `fn.bind().call()`, IIFE, element-access
callee, conditional callee, closure calls, host-callable fallbacks …), each
branch 50–800 lines mixing predicate logic, argument compilation,
late-import registration, and body emission. Consequences: every new builtin
lands another branch here (the growth data proves it); the branch ORDER is
load-bearing and undocumented; and it is the top merge-conflict file among
dev agents.

## Why this is `feasibility: hard` (honest assessment)

Unlike #3104/#3108 (pure motion), branches here share **mutable local state
accumulated earlier in the function** (resolved receiver info, arg-count
locals, memoized type lookups) and interleave `fctx.body` emission with
predicate evaluation (a predicate that compiles a sub-expression to _inspect_
it has already emitted code). A naive per-branch extraction breaks those
data flows. This needs a design pass (fable), then mechanical execution.

## Target structure

```
src/codegen/expressions/calls.ts        — dispatcher: ordered list of
                                          tryCompileXxxCall(ctx, fctx, expr, shared) probes
src/codegen/expressions/call-shapes/
  optional-chain.ts
  eval-dynamic-import.ts
  super-calls.ts
  builtin-statics.ts    (Object/JSON/Math/Number/String/Date statics)
  bind-call-apply.ts
  closure-calls.ts
  host-fallback.ts
  …
```

Contract per shape: `tryCompileXxxCall(...): InnerResult | NOT_THIS_SHAPE`,
with the hard rule **a probe that declines MUST NOT have emitted into
`fctx.body`** (predicate/emit separation). The `shared` parameter carries the
formerly-function-local state, made explicit as a typed
`CallSiteInfo` object built once at the top of the dispatcher.

## Phasing (each phase independently mergeable + identity-proven)

- **Phase 0 — corpus + baseline.** Extend `prove-emit-identity.mjs` corpus
  with a `tests/call-shapes-corpus/` directory: ~40 small probes, one per
  branch family (enumerate by reading the cascade top-down). Golden baseline.
- **Phase 1 — peel from the TAIL.** The last branches in the cascade
  (fallback paths) have the fewest state dependencies (everything before them
  declined). Extract bottom-up: last branch → module; the cascade calls it.
  `check` IDENTICAL per branch.
- **Phase 2 — peel self-contained heads.** Branches that already start with a
  cheap syntactic predicate and locally compute everything (e.g. the
  `Math.*`/`JSON.*` static families — several already delegate to
  `compileMathCall`/`tryEmitJsonStringifyPrimitive`) move next.
- **Phase 3 — shared-state extraction.** Introduce `CallSiteInfo` for the
  remaining entangled middle; move state reads onto it one field at a time.
- **Phase 4 — enforce.** Add the per-function LOC ceiling for
  `compileCallExpression` (#3102 slice 2) so the cascade cannot regrow.

Any branch that cannot be extracted without changing emission order gets
LEFT IN PLACE and documented — partial completion is acceptable; the
dispatcher-with-modules shape is the goal, not 100% extraction.

## Safety story

`prove-emit-identity` per extracted branch, over the extended corpus, all
targets. Additionally scoped vitest: `tests/` has extensive per-builtin
call tests. Risk concentrates in Phase 3; Phases 0–2 are provable motion.
If any phase can't prove identity, it stops there and re-plans — earlier
phases still deliver value.

## Estimated LOC delta

Net ≈ 0 (motion) − duplicate throw-guard/arg-coercion scaffolds (calls.ts has
1,261 duplicated-window lines; ×17 throw-guard idiom → #3105 builders) ≈
**−600 to −1,000**; `compileCallExpression` 12,210 → dispatcher < 800.

## Acceptance criteria

1. IDENTICAL identity proof per extraction commit (extended corpus).
2. `compileCallExpression` < 2,000 lines (stretch: < 800).
3. Probe contract documented + enforced (decline ⇒ no emission) — add a
   debug assertion on `fctx.body.length` around probes in dev builds.
4. No test262 regression on any shard.
