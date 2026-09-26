---
id: 6694
title: "ir-inline: an inlined callee's declared locals are not re-zeroed, so a copy inside the caller's loop sees the previous iteration's values"
status: ready
sprint: Backlog
created: 2026-09-26
updated: 2026-09-26
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
goal: standalone
related: [4157, 6677]
---

# #6694 — inliner relies on callee locals being written before read

## Problem

`inlineUserFunctions` (src/codegen/ir-inline.ts, #4157) relocates a callee's
declared locals into a fresh block appended to the caller and splices the body
in place of the call. Wasm zero-initialises locals once per FRAME, not per
block, so when the call site sits inside a loop the inlined copy starts its
second iteration with whatever the first iteration left in those locals. A
callee that reads a declared local before writing it — i.e. relies on the Wasm
default — silently changes meaning once inlined.

Found while building #6677's runtime RegExp compiler: its hand-written
`parseTerm` helper kept its quantifier kind in a zero-default local; inlined
into `parseAlt`'s term loop, every term after a quantifier re-used the previous
quantifier (`ab*cd` parsed as `a b* c*`, `d` consumed as the quantifier). The
#6677 helpers now zero their i32 locals explicitly
(`defineRxFn`, src/codegen/regex-runtime/env.ts), which masks it for them only.

TS-compiled user code was not observed to hit this (the probes
`var q; if (x) q = 1; return q` and a counted inner loop, both inlined into a
3-iteration caller loop, answered correctly in `gc` and `standalone`) because
source-level locals are initialised explicitly by codegen. Hand-authored
helpers and any future codegen that leans on the default are exposed.

## Fix sketch

In the rewrite (the `fresh` locals loop), emit `<zero>; local.set base+nParams+i`
for every defaultable declared callee local that the relocated body can read
before writing — or unconditionally when the call site is inside a loop and let
Binaryen drop dead stores. Measure the size delta on the playground corpus.

## Acceptance criteria

- A unit test with a hand-built callee that reads a zero-default local, inlined
  at a loop call site, gives the same answer as the non-inlined call.
