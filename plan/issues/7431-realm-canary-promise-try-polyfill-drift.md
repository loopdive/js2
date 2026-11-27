---
id: 7431
title: "test262 worker: on Node < 23 the realm canary recycles after almost every test (`Promise.try:added`)"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: test262, infra
goal: core-semantics
related: [1957, 3426, 6440, 6492, 7376]
---

# #7431 — realm canary drift from the `Promise.try` polyfill on Node < 23

## Problem

On Node < 23 (`typeof Promise.try === "undefined"`; measured on Node 22.23.5
in a 4-core cloud container on 2026-11-19), the realm canary (#1957) reports
`Promise.try:added` after almost every test and, in the default `recycle`
mode, replaces the worker each time:

```
[pool] recycling worker: realm drift (#1957): Promise.try:added
```

- **Cause.** `installAmbientCompatibility` (`src/runtime/compatibility-adapter.ts`)
  runs `_installSelectedPromiseCompatibility` on every instantiate. That
  installs the keyed combinators AND the #6440 `Promise.try` polyfill on the
  host `Promise`. `scripts/test262-worker.mjs` primes only the keyed
  combinators before `snapshotRealmSurface()` (#6492 r5). So on a host
  without a native `Promise.try`, the first instantiate in every fresh worker
  adds it after the baseline, and that reads as drift.
- **Effect, measured.** `TEST262_TARGET=standalone pnpm run test:262` at pool
  3: about 20 tests/min with the canary in `recycle` mode, against about
  90 tests/min with `TEST262_REALM_CANARY=""` (9,029 ES5 rows in 91 min). A
  full local run is effectively unusable on Node 20/22, which `package.json`
  still supports (`engines: node >=20`).
- `tests/issue-3426-realm-canary-log-baseline.test.ts` fails on main on the
  same Node: it expects only `String.prototype.concat.name:deleted` and gets
  `Promise.try:added`.
- **Why CI does not see it.** CI's Node 24/25 ships `Promise.try`, so the
  polyfill is a no-op there.

## Implementation Plan

- **Module.** `scripts/test262-worker.mjs`, plus a one-line re-export in
  `src/runtime.ts`.
- **Change.** The existing #6492 prime before the snapshot calls the
  combined installer `_installSelectedPromiseCompatibility(Promise, mirror)`
  instead of `_installPromiseKeyedCombinators` alone. It is the same
  first-wins install that `installAmbientCompatibility` performs, so the
  baseline already contains everything a later instantiate writes.
  - `src/runtime.ts` re-exports `_installSelectedPromiseCompatibility` beside
    `_installPromiseKeyedCombinators`.
  - Keep the `TEST262_COMPILER_PATH !== "ir"` guard and the optional chaining
    for older bundles.
- **Rejected.** An exemption for `Promise.try` in `REALM_CANARY_IGNORE`. It
  would be a second source of truth for what the runtime installs, and it
  would also hide a test that really adds `Promise.try`.
- **Quality criterion.** No new list and no second install path: the worker
  primes through the one installer the runtime itself uses.

## Finding: a second, separate failure in the 3426 test (2026-11-19)

`tests/issue-3426-realm-canary-log-baseline.test.ts` also fails for a reason
this fix does not touch. It expects the canary to report
`String.prototype.concat.name:deleted` after a compiled
`delete String.prototype.concat.name;`.

- **Result.** With the `Promise.try` drift removed, the worker reports no
  drift at all. On base the deletion was not reported either: the only drift
  line there was `Promise.try:added`.
- **Cause.** Under the native semantic core (#6708, #6979) the compiled
  `delete` acts on the Wasm-native `String` prototype, not on the host's. On
  the default target, compiling and running that statement leaves the host
  `String.prototype.concat.name` descriptor unchanged
  (`{ value: "concat", writable: false, enumerable: false, configurable: true }`).
  The canary watches the host realm, so it is right to report nothing.
- **Conclusion.** The test's premise, a compiled statement that mutates a host
  built-in, is stale. It needs a probe that really reaches the host realm, or
  it should be retired. This is its own issue, not part of this fix.
- **Not verified.** I did not run the test on Node 24+ (CI's version) here, so
  whether CI also sees it red is unconfirmed.

## Acceptance

1. On Node 22, `TEST262_REALM_CANARY=log` reports no `Promise.try:added`.
2. Local tests/min before and after on Node 22, in `recycle` mode.
3. `tests/issue-3426-realm-canary-log-baseline.test.ts` no longer reports
   `Promise.try:added` on Node 22. It still fails on the separate finding
   above.
4. Verdicts unchanged on a measured path set. Node 24+ is unaffected by
   construction: the polyfill is a no-op there.

## Suspended Work (2026-11-20, budget window closed)

- **Branch:** `claude/7431-canary-promise-try`, head
  `22f3de0a3cc02f5c44c442c70cb0d1cb4a73c5a0`, based on main `89e4748241`.
  Pushed; no PR is open yet.
- **Done on the branch:**
  - the worker prime calls `_installSelectedPromiseCompatibility`;
  - `src/runtime.ts` re-exports it, swapped in place, net −1 line;
  - one mock name changed in `scripts/test262-compiler-path.test.mjs`, which
    passes 23/23.
  - All CLAUDE.md ratchet gates pass bare.
- **Measured.** Node 22, 600 ES5 standalone files, pool 3,
  `TEST262_REALM_CANARY=recycle`, all 600 pass in both runs:

  | run | time | recycles | `Promise.try:added` lines |
  | --- | ---: | ---: | ---: |
  | base | 1,623 s | 612 | 1,224 |
  | new | 802 s | 0 | 0 |

  Both times include the bundle build.
- **Next steps:**
  1. Merge `origin/main` into the branch.
  2. Set this file to `status: done` in the implementation PR, once #7328 has
     landed.
  3. Open the PR with the `hold` label.
  4. Run an adversarial review.
- **Not done:** the separate 3426 finding above needs its own issue id; none
  has been allocated.
- **Open review threads:** none.
