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
  - tests/dogfood/lodash-upstream-suite.mjs
  - tests/dogfood/lodash-upstream-suite.test.ts
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

## Unit-infrastructure continuation 2

The shared isolated worker now accepts a package-selected platform, so Node
globals are available to original Jest and TypeScript modules without changing
the browser default. Jest's adapter also resolves extensionless relative,
directory-index, default, namespace, and named imports from the pinned source;
the native oracle normalizes the CommonJS namespace while leaving each original
callback body unchanged.

The Jest pin now selects eight original `@jest/get-type` and `@jest/util` files,
registering 99 callbacks. Native execution passes 99/99; all eight modules
compile and validate; 29/99 Wasm callbacks pass and 70 remain scored failures.
The other 3,189 registrations are explicitly reported as unavailable
infrastructure. TypeScript now selects three original base64/bigint utility
files (11 callbacks, native 11/11); exact projections expose the release-tag
`parsePseudoBigInt` implementation and its `CharacterCodes` carrier. All three
modules compile and validate; 4/11 Wasm callbacks pass, 7 fail, and 1,750
registrations remain unavailable. These failures are measured runtime/compiler
results, not hidden by the adapter.

## Unit-infrastructure continuation 3

The Jest source adapter now materializes the small published dependencies used
by the selected original utilities (`detect-newline` for `jest-docblock`) as
explicit ESM workspace adapters. Namespace imports from relative upstream
modules are rebound to the statically read members, so the tests exercise the
real functions instead of receiving an empty namespace carrier. This is a
harness import adaptation; the upstream callback bodies remain unchanged.

The pin now selects twelve original files across `@jest/get-type`, `jest-util`,
`jest-docblock`, `jest-diff`, `diff-sequences`, and `jest-config`. The run
registers 234 callbacks: 232/234 pass in the native oracle (the two native
failures remain explicit harness-incompatible outcomes), all twelve Wasm
modules compile and validate, and 113/232 native-compatible callbacks pass in
Wasm. The remaining 119 are scored Wasm failures, while 3,054 registrations
remain explicitly unavailable infrastructure. No upstream test was rewritten
or counted as a pass because it was deferred.

The shared runner now exposes `UPSTREAM_TEST_SHIM_NODE` for package graphs whose
CommonJS dependencies execute during module initialization. It omits only the
late-initialized browser `var global = globalThis` alias; the Node platform
already lowers bare `global` correctly. Lodash and lodash-es now select the same
seven original modules and 11 callbacks in both lanes: native 11/11 and Wasm
11/11, with the remaining 1,742 registrations explicitly deferred as
unavailable infrastructure. Before this fix, all 11 callbacks in each package
failed at initialization when Lodash's `_root` helper fell back to the
unavailable `Function` constructor.

The existing selected adapters also run successfully for jsdom (6/6),
styled-components (6/6), and the selected webpack slice (13/16). Stylelint is
8/9 and Redux is 13/82; their remaining failures are scored runtime/compiler
semantics, not missing test registration or acquisition infrastructure.

## Unit-infrastructure continuation 4 (Axios)

Axios now uses the original upstream test files through the shared worker. The
pin selects 33 of 49 files and registers 231 callbacks; native execution is
231/231, all 33 Wasm modules compile and validate, and 21/231 Wasm callbacks
pass. Two callbacks are scored assertion failures and 208 stop during module
initialization. Sixteen files (414 registrations) remain explicitly deferred
as unavailable infrastructure. The worker supplies the Node builtin namespaces
used by Axios (`async_hooks`, `assert`, `buffer`, `crypto`, `events`, `stream`,
`timers`, `url`, and `util`) without replacing the package implementation.

The class-rest dispatch reduction is green and the generic bridge fix is in the
codegen path. Symbol-valued module bindings now retain their semantic brand,
removing the earlier `Cannot convert a Symbol value to a number` failure. The
remaining scored blocker is a reference-valued callback crossing the legacy
numeric callback bridge (`toLowerCase is not a function`); an experimental
reference bridge exposed a closure-lifetime trap and was not shipped. Track
that follow-up in [issue 4527](./4527-axios-class-call-concat-vararg-invalid-module.md)
and [issue 4528](./4528-axios-module-init-symbol-tonumber.md).

## CI follow-up (2026-08-21)

The first CI run for the Axios continuation passed all equivalence, issue,
smoke, and lint checks but stopped in the host-import policy ratchet. The
generic Node builtin provider and callback normalization intentionally add 18
runtime source lines and 22 `resolveImport` lines. The tracked source budget
now records those measured values (`17118` and `7238`) rather than weakening a
correctness or performance gate; the raw host-import policy remains active.

## Unit-infrastructure continuation 4 (Lodash)

The Hono adapter now selects four additional original files from the immutable
v4.12.16 source inventory: the HTML helper, route helper, context-storage
middleware, and pretty-JSON middleware. The context-storage test keeps the web
ambient surface required by Hono's standard `Request` API while the isolated
worker supplies the real Node builtin namespaces (including
`node:async_hooks`) through a generic host-dependency provider. This removes
the previous module-initialization failure without substituting a mock or
rewriting the upstream callback.

The selected Hono slice is now 20/120 original files with 322 registered
callbacks. The native oracle passes 321/322 (one upstream native failure), all
20 Wasm modules compile and 19/20 validate, and 87/321 callbacks pass in Wasm.
The six module/runtime failures, 228 scored Wasm failures, one invalid Wasm
module, and the 2,033 registrations from the other 100 source files remain
explicitly visible; they are not reclassified as unavailable infrastructure.

## Unit-infrastructure continuation 5

The Lodash adapter now selects 18 original QUnit modules instead of seven,
covering arithmetic, comparison, and string helpers. The expanded lane runs
26/26 callbacks natively for both packages; Wasm passes 26/26 for `lodash` and
22/26 for `lodash-es` (the four failures are null string-method results).
The other 1,727 registrations remain explicitly deferred as unavailable
infrastructure, and no upstream callback or input is rewritten.
