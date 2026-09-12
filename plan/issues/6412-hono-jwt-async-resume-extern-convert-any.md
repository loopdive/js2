---
id: 6412
title: "hono's JWT subpaths emit an invalid module — `extern.convert_any[0] expected type anyref, found call of type externref` in `__async_resume_fimportPublicKey`"
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
`WebAssembly.compile`:

| module | engine message |
| --- | --- |
| `dist/utils/jwt/index.js` | `Compiling function #212:"__async_resume_fimportPublicKey" failed: extern.convert_any[0] expected type anyref, found call of type externref @+56513` |
| `dist/middleware/jwk/index.js` | `Compiling function #426:"__async_resume_fimportPublicKey" failed: extern.convert_any[0] expected type anyref, found call of type externref @+187403` |
| `dist/middleware/jwt/index.js` | `Compiling function #425:"__async_resume_fimportPublicKey" failed: extern.convert_any[0] expected type anyref, found call of type externref @+183035` |

All three are the same defect reached through three entry points: the async
resume continuation for `importPublicKey` feeds an `extern.convert_any` with a
value the call already produced as `externref`. `extern.convert_any` takes
`anyref` — converting an `externref` that is already external is the type
error. The coercion is emitted in the resume path, not the straight-line one,
which is why it survives the ordinary async lowering tests.

Found by the `--surface exports` survey added in
[#5368](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5368-dogfood-validation-gate-declared-entry-only)
on `cf82f78d6d` (2026-09-12). Recorded in `KNOWN_INVALID_MODULES` in
`scripts/check-dogfood-validation.mjs`; deleting those three rows is the
acceptance test.

## Reproduce

```bash
node --import tsx tests/dogfood/dogfood-surface-probe.mjs \
  --package hono --modules dist/utils/jwt/index.js
```

## Acceptance criteria

1. All three modules compile to binaries that pass `validateEmittedBinary`.
2. Their three rows are deleted from `KNOWN_INVALID_MODULES`.
3. A regression test that fails on the parent commit and passes with the fix.
