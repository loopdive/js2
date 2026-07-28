---
id: 3725
title: "Speculative rollback discards deliberate compile-time REFUSALS — a refusal becomes a runtime trap"
loc-budget-allow:
  # The sticky-refusal marker plus the comment explaining WHY the #1599 refusal
  # must survive rollback (a swallowed refusal compiled to a trapping module).
  - src/codegen/expressions.ts
  - src/codegen/expressions/call-namespace-static.ts
  # The `sticky?: true` field on CodegenError plus the doc-comment stating the
  # opt-in rule (refusal sites only, never a probe's failure). The flag has to
  # live on the diagnostic interface, which is what this file declares.
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
status: in-progress
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: standalone-gap
related: [1919, 1921, 1599, 1539, 2508, 1712, 3724]
---

# #3725 — a speculative rollback erases refusals, turning them into runtime traps

## Problem

`rollbackSpeculative` (#1919) unwinds a speculative compile: body, locals, late
imports — and `ctx.errors`. Discarding diagnostics is right for a genuine
**probe** (one of several candidate lowerings; a failure just means "not this
one"). But the backend's **refusal** idiom is the same two lines:

```ts
reportError(ctx, expr, "Codegen error: … not supported in --target standalone/wasi (#1599)");
return null;
```

and `return null` is indistinguishable from a probe miss at
`compileExpression`'s transactional wrapper. So the fatal diagnostic was
truncated away and `pushDefaultValue` substituted a value in its place.

The result is the **opposite** of the refusal, and strictly worse than it:

```ts
export function f(): string {
  const a: number[] = [1, 2, 3];
  return JSON.stringify(a);
}
```

`--target standalone` → `success: true`, **0 errors**, 46 KB binary, **0
imports** … and every call traps with `dereferencing a null pointer`. The
compiler refused, then discarded its own refusal and emitted a trap.

This also defeats #1921's contract, which states that the compile-failure gate
keys on `severity`, and that an omitted severity is treated as `"error"` "so a
forgotten classification fails loudly instead of silently degrading".

## What is fixed here (narrow)

`CodegenError.sticky` — an opt-in marker that survives the rollback.
`rollbackSpeculative` keeps sticky diagnostics and drops everything else, so
probe noise still vanishes with the emission it described.

Applied to the #1599 standalone/WASI JSON refusal only. Pinned by
`tests/issue-1599-json-standalone-refuse.test.ts` (3 cases, previously failing
on `main`).

## Why NOT "retain every fatal diagnostic" (the real finding)

The obvious fix — keep all `severity: "error"` diagnostics across rollback —
was implemented and measured first. It fixes #1599, and it also **fails two
suites that are green today**:

| suite                                                 | what surfaces                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `tests/issue-1712-standalone.test.ts`                 | **60** `#1539 Phase 2a` standalone-RegExp refusals inside compiled Acorn |
| `tests/issue-2508-standalone-anyarray-search.test.ts` | `indexOf: failed to bind element equality helper`                        |

That is the finding worth recording: **the compiled-Acorn standalone
acceptance module passes today partly because 60 deliberate RegExp refusals are
being silently discarded** and replaced with fallback values. `#2508` is the
same shape — its assertion (`r < -1 ? 99 : 0`) is weak enough to pass against a
substituted default.

So the swallow is load-bearing for currently-green gates, and removing it
wholesale is its own remediation project, not a side effect of a bug fix.

## Scope (remaining)

- [ ] Audit every `reportError(...); return null` site and classify it:
      deliberate refusal (`sticky`), deliberate degrade (`severity: "degrade"`,
      per #1921's own rule that a degrade site must cite a tracking issue), or
      genuine probe (leave as-is).
- [x] `#1539` — **RESOLVED by #3724.** They were neither: the gate was refusing
      work the lane already did (`emitRegexSearchCall` already routes every
      subject through `__extern_toString`, so the ToString `re.test(x)` needs was
      already running). Widening the argument gate took the compiled-Acorn
      refusal count from ~60 to **0**, after which the remaining `#1539`
      refusals were marked `sticky` — so this whole bucket is now honest.
- [ ] `#2508` — `ensureExternStrictEqHelper` returns undefined for the
      string-element `any[]` case; that branch reads as an internal failure, not
      an intended degrade. Fix the helper or reclassify the site.
- [ ] Once the audit lands, flip the default: retain fatal diagnostics across
      rollback and make `sticky` unnecessary.

## Acceptance criteria

- [x] The #1599 repro above fails to compile instead of emitting a trapping
      module.
- [x] No currently-green suite regresses (`#1712` / `#2508` verified).
- [ ] Every `reportError + return null` site is classified.
- [ ] Fatal diagnostics survive rollback by default.
