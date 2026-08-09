---
id: 3605
title: "Audit: are there further silent-no-op / vacuity cases beyond the three already found?"
status: ready
created: 2026-07-25
updated: 2026-07-25
priority: high
feasibility: medium
model: fable
task_type: investigation
area: codegen, runtime, testing
goal: standalone-mode
sprint: current
horizon: m
related: [3592, 3603, 3468, 3606]
---

# #3605 — audit for further silent-no-op / vacuity cases

## Problem

Three separate mechanisms have been found that make test262 report **pass for tests that
should fail**. Each was hidden behind the previous one, and each was found by accident
rather than by a systematic search:

| #   | Mechanism                                                                                                                                                                                                                                      | Where                                                                                                              | Status                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 1   | Standalone closures cannot carry own properties, so `assert.*` methods were never invoked at all                                                                                                                                               | property dispatch gated on `ref.test $Object`                                                                      | **fixed** — #3468 / PR #3523, ~3,545 vacuous passes removed |
| 2   | Under-applied calls silently return the undefined sentinel, so `assert.sameValue(1,2)` (2 args, 3 formals) does nothing                                                                                                                        | `fillApplyClosure` dispatches on `args.length`; `emitClosureMethodCallExportN` filters `paramTypes.length > arity` | **#3592**, landing                                          |
| 3   | `verifyProperty` is vacuous on **both** lanes — standalone: object literals have no `$Object` own-property table so every runtime MOP query reports zero own properties; host: uncurried `__push` is a silent no-op so `failures.length === 0` | `emitHasOwn` (`object-runtime.ts` ~2630-2677); the uncurryThis family                                              | **#3603**, unfixed                                          |

Plus a fourth, narrower one: a bare top-level `throw` statement was silently dropped in
**both** lanes (`declarations.ts:1522`, a `ctx.wasi` gate) — 40 files, fixed in #3592.

**We do not know how many more there are.** Every fix so far has exposed the next layer,
because the failure mode is indistinguishable from success unless probed deliberately.

## The pattern to hunt

Every instance is the same shape: **a silent `false` / `0` / `undefined` sentinel on a path
that should either succeed or throw.**

- a guard returns `0` instead of raising (`emitHasOwn`: `if (!ref.test $Object) return 0`)
- a dispatcher matches no arm and returns an undefined sentinel instead of erroring
- an append (`__push`) quietly does nothing
- a statement kind is `continue`-d past during collection

None of these surface anywhere. The harness runs to completion and the test scores pass.

## Scope

Find the remaining instances **before** they are discovered one at a time by accident.

1. **Static sweep.** Enumerate every site in `src/codegen/` and `src/runtime/` that returns a
   sentinel (`0` / `undefined` / `null` / a "missing" marker) from a _guard_ or _dispatch_
   arm rather than raising or falling back. Classify each: intended fallback vs. silent
   failure. The three known instances must all appear in the output — if the sweep misses a
   known one, the sweep is wrong, not the code.
2. **Dynamic probe.** Extend the **A/B wrong-expectation control** (see Method) beyond
   `assert.*` and `verifyProperty` to every other harness primitive test262 relies on:
   `compareArray`, `assert.throws` sub-cases, `propertyHelper`'s other exports,
   `deepEqual`, `assertRelativeDateMs`, `testWithTypedArrayConstructors`, the async
   `doneprintHandle` channel, `wellKnownIntrinsicObjects`, `nativeFunctionMatcher`.
   For each: feed a deliberately wrong expectation and confirm it **fails**.
3. **Both lanes, always.** Layer 3 was assumed standalone-only and turned out to affect host
   too by a different mechanism. Never conclude "standalone-only" without running the host
   arm.

## Method — do not invent a new one

**The A/B wrong-expectation control.** Feed the harness a deliberately WRONG expectation and
see whether it still reports pass. Then re-run with the candidate cause force-disabled; if
behaviour is identical in both arms, the vacuity is pre-existing rather than introduced.

Supporting controls that made the earlier work measurable rather than anecdotal:

- **Local-vs-local A/B** — same runner, same process, only the toggle changed. **Never diff a
  local sweep against the committed baseline JSONL**; sharded-CI-worker vs in-process
  differences manufacture phantom deltas (this produced a bogus "+118" once already).
- **Attribution control** — re-run with all instrumentation present but its throws removed.
  If that does not reproduce stock exactly, you are measuring your scaffolding.
- **Calibrate before sampling** — positive control must fire, negative must stay silent, so a
  null result means "nothing there" rather than "detector broken".

### Known detector trap

Do **not** use `Object.keys(desc)` / `getOwnPropertyNames(desc)` as a yardstick in a
standalone detector. On a directly-named module global `Object.keys(DESC).length` is `4`
(compile-time fold); on the **same object** through an `any` parameter it is `0`. A detector
built on it never fires and returns a null result that looks like a clean bill of health.

## Acceptance

- A written inventory of every sentinel-returning guard/dispatch arm, each classified
  intended-fallback vs silent-failure, with the three known instances present.
- Every harness primitive above probed with a wrong expectation on **both** lanes, with the
  result recorded (fires / vacuous) and denominators given.
- Any newly found vacuity filed as its own issue with a minimal repro.
- If the answer is genuinely "no more", say so with the evidence — a negative result here is
  a valid and valuable deliverable.

## Notes

- **Expect any fix to push the measured floor DOWN.** That is correct, not a regression —
  see the landing recipe used for #3468/#3523 and #3592.
- Sizing must be **measured, never extrapolated**. Cluster labels have over-counted actual
  flips by large factors in this project; report real denominators and an honest pass/fail
  split.
- #3606 is the durable counterpart to this issue: this one _finds_ the remaining cases,
  #3606 makes new ones **impossible to introduce silently**.
