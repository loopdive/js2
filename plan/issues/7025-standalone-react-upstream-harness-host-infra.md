---
id: 7025
title: "dogfood: React upstream suite scores 0/180 in the standalone unit lane — the compiled-in React test shim reaches jsdom (`document.implementation.createHTMLDocument` → `env.DOMImplementation_createHTMLDocument`) and the host-installed `globalThis.__js2ReactUpstreamInfrastructure` (renderers, scheduler mock, jsx runtimes), so every batch is refused by the zero-import check"
status: ready
sprint: current
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: infra
language_feature: dogfood, npm-compat
goal: standalone-gap
related: [7013, 7016, 7022]
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

## Acceptance criteria

- The standalone React report has no batch refused for a host import that the
  harness (not the package) introduced.
- Tests that need a carrier the standalone lane does not compile in are
  reported as harness-incompatible with the carrier named, not as `skipped`.
- JS-host React numbers unchanged (150/180 at the time of filing).
