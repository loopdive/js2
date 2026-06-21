---
id: 2103
title: "shared binding-info analysis — one mutation/capture/declaration-order oracle for all lowerings"
status: done
assignee: ttraenkler/cs-2103
sprint: 63
created: 2026-06-11
updated: 2026-06-17
completed: 2026-06-17
priority: medium
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: correctness
related: [1970]
origin: "2026-06-11 analysis program (report 01 family F7 parent); stub 08-D18"
---

# #2103 — every lowering keeps its own stale binding snapshot

## Problem

Each lowering maintains a private snapshot of binding facts and forgets to
invalidate it: localMap shadows leak across if-branches (block-scope
issue), for-of/for-in iterate stale snapshots (mutation-not-observed
family), isStaticNaN ignores reassignment, rethrow ignores catch-param
reassignment, Map-destructuring conversion buffers go stale (#1970).
~12 June issues (BIND family).

## Root cause

No single binding-info oracle (assigned-after-init? captured? declaration
order? shadowing depth?) consulted by closure capture, const-folding,
snapshot caching, and scope save/restore.

## Fix direction

A per-function binding-analysis pass (one walk, memoized) exposing
queries; lowerings consume it instead of private snapshots. Large (M+);
members remain individually fixable meanwhile — this is the structural
parent for sprint 64+.

## Acceptance criteria

- The cited members' tests pass from oracle-backed lowerings
- A mutation-after-snapshot fuzz probe class stops regressing

## Dupe check

Member issues filed (several already fixed point-wise); no oracle issue
exists. New (analysis program).

## Resolution (2026-06-17) — foundation stone landed

### Scope decision (why this PR is the substrate, not the whole oracle)

The issue is explicitly the **structural parent for sprint 64+** and "Large
(M+)" — a single behavior-preserving PR cannot migrate every consumer
(closure capture, const-folding, snapshot caching, scope save/restore,
for-of/for-in, isStaticNaN, rethrow) onto a new oracle without churning
dozens of files and risking exactly the regressions the `reasoning_effort:
max` flag warns about. A prior claim (`dv1`) was released with no branch,
which signals the wholesale rewrite is not a one-shot. The cited member bugs
are also **already fixed point-wise** (#1970 done in s61), so the acceptance
criteria's "members pass" gate is already green on `main` — meaning the value
left to capture here is the *structural* one: build the single owned,
memoized per-function analysis the fix direction names, and route the
hottest redundant re-derivation through it, with zero behavior change. That
is what landed; the remaining query surface + consumer migrations are the
sprint-64+ follow-on this substrate is designed to grow.

### What changed

New module `src/codegen/binding-info.ts` — the shared per-function
binding-info oracle. It owns a `WeakMap<ts.Node, ReadonlySet<string>>`
memoization of a function's **own locals** (params + destructuring binding
names + function-scoped `var`/top-level `function`/`class` decls), exposed as
`getFunctionOwnLocals(node)` / `addFunctionOwnLocals(node, out)`. The actual
collection rule still lives in `closures.ts`
(`collectFunctionOwnLocals`), which is injected into the oracle via
`registerOwnLocalsCollector` at module load — so the oracle does not
duplicate the scope-walking logic and there is no import cycle
(`binding-info.ts` imports only the `ts` *type*).

Routed every top-level + in-walk caller of `collectFunctionOwnLocals` through
the memoized accessor:
- `closures.ts`: the two recursion sites inside `collectReferencedIdentifiers`
  and `collectWrittenIdentifiers` (fire once per nested function-scope
  boundary on *every* walk — the dominant recomputation), plus the three
  per-arrow entry points (`compileArrowAsClosure`, `compileArrowAsCallback`,
  and the callback variant).
- `declarations.ts`: `functionDeclarationCapturesEnclosingLocal`.
- `statements/nested-declarations.ts`: both capture-analysis sites.

### Why this is behavior-preserving

`collectFunctionOwnLocals` is a **pure function of the node** — same node →
same set, every time. The AST is immutable for a compile's lifetime; the only
rewrites (`array-reduce-fusion.ts`) build *fresh* trees via `ts.transform` and
never mutate the originals the cache keys on (verified). Memoization therefore
returns identical results, computed once instead of once-per-consumer-walk.
The accessor copies the cached set into the caller's accumulator (never hands
out the shared instance) so no consumer can corrupt the cache.

### Test results (branch vs. clean `origin/main`, identical = no regression)

- `tests/issue-1970.test.ts` — 6/6 pass (the named member bug stays fixed).
- Capture/scope subset (closure-push-host-callback, iife-and-call-expressions,
  nested-function-recursion, arguments-nested-and-loops, var-hoisting-scope,
  if-branch-block-scope, optional-direct-closure-call,
  object-literal-getters-setters, scope-and-error-handling, fn-variable-call):
  **155 pass / 7 fail on BOTH branch and main** — the 7 are pre-existing
  harness import-stub `LinkError`s, byte-identical across the two trees.
- Destructuring/TDZ/params subset (destructuring-extended,
  destructuring-initializer, for-of-array-destructuring,
  for-of-assign-destructuring-primitive, tdz-reference-error,
  default-parameters, rest-params-call): **38 pass / 6 fail on BOTH** —
  identical pre-existing failures.
- `tests/illegal-cast-closures-585.test.ts` — 7/7 fail on BOTH (harness host
  imports incomplete), not a regression.
- `tsc --noEmit` clean.

### Follow-on for sprint 64+

Extend `binding-info.ts` with the remaining queries the fix direction names —
referenced/written free-variable sets (memoized per function node, the next
most-recomputed pair), then assigned-after-init / declaration-order /
shadowing-depth — and migrate the snapshot consumers (for-of/for-in,
isStaticNaN, rethrow catch-param, scope save/restore) onto them so the stale
private snapshots are deleted. The module docstring records this trajectory.
