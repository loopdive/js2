---
id: 3510
title: "Publish js2 standalone on test262.fyi"
status: ready
sprint: current
created: 2026-07-21
updated: 2026-07-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: test262-runner
goal: test262-conformance
lane: A
related: [3473, 3490, 3491, 3494, 3509]
files:
  - package.json
  - scripts/build-test262-cli.mjs
  - scripts/run-test262-fyi.mjs
  - scripts/test262-fixture-graph.mjs
  - scripts/test262-fyi-cli.mjs
  - tests/issue-3510-test262-fyi-two-lane-cli.test.ts
---

# #3510 — Publish js2 standalone on test262.fyi

## Problem

js2 can run the literal test262.fyi source assembly locally in standalone mode,
but test262.fyi cannot publish the result. Its engine contract intentionally
invokes every engine through an isolated command-line process, while js2's
original-harness executor was only available as an in-process project runner.

The first public integration is deliberately one standalone WebAssembly GC
result. A single target keeps the upstream engine shape small while preserving
the host-free capability boundary in the published score.

## Design

- Export a one-shot command-line adapter around the canonical FYI source worker
  as the `js2-test262` binary in the ordinary `@loopdive/js2` npm package.
- Accept test262.fyi's already assembled temporary source file without rewriting
  it.
- Discover static and dynamic fixture metadata from the external Test262 clone,
  rather than assuming js2's optional submodule path.
- Default the external engine wrapper to `standalone`.
- Run one isolated compiler worker per CLI invocation and report through the
  standard exit-code/stdout/stderr contract.
- Leave strict reruns and final process-result classification with
  test262.fyi's unchanged runner. Preserve js2's stricter negative phase/type
  checks inside the CLI before encoding the ordinary child-process result.

The corresponding upstream data integration installs `@loopdive/js2` once,
then registers one `js2` engine using ordinary `setup.js`, `runtime.js`, and
synchronous `run.js` files. It does not modify the shared runner.

## Acceptance criteria

- An external Test262 checkout can supply a fixture graph without using the
  repository's `test262` submodule.
- Standalone executes through the one-shot CLI contract.
- The published npm package contains the CLI and isolated worker artifacts.
- Unsupported target names fail before any test is published.
- test262.fyi can invoke js2 without changes to its shared runner.
- The generated site data contains one unambiguous `js2` engine key.
- Focused adapter, FYI runner and fixture-graph tests pass, followed by one
  original-harness standalone smoke sample.

## Validation

- `tests/issue-3510-test262-fyi-two-lane-cli.test.ts`
- `tests/test262-fyi-runner.test.ts`
- `tests/issue-3491-test262-fyi-module-fixtures.test.ts`
- TypeScript, Prettier, issue-ID and issue-spec gates.
