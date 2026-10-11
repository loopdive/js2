---
id: 6884
title: "Class-method host bridge passes host MIRRORS of its arguments into the compiled callee (Temporal `__digit is not a function`, 27 test262 rows after #6511)"
status: done
sprint: current
created: 2026-10-07
updated: 2026-10-07
completed: 2026-10-07
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: core-semantics
related: [6511, 6848, 5237, 5222]
---

## Problem

PR #6511 (hono async/array-callback fixes) merged over a bot park-hold; its
`merge_group` run 37399097173 reported 36 test262 `pass → fail` rows plus one
`null_deref` trap-category growth. Bisected and measured locally WITH the CI
Temporal provider (`scripts/run-test262-paths.mts`, which builds the same
compile-once provider the shards prewarm; one `JS2WASM_TEMPORAL_CACHE` per
compiler state, because the provider cache is keyed on the polyfill source,
not the compiler).

**None of the 36 rows was broken by #6511. Every one of them was a false
pass that #6511 made honest.** Breakdown:

| rows | what #6511 changed | real cause (pre-existing on the parent, measured) |
| ---: | --- | --- |
| 27 | #6848 made `expected.forEach(([unit, …]) => { … })` run its callback (tuple-element vec + callback capturing a host ambient → the native lane declines; the decline used to drop the call silently, so no assertion ever ran) | **this issue** — `__digit is not a function` |
| 1 | same (#6848, `PlainDate/from/limits.js` inner `forEach`) | array literal `[obj, obj, "str", "str"]` (identifier object first) stores the strings as `null` — #6885 |
| 1 | same (`PlainDateTime/…/roundingmode-halfexpand-is-default.js`) | spread call with a trailing argument, `f(...arr, "desc")`, mis-slots the arguments — #6886 |
| 3 | same (`Duration/{compare,round,total}/relativeto-string-invalid.js`) | the pinned `@js-temporal/polyfill@0.5.1` itself accepts `2025-01-01T00:00:00+00:0000` (checked in plain Node with the polyfill) — not a compiler bug |
| 2 | #6847 made `for (const v of …) { await assert.throwsAsync(…) }` actually await (it was an identity before, so the async test finished before any rejection) | object literal `{ [Symbol.iterator]: v }` reaches the host without its symbol key, so `Array.fromAsync` treats it as array-like and resolves — #6887 |
| 2 | nothing (`Iterator/prototype/includes/*`) | host environment: no compiler code involved; the same run flipped the sibling `next-method-returns-non-object.js` fail → pass, the signature of the host `Iterator.prototype.includes` changing, not codegen. Parent and merge are byte-identical locally (both fail on Node 22) |
| (trap) | nothing (`computed-property-names/object/method/number.js`) | traps identically on the parent locally (baseline status was already `fail`) |

Vacuity was measured, not inferred: on the parent, a copy of
`Duration/prototype/round/roundingmode-ceil.js` with
`throw new Test262Error("callback ran")` as the first statement of the
`forEach` callback still PASSES; a copy of `limits.js` that logs from both
callbacks shows the outer one running and the inner one never running.

### The bug fixed here

The Temporal polyfill's `nudgeToDayOrTime` does `d.subtract(c)` with `c`, `d`
untyped `TimeDuration`s. Many polyfill classes declare `subtract`, so the call
is a dynamic `__extern_method_call`, which wraps every argument for host
visibility (`_wrapForHost`: a compiled struct becomes a Proxy) and then
dispatches to the compiled class-method host bridge
(`src/runtime/class-method-host-bridge.ts`). The bridge strips a mirror off
the RECEIVER (#5237) but forwarded the ARGUMENTS as-is into
`__class_call_subtract_1`. Inside the compiled callee `t` was therefore the
Proxy: `t instanceof TimeDuration` was false and `t.totalNs` was read through
the host mirror, which handed JSBI a carrier without its class members →
`TypeError: __digit is not a function` in `JSBI.__absoluteCompare`.

Reduced to plain JS in `tests/fixtures/issue-6884/entry.js` (no Temporal):
parent answers `THROW TypeError: __digit is not a function`, Node answers
`true:5`.

## Implementation Plan

1. `src/runtime/class-method-host-bridge.ts`: add `unwrapBridgeArgs(args, deps,
   callbackState)` and apply it in all three compiled bridges
   (`classMethodHostBridge`, `externrefClassMethodHostBridge`,
   `externrefClassVarargHostBridge`) — each forwards host values straight
   into a compiled `__class_call_*` export, so each must receive raw carriers,
   exactly as the receiver already does.
2. Unwrap with the bridge's OWN module as the reader
   (`deps.unwrapReceiver(value, callbackState)` → `_unwrapForHost(value,
   reader)`), so the #5222 linked-provider rule still holds: a mirror minted by
   a different module across a provider seam is kept intact (the callee could
   not decode the foreign struct).
3. `src/runtime.ts`: thread the optional reader through the existing
   `unwrapReceiver` dep (one-line change, no growth — the file is at its #4401
   ceiling).
4. Regression test `tests/issue-6884-class-bridge-arg-unwrap.test.ts`: fails
   on the parent, passes with the fix; asserts the shape really imports
   `__extern_method_call` (anti-vacuity) and carries a statically-resolved
   control.

Acceptance: the 27 `__digit` rows pass with the CI Temporal provider; no
bridge/provider test regresses; npm suites unchanged.

## Resolution

Implemented as planned (`src/runtime/class-method-host-bridge.ts`
`unwrapBridgeArgs`, applied in all three compiled bridges; `src/runtime.ts`
threads the bridge's own module as the `_unwrapForHost` reader). JS-host
runtime only — no codegen and no standalone surface touched.

Measured 2026-10-07 on upstream/main `75252327a4`, base vs fix, same HEAD,
JS-host lane, CI Temporal provider built per compiler state:

- **The 36 #6511 rows** (`scripts/run-test262-paths.mts`): base 0/36 → fix
  27/36. The 27 are every `__digit` row. The other 9 are the residuals in the
  table above (#6885, #6886, #6887, the polyfill limitation, the host
  `Iterator.prototype.includes` environment rows).
- **Wider sample**, 1,977 rows (`Temporal/Duration/**`,
  `Temporal/PlainDateTime/prototype/**`, `Temporal/PlainDate/prototype/**`,
  `language/statements/class/{subclass,method}/**`, `Map/prototype/**`),
  shuffled, streamed one row at a time: base 1,435 pass → fix 1,506 pass,
  **+71 fail → pass, 0 pass → non-pass**. The 44 gains beyond the 27 are
  pre-existing failures with the same mechanism (`since`/`until`/`round`
  rounding-increment, bubble-time-unit, near-minimum-date rows).
- **npm suites** (`tests/dogfood/<pkg>-upstream-suite.mjs`), base = fix for
  all eleven: prettier 111/151, hono 294/324, redux 76/82, lodash 60/62,
  axios 219/231, jest 344/356, marked 18/30, uuid 75/75, clsx 32/32,
  cookie 63740/63740, moment 10/10.
- Bridge/provider vitest files (38, every test file naming the bridge or the
  #5222/#5225/#5237/#5373/#5204 seams, plus #6848/#6450): 9 failures, the
  SAME 9 on base (pre-existing, unrelated).
