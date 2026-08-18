---
id: 4152
title: "lodash `createHybrid` — the function a prior #4134 attempt broke — had no test coverage at all"
status: done
completed: 2026-08-04
sprint: 78
created: 2026-08-04
updated: 2026-08-18
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: test
area: testing
language_feature: closures
goal: npm-library-support
related: [4133, 4134, 3008, 3552, 4074]
origin: "Found by the verification-plan architect pass on #4133/#4134, 2026-08-04; independently confirmed"
---

# #4152 — no test covered lodash `createHybrid`

## The gap

`_createHybrid.js` is the most capture-dense function in lodash: it builds a
wrapper closure over `partials`, `holders`, `argPos`, `ary`, `arity` and returns
it from the enclosing factory — exactly the shape the #4133/#4134 nested-capture
defects hit.

It has already been broken once. The `funcMapOwnerDecl` +
`restoreShadowedFuncBindings` recompile path attempted during #4134 broke
`createHybrid`, and the approach was backed out entirely. It was caught **only
because someone ran the full lodash bundle by hand.**

Nothing in the suite covered it. Verified 2026-08-04:

```
$ grep -rl "createHybrid" tests/
(no output)
```

So the single regression signal for a known-fragile function was a manual step
that happened to be performed. That is not a signal; it is luck.

## Fix

`tests/issue-4152-lodash-createhybrid-coverage.test.ts` — compiles four entry
points into the `createHybrid` call graph (`_createHybrid.js`, `partial.js`,
`bind.js`, `curry.js`) and asserts each produces a module that passes
`WebAssembly.validate`, plus a scoped check that no `local index out of range`
diagnostic is emitted.

**Why validity and not a computed value.** The failure mode of this defect class
is an *invalid module*, not a wrong answer: codegen emits `local.get N` for N
outside the frame and the binary fails validation. A behavioural assertion is
deliberately not made — these modules do not yet instantiate standalone (missing
imports, tracked separately), so it would have to be skipped and would guard
nothing. Validity is the strongest claim that is true today.

**Why compilation is not asserted diagnostic-free.** These files legitimately
produce TypeScript diagnostics when compiled as loose JS (`Property
'placeholder' does not exist on type 'Function'`, etc.). They are non-fatal —
`success` stays true and a valid binary is produced. Asserting zero diagnostics
would make the test fail for reasons unrelated to its invariant.

## Non-vacuity — demonstrated, not asserted

Measured on this checkout: all four compile to valid Wasm (`partial` 73,792 B ·
`_createHybrid` 49,749 B · `bind` 75,460 B · `curry` 70,009 B), in ~16 s total.

Passing today does not by itself prove the assertion has teeth, so the rejection
side was demonstrated directly. A hand-assembled module whose single function
declares **zero** locals and executes `local.get 5` — the exact emission shape
of this defect — gives `WebAssembly.validate(...) === false`, while an otherwise
identical well-formed module gives `true`.

## ⚠ Honest limitation — this does NOT gate per-PR

Untouched root test files do **not** run at PR time (#3008's two-layer design);
the full suite is deferred to the post-merge `issue-tests.yml` detector, which
detects but does not ENFORCE. The per-PR enforcing gate is the curated
`tests/guard-suite.json` manifest.

This file was **not** added to that manifest, because it does not meet entry
criterion 1 — *"guards an invariant that a prior PR silently broke on **main**"*.
The `createHybrid` break happened on a branch and was backed out before merge.
Adding it anyway would quietly widen a manifest whose entire value is that its
criteria are honoured.

It already satisfies criteria 2 (~16 s, no test262 harness or prepared inputs)
and 3 (green on main). **If this ever breaks main, criterion 1 is satisfied and
it should be promoted into `guard-suite.json` immediately.**

So the gap is narrowed, not closed: coverage now exists and the post-merge
detector will see a break, but a PR that regresses `createHybrid` without
touching this file can still go green. Closing that fully is a judgement call
about what belongs in the required manifest, and is left to the maintainer.

## Acceptance criteria

- [x] A test exists that fails when `createHybrid`'s call graph emits an
      out-of-frame local.
- [x] Its non-vacuity is demonstrated rather than asserted.
- [x] The gating limitation is stated where a reader will find it (both here and
      in the test file's own header), not left implied.
