---
id: 5180
title: "`JSBI___toPrimitive` binary emit fails with struct field index out of range — new on main, blocks the temporal-polyfill lane"
status: in-review
sprint: current
created: 2026-08-29
updated: 2026-08-29
pr: 5223
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
goal: dogfood
related: [4628, 5178, 3481, 5147]
---

# #5180 — `struct field index out of range` on `JSBI___toPrimitive`

## Problem

The linked `@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0` bundle now fails to
produce a binary at all:

```
Binary emit error: RangeError: Codegen error: struct field index out of range
— 1 (valid: [0, 1)) at function 'JSBI___toPrimitive' (position 97, 21 declared locals)
```

`success: false`, one hard error, `result.binary` empty — so
`WebAssembly.compile()` reports `BufferSource argument is empty`. This is
strictly worse than the class of bug #4644/#5169/#5178 addressed (those all
produced a binary that merely failed validation).

## This is NEW on main, and it is not the dogfood lane's own doing

Measured 2026-08-29, in this order:

| tree | result |
| --- | --- |
| `fc6fd3b5f3` + `#4644` + `#4645` + `#5169` + `#5178` | **VALIDATE OK**, 0 hard errors, ~40 s compile |
| plain `origin/main` @ `bdb19824b0` (scratch worktree) | **this error**, 1 hard error, ~37 s compile |
| the same branch re-merged onto `bdb19824b0`, with and without the #5178 fix | **this error** in both — so #5178 neither causes nor masks it |

So it entered `main` between `fc6fd3b5f3` and `bdb19824b0`. The source-touching
merges in that window are **#5203** (`claude/es2015-test262-standalone-9vij99`)
and **#5204** (`claude/pr-5183-fix-osgkt9`); #5187 is #4644, which the green run
above already contained, and the rest are docs/artifact commits. **The window is
narrowed, not resolved — do not treat either PR as confirmed without a probe.**

A per-commit bisect on plain `main` is impractical for the polyfill: without
#4645 the compile is the superlinear case that issue exists to fix (the probe at
`fc6fd3b5f3` did not finish in 10 minutes). Bisect on a tree that has #4645
merged, or reduce first.

## Reproduce

```bash
node --import tsx .tmp/repro-bundle.mjs   # links jsbi + polyfill, compiles, validates
```

or the dogfood lane:

```bash
DOGFOOD_TEMPORAL_POLYFILL=1 node node_modules/vitest/dist/cli.js run \
  tests/dogfood/temporal-polyfill.test.ts
```

## Where to start

`JSBI___toPrimitive` is a synthesized `Symbol.toPrimitive` method export. The
emitted `struct.get`/`struct.set` names field 1 of a struct that has exactly one
field, at instruction position 97 in a body with 21 declared locals — i.e. a
field index computed against one struct layout and emitted against another. The
`emitToPrimitiveMethodExports` path in `src/codegen/index.ts` and the
symbol-carrier layout work from #3481 are the two places where a `@@toPrimitive`
carrier's field list is decided.

## Acceptance

* The linked polyfill bundle compiles with 0 hard errors and passes
  `WebAssembly.compile()` on current `main`.
* A minimized regression test asserting both, failing before the fix.
