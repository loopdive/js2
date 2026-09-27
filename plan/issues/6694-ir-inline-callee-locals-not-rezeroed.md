---
id: 6694
title: "ir-inline: an inlined callee's declared locals are not re-zeroed, so a copy inside the caller's loop sees the previous iteration's values"
status: done
sprint: Backlog
created: 2026-09-26
updated: 2026-09-26
completed: 2026-09-26
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

## Implementation Plan

Executed as written below.

1. In the `inlineUserFunctions` rewrite (`src/codegen/ir-inline.ts`), seed the
   splice sequence with `localResets(...)` (stack-neutral, so it may precede
   the reverse-order argument spills) only when the site's wasm `loopDepth > 0`
   (outside a loop the fresh locals are zeroed by the caller's frame entry and
   the copy runs at most once per frame).
2. `localResets(body, nParams, locals, base)`: one pre-order walk of the
   (possibly specialised) callee body records, per callee local, whether its
   FIRST textual access is a top-level (depth 0) `local.set`/`local.tee`. That
   is the only shape proven written-before-read on every path: everything before
   it is straight-line, and a branch past it leaves the wrapper block. Every
   declared local whose first access is anything else gets `<zero>; local.set
   base+nParams+i`. Locals never accessed get nothing. Non-defaultable `ref`
   / `ref_extern` locals are skipped (Wasm validation already requires a write
   before their first read).
3. `zeroOf(t)` gives the Wasm default per `ValType` (`f64.const 0`, not the
   destructuring sNaN sentinel `defaultValueInstrs` uses).
4. Regression test with a hand-built module (`i32`/`f64`/`i64`/`funcref`
   locals), plus two controls pinning that no reset is emitted when the local is
   written first or the site is outside a loop.

## Resolution

Fixed in `src/codegen/ir-inline.ts` (`localResets` / `zeroOf`, called from the
rewrite). `tests/issue-6694-ir-inline-callee-locals-rezero.test.ts`: 4 of 6
fail on the parent (`expected 15 to be 5`), 6/6 pass with the fix.

Size delta on the playground corpus (26 compiles, gc + standalone, default
options): +588 bytes on 1,178,188 (+0.05 %), 7 of 26 binaries changed. The
resets land on runtime helpers whose first write sits inside a nested block
(`__is_truthy`'s `$f64_temp`, `__str_concat_*`'s `output`/`offset`,
`__vec_from_extern_*`, async state-machine temps) — conservative, and dead
stores for Binaryen under `-O`.
