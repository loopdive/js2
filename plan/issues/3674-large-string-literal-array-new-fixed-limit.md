---
id: 3674
title: "Large string literals emit array.new_fixed beyond V8's 10,000-element limit"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler, codegen, strings
language_feature: string-literals
goal: self-hosting-dogfood
es_edition: n/a
related: [1712, 2928, 3673, 3675]
---

# #3674 — Chunk large static string initialization

## Problem

Embedding Acorn's 230,975-byte distribution as one source literal in a
standalone self-parse canary produces a Wasm module that V8 refuses to compile:

```text
WebAssembly.compile(): Compiling function "__module_init" failed:
Requested length 230947 for array.new_fixed too large, maximum is 10000
```

The compiler emits the entire static string backing array through one
`array.new_fixed`. V8 caps that instruction's immediate element count at
10,000, so otherwise valid JavaScript source becomes invalid for an
implementation-specific Wasm validation limit.

Chunking the source into 8,000-character literals and joining the chunks before
the parser call works around this validator failure. That workaround is useful
for isolating #3675, but callers should not need to rewrite large literals to
make compiler output valid.

## Required change

- Lower large static string backing data through bounded chunks or another
  initialization path that never requests more than the engine-supported
  element count in one `array.new_fixed`.
- Preserve exact UTF-16 code units, including lone surrogates and non-BMP
  characters; byte-oriented splitting must not corrupt JavaScript string
  semantics.
- Keep small literals on their current compact path where profitable.
- Apply the bound from one shared lowering policy rather than an
  Acorn-specific source rewrite.

## Acceptance criteria

- Standalone modules containing literals of 10,000, 10,001, and at least
  230,975 UTF-16 code units validate and instantiate in V8.
- Each literal round-trips exactly, including boundary cases with a surrogate
  pair or lone surrogate across an internal chunk boundary.
- The Acorn full-source wrapper compiles without manually splitting or joining
  the source in user code and retains zero function imports.
- Generated code contains no `array.new_fixed` whose immediate element count
  exceeds the supported bound.
- Existing small-string, native-string, and standalone Acorn canaries remain
  green.

## Test plan

- Add the 10,000/10,001/230,975-code-unit and surrogate-boundary matrix to
  `tests/issue-3674.test.ts`.
- Extend `tests/dogfood/acorn-standalone-compile.mjs` with the direct,
  unchunked-source wrapper so the real pinned Acorn input guards the lowering
  path.

## Scope boundary

This issue owns static data lowering and Wasm validation only. The
post-workaround runtime `illegal cast` while Acorn parses its full source is
#3675; parser throughput is #3673.
