---
id: 4585
title: "Restore npm compatibility refresh publication"
status: in-progress
created: 2026-08-21
updated: 2026-08-21
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, npm-compat, dogfood
goal: correctness
sprint: current
depends_on: [4577, 4578]
assignee: ttraenkler/codex
horizon: s
related: [3781, 3958, 3982, 4130]
origin: "The live npm dashboard retained its pre-#4578 Acorn/clsx snapshot because both post-fix aggregate refreshes aborted before publication."
files:
  - scripts/generate-npm-compat-report.mjs
  - scripts/lib/npm-compat-perf.mjs
  - src/codegen/ambient-parse-import.ts
  - src/codegen/extern-declarations.ts
  - tests/dogfood/react-dom-upstream-suite.mjs
  - tests/dogfood/react-dom-upstream-suite.test.ts
  - tests/dogfood/react-upstream-suite.mjs
  - tests/dogfood/hono-upstream-suite.mjs
  - tests/dogfood/hono-upstream-suite-pin.json
  - tests/dogfood/hono-upstream-suite.test.ts
  - tests/dogfood/jest-upstream-suite.mjs
  - tests/dogfood/jest-upstream-suite-pin.json
  - tests/dogfood/typescript-upstream-suite.mjs
  - tests/dogfood/typescript-upstream-suite-pin.json
  - tests/dogfood/upstream-suite-runner.mjs
  - tests/dogfood/upstream-suite-compile-worker.mjs
  - tests/dogfood/upstream-suite-runner.test.ts
  - tests/issue-3781-npm-perf-lanes.test.ts
  - tests/issue-4585-npm-compat-refresh-resilience.test.ts
  - plan/issues/4585-npm-compat-refresh-resilience.md
---

# #4585 — restore npm compatibility refresh publication

## Problem

The public npm compatibility page still shows the Acorn and clsx regression
that #4578 fixed. The page itself is current, but its committed aggregate is
from before the fix because two later refreshes aborted before writing their
artifacts:

- Acorn projected the same ambient `env.parseInt` slot twice when legacy and
  prepared IR consumers shared the global.
- ReactDOM's production oracle admitted upstream tests which call the
  development-only `React.captureOwnerStack` API; a late callback threw outside
  the awaited test body and terminated the aggregate process.

## Scope

- Preserve the compiler's exact ambient `parseInt`/`parseFloat` import identity
  when the TypeScript library declaration is registered.
- Keep duplicate serialized adapter bindings fail-closed; do not weaken the
  runtime manifest validator.
- Reject exact `React.captureOwnerStack()` call sites before a production
  ReactDOM run, report the reason, and retain them in development runs.
- Compile standalone performance lanes at verified O4 after [#4586](./4586-o4-try-table-flatten-fallback.md),
  explicitly recording the unsupported `Flatten` omission for `try_table`
  modules while rejecting every unrelated optimizer warning.
- Regenerate and publish the complete npm compatibility aggregate only after
  every package finishes and the fixed Acorn/clsx measurements are present.
- Bound the React and React DOM per-test watchdogs at two seconds by default so
  admitted upstream tests that need unavailable async infrastructure remain
  visible in the report without consuming the aggregate refresh's entire job
  budget.

## Acceptance criteria

- [x] The Acorn parse shape emits one physical and one projected
      `env.parseInt` binding, builds `importObject`, instantiates, and executes.
- [x] A caller-mutated manifest containing a duplicate binding remains rejected.
- [x] Production ReactDOM filtering is AST-based, ignores text-only near misses,
      records an explicit reason, and leaves the development corpus unchanged.
- [x] The pinned Acorn dogfood suite completes without the adapter-manifest
      exception.
- [x] JS-host and standalone rows record O4; `try_table` modules explicitly
      record the omitted `Flatten` pass and no raw fallback is measured.
- [ ] A fresh aggregate refresh completes and the live page serves a post-#4578
      timestamp and corrected Acorn/clsx measurements.
- [ ] The full aggregate refresh reaches publication without timing out in the
      React upstream suites; all admitted tests remain represented with an
      explicit pass, fail, trap, or infrastructure outcome.

Pre-[#4586](./4586-o4-try-table-flatten-fallback.md) checkpoint: the exact standalone-dynamic clsx 2.1.1 lane at O3 measured
0.149035 µs/op versus Node's 0.023225 µs/op (ratio 0.155833), with checksum
14/14 and an explicit verified-O3 receipt. The stale public row is 0.000122.
The exact Node 25 Acorn 8.16.0 lane measured 57,331.486 µs/op versus Node's
4,012.257 µs/op (ratio 0.069983), checksum 422/422, and a verified 2,132,904-byte
O3 artifact; the stale public ratio is 0.000838.

## Non-goals

- Hiding a regression by changing benchmark baselines or historic result rows.
- Treating development React artifacts as the production npm package.
- Weakening manifest ownership or duplicate-import validation.

## Checkpoint evidence

- Syntactic and checker lib scanners both emit exactly one physical and one
  projected `env.parseInt` binding for the reduced Acorn shape; it instantiates
  and returns `30`. The forged duplicate remains rejected.
- The pinned Acorn suite completes with `3494/3518` passing and no manifest
  exception.
- The pinned ReactDOM corpus records `78` production-incompatible call sites:
  `1923` admitted + `80` rejected = all `2003` upstream tests. Development
  retains all `2001` non-skipped tests.
- Focused parse/standalone tests pass `16/16`; ReactDOM infrastructure passes
  `5/5` with its heavy suite deliberately skipped. Typecheck, formatting, lint,
  LOC/function/oracle/dead-export, IR-fallback, and issue gates pass.

## Refresh-timeout checkpoint

The first post-O4 full refresh reached the React package at 04:54 UTC and was
cancelled at the 180-minute workflow limit before the next package. The log
showed no compiler error: React's 272 admitted upstream tests were being run
with the historical ten-second per-test watchdog, so tests waiting on missing
Jest/DOM infrastructure serialized into hours. A local complete React run with
the watchdog set to 2 seconds finished in 56 seconds and retained the same
`102/179` scored result (`272/273` upstream tests represented). This change
keeps the original corpus and records each timeout; it only prevents a missing
async dependency from starving publication.

## Unit-infrastructure checkpoint

The generic pinned-suite runner now carries deferred upstream registrations into
the report as `extraction.unavailableInfra` instead of silently dropping them
from the npm card. This remains separate from native-oracle failures and
invalid Wasm modules. The shared test shim also supports the lifecycle and
spy/matcher surface used by the next Web API slices (`beforeAll`, `afterAll`,
`vi.spyOn`, `stubEnv`, and one-call matchers).

Hono's pinned suite now admits the original `src/utils/filepath.test.ts` in
addition to its existing ten files. The unchanged two upstream callbacks both
compile, validate, and pass in Wasm: the suite moves from 205 to 207 admitted
callbacks and from 79 to 81 passes. The remaining 2,148 Hono registrations are
visible as unavailable infrastructure until their external test/package and
platform adapters are wired; no tests were rewritten or counted as passes.

## Unit-infrastructure continuation

The Hono adapter now resolves the published package's bare-root and
directory-index imports, removes multiline type-only imports without changing
the callback bodies, and preserves the source directory in generated paths so
same-named `index.test.ts` files cannot overwrite one another. The shared
upstream shim also provides `expectTypeOf(...).toBeFunction()` and executes
`afterEach` hooks around synchronous and promise-returning callbacks.

The expanded immutable Hono slice selects 16 original files and registers 297
callbacks. The native oracle passes 296; 15/16 Wasm modules validate and
86/296 callbacks pass in Wasm. The report records the remaining 2,058
unavailable registrations explicitly. The one native failure, one invalid Wasm
module, and six module-initialization/runtime failures remain visible as test
or compiler/runtime defects rather than being reclassified as unavailable
infrastructure.

Jest's adapter now resolves extensionless default, namespace, and directory
imports against the immutable source checkout, normalizes the CJS-shaped
default exports used by Node's native loader, and can compile a selected suite
with the Node platform surface instead of the browser surface. The shared shim
exposes the small `jest.fn`/`jest.spyOn` facade needed by those original tests.
The selected Jest slice is now eight files and 99 callbacks: all 99 native
callbacks pass, all eight Wasm modules validate, and 29 callbacks pass in Wasm;
3,189 registrations remain explicitly unavailable infrastructure. The added
`isError.test.ts` exercises the `node:util/types` host seam; its failing Wasm
assertions remain scored runtime semantics rather than being hidden as infra.

The TypeScript adapter now exercises both original base64 unit files through
the exact release-source projection, supplies the `ts.sys.base64encode` seam,
and compiles the Node-oriented test with the Node platform surface so its
upstream `Buffer` guard behaves as it does under Node. The projection now also
contains the exact `parsePseudoBigInt` implementation and its character-code
constants. The slice registers 11 callbacks across three original files; all
11 pass natively, all three Wasm modules validate, and four callbacks pass in
Wasm. Its remaining 1,750 registrations stay explicit unavailable
infrastructure.
