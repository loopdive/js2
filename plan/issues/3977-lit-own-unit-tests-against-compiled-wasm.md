---
id: 3977
title: "Run lit's own unit tests against compiled lit, and stop measuring the `lit` tarball's four-line barrel"
status: in-progress
sprint: current
created: 2026-08-01
updated: 2026-08-20
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: test
area: dogfood
language_feature: compiler-internals
goal: dogfood
related: [3958, 3775, 3978]
---

# Run lit's own unit tests against compiled lit

## Problem

The npm-compat catalog carried `lit` with
`tests: {kind: "upstream-suite", status: "not-integrated", reason: "not shipped
in npm tarball; adapter pending"}` — an honest placeholder, and #3958 had just
established the pattern for closing exactly this gap on React.

But lit had a second problem React did not, and it invalidated the card that
*was* green. `lit/index.js` is a **four-line barrel**:

```js
import "@lit/reactive-element";
import "lit-html";
export * from "lit-element/lit-element.js";
export * from "lit-html/is-server.js";
```

The implementation ships in three **separate** packages that the `lit` tarball
does not contain. So the package-entry harness was compiling a re-export list —
201 bytes of output — and reporting "compiles + validates". That number was
never about lit.

## What was done

`tests/dogfood/lit-upstream-suite.mjs`, following the #3958 (React) precedent
with the pieces lit needs that React did not:

1. **Pin the packages that actually contain the implementation.** Three
   sha1-verified published tarballs — `lit-html@3.3.3`,
   `@lit/reactive-element@2.1.2`, `lit-element@4.2.2` — not the `lit` barrel.
   The monorepo tag `lit@3.3.3` carries exactly those three versions, verified
   at setup time, so there is **zero version skew** between the tests and the
   implementation under test.
2. **Resolve through the packages' own `exports` maps.** The tarballs are
   extracted into a real `node_modules` layout and bundled with esbuild, so a
   test's `import 'lit-html/directives/choose.js'` resolves to the file npm
   would actually serve — not to a path this harness guessed.
3. **Lift every upstream `test()`** with its `suite` scope and `setup` prelude,
   verbatim, from the verified commit. lit's tests are TypeScript, and the
   `decorators/` and `decorators-modern/` trees use LEGACY and STANDARD
   decorators respectively — each is transpiled with the setting upstream
   itself uses, because transpiling with the wrong one silently emits the other
   semantics.
4. **A chai `assert` shim** covering the 26 members lit's tests actually use
   (surveyed across all 58 files, not guessed). The same shim SOURCE is
   compiled into the Wasm module and evaluated for the native oracle, so a
   divergence is always the compiler and never a difference between two
   hand-written shims. `equal` is `==` and `strictEqual` is `===`, as chai
   defines them — lit depends on the difference.
5. **Stub, don't drop, what npm does not ship.** lit's repo-internal
   `../test-utils/…` helpers exist in no tarball. They resolve to a module that
   throws on use, so those tests still RUN and still fail on both sides,
   landing in `harness-incompatible` rather than vanishing from the corpus.

**583 of 587 upstream tests are admitted.** The 4 rejections are all
`upstream-skipped` — tests upstream itself marks `.skip`. Nothing is filtered
for being expected to fail: the ~90 % of lit's suite that needs a DOM runs too,
and the native oracle sorts it into `harness-incompatible` so it is never
blamed on the compiler.

### Ask whether the implementation compiles BEFORE compiling any test

The React harness halves a batch that fails validation, to bound #3775's blast
radius. Applied naively to lit that is not just slow, it is **wrong-headed**:
lit-html's implementation is itself invalid (#3978), so every batch containing
it is invalid, and halving bottoms out at one test and still fails. The first
run spent its entire wall clock subdividing toward a floor that did not exist.

So each file's bundled implementation is now compiled **alone, with no test
code**, first. If that module is invalid, the file's tests are recorded under
`compile.implementationInvalid` with the validator's own message and their test
compilation is skipped entirely. They are still run natively and still scored
as failures — never quietly dropped — but no time is spent subdividing.

That check is also what produced the more interesting result: it is the only
thing that could have shown that js2wasm cannot compile lit's published bytes
at all, which no per-test number would ever have surfaced.

## Result

The headline is not a pass rate — it is that the largest part of lit does not
compile to a valid module. See #3978, which this work found and which is filed
separately with its reproduction and the four hypotheses it rules out.

Additional distinct codegen failures surfaced by the reactive-element tests,
where the implementation IS valid and the per-test batches are not:

- `Codegen error: local index out of range — 34`
- `global.set[…]` in `__closure_0`
- `Codegen error: inherited class callable __anonClass_N_updated has no entry`

These are recorded per batch in the report rather than aggregated away.

## Browser infrastructure checkpoint (2026-08-20)

The Lit harness already installs jsdom before extraction and execution. The
shared browser bootstrap now also exports the DOM constructors that Lit's
upstream tests use directly (`HTMLAnchorElement`, `HTMLFieldSetElement`,
`HTMLLabelElement`, `HTMLSpanElement`, and `ElementInternals`). Conservative
extraction is now told which browser surfaces are actually supplied — DOM,
window, custom elements, shadow roots, constructable stylesheets, and Lit's
warning registry — instead of classifying those references as unavailable
infrastructure. A source-level audit of the pinned 587-test corpus reports
**583 admitted and 4 upstream-skipped** in both admit-all and conservative
modes.

This changes reachability only; it does not turn jsdom's incomplete browser
semantics or Lit's missing monorepo test utilities into passes. Those tests
continue to run, and native-oracle failures remain separate from compiler
failures. The remaining implementation/compiler frontier is still tracked by
#3978, #3979, and #3980.

## Handoff checkpoint (2026-08-20)

The reusable browser/test infrastructure is complete for this slice and is
shipped with the npm-compat adapter work in PR #4660. Do not raise Lit's
compatibility score from the admitted-test count alone: the published
`lit-html` implementation still emits an invalid module, and the
reactive-element batches still expose compiler failures such as invalid local
indices, `global.set` in closures, and inherited-class callable resolution.

The next owner should take #3978 first (make the published lit-html graph
validate), then revisit #3979/#3980 for the remaining reactive-element
code-generation failures. After those land, rerun the unchanged
`DOGFOOD_LIT_UPSTREAM=1` driver and update only the measured report; no test
source or harness-incompatible result should be reclassified as a pass.

## Acceptance criteria

- [x] The corpus is lit's own test sources at a verified commit, not
      harness-authored vectors.
- [x] The implementation under test is the three PUBLISHED packages that carry
      it, not the `lit` barrel; versions verified to match the tag.
- [x] Every upstream test that upstream does not itself `.skip` is RUN,
      including the ones that need a DOM.
- [x] Every upstream test is either scored or rejected with a recorded reason;
      `admitted + rejected == upstreamTestsSeen` is asserted.
- [x] Natively-unreproducible tests are scored in their own bucket, never as
      compiler failures.
- [x] A file whose implementation cannot produce a valid module is reported by
      name with the validator's message, and its tests are scored as failures
      rather than dropped.
- [x] The vitest wrapper enforces floors (regression gates), not targets.

## Permanent test reference

`tests/dogfood/lit-upstream-suite.test.ts` — pin/commit assertions run always;
the full run is gated behind `DOGFOOD_LIT_UPSTREAM=1`.

```bash
pnpm run dogfood:lit-upstream-suite
DOGFOOD_LIT_UPSTREAM=1 pnpm exec vitest run tests/dogfood/lit-upstream-suite.test.ts
```

## References

- #3958 — the React precedent this follows.
- #3978 — the compiler bug this suite found: lit-html's published bytes emit an
  invalid module.
- #3775 — same failure family (`global.set` against a wrong index, invisible to
  construct-level reduction).
