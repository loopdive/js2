---
id: 3535
title: "Standalone (start) top-level throws unrenderable (instance===null) — 8,610 baseline rows masked as 'wasm exception during module init'"
status: done
created: 2026-07-23
updated: 2026-07-23
completed: 2026-07-23
priority: high
feasibility: medium
task_type: bugfix
area: test262-runner
goal: standalone
sprint: 75
horizon: s
umbrella: 2860
assignee: ttraenkler/fable-2860
related: [2860, 2877, 2962, 3049, 3123, 3468, 3417, 3439]
files:
  - scripts/test262-worker.mjs
  - tests/test262-runner.ts
  - tests/issue-3535.test.ts
---

# Standalone `(start)` top-level throws render as one opaque label

## Problem (the F3 observability blocker under #2860)

The standalone test262 lane compiled every test with the wasm `(start)`-section
init model. In original-harness mode ALL test code is top-level, so **every
runtime failure** was a top-level throw that surfaced out of
`WebAssembly.instantiate` — with `instance === null`. The #2962 native
exception-render path (`__exn_render_prepare` / `__exn_render_char`) needs a
live instance, so it was structurally unreachable for these throws, and
`extractWasmExceptionMessage(err, null)` collapsed **8,610 heterogeneous
standalone failures** (current `test262-standalone-current.jsonl`) onto the one
opaque string `wasm exception during module init`.

This was harness-only masking, not a codegen bug: a stratified 152-sample from
the 3-agent parity investigation (`.tmp/parity-findings.md`, Cluster B) found
**0 CompileError / 0 LinkError** — every binary is valid Wasm whose top-level
code runs and throws for dozens of independent, real, pre-existing reasons.
Until this landed, standalone triage worked off garbage: #3417 measured the
bucket at 7,063 rows and could only cite it as "diffuse"; #3439's report gate
needed a dedicated opaque-residual bucket to swallow it.

## Fix

The standalone lane joins the host lane's `deferTopLevelInit` rule (#3049 C1 /
#3123): compile with `deferTopLevelInit: true`, so `__module_init` is exported
instead of wired to `(start)`; the existing exec paths already call the export
right after `setExports` (feature-detected, both runners). A top-level throw
now happens at the explicit `__module_init()` call with a live instance and
renders its real signature through the module's own #2962 exports.

- `scripts/test262-worker.mjs` `doCompile`: defer rule becomes
  `(target && target !== "standalone") || (!originalHarness && inferModuleStrictArguments) ? {} : { deferTopLevelInit: true }`
  — wasi/linear keep their `_start`/`(start)` models; the project-runner
  module-goal carve-out (#2835/#2839 dup-`__module_init` guard) is preserved.
- `tests/test262-runner.ts` `runOriginalVariant` + `runTest262File`
  (baseline-validator lane): same rule, same carve-out. Exec paths unchanged —
  both already call `__module_init` when exported.
- `scripts/compiler-fork-worker.mjs` needs no change (host-lane only).
- Compiler needs no change: `exportModuleInit = ctx.deferTopLevelInit &&
!ctx.wasi` (src/codegen/declarations.ts) already covers standalone.

No verdict-logic change: the same scoring rule (runtime-negative → pass, else
honest fail) is re-hosted from the instantiate-catch to the `__module_init`
call site — the same oracle-version-exempt precedent as the #3123 host-lane
arm. No ORACLE_VERSION bump needed.

## Measured impact (verify-first, 2026-07-23, main @ aa203fdc)

- **152-row stratified sample of the 8,610 masked rows: 0 verdict flips;
  152/152 un-masked** (mode A all opaque, mode B zero opaque). Revealed
  signatures are exactly the triage signal #2860 needs — top clusters:
  `ReferenceError: Temporal is not defined` (23, deferred-feature),
  `Test262Error: obj should have an own property m` (14+, the #3468
  function-object own-property residual), `TypeError: Cannot convert undefined
or null to object` (13), positional null-deref TypeErrors, eval-shim #2928
  refusals (7).
- **Runtime-negative masked subset measured EXHAUSTIVELY (all 7 rows): 6 flip
  fail→pass** — the thrown error TYPE becomes observable via the exported tag
  with a live instance and now correctly matches. Max 7 corpus-wide flips,
  all honest, all upward.
- **100-row stratified sample of the 29,410 currently-passing rows: 0
  pass→fail flips** (see `## Floor safety` below) — defer is
  semantics-neutral for passing tests, so the standalone high-water floor
  (`check-standalone-highwater.mjs`, tolerance 50) is safe.
- End-to-end through the real edited worker (IPC drive): masked rows return
  `fail  Test262Error: obj should have an own property a` etc.; runtime
  negatives return `pass`.

## Floor safety

Deferring init changes only WHERE init runs (explicit export call vs `(start)`
during instantiate) — nothing observable happens between instantiate and the
`__module_init()` call in either runner. Binary content is identical except
the export entry and start-section removal. The `__in_module_init` flag
(#2800) is set/cleared inside `__module_init` itself, so its semantics are
model-independent. Non-test262 embedders are untouched — standalone WITHOUT
`deferTopLevelInit` keeps the `(start)` model (pinned by a test).

## Why this is 0-flip by design but still high-value

It converts one 8,610-row opaque bucket into honest per-row signatures that
distribute across the existing #2860 children (Temporal-class deferred
features, #3468 own-property residuals, null-deref substrate, eval #2928,
annexB methods, defineProperty #1906 …). Every subsequent standalone fix can
now be measured against real signatures instead of an undifferentiated blob.
The ~6-7 runtime-negative flips and any baseline-lag drift (~160 rows already
green on HEAD per the parity findings) surface as small upward motion on the
next promote.

## Test plan

- `tests/issue-3535.test.ts` — pins the compiler contract end to end:
  standalone+defer exports `__module_init`, instantiate does NOT throw, the
  init throw renders "TypeError: boom" via `__exn_render_prepare`/`__exn_render_char`;
  standalone WITHOUT defer keeps `(start)` (embedder model unchanged); a
  structural drift-guard on the worker's lane rule.
- CI: standalone matrix + `merge_group` standalone floor validate at 43k scale.
