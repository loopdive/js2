---
id: 5338
title: "hono ipaddr: a compiled string-producing function answers null to the host — `Cannot read properties of null (reading 'split')` (10 tests)"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-06
completed: 2026-09-06
assignee: ttraenkler/senior-dev
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-06 — both mechanisms live in NEW modules
# (src/codegen/tagged-template-arguments.ts, src/codegen/template-raw-dynamic.ts).
# What lands in the two god-files is only what cannot leave them: the four
# per-arm call sites inside `compileTaggedTemplateExpression` (+48) and the
# dispatch hook in `tryNamespaceConstantAndSymbolReads` (+8, which stays at
# 235 LOC — under the 300-LOC function ceiling, so it needs no func grant).
loc-budget-allow:
  - src/codegen/string-ops.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - "src/codegen/string-ops.ts::compileTaggedTemplateExpression"
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

## Implementation Notes (2026-09-06)

### All three candidates in the plan were wrong, and so was the premise

The plan assumed a compiled function ANSWERED null. It did not. The null was a
**test argument**, and the reason it existed at all is that the harness's
`test.each\`table\`` helper had silently fallen back to a different case list.

`__upstreamEach` (in `UPSTREAM_TEST_SHIM`, shared by every dogfood suite) gates
the tagged-template table path on

```js
Array.isArray(cases) && cases.raw && values.length > 0
```

with `values = Array.prototype.slice.call(arguments, 1)`. In the Wasm lane
`cases.raw` was `undefined` and `values.length` was `0`, so the gate failed and
`sourceCases = cases` — **the template STRINGS array**. `test.each` then
registered one test per template chunk and called each body with a *string*.
Destructuring `({ input, expected })` from a string yields nullish, and
`convertIPv4ToBinary(null)` reaches `null.split('.')`. The `.split` receiver
being null is three layers downstream of the defect.

Two independent compiler bugs produced that:

1. **Tagged-template substitutions were never passed as arguments.**
   `compileTaggedTemplateExpression` (`src/codegen/string-ops.ts`) marshalled at
   most `declaredParams - 1` substitutions into positional slots and dropped the
   rest — it did not even COMPILE them, so their side effects were lost too. A
   tag reading `arguments` saw `arguments.length === 1`. Fixed in all four
   non-host-bridge arms via the existing `__argc` / `__extras_argv` protocol
   (`src/codegen/tagged-template-arguments.ts`).
2. **`strings.raw` was unreadable for an ordinary named tag.** The template vec
   struct's third field is `raw`, but `tryNamespaceConstantAndSymbolReads` only
   read it when the receiver could be typed statically — a vec-typed slot, or
   the first parameter of an INLINE tag (`` ((s) => s.raw)`x` ``). A named tag's
   parameter is a plain `externref`, so the read fell through to `__extern_get`,
   and the JS-host `__extern_get` cannot index a WasmGC struct: `undefined`.
   (Standalone's NATIVE `__extern_get` already has a template-vec `raw` arm —
   `object-runtime-template-raw.ts` — so only the host lane was blind, which is
   why this never showed up in a standalone measurement.)
   Fixed by a runtime discriminator in
   `src/codegen/template-raw-dynamic.ts`: `ref.test` the template-vec type, read
   field 2 on a hit, and fall through to the ORIGINAL `__extern_get` on a miss —
   so an ordinary object that really carries a `raw` property (marked's tokens)
   is untouched.

Ruled out by measurement, not by argument: #5343's typed-but-unmatched
fall-through (already merged, hono unchanged), the `type-coercion.ts` terminal
`ref.null` fallback, and the capture-cell families (#5320/#5323/#5333) — the
reduced repro needs no captures, no conditionals and no dispatch miss, just a
tagged template and a tag that reads `arguments`.

### Why publication is unconditional on the dynamic arms

Where the callee is statically known (`ctx.funcMap` by name) the extras are
published only when `ctx.funcUsesArguments` says the body reads `arguments`.
Where the tag is resolved at RUNTIME (`` obj.tag`…` `` — hono's own spelling) no
such proof exists, so the arms publish unconditionally and RESET `__argc` /
`__extras_argv` to their sentinels after the call (the #2704 discipline).
Without the reset, a callee that ignored the extras would leak them into the
next `arguments`-reading call, whose own call site would not have set them.

### Result, and the residual that is NOT this issue

hono `src/utils/ipaddr.test.ts`: **4/16 → 13/16**; the package 220/324 →
229/324 (this HEAD's baseline is 220, not the 244 quoted in the acceptance
criteria — main moved between the two measurements).

All ten `Cannot read properties of null (reading 'split')` failures are gone.
AC1 asked for ≥14/16 and this is 13/16, because the pre-fix per-test labels in
the report were **not trustworthy**: the Wasm lane registered a different NUMBER
of tests than the native lane (each `test.each` expanded to one test per
template chunk), so the index-keyed report mislabelled everything after the
first each-block. The three residual failures are all one distinct defect,
filed as **#5361**: `splice` with a SPREAD argument inserts the spread source as
a single element, which `expandIPv6('::ffff:127.0.0.1')` hits on its
IPv4-mapped branch. Verified independent — it reproduces byte-identically with
this change reverted.

Two further defects observed during reduction, neither introduced here (both
reproduce on the parent) and both left alone:

- a tag reached through a PROPERTY in a module with no signature-matching
  registered closure compiles to the `__tagged_template` host bridge, which
  hands the raw closure carrier to JS — `TypeError: tag is not a function`;
- an arrow tag with a `...rest` parameter answers `undefined` (Case 1
  deliberately declines it and the generic arms mis-marshal the rest vec).
