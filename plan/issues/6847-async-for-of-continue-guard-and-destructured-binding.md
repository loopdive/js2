---
id: 6847
title: "async for-of over an awaiting body: `continue` guards, for-of-only bodies and destructured heads all miscompile — hono `parseSigned` answers `false` for valid signatures"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
# (#6847, 2026-10-05) One call each in the for-of `bindElement` step of
# `planTryCatchCfg` / `buildBody` (the helper is in analysis/async-for-of-region.ts).
func-budget-allow:
  - src/codegen/async-cps.ts::planTryCatchCfg
  - src/codegen/async-cps.ts::buildBody
---

## Problem

hono `src/utils/cookie.test.ts` — eight `parseSigned` rows read `false` where
the cookie value is expected
([#6449](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6449-hono-signed-cookie-verify-returns-false)).
`verifySignature` is fine; the loop that calls it is not:

```js
for (const [key, value] of Object.entries(parse(cookie, name))) {
  const signatureStartPos = value.lastIndexOf(".");
  if (signatureStartPos < 1) { continue; }
  …
  const isVerified = await verifySignature(signature, signedValue, secretKey);
  parsedCookie[key] = isVerified ? signedValue : false;
}
```

Three independent defects in the async CFG for-of region
(`lowerRegionBody` / `planTryCatchCfg`, `src/codegen/async-cps.ts`), measured
on upstream/main `c3e3fab33d` with `.tmp` reductions (`{a:"xy", b:"", c:"z"}`,
`check(v)` = `await null; return v.length > 1`; node answers
`{"a":"xy","c":false}`):

1. **`continue` anywhere in the body** → `asyncForOfBodyHasUnsupportedControl`
   rejects the region, the function falls to the synchronous pass-through, and
   `const ok = await check(v)` binds the Promise (coerced to `false`):
   `{"a":false,"c":false}`.
2. **A body whose only non-linear construct is the for-of** →
   `analyzeTryCatchAsync` requires a group, a conditional or a hoist, so the
   for-of region is built and then thrown away — same pass-through:
   `{"a":false,"b":false,"c":false}`.
3. **A destructured head** (`const [key, value]`) whose names are read in a
   state AFTER a suspension → `ReferenceError: key is not defined`.
   `compileForOfDestructuring` allocates `__tdz_key`/`__tdz_value` flags as
   plain resume-function locals, which reset on every re-entry; the `#4618`
   TDZ cells only cover flags known to the ACTIVATING function.

## Implementation Plan

1. `isLoopContinueGuard(stmt)`: an unlabeled `if (c) continue;` /
   `if (c) { continue; }` with no else. `asyncForOfBodyHasUnsupportedControl`
   skips such a statement when it is a direct child of the loop block.
   `lowerRegionBody(…, inLoopBody)` lowers it, at the loop body's top level
   only, as `if (c) {} else { REST }`: a `conditional` item whose true arm is
   empty and whose false arm is `lowerRegionBody(REST, …, true)` (recursion
   handles a second guard). No synthetic AST — the condition is the original
   expression, and the conditional's join is the loop's existing increment
   state, which is exactly where `continue` goes.
2. `analyzeTryCatchAsync` also admits a region with a top-level `forOf` item.
3. The for-of `bindElement` step deletes the pattern names from
   `fctx.tdzFlagLocals` right after `compileForOfDestructuring`: the head binds
   every name before any body statement runs, in every iteration, so later
   states need no TDZ check (and must not consult a reset local).

Acceptance: the three reductions match node; regression test with a
base-failing row per defect and an anti-vacuity row (the wrong-signature row
still answers `false`); hono `cookie.test.ts` 27/35 → 35/35; standalone
test262 async scope flat.

## Resolution

Implemented as planned (`src/codegen/analysis/async-for-of-region.ts`;
`lowerRegionBody(..., inLoopBody)`, the for-of admission in
`analyzeTryCatchAsync`, `releaseForOfHeadTdzFlags` in the for-of
`bindElement` step). All three reductions match node; regression test
`tests/issue-6847-async-for-of-continue-destructuring.test.ts`. hono
`cookie.test.ts` 27/35 -> 35/35, which closes
[#6449](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6449-hono-signed-cookie-verify-returns-false).
Standalone test262 async scope (429 rows) identical before/after; full A/B in
[#6846](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6846-async-nested-leading-await-replay).
