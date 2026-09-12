---
id: 6414
title: "hono's `adapter/cloudflare-pages` emits an invalid module — `struct.set[1] expected type i32, found local.get of type externref` in an async resume"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

`hono/dist/adapter/cloudflare-pages/index.js` compiles successfully and then
fails `WebAssembly.compile`:

```
Compiling function #318:"__async_resume_fanon_467" failed:
  struct.set[1] expected type i32, found local.get of type externref @+117395
```

An async resume continuation stores a spilled local back into its frame struct
with the wrong representation: the frame field was laid out as `i32` but the
value being written is `externref`. The other hono adapters
(`aws-lambda`, `bun`, `cloudflare-workers`, `deno`, `lambda-edge`, `netlify`,
`service-worker`, `vercel`) all compile and validate, so the disagreement is
specific to what this module's captured anonymous async function spills.

Likely related to
[#6412](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6412-hono-jwt-async-resume-extern-convert-any)
— both are `__async_resume_*` frames mixing `i32` and `externref` for one slot
— but they fail at different instructions and this has not been verified as one
root cause.

Found by the `--surface exports` survey added in
[#5368](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5368-dogfood-validation-gate-declared-entry-only)
on `cf82f78d6d` (2026-09-12).

## Reproduce

```bash
node --import tsx tests/dogfood/dogfood-surface-probe.mjs \
  --package hono --modules dist/adapter/cloudflare-pages/index.js
```

## Acceptance criteria

1. The module compiles to a binary that passes `validateEmittedBinary`.
2. Its row is deleted from `KNOWN_INVALID_MODULES` in
   `scripts/check-dogfood-validation.mjs`.
3. A regression test that fails on the parent commit and passes with the fix.
