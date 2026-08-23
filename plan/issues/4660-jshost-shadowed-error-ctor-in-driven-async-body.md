---
id: 4660
title: "js-host: .constructor on a user-shadowed intrinsic error resolves the intrinsic carrier inside a frame-driven async body"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
related: [4648, 4626]
files:
  - src/codegen/error-ctor-carrier.ts
---

# js-host: `.constructor` resolves the intrinsic inside a driven async body

Split out of #4648 (PR #4801, merged), whose agent isolated this as an
independent fifth root cause and recommended its own issue. It is the last
async-family harness self-test failure in the js-host lane.

Goal context: 100% of `test/harness/` in BOTH lanes. Measured on main
`16eba04e8` with the quickjs provider built: standalone **115/116**, js-host
**102/116**; PRs #4803 and #4801 have since landed (js-host ≈110), #4804 is
queued (≈113).

## Symptom

`test262/test/harness/asyncHelpers-throwsAsync-custom-typeerror.js` fails with
`assert.throwsAsync did not reject a collision of constructor names`: the two
`throwsAsync` calls that must REJECT resolve instead, because
`thrown.constructor` answers the INTRINSIC `TypeError` rather than the test's
local `function TypeError() {}`.

## Discriminator (from #4648, verify before designing)

Both js-host, both under `asyncTest`:

```js
// (a) outer async body WITHOUT any await → e.constructor === TypeError  (CORRECT)
asyncTest(async function () {
  function TypeError() {}
  var e = new TypeError();
  throw new Test262Error("" + (e.constructor === intrinsic));   // false
});

// (b) outer async body WITH an await → e.constructor === intrinsic  (WRONG)
asyncTest(async function () {
  function TypeError() {}
  var e = new TypeError();
  await Promise.reject(e).then(null, function () {});
  // e.constructor === intrinsic → true
});
```

The `await` is the discriminator: it makes the body **frame-driven** (the async
body is split across resume points with locals spilled to a frame).

**Construction is already correct** — `e instanceof intrinsic` is FALSE in (b),
so the shadow guard `errorCtorNameIsUserShadowed` fires and the right
constructor runs. Only the `.constructor` READ resolves the wrong carrier.

## Implementation Plan

1. **Reproduce (b) as a standalone probe first**, js-host lane, before touching
   codegen. Vary: with/without `await`; `.constructor` read before vs after the
   await; the shadowing declaration hoisted vs not. The goal is to pin whether
   the wrong carrier is chosen at the READ site or baked when the local is
   spilled to / restored from the frame.
2. Locate the `.constructor` read path and the carrier precedence in
   `src/codegen/error-ctor-carrier.ts`; compare what it consults in a plain body
   versus a driven body. A driven body's local restore is the prime suspect: if
   the spilled value's static type or carrier tag is recorded from the intrinsic
   family rather than the user fnctor, the read after resume looks it up in the
   wrong table.
3. Fix so the carrier follows the VALUE, not the name-keyed intrinsic family,
   across a resume boundary. Do not special-case `TypeError` or the harness.
4. Check the standalone lane for the same defect (standalone is at 115/116 and
   this test passes there — establish WHY before changing shared code, so the
   fix does not flip it red).

## Acceptance criteria

- `asyncHelpers-throwsAsync-custom-typeerror.js` passes js-host.
- Full js-host harness category improves by exactly this test, no regressions.
- Full standalone harness category unchanged.
- js-host 60-sample and the equivalence gate clean.

## Permanent repro

`test262/test/harness/asyncHelpers-throwsAsync-custom-typeerror.js` (js-host
lane, `tests/test262-runner.ts` `runTest262File(..., undefined)`).
