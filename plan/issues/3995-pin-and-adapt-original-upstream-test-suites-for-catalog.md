---
id: 3995
title: "npm-compat: pin and adapt original upstream test suites for catalog packages"
status: ready
created: 2026-07-30
updated: 2026-08-14
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
---
# npm-compat: pin and adapt original upstream test suites for catalog packages

## Problem

The catalog package tarballs do not ship their original unit suites. The npm-compat page correctly reports upstream suite not shipped; adapter pending, but this needs a tracked path to genuine validation.

Pin matching source revisions and provide adapters for: hono, lodash, axios, react-dom, webpack, uuid, typescript, redux, jest, styled-components, moment, stylelint, three, lit, tailwindcss, and cookie. Keep upstream-suite validation distinct from compile checks, synthetic differential vectors, and benchmark harnesses.

Start with React DOM, Jest, and Lit, which already compile and validate their entry artifacts.

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

## 2026-08-14 Redux complete runtime suite

Redux 5.0.1 now uses all nine original `*.spec.ts` runtime files from
`reduxjs/redux@v5.0.1` (commit
`50b010210df25c470386f7e39a9389a4a77b3842`). All 82 callbacks register and
all nine generated test modules compile to valid Wasm. The synchronous Node
oracle reproduces 78 callbacks; the four promise-returning callbacks are
explicitly harness-incompatible until the shared runner supports async Wasm
tests. The measured Wasm baseline is **5/78**: ten callbacks reach an assertion
and diverge, while 63 encounter a module-level runtime trap in the larger
`bindActionCreators`, `combineReducers`, and `createStore` files. The existing
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
Node passes **18/18**, and Wasm currently reports **0/18**.

The module reaches the shared QUnit callback runner but currently returns false
for every callback without a surfaced assertion message. The report preserves
those measured zeroes and all 231 deferred browser, WebGL, DOM, loader, and
larger object-graph files. The npm-compat generator invokes the suite directly,
so the merge-only refresh publishes the numeric result and upstream pin rather
than leaving Three.js at `adapter pending`.
