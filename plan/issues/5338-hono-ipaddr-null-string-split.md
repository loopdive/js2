---
id: 5338
title: "hono ipaddr: a compiled string-producing function answers null to the host — `Cannot read properties of null (reading 'split')` (10 tests)"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`src/utils/ipaddr.test.ts` in the hono upstream suite is **4/16**. Ten of the
twelve failures share one first line:

```
TypeError: Cannot read properties of null (reading 'split')
```

`.split` is only ever called on a string. The receiver is `null`, so a compiled
function that should have produced a string handed `null` across the host
boundary. That is the signature of a *silent* value loss — not a trap, not a
validation failure — which is why it survived: nothing in the compiler's own
gates sees a wrong value.

Measured on a clean detached worktree at main `c9a8b48616`
(`git status --porcelain | grep -vc '^??'` = 0). hono overall is 244/324; this
is the single largest bucket in the package.

## Evidence

- `tests/dogfood/report/hono-upstream-suite.json` after
  `node --import tsx tests/dogfood/hono-upstream-suite.mjs`: 10 entries with
  `file: src/utils/ipaddr.test.ts` and the `split` message; `wasmError` is
  non-null on all ten (this is a runtime failure, not a whole-module one).
- The two other ipaddr failures are different buckets and out of scope here.

## Acceptance criteria

1. `src/utils/ipaddr.test.ts` ≥ 14/16 (the ten `split` failures pass; the two
   other buckets may remain).
2. A regression test under `tests/` that **fails on the parent commit and
   passes with the fix**, pinning the *value* (the returned string), with
   untyped `.js` fixtures in a two-file project (`mod.js` + `entry.ts`).
   Include an anti-vacuity control that passes both ways.
3. A/B at one HEAD over all 17 suites, per test file: hono improves, nothing
   else moves. Anchors on clean main `c9a8b48616`: webpack 16/16 · three 17/18
   · clsx 32/32 · cookie 63740/63740 · lodash 53/62 · redux 61/82 · axios
   200/231 · stylelint 108/108 · tailwindcss 13/13 · jsdom 6/6 ·
   styled-components 9/9 · uuid 75/75 · marked 9/30 · moment 10/10 (and
   `compile.validated` 6/6) · prettier 101/151 · jest 329/356 · hono 244/324.
4. All ratchet gates green, including the new required
   `pnpm run check:dogfood-validation`.

## Implementation Plan

1. **Locate the producer, not the consumer.** Read hono's
   `src/utils/ipaddr.ts` (in `tests/dogfood/.hono-upstream-suite/`). The
   `.split` calls sit in `expandIPv6` / `distinctRemoteAddr` / the
   normalisation helpers. Find which *compiled* function's return value the
   failing tests pass into `.split`. Add a one-line host-side `console.log` of
   `typeof` at the boundary if needed — it is a host lane, so that is free.
2. **Reduce with a negative control** via a standalone `.mjs` calling
   `compileAndRunUpstreamModule` (model: `.tmp/markedbisect/globalset.mjs`).
   Sanity-check the harness with a deliberately-false assertion first
   (`native=0/1`). Ablate one ingredient at a time until you have the smallest
   source that returns `null` and the nearest that returns the string.
3. **Dump WAT** (`node --import tsx src/cli.ts <fixture>.ts --wat`) for both
   and diff. Expect one of these known shapes — check each before treating it
   as new:
   - a `drop` + `ref.null extern` tail from a dispatch arm that found no match
     (the `call-tail-dispatch.ts` typed-but-unmatched fall-through, issue
     #5343 — if that is the site, coordinate: fix there once, not twice);
   - an `externref → …` coercion whose guard `ref.test` fails and takes a
     `ref.null` else-arm (#5327's family, `src/codegen/type-coercion.ts`
     ~4290 terminal fallback is `drop` + `pushDefaultValue`);
   - a string built through `__str_concat` / template lowering whose operand
     was `null` because a capture cell was never materialised (#5320/#5323
     family — check `boxedCaptures` before assuming).
4. **Fix at the producer.** Prefer routing the miss to the dynamic ladder over
   inventing a new arm; prefer a subsystem module over growing a god-file
   (`calls.ts`, `type-coercion.ts`, `declarations.ts` are all at their LOC
   ceilings — extract).
5. **Regression test**, then the **A/B** (one suite at a time; re-run alone any
   suite that prints no `admitted` headline or exits non-zero).

Adjacent, do not chase: the four `TextEncoder is not a constructor` failures
elsewhere in hono are a host-shim gap, not codegen.

## Dispatch

Model: **opus**. The producer is unknown and the family has three live
candidates; this needs judgement across codegen subsystems, but the reduction
path is well-trodden.
