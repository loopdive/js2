---
id: 3722
title: "Fix: await-as-label early-error false positive on `cond ? await x() : y` ternaries"
status: done
sprint: 77
created: 2026-07-27
updated: 2026-07-30
completed: 2026-07-27
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: checker
language_feature: async-await
goal: core-semantics
origin: "found re-testing marked (#3715/#3716) with skipSemanticDiagnostics to see if it unblocks the same way #3717 unblocked acorn"
related: [3715, 3716, 3717, 1068]
loc-budget-allow:
  # The isInTernary guard mirrors the existing yield-as-label check +10 LOC
  # to src/compiler/early-errors/node-checks.ts's baseline (1866 -> 1876).
  # Same file, same kind of grant as #3714's brand-check fix.
  - src/compiler/early-errors/node-checks.ts
func-budget-allow:
  # Same +10 LOC lands inside runNodeChecks itself (1785 -> 1795) since the
  # await-as-label check is one branch inside that single dispatch function.
  - src/compiler/early-errors/node-checks.ts::runNodeChecks
---

# #3722 — `cond ? await x() : y` false-flagged as `await:` label

## How this was found

Re-tested `marked@18.0.2` after #3717 (acorn's `skipSemanticDiagnostics`
fix). Marked is still blocked by #3715 (evolving array types) under normal
compilation, but compiling with `skipSemanticDiagnostics: true` (to see if
it would unblock the same way it did for acorn) surfaced a DIFFERENT,
real, previously-invisible bug: 5 diagnostics, all
`'await' is not allowed as a label identifier in this context`, all
pointing at the same construct.

## Root cause

`src/compiler/early-errors/node-checks.ts` — the await-as-label check
(originally added for #1068, which correctly allows `await:` as a real
label in *non*-async functions) flags any `AwaitExpression` immediately
followed by `:` while inside an async function, **without excluding the
case where that colon is a ternary's separator**, not a label colon:

```js
i.hooks ? await i.hooks.preprocess(n) : n
//                                    ^ this colon — misread as a label colon
```

The sibling check for `yield` (same file, ~200 lines below) already has
exactly this exclusion (`isInTernary`, checking whether the node's parent
is a `ConditionalExpression`) — it was added there but never backported to
`await`'s copy of the same check. A clear copy-paste divergence.

Confirmed with exact source positions from marked's bundle — all 5 hits
are `cond ? await obj.method(...) : fallback` shapes (e.g. `lib/marked.esm.js`
line 75: `i.hooks?await i.hooks.preprocess(n):n`, `...await i.hooks.provideLexer(e):e?x.lex:x.lexInline`, etc.), each a legitimate async/sync
dual-path pattern.

## Fix

Mirror the `yield` check's `isInTernary` guard onto the `await` check
(`src/compiler/early-errors/node-checks.ts`, the "Also check await: label
pattern" block): don't flag if the `AwaitExpression`'s parent (or
grandparent through one layer of parens) is a `ConditionalExpression`.

## Verification

- New test `tests/issue-3722-await-ternary-label-false-positive.test.ts`
  (4 cases): ternary-with-await true/false branches execute correctly, a
  member/call-chain shape (closer to marked's real code) compiles, and a
  genuine `await:` label inside an async function (no ternary) is still
  correctly rejected as an error.
- Re-ran `mustache`-adjacent (`tests/issue-1068.test.ts`,
  `tests/labeled-loops.test.ts`, `tests/issue-2877.test.ts`) — no
  regressions; pre-existing failures in `issue-2877`/`labeled-loops`
  confirmed identical with the fix stashed out (unrelated: an IR
  `SyntaxError` class gap and a `string_constants` import-wiring
  environment issue, respectively).
- Does **not** unblock marked's normal (non-`skipSemanticDiagnostics`)
  compile — #3715 (evolving array types) still gates it earlier in the
  pipeline. This fix only becomes externally visible once #3715 lands (or
  when `skipSemanticDiagnostics: true` is used), but is a real, standalone
  bug independent of that.

## Acceptance criteria

- [x] `cond ? await x() : y` inside an async function compiles and runs
      correctly for both branches.
- [x] A genuine `await:` label (no ternary) inside an async function is
      still rejected.
- [x] No regressions in existing await/yield/label test suites.
