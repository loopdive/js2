---
id: 4299
title: "Compile jsdom and run its 318 original API tests against Wasm"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-13
priority: high
feasibility: hard
reasoning_effort: high
task_type: test
area: dogfood
language_feature: modules, node-builtins, async
goal: npm-library-support
horizon: l
related: [3958, 3982, 4298]
origin: "npm compatibility expansion: replace jsdom's compile-only card with its own upstream tests, without claiming tests that never reached a compiled implementation."
---

# Compile jsdom and run its 318 original API tests against Wasm

## Problem

The npm compatibility catalog pins the real published `jsdom@30.0.1` package
and its dependency graph, but only probes `package/lib/api.js`. There is no
runtime differential harness, and the npm tarball does not ship jsdom's tests.
The page must not turn that absence into an implied pass.

The matching upstream source is:

- repository: `https://github.com/jsdom/jsdom.git`
- annotated tag: `v30.0.1`
- immutable commit: `6584485f094d5b271553005b68804c93a455c002`
- original suite: all 17 files under `test/api/`
- exact declarations: **318** `it(...)`/`specify(...)` tests
- upstream skips: **0**

This is the smallest upstream suite that directly exercises the published
`JSDOM` API. The larger WPT population is separate and should not be silently
mixed into this denominator.

## Current measured blocker

The full published `lib/api.js` project graph was compiled in an isolated child
with the catalog's exact GC/Node options and 180,000 ms budget. Result:

| metric | value |
| --- | ---: |
| elapsed | **180,227 ms** |
| timed out | yes |
| binary bytes | **0** |
| valid module | no binary to validate |
| compiled-scored original tests | **0/318** |

This is a compiler-frontier result, not a test failure and not evidence that
jsdom works. Increasing the test harness alone cannot help: there is no compiled
implementation to invoke. A reduced dispatcher that imports jsdom still pulls
the same implementation/dependency graph and did not yield a usable binary,
so replacing the API call with a harness-authored approximation would be
misleading.

## Work

Architecture constraint: compile jsdom's JavaScript and its reachable package
dependencies to Wasm. Keep only concrete Node capability APIs as explicit host
imports. Do not replace the `JSDOM` implementation with a whole-package host
proxy or count calls into native host jsdom as compiled execution. This makes
the resulting compiled DOM usable by the ReactDOM lane in
[#3982](3982-react-dom-own-unit-tests-against-compiled-wasm.md).

1. Profile `compileProject(package/lib/api.js)` by phase and graph unit to
   distinguish slow progress from a non-converging analysis.
2. Remove the compile-time bottleneck generically; do not prune jsdom modules
   whose native loader reaches them.
3. Pin and verify the upstream tag/commit because the tests are absent from the
   npm tarball.
4. Run all 318 original API tests through the same native/compiled adapter.
   Classify only tests that the native adapter cannot reproduce as
   infrastructure-incompatible, with exact names and reasons.
5. Report admitted, scored, passed, failed and infrastructure-incompatible
   counts separately on the npm compatibility page.

## Suspended handoff (2026-08-09)

Commit `c1eed0951fd680` adds the pinned upstream-suite accounting and keeps the
card honest at **0/318 executed** while no implementation binary exists. The
published branch is `codex/npm-compat-handoff`; there is no separate unfinished
jsdom worktree or hidden patch.

Resume at the compiler, not the adapter: profile the 180-second
`compileProject(package/lib/api.js)` child by graph and finalization phase. Do
not replace jsdom with a reduced implementation, count native-only execution,
or turn the entry-barrel validation result into a package pass.

## Acceptance criteria

- [ ] The full published jsdom entry graph emits a WebAssembly binary within a
      documented bounded budget and that binary validates.
- [ ] The upstream source pin is verified at commit
      `6584485f094d5b271553005b68804c93a455c002`.
- [ ] All 318 original `test/api` tests are admitted or rejected with an exact,
      recorded reason; no test disappears before accounting.
- [ ] Native Node and compiled Wasm execute the same test bodies and inputs.
- [ ] No cached/precomputed result, package-specific constant answer or
      harness-authored substitute is counted as a jsdom test pass.
- [ ] The npm compatibility card reports the real denominator and does not
      imply correctness while the implementation cannot compile.
