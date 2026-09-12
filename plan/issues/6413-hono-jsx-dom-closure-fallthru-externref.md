---
id: 6413
title: "hono's `jsx/dom` subpaths emit an invalid module — closure falls through with `externref` where `i32` is expected"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

Three hono subpath modules compile successfully and then fail
`WebAssembly.compile` with the same fallthrough type mismatch:

| module | engine message |
| --- | --- |
| `dist/jsx/dom/client.js` | `Compiling function #195:"__closure_64" failed: type error in fallthru[0] (expected i32, got externref) @+110178` |
| `dist/jsx/dom/jsx-runtime.js` | `Compiling function #157:"__closure_35" failed: type error in fallthru[0] (expected i32, got externref) @+80404` |
| `dist/jsx/dom/jsx-dev-runtime.js` | `Compiling function #157:"__closure_35" failed: type error in fallthru[0] (expected i32, got externref) @+80363` |

A generated closure is declared to return `i32` but its body falls off the end
leaving an `externref` on the stack — the declared result type and the value
the last expression actually produces disagree. The shape is adjacent to
[#5339](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5339-hono-dev-index-whole-module)
(`type error in return[0] (expected i32, got externref)`), which was an
inlined-IIFE `return` inside a `catch` clause left as a Wasm `return`; here it
is the implicit fallthrough rather than an explicit return, so the #5676 fix
does not cover it. Whether the two share a root cause is unverified.

Found by the `--surface exports` survey added in
[#5368](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5368-dogfood-validation-gate-declared-entry-only)
on `cf82f78d6d` (2026-09-12). `dist/jsx/dom/index.js`, `css.js` and `server.js`
compile and validate, so the defect is in what `client.js` / the runtimes reach,
not in the jsx/dom core.

## Reproduce

```bash
node --import tsx tests/dogfood/dogfood-surface-probe.mjs \
  --package hono --modules dist/jsx/dom/jsx-runtime.js
```

## Acceptance criteria

1. All three modules compile to binaries that pass `validateEmittedBinary`.
2. Their three rows are deleted from `KNOWN_INVALID_MODULES` in
   `scripts/check-dogfood-validation.mjs`.
3. A regression test that fails on the parent commit and passes with the fix.
