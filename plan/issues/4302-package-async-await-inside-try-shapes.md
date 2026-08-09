---
id: 4302
title: "Async CPS: support the await-inside-try shapes used by Prettier, Axios, and Stylelint"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: async, promises, try-catch
goal: npm-library-support
related: [1032, 1034, 3587, 4000]
---

# Support residual package `await`-inside-`try` shapes

## Problem

#3587 correctly removed a silent miscompile: async bodies the host-drive engine
cannot represent now fail loudly instead of dropping awaited rejections. Three
real package entries have reached that deliberate refusal and need an
additional generic CFG shape, not a package rewrite or a suppressed diagnostic.

| package | exact command | measured result |
| --- | --- | --- |
| Prettier | `node tests/dogfood/prettier-harness.mjs --json` | 24.907 s; two #3587 diagnostics; no binary |
| Axios | `node tests/dogfood/npm-compat-catalog-harness.mjs --package axios --json` | 13.617 s; one #3587 diagnostic; no binary |
| Stylelint | `node tests/dogfood/npm-compat-catalog-harness.mjs --package stylelint --json` | 82.319 s; five #3587 diagnostics plus the separate #4303 TDZ error; no binary |

A direct Axios `compileProject` probe located its reported await at line 219,
column 32. The current codegen diagnostic drops the source filename, so the
three rejected declarations are not yet all mapped precisely.

## Suspended handoff (2026-08-09)

The investigation worktree `/private/tmp/js2-async-try-packages-20260809` on
`codex/3587-async-try-packages-20260809` is clean at
`7a50f7fd9a34fd`; it has no tracked edits or commits. No generic lowering was
attempted before suspension.

The likely decision points are `lowerChunk`/`lowerRegionBody` in
`src/codegen/async-cps.ts` and `computeTryCatchSpills` plus host eligibility in
`src/codegen/async-frame.ts`. Resume by retaining source locations in the
diagnostic (or instrumenting the activation decision), mapping the rejected
declarations, and reducing the smallest shared shape. #3587 stays complete:
this issue owns the additional supported shape while preserving #3587's loud
refusal for everything still outside the machine.

## Acceptance criteria

- [ ] Every rejected suspension point reports its source file and location.
- [ ] Reduced tests cover the shared package shape and rejection delivery
      through `catch`/`finally` on the host lane.
- [ ] Prettier, Axios, and Stylelint advance beyond this refusal without source
      rewriting or a synchronous fallback.
- [ ] Any still-unsupported rejection-sensitive shape continues to fail loudly.
