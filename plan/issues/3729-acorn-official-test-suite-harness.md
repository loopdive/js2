---
id: 3729
title: "Run acorn's OWN real test suite (not just fixtures) against compiled acorn — 99.7% pass"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: high
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: core-semantics
origin: "user asked whether the dogfood harness runs the packages' own bundled unit tests — it didn't (npm tarballs strip test/); this adds the real suite via source acquisition"
related: [1710, 3717, 3730, 3728]
---

# #3729 — acorn official test-suite harness

## Problem

`tests/dogfood/`'s existing acorn scripts (`acorn-harness.mjs`,
`acorn-corpus.mjs`, `acorn-probe.mjs`, `acorn-test262.mjs`) all
differentially test compiled acorn against a small, hand-written fixture
corpus (a handful of `.js` files). None of them run acorn's **own** real
test suite — and they physically can't from the pinned npm-pack tarball:
published npm tarballs strip `test/` entirely (confirmed empty on the
committed `acorn-8.16.0.tgz`; only `dist/`, `README`, `package.json`,
`bin/` ship). A hand-picked fixture corpus, however careful, is a much
weaker signal than the parser's own ~3,500-case authoritative conformance
suite.

## What changed

- `tests/dogfood/acorn-test-suite-pin.json` — pins acorn's test suite by
  exact commit SHA (not just tag) at the same version as the existing
  dist pin, same integrity discipline via a different mechanism (git, not
  npm sha1) since the test suite isn't npm-published.
- `tests/dogfood/setup-acorn-test-suite.mjs` — acquisition: shallow
  `git clone --branch <tag>`, verifies `git rev-parse HEAD` against the
  pin (refuses on drift), then stitches the ALREADY sha1-verified dist
  bytes from `setup-acorn.mjs`'s pinned tarball into the clone's
  `acorn/dist/` so the test files' own `require("../acorn")` resolves —
  avoids running acorn's real rollup build (and pulling its whole
  devDependency tree) just to reproduce bytes already verified.
- `tests/dogfood/acorn-official-suite.mjs` — the harness. Loads acorn's
  real `test/driver.js` + all `test/tests*.js` files (their own internal
  `require("../acorn")` builds EXPECTED-AST fixtures against real acorn —
  never used to do the actual parsing-under-test), compiles the pinned
  acorn source with js2wasm, then calls the driver's `runTests(config,
  callback)` — fully decoupled from any specific acorn build, it just
  needs a `parse(code, options)` function — with compiled-acorn's `parse`.
- `tests/dogfood/acorn-official-suite.test.ts` — vitest wrapper, opt-in
  (`DOGFOOD_ACORN_OFFICIAL=1`, child-process invocation, same rationale as
  `acorn.test.ts`). **Unlike the other acorn wrappers, this one gates on a
  real regression floor** (`results.passed >= 3507` at `results.total ===
  3518`) rather than just "the harness completed" — this suite is
  authoritative enough that a drop is worth failing CI over.
- `pnpm run dogfood:acorn-official-suite` script; `.gitignore` +
  `biome.json` entries for the new `.acorn-test-suite/` extraction dir
  (same class of fix as #3699's `.marked/` gap — a copied `acorn.d.ts`
  inside the gitignored clone would otherwise match biome's
  `tests/**/*.ts` include glob).

## A real bug found and fixed along the way (not a compiler bug)

Wiring compiled-acorn's `parse` into acorn's driver first crashed the
driver: compiled-acorn's `throw` lowers to a bare `WebAssembly.Exception`
with **zero** JS-reflectable payload (`Object.keys(e)` empty, `.message`/
`.stack` both `undefined`), but the driver needs a real `.message` to
compare against each test's expected error text. Initially this made the
pass rate look catastrophic (55.2%, 1943/3518) — nearly every genuine
"correctly threw a syntax error" case showed up as "Got error message:
`[object WebAssembly.Exception]`", indistinguishable from actually not
throwing at all.

Fixed by routing the caught exception through
`extractWasmExceptionMessage` (`tests/test262-runner.ts`) — the project's
own already-established mechanism for exactly this problem (#2962),
previously believed standalone/wasi-specific but confirmed here to also
recover JS-host-mode exception payloads via the module's `__exn_tag`
export. After the fix, the real pass rate is **99.7%**, not 55.2% — the
harness itself was the entire gap, not the compiler.

## Result: 3,507 / 3,518 (99.7%)

11 real residual failures, filed separately (properly scoped, not fixed
here — this issue is the harness):

- **#3730** — comment-collection (`onComment`) arrays come back empty
  across the Wasm boundary (6 cases).
- **#3728** — astral (surrogate-pair) Unicode identifier characters
  misclassified in a few edge positions (4 cases), plus one unrelated
  extremely narrow CJK string-literal-export-binding error-message
  oddity (1 case).

## Acceptance criteria

- [x] `pnpm run dogfood:acorn-official-suite` acquires both pins, compiles
      acorn, runs the real driver against it, and emits a structured
      report (`tests/dogfood/report/acorn-official-suite.json`,
      gitignored).
- [x] Vitest wrapper passes with a real regression floor, not just
      structural completeness.
- [x] The exception-message extraction gap is fixed via the project's
      existing #2962 mechanism, not a new one.
- [x] Residual failures triaged into buckets and filed as separate,
      properly scoped issues (#3730, #3728).
