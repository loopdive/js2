# Dogfood harnesses — pinned real-package differential testing

Committed, reproducible harnesses that compile a real, pinned npm package
with js2wasm and validate the resulting Wasm. Packages with a callable API
harness also run it and differentially compare its output with the SAME
package running natively under Node (zero version skew — any divergence is a
compiler bug, never an oracle mismatch). Runtime results remain explicitly
unavailable for package entries that do not yet have that API-level proof.

The npm-compat catalog adds another seventeen packages through one data-driven,
bounded package-entry harness:

`hono`, `lodash`, `lodash-es`, `axios`, `react`, `react-dom`, `jsdom`, `webpack`, `uuid`, `typescript`,
`redux`, `jest`, `styled-components`, `moment`, `stylelint`,
`three`, `lit`, and `tailwindcss`.

Every catalog entry pins the canonical npm tarball sha1/integrity and the exact
published entry file. The package's locked dependency graph is installed so a
compile failure is not manufactured by omitting declared dependencies. None of
these seventeen npm tarballs ships its upstream unit-test sources. A package
without a matching source adapter says “upstream suite — not shipped; adapter
pending”; UUID and the separately listed packages below pin immutable matching
source revisions instead. Neither lane substitutes harness-authored smoke
vectors or implies that validation is a test pass. Matching upstream source
suites can be pinned and adapted package by package, following the existing
Acorn/React precedent.

ESLint and jsdom are the explicit runtime-workload exceptions. Their npm
tarballs still omit the upstream suites, but each has a separate API workload
that is only scored after the generated Wasm driver actually runs and matches
a native Node oracle. ESLint additionally pins one complete original upstream
unit file as a deliberately named slice. Redux retains its API workload as a
secondary signal and now also runs its complete original runtime unit suite. A
compile timeout or invalid module remains an unverified workload, never a pass.

The extracted catalog fixture is also given the installed package's importer
context (`node_modules`), including pnpm's private dependency links. This keeps
the published bytes under test while allowing relative imports such as jsdom's
`tough-cookie` dependency to resolve from the same locked graph. A pin marker
invalidates stale ignored extractions when a tarball revision changes.

## TypeScript upstream-source compile probe (#1058)

The published TypeScript package contains one large generated JavaScript
bundle, but the matching upstream tag also contains the original module graph.
The worker-isolated probe compares those two representations with the same
`compileProject` options, streams compiler-phase markers, and records periodic
CPU/RSS heartbeats so a long compile can be distinguished from a blocked
process:

```bash
node tests/dogfood/typescript-upstream-build-probe.mjs \
  --root /path/to/TypeScript-5.9.3 --mode source --timeout-ms 1800000 --heap-mb 4096 --json

node tests/dogfood/typescript-upstream-build-probe.mjs \
  --root /path/to/TypeScript-5.9.3 --mode bundle --timeout-ms 1800000 --heap-mb 4096 --json

node tests/dogfood/typescript-upstream-build-probe.mjs \
  --root tests/dogfood/.npm-upstream-suites/typescript --prepare-pinned-typescript --mode source \
  --entry ../../fixtures/typescript-parser-workload.ts \
  --consumer-driven-barrels --invoke-export runCase --require-invocations 3 \
  --invoke-case src/compiler/builderStatePublic.ts=13386537220945 \
  --invoke-case src/compiler/corePublic.ts=40098163538143 \
  --invoke-case src/compiler/performanceCore.ts=49645738923599 \
  --timeout-ms 300000 --heap-mb 4096 --json
```

`--mode source` selects `src/typescript/typescript.ts`; `--mode bundle`
selects `lib/typescript.js`. Pass `--entry <path-relative-to-root>` for a
narrow upstream-source entry such as a parser workload. The probe defaults to
a 30-minute budget, a 4 GiB worker heap, and 30-second heartbeats. It reports
compile and validation separately and never treats elapsed CPU time or a valid
binary as a package test pass. `--consumer-driven-barrels` is an explicit,
default-off source-tree specialization experiment. A one-off runtime oracle can
use `--invoke-string` plus `--expected-number`. The parser gate instead repeats
`--invoke-case <path>=<safe-integer>` and sets an explicit
`--require-invocations` floor: one compiled parser instance must consume every
unchanged upstream file and match each independently verified structural AST
fingerprint. A constant result, ignored input, invalid binary, missing case, or
reported match whose actual value differs all fail the command.
`--prepare-pinned-typescript` verifies the exact v5.9.3 checkout, runs
TypeScript's checked-in `processDiagnosticMessages.mjs` generator, and verifies
both generated diagnostic artifacts against pinned SHA-256 digests before the
compiler worker starts. This keeps `Diagnostics` in the source graph even from
a fresh upstream checkout.

The original package-specific harnesses, plus the deeper Acorn conformance
check, are:

## Unified npm-compat upstream sources

Every package rendered on `npm-compat.html` has one GitHub repository, release
tag, and immutable commit in `npm-compat-upstream-sources.json`. Acquire and
verify one package without touching any other lane:

```bash
pnpm run dogfood:npm-compat-upstream-sources -- --package clsx
pnpm run dogfood:npm-compat-upstream -- --package clsx
```

Use `--all` instead of `--package` for the complete catalog. `--source-only`
stops after the GitHub checkout and unit-file inventory check;
`--skip-compile` reuses the already-verified published package compile and runs
only its upstream adapter. Packages whose adapters are still being built fail
loudly by default; `--allow-pending` records them as `adapter-pending` while an
all-package source/compile census continues.

The clsx and cookie adapters cover their complete upstream unit-file
inventories. Their reports separate native-incompatible assertions, Wasm
compile/validation failures, runtime failures, and actual assertion
divergences; none of those categories is converted into a pass.

The focused lodash callback-capture regression can be run without extracting
the full package:

```bash
node --import tsx tests/dogfood/lodash-callback-frame-regression.mjs
```

It compiles a reduced `stringToPath` shape, validates and instantiates the Wasm,
then compares its result with the same operation in native Node.

| package                                 | issue | entry file                | oracle diff                                                                 |
| --------------------------------------- | ----- | ------------------------- | --------------------------------------------------------------------------- |
| **acorn** (JS parser)                   | #1710 | `dist/acorn.mjs`          | structural AST diff (`ast-diff.mjs`)                                        |
| **marked** (Markdown→HTML)              | #3716 | `lib/marked.esm.js`       | plain string equality (HTML output)                                         |
| **acorn official suite**                | #3729 | `dist/acorn.mjs`          | acorn's own real `test/tests*.js` (~3,500 cases)                            |
| **clsx** (className joiner)             | #3748 | `dist/clsx.mjs`           | per-op string equality (see below — driver epilogue, not a raw export call) |
| **cookie** (RFC-6265 parser/serializer) | #3751 | `dist/index.js`           | per-op JSON-normalized equality (direct export calls, no epilogue)          |
| **eslint** (JavaScript linter)          | #1400 | `lib/api.js`              | bounded full-package compile/validate; `Linter.verify` API workload         |
| **eslint selected upstream unit**       | #3995 | five `lib/shared/*` utilities | all 158 original cases from the matching source tag                    |
| **prettier** (code formatter)           | —     | `standalone.mjs`          | bounded package-entry compile/validate; runtime diff pending                |
| **react** (UI library)                  | —     | `index.js`                | bounded package-entry compile/validate                                      |
| **react upstream suite**                | —     | `cjs/react.production.js` | React's own real `packages/react/src/__tests__` unit tests                  |
| **react-dom upstream suite**             | #3982 | `cjs/react-dom*.js`       | ReactDOM's own real `packages/react-dom/src/__tests__` unit tests            |
| **uuid upstream suite**                 | #3995 | `dist/index.js`           | UUID's own 75 `src/test/*.test.ts` cases                                    |
| **hono upstream suite**                 | #3995 | `dist/utils/*.js`         | pinned original Vitest callbacks; complete source inventory tracked          |
| **lodash upstream suite**               | #3995 | modular method files      | unchanged QUnit module slices from the monolithic upstream suite              |
| **lodash-es upstream suite**            | #3995 | modular ESM method files  | the same unchanged QUnit module slices against the ESM distribution           |
| **moment upstream suite**               | #3995 | `moment.js`               | pinned original QUnit callbacks; complete core/locale inventory tracked       |
| **stylelint upstream suite**            | #3995 | `lib/utils/*.mjs`         | pinned original utility-unit callbacks; complete `lib/**/__tests__` inventory tracked |
| **three upstream suite**                | #3995 | `src/math/MathUtils.js`   | pinned original QUnit module; complete `test/unit/src` inventory tracked      |
| **jsdom upstream suite**                | #3995 | `lib/jsdom/virtual-console.js` | pinned original VirtualConsole callbacks; complete `test/api` inventory tracked |
| **styled-components upstream suite**    | #3995 | `src/utils/*.ts`        | pinned original utility callbacks; complete source-unit inventory tracked |
| **webpack upstream suite**              | #3995 | `lib/util/*.js`         | pinned original utility callbacks; complete top-level unit inventory tracked |
| **jest upstream suite**                 | #3995 | `jest-get-type/src/index.ts` | pinned original get-type callbacks; complete monorepo unit inventory tracked |
| **tailwindcss upstream suite**          | #3995 | `src/utils/{segment,to-key-path}.ts` | pinned original utility callbacks; complete package test inventory tracked |
| **typescript upstream suite**           | #3995 | 4 original utility-unit files | 14 pinned base64/pseudo-BigInt/comment-scanner callbacks; all 256 files / 1,761 registrations inventoried |
| **redux** (state container)             | #3996 | `dist/redux.mjs`          | consumed store/reducer/subscription/action-creator API workload             |

## uuid v14.0.1 upstream suite (#3995)

```bash
pnpm run dogfood:uuid-upstream-suite
DOGFOOD_UUID_UPSTREAM_SUITE=1 pnpm exec vitest run tests/dogfood/uuid-upstream-suite.test.ts
```

The harness verifies the published `uuid@14.0.1` tarball and clones the
matching `uuidjs/uuid` tag at commit
`70177807e9229dfacde2038dc1e722f1828f358a` for the ten original TypeScript test
files. It runs the same registered test bodies in a native Node oracle and in
one Wasm module per file; the shared table helper is pinned alongside the test
files. The measured mainline baseline is **75/75 native, 3/75 Wasm** (exact
runtime denominator 75). Every failure remains in the JSON report, including
the invalid `v7` callback binary and v1/validate/version runtime traps.

## Hono, Lodash, and Moment upstream suites (#3995)

```bash
pnpm run dogfood:hono-upstream-suite
pnpm run dogfood:lodash-upstream-suite
pnpm run dogfood:lodash-es-upstream-suite
pnpm run dogfood:moment-upstream-suite
```

Each lane clones the exact source tag matching the committed npm tarball,
verifies the immutable commit and complete upstream test inventory, and runs
unchanged upstream callbacks against the published package bytes in both Node
and Wasm. The initial adapters select only synchronous, runner-independent
files or complete QUnit module slices. Every unselected file or registration
site remains counted as deferred in the JSON report; a supported slice is
never presented as the whole upstream suite.

The 2026-08-12 initial baselines are **Hono 25/31**, **Lodash 0/11**, and
**Moment 0/10** in Wasm; their Node oracles pass 31/31, 11/11, and 10/10. Every
generated module compiles and validates. Lodash fails at the callback-runner
boundary; Moment reaches the callbacks but differs on their assertions.

## Redux 5.0.1 upstream suite and API workload

Tracked by [issue 3995](https://github.com/loopdive/js2wasm/blob/main/plan/issues/3995-pin-and-adapt-original-upstream-test-suites-for-catalog.md).

```bash
pnpm run dogfood:redux-upstream-suite
pnpm run dogfood:redux-workload
```

The upstream lane verifies all nine original runtime test files at
`reduxjs/redux@v5.0.1` and registers all 82 callbacks against the matching
published bundle. Node reproduces all 82 callbacks. The shared runner supplies
the Node-compatible `global` alias used by Redux's console-warning tests in
both the native and Wasm lanes. All nine generated modules compile and
validate; the current Wasm baseline is **13/82**. Per-file runtime traps and
assertion differences are retained in the JSON report.

The smaller generated API driver remains as an independent secondary signal.
It consumes `combineReducers`, `createStore`, `subscribe`, and
`bindActionCreators`, then compares one numeric summary with the same package
running in native Node.

## Stylelint 17.14.1 upstream utility units

```bash
pnpm run dogfood:stylelint-upstream-suite
DOGFOOD_STYLELINT_UPSTREAM_SUITE=1 pnpm exec vitest run tests/dogfood/npm-small-upstream-suites.test.ts
```

The harness verifies all 281 matching files and 1,574 static registration sites
from Stylelint's pinned GitHub release. The initial synchronous slice selects
five dependency-light utility files: all five generated modules compile and
validate, Node passes **9/9**, and Wasm passes **7/9**. The two runtime traps and
all 276 deferred files remain visible in the report.

## Three.js r185 upstream MathUtils unit module

```bash
pnpm run dogfood:three-upstream-suite
DOGFOOD_THREE_UPSTREAM_SUITE=1 pnpm exec vitest run tests/dogfood/npm-small-upstream-suites.test.ts
```

The harness verifies all 232 matching source files and 1,313 QUnit registration
sites from the pinned Three.js release. The initial dependency-light MathUtils
module compiles and validates, Node passes **18/18**, and Wasm currently reports
**0/18** at the QUnit callback boundary. All 231 deferred files and the per-test
zeroes remain visible; none is converted into a pass.

## Axios 1.16.1 upstream suite

Tracked by [issue 3995](https://github.com/loopdive/js2wasm/blob/main/plan/issues/3995-pin-and-adapt-original-upstream-test-suites-for-catalog.md).

```bash
pnpm run dogfood:axios-upstream-suite
```

The source pin verifies all 49 original `tests/unit/**/*.test.js` files and 645
static registration sites. The initial self-contained synchronous slice runs
all 170 expanded callbacks from 25 files against the matching published Axios
modules. Node passes 170/170; all 25 generated modules compile and validate;
Wasm currently passes **16/170**. The other 24 files remain explicitly deferred
because they require the async Wasm runner, live HTTP servers, sockets, streams,
or filesystem test infrastructure.

The npm-compat report generator runs this adapter directly. The merge-only
refresh workflow also verifies that every configured upstream adapter emitted
numeric pass/total results before it can publish the six dashboard artifacts.

## acorn (#1710)

Mechanizes the acorn self-hosting dogfood loop: **compile acorn with
js2wasm → validate the Wasm → run it → differentially diff its AST against
node-acorn**. It turns the previously throwaway `.tmp/acorn/probe.mjs`
scratch work into data that #1711 (triage) buckets and that #1712
(acceptance gate) reuses.

## Invoke

```bash
pnpm run dogfood:acorn          # run the loop, print a human summary, write the JSON report
npx tsx tests/dogfood/acorn-harness.mjs --json   # machine output to stdout
pnpm test -- tests/dogfood/acorn.test.ts         # vitest contract wrapper
```

The structured surface report is written to
`tests/dogfood/report/acorn-surface.json` (gitignored — regenerate any time).

## What it does

1. **Acquire** — `setup-acorn.mjs` verifies the pinned, committed acorn tarball
   (`fixtures/acorn-8.16.0.tgz`) against its canonical npm sha1 and extracts it
   into `tests/dogfood/.acorn/` (gitignored). **No run-time network.**
   Acquisition decision is pinned in `acorn-pin.json` per the project-lead
   decision (2026-05-29): pinned `npm pack`, not a vendored source copy.
2. **Compile** — feeds `dist/acorn.mjs` through `compile(src, { fileName:
"acorn.mjs" })` and records `success`, binary size, and categorized
   diagnostics. The TS "Property does not exist" JS-noise (acorn is plain JS
   run through the TS checker) is collapsed into one non-blocking
   `ts-property-noise` bucket.
3. **Validate** — `WebAssembly.compile(binary)` and records the first validator
   error verbatim (the surface that exposed #1690).
4. **Run + diff** — when the binary validates and exposes a callable `parse`,
   parses each fixture in `fixtures/inputs/*.js` with both compiled-acorn and
   node-acorn (the **same pinned tarball** is the oracle, so any divergence is a
   compiler bug, never version skew) and structurally diffs the ASTs. A red
   surface (binary invalid) is **recorded and skipped**, never crashes the
   harness.
5. **Report** — emits `report/acorn-surface.json` +
   a human summary.

## Reusable differential-AST gate (`ast-diff.mjs`)

`diffAst(expected, actual, opts)` is the keystone shared with #1712. It does a
structural deep-compare of two acorn ASTs, **ignoring position fields**
(`start`/`end`/`loc`/`range`) by default so node-kind/shape/literal divergences
dominate the report; pass `{ ignorePositions: false }` to include them once
shape is clean. It reports the first divergence as
`{ path, reason, expected, actual }` with a JSONPath-ish pointer. `diffParse`
is a convenience that parses with both sides and diffs in one call.

The harness runs an **oracle self-check** (node-acorn vs node-acorn, identical
vs operator-differing sources) every run, proving `diffAst` detects both
equality and divergence even while compiled-acorn can't run yet — so #1712 can
rely on it immediately.

## Refreshing the pin

```bash
npm pack acorn@<version>            # produces acorn-<version>.tgz
# move it to tests/dogfood/fixtures/, update version/shasum/integrity in acorn-pin.json
npm view acorn@<version> dist.shasum dist.integrity   # canonical values to pin
```

The oracle dependency is the SAME tarball, so there is no separate `acorn`
devDependency to keep in sync.

## Scope (acorn)

This harness does **not** fix any compiler bug — pure tooling. Compiler defects
it surfaces are recorded in the report for #1711 to triage. Standalone
(`--target wasi`) execution of compiled acorn is an explicit follow-up
(a #1711 child), not part of this harness.

## marked (#3716)

Same loop, second package, deliberately simpler: marked's observable
surface is a single HTML **string** (not an AST object graph), so plain
string equality replaces `ast-diff.mjs`'s structural diff — no marshalling
layer needed to compare results.

```bash
pnpm run dogfood:marked          # run the loop, print a human summary, write the JSON report
pnpm run dogfood:marked-upstream-suite  # run the selected original Hooks callbacks
npx tsx tests/dogfood/marked-harness.mjs --json   # machine output to stdout
DOGFOOD_MARKED=1 pnpm test -- tests/dogfood/marked.test.ts   # vitest contract wrapper
```

Report: `tests/dogfood/report/marked-surface.json` (gitignored). Pin:
`marked-pin.json` (same acquisition discipline as acorn — refresh via
`npm pack marked@<version>` + `npm view marked@<version> dist.shasum
dist.integrity`).

**Current state (first run, 2026-07-27)**: red surface — `marked` does not
compile at all yet. Root-caused to #3715 (TypeScript's "evolving array
type" inference — `let x = []` later populated via `.push()` — is not
implemented in the checker, so any array of this shape stays typed
`never[]` forever). This harness's job was to surface that, not fix it;
see #3715 for the minimal repro and scope. Once that lands, re-run
`pnpm run dogfood:marked` for the first real run+diff data.

This harness does **not** fix any compiler bug — pure tooling, same as
acorn's scope note above.

## eslint (#1400)

ESLint uses the same committed npm-tarball integrity contract, but its public
entry is a multi-file CommonJS graph rather than a self-contained dist bundle.
`setup-eslint.mjs` verifies every published ESLint file in the installed
devDependency against `fixtures/eslint-10.0.3.tgz` byte-for-byte, then compiles
the verified installed `lib/api.js` path so pnpm can resolve dependencies from
ESLint's real importer context.

The compile runs in a bounded child process because the unresolved #3672 scale
frontier must become structured red data, not hang or exhaust the page
generator:

```bash
pnpm run dogfood:eslint
npx tsx tests/dogfood/eslint-harness.mjs --json
DOGFOOD_ESLINT=1 pnpm test -- tests/dogfood/eslint.test.ts
```

`DOGFOOD_ESLINT_TIMEOUT_MS` can override the default 180-second compile budget
for focused diagnostics. A timeout remains a failed compile result. It is never
relabelled as validation or runtime success.

The package-entry harness reports compile/validate separately. Once that
frontier is green, the companion workload is attempted automatically by the
npm-compat report generator:

```bash
pnpm run dogfood:eslint-workload
npx tsx tests/dogfood/eslint-workload-harness.mjs --json
```

The workload compiles a generated driver outside the extracted fixture, imports
the verified installed ESLint graph, and returns the number of `semi` rule
diagnostics for `var x = 1`. The native oracle evaluates that same operation
against the same installed package at run time. `DOGFOOD_ESLINT_WORKLOAD_TIMEOUT_MS`
can shorten the bounded probe for local diagnostics.

If the package-entry compile is still blocked, the report leaves the workload
explicitly unverified. This is intentional: a valid module is not evidence of
correct `Linter.verify` behavior, and a timeout is not a pass.

The package-entry timeout does not prevent smaller original units from exposing
real runtime semantics. ESLint's npm tarball omits its tests, so the selected
upstream-unit lane clones the exact `v10.0.3` source commit
`bfce7eaa0ec5d6591fd247b7ff57b51e45fb88a1`, verifies it, and runs all 158
bodies from five shared-utility files against the byte-verified published
implementation:

```bash
pnpm run dogfood:eslint-upstream-suite
DOGFOOD_ESLINT_UPSTREAM_SUITE=1 pnpm exec vitest run tests/dogfood/eslint-upstream-suite.test.ts
```

The adapter keeps the original test bodies and changes only their bindings: the
package-relative implementation require points at the pinned npm payload, and
`node:assert`/Chai is replaced by one deterministic callable assertion plus a
plain method object shared by the Node and Wasm lanes. The split is deliberate:
Wasm does not preserve properties assigned onto a function value, while it does
preserve methods on an ordinary object. No test body is transcribed, rejected,
or silently skipped. The current measured slice is **158/158 in Node and
50/158 in Wasm**; the deep-merge unit is **44/44 in both lanes**. The remaining
Wasm failures are compiler/runtime mismatches in typed reference-array HOFs and
serialization helpers, and remain visible in the per-file report. The
npm-compat card calls this a “selected upstream unit” so these numbers can never
be mistaken for ESLint's whole suite.

## jsdom (#3995)

`jsdom`'s published npm tarball omits its upstream Mocha/Web Platform Tests, so
there is no honest upstream-suite denominator to report from the fixture alone.
The package-entry catalog harness still compiles the real `lib/api.js` graph,
with the installed pnpm importer context wired into the extracted fixture. The
API workload adds a small consumed DOM check (selector text, list cardinality,
and serialized markup) and compares the primitive count with native `JSDOM`:

```bash
pnpm run dogfood:jsdom-workload
npx tsx tests/dogfood/jsdom-harness.mjs --json
```

This is explicitly an API smoke workload, not jsdom's upstream suite. It is
only marked verified after the compiled workload runs and matches the native
oracle; a compile timeout remains unverified. The npm-compat report generator
attempts it after the package-entry compile/validation step succeeds.

## prettier and react

Prettier and React use the same committed-tarball integrity contract and
bounded package-entry harness. The generic
`package-entry-harness.mjs` helper verifies and extracts each exact npm
tarball, runs `compileProject` in a child process, validates any emitted Wasm,
and records runtime verification as unavailable until a real package API
differential test exists.

```bash
pnpm run dogfood:prettier
pnpm run dogfood:prettier-upstream-suite
pnpm run dogfood:react
pnpm run dogfood:react-upstream-suite
DOGFOOD_PRETTIER=1 pnpm test -- tests/dogfood/prettier.test.ts
DOGFOOD_REACT_UPSTREAM=1 pnpm exec vitest run tests/dogfood/react-upstream-suite.test.ts
```

The current Prettier package entry emits an invalid binary, while its separate
upstream-suite lane compiles three self-contained original unit modules from the
pinned GitHub release. All 8 selected callbacks pass in Node; 1/8 currently
passes in Wasm. The full 20-file inventory and 17 deferred files remain visible
in the report. React's package entry compiles to valid Wasm, but that alone is
not reported as runtime correctness — `react-upstream-suite.mjs` is what actually
tests it, by running **React's own unit tests**.

### How React's suite is reached

React's npm tarball omits its unit-test sources, so the harness clones React's
matching pinned tag and verifies the immutable commit before anything is
attributed to upstream React. Unlike acorn — whose `test/driver.js` is
deliberately decoupled from any acorn build — React's suite is welded to Jest,
`internal-test-utils`, ReactDOM and a jsdom document, and there is no upstream
entry point that can be handed a `React` and asked to run. So
`react-upstream-extract.mjs` reads the upstream test FILES verbatim, transpiles
their JSX with the classic runtime (`<div/>` → `React.createElement('div',
null)`, exactly what React's own jest transform does), and lifts each `it(...)`
out with its enclosing `describe` scope and `beforeEach` prelude. Test names,
bodies and assertions are upstream's — nothing is transcribed or reworded.

Three rules keep the number honest:

1. **Everything is accounted for; the SCORE is what is guarded.** All 272
   upstream tests that upstream does not itself `.skip` are admitted, including
   the ones reaching for ReactDOM, `act`, `jest.*` or a `document`. Those are
   expected to fail — a failure that is run and counted is more honest than a
   test filtered out before it runs. What they are not is _compiler evidence_:
   the native oracle fails them too, so they land in `harness-incompatible` and
   sit outside the pass rate. Any compile-quarantined test is reported by name
   rather than described as executed. The report prints selected, executed,
   scored, infra-blocked and quarantined counts so none can hide another.
2. **The `expect` shim implements only the matchers the admitted tests use**
   (`SUPPORTED_MATCHERS`); a test using anything else is rejected rather than
   scored against an approximation of Jest. The same shim source runs on both
   sides, so a divergence is always the compiler.
3. **A test the harness cannot reproduce natively is not evidence about the
   compiler.** It is excluded from the score under its own
   `harness-incompatible` bucket instead of being counted as a compiler bug.

Both React harnesses install the same explicit jsdom browser-global set for
their native oracle. `react-upstream-infrastructure.mjs` supplies the
cross-package host half required by the original tests: ReactDOM client/server,
the test renderer and noop renderer, `prop-types`, `create-react-class`, web
streams, Jest spies/mocks, and `internal-test-utils` assertions. The published
ReactDOM/client/server and test-renderer entries are resolved with
`NODE_ENV=production` and aliased to the exact pinned React object; this avoids
the real dev-renderer/production-React peer mismatch that otherwise fails in
React's internal `actQueue` path. Production test-renderer has no `act` or
committed tree, so the noop adapter uses a jsdom ReactDOM root and
`flushSync`, including a test-renderer-shaped JSON/ref view. The setup also
unrefs scheduler `MessagePort`s and restores the CommonJS module cache during
cleanup, so a finished suite exits cleanly.

The test-only dependencies are pinned in `devDependencies`:
`react-test-renderer`, `create-react-class`, `prop-types`, and
`web-streams-polyfill`. A compile-stuck large integration file is split into
one upstream test per module; a per-test/compile watchdog records a timeout
instead of blocking the rest of the corpus. Native-oracle failures still stay
in the explicit `harness-incompatible` bucket and are never turned into
compiler evidence.

The shared upstream runner and the React shim both expose Node's `global`
spelling as an alias of `globalThis`; this is required by React and Redux's
original polyfill and console-warning tests and is installed identically in
the native and Wasm lanes.

Failures stay in the corpus. The vitest wrapper enforces a pass FLOOR, not a
target, so a regression is caught while the remaining frontier stays visible.

Current exact result (2026-08-20): **92/178** natively scoreable upstream tests
pass against compiled Wasm. The harness admits and executes 272 of React's
273 tests (one is upstream-skipped), reports 94 native-oracle-incompatible
tests, and has zero compile-quarantined batches across 44 valid Wasm batches.
The production `__DEV__ = false` constant is embedded in the shared native/Wasm
source because that is the transform React itself applies to
`react.production.js`; it does not precompute a test result. The remaining
incompatible cases are recorded as infrastructure/behavior mismatches (mostly
production warning expectations, renderer semantics, and compiled component
closures crossing the Wasm/host boundary), not silently skipped package
lookups.

### ReactDOM's platform lanes

`react-dom-upstream-suite.mjs` uses the same pinned React checkout, extractor,
jsdom host, and native oracle, but keeps each published renderer graph
independent. The 2,001 admitted ReactDOM tests are split into the client graph,
legacy browser SSR, browser Fizz (60 tests), Node Fizz (35), and Edge Fizz (2).
Each lane records its own compile, validation, native-oracle, and Wasm result
counts in the report and on the npm-compat card. The Node lane exposes the real
Node `stream.PassThrough` through a named host capability; browser and Edge use
the standard Web Streams, messaging, encoder, headers, abort, and async-hooks
host surface.

To keep a local iteration bounded, use separate limits rather than silently
dropping a platform:

```bash
DOGFOOD_REACT_DOM_TEST_LIMIT=1 \
DOGFOOD_REACT_DOM_SERVER_TEST_LIMIT=1 \
DOGFOOD_REACT_DOM_FIZZ_TEST_LIMIT=1 \
DOGFOOD_REACT_DOM_NODE_FIZZ_TEST_LIMIT=1 \
DOGFOOD_REACT_DOM_EDGE_FIZZ_TEST_LIMIT=1 \
node --import tsx tests/dogfood/react-dom-upstream-suite.mjs --json
```

Concise upstream arrows are lifted as expression statements, so the full
corpus is now admitted except for the two tests upstream marks `.skip`.
Compiler/runtime failures remain failures; host-incompatible native tests and
private test scaffolding are reported separately rather than converted into
passes.

## lit upstream suite (#3977)

```bash
pnpm run dogfood:lit-upstream-suite
DOGFOOD_LIT_UPSTREAM=1 pnpm exec vitest run tests/dogfood/lit-upstream-suite.test.ts
```

Same shape as React's, with two differences that matter.

**The `lit` tarball contains no implementation.** `lit/index.js` is a four-line
barrel re-exporting `lit-element` and `lit-html`, which ship as separate
packages that the `lit` tarball does not include. The old package-entry card
compiled that barrel — 201 bytes — and reported "compiles + validates", which
was true of the barrel and said nothing about lit. So this suite pins the
**three published packages that actually carry the code** (`lit-html@3.3.3`,
`@lit/reactive-element@2.1.2`, `lit-element@4.2.2`, each sha1-verified) and
compiles those. The monorepo tag `lit@3.3.3` carries exactly those versions,
checked at setup time, so there is zero skew between the tests and the
implementation under test. Imports resolve through a real `node_modules` layout
so each package's own `exports` map decides which file is served — not a path
this harness guessed.

**The implementation is compiled ALONE first, before any test.** React's
harness halves a batch that fails validation. Applied to lit that is not merely
slow, it is wrong-headed: lit-html's implementation is itself invalid (#3978),
so every batch containing it is invalid and halving bottoms out at one test and
still fails. Each file's bundle is therefore compiled with no test code
attached; if that module is invalid the file is recorded under
`compile.implementationInvalid` with the validator's own message and its tests
skip compilation entirely. They still run natively and are still scored as
failures — never dropped — but no time is spent subdividing toward a floor that
does not exist. That check is also the only thing that could have shown that
js2wasm cannot compile lit's published bytes at all, which no per-test number
would have surfaced.

Otherwise the rules are the React ones: 583 of 587 upstream tests are admitted
(the 4 rejections are upstream's own `.skip`), and the DOM-dependent ~90 % runs
through the jsdom browser surface. The shared browser bootstrap now exposes
the standard DOM constructors used by lit (`HTMLAnchorElement`,
`HTMLFieldSetElement`, `HTMLLabelElement`, `HTMLSpanElement`, and
`ElementInternals`) in both the native and compiled lanes. Conservative
extraction treats DOM, window, shadow-root, custom-element, constructable
stylesheet, and Lit warning globals as supplied infrastructure; it no longer
turns those source references into unavailable-infrastructure rejections.
Lit's repo-internal `test-utils` — which ship in no tarball — still resolve to a
stub that throws, so those tests run and fail on both sides instead of
vanishing. The `assert` shim covers the 26 chai members lit's tests actually
use, surveyed across all 58 files; `equal` is `==` and `strictEqual` is `===`,
because lit depends on the difference.

The suite found #3978, #3979 and #3980.

## acorn official suite (#3729)

The other acorn/marked harnesses above diff compiled output against a small,
hand-written fixture corpus. This one instead runs acorn's **own real test
suite** (`test/tests*.js`, ~3,500 cases at the pinned version) against
compiled acorn — its own authoritative "does this parser actually work"
check, not an approximation of it.

npm does not publish acorn's `test/` directory (stripped by its `files`
field — confirmed empty on the committed dist tarball), so unlike the dist
module, the test suite must be acquired from source:
`setup-acorn-test-suite.mjs` does a shallow `git clone` at a pinned exact
commit SHA (`acorn-test-suite-pin.json`), verifies the clone's HEAD against
the pin, then stitches the already sha1-verified dist bytes from
`setup-acorn.mjs`'s pinned tarball into the clone's `acorn/dist/` so the
test files' own `require("../acorn")` resolves — without running acorn's
real rollup build. **This is the one dogfood harness that needs run-time
network** (a real difference from the others' fully offline tarball
extraction).

acorn's `test/driver.js` exposes `runTests(config, callback)` fully
decoupled from any specific acorn build — it just needs a `parse(code,
options)` function — so the real driver + real test files run unmodified,
just pointed at compiled-acorn's `parse` instead of native.

```bash
pnpm run dogfood:acorn-official-suite                       # run the loop, print a human summary, write the JSON report
npx tsx tests/dogfood/acorn-official-suite.mjs --json        # machine output to stdout
DOGFOOD_ACORN_OFFICIAL=1 pnpm test -- tests/dogfood/acorn-official-suite.test.ts   # vitest contract wrapper
```

Report: `tests/dogfood/report/acorn-official-suite.json` (gitignored).

**Current state (2026-07-28): 3,507 / 3,518 passed (99.7%)**. Getting an
accurate number required fixing a harness-side bug first: compiled-acorn's
`throw` lowers to a bare `WebAssembly.Exception` with zero JS-reflectable
payload, which initially made the pass rate look like 55.2% (every
correctly-thrown syntax error was indistinguishable from "didn't throw at
all"). Routing through `extractWasmExceptionMessage`
(`tests/test262-runner.ts`, the project's established #2962 mechanism)
fixed that. The 11 real residual failures are filed separately: **#3730**
(comment-collection `onComment` arrays lost across a compiled-internal
closure, 6 cases) and **#3728** (astral/surrogate-pair Unicode identifier
character misclassification, 4 cases, plus one unrelated narrow oddity).

Unlike the other acorn/marked vitest wrappers (which only assert the
harness ran to completion), this one's heavy test gates on a real
**regression floor** (`results.passed >= 3507` at `results.total ===
3518`) — this suite is authoritative enough that a drop is worth failing
CI over. Raise the floor after a genuine fix improves the pass count, never
lower it to paper over a regression.

This harness does **not** fix any compiler bug — pure tooling, same as the
other harnesses' scope notes above.

## dayjs — investigated, not committed as a harness (#3747)

Before clsx, `dayjs@1.11.21` was the next candidate: `dayjs.min.js` compiles
and validates cleanly. But dayjs's dist file is a **UMD bundle**
(`module.exports = factory()`), unlike acorn/marked/clsx's real ESM entry
modules with named exports — there's no `export` statement to wire a wasm
export to, so reaching the returned value required a small `module.exports`
shim appended around the (unmodified) pinned source. That compiled and
validated too, but every actual call through the exported value failed with
`null is not a function`.

Reduced to a minimal repro fully independent of dayjs: reassigning an
object-literal property (seeded with any non-function value) to a closure
silently loses callability — `typeof` reports `"object"` and calling it
throws, with no compile error and nothing throwing anywhere near the actual
defect. Filed as **#3747** rather than fixed here (`feasibility: hard`) —
it blocks the `module.exports = ...` pattern used by essentially every
CJS/UMD-bundled npm package, so it's a real prerequisite for extending this
corpus to any UMD-shaped package (not just dayjs), not fixed inline. No
`dayjs-harness.mjs` exists yet; it's a natural follow-up once #3747 lands.

## clsx (#3748)

A third differently-shaped real npm package: `clsx@2.1.1`'s
`dist/clsx.mjs` is a genuine single-file **ESM** bundle (330 bytes
minified, zero imports, real `export function clsx(){...}`) — same shape
as acorn/marked, chosen specifically because dayjs's UMD shape (above)
turned out not to fit this pattern directly.

clsx's own exported function is variadic — it declares zero parameters and
reads the `arguments` object internally. Calling it directly across the
wasm export boundary always observes zero arguments: verified independent
of clsx that this is an inherent Wasm-ABI fixed-arity limitation (an
export's wasm function signature is fixed from its declared parameter
list), not a compiler bug. So `clsx-harness.mjs` compiles the UNMODIFIED
pinned source with a small internal **driver epilogue** appended
(`clsx-ops.mjs`) — 18 ops, each a fixed-arity wrapper making an ordinary
internal call into `clsx` with hardcoded literal arguments. The exact same
op-code string drives both the compiled wrapper export and the native
oracle (`new Function("clsx", code)` bound to the same pinned tarball's CJS
build), so oracle and compiled logic can never drift apart from each other.

```bash
pnpm run dogfood:clsx                                  # run the loop, print a human summary, write the JSON report
npx tsx tests/dogfood/clsx-harness.mjs --json           # machine output to stdout
DOGFOOD_CLSX=1 pnpm test -- tests/dogfood/clsx.test.ts  # vitest contract wrapper
```

Report: `tests/dogfood/report/clsx-surface.json` (gitignored). Pin:
`clsx-pin.json`.

**Current state (2026-07-28): 17 / 18 ops match.** The one divergence —
`clsx([{a:true,b:false},{c:true}])` throwing `dereferencing a null
pointer` — is a real bug, reduced to a minimal repro fully independent of
clsx (an array literal containing object literals of _different_ shapes
crashes `for...in`; same-shaped siblings or a single object are fine) and
filed as **#3749**, not fixed here. Like the other vitest wrappers, this
one gates on a real regression floor (`equal >= 17` at `total === 18`) —
tight enough to be meaningful at this scale; raise it after a genuine fix,
never to paper over a regression.

This harness does **not** fix any compiler bug — pure tooling, same as the
other harnesses' scope notes above.

## cookie (#3751)

A fourth differently-shaped real npm package: `cookie@2.0.1`'s
`dist/index.js` is a genuine single-file ESM bundle (RFC-6265
`Cookie`/`Set-Cookie` header parsing and serialization) — same shape as
acorn/marked/clsx. Unlike clsx, cookie's four exports (`parseCookie`,
`stringifyCookie`, `stringifySetCookie`, `parseSetCookie`) are all
fixed-arity with real declared parameters, so `cookie-harness.mjs` calls
them DIRECTLY across the wasm export boundary — no driver-epilogue shim
needed (contrast clsx's variadic `arguments`-based export, above).

```bash
pnpm run dogfood:cookie                                    # run the loop, print a human summary, write the JSON report
npx tsx tests/dogfood/cookie-harness.mjs --json             # machine output to stdout
DOGFOOD_COOKIE=1 pnpm test -- tests/dogfood/cookie.test.ts  # vitest contract wrapper
```

Report: `tests/dogfood/report/cookie-surface.json` (gitignored). Pin:
`cookie-pin.json`.

**Current state (2026-07-28): 18 / 21 ops match.** The three divergences
— all three `parseSetCookie` ops that pass a `Set-Cookie` attribute
(`HttpOnly`, `Path`, or several combined) — share one root cause: the
attribute gets assigned onto the result object dynamically inside the
attribute-parsing loop/switch, and that write is silently dropped (no
crash, no wrong type — the property is just completely absent from the
result). The base `{name, value}` shape with zero attributes round-trips
correctly. Reduced to a minimal repro fully independent of cookie and
filed as **#3750**, not fixed here — cross-referenced against #3747
(dayjs) and #3749 (clsx) as likely-related instances of the same general
"object/array shape representation" gap, each with its own distinct
symptom. Like the other vitest wrappers, this one gates on a real
regression floor (`equal >= 18` at `total === 21`).

This harness does **not** fix any compiler bug — pure tooling, same as the
other harnesses' scope notes above.

## @js-temporal/polyfill — spike harness (#4628)

Unlike every other harness here, this one is a **spike instrument, not a
regression gate**. It exists to answer one question for
[#4628](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4628-temporal-runtime-object-spike):
can js2wasm compile `@js-temporal/polyfill` well enough to install a real
`Temporal` global? So it runs the **compile + validate** lane only — the cheap
half — with no differential-execution lane and, deliberately, **no pass/fail
floor** in the vitest wrapper.

Two pins, not one: the polyfill's published ESM bundle is **not**
self-contained. `dist/index.esm.js` carries exactly one import against
`jsbi@^4.3.0`, so `jsbi-4.3.0.tgz` is pinned alongside it and the harness links
them into a single module (jsbi's `export default JSBI;` dropped, the import
rewritten to `const e=JSBI;`). Both edits are asserted, so an upstream bump that
changes the bundle shape fails loudly instead of quietly measuring something
else.

```bash
# slice lane — split at top-level statement boundaries, compile chunk by chunk
node tests/dogfood/temporal-polyfill-harness.mjs --no-umd --no-whole --slices=25
# whole-bundle lane (see the caveat below)
JS2WASM_COMPILE_PROFILE=stream node tests/dogfood/temporal-polyfill-harness.mjs --no-umd
# vitest contract wrapper (cheap acquisition/link lane always runs)
DOGFOOD_TEMPORAL_POLYFILL=1 pnpm test -- tests/dogfood/temporal-polyfill.test.ts
```

Report: `tests/dogfood/report/temporal-polyfill-surface.json` (gitignored). Pin:
`temporal-polyfill-pin.json`.

**Current state (2026-08-23):** the slice lane compiles **342 / 342 top-level
statements with zero compile errors**, but 5 of 14 slices emit a binary that
fails `WebAssembly.compile()` (all one family: a call thunk pushing one operand
fewer than the callee's declared arity). The **whole-bundle lane does not
terminate** — 157 KB in one module ran 45 minutes without finishing, while the
same statements sliced up sum to ~24 seconds. Per the rule at the top of this
file, a compile timeout is an unverified workload, never a pass. Full
measurements, the scaling curve and the Option A / Option B decision are in the
issue.

The `--slices=N` mode is the reusable part: when a whole-module compile will not
terminate, it still yields a bucketed cause list, and it **reports coverage**
(slices run / skipped, statements covered / total) so partial results can never
be mistaken for a whole-bundle number.
