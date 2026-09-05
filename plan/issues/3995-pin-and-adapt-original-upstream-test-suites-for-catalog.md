---
id: 3995
title: "npm-compat: pin and adapt original upstream test suites for catalog packages"
status: ready
created: 2026-07-30
updated: 2026-08-26
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ci
language_feature: n/a
goal: dogfood
sprint: Backlog
horizon: m
related: [1058, 3587, 3672, 3958, 3982, 3997, 3999, 4000, 4287, 4299, 4301, 4302, 4303, 4756]
oracle-ratchet-allow:
  # The Hono fix compares the actual registered Wasm carriers for two inferred
  # anonymous object literals. TypeOracle deliberately exposes only
  # registry-free facts, so it cannot answer whether their concrete typeIdx
  # values match; keep this exact representation query at the codegen seam.
  - src/codegen/literals.ts
  # Async continuation planning needs declaration identity to prove a callable
  # is a lexical `const`, plus the exact resumed AwaitExpression type to keep
  # the synthetic delivery local ABI aligned. TypeOracle intentionally does
  # not expose symbols, declaration lists, resolved signatures, or ValTypes.
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/literals.ts
  - src/codegen/index.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/control-flow.ts
  # Hono's typed-array carrier keeps the ArrayBuffer overload and `.buffer`
  # identity without exposing TypedArray-only properties on ordinary vecs.
  # Its route-table spread also needs a runtime-sized native/host copy path;
  # the implementation is isolated below the array-method dispatcher.
  - src/codegen/array-methods.ts
  - src/codegen/type-coercion.ts
  - src/codegen/statements/variables.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/compiler.ts
  - src/codegen/extern-declarations.ts
  # Hono's recursive middleware dispatcher needs the already-structured async
  # CFG to admit conditional-owned awaits, with one shared nested-declaration
  # activation decision for reservation and final body compilation.
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
  - src/codegen/statements/nested-declarations.ts
  # The completed trailing-slash path preserves class-expression private
  # receiver identity, dynamic void-cleared fields, and bounded async call
  # continuations across the generic class/expression seams.
  - src/codegen/class-bodies.ts
  - src/codegen/expressions.ts
  - src/codegen/expressions/helpers.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls-optional.ts
func-budget-allow:
  # The dispatcher adds one narrow selector for `vec.push(...runtimeSource)`;
  # the runtime-sized copy lives in extracted helpers below the switch.
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/calls.ts::compileIIFE
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/identifiers.ts::compileHostInstanceOf
  - src/runtime.ts::_safeSet
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/type-coercion.ts::buildVecFromExternref
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/closures.ts::compileLiftedClosureBody
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
  - src/codegen/extern-declarations.ts::registerBuiltinExternClasses
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  # A nested await continuation installs its delivered-value alias only while
  # compiling the corresponding resume state, then restores the prior map.
  - src/codegen/async-frame.ts::buildStateBody
  - src/codegen/expressions.ts::compileExpressionInner
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

## 2026-08-26 PR quality and equivalence audit

The combined upstream-suite branch exposed two generic boundary regressions
before it could land:

- the host-call fallback for `identifier.call/apply` also claimed the
  non-callable `Reflect` namespace, so `Reflect.apply(...)` emitted legacy
  `__js_array_new`/`__js_array_push` imports instead of its native-first
  boundary lowering. The fallback now requires a callable or genuinely
  dynamic receiver type;
- plain struct materialization was applied to every extern constructor
  argument. That correctly made `new Response(body, init)` dictionaries
  visible to the host, but cloned the target of `new WeakRef(target)` and
  broke its round-trip Wasm struct identity. Materialization is now limited to
  the second `Request`/`Response` Web IDL dictionary argument.

The policy gate was then remeasured rather than widened speculatively. The
intentional TypedArray instance-wiring import is documented in
[#4360](https://github.com/loopdive/js2wasm/blob/main/plan/issues/4360-host-arraybuffer-copy-typedarray-views.md): native-first imports move exactly
393 to 394, with legacy-semantic and unknown imports still zero. The runtime
support added by this package-compatibility slice moves `src/runtime.ts` from
the previous 17,949-line ceiling to the measured 18,188 lines. The baseline is
set to that exact count; the resolveImport, adapter, capability, legacy, and
unknown ceilings are unchanged.

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

## 2026-08-22 styled-components utility expansion

The styled-components adapter now includes the original
`generateAlphabeticName.test.ts` utility file and registers **9/9** callbacks
across four dependency-light utility files. Native Node and Wasm both pass all
9 callbacks. The shared upstream assertion shim now supports the string form
of Vitest's `toMatchInlineSnapshot`, and the adapter provides the pinned
release version fixture used by styled-components' build-time `__VERSION__`
constant. The remaining 37 files and 659 registrations stay visible as
unavailable infrastructure; React, DOM, snapshot, SSR, Stylis, and larger
object-graph coverage is not counted as passing.

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

## 2026-08-22 ESLint expansion handoff

The shipped ESLint adapter remains the one-file `deep-merge-arrays.js` slice:
the unchanged upstream callbacks register and pass **44/44** in both the Node
oracle and Wasm lanes, and its module compiles and validates.

A local infrastructure experiment extracted five original ESLint v10.0.3
utility files (`deep-merge-arrays.js`, `naming.js`, `option-utils.js`,
`serialization.js`, and `string-utils.js`). The native oracle registered and
passed **158/158** callbacks, and all five modules compiled and validated.
The generalized adapter is intentionally published only as a draft: its Wasm
binding/import strategy causes registration mismatches (including 0/59, 0/18,
and 4/23 registered callbacks in three files) and does not reproduce the
native result set. No Wasm score claim should be made for this experiment, and
the mismatches must not be relabeled as unavailable infrastructure.

Follow-up work should preserve the per-file original test bodies while using
direct named-import adapters or otherwise matching module-init execution
semantics before this selection is made publishable. The experiment changes
only adapter/pin infrastructure; it does not modify ESLint source or test
expectations.

## 2026-08-22 Jest fake-timer infrastructure checkpoint

The shared Jest/Vitest runner now provides deterministic `jest.useFakeTimers`,
`jest.useRealTimers`, timer advancement/clearing, async timer aliases, clock
inspection/setting, and spy cleanup. Fake timers are
implemented in the test environment rather than replacing the harness's own
clock, so Wasm async handoff and the Node oracle continue to make progress.
Bare `setTimeout`/`clearTimeout` names route through the same fake queue, and
timer spy matchers use a scalar call-count bridge because Wasm function
properties are not a reliable storage location.

The runner regression exercises scheduling, draining, spy observation, and
cleanup in both lanes: **1/1 native**, the module compiles and validates, and
**1/1 Wasm** passes. The unchanged original
`jest-jasmine2/src/__tests__/pTimeout.test.ts` is now selected. Its **3/3**
callbacks pass in the Node oracle, compile and validate, and are scored in
Wasm; all three currently expose compiler/runtime async-function-reference
failures rather than unavailable infrastructure. The Jest inventory is now
**237 callbacks across 13 files**, with **235 admitted** and **109/235 Wasm**
passes. The remaining **3,051 registrations** from 228 verified files remain
explicitly reported as unavailable infrastructure.

## 2026-08-22 ESLint assertion-binding checkpoint

The binding mismatch was narrowed to the assertion shim, not the published
ESLint utility exports. The old shim attached `strictEqual`, `deepStrictEqual`,
`isTrue`, and `isFalse` as properties on a callable function. Node observes
those properties, but the Wasm function representation does not retain them;
the result was a false **0/158** score even when the utility returned the right
value. The adapter now keeps the callable assertion and exposes its methods on
an ordinary object, with the generated source binding method calls to that
object. The original callback bodies and inputs remain unchanged.

Measured on the five-file selection: **158/158 native**, all five modules
compile and validate, and **50/158 Wasm** currently pass. The deep-merge unit
is restored to **44/44 Wasm**; the remaining failures are real compiler/runtime
gaps in typed reference-array higher-order functions and serialization helpers,
with per-file failure summaries retained in the generated report. The adapter
is still draft-only until those gaps are either fixed or explicitly scoped in
follow-up issue slices; they are compatibility findings, not unavailable
infrastructure.

## 2026-08-22 generic Node host dependency checkpoint

The isolated upstream-suite worker previously forwarded only ten Node builtin
namespaces. The verified Hono and jsdom source inventories also import
`node:fs`, `node:fs/promises`, `node:http`, `node:https`, `node:child_process`,
`node:dns`, `node:vm`, `node:worker_threads`, and related platform modules.
The host dependency surface is now expanded explicitly for opt-in
`DOGFOOD_NODE_HOST_DEPS=1` runs, without changing the default web lane or
standalone compilation. A regression fixture imports `node:fs`, reads its own
generated source through the real host binding, and instantiates successfully
through the worker. The same compiler path now removes only exact duplicate
adapter descriptors (the fs call's numeric coercion used to emit two identical
`__box_number` entries); descriptors that differ in arity or intent remain
visible to strict manifest validation. This is host setup coverage only; any
compiler, validation, or runtime mismatches in the upstream suites remain
scored as compatibility failures.

Implementation: [PR #4756](https://github.com/loopdive/js2/pull/4756).

## 2026-08-22 Jest internal-package resolution checkpoint

The Jest adapter now materializes the verified `@jest/get-type@30.1.0`
workspace package in the pinned checkout's `node_modules`. The package metadata
and source hash are checked against the release-tag source before the test
starts; the implementation bytes are unchanged. This closes the real package
name-resolution seam used by `jest-matcher-utils/src/Replaceable.ts` instead of
rewriting that import to a relative path.

The unchanged `Replaceable.test.ts` is now selected alongside the existing Jest
utility slice. The verified 30.4.2 inventory registers **251 callbacks across
13 files**: **249/249** admitted callbacks pass in the Node oracle, all 13
modules compile and validate, and Wasm scores **124/249**. The two original
snapshot callbacks remain harness-incompatible and the 125 Wasm failures are
scored compatibility findings. The remaining **3,037 registrations** from 228
verified files remain explicitly reported as unavailable infrastructure.

## 2026-08-22 Jest queue-runner package seam checkpoint

The original `jest-jasmine2/src/__tests__/queueRunner.test.ts` file is now
selected. Its `jest-util` package-name import is materialized as a
hash-verified ESM adapter exposing the release-tag `formatTime` implementation;
the six upstream callback bodies and timeout inputs are unchanged. The shared
Jest transform also strips type-only named imports from the native CommonJS
normalization path, so the Node oracle registers all six callbacks.

The exact run now covers **257 callbacks across 14 selected files**: Node
admits **255/255**, all 14 modules compile, 13 validate, and Wasm scores
**124/255**. The queue-runner module's invalid Wasm is a compiler validation
finding (`call_ref` received one argument but requires two), not unavailable
package infrastructure; its six callbacks remain in the denominator and are
reported as compiler-blocked. The remaining **3,031 registrations** from 227
verified files remain explicitly reported as unavailable infrastructure.

## 2026-08-22 Jest merged-timer integration checkpoint

After rebasing this package-resolution and queue-runner work onto the landed
fake-timer infrastructure, the selected inventory includes both the original
`pTimeout.test.ts` timer unit and `queueRunner.test.ts`. The exact run now
covers **260 callbacks across 15 selected files**: Node admits **258/258**, all
15 modules compile, 14 validate, and Wasm scores **120/258**. The one invalid
queue-runner Wasm module remains a compiler validation finding, while the
remaining **3,028 registrations** from 226 verified files remain explicitly
reported as unavailable infrastructure.
## 2026-08-22 Jest collection-matcher checkpoint

The original `jest-jasmine2/src/__tests__/iterators.test.ts` and
`itToTestAlias.test.ts` units are now selected without changing their source.
The shared Jest matcher now distinguishes arrays from array-like objects and
implements recursive Set/Map equality, matching the collection semantics those
tests exercise. The exact run covers **242 callbacks across 15 selected
files**: Node admits **240/240**, all 15 modules compile and validate, and Wasm
scores **114/240**. The remaining **3,046 registrations** from 226 verified
files remain explicitly reported as unavailable infrastructure; other Wasm
failures remain compatibility findings rather than unavailable setup.

## 2026-08-22 Jest registration-API checkpoint

Three original `jest-jasmine2` units are now selected unchanged:
`itTestError.test.ts`, `todoError.test.ts`, and `hooksError.test.ts`. The shared
adapter now validates Jest test names and callbacks, implements the `it.todo` /
`test.todo` argument contract, validates all four lifecycle hooks, and lowers
Jest's curried `*.each(cases)(name, body)` registration shape to an equivalent
direct registration call for Wasm. The hook-error unit's dynamic global hook
lookup is routed through the same named hook functions; its assertion body and
inputs remain upstream source.

The exact run now covers **283 callbacks across 18 selected files**: Node admits
**281/283**, all 18 modules compile and validate, and Wasm scores **195/281**.
The remaining **3,005 registrations** from 223 verified files remain explicitly
reported as unavailable infrastructure; Wasm failures are compatibility findings,
not silently skipped tests.

## 2026-08-22 Jest current-main rebase checkpoint

After rebasing the registration-API slice over the landed package-resolution
and queue-runner work, the exact inventory includes those two earlier files as
well. It now covers **306 callbacks across 20 selected files**: Node admits
**304/306**, all 20 modules compile and 19 validate (the queue-runner Wasm
binary remains the known compiler validation finding), and Wasm scores
**206/304**. The remaining **2,982 registrations** from 221 verified files are
still explicitly reported as unavailable infrastructure.

## 2026-08-22 Jest chalk and configuration-unit checkpoint

The Jest checkout now resolves the real pinned `chalk@4.1.2` package name for
upstream sources. Its installed source hash is verified before materialization;
the adapter also wires the matching `ansi-styles@4.3.0`,
`supports-color@7.2.0`, and `has-flag@4.0.0` package seams, including the
`node:tty` host namespace. Chalk 4's prototype mutation currently lowers to an
invalid Wasm GC cast, so the adapter preserves the level-0 callable and chained
style API used by the Jest lane while leaving the color-model path explicitly
deferred.

The unchanged original `jest-config/src/__tests__/parseShardPair.test.ts` is
now selected. The exact run covers **315 callbacks across 21 selected files**:
Node admits **313/315**, all 21 modules compile and 20 validate, and Wasm
scores **215/313** (98 compatibility failures, zero runtime failures). The
remaining **2,973 registrations** from 220 verified files are explicitly
reported as unavailable infrastructure. The nine new parse-shard callbacks
pass in both lanes; no test body or expected input was rewritten.

## 2026-08-22 Jest global-process and concurrent-registration checkpoint

Two additional original release-tag units are now selected without changing
their callback bodies: `jest-core/src/__tests__/globals.test.ts` and
`jest-jasmine2/src/__tests__/concurrent.test.ts`. The generic Jest extractor
also recognizes the original `test.concurrent.each(...)` registration form and
routes it through the same per-callback runner; the compatibility lane scores
results serially because it compares behavior, not Jest's worker scheduling.

The exact run now covers **319 callbacks across 23 selected files**. Node
admits **317/319**, all 23 modules compile and 22 validate, and Wasm scores
**218/317**. All three concurrent callbacks pass in Wasm. The globals callback
runs in both lanes but fails its original `[object process]` assertion because
the current Wasm host exposes the process binding as a null-shaped value; this
is retained as a compatibility failure rather than relabeled as unavailable
infrastructure. The queue-runner module remains the sole invalid Wasm module.
The remaining **2,969 registrations** from 218 verified files remain explicit
unavailable infrastructure.

The same checkpoint also admits the original
`jest-haste-map/src/lib/__tests__/getPlatformExtension.test.js` utility unit.
Its single callback passes in both lanes. The exact inventory is now **320
callbacks across 24 selected files**: Node admits **318/320**, 24 modules
compile and 23 validate, and Wasm scores **219/318**. The unavailable
infrastructure remainder is **2,968 registrations** from 217 verified files.
An exploratory `jest-config/src/__tests__/Defaults.test.ts` was not admitted:
its original package graph requires the unmaterialized pinned `deepmerge`
dependency, so the Node oracle could not register the callback. That remains a
concrete dependency-resolution follow-up rather than a Wasm result.

## 2026-08-22 Jest defaults and Node-host seam checkpoint

The original `jest-config/src/__tests__/Defaults.test.ts` callback is now
admitted. Its assertion body is unchanged; the harness resolves its `defaults`
named export directly to the defining upstream `Defaults.ts` module so the
one-line unit does not eagerly load Jest's unrelated full config graph. The
adapter verifies the pinned `jest-config@30.4.2` source hash, makes the helper's
ambient `process` binding explicit, and uses the existing `node:os` namespace
for the cache-directory temporary path. The original `ci-info@4.4.0` and
`jest-regex-util@30.4.0` package seams are pinned and verified as well.

The exact run now covers **321 callbacks across 25 selected files**. Node
admits **319/321**, all 25 modules compile and 24 validate (queue-runner is
still the sole validation finding), and Wasm scores **220/319** with zero
runtime failures. The unavailable-infrastructure remainder is **2,967
registrations** from 216 verified files. The earlier deepmerge blocker is
superseded by this narrower public-entrypoint dependency seam; the old note is
retained above as the prior measured checkpoint.

The generated `Defaults.js2wasm.ts` and `getCacheDirectory.js2wasm.ts` files
are adapter copies beside the pinned upstream sources. They are recreated by
the setup step and are deliberately not written back into the upstream clone,
so a rerun cannot silently change the source under test.

Implementation: [PR #4764](https://github.com/loopdive/js2/pull/4764).

## 2026-08-22 Jest ANSI snapshot checkpoint

The shared Jest runner now loads pinned string snapshots from each selected
upstream `__snapshots__` file and matches them by the original test name. ANSI
escape sequences are normalized to the same serializer markers used by Jest;
the chalk adapter exposes explicit `dim` and `reset` styles, including the
empty-string behavior, so callable properties survive WasmGC lowering. The
original `jest-watcher/src/lib/__tests__/formatTestNameByPattern.test.ts` is
now selected unchanged.

The exact run covers **332 callbacks across 26 selected files**. Node admits
**330/332**, all 26 modules compile and 25 validate, and Wasm scores
**231/330** with zero runtime failures. The unavailable-infrastructure
remainder is **2,956 registrations** from 215 deferred files. All 11 watcher
snapshot callbacks pass in both lanes; the two existing Node-oracle failures
remain the process-shape assertion and queue-runner validation finding.

## 2026-08-22 Jest watcher scroll checkpoint

The original `jest-watcher/src/lib/__tests__/scroll.test.ts` is now selected
unchanged. It needs no package adapter: the existing runner and project
resolver are sufficient for all five callbacks.

The exact run now covers **337 callbacks across 27 selected files**. Node
admits **335/337** (the two existing diff-sequence snapshot-oracle failures),
all 27 modules compile and 26 validate, and Wasm scores **236/335** with zero
runtime failures. The unavailable-infrastructure remainder is **2,951
registrations** from 214 deferred files. All five scroll callbacks pass in
both lanes.

## 2026-08-22 Jest haste-map mock-name checkpoint

The original `jest-haste-map/src/__tests__/get_mock_name.test.js` is now
selected unchanged. Its `node:path` import is already covered by the host
namespace, so no package-specific adapter is needed; the callback passes in
both lanes.

The exact run now covers **338 callbacks across 28 selected files**. Node
admits **336/338** (the two existing diff-sequence snapshot-oracle failures),
all 28 modules compile and 27 validate, and Wasm scores **237/336** with zero
runtime failures. The unavailable-infrastructure remainder is **2,950
registrations** from 213 deferred files.

## 2026-08-22 Jest array-subset matcher checkpoint

The shared `toMatchObject` implementation now handles arrays with Jest's
same-length element-by-element subset semantics. This admits the original
`jest-core/src/__tests__/FailedTestsCache.test.js` unchanged; its expected
array of failed test paths now matches the real returned test objects in both
lanes.

The exact run now covers **339 callbacks across 29 selected files**. Node
admits **337/339** (the two existing diff-sequence snapshot-oracle failures),
all 29 modules compile and 28 validate, and Wasm scores **238/337** with zero
runtime failures. The unavailable-infrastructure remainder is **2,949
registrations** from 212 deferred files.

## 2026-08-22 Wasm callback and process compatibility checkpoint

The next original unit was admitted without changing its test body:
`packages/jest-watcher/src/lib/__tests__/prompt.test.ts`. Its four callbacks
now pass in both lanes. The adapter also exposes the minimal Node `process`,
`stdout`, and `stderr` surface used by the original prompt and globals tests.

The Wasm runtime fix is generic: host-method dispatch now uses
`Reflect.apply`, which supports `WebAssembly.Function` values that are
callable but do not have a JavaScript `.apply` property. The Jest shim records
spy calls in flat scalar/argument vectors; nested WasmGC vectors can be copied
at a host boundary and otherwise report stale lengths. This keeps the matcher
oracle backed by actual callback invocations rather than a cached or
synthetic result.

Exact unchanged run:

```text
DOGFOOD_JEST_UPSTREAM_SUITE=1 node --import tsx tests/dogfood/jest-upstream-suite.mjs --json
```

- 343 callbacks across 30 selected files; 211 files and 2,945 registrations remain deferred as unavailable infrastructure;
- Node oracle: 341/343 registered callbacks pass (the two existing diff-sequence oracle failures remain);
- compile: 30/30 modules succeed and 29/30 validate;
- Wasm: 243/341 scored tests pass, 98 fail, 0 runtime failures;
- the newly admitted `jest-watcher` prompt unit is 4/4 in Wasm.

Focused Vitest, typecheck, issue-id, formatting, and diff checks remain the
required follow-up gates. This is still a measured selected slice, not a claim
that Jest's deferred runner, worker, DOM, or filesystem suites are complete.

Implementation: [PR #4767 — bridge WebAssembly callbacks in prompt tests](https://github.com/loopdive/js2wasm/pull/4767).

## 2026-08-22 Jest Node-global and dependency-resolution checkpoint

The next original release-tag unit, `jest-environment-node/src/__tests__/globals_cleanup_3.test.ts`, is now selected unchanged. It exercises the
Node-global cleanup path using `Object.getOwnPropertyDescriptors` and passes in
both the native oracle and compiled Wasm without a package-specific adapter.

The same run exposed a real cross-lane infrastructure mismatch: Vitest's
`NODE_PATH` supplied `graceful-fs` to Jest's queue-runner unit, while the direct
npm-compat process did not. The adapter now verifies pinned `graceful-fs@4.2.11`
bytes and materializes an explicit ESM host-capability package exposing the
`node:fs` `realpathSync` surface consumed by Jest's upstream `tryRealpath`
implementation. The original queue-runner callbacks therefore register in both
lanes; the module's Wasm validation finding remains scored, not hidden.

The exact unchanged run now covers **344 callbacks across 31 selected files**:
Node admits **342/344**, all 31 modules compile and 30 validate, and Wasm
scores **244/342** with zero runtime failures. The unavailable-infrastructure
remainder is **2,944 registrations** from 210 deferred files. The two native
oracle failures and 98 scored Wasm failures remain visible compatibility
findings; this checkpoint does not reclassify them as infrastructure.

Implementation remains on [PR #4767 — bridge WebAssembly callbacks in prompt tests](https://github.com/loopdive/js2wasm/pull/4767).

## 2026-08-22 Jest pretty-format dependency checkpoint

The original `jest-jasmine2/src/__tests__/expectationResultFactory.test.ts`
unit is now selected unchanged. Its real `pretty-format@30.4.1` source is
verified from the pinned Jest checkout and exposed through a package-resolution
adapter. The adapter also verifies and materializes the published
`ansi-styles@5.2.0`, `react-is@18.3.1`, and `react-is@19.2.8` sources as ESM
package roots; the React-is adapters execute the pinned development bundles,
not synthetic test results. Snapshot matching now uses the upstream
pretty-format serializer for this unit and handles escaped backticks in Jest's
original snapshot keys. Existing watcher snapshots continue to use their
string serializer.

The exact unchanged run covers **351 callbacks across 32 selected files**.
Node admits **349/351** (the two existing diff-sequence oracle failures), all
32 modules compile and 31 validate, and Wasm scores **245/349** with zero
runtime failures. The unavailable-infrastructure remainder is **2,937
registrations** from 209 deferred files. The newly admitted unit contributes
one Wasm pass; its six remaining Wasm failures are genuine null-pointer
runtime failures in the optional-property/error paths and are not reclassified
as dependency infrastructure.

Implementation remains on [PR #4767 — bridge WebAssembly callbacks in prompt tests](https://github.com/loopdive/js2wasm/pull/4767).

## 2026-08-22 Jest `jest-util.isError` package seam checkpoint

The original `jest-core/src/lib/__tests__/serializeToJSON.test.ts` unit is now
selected unchanged. Its upstream implementation imports `isError` through the
published `jest-util` package name; the adapter now verifies the pinned
`jest-util@30.4.1` `isError.ts` bytes and exposes that real source alongside the
existing `formatTime`, `convertDescriptorToString`, and `tryRealpath` exports.
This fixes a genuine package-resolution gap in both the Node oracle and the
compiled Wasm project. No test result is synthesized and the upstream test
body is untouched.

The exact unchanged run now covers **353 callbacks across 33 selected files**.
Node admits **351/353** (the two existing diff-sequence snapshot-oracle
failures remain), all 33 modules compile and 32 validate, and Wasm scores
**247/351** with zero runtime failures. The unavailable-infrastructure
remainder is **2,935 registrations** from 208 deferred files. Both newly
admitted `serializeToJSON` callbacks pass in Node and Wasm.

Implementation: [PR #4772 — expose the pinned `jest-util.isError` dependency](https://github.com/loopdive/js2wasm/pull/4772).

## 2026-08-22 Jest CommonJS path-global checkpoint

The original `jest-haste-map/src/lib/__tests__/fast_path.test.js` unit is now
selected unchanged. Its CommonJS-compatible test body uses Node's
`__dirname`; the generated ESM harness now supplies per-file `__dirname` and
`__filename` bindings, matching the standard Node module surface without
hard-coding a package result. All five callbacks pass in both lanes.

The exact unchanged run now covers **358 callbacks across 34 selected files**.
Node admits **356/358** (the two existing diff-sequence snapshot-oracle
failures remain), all 34 modules compile and 33 validate, and Wasm scores
**252/356** with zero runtime failures. The unavailable-infrastructure
remainder is **2,930 registrations** from 207 deferred files.

Implementation: [PR #4773 — provide CommonJS path globals](https://github.com/loopdive/js2wasm/pull/4773).

## 2026-08-22 Web-host TextEncoder/TextDecoder binding checkpoint

The generic host compiler now registers `TextEncoder` and `TextDecoder` as
synthetic extern classes when a JavaScript package uses the bare Web/Node
globals without a DOM or Node declaration file. Their constructors, UTF-8
methods, and standard read-only properties bind through the existing
`extern_class` host boundary and the runtime's real Web constructors. Host-free
WASI/standalone targets keep the native UTF-8 lowering and acquire no
`TextEncoder_*`/`TextDecoder_*` imports.

The regression covers both compilation and execution: a compiled
`new TextEncoder().encode()` / `new TextDecoder().decode()` round trip returns
the Node result and requests the expected host imports. This closes the
concrete `TextEncoder is not defined` / `TextDecoder is not defined` runner
failure observed in Hono's unchanged buffer and crypto tests. Any remaining
Hono failures are scored compiler/runtime compatibility findings, not missing
Web-global infrastructure.

Implementation: [PR #4752](https://github.com/loopdive/js2/pull/4752).

## 2026-08-22 Prettier utility-suite infrastructure checkpoint

The Prettier adapter now selects 16 of the 20 verified `tests/unit/*.js`
files, up from the original three-file smoke slice. The unchanged upstream
callbacks register **151 tests**; the Node oracle reproduces **151/151** after
the shared runner's negative `toThrow` fix. The shared runner now implements
negative `toThrow`/`toThrowError` matching, so a negative assertion only fails
when the thrown error also matches its requested message or constructor.

The adapter supplies source-compatible, ignored checkout dependencies for the
small pure helpers Prettier imports (`trim-newlines`, `escape-string-regexp`,
`emoji-regex`, `get-east-asian-width`, `url-or-path`, and `n-readlines`). It
also supports inline snapshots and the `toBeGreaterThan` matcher used by the
selected utility tests. No upstream callback or expected input was changed.

The expanded lane compiles 16/16 modules and validates 10/16. It scores
**48/151** in Wasm; the remaining results are compiler/runtime findings,
including the existing async-await-in-try refusal tracked in
[3587](https://github.com/loopdive/js2wasm/blob/main/plan/issues/3587-host-declined-async-shapes-swallow-rejections.md),
document-carrier validation failures. The four deferred files
(`builtin-plugins.js`, `html-elements.js`, `syntax-transform.js`, and
`visitor-keys.js`) remain explicit, with 11 direct static registration sites
reported as unavailable infrastructure rather than silently disappearing. The
pinned inventory counts direct `it`/`test` call sites; table-driven
registrations are expanded separately by the runner.

## 2026-08-24 Hono Web-base64 infrastructure checkpoint

The fresh npm-compat artifact reports Hono at **105/324** scored upstream
callbacks. Its single largest exact failure file is the unchanged
`src/utils/encode.test.ts`: **0/44** before this checkpoint. The first shared
infrastructure defect was that the upstream worker exposed Web constructors
but not Node/browser's real `atob` and `btoa` functions, so both imports were
bound to the missing-provider fallback. Adding those standard globals to the
Web host provider changes the exact file to **23/44**: all decode callbacks
execute instead of throwing on an undefined `atob` result.

A second generic boundary fix routes `new Uint8Array(value)` through the real
host constructor when `value` is genuinely `any`/`unknown`. This preserves the
runtime ArrayBuffer overload used by unannotated package JavaScript instead of
coercing a host ArrayBuffer to the numeric length `0`. The exact Hono file then
measures **27/44**. The focused
[#3097](./3097-compiled-arraybuffer-host-ta-ctor-boundary.md) suite is
**11/11**, including the new
host-ArrayBuffer-through-untyped-helper regression.

The final **17/44** failures were encode rows whose input was created by Hono's
compiled `str2UInt8Array` helper. Indexed bytes and `.length` were correct, but
the compiled vec lost its concrete TypedArray identity when it crossed inside
a heterogeneous table-test row. Codegen now registers only compiler-created
TypedArray carriers, and `__make_iterable` preserves that brand as an
identity-stable host TypedArray mirror. A plain compiled Array remains
unbranded and still has no `.buffer` property. The exact original file now
passes **44/44** without changing any upstream callback or expected value.

A full Hono rerun has not been performed, so no whole-suite numerator is
inferred from this one-file measurement. The next largest measured Hono file,
unchanged `src/middleware/trailing-slash/index.test.ts`, declares **36**
callbacks. Its async outcome transport first exposed a generic runner defect:
reading a promise-result object after `.then()` could lose the anonymous object
carrier. The runner now awaits the callback directly and stores the pass/error
outcome in scalar locals. The shared focused async-runner regression passes.

That correction exposes three separate compiler/runtime findings in Hono's
dispatch path. Dynamic writes such as `context.res = response` now call a
positively matched compiled prototype setter before the host sidecar fallback;
this preserves the setter's `finalized = true` side effect. A compiled class
method invoked as `router.add(...route)` now uses the runtime-sized vararg
dispatcher and receives three positional arguments instead of one nested
route vector. Both changes have package-independent regressions in this issue.

The exact original file now reaches the next boundary but is not green: it
compiles and validates, exposes **1/36** declared callbacks, and that callback
fails. In `RegExpRouter.#buildMatcher`, native
`routes.push(...ownRoute)` still treats its dynamic spread source as one
compile-time argument, appending the complete `ownRoute` vector as a nested
row. Consequently `buildMatcherFromPreprocessedRoutes` observes an array in
`route[0]` where the route path string belongs and eventually throws
`TypeError: null is not iterable`. The generic runtime-sized native-vector
push helper exists but is not yet selected by the array-method call lowering.
This remains a scored compiler finding, not unavailable infrastructure; the
next handoff is to wire that helper for an exact single dynamic spread while
preserving ordinary fixed-arity `push`.

## 2026-08-24 Hono trailing-slash async-CFG handoff

The native-vector spread and nested row-carrier fixes described above are now
covered by the focused regressions in this issue. That suite is **11/11**, including
an out-of-bounds nested member read that still throws a catchable `TypeError`.
The exact original Hono trailing-slash file is restored to all **36** declared
callbacks and compiles and validates in about 17 seconds. A binary exposure
run now passes callbacks 1 and 2, then callback 3 reaches an unhandled late
continuation (`Context is not finalized`, followed by `new URL(undefined)`).
Therefore the exact current result is **2/36 before a fatal worker exit**, not
an inferred whole-file score. The generated callback source and expectations
were not changed.

The remaining failure is a generic async lowering gap, not unavailable test
infrastructure. Hono's recursive `compose` helper defines `async function
dispatch(i)` and awaits handlers inside `if` branches. Host async-drive
admission currently accepts the linear-await and try/catch planners, but an
await buried in an `if` has no matching CFG plan. It consequently falls back
to legacy synchronous await passthrough. The minimal reduction is:

```ts
export async function test(): Promise<number> {
  async function inner(depth: number): Promise<number> {
    if (depth > 0) return await (() => inner(depth - 1))();
    return 7;
  }
  return await inner(1);
}
```

It currently returns `NaN`. The emitted WAT gives `$inner` the direct
`(param f64) (result f64)` ABI and emits no `$__async_resume_finner`; the
branch creates a Promise and then tries to unbox it as the synchronous numeric
return. This localizes the next implementation to the branch-capable
host-drive CFG/resume planner owned by
[1042](./1042-async-await-state-machine-lowering.md) and
[2906](./2906-async-drive-multistate-cfg-resume-machine.md). Merely widening
the admission gate is insufficient: the planner must create condition and
branch states, split each branch at awaits, join them, and preserve the union
of live spills across both successors.

Exact reproduction:

```sh
node --import tsx tests/dogfood/upstream-suite-compile-worker.mjs \
  .hono-upstream-suite-generated/src/middleware/trailing-slash/index.test.ts project
```

The separate exact Hono encode file remains **44/44**. Focused evidence is
**11/11** in `tests/issue-3995-hono-class-boundary.test.ts`, **11/11** in the
typed-array [#3097](./3097-compiled-arraybuffer-host-ta-ctor-boundary.md)
suite, and **1/1** for the upstream runner's async callback
transport. No full Hono rerun has been performed, so the artifact's overall
105/324 numerator must not be adjusted from these file-local results.

## 2026-08-25 Hono conditional-await resume checkpoint

The recursive reduction above now returns **7**, not `NaN`, and its expected
failure is a normal passing regression. The generic CFG builder already had
condition and branch states for try/catch bodies; admission incorrectly
required at least one try/catch group, so an otherwise identical `if`-owned
await could never reach those states. Branch-aware analysis now accepts a body
when either a try/catch group or a conditional owns every suspension point.

Nested `async function` declarations also used a separate lifted-body path that
never invoked async activation. The bounded fix routes a nested declaration
through the existing frame engine only when an `if` arm lexically owns one of
that declaration's awaits. Its reserved function signature is changed to the
real Promise carrier (`externref`) before recursive and forward calls are
compiled. Phase-0 sibling reservation and the real lifted-body compile use the
same activation decision; otherwise a bodyless forward slot can retain the
legacy unwrapped numeric result while the final body switches to `externref`.
The focused sibling-recursion and forward-sibling-caller regressions both
instantiate and return 7 with the shared ABI. An unrelated synchronous guard
plus a linear top-level await remains on its previous lane; the focused guard
proves that merely co-occurring in one body is not enough to change routing.
The same conditional admission is also covered at the exported host-visible
async boundary, rather than only through nested declarations.

Measured focused evidence on the replacement PR worktree:

- `tests/issue-3995-hono-class-boundary.test.ts`: **18/18**;
- `tests/async-await.test.ts`: **8/8**;
- `tests/equivalence/async-function.test.ts`: **7/7**;
- `tests/equivalence/promise-chains.test.ts`: **8/8**;
- `tests/issue-3587-async-rejection-delivery.test.ts`: **21/21**;
- `tests/issue-4618-async-nested-fn-decl.test.ts`: **1/1**.

The local Node engine cannot execute the WASI try/catch control suite: all 38
cases stop at instantiation on opcode `0x1f` with its exnref feature disabled,
before any test value runs. That is an engine-infrastructure limitation, not a
pass claim.

The exact selected Hono rerun on this branch scores **138/322** native-admitted
callbacks in Wasm (19/20 selected modules compile and 17 validate). That is a
branch-wide measurement, not an attribution of all 33 additional passes to
this async slice. In particular, the unchanged original trailing-slash file
does **not** advance past its earlier boundary: callbacks 1 and 2 pass, while
callback 3 still reports `Context is not finalized` and a late
`new URL(undefined)` rejection leaves its test promise unresolved. The normal
worker exits on that rejection; running Node in warning mode confirms the
unresolved continuation rather than producing a later callback result. The
exact conservative outcome therefore remains **2/36 before the fatal/pending
third callback**. Neither the generated callback source nor its expectations
were edited for this measurement.

## 2026-08-26 Hono trailing-slash completion checkpoint

The exact pinned and transformed-but-otherwise-unchanged
`src/middleware/trailing-slash/index.test.ts` now compiles, validates, exposes
all **36** declared callbacks, and passes **36/36** in Wasm. A final isolated
worker run compiled the 1,165,051-byte binary in **6.432 s**. No upstream
assertion, callback, or expected value changed.

Three generic runtime/compiler boundaries closed the post-conditional-CFG
residue. A named class expression now keeps its actual private-field receiver
when the lexical and visible class carriers refer to the same declaration,
instead of projecting `this` through a duplicate synthetic class layout.
Inferred native-ref fields that the class later clears with `void` use the
dynamic externref carrier, preserving the real `undefined` state rather than
materializing an empty native array. The class-body scan is cached per AST
declaration: the uncached first implementation increased the exact compile to
**29.230 s**, while the cached implementation restored the isolated result to
**6.432 s**.

The last two callbacks used
`expect(await response.text()).toBe("wildcard")`. That nested await made the
whole async test closure fall back to synchronous passthrough, so its earlier
`await app.request(...)` exposed the raw pending host Promise and `status`
became `NaN`. The linear async planner now admits the bounded, replay-safe form
where the awaited value is the first dynamic argument of a checker-proven
`const` callable and all enclosing member/call operations occur after that
call. Recompilation therefore repeats only an immutable binding read. Mutable
or global callees, earlier arguments, embedding as another operand, and
concrete scalar callable parameters remain on their prior lane; the latter
need a separate typed continuation ABI and are explicitly pinned by the
focused regression.

Focused Hono/compiler evidence is **27/27** in
`tests/issue-3995-hono-class-boundary.test.ts`, including both the dynamic
nested-await activation and its concrete-scalar non-admission control. The
separate exact encode file remains **44/44** from the preceding checkpoint.

A fresh full selected-Hono run now scores **170/322** native-admitted callbacks
in Wasm, up from the preceding branch measurement of **138/322**. All 20
selected modules were attempted: 18 compiled, 16 validated, and the runner
recorded zero runtime-failed callbacks outside the ordinary scored failures.
The trailing-slash module contributes the directly measured **36/36**. This is
a branch-wide result rather than attribution of all 32 additional passes to
the final nested-await slice; the report preserves each remaining package
failure and the separately deferred upstream inventory.

## 2026-08-26 combined integration report audit

The fresh combined report preserves the exact Hono result: **170/322** admitted
original callbacks pass in Wasm and **152/322** are scored compatibility
failures. Node passes the same **322/322** admitted denominator; two additional
registrations fail natively and are not admitted. Of 20 selected modules,
**18/20 compile** and **16/20 validate**. The unchanged
`src/middleware/trailing-slash/index.test.ts` module itself compiles, validates,
and passes **36/36**. Separately, **2,031 registrations in 100 deferred files**
remain unavailable infrastructure; they are not counted as scored failures.

## 2026-08-26 successor implementation plan

The merged integration checkpoint advances Hono to **180/322** admitted
upstream callbacks, with Node at **322/322** on the same admitted denominator.
All 20 selected modules are attempted: **17/20 compile** and **16/20 validate**.
The unchanged inventory still records **2,031 registrations in 100 files** as
deferred infrastructure. The npm-compat artifact generated earlier that day is
a partial refresh with stale package rows, so these post-merge row-level results
remain the authoritative Hono checkpoint until the next complete refresh.

The package-wide remaining-test census and ordered implementation lanes now live
in [`#4756`](4756-close-curated-npm-upstream-test-gaps.md). Continue this issue
as the shared upstream-source/admission contract; file correctness fixes in the
package-specific child issues named there. Exact denominators, unavailable
infrastructure, native-oracle exclusions, compile failures, validation failures,
and scored Wasm failures must remain separate at every checkpoint.
