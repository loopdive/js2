---
id: 2877
title: "Standalone exceptions expose no JS-readable message (__sget_message returns null) — blocks message-level triage"
status: ready
created: 2026-06-30
priority: medium
task_type: enhancement
area: tooling
goal: standalone
sprint: current
horizon: s
related: [2870, 2862, 2860]
umbrella: 2860
---

# Standalone exceptions expose no JS-readable message

## Problem

A `--target standalone` module throws a Wasm-GC error struct as the exception
payload. From the JS test harness the payload is opaque: `String(payload)` throws
(fixed in #2870 by guarding it), and the obvious accessor
`instance.exports.__sget_message(payload)` returns **null** for the thrown
payloads sampled in #2870's de-mask. So the harness cannot recover the REAL
per-test failure message — the #2870 de-mask falls back to a stable label
(`uncaught Wasm-GC exception (non-stringifiable payload)`).

### Why it matters

Without a readable message, standalone-gap triage can only cluster by **test
path/feature**, not by the actual error (`x is not a function`, a specific
TypeError text, a trap reason). A readable message would let triage group the
~2,014 de-masked failures (#2870) by real signature and pinpoint shared root
causes far faster.

## Investigation / fix sketch

1. Determine what the standalone throw payload actually is for these cases
   (a `__new_TypeError` struct with a null message field? a non-error value? the
   null/undefined access sentinel?). `__sget_message` returning null suggests
   either the message field is unset at throw time or the payload is not the
   error struct `__sget_message` expects.
2. Either (a) ensure native error constructors populate a readable `message`
   field reachable via an exported accessor, or (b) export a dedicated
   `__exn_message(payload) -> externref(nativeString)` helper the harness can
   call (returning the flattened message or a class label), and wire
   `extractWasmExceptionMessage` (both `tests/test262-runner.ts` and
   `scripts/test262-worker.mjs`) to prefer it over the #2870 stable fallback.

## Acceptance

The harness records the real error message (or a precise class label) for a
standalone-thrown exception instead of the generic #2870 fallback, with zero
pass/fail movement (tooling-only). Enables message-level re-triage of #2862's
de-masked clusters.
