---
id: 6741
title: "jsdom standalone compile does not finish: per-body-source module-init census re-validation is quadratic"
status: done
completed: 2026-09-29
sprint: Backlog
created: 2026-09-28
updated: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
goal: npm-library-support
lane: A
related: [3494, 3525, 6737, 6745]
loc-budget-allow:
  # 2026-09-29 (#6741): +3 — the two per-entry census calls in
  # `#stateForBodySource` / `#stateForOverlaySource` name the entered source
  # (one import line, one `entered` const); the logic lives in the census module.
  - src/codegen/multi-prepared-program.ts
files:
  - src/codegen/multi-prepared-module-init-census.ts
  - src/codegen/multi-prepared-program.ts
  - src/codegen/context/locals.ts
---

# #6741 — jsdom standalone compile does not finish (quadratic census re-validation)

## Problem

Once #3494 let standalone `import()` compile, the jsdom `standalone-dynamic`
lane stopped failing in 56 s on the dynamic-import refusal and instead ran
more than 60 CPU-minutes without finishing (killed). CPU profiles (8 s
samples via the inspector, 2026-09-28) of `compileProject` on the lane driver:

- ~70 % of samples: `#stateForBodySource` →
  `assertMultiPreparedModuleInitCensusCurrent`
  (`currentSourceSyntax` / `captureLegacyObservation` /
  `nodeSyntaxScalarFields` / `terminalRecordsFor`). The assertion re-walks
  EVERY source's syntax on each body-source compile: O(sources x graph
  syntax). With the assertion short-circuited locally (diagnostic only) the
  compile still ran >25 CPU-min, now in `compileDeclarations` self time.
- Earlier phase: `snapshotLocals` (`speculative.ts`) copies the whole
  `localMap` per speculative object-literal compile in the flattened module
  init — GC-bound on a module init with a very large local count.
- (Fixed in #3494: `receiver-flow-analysis.ts` `resolveLocalBinding`
  re-walked every enclosing scope per receiver.)

## Acceptance criteria

- The census invariant is checked once per source (or incrementally), not
  per body source over the whole graph; same invariant strength.
- jsdom `--lane standalone-dynamic` reaches a verdict (pass or a named
  codegen blocker) within the lane budget; report the next blocker verbatim.
- Standalone output byte-identical on the dogfood-validation set.

## Implementation Plan

Owner decision for #3525 (the census invariant): split WHERE each fact is
re-derived, not WHAT is checked.

1. `src/codegen/multi-prepared-module-init-census.ts`
   - Factor the check into `assertCensusCurrent(census, focus)`.
     `assertMultiPreparedModuleInitCensusCurrent(census)` = `focus` undefined =
     the old whole-program check, byte-for-byte the same conditions.
   - New `assertMultiPreparedModuleInitCensusSourceCurrent(census, sourceFile)`:
     keeps every whole-program join / order / legacy-queue identity check
     (O(sources + queue) map lookups, so queue drift anywhere is still caught
     on every entry) and re-derives the three O(program) facts — AST syntax
     walk, terminal denominator, legacy parity report — for the ENTERED source
     only. An entered source that is not a census source fails `source-join`.
   - `censusInventoryIndex(inventory)`: `sourceId → record` and
     `sourceId → terminal ids`, cached per inventory object. Sound because
     `buildIrUnitInventory` freezes the inventory, its `sources` /
     `terminalUnits` arrays and every record; a non-frozen inventory (test
     double) is re-indexed per call. Also replaces the build-time
     `inventory.sources.find` / `terminalRecordsFor` scans (O(S²), O(S·T)).
2. `src/codegen/multi-prepared-program.ts`
   - `#stateForBodySource`: focused check on the expected (semantic-order)
     source; past the end → whole-program check.
   - `#stateForOverlaySource`: the first overlay visit is the body→overlay
     phase boundary → whole-program check; later visits → focused.
   - Whole-program checks still run at census build, queue reconciliation,
     module-init registration, `sealBodyBoundary`, the final-body callable
     commit, `sealRoutesComplete` and `complete` — so any drift that survives
     to a boundary fails closed before an artifact is published.
3. Test `tests/issue-6737-census-entry-scope.test.ts`: seeded AST drift fires
   at the drifted source's entry and at the whole-program check; entering a
   different source does not re-walk it; an already-entered source's drift
   fires at `sealRoutesComplete`; whole-queue drift is caught on any entry;
   a foreign entered source is rejected.

What the per-entry check no longer catches: an AST edit to a source OTHER
than the entered one that is reverted before the next entry of that source
and before the next phase boundary. The old check caught it only if an entry
happened to fall inside the window.

## Resolution

Implemented as planned (PR on branch `issue-6737-6741-census-scoped`).

Regression test: parent 5 fail / 1 pass, fix 6/6 pass. Existing #3525 suites
(`issue-3525-ordered-module-init-census`, `issue-3525-multi-prepared-program-census`)
25/25 pass.

lodash-es lane driver, `optimize: 0`, codegen only (same box, load 150–210):

| | before (main `c8b4f0ef36`) | after |
|---|---|---|
| standalone compile | 424.6 s | 220.2 s (249.8 s under `--cpu-prof`) |
| standalone sha256 | `f5349301…` (5,822,763 B) | `f5349301…` (identical) |
| JS-host (`gc`) compile | 401.1 s | 220.3 s |
| JS-host sha256 | `43ba3a44…` (4,877,855 B) | `43ba3a44…` (identical) |
| census share (cpu-prof) | 43 % of codegen (#6737 note) | 7.6 % (syntax walk 0.5 %; rest is the per-entry whole-queue check) |

jsdom (1,033 sources, 8,495 module-init statements): on current main the
compile never reaches the quadratic region. Base and fix both stall in the
FIRST body source's first module-init pass
(`codegen/bodies/…/tldts-core/dist/es6/src/domain.js/module-init-pass1`),
which runs after only one census entry. Inspector windows in that pass:

| | GC | `snapshotLocals` self | census check |
|---|---|---|---|
| base (main `c8b4f0ef36`), 180 s | 88.7 s (49 %) | 31.6 s (18 %) | 0 % |
| fix, 240 s / 180 s | 52 % / 60 % | 21 % / 8.5 % | 0 % |

So the lane verdict is unchanged by this fix (does not finish → does not
finish); the per-entry cost it removes is what jsdom would have hit on each
of its remaining 2,065 entries (1,032 bodies + 1,033 overlays) once the first
pass completes. The next blocker is filed as
[#6745](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6745-jsdom-module-init-snapshot-locals-gc),
which takes over this issue's "jsdom reaches a verdict" criterion.

Scoped standalone test262 (`language/module-code`, 284 files): parent
180 pass / 90 fail / 14 compile_error, fix identical, same non-pass set.
