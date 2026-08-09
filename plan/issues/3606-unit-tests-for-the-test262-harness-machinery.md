---
id: 3606
title: "Unit-test the test262 harness machinery itself — assertions must FAIL when they should"
status: ready
created: 2026-07-25
updated: 2026-07-25
priority: high
feasibility: medium
model: opus
task_type: testing
area: testing, runtime
goal: standalone-mode
sprint: current
horizon: m
related: [3605, 3592, 3603, 3468, 3008]
---

# #3606 — unit-test the code that does the testing

## Problem

test262's harness (`assert.js`, `propertyHelper.js`, `compareArray.js`, …) is **compiled by
our compiler and executed as our output**. It is the instrument every conformance number is
measured with — and **nothing tests the instrument**.

We currently verify that tests _pass_. We never verify that they _can fail_. Three separate
mechanisms have now been found that silently disabled the assertion machinery:

1. `assert.*` methods never invoked at all — standalone closures could not carry own
   properties (#3468, fixed, ~3,545 vacuous passes).
2. Under-applied calls silently return the undefined sentinel, so `assert.sameValue(1,2)`
   does nothing while `assert.sameValue(1,2,"msg")` throws correctly (#3592, ~18.9% of
   sampled standalone passes).
3. `verifyProperty` vacuous on **both** lanes, by two unrelated causes (#3603, unfixed).

**Every one of these would have been caught within minutes by a test asserting "a wrong
expectation must throw".** Instead each was found by accident, months apart, after inflating
the published conformance number.

This is the same disease as the "vacuous / stale / invisible test outside required checks"
family (#3558, #3552, #3008) — but one level deeper: the _test harness_ is the thing that
rotted.

## Scope

A vitest suite that compiles the **real** test262 harness through the **real** compiler and
asserts, for every assertion primitive, that it **fails on wrong input** — on **both** the
js-host and standalone lanes.

### Required cases (each must FAIL; a pass is a bug)

- `assert(false)`
- `assert.sameValue(1, 2)` — **2 args, no message**. This exact shape is what #3592 exposed;
  it must be tested _separately_ from the 3-arg form, which already worked.
- `assert.sameValue(1, 2, "msg")` — 3 args
- `assert.notSameValue(1, 1)`
- `assert.throws(TypeError, function () {})` — throws nothing
- `assert.throws(TypeError, function () { throw new RangeError(); })` — wrong error type
- `assert.compareArray([1,2], [1,3])`
- `verifyProperty(obj, key, {value: <wrong>})` and independently wrong `writable`,
  `enumerable`, `configurable` — **all four attributes separately**, because #3603 showed the
  a1 (own-property-exists) gate can be live while all four descriptor checks are dead
- a bare top-level `throw new Test262Error("x")` — must FAIL (the #3592 RC1 bug)
- the async channel: a rejected/failed async test must FAIL, not time out into a pass

### Also assert the positive direction

Correct expectations must still **pass** — otherwise the suite is satisfied by a harness that
throws unconditionally, which is the opposite failure and equally useless.

### Both lanes, always

#3603's host root cause was found only because someone ran the host arm on a bug everyone
assumed was standalone-only. Any lane-specific expectation must be justified in a comment.

## Make it load-bearing

- Add the suite to `tests/guard-suite.json` so it runs in the required gate. The #3008 gate
  only runs PR-_touched_ root tests, which is exactly why the previous guard tests rotted
  invisibly for five days.
- Where a case is known-broken today (e.g. the #3603 `verifyProperty` attributes), pin it as
  an explicit **KNOWN-OPEN** assertion — assert the _current wrong_ behaviour with a pointer
  to the owning issue — so the real fix flips it **loudly** instead of silently. This
  convention is already used in the #3594 static-super tests.

## Acceptance

- Suite exists, runs both lanes, and is in `guard-suite.json`.
- Introducing any of the three known historical bugs makes it fail. **Verify this by
  actually reverting each fix** — a test that passes with and without the fix is decoration.
  (This is the same load-bearing check used on the #3595 trap-ratchet tests.)
- Every KNOWN-OPEN pin cites its issue.

## Why this is worth doing now

The conformance numbers are the project's headline metric and the basis for prioritisation
decisions. Both the standalone and host figures are currently overstated — and were for
months — because the measuring instrument was broken and nothing watched it. This suite is
the cheapest possible guarantee that the next such bug is caught on the PR that introduces
it, rather than after it has silently inflated the published number.

#3605 is the complementary issue: it _finds_ the remaining vacuity cases; this one makes new
ones impossible to introduce silently.
