# Dogfood harnesses — pinned real-package differential testing

Committed, reproducible harnesses that compile a real, pinned npm package
with js2wasm and validate the resulting Wasm. Packages with a callable API
harness also run it and differentially compare its output with the SAME
package running natively under Node (zero version skew — any divergence is a
compiler bug, never an oracle mismatch). Runtime results remain explicitly
unavailable for package entries that do not yet have that API-level proof.

The npm-compat catalog adds another fifteen packages through one data-driven,
bounded package-entry harness:

`hono`, `lodash`, `axios`, `react-dom`, `webpack`, `uuid`, `typescript`,
`redux`, `jest`, `styled-components`, `moment`, `stylelint`,
`three`, `lit`, and `tailwindcss`.

Every catalog entry pins the canonical npm tarball sha1/integrity and the exact
published entry file. The package's locked dependency graph is installed so a
compile failure is not manufactured by omitting declared dependencies. None of
these fifteen npm tarballs ships its upstream unit-test sources. Their cards
therefore say “upstream suite — not shipped; adapter pending”; they do not
substitute harness-authored smoke vectors or imply that validation is a test
pass. Matching upstream source suites can be pinned and adapted package by
package, following the existing Acorn/React precedent.

The original package-specific harnesses, plus the deeper Acorn conformance
check, are:

| package                                 | issue | entry file                | oracle diff                                                                 |
| --------------------------------------- | ----- | ------------------------- | --------------------------------------------------------------------------- |
| **acorn** (JS parser)                   | #1710 | `dist/acorn.mjs`          | structural AST diff (`ast-diff.mjs`)                                        |
| **marked** (Markdown→HTML)              | #3716 | `lib/marked.esm.js`       | plain string equality (HTML output)                                         |
| **acorn official suite**                | #3729 | `dist/acorn.mjs`          | acorn's own real `test/tests*.js` (~3,500 cases)                            |
| **clsx** (className joiner)             | #3748 | `dist/clsx.mjs`           | per-op string equality (see below — driver epilogue, not a raw export call) |
| **cookie** (RFC-6265 parser/serializer) | #3751 | `dist/index.js`           | per-op JSON-normalized equality (direct export calls, no epilogue)          |
| **eslint** (JavaScript linter)          | #1400 | `lib/api.js`              | bounded full-package compile/validate; runtime diff pending                 |
| **prettier** (code formatter)           | —     | `standalone.mjs`          | bounded package-entry compile/validate; runtime diff pending                |
| **react** (UI library)                  | —     | `index.js`                | bounded package-entry compile/validate                                      |
| **react upstream suite**                | —     | `cjs/react.production.js` | React's own real `packages/react/src/__tests__` unit tests                  |

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

The harness currently reports compile/validate separately and leaves the test
count unavailable until the real `Linter.verify()` proof in #1400 is complete.
This is intentional: the npm-compat page includes unfinished packages such as
marked, and ESLint should be equally visible without overstating support.

## prettier and react

Prettier and React use the same committed-tarball integrity contract and
bounded package-entry harness. The generic
`package-entry-harness.mjs` helper verifies and extracts each exact npm
tarball, runs `compileProject` in a child process, validates any emitted Wasm,
and records runtime verification as unavailable until a real package API
differential test exists.

```bash
pnpm run dogfood:prettier
pnpm run dogfood:react
pnpm run dogfood:react-upstream-suite
DOGFOOD_PRETTIER=1 pnpm test -- tests/dogfood/prettier.test.ts
DOGFOOD_REACT_UPSTREAM=1 pnpm exec vitest run tests/dogfood/react-upstream-suite.test.ts
```

The current Prettier entry exposes a compile blocker. React's package entry
compiles to valid Wasm, but that alone is not reported as runtime correctness —
`react-upstream-suite.mjs` is what actually tests it, by running **React's own
unit tests**.

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

1. **Everything runs; the SCORE is what is guarded.** All 272 upstream tests
   that upstream does not itself `.skip` are compiled and executed, including
   the ones reaching for ReactDOM, `act`, `jest.*` or a `document`. Those are
   expected to fail — a failure that is run and counted is more honest than a
   test filtered out before it runs. What they are not is _compiler evidence_:
   the native oracle fails them too, so they land in `harness-incompatible` and
   sit outside the pass rate. The report prints all three numbers (run, scored,
   infra-blocked) so neither can hide the other.
2. **The `expect` shim implements only the matchers the admitted tests use**
   (`SUPPORTED_MATCHERS`); a test using anything else is rejected rather than
   scored against an approximation of Jest. The same shim source runs on both
   sides, so a divergence is always the compiler.
3. **A test the harness cannot reproduce natively is not evidence about the
   compiler.** It is excluded from the score under its own
   `harness-incompatible` bucket instead of being counted as a compiler bug.

Failures stay in the corpus. The vitest wrapper enforces a pass FLOOR, not a
target, so a regression is caught while the remaining frontier stays visible.

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
