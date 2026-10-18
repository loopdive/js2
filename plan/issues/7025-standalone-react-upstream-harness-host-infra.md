---
id: 7025
title: "dogfood: React upstream suite scores 0/180 in the standalone unit lane — the compiled-in React test shim reaches jsdom (`document.implementation.createHTMLDocument` → `env.DOMImplementation_createHTMLDocument`) and the host-installed `globalThis.__js2ReactUpstreamInfrastructure` (renderers, scheduler mock, jsx runtimes), so every batch is refused by the zero-import check"
status: done
completed: 2026-10-18
sprint: current
created: 2026-10-17
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: infra
language_feature: dogfood, npm-compat
goal: standalone-gap
related: [7013, 7016, 7022, 7085]
loc-budget-allow:
  # 2026-10-18 (#7025): +1 line — the element-call ladder reserves the number /
  # boolean boxers before its arms are built (`reserveScalarResultBoxers`); the
  # bridge logic itself lives in dispatch-extern-result-bridge.ts.
  - src/codegen/expressions/calls-closures.ts
---

# React upstream suite in the standalone lane: the harness, not React, needs a host

## Problem

The #7013 standalone lane (`JS2WASM_UPSTREAM_TARGET=standalone node --import tsx
tests/dogfood/react-upstream-suite.mjs`, measured 2026-10-17, report
`tests/dogfood/report/react-upstream-suite.standalone.json`) scores **0/180**
(272 of 273 tests executed, 92 harness-incompatible as in the JS-host lane).
All 180 scored tests are `skipped` with one reason:

```
standalone: standalone binary retained 1 host import(s): env.DOMImplementation_createHTMLDocument:function
```

All 44 batches validate; none instantiates with an empty import object.
The JS-host lane scores 150/180 (npm-compat.json, 2026-10-15).

The import does not come from the `react` package. It comes from
`REACT_EXPECT_SHIM` (`tests/dogfood/react-upstream-shim.mjs`), which every
batch concatenates in full:

- `__js2ReactDOMServerIntegrationTestUtils` (`getContainerFromMarkup`, ~L1017)
  calls `document.implementation.createHTMLDocument("")`. On `--target
  standalone` that member chain compiles to a host import, even in batches
  whose tests never `require("./utils/ReactDOMServerIntegrationTestUtils")`.
- Behind that first refusal is a second, larger dependency:
  `__js2ReactInfra()` (59 call sites) reads
  `globalThis.__js2ReactUpstreamInfrastructure`, which
  `react-upstream-infrastructure.mjs` installs **on the host**: `react-dom`,
  `react-dom/client`, `react/jsx-runtime`, `react/jsx-dev-runtime`,
  `scheduler/unstable_mock`, `react-test-renderer`, `react-noop-renderer`,
  web streams, and the fallback `require`. A standalone module has its own
  `globalThis`, so the read yields `undefined` and those tests would throw
  `React upstream test infrastructure is not installed` once the import is gone.
  Only `require("react")` resolves to the compiled `__REACT__`.

So the 0 is a harness-boundary finding: React's Jest environment is host
infrastructure in the JS-host lane, and the standalone lane must decide what of
it is compiled in.

## Implementation Plan

1. **Measure the second layer first (no code change to the lane).** In a
   `.tmp/` probe, compile one batch (e.g. `ReactCreateElement-test.js`) with
   `STANDALONE_COMPILE_OVERRIDES` after deleting the
   `__js2ReactDOMServerIntegrationTestUtils` body, instantiate with `{}`, and
   run it through `runStandaloneUpstreamTestsIsolated`. Record per-test errors
   and bucket them: (a) passes, (b) `infrastructure is not installed` (which
   carrier), (c) genuine compiler failures. This tells how many of the 180 are
   reachable without any host infrastructure.
2. **Stop shipping DOM helpers to batches that do not use them.** In
   `react-upstream-suite.mjs` `buildModuleSource`, include
   `__js2ReactDOMServerIntegrationTestUtils` / `__js2IntersectionMocks` /
   the `executeScript` jsdom helpers only when a test in the batch requires the
   module that returns them (the extractor already knows each test's
   `require` specifiers). This keeps the JS-host lane's module byte-identical
   when the flag is off (gate it on `isStandaloneUpstreamLane()` if the shim
   split cannot be made output-neutral) — hash the JS-host batch sources
   before/after.
3. **Compile the pure-JS carriers in.** `react/jsx-runtime`,
   `react/jsx-dev-runtime` and `scheduler/unstable_mock` are plain JavaScript
   in the pinned React checkout; in the standalone lane resolve them to
   compiled sources concatenated into the batch (as `__REACT__` already is)
   instead of `__js2ReactInfra()`. Renderers (`react-dom`, test/noop
   renderers) are separate packages: either compile them into the batch the
   same way (size permitting — batches are already ~1.2 MB) or score those
   tests `harness-incompatible: needs <carrier> in standalone` explicitly,
   never as Wasm failures.
4. **Never stub.** A test whose carrier cannot be compiled in stays visibly
   out of the scored set with its reason; the zero-import refusal in
   `instantiateStandaloneResult` is not relaxed.

### Measured revision (2026-10-18, wave 17)

Step 1 was run first. Removing only the harness-introduced import (compiler
side: `DOMImplementation` joins the unprovided lib.dom document interfaces of
#6841, so `document.implementation.createHTMLDocument` lowers behind the
`document` ReferenceError instead of `env.DOMImplementation_createHTMLDocument`)
made all 44 batches instantiate with `{}`, and the lane read **5/180**. The
per-test buckets then showed that most of the remaining failures were not host
infrastructure at all but two standalone compiler defects that every batch
hits:

- **(c1) user `escape` shadowed by Annex B.** React's own
  `function escape(key)` (child-key escaping) was lowered to the Annex B
  `escape` builtin by `compileAnnexBEscapeCall`, which never checked that the
  callee is the ambient binding — every mapped child key lost its `$`
  (`.$simple` read as `.simple`). Fix: return early unless
  `resolvesToAmbientGlobal` (the #5158 helper the non-constructor checks use).
- **(c2) union-of-signatures dispatch dropped the live result.** The harness
  dispatches lifted tests through one array; a batch holding a sync and an
  async test types it `(() => number) | (() => Promise<number>)`, so the call
  site expects externref (or `$AnyValue` for `number | string`). The ladder
  arms for the `f64` / native-string candidates fell into the dead-arm
  placeholder (`drop` + `ref.null`), so every synchronous `return 1` read back
  as a failure. Fix (no-host lanes only, `dispatch-extern-result-bridge.ts`):
  `anyValueResultBridge` boxes into `$AnyValue` with an inline `struct.new`
  (the `__any_box_*` layout; no call, no registration — #2174),
  `boxedScalarResultBridge` boxes `f64`/`i32` through an already-registered
  `__box_number`/`__box_boolean`, and `reserveScalarResultBoxers` registers
  those (native helpers on these lanes) BEFORE the element-call ladder is
  built. The identifier-call ladder admits such candidates
  (`liveResultBridgeable`) instead of ending in its TypeError terminal.

With c1+c2 the lane reads 74/180. The rest splits into:

- **Host-carrier-bound (not reachable from a zero-import module):** tests that
  render through ReactDOM into a jsdom container (`document is not defined`),
  and tests that call the host `__js2ReactUpstreamInfrastructure`
  (test renderers / noop renderer / internal-test-utils console capture /
  create-react-class with Node's `process.env` / web-streams-polyfill).
  These rows now carry `standaloneCarrier` naming the carrier, and the summary
  reports `standaloneCarrierBound` / `standaloneReachable`. The denominator
  stays 180 so the standalone score stays comparable with the JS-host lane.
- **Compiled in (step 3, pure JS from the pinned tarball):**
  `react/jsx-runtime`, `react/jsx-dev-runtime` and the tarball's
  `package.json` version, only into batches whose tests require them; the
  shim prefers a compiled carrier when present, so the JS-host lane resolves
  exactly as before. The `patchMessageChannel` prelude binding now uses the
  shim's own no-op instead of reading the host infrastructure object.
- **Remaining compiler defects (filed as residuals):** a React element's
  `.constructor` reads `undefined` (struct-typed object literal without the
  `Object.prototype` link, 2 rows); an iterable child object
  (`{[Symbol.iterator]: …}`, 1); the regex-child error message (1).

Step 2 (splitting the DOM helpers out of the shim) became unnecessary: once the
lib.dom member no longer imports, the helper costs nothing in batches that do
not call it.

## Acceptance criteria

- The standalone React report has no batch refused for a host import that the
  harness (not the package) introduced.
- Tests that need a carrier the standalone lane does not compile in are
  reported as harness-incompatible with the carrier named, not as `skipped`.
- JS-host React numbers unchanged (150/180 at the time of filing).

## Resolution

Standalone React upstream lane (`JS2WASM_UPSTREAM_TARGET=standalone node
--import tsx tests/dogfood/react-upstream-suite.mjs`), measured on this branch:

| state | score |
| --- | --- |
| upstream/main (2cc1516657) | 0/180 — every batch refused: `env.DOMImplementation_createHTMLDocument` |
| + `DOMImplementation` unprovided | 5/180 |
| + Annex B `escape` shadow + union-dispatch result | 74/180 |
| + jsx runtimes / package.json compiled in, `patchMessageChannel` | **77/180** |

**Reachable count:** 82 of the 180 scored tests run without a host carrier;
98 need one (63 render through ReactDOM into a jsdom container — `document is
not defined`; 35 call the host infrastructure: noop / test renderers,
internal-test-utils console capture, create-react-class with Node's
`process.env`, web-streams-polyfill). 77 of the 82 pass; the 5 left are
compiler defects filed as [#7085](./7085-standalone-react-reachable-residuals.md).

- JS-host React lane: 150/180 before and after, per-test statuses identical.
- JS-host bytes: sha256 of the gc binary identical before/after for 24
  fixtures (13 playground examples, 2 React batch modules, 9 standalone repros).
- Scoped standalone test262 (1133 rows: `annexB/built-ins/{escape,unescape}`,
  `language/expressions/call`, `language/{expressions,statements}/async-function`,
  `built-ins/Array/prototype/{forEach,map,reduce}`,
  `built-ins/Function/prototype/{apply,call}`, `built-ins/Promise/prototype/then`):
  949 → 953, 0 regressions. The 4 new passes are async functions returning a
  closure that a `.then` callback calls (`returns-async-*-returns-arguments-*`)
  — the union-dispatch fix; the callback's result was dropped to null before.
- `tests/issue-7025-standalone-react-harness.test.ts`: parent 3 fail / 2 pass
  (the 2 are controls: JS-host keeps its DOMImplementation import, the ambient
  Annex B `escape` still runs), fix 5/5.

Deviation from the acceptance wording: carrier-bound rows stay in the scored
set (status `fail`, `standaloneCarrier` names the carrier, summary
`standaloneCarrierBound` / `standaloneReachable`) instead of moving to
`harness-incompatible`, so the standalone denominator stays 180 and comparable
with the JS-host lane. No batch is refused for a harness-introduced import.

Residuals: create-react-class needs a bundler-style `process.env` and a
Wasm-side console capture before it can be compiled in; web-streams-polyfill
4.3.0 does not compile standalone yet (`Cannot access 't' before
initialization`, `new Promise` in a class, a stack-balance invariant); the
renderers and jsdom are out of scope for a zero-import module.
