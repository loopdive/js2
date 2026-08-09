---
id: 3726
title: "Standalone suites red on main: assertions pinned to superseded mechanisms and a snapshot of a ratcheting metric"
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
area: testing
language_feature: n/a
goal: standalone-gap
related: [681, 1320, 2879, 2889, 3592]
---

# #3726 — two standalone suites asserted mechanisms, not invariants

Both were failing on `upstream/main` itself, unnoticed, because neither sits in
a required check.

## #2879 — a snapshot ceiling on a deliberately ratcheting metric

`tests/issue-2879-standalone-host-free-floor.test.ts` asserted
`mark.pass < 20000`. That ceiling encoded the moment #2879 landed: it separated
the honest host-free count (~12.9k) from the leaky raw one (~26k).

But the high-water mark **ratchets up** by design, so every legitimate
improvement walked toward the ceiling — and #3592's measured
post-de-vacuification re-raise to **22,626** crossed it. Committed on `main`,
red on `main`.

The ceiling was never what distinguished honest from leaky anyway. The real
guarantee is #2889's self-describing `host_free_pass` field, which the WRITE
side refuses to synthesize from a leaky `pass` (asserted by
`hostFreeFromReport returns null when host_free_pass is ABSENT`).

**Fix:** keep the lower bound (a floor that only ratchets up never goes stale),
replace the magic ceiling with the structural one (`pass <= official_total` — a
mark above the corpus is nonsense by construction, and that bound moves with the
corpus), and keep the `host_free_pass === pass` identity.

## #681 — asserting the refusal instead of the no-host-import invariant

`tests/issue-681-standalone-iterators.test.ts` asserted that an unknown for-of
iterable is **refused at compile time** in standalone. That refusal existed for
exactly one goal: never leak an `__iterator` HOST import into a standalone
module.

#1320 Slice 1 replaced the mechanism. `ensureNativeIteratorRuntime` binds the
iterator protocol to emitted Wasm, so the module now compiles with **zero
imports** and a shape the native `__iterator` cannot canonicalize fails loudly
at runtime instead. The goal is still met; the refusal that used to enforce it
is gone.

**Fix:** pin the invariant (zero host imports) plus the property that justifies
dropping the refusal (unsupported shapes must be LOUD, never a silent
miscount) — verified against `undefined`, a number, and a JS array, all of which
throw.

A second, subtler staleness in the same file: `expectNoIteratorHostImports` ran
its regex over the WHOLE module. That was equivalent back when any mention of
`__iterator` could only be an import — but since #1320 those names belong to
**locally defined** functions, so a whole-module match now fires on the
host-free implementation itself, the exact opposite of the guard's purpose.
Restricted to `(import` lines, which keeps the teeth without flagging the
runtime that made the module host-free.

## Lesson

Both failures share a shape worth naming: **the assertion outlived the thing it
was asserting.** A test pinned to a mechanism (a refusal, a magnitude band)
rots when the mechanism is legitimately replaced or the metric legitimately
moves; a test pinned to the invariant (no host import; the mark is
self-describing and corpus-bounded) does not. Prefer the invariant, and when
only a magnitude is available, prefer a bound that moves with the data over one
someone wrote down on a Tuesday.

## Acceptance criteria

- [x] `tests/issue-2879-standalone-host-free-floor.test.ts` passes (14/14).
- [x] `tests/issue-681-standalone-iterators.test.ts` passes (8/8).
- [x] Neither fix weakens the invariant it exists to protect.
