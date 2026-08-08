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
difference. (Full census table in the lead session log, 2026-08-08; the
report's .tmp copy was lost to worktree auto-cleanup — the summary survives
in the session transcript and the conclusions in #3927 §6.4's data note.)

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
