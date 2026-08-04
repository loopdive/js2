---
id: 4147
title: "`runTest262File` links no `js2wasm:runtime-eval` provider — every standalone file including propertyHelper.js dies at instantiate, so local measurement is silently blind"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-04
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: tooling
language_feature: n/a
goal: standalone-mode
related: [2527, 4010, 4061, 4098]
---

# `runTest262File` links no `js2wasm:runtime-eval` provider — local standalone measurement is silently blind

`runTest262File` (`tests/test262-runner.ts`) does **not** supply the separately
compiled `js2wasm:runtime-eval` provider that the CI worker links
(`scripts/test262-worker.mjs` → `instantiateRuntimeEvalNamespace`). Any
standalone module whose harness assembly carries those imports therefore dies at
`WebAssembly.instantiate`:

```
TypeError: WebAssembly.instantiate(): Import #0 "js2wasm:runtime-eval":
module is not an object or function
```

**`propertyHelper.js` in the assembly is the trigger** — measured by the S3
owner: prefix alone = 0 imports, prefix + `propertyHelper` = 2. Since
`propertyHelper.js` is the standard include for any test asserting property
attributes, this silently removes a large, systematically-chosen slice of the
corpus from every local measurement.

## Why this is a blindness bug and not a nuisance

The failure is **indistinguishable from a compiler failure at the call site**.
`runTest262File` returns `status: "fail"` with an error string, exactly as it
would for a real miscompile. An agent measuring a fix locally sees rows that
"fail", attributes them to its own change, and either chases a phantom
regression or — worse — discounts real ones because "those were already
failing". The rows are not marked skipped, not marked errored, and carry no
signal that the instrument, rather than the compiler, is what broke.

This is the [[silent-empty]] shape applied to a measurement lane: *what does the
instrument do when it cannot see?* Here it answers "the test fails", which is
the one answer that cannot be distinguished from a real result.

## Two independent measurements, from two lanes that did not coordinate

### 1. S3 / #4010 owner — the trigger and the scale

A pilot of the `{name,length}.js` stratum scored **0 / 11 runnable**. The
instrument was blind, not the compiler broken. Their workaround: neutralise
`$262.evalScript`'s `eval` in a **local copy** of
`scripts/test262-fyi-runtime.js` (a function no `{name,length}.js` test calls).
With the instrument repaired it agreed with the published CI standalone baseline
**16/16** pass/not-pass. Recorded in `plan/issues/4010-m2-disjoint-receiver-side-tables.md`
under "Instrument note — `runTest262File` cannot run this corpus unaided"
(currently on PR #4091's branch, not yet on `main`).

### 2. #4061 owner — two controls proving it is the instrument, not the change

While sweeping the 182 baseline-passing `built-ins/Object/create` files for
regressions, **27** failed with the identical import error. Two controls
established that this was the harness:

- **`built-ins/Object/create/name.js` was among the 27.** It is a pure
  `Object.create.name === "create"` assertion — it contains no descriptor
  argument at all, so the descriptor-routing change under test could not
  possibly reach it.
- **Four baseline-passing tests from unrelated directories reproduced it
  exactly**: `Array/prototype/{filter,findLast,flatMap}` and
  `String/prototype/lastIndexOf` → **0 / 4**, same error, same instantiate
  failure.

Corrected reading of that sweep: **155 pass, 27 unrunnable, 0 regressed** — a
number that would have read as "27 regressions" without the controls.

## Cost when undetected

Two independent lanes each burned real effort on it in the same session, and
neither could have found it from the error text alone — one needed a
descriptor-free file inside its own failing set, the other needed a
cross-directory control. A third lane hitting this would start from zero again.
Every local standalone measurement in the project is currently understating
runnable coverage by an unknown amount, and the understatement is
**systematic** (it selects exactly the attribute-asserting tests), not random.

## Acceptance

- [ ] A `propertyHelper.js`-including test — e.g.
      `built-ins/Object/create/name.js` — is **measurable locally** through
      `runTest262File` with `target: "standalone"`, and its status **matches the
      published CI standalone baseline** for the same commit. Matching CI is the
      criterion; "does not throw at instantiate" is not sufficient, since a
      wrongly-linked provider could instantiate and then answer differently from
      CI.
- [ ] The fix links the **same** provider CI links
      (`instantiateRuntimeEvalNamespace`, `scripts/test262-worker.mjs`) rather
      than a second local shim, so the two lanes cannot drift apart. If a shim
      is unavoidable, state explicitly what it does NOT provide.
- [ ] A positive control is included: at least one test that legitimately
      **fails** on the measured commit still reports `fail`, so the fix is not
      confused with "everything now passes".
- [ ] **The unlinked case must announce itself.** If the provider genuinely
      cannot be linked, `runTest262File` must return a distinct status
      (`skip`/`error` with a named reason), never `fail` — a detector that
      cannot see must say so rather than return the same answer as a real
      failure. This criterion is the point of the issue; the convenience fix
      without it leaves the next unlinked path silently blind again.
- [ ] Re-run the #4061 182-file `Object/create` sweep as a regression witness:
      expect 182 runnable, not 155.

## Notes

- Related: **#2527** (core-wasm linking / host shims and runtime) — the
  runtime-eval provider is part of that packaging story, and a fix here should
  not fork it.
- The S3 workaround (patching a local copy of `scripts/test262-fyi-runtime.js`)
  is a **measurement-lane** hack and explicitly *not* a defect on `main`; do not
  land it as-is.
