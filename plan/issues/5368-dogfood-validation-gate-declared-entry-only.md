---
id: 5368
title: "`check:dogfood-validation` compiles only each package's declared entry module — a subpath that emits invalid Wasm (`hono/dist/utils/color.js`, #5339) passes the gate green"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-12
completed: 2026-09-12
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infra
area: ci
goal: correctness
---

## Problem

`scripts/check-dogfood-validation.mjs` (#5336, required inside `quality`)
asserts `compile.success ⇒ validates` — but only for each package's
**declared entry module** (`<pkg>/dist/index.js`). A module the dogfood suite
admits through a subpath is never compiled by the gate.

#5339 is the measured miss: hono's `dist/utils/color.js` compiled to a module
that failed `WebAssembly.compile` (`type error in return[0] (expected i32,
got externref)` in `getColorEnabledAsync` — an inlined IIFE's `return`
inside a `catch` clause left as a Wasm `return`), and **with that source
restored the gate exits 0**. The invalid module was live on `main` with the
gate green; it surfaced only as a whole-file `0/8` in the hono suite, where
four agents had already misread the null `wasmError`.

## Acceptance criteria

1. The gate is **red** on the parent of #5339's fix (PR #5676) and green
   after it — demonstrate both runs.
2. It covers every module the dogfood suites admit, not just the declared
   entry: the union of modules the suite runner compiles for each package
   (the generated trees `.<pkg>-upstream-suite-generated/` enumerate exactly
   that), or the package's exported subpath map — whichever the runner
   already knows how to enumerate.
3. Wall-clock stays inside the `quality` budget: ≤ 2× today's ~26 s, or
   packages run in a worker pool (`cores − 1`). Quote before/after timings.
4. On failure the message names the package, the module path, and the
   validation error verbatim.

## Implementation Plan

1. Read the gate script and `tests/dogfood/upstream-suite-runner.mjs`'s
   module enumeration (`UPSTREAM_TEST_EXPORTS`, the generated-tree layout).
   Reuse the runner's enumeration rather than re-deriving `exports`
   conditions from `package.json`.
2. Compile every enumerated module with the same options the suite uses;
   fail on any `success && !validates`. Keep compile-error modules out of the
   verdict (they are a different gate's business) but count them in the
   summary line.
3. Parallelise per package if the budget needs it; keep output deterministic
   (sorted by package, then path).
4. Verify AC 1 by checking out #5676's parent in a detached worktree under
   `<repo>/.claude/worktrees/`, running the gate there (red), then on main
   (green). Record both in the PR body.
5. `.github/workflows/**` is untouched (the gate is already wired); if a
   workflow change is needed after all, expect the `needs-manual-enqueue`
   label (#3584) — a lead action, not a hold.

## Dispatch

Model: **opus** (small CI change; opus rather than sonnet because the
mandatory step-0 base recipe on this box has stalled two sonnet agents).

## Resolution

**Mechanism.** `scripts/check-dogfood-validation.mjs` now compiles a module
SURFACE per package instead of one declared entry. `tests/dogfood/dogfood-surface-modules.mjs`
enumerates it; `tests/dogfood/dogfood-surface-probe.mjs` compiles a chunk of it
in one child process (one process per chunk, not per module — loading the
compiler is ~1.5 s and the surface has 20x the modules). Both phases now share
ONE worker pool, so the short subpath chunks fill the gaps between the six long
entry probes rather than forming a tail.

Two surfaces:

- **`suite` (gated, default)** — the declared entry plus every published module
  the dogfood upstream suites admit. Derived from the committed suite pins, so
  the gate needs no upstream clone and no generated tree. Only hono's suite
  rewrites its tests' imports onto the published `dist/` tree; the other suites
  (redux, jest, styled-components, moment, react) compile the upstream
  repository's sources, so their admitted set is legitimately the entry alone.
  That mapping is one declarative table entry per package, not new logic.
- **`--surface exports` (survey, not gated)** — every file the package's
  `exports` map resolves to. Deliberately not gated: see the residuals.

A module that does not codegen at all is counted and printed but never failed
on — it makes the implication vacuous, which is #5332's business, not this
gate's. A chunk that dies mid-way is an infrastructure failure (exit 3), not a
silent pass over the modules it never reached.

**Counts both ways (AC 1).** Same gate, same command, two trees:

| tree | verdict | subpath surface | exit |
| --- | --- | --- | --- |
| `34720daf53` (#5676's parent) | **RED** | 20 modules — 19 valid, **1 invalid** | 1 |
| `cf82f78d6d` (main, 2026-09-12) | **GREEN** | 20 modules — 20 valid | 0 |

The single invalid module on the parent is exactly #5339:

```
::error::[dogfood-validation] hono module dist/helper/dev/index.js compiled 36,213 bytes
that do NOT validate: WebAssembly.Module(): Compiling function #36:"getColorEnabledAsync"
failed: type error in return[0] (expected i32, got externref) @+11543
```

Package, module path, verbatim engine error — AC 4.

**Wall clock (AC 3).** Measured back-to-back on the same loaded box, same
concurrency 4:

| run | wall | vs base |
| --- | --- | --- |
| entry-only gate (`HEAD:scripts/check-dogfood-validation.mjs`) | 44.5 s | 1.00x |
| widened gate, run 1 | 71.8 s | 1.61x |
| widened gate, run 2 | 65.0 s | 1.46x |

Inside the ≤ 2x budget. The added *work* is small — the 20 hono modules cost
~12 s of CPU serially — so most of the delta is scheduling contention from four
more concurrent children on a shared box; a quiet runner should see less.

**Anti-vacuity control.** `tests/dogfood/dogfood-surface-modules.test.ts` pins
the SET, because an enumeration that quietly collapsed back to the declared
entry would restore the exact blind spot and still exit 0. Disabling the suite
mapping fails 3 of its 6 tests.

## Residuals

- **The `exports` surface is NOT gated, and it is not clean on main.** Running
  `--surface exports` over hono's 74 published modules on `cf82f78d6d` finds
  **7 invalid modules** — three distinct codegen bugs, now filed as #6412
  (`extern.convert_any` given an already-external ref in
  `__async_resume_fimportPublicKey`: `utils/jwt`, `middleware/jwk`,
  `middleware/jwt`), #6413 (closure fallthrough typed `i32`, producing
  `externref`: `jsx/dom/client`, `jsx/dom/jsx-runtime`,
  `jsx/dom/jsx-dev-runtime`) and #6414 (`struct.set` of an `externref` into an
  `i32` frame slot: `adapter/cloudflare-pages`). They are recorded in
  `KNOWN_INVALID_MODULES` so the survey is reproducible; on the default surface
  that list waives nothing. Widening the gate to `exports` means emptying it
  first.
- **Cost is the other reason `exports` is not gated**: hono's 74 modules cost
  **151 s of CPU** on their own, which does not fit the `quality` budget at any
  plausible concurrency. Four more hono modules fail to codegen outright
  (`helper/streaming`, `middleware/combine`, `middleware/timing`,
  `validator/index` — all the #3587 "async shape not supported" class).
- **Compiling the whole exports surface as ONE union barrel does not work** and
  should not be retried: it took 178 s and then failed to codegen at all, which
  makes the implication vacuous for the entire package. Per-module compiles are
  what keep a single bad module from blinding the rest.
- Only hono contributes suite subpath modules today. The mechanism generalises
  — a new package is one table entry — but the coverage it buys right now is
  hono's 20 modules.
