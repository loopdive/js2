---
id: 4235
title: "generateMultiModule never assigns ctx.fnctorEscapeGate — the entire fnctor pipeline (per-type layouts included) is silently inert on every multi-file compile"
status: ready
created: 2026-08-08
updated: 2026-08-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, objects
goal: performance
related: [3927, 4157, 4211, 4074]
origin: "2026-08-08 second-corpus layout census (lead's measurement subagent): the positive control — identical options, compile() vs compileMulti() on a two-site fixture — separated compile path from options after a first pass reported zeros for acorn through compileProject."
---

# #4235 — multi-file compiles silently skip the whole fnctor pipeline

## Problem

`analyzeFnctorEscapeGate` is called **only** at `src/codegen/index.ts:3536`,
inside `generateModule` — the single-file path. `generateMultiModule`
(`src/codegen/index.ts:6206`), which `compileProject`/`compileMulti` dispatch
to via `src/compiler.ts:975`, never assigns `ctx.fnctorEscapeGate`.

Consequence: on any multi-file compile the entire fnctor pipeline is inert —
escape-gate analysis, presence bits/hot-cold split (#4211/#4217), and the
per-type layout analysis + emission (#3927/PR #4230). No error, no fallback
telemetry: the compile succeeds with the unsplit union representation, which
is a **silent-empty** — a zero from this path is indistinguishable from "no
fnctors in the package".

Line numbers verified 2026-08-08 on main @ `5d661603f`; re-verify before
fixing — this file cites a moving target.

## Why it matters

- Most of the npm-compat corpus compiles through `compileProject`. Every
  fnctor-pipeline measurement or optimization validated on single-file
  `compile()` (acorn's lane) has never run on those packages at all.
- The 2026-08-08 second-corpus census had to fall back to single-file
  `compile()` for every package; its acorn numbers were validated against CI
  (binary 621,552 B == npm-compat.json) only via that path.
- Any future default-ON of `JS2WASM_FNCTOR_LAYOUT_EMIT` (#3927 §6) will look
  like it shipped to the whole corpus while actually engaging only on
  single-file compiles.

## Evidence (reproducible)

Two-site fnctor fixture (`TWO_SITE`), identical options:

- `compile()` (single-file): `[alloc-labels]` stderr reports the family,
  verdicts, and labels.
- `compileMulti()`: zero fnctor analysis output; `ctx.fnctorEscapeGate`
  undefined throughout codegen.

The census subagent's first acorn-through-`compileProject` pass reported
zeros for everything — only the positive control exposed the path
difference. (The report's `.tmp` copy was lost to worktree auto-cleanup;
the table below is the durable record, transcribed 2026-08-08.)

## The second-corpus census (what the single-file path measured)

Instrument: `[alloc-labels]` stderr, single-file `compile()`, main @
`5d661603f`. Verdict names are the code's (`split` = proved per-type
layouts; `too-many-shapes` etc. are bail verdicts). The site-count column is
a static proxy, NOT volume; the alloc-share column needs a runnable module
and only acorn compiles standalone of this set.

| package | families | proved (`split`) | bail verdicts | labels proved/all | alloc share |
| --- | ---: | ---: | --- | ---: | --- |
| acorn 8.16.0 | 6 | **1** (`Node`) | 1 single-site, 1 not-sep, 3 no-sites | 59/68 (87%) | ≥77.5% of struct bytes (runtime census) |
| lodash 4.18.1 | 7 | 2 | 5 no-sites | 13/25 (52%) | no data — doesn't compile |
| three 0.185.1 | 33 | **0** | 3 single-site, 2 not-sep, 28 no-sites | 0/36 (0%) | no data — doesn't compile |
| moment 2.30.1 | 3 | 1 (`Moment`) | 2 single-site | 3/5 (60%) | no data — doesn't compile |
| styled-components, marked, redux, cookie, clsx | 0 | — | — | — | no fnctors at all |
| react-dom, jest, uuid, lit | 0 | — | — | — | no data — barrel entries (157–1,359 B stubs) |

Union widths of proved families: acorn `Node` 62 fields (mean 6.3) vs
`Moment` 17, `LazyWrapper` 10, `LodashWrapper` 5.

**Conclusion (2026-08-08): k=1 labeling generalizes as a MECHANISM, not as a
payoff — acorn is the best case by a wide margin.** Every second-corpus
union is 5–17 fields against acorn's 62; three.js (largest family count, 33)
yields zero splits. **Keep the #4211/#4217 cold split**: its value lives in
the bail-verdict families, which dominate everywhere (32/33 three.js, 5/7
lodash, 5/6 acorn itself). And the headline caveat stands: most of this
corpus compiles through `compileProject`, which this analysis has NEVER
measured — fixing this issue is the precondition for a real corpus-wide
census.

## Acceptance criteria

- [ ] `generateMultiModule` runs the same fnctor pipeline (escape gate →
      presence/cold analysis → layout analysis when flagged) with
      whole-program visibility across the module graph, or an explicit,
      TELEMETERED refusal (a counted fallback reason, not silence) where
      cross-module analysis is genuinely not yet supported.
- [ ] A regression test pins the parity: the `TWO_SITE` fixture compiled via
      `compile()` and `compileMulti()` yields the same fnctor analysis
      verdicts (or the telemetered refusal on the multi path).
- [ ] The alloc-labels diagnostic prints which compile path it ran under, so
      a zero can never again be read without its provenance.

## Notes for the implementer

- Check what else `generateModule` sets up around index.ts:3536 that
  `generateMultiModule` also lacks — the escape gate may not be the only
  single-path-only analysis (audit, don't assume).
- The detector-must-say-I-don't-know rule applies: if multi-file support is
  deferred, the deferral must be visible in diagnostics and counted in the
  IR-fallback-style budget, not silent.
