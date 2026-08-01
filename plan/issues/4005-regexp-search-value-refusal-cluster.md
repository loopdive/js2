---
id: 4005
title: "RegExp search-value refusal is a separate lever hiding inside String.prototype — one named codegen refusal across ~98 files"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-gap
related: []
---

# RegExp search-value refusal is a separate lever hiding inside String.prototype — one named codegen refusal across ~98 files

## Problem

A single named codegen refusal — *"`String.prototype.<m>(...)` with a RegExp or
symbol-protocol value not supported in standalone"* — accounts for a large,
coherent cluster:

```
 24 search   19 match   17 split   14 replace
 10 matchAll  8 RegExp replace with a function replacer   6 replaceAll
```

Measured over `built-ins/String/prototype`, all-official, fresh baseline: **418
non-pass, of which 129 die at compile stage — and only 20 of those are Wasm
validation failures.** The other ~109 are this refusal.

## Two cuts, stated separately and NOT reconciled

- **~98 files** — all-official scope, by refusal message (`L-evalink`)
- **51 files** — ES5+untagged goal scope, by mechanism classification (`L-strwith`)

These are different cuts of overlapping populations. **Do not sum them, and do not
treat either as a flip ceiling** (measured reference: 103 reachable gated → 34
flipped, 33%).

Overlap with the tail census's separate "RegExp engine semantics" (68 files, 39
standalone-only) and "RegExp unsupported pattern/arity" (21, 16 standalone-only)
is **UNMEASURED** — establish it before sizing, or you will double-count.

## Why it is a good candidate

One refusal, one area, Tier-1 conclusive classification (the compiler names the
mechanism itself, so no body-reading is needed to identify membership). That is a
better shape than most of what remains.

## Sizing discipline

The framing this was extracted from was wrong three ways: `String.prototype` was
dispatched as "generic receivers, 218 files, top signature `Cannot access property
on null or undefined` (31)". Normalized, that signature is **22**, in an area
carrying **113 distinct signatures across 203 files**, and generic-receiver
defects are **69 — about one third of the area**. A signature census is not a
mechanism census.
