---
id: 3995
title: "npm-compat: pin and adapt original upstream test suites for catalog packages"
status: ready
created: 2026-07-30
updated: 2026-08-21
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ci
language_feature: n/a
goal: dogfood
sprint: Backlog
horizon: m
related: [1058, 3587, 3672, 3958, 3982, 3997, 3999, 4000, 4287, 4299, 4301, 4302, 4303]
oracle-ratchet-allow:
  # The Hono fix compares the actual registered Wasm carriers for two inferred
  # anonymous object literals. TypeOracle deliberately exposes only
  # registry-free facts, so it cannot answer whether their concrete typeIdx
  # values match; keep this exact representation query at the codegen seam.
  - src/codegen/literals.ts
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/literals.ts
  - src/codegen/index.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/control-flow.ts
  - src/compiler.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/context/create-context.ts::createCodegenContext
  # The React/ReactDOM upstream adapter exercises these existing codegen
  # paths. Keep the PR's measured growth explicit until the post-merge
  # baseline refresh records the new ceilings.
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/runtime.ts::<anonymous>#89
---
# npm-compat: pin and adapt original upstream test suites for catalog packages

## Problem

The catalog package tarballs do not ship their original unit suites. The npm-compat page correctly reports upstream suite not shipped; adapter pending, but this needs a tracked path to genuine validation.

Pin matching source revisions and provide adapters for: hono, lodash, axios, react-dom, webpack, uuid, typescript, redux, jest, styled-components, moment, stylelint, three, lit, tailwindcss, and cookie. Keep upstream-suite validation distinct from compile checks, synthetic differential vectors, and benchmark harnesses.

Start with React DOM, Jest, and Lit, which already compile and validate their entry artifacts.

The React browser harness installs the complete set of HTML element constructors
provided by JSDOM that appear in the pinned React and ReactDOM sources. This
keeps `instanceof` and feature-detection paths faithful without inventing host
stubs; constructors absent from JSDOM remain unavailable rather than being
reported as passing infrastructure. This includes the event constructors used
by Fizz and event-plugin tests, which JSDOM exposes on `window` but not on
Node's `globalThis` by default.

## Provenance

Migrated on 2026-08-01 from a GitHub issue on `loopdive/js2` (opened 2026-07-30)
that was created by an agent in error — this project tracks work as markdown
under `plan/issues/`, not as GitHub issues. The GitHub issue has been closed and
points here. **No content was dropped:** the Problem section above is the
original issue body verbatim.

Metadata below the title is newly assigned and is a **starting estimate, not a
measurement** — `priority`, `horizon` and `feasibility` were not stated in the
original and have not been validated against the corpus. Re-derive before
scheduling.

## UUID v14.0.1 lane (remeasured 2026-08-12)

The UUID adapter is now pinned and runnable at
`pnpm run dogfood:uuid-upstream-suite`. It clones
`uuidjs/uuid@v14.0.1`, verifies commit
`70177807e9229dfacde2038dc1e722f1828f358a`, and runs the ten original
`src/test/*.test.ts` files against the published `uuid@14.0.1` tarball. The
shared `test_constants.ts` fixture is pinned separately. Registration-shaped
`Array#forEach` calls are expanded only by the generic runner so the source
test bodies stay intact; this preserves all dynamically generated cases.

Measured oracle/runtime result on the first mainline merge carrying this lane
and on current main: **75/75 native tests pass; 3/75 admitted tests pass in
Wasm** (exact denominator 75, no harness-incompatible tests). All ten generated
modules compile; nine validate, while `v7.test.ts` emits a `call_ref` operand
type mismatch in `__call_fn_2`. The three passing cases are two parse cases and
the v6 creation-time sort case. The remaining 72 Wasm failures are recorded
individually in `tests/dogfood/report/uuid-upstream-suite.json`, including
illegal casts in v1, null dereferences in validate/version, and assertion
mismatches in vector and crypto paths. The opt-in floor now reflects this
measured mainline baseline; it is not lowered below a result that ever existed
on main. This is runtime evidence, not a compile-only card; the lane remains
open until the compiler/runtime frontier improves.

## Hono, Lodash, and Moment lanes (measured 2026-08-12)

The matching upstream repositories are pinned to immutable commits and their
complete unit inventories are verified before extraction:

- Hono v4.12.16: 120 `src/**/*.test.{ts,tsx}` files and 2,355 measured
  `test`/`it` registration sites. The initial adapter runs all 31 callbacks in
  `utils/accept.test.ts` and `utils/mime.test.ts` against published `dist`.
- Lodash 4.18.1: the complete 27,234-line `test/test.js` source is pinned by
  digest (1,753 QUnit registration sites). Seven complete, self-contained
  QUnit modules contribute 11 unchanged callbacks against the matching
  published modular method files.
- Moment 2.30.1: 190 core/locale unit files and 2,638 measured registration
  sites. Six synchronous core files contribute ten original callbacks against
  published `moment.js`.

The adapters run the same callback text and assertion shim in Node and Wasm.
Deferred files/registration sites remain explicit report fields; they are not
counted as passes or silently removed from the upstream denominator. UUID's
existing 75-test lane is reused unchanged rather than duplicated.

Measured runtime results after the 2026-08-12 compiler fixes:

- Hono: **31/31 native, 31/31 Wasm**. Both selected modules compile and
  validate. The six initial failures were generic compiler defects: an
  incompatible nested object carrier reused across array elements, host-null
  instead of real `undefined` on closure fallthrough, and an untyped JavaScript
  object-default parameter closed to the default object's exact shape.
- Lodash CommonJS: **11/11 native, 11/11 Wasm**. Static top-level `require`
  linking, CommonJS export-object handling, JSDoc `*` parameter preservation,
  mixed callable arrays, and callback/apply lowering are exercised by the
  unchanged selected QUnit modules.
- lodash-es 4.18.1 is a separate catalog lane: its published 308-module ESM
  barrel now compiles to valid Wasm, and the same seven original QUnit modules
  pass **11/11 native, 11/11 Wasm** against the modular ESM implementation. A
  source-qualified ambient-builtin registry prevents `toNumber`'s
  `freeParseInt` alias from being confused with lodash-es's own exported
  three-argument `parseInt` function.
- Moment: **10/10 native, 0/10 Wasm**. All six selected modules compile and
  validate, but the generated callbacks observe a null Moment implementation.
  The exact implementation-versus-adjacent-declaration resolution defect is
  split into #4384.

These are exact selected-slice denominators, not whole-suite pass rates. The
reports retain the larger upstream inventories and deferred counts separately.

## Suspended catalog handoff (2026-08-09)

Work is suspended on `codex/npm-compat-handoff`. The last compiler checkpoint
is `7a50f7fd9a34fd` plus the handoff/config commit that closes #4000. No
parallel worker retained an implementation patch. A fresh manual audit of the
23 pinned catalog entries found **13 compiling and 12 validating**; the
checked-in public report predates the latest long-running probes and must be
regenerated before publication. In particular, a validating re-export barrel
is not evidence that ReactDOM or Lit's implementation works.

| lane | suspended state | owner / next step |
| --- | --- | --- |
| React | 64/64 scored original tests pass; 272/273 admitted | #3958 records the complete result |
| ReactDOM | implementation emits a malformed `updateForwardRef` frame; 0 scored | #3982 |
| jsdom | 318 original API tests accounted for; implementation compile times out at 180.227 s; 0 executed | #4299 |
| Hono | 373,905-byte module validates; route match fails the `#routes` brand | #4301 |
| TypeScript | source graph 82 -> 31 files, but no binary after 300.3 s | #1058 |
| ESLint | selected upstream unit lane passes 44/44; full `lib/api` graph still exceeds the bounded run | resume the scale measurement from #3672 before claiming full ESLint |
| Prettier / Axios | no binary; residual safe async refusal | #4302 |
| Stylelint | explicit `fs enabled` lane reaches five #4302 diagnostics and one #4303 diagnostic | #4000, #4302, #4303 |
| styled-components | compiles; invalid `nt` local type | #3999 |
| webpack / tailwindcss | bounded entry compile does not finish | #4287 |
| Three.js | bounded entry compile does not finish | #3997 |
| UUID | 3/75 original tests currently pass; the v7 suite module is invalid | this issue's UUID section |
| Lit | 8/16 scored; implementation validation remains blocked | #3978 |
| Acorn / clsx / cookie | 3508/3518, 17/18, and 21/21 respectively | existing package-specific issues |
| Redux | runtime workload passes 1/1 | adapter can be expanded to originals |
| Jest / Lodash / Moment | entry compiles and validates; no original-suite score yet | add pinned adapters here |

The npm-compat generator now invokes the Hono, Lodash, lodash-es, UUID, and
Moment upstream runners directly. Pass counts therefore come from a fresh run,
not copied static data. UUID remains **3/75** with exact per-test messages and
is tracked in #4383. Performance regressions remain informational rather than
a gate, per the catalog policy.

## 2026-08-11 resumed compiler progress

The pinned catalog was rerun from current `main` while resuming this umbrella:

- `lit@3.3.3` now compiles to a valid 98,116-byte module after unknown-field
  logical assignment was routed through dynamic property storage (#3978);
- `styled-components@6.4.4` now compiles to a valid 272,297-byte module after
  three generic validation bugs were fixed (#3999);
- neither card has a runtime differential workload yet, so both remain
  correctness-unverified despite validation succeeding.

The full pinned Lit upstream suite was also rerun: 583/587 upstream tests are
admitted, 8/16 scored tests pass, 554 need browser/test infrastructure, and two
implementation files (28 tests total) still emit invalid call operands before
execution. The report also contains 92 invalid per-test batches. #3978 remains
the active owner for that compiler frontier; this umbrella continues to own the
missing consistent runtime adapters and report integration.

## 2026-08-14 unified GitHub-source setup and complete small-package suites

`npm-compat-upstream-sources.json` now pins the GitHub repository, release tag,
and immutable commit for every one of the 24 packages rendered by
`npm-compat.html`. The source acquisition command accepts either
`--package <name>` or `--all`; a single-package run does not acquire, compile,
or execute any unrelated package. For the 14 packages that had no source-suite
adapter when this slice started, the committed metadata also verifies the
complete unit-file inventory by count and path digest. This closes the
provenance/setup gap without presenting packages that merely compile as if
their original tests passed.

The first complete new runtime adapters are measured on current main:

- clsx 2.1.1: all 3 upstream uvu files and all 32 callbacks run; **20/32** pass
  in Wasm and **32/32** pass natively. The 12 real Wasm divergences are retained
  in the report. The existing 18/18 differential operation workload remains a
  separate secondary signal.
- cookie 2.0.1: all 4 upstream Vitest files and all 63,740 expanded callbacks
  run. **63,625/63,672** natively reproducible cases pass in Wasm. The 68
  top-site snapshot cases are explicitly harness-incompatible until the
  snapshot adapter is implemented; they are not counted as passes. Both
  stringify files are fully green (63,625/63,625); the 47 scored failures are
  in parse modules, including an invalid `parse-set-cookie` Wasm module.
- marked 18.0.2: the complete 6-file unit inventory is pinned. An adapter
  experiment reached the original Hooks callbacks, but a full bounded run was
  still too slow in the Lexer/Parser compilation phase. The experiment is not
  shipped as a runnable adapter and no pass-rate claim is made.

The npm-compat generator now publishes the clsx and cookie upstream-suite
scores and pins directly. Remaining packages with no runtime adapter stay
explicitly `adapter-pending`; the next slices should expand the unified runner
in ascending harness complexity (Redux/Axios first, then jsdom/Prettier and the
large compiler/tooling suites).

## 2026-08-20 Redux complete runtime suite

Redux 5.0.1 now uses all nine original `*.spec.ts` runtime files from
`reduxjs/redux@v5.0.1` (commit
`50b010210df25c470386f7e39a9389a4a77b3842`). All 82 callbacks register and
all nine generated test modules compile to valid Wasm. The shared runner now
supplies the Node-compatible `global` alias used by Redux's warning tests, so
the synchronous Node oracle reproduces all **82/82** callbacks. The measured
Wasm baseline is **13/82**; the remaining failures are runtime/compiler
mismatches in the existing `bindActionCreators`, `combineReducers`, and
`createStore` paths rather than unavailable test infrastructure. The existing
1/1 package API workload remains visible as a separate secondary result.

Vitest's spy/assertion surface and the one RxJS protocol test use narrow test
infrastructure shims; the original callback bodies and inputs are unchanged.

## 2026-08-14 Axios synchronous unit slice and publication contract

Axios 1.16.1 now verifies the complete 49-file `tests/unit/**/*.test.js`
inventory and its 645 static registration sites at
`axios/axios@v1.16.1` (commit
`1337d6b537afb2d3f501074c8ac4ef4308221197`). The first runtime adapter selects
25 self-contained synchronous files: **170/170** callbacks pass in Node, all 25
generated modules compile and validate, and **16/170** pass in Wasm. Two
callbacks reach differing assertions; the other 152 scored failures are
module-level runtime traps. The remaining 24 files are counted as deferred and
require async execution plus HTTP server/socket/stream/filesystem test
infrastructure.

This result is not a local-only report. The main npm-compat generator invokes
the Axios adapter and writes its upstream counts into the Axios card. The
merge-only `npm-compat-refresh.yml` workflow now derives the set of configured
suite adapters from `npm-compat-upstream-sources.json` and refuses to publish
if any adapter lacks numeric pass/total results. This also protects the Redux,
clsx, cookie, and pre-existing upstream lanes from silently reverting to
`adapter pending` on `npm-compat.html`.

## 2026-08-14 Prettier synchronous source-unit slice

Prettier 3.8.1 now verifies all 20 top-level `tests/unit/*.js` files and 48
static registration sites from `prettier/prettier@3.8.1` (commit
`90983f40dce5e20beea4e5618b5e0426a6a7f4f0`). The first runtime adapter runs
the three self-contained synchronous files `ast-path.js`, `errors.js`, and
`make-string.js` without rewriting their callback bodies or inputs. All three
generated modules compile and validate, all **8/8** callbacks pass in native
Node, and **1/8** passes in Wasm.

The seven measured failures are useful compatibility evidence rather than a
gate: the four `AstPath` callbacks trap with `illegal cast`, while the three
custom `Error` subclasses expose the existing builtin-subclass/name gap
([#1366a](https://github.com/loopdive/js2wasm/blob/main/plan/issues/1366a-class-extends-error-builtin-subclassing.md),
[#2962](https://github.com/loopdive/js2wasm/blob/main/plan/issues/2962-native-error-identity-stringification.md)).
The remaining 17 source files are explicitly deferred for async plugin loading,
snapshots, Node-only helpers, external development dependencies, or larger
document/parser graphs. The npm-compat generator now publishes this score, and
the merge-only workflow's configured-suite guard requires the numeric Prettier
result before it can update `npm-compat.html`.

## 2026-08-14 Marked Hooks source-unit slice

Marked 18.0.2 now verifies the complete six-file `test/unit/*.test.js`
inventory and 181 static registration sites from `markedjs/marked@v18.0.2`
(commit `c4f4529d69d254458831f3c22187d080db2f3c83`). The first runtime adapter
runs the original 30-callback `Hooks.test.js` file against the matching
published `marked.esm.js` build. Native Node reproduces **15/30** callbacks;
the 15 promise-returning callbacks are explicitly harness-incompatible until
the shared Wasm runner supports async tests.

The generated implementation module compiles in about eight seconds but fails
Wasm validation in an object-method trampoline, so **0/15** synchronously
reproducible callbacks execute successfully. The npm-compat card records this
as blocked, carries all 15 implementation-invalid tests and the exact validator
message, and still publishes numeric pass/total fields for the workflow
contract. The five heavier Lexer, Parser, CLI, instance, and full marked files
remain explicit deferred inventory rather than disappearing from the report.

## 2026-08-14 Stylelint synchronous utility slice

Stylelint 17.14.1 now verifies all 281 matching files under `lib/**/__tests__`
and their 1,574 static `it()`/`test()` registration sites from
`stylelint/stylelint@17.14.1` (commit
`cd66b035087270dd62d33542154463266cc5e81a`). The first runtime adapter runs
five dependency-light original utility test files without changing their
callbacks or inputs. All five generated modules compile and validate, native
Node passes **9/9**, and Wasm passes **7/9**.

Both remaining callbacks are in `arrayEqual.test.mjs` and trap with `illegal
cast`; this is a real mixed-array runtime gap rather than missing runner
infrastructure. The other 276 inventory files remain explicitly deferred. The
npm-compat generator invokes the runner directly, so the merge-only refresh
publishes the 7/9 result and the configured-suite guard rejects a missing or
`adapter pending` Stylelint row.

## 2026-08-14 Three.js MathUtils QUnit slice

Three.js r185 now verifies all 232 `test/unit/src/**/*.tests.js` files and 1,313
QUnit registration sites from `mrdoob/three.js@r185` (commit
`2431a09f46f34c560bc8e44b33be0e567723d5b9`). The first runtime adapter runs
the original dependency-light `MathUtils.tests.js` module directly against the
matching GitHub source. Its generated module compiles and validates, native
Node passes **18/18**, and Wasm now reports **17/18**.

The adapter preserves Three's default-exported `QUnit.module(...)` call as a
top-level registration side effect; otherwise the compiler elided the unused
default value and the Wasm lane observed zero registered tests. The remaining
single failure is a floating-point last-bit difference in `MathUtils.damp`, not
missing test infrastructure. All 231 deferred browser, WebGL, DOM, loader, and
larger object-graph files remain explicit inventory. The npm-compat generator
invokes the suite directly, so the merge-only refresh publishes the numeric
result and upstream pin rather than leaving Three.js at `adapter pending`.

## 2026-08-14 jsdom VirtualConsole slice

jsdom 30.0.1 now verifies the complete 17-file `test/api/*.js` inventory and
all 318 static registration sites from `jsdom/jsdom@v30.0.1` (commit
`6584485f094d5b271553005b68804c93a455c002`). The first runtime adapter selects
six unchanged synchronous callbacks from `virtual-console.js` which exercise
`VirtualConsole.forwardTo()` without constructing a DOM. They run against the
matching published `lib/jsdom/virtual-console.js`; its Node `events` dependency
is left at the platform boundary rather than replaced with a harness fake.

The selected module compiles and validates in about three seconds. Native Node
and Wasm now both pass **6/6** callbacks. The five former `on is not a
function` failures are fixed by the shared callable class-method projection
bridge for host-provided `EventEmitter` instances; the invalid-option callback
continues to pass without registering a listener. The upstream regression test
now asserts the complete 6/6 result instead of only checking that callbacks
were scored.

The remaining 312 registrations, including full DOM construction, resource
loading, and asynchronous cases, remain explicit deferred coverage. The
npm-compat generator invokes this adapter directly and publishes its numeric
pass/total result on merge; the workflow guard rejects a missing or pending
jsdom suite row.

## 2026-08-14 styled-components synchronous utility slice

styled-components 6.4.4 now verifies the complete 41-file source-unit
inventory and 668 static registrations from the matching
`styled-components@6.4.4` release tag (commit
`5f69a304df5de81aae114928dcd98896c627c94a`). The first runtime adapter runs
the original `addUnitIfNeeded`, `escape`, and `hyphenateStyleName` utility test
files directly against their pinned release-source
implementations, without changing callback bodies or inputs.

All three generated modules compile and validate. Native Node passes **6/6**
callbacks and Wasm also passes **6/6**. The native oracle normalizes the pinned
monorepo's extra CommonJS default-export wrapper; the compiled source uses the
release module directly, and both paths execute identical callback bodies.

React, DOM, snapshot, SSR, Stylis, and larger object-graph files remain
explicit deferred inventory. The npm-compat generator invokes the adapter
directly so the merge-only refresh publishes numeric results and cannot fall
back to `adapter pending`.

## 2026-08-14 Jest get-type slice

Jest 30.4.2 now verifies all 241 matching files under
`packages/**/__tests__` and 3,288 static registrations from
`jestjs/jest@v30.4.2` (commit
`746f2a0f57c56e3bba555280f0587d40f3db95c0`). The first runtime adapter runs
the original `@jest/get-type` `getType` and `isPrimitive` test files directly
against their matching release-tag TypeScript implementation without changing
callback bodies or inputs.

Both selected modules compile and validate. Native Node passes **32/32**
callbacks and Wasm passes **16/32**. The failures share a representation cause:
several primitive values reach the generic `unknown` helper boxed as objects,
so JavaScript `typeof` and `Object(value) !== value` checks misclassify them.
The native oracle also confirmed all 32 callbacks after the shared `test.each`
shim learned to distinguish a table of scalar cases from a table of tuples.

Runner, snapshot, filesystem, worker, async, DOM, and larger package graphs
remain explicit deferred inventory. The npm-compat generator invokes the
adapter directly so the merge-only refresh publishes numeric results and
cannot fall back to `adapter pending`.

## 2026-08-14 Tailwind CSS segment utility slice

Tailwind CSS 4.3.3 now verifies all 42 matching tests under
`packages/tailwindcss` and 1,376 static registrations from
`tailwindlabs/tailwindcss@v4.3.3` (commit
`c2b24dd15fed1c59dd521bd86082f520c9f5ad0d`). The first runtime adapter runs
the original `segment.test.ts` and `to-key-path.test.ts` callbacks directly
against their matching release-tag TypeScript implementations without changing
callback bodies or inputs.

The adapter registers 13 callbacks. All 13 pass in native Node and all 13 pass
after compiling the release-tag sources and original callbacks to Wasm.

Scanner, Rust/native, CSS pipeline, snapshot, async, UI, and larger graph files
remain explicit deferred inventory. The npm-compat generator invokes the
adapter directly so the merge-only refresh publishes numeric results and
cannot fall back to `adapter pending`.

## 2026-08-14 TypeScript base64 slice

TypeScript 5.9.3 now verifies all 256 files and 1,761 static registrations under
`src/testRunner/unittests` from `microsoft/TypeScript@v5.9.3` (commit
`c63de15a992d37f0d6cec03ac7631872838602cb`). The first runtime adapter runs the
original `base64.ts` callback unchanged. At setup time it projects the exact
base64 declarations from the matching release's `src/compiler/utilities.ts`,
avoiding the unrelated full compiler graph that exceeds the bounded catalog
compile budget.

The adapter registers one callback. It passes in native Node and after the
release-tag source and original callback are compiled to Wasm.

The remaining 255 compiler, server, watch, evaluator, snapshot, async, and
filesystem-heavy files remain explicit deferred inventory. The npm-compat
generator invokes this adapter directly, so the merge-only refresh publishes a
numeric result and cannot fall back to `adapter pending`.

## 2026-08-14 complete workflow wiring

All 24 packages rendered on npm-compat now declare an executable `suiteScript`.
The report generator uses one registry for those 24 adapters and refuses to
start if the configured and executable package sets differ. Catalog packages
no longer pass through a nullable conditional chain that could silently fall
back to `adapter pending` after an adapter had shipped.

The merge-only npm-compat workflow independently rejects its generated artifact
unless every configured adapter produces numeric `passed` and `total` fields.
Performance measurements and regressions remain reporting data rather than unit
test gates.

The complete `generate:npm-compat --no-write` path was run locally after this
wiring change. It completed all 24 packages, left one numeric suite report per
package, and exited successfully. Its aggregate correctness rollup reported 8
verified, 14 divergent, and 2 unverified packages; those compatibility gaps are
reported data, not hidden or converted into performance gates.

## 2026-08-14 webpack synchronous utility slice

webpack 5.109.2 now verifies all 98 top-level `test/*.unittest.js` files and
1,357 static registrations from `webpack/webpack@v5.109.2` (commit
`6a24bd65b72c43207c36ce61b54e1f5833486906`). The first runtime adapter runs
the original `ArrayHelpers`, `formatSize`, and `objectToMap` unit files against
their matching published CommonJS implementations without changing callbacks
or inputs.

All three generated modules compile and validate. Native Node passes **16/16**
callbacks and Wasm passes **13/16**. Both `ArrayHelpers.groupBy` callbacks trap
with `illegal cast` on their nested array results. The remaining failure is
`formatSize(undefined)`, where Wasm produces `0 bytes` instead of Node's
`unknown size`; the `objectToMap` callback passes.

Compiler, filesystem, loader, snapshot, async, and larger graph files remain
explicit deferred inventory. The npm-compat generator invokes the adapter
directly so the merge-only refresh publishes numeric results and cannot fall
back to `adapter pending`.

## 2026-08-20 non-blocking Vitest launcher infrastructure

Opt-in Vitest wrappers now share `tests/dogfood/run-dogfood-script.ts`. It
launches every adapter with Node's explicit `--import tsx` loader and awaits
the child process, so long Wasm compiles no longer block the Vitest worker
heartbeat or use tsx's restricted IPC socket. The package scripts and wrapper
tests are covered by `dogfood-launchers.test.ts`.

The React upstream wrapper passes its full local gate (7/7 wrapper tests), the
bounded ReactDOM wrapper passes 4/4 with no worker timeout, and the complete
Redux callback inventory runs through the same path: 82/82 admitted and
scored, 9/9 modules compile and validate, 13 Wasm passes, 69 semantic
failures, and zero runtime failures. The remaining Redux failures are
compiler semantics, not unavailable runner infrastructure.

## 2026-08-20 React cross-package infrastructure checkpoint

The React upstream adapter now preserves each source test file's strict-mode
boundary when lifting individual Jest callbacks. It also supplies the
original `create-react-class/factory` module and routes the indirect factory
call through a callable host facade that reifies only the class specification
object. This is host/test infrastructure, not a change to React's upstream
test bodies.

On the unchanged 273-test React inventory, the full local run now executes
272 admitted tests and scores **102/179** in Wasm (up from 92/178); the native
oracle's infrastructure-incompatible bucket fell from 94 to 93. The
create-react-class slice specifically moved from 0/16 to **10/16** scored
passes. The remaining React failures are compiler/runtime behavior or
development-build warning differences, not silently skipped infrastructure.

The shared JSDOM setup also now installs the browser constructors and standard
web globals referenced by the ReactDOM corpus (image/table/media elements,
streams, encoders, fetch types, files, and abort primitives). Node-owned
`performance`, `queueMicrotask`, and `setImmediate` remain untouched because
JSDOM's implementations delegate back to those globals and copying them would
recurse. The setup test covers representative constructors and stream/fetch
globals. The host dependency resolver now also searches pnpm peer-dependency
roots, so ReactDOM's upstream `scheduler` and `scheduler/unstable_mock`
imports resolve to the installed package even though the workspace root does
not expose a direct symlink.

The upstream runner also accepts `DOGFOOD_REACT_BUILD=development`. This uses
the published `react.development.js` artifact and loads ReactDOM and the test
renderer under the matching `NODE_ENV`, which is the environment used by
React's Jest suite. The default npm-compat lane remains the production build;
the development option gives the original warning and `act` tests a faithful
renderer pair instead of treating production-build differences as unavailable
host infrastructure. The selected build is recorded in the JSON report.

The first development-build probe (80 filtered upstream tests) is intentionally
recorded as a compiler finding: the native oracle ran, but all 80 Wasm batches
hit the existing stack-balance/local-index invariant in the development graph,
so **0/61** tests were scoreable. This does not change the default production
result or turn an invalid binary into an infrastructure pass; the opt-in lane
is retained to make the correct upstream environment runnable once that
compiler blocker is addressed.

## 2026-08-20 Hono web-host and Vitest infrastructure checkpoint

The Hono adapter now exercises ten self-contained HTTP/utility files from the
pinned v4.12.16 release instead of the original two-file smoke slice:
`http-exception`, `request`, `accept`, `basic-auth`, `cookie`, `encode`, `html`,
`ipaddr`, `mime`, and `url`. All **205/205** extracted callbacks execute in the
native oracle, and the ten modules compile; nine validate because the upstream
`ipaddr` module still exposes an existing Wasm fall-through type error. The
validated Wasm modules score **78/205**. The remaining failures are compiler or
runtime semantics (URL decoding, request-body/object carriers, cookie signing,
binary encoding, and IPv4/IPv6 conversion), not unavailable test infrastructure.

The shared upstream runner now supports Vitest table-template expansion,
`describe.each`, promise `resolves`/`rejects` matchers with immediate rejection
handlers, `toMatchObject`, and Vitest's compile-time-only `expectTypeOf` chain.
The runtime host constructor registry also exposes the standard Node Web API
constructors (`Request`, `Response`, `FormData`, `Blob`, and `File`) when they
exist on `globalThis`, allowing Hono's original request tests to initialize in
both Node and Wasm. These adapters are generic and are covered by a runner
regression test; no Hono test callback or input is rewritten.

The ReactDOM adapter now has the same explicit build selection as the React
adapter: production remains the npm-compat default, while
`DOGFOOD_REACT_DOM_BUILD=development` loads the matching development React,
ReactDOM client, legacy server, and browser/Node/Edge Fizz graphs. This is
important for the original warning and `act` tests: production artifacts omit
those diagnostics, which otherwise appears as unavailable native test
infrastructure. The selection is pin-checked and covered by the ReactDOM
setup regression test; it does not change the production catalog result.

## 2026-08-20 final package checkpoint and handoff

The jsdom VirtualConsole slice now runs its six selected original callbacks
through both oracles: native Node **6/6** and Wasm **6/6**. The former five
`on is not a function` failures were the shared callable host-method bridge,
not jsdom test defects. The remaining jsdom registrations stay explicitly
deferred because they require the full DOM/resource/async graph.

The Three.js MathUtils slice now preserves the upstream default-exported
`QUnit.module` registration side effect. Native Node is **18/18** and Wasm is
**17/18**; the one remaining `MathUtils.damp` mismatch is a last-bit floating
point difference, not unavailable infrastructure. The other 231 upstream
files remain deferred browser/WebGL/loader coverage.

The long landing-four-lane CI probe in this work was changed to await its
child process instead of blocking Vitest's worker heartbeat; the focused core
probe passes locally. Keep this CI plumbing in PR #4660 and treat the Lit
compiler gaps in #3977/#3978/#3979/#3980 as the next independent work item.

## 2026-08-21 shared matcher infrastructure checkpoint

The shared upstream assertion shim now implements Vitest's `instanceOf` and
`toBeInstanceOf` aliases in both positive and negated form, plus the positive
`toBeCalled` and `toHaveBeenCalled` spy aliases. These are generic runner
features, covered by `upstream-suite-runner.test.ts`; they are not Hono-specific
rewrites. Before this change Hono's `utils/body.test.ts` was incorrectly
classified as harness-incompatible because the native oracle could not call
`expect(value).not.instanceOf(...)`.

Rerunning the unchanged 16-file Hono selection after the shim fix produced
**297/297 native callbacks** (previously 296/297 with one harness error), all
16 modules compiled, 15 validated, and **86/297 Wasm callbacks passed**. The
remaining 211 Wasm failures and six module-init runtime failures are compiler
or runtime semantics; they are now scored rather than hidden as unavailable
infrastructure. The full 120-file inventory and 2,058 deferred registrations
remain explicit in the report.

The same generic runner now exposes `it.skip`/`test.skip`, `todo`, and skipped
suite registration semantics. This admits Hono's original Node-facing
`utils/buffer.test.ts` and `utils/crypto.test.ts` without changing their
callbacks. The compile worker also forwards the host's standard Web
constructors when a suite explicitly selects the Node platform. The expanded
18-file selection registers **311/311 native callbacks**, compiles 18 modules
(17 validate), and scores **90/311 Wasm passes**; the two intentionally skipped
upstream callbacks remain outside the denominator. The unresolved TextEncoder
and crypto behavior is reported as Wasm compatibility failure, not relabeled as
unavailable infrastructure. Deferred inventory is now 2,044 registrations.

## 2026-08-21 Vitest global-stub infrastructure checkpoint

The shared upstream shim now implements Vitest's generic `vi.stubGlobal` and
`vi.unstubAllGlobals` contract. Each stub records whether the global was an
own property and restores or deletes it in reverse order, so upstream tests can
temporarily install browser/platform globals without leaking state into later
callbacks. The runner regression test exercises the complete install/restore
cycle in both Node and Wasm.

Hono's unchanged `src/helper/testing/index.test.ts` is now admitted. The
expanded 19-file selection registers **316/316 native callbacks** (up from
311/311), compiles 19 modules (18 validate), and records **90/316 Wasm passes**.
The five new callbacks still expose existing Hono route/object compiler
failures; only the former `vi.stubGlobal is not a function` harness failure was
removed. Deferred inventory is now 2,039 registrations.

## 2026-08-21 Vitest environment-stub checkpoint

The shared upstream shim now gives `vi.stubEnv` and `vi.unstubAllEnvs` real
Vitest-style save/restore behavior. Each environment write records the prior
own-property state and restores or deletes it in reverse order. A runner
regression covers the contract without depending on a host-only process
global.

Hono's original `src/helper/dev/index.test.ts` is now admitted because its
`NO_COLOR` setup/teardown no longer leaves the process environment mutated.
The unchanged selection registers **324/324 native callbacks** (up from
316/316), compiles all 20 modules (18 validate), and leaves the Wasm score at
**90/324** while the two invalid modules remain compiler findings. Deferred
inventory is now **2,031** registrations. The native oracle was run with
`NO_COLOR` unset so the upstream color expectations are not contaminated by
the local shell environment.

## 2026-08-21 Jest module-isolation infrastructure checkpoint

The React/ReactDOM upstream shim now implements `jest.isolateModules()`. Each
isolated callback gets a fresh namespace object for every required module, the
same namespace is reused for repeated requires within that callback, and the
outer registry is restored when the callback returns. This supplies the
identity contract used by ReactDOM's original selective-hydration and event-
propagation tests without mutating Node's process-wide require cache or
rewriting either test.

The new regression exercises the exact contract in both the native oracle and
compiled Wasm: two isolated `react-dom/client` requires are distinct, each is
distinct from the outer namespace, and repeated outer requires remain stable.
The remaining ReactDOM implementation/compile blockers are unchanged; this
checkpoint removes a harness gap so those original callbacks can be scored as
soon as their published graph validates.

The same host surface now supplies React's original `IntersectionMocks` helper:
observer registration and teardown, simulated intersection entries, and
`getBoundingClientRect`/`getClientRects` stubs. `IntersectionObserver` is also
registered in the generic Web-host constructor table so compiled code sees the
same host class at module instantiation. The host behavior is covered directly
in Node and the compiled regression verifies the observer registration path.

The same build-time environment now supplies React's stable-package selectors
(`__VARIANT__` and `__EXPERIMENTAL__`) as `false`, and exposes the published
ReactDOM `HTMLNodeType` constants to the original tests. These are Jest/build
bindings, not package behavior; defining them prevents avoidable native
oracle failures while keeping the stable, non-experimental test branch.

## 2026-08-21 Jest utility-suite infrastructure checkpoint

The Jest adapter now admits four additional original release-tag test files:
`diff-sequences`, `jest-docblock`, `jest-diff`'s control-character utility, and
`jest-config`'s `stringToBytes` utility. The verified 30.4.2 checkout therefore
registers **234 callbacks across 12 files** (232/234 pass in the Node oracle),
and all 12 generated modules compile and validate. The Wasm lane passes
**113/232 native-compatible callbacks**; the other 119 remain scored failures,
not unavailable tests. The remaining **3,054 registrations** are explicitly
reported as unavailable infrastructure from the other 229 verified test files.

The missing `node:os` builtin is now in the generic Node host dependency set.
`jest-docblock`'s `detect-newline@3.1.0` CommonJS dependency is materialized
from the installed, lockfile-pinned source as an ESM adapter with a version and
source-hash check. A narrow namespace-import rewrite binds the static members
used by the original tests; no callback body or expected result is rewritten.
The two native snapshot cases remain harness-incompatible and the Wasm
semantic failures remain visible in the scored report.

## 2026-08-21 UUID common-suite CI checkpoint

UUID's existing pinned v14.0.1 runner is now part of the shared
`npm-small-upstream-suites.test.ts` package gate. The gate verifies the complete
official ten-file inventory and, when `DOGFOOD_UUID_UPSTREAM_SUITE=1`, runs all
**75/75 original callbacks** in both lanes: the Node oracle passes 75, all ten
modules compile and validate, and Wasm scores **10 passed / 65 failed**. The
failures remain visible compatibility findings (WebCrypto typed-array
crossing, missing global `crypto`, UUID parsing/exception semantics, and the
v3/v5 hash path); none are relabeled as unavailable infrastructure.
