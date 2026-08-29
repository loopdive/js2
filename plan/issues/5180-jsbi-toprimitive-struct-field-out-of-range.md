---
id: 5180
title: "`JSBI___toPrimitive` binary emit fails with struct field index out of range — new on main, blocks the temporal-polyfill lane"
status: in-review
pr: 5223
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
goal: dogfood
related: [4628, 5178, 3481, 5147, 5204]
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
above already contained, and the rest are docs/artifact commits.

A per-commit bisect on plain `main` is impractical for the polyfill: without
#4645 the compile is the superlinear case that issue exists to fix (the probe at
`fc6fd3b5f3` did not finish in 10 minutes). **Reducing first was the right move
and is what closed the window** — see Root cause below: #5204, `8f161cbf15`.

## Reproduce

Three lines, no polyfill needed (reduction by dev-5180; **re-verified
independently on this branch**, same error class, `__module_init` instead of
`JSBI___toPrimitive`):

```js
const d = new Date(0); const t = d.valueOf;
```

```
Binary emit error: RangeError: Codegen error: struct field index out of range
— 1 (valid: [0, 1)) at function '__module_init'
```

Whole-bundle form:

```bash
node --import tsx .tmp/repro-bundle.mjs   # links jsbi + polyfill, compiles, validates
DOGFOOD_TEMPORAL_POLYFILL=1 node node_modules/vitest/dist/cli.js run \
  tests/dogfood/temporal-polyfill.test.ts
```

## Root cause (dev-5180) — window closed to #5204

This issue's original "where to start" guess — `emitToPrimitiveMethodExports`
in `src/codegen/index.ts`, or the #3481 symbol-carrier layout — was **wrong on
both counts**, and is dropped rather than left to mislead. The function name was
a red herring: `JSBI___toPrimitive` was simply the first function in the bundle
to reach the bad candidate. The only part of that guess that held up was the
mechanical read, "a field index computed against one struct layout and emitted
against another", which is exactly the drift below.

`ensureDateStruct` registers `mod.types[$__Date].fields` and
`ctx.structFields.get("__Date")` as **two separate arrays**. The dynamic
field auto-registration in `finalizeStructAndDynamicMemberGet` appends to the
metadata array only, so the two drift; `findAlternateStructsForField` then
offers `__Date` as a `valueOf` candidate at field 1 and emits
`struct.get $__Date 1` against a one-field struct.

**Attribution: #5204, commit `8f161cbf15` (selfhost) — #5203 is clean.** That
commit made the pre-existing drift *reachable* by adding the `receiverWasm`
carrier-name fallback in `resolveStructNameForExpr`
(`src/codegen/property-access.ts:1147-1149`, confirmed present), which resolves
a `Date` receiver to `typeName === "__Date"`. The narrowed-but-unresolved
window recorded above is therefore now closed.

Fix: **PR #5223** (`issue-5180-struct-field-index-oob`) — one line, never grow a
struct whose field metadata is a separate array.

## Effect on the temporal-polyfill lane

Measured by dev-5180 (their numbers, not re-run here):

| tree | result |
| --- | --- |
| `origin/issue-5178-method-return-struct-type` + #5180 fix | **0 hard errors, VALIDATE OK**, 1,095,247 bytes |
| plain `main` + #5180 fix | 1,097,367 bytes, fails validation: `immutable global #1226 cannot be assigned` in `JSBI_BigInt` |

That second residual is **not** a new defect: dev-5180 verified it is also
present on unfixed `main` (by bypassing the emitter's struct-field check) and at
base `3abe6a72de` + their fix, and that it disappears with the #5178 stack —
i.e. it is the #5169 immutable-global bug, still in flight as PR #5212. No new
issue was filed for it, correctly.

So **#5180 + #5178 (which carries #5169) together restore the lane**; neither
alone does.

## Status note

Held at `in-review`, not `done`: PR #5223 is **open, not merged** (verified via
the API at the time of writing). This file lives only on
`origin/issue-5178-method-return-struct-type` (PR #5216) because duplicating it
on the fix branch would collide on the issue-id gate, so the fix PR cannot carry
its own status flip — the handoff case `in-review` exists for. Whoever observes
#5223 merge flips this to `done`.

## Acceptance

* The linked polyfill bundle compiles with 0 hard errors and passes
  `WebAssembly.compile()` on current `main`.
* A minimized regression test asserting both, failing before the fix.
