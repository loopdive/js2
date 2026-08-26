---
id: 4756
title: "npm-compat: close every remaining curated upstream-test and unavailable-infrastructure gap"
status: ready
created: 2026-08-26
updated: 2026-08-26
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: feature
area: dogfood, ci, codegen
language_feature: npm-packages, host-boundaries, async, modules
goal: npm-library-support
sprint: current
related: [3995, 4585, 4604, 4618, 4526, 4527, 3982, 3977, 4299, 3994, 4287, 1400]
---

# Close every remaining curated npm upstream-test gap

## Problem

The curated npm page contains 24 packages, but a green selected slice is not
the same thing as the original package suite being green. Only Acorn, Cookie,
clsx, and UUID currently have a complete measured denominator with no deferred
original tests. The other packages have scored failures, uncompiled test
modules, unavailable host/test infrastructure, or large entry graphs that do
not emit a valid package binary.

The current published artifact is also not a reliable single source for the
four packages advanced by merged
[PR 4849](https://github.com/loopdive/js2/pull/4849). The artifact generated at
`2026-08-26T09:19:46.561Z` is a partial refresh and marks 23 of 24 package rows
stale. For UUID, Axios, Hono, and Redux, the unchanged-suite post-merge run in
that PR is newer than the retained package partials. This issue records both
provenances rather than silently choosing the larger number.

Every result below uses original pinned test callbacks and inputs in both Node
and Wasm. Cached answers, package-specific source rewrites, and harness-authored
substitutes do not count.

## Exact census at the 2026-08-26 checkpoint

`Scored` is Wasm passes over the same Node-compatible callback denominator.
`Outside scored` is separate and must never be added to either passes or
failures. `Entry C/V` is the package-card entry compile/validate result, not the
selected test-module result.

| package | scored | outside scored | entry C/V | active owner and next boundary |
| --- | ---: | ---: | ---: | --- |
| Acorn 8.16.0 | **3518/3518** | 0 | 1/1 | Complete control; retain the full denominator. |
| Cookie 2.0.1 | **63740/63740** | 0 | 1/1 | Complete control; retain the full denominator. |
| clsx 2.1.1 | **32/32** | 0 | 1/1 | Complete control; retain the full denominator. |
| UUID 14.0.1 | **75/75** | 0 | 1/1 | Resolved by [UUID original-suite gaps](./4383-uuid-original-suite-runtime-and-callref-gaps.md); the published 28/75 row is stale. |
| Redux 5.0.1 | **55/82** | 0 | 1/1 | [Redux remaining observable, shadowing, and call clusters](./4526-redux-runtime-null-deref-illegal-cast-clusters.md): 27 scored failures, all 9 modules valid. |
| Axios 1.16.1 | **187/231** | 414 registrations / 16 files | 0/1 | [Axios remaining dynamic callback ABI](./4527-axios-class-call-concat-vararg-invalid-module.md): 44 scored failures; all 33 selected modules compile and validate. |
| Hono 4.12.16 | **180/322** | 2,031 registrations / 100 files; 2 native-incompatible registrations | 1/1 | [Original-suite umbrella](./3995-pin-and-adapt-original-upstream-test-suites-for-catalog.md): 142 scored failures; selected modules 17/20 compile and 16/20 validate. |
| React 19.2.6 | **133/180** | 92 harness-incompatible from 272/273 executed | 1/1 | [React async/act and class bridge](./4618-react-upstream-async-act-lanes.md): element/children identity, class lifecycle, forwardRef/StrictMode, JSX and mock-call clusters. |
| React DOM 19.2.6 | **18/194** | 984 harness-incompatible; 533 implementation-invalid in the 2,003-test inventory | 0/1 | [React DOM original suite](./3982-react-dom-own-unit-tests-against-compiled-wasm.md): client ref/global typing first; server/Fizz lanes independently. |
| TypeScript 5.9.3 | **9/11** | 1,750 registrations | 0/1 | [TypeScript pseudo-BigInt correctness](./4757-typescript-pseudobigint-octal-large.md) owns the two scored failures; [package graph traversal](./3994-bound-recursive-package-graph-traversal-for-typescript.md) separately owns the 600 s entry timeout. |
| ESLint 10.0.3 | **50/158** | the adapter currently covers five utility files only | 0/1 | [ESLint package entry](./1400-eslint-package-entry-valid-wasm.md) plus this issue: typed ref-array higher-order functions and serialization helpers; entry compile times out. |
| lodash 4.18.1 | **51/62** | 1,691 registrations | 0/1 | [Lodash module-init and lane report](./4533-lodash-module-init-null-call-and-es-lane-report.md): predicate/falsey/realm observations, iterable/string conversions; keep CJS entry diagnostics separate. |
| lodash-es 4.18.1 | **44/62** | 1,691 registrations | 1/1 | Same owner as lodash; modular string/predicate/conversion paths remain. |
| Jest 30.4.2 | **325/356** | 2,930 unavailable; 2 harness-incompatible | 1/1 | This issue: 31 scored failures in descriptor/clone/error/prompt semantics and timer/queue/call-ref paths. Old get-type and accessor-import headlines no longer describe the current rows. |
| Prettier 3.8.1 | **48/151** | 4 source files remain deferred | 1/0 | [AstPath heterogeneous stack](./4531-prettier-astpath-heterogeneous-stack-illegal-cast.md) and [Error subclass names](./4532-error-subclass-constructor-name.md). Selected modules 16/16 compile, 10/16 validate. |
| Moment 2.30.1 | **4/10** | 2,628 registrations | 1/1 | [Moment live JS resolution](./4384-moment-js-entry-resolves-to-adjacent-declaration.md) and [closure capture validation](./4525-moment-closure-capture-i32-ref-validation.md). A 10/10 branch checkpoint is not a mainline claim until landed and rerun. |
| Marked 18.0.2 | **0/30** on the card; synchronous Hooks **0/15** | 15 async Hooks callbacks plus 5 heavier files | 0/1 | [Marked host/runtime gap](./4435-marked-upstream-host-runtime-gap.md): `use` receiver/callback path, then generic async callback continuation. The separate fixture lane is 8/8. |
| Lit 3.3.3 | **0/151** | 432 harness-incompatible; 398 implementation-invalid in 587 discovered tests | 1/0 | [Lit original suite](./3977-lit-own-unit-tests-against-compiled-wasm.md) and [published-byte invalid module](./3978-lit-html-published-bytes-emit-invalid-module.md): fix ref operands before directive semantics. |
| Three.js 0.185.1 | **17/18** | 1,295 registrations | 0/1 | [MathUtils `damp` numeric mismatch](./4535-three-mathutils-silent-wasm-failures.md): one exact floating result differs. |
| jsdom 30.0.1 | selected **6/6** | 312 API registrations | 0/1 | [Full jsdom API suite](./4299-jsdom-original-api-suite.md): the six VirtualConsole tests are green; full `lib/api.js` still produces no binary within 180 s. |
| webpack 5.109.2 | selected **16/16** | 1,341 registrations | 0/1 | [Webpack/Tailwind compile budget](./4287-webpack-tailwind-package-compile-budget.md) plus this issue for coverage expansion. |
| Tailwind CSS 4.3.3 | selected **13/13** | 1,363 registrations | 0/1 | Same owner as webpack; selected utilities are green, entry graph times out. |
| styled-components 6.4.4 | selected **9/9** | 659 registrations | 1/1 | This issue owns expansion beyond pure utilities into React/DOM/SSR/Stylis without relabeling it as already passing. |
| Stylelint 17.14.1 | selected **108/108** | 1,466 registrations | 0/1 | This issue owns coverage expansion; the former array/webpack residual issue is complete. |

## Failure families, not error-message buckets

Error text identifies where execution stopped, not necessarily one root cause.
Implementers must reduce representative rows and prove attribution by removing
the candidate fix. The current work separates into these independently
measurable families:

1. **Scored dynamic-call and object-carrier semantics** — Redux, Axios, Hono,
   React, ESLint, lodash/lodash-es, Jest and Prettier.
2. **Invalid test or package modules** — React DOM, Lit, Marked and some Hono
   modules. Repair validity before interpreting downstream runtime failures.
3. **Small numeric/value correctness residues** — TypeScript's two
   `parsePseudoBigInt` rows and Three's one `MathUtils.damp` row.
4. **Package-graph scale** — TypeScript, jsdom, ESLint, webpack, Tailwind,
   Stylelint and the CommonJS lodash entry. A timeout is not a unit-test fail.
5. **Unavailable test infrastructure** — async callbacks/fake timers,
   snapshots, filesystem/server/socket/stream fixtures, DOM/resource loading,
   browser/WebGL, native/Rust helpers, and large multi-package graphs.

## Implementation plan

### Phase 0 — make the measurement impossible to overstate

1. Keep one immutable upstream pin and complete file/registration inventory per
   package.
2. Emit, for every run: Node passes/total, Wasm passes/total, admitted,
   discovered, harness-incompatible, implementation-invalid, unavailable,
   selected module compile/validate, and package-entry compile/validate.
3. Reject a silent-empty result: every adapter has a positive registration
   floor and a deliberately failing assertion control.
4. Fix the partial-refresh path under [npm refresh resilience](./4585-npm-compat-refresh-resilience.md)
   and [refresh timeout](./4604-npm-compat-refresh-runtime-exceeds-timeout.md)
   so a stale package partial cannot overwrite a newer verified checkpoint.

### Phase 1 — close bounded scored denominators in parallel

These first three lanes have unchanged, fully enumerated denominators and do
not need new host infrastructure:

1. [TypeScript pseudo-BigInt correctness](./4757-typescript-pseudobigint-octal-large.md):
   `9/11 -> 11/11`.
2. [Redux remaining observable, shadowing, and call clusters](./4526-redux-runtime-null-deref-illegal-cast-clusters.md):
   `55/82 -> 82/82` with all 9 modules still valid.
3. [React async/act and class bridge](./4618-react-upstream-async-act-lanes.md):
   first remove the bounded async/class/props substrate failures, then rerun the
   complete 273-test inventory.

Next, without overlapping those files, take Axios's iterable/Error carrier,
Hono's route tuple/private dispatch, Three's one numeric mismatch, Prettier's
two existing child issues, and Moment's resolver/capture issues. Do not dispatch
Axios while its existing issue claim remains live.

### Phase 2 — valid modules before semantic interpretation

1. React DOM client: repair `trackValueOnNode` ref/global typing and module-init
   null carriers; rerun the client lane only.
2. React DOM server/Fizz: keep legacy server stack balance, browser timeout,
   and Node async-in-try as independent A/Bs.
3. Lit: repair published `lit-html`/`lit-element` GC-ref versus externref call
   operands, then separately address ReactiveElement closure/callable-class
   frames and directive null carriers.
4. Marked: make the Hooks implementation module and mixed-arity `use` receiver
   path valid before admitting the 15 async callbacks.

### Phase 3 — expand original tests by reusable infrastructure

Expand complete original files in ascending dependency cost; do not cherry-pick
individual passing callbacks:

1. synchronous dependency-light utilities and package-internal modules;
2. promises, async callbacks, fake timers, mocks and lifecycle hooks;
3. snapshots, filesystem, HTTP/server/socket/stream fixtures;
4. DOM/resource loading and browser/WebGL/native-helper graphs.

Every infrastructure addition must be generic, covered by a runner regression,
and reused by at least one independent package control where practical. A newly
admitted failing test increases the scored denominator; it is not a regression
and must not be moved back to `unavailable`.

### Phase 4 — full package-entry compile and validation

Profile phase and graph-unit progress before raising a timeout. Land generic
bounded scheduling/compile-once work for TypeScript, jsdom, ESLint, webpack,
Tailwind, Stylelint and lodash, preserving all natively reachable modules.
Selected utility modules passing does not excuse a red package entry.

### Phase 5 — CI and publication

Wire every expanded package adapter into the merge-only npm-compat workflow.
The workflow must refuse missing numeric results, retain the last good result
with explicit stale provenance when a worker fails, and publish the same
denominators used by the implementation PR. Performance remains reported but
is not a merge gate.

## Acceptance criteria

- [ ] All 24 curated packages retain an immutable upstream pin and complete
      original test inventory.
- [ ] Every original test is either executed in both Node and Wasm or has one
      exact, reviewable infrastructure reason; no test silently disappears.
- [ ] All Node-compatible original tests pass in Wasm, with unchanged callback
      bodies, inputs and expectations.
- [ ] Unavailable infrastructure reaches zero except tests that the pinned
      upstream suite itself cannot execute in the selected Node environment.
- [ ] Every package entry compiles within a measured bounded budget and emits a
      valid Wasm module, independently of selected test-module success.
- [ ] Acorn 3518/3518, Cookie 63740/63740, clsx 32/32, and UUID 75/75 remain
      non-vacuous zero-withdrawal controls.
- [ ] The merge-only npm-compat workflow publishes the fresh per-package rows;
      performance measurements are informational, never a correctness gate.
