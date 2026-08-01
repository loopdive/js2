---
id: 3982
title: "Run react-dom's own unit tests against compiled react-dom; its published client module does not compile"
status: in-progress
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: test
area: dogfood
language_feature: compiler-internals
goal: dogfood
related: [3958, 3977]
---

# Run react-dom's own unit tests against compiled react-dom

## What was done

`tests/dogfood/react-dom-upstream-suite.mjs`, built on the #3958 React suite
rather than beside it: the test extractor (`react-upstream-extract.mjs`) and the
`expect` shim (`react-upstream-shim.mjs`) are reused verbatim, because
react-dom's tests are the same Jest + JSX + `describe`/`it` shape from the same
repository at the same commit. The suite reuses React's already-verified
checkout, so the two cannot drift onto different revisions of the same repo —
the setup asserts the shared tag and commit and fails loudly otherwise.

Three things genuinely differ, and each is why a separate harness exists:

1. **Two published CJS modules** make up the implementation — the shared entry
   plus the 536 KB client renderer — and each needs its OWN function scope.
   react and react-dom both declare a top-level `noop`, so a bare concatenation
   dies with `Duplicate identifier 'noop'` before a single test runs.
2. `require("react")` / `require("react-dom")` / `require("scheduler")` inside
   those modules are rewired to the in-module values, so what runs is the
   published implementation wired to the published implementation. `scheduler`
   is not in the react-dom tarball and is an empty object; anything that needs
   it fails identically on both sides.
3. The implementation is compiled **alone first** (the #3977 lit lesson).

**1942 of 2003 upstream react-dom tests are admitted** — the whole public
`packages/react-dom/src/__tests__` tree, 115 files.

## Result: the implementation does not compile

```
react-dom implementation alone (547 KB):
  INVALID — Signature declarations can only be used in TypeScript files.
```

Seven diagnostics on a plain **`.js`** file: 2 × `Signature declarations can
only be used in TypeScript files` (TS8017) and 5 × `Type annotations can only be
used in TypeScript files` (TS8010). No test in the corpus ever had a chance, so
the pre-check is the result — and it is the result no per-test number would have
surfaced.

### Not localised, and the obvious method does not work

**Prefix bisection is unsound for this diagnostic.** Truncating the file inside
a function body leaves `function () {` with no body, which TS reports with the
*same* TS8017 message. A prefix bisect therefore converges on wherever it was
cut, not on the trigger — it pointed confidently at line 5902
(`setTimeout(function () {`), which is an artefact of the cut. Anyone picking
this up should not repeat it.

**Reading the position off the complete file does not work either**: all seven
diagnostics report `line 1, column 1` for a 16,050-line input. A parse
diagnostic with no usable position on a half-megabyte file is its own defect —
it is what makes this bug expensive to chase — and is worth fixing regardless of
the underlying syntax issue.

So the trigger is **not identified**. What is established: it is parse-level
(not codegen), it is in the react-dom client module (react alone compiles fine
in #3958), and it reproduces on the published bytes with nothing else attached.

## Why scored is 0

All 1942 admitted tests fail the NATIVE oracle too — react-dom's suite needs a
jsdom `document`, `internal-test-utils` and jest's module registry, none of
which the harness supplies. They land in `harness-incompatible` and sit outside
the score, exactly as in #3958. So the headline is `0/0` scored, with the real
finding carried by `summary.implementationInvalid` rather than by a pass rate.

Scoring react-dom meaningfully needs that infrastructure supplied to the oracle —
real work, deliberately not attempted here, and pointless before the
implementation compiles at all.

## Acceptance criteria

- [x] The corpus is react-dom's own test sources at a verified commit shared
      with the react suite.
- [x] Every upstream test that upstream does not itself `.skip` is RUN.
- [x] `admitted + rejected == upstreamTestsSeen` is asserted.
- [x] The implementation is compiled alone and reported by name with the
      compiler's own message when it fails.
- [ ] react-dom's published client module compiles to a valid Wasm module.
- [ ] Parse diagnostics carry a real source position instead of `1:1`.

## Permanent test reference

`tests/dogfood/react-dom-upstream-suite.test.ts` — pin/commit assertions run
always; the full run is gated behind `DOGFOOD_REACT_DOM_UPSTREAM=1`.

```bash
pnpm run dogfood:react-dom-upstream-suite
DOGFOOD_REACT_DOM_UPSTREAM=1 pnpm exec vitest run tests/dogfood/react-dom-upstream-suite.test.ts
```
