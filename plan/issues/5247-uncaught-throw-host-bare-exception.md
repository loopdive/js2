---
id: 5247
title: "An uncaught compiled throw escapes to the HOST as a bare WebAssembly.Exception with no name/message — export-boundary gap, both lanes"
status: ready
sprint: current
priority: medium
horizon: s
goal: error-model
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5247 — uncaught throws reach the host as bare `WebAssembly.Exception`

## Problem

A `throw new RangeError("x")` inside a compiled exported function that is
NOT caught in wasm surfaces to the calling host as a bare
`WebAssembly.Exception` — no `name`, no `message`, `instanceof Error` false.
Measured by dev-5226 (PR #5369) identically in the single-module control and
the linked lane, before and after the shared-tag fix — so this is an
EXPORT-boundary gap, not a provider-seam one. The #5226 reduction's last test
pins that both lanes agree, giving a future fix a measured starting point.

This matters for the #4628 test262-runner wiring: harness `assert.throws`
runs in the HOST when the runner drives compiled code, so error-type
assertions on uncaught paths read the bare exception unless the runner
catches via a compiled wrapper.

## Direction

The payload already IS the host-native Error (carried on the shared/module
`__exn` tag as externref). At the export boundary the host sees the
`WebAssembly.Exception` wrapper instead of its payload. Likely fix: the
runtime's export-wrapping layer (where `run()`/exported functions are handed
to the host) catches `WebAssembly.Exception`, extracts the payload via
`exn.getArg(tag, 0)` when the tag matches ours, and rethrows the payload.
Cold path — no hot-path concern. Cover both the shared-tag (linked) and
module-local (single-module) tags.

## Acceptance criteria

1. Reduction: uncaught `throw new RangeError` in an exported function reaches
   the host `catch` with identity intact (`instanceof RangeError`,
   name/message), both lanes; base-failing test (flip the pinned #5226 row).
2. No regressions in issue-5221…5226 family + linker family; equivalence at
   baseline; gates green.

## Notes

- Filed from PR #5369's "Reported-NOT-fixed" (dev-5226). Relevant to the
  #4628 criterion-2 runner wiring but not a hard blocker — the runner can
  wrap calls in compiled try/catch meanwhile.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
