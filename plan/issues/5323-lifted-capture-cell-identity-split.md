---
id: 5323
title: "A lifted frame mints a SECOND ref cell for a capture it already boxed, so reads land on the null one (moment 4/10)"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-05: +14 lines. The decision this changes IS the capture-prepend's
# source resolution — three lines of code plus the pointer comment that says why
# the frozen slot is not consulted first here. It cannot move out of the branch
# it guards without duplicating the branch.
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
# 2026-09-05: +7 lines — one optional `FunctionContext` field and its doc
# pointer. Frame state has to be declared on the frame type.
  - src/codegen/context/types.ts
# 2026-09-05: +5 lines — one call recording the eager pass's own box, beside the
# `localMap`/`boxedCaptures` writes it must stay in lockstep with.
  - src/codegen/statements/nested-declarations.ts
# 2026-09-05: +8 lines inside the mutable-capture prepend, for the reason above.
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
---

# One binding, two ref cells

## Symptom

moment@2.30.1 scored **4/10** on the upstream npm suite. All six remaining
failures were one trap:

```
RuntimeError: dereferencing a null pointer
  prepareConfig  ← innermost frame
  createFromConfig → createLocalOrUTC → createLocal
```

`prepareConfig`'s WAT declares the same ~**30** `__boxed_<name>` cell locals
**twice**, in two rounds:

```wat
(func $prepareConfig …
  (local $__boxed_YEAR (ref null 97))   ;; slot 40 — round 1
  …29 more…
  (local $__boxed_YEAR (ref null 97))   ;; slot 85 — round 2
  …29 more…

  local.get 3  struct.new 97  local.set 40      ;; round 1: function top, unconditional
  …
  (if (then  local.get 3  struct.new 97  local.tee 85  … return_call 295 ))
  …
  local.get 85  struct.get 97 0                  ;; ← read OUTSIDE that arm: slot 85 is null
```

Across the whole moment module **210** cells were minted twice, and every one of
them is the same pair: the function-top eager mint, then a call-site re-mint.

## What actually happens

A nested `function` declaration is lifted with its captures as leading
parameters. A capture it only READS arrives **by value**. If that same function
calls a sibling that captures the binding **mutably**, it must hand that sibling
the shared ref cell — so `emitEagerNestedCallCaptureBoxes` (#2758) mints one from
the capture param into the UNCONDITIONAL function-top buffer and re-aims
`localMap` / `boxedCaptures` at it. That pass states its own contract plainly:

> The call site then takes its existing already-boxed branch (no second
> `struct.new`) because `fctx.boxedCaptures.has(name)` is already true.

On a **lifted** frame the call site never looked. Its mutable-capture prepend
resolves the source through `liftedCaptureSlots` — the FROZEN leading
capture-param slot, consulted first precisely so a same-named body binding cannot
shadow the capture (React's `forceStoreRerender`: a local `root` beside a
captured module `root`). That slot still names the **raw param**. So the prepend
saw a non-cell, took its "materialize the cell at this forwarding boundary" arm,
minted a second cell, and re-aimed `localMap`/`boxedCaptures` at it.

The instrumented compile says it in one line:

```
[remint] fn=prepareConfig cap=YEAR currentLocalIdx=3 sourceType={"kind":"f64"}
         liftedSlot=3 localMap=40 localMapType={"kind":"ref","typeIdx":97}
         boxedCaptures={"refCellTypeIdx":97,…} refCellTypeIdx=97
```

`localMap` already pointed at slot 40, whose type is exactly the cell the callee
wants. The prepend read slot 3 instead and minted slot 85.

From then on the binding has **two** cell slots. The frame's own reads and writes
address the newer one, which is `local.tee`'d inside whatever control-flow arm the
call sits in — so it is **null on every path that skipped that arm**. In moment
`prepareConfig`'s early `return_call` arm holds the call and the ordinary path
below it reads `YEAR`…`WEEKDAY` off the never-`tee`'d cell.

### Why this became visible only now

`prepareConfig` receives these bindings by value because #5303's
`preRegisteredValueForwarding` pins a read-only capture to its phase-0 value type
even after the declaring frame boxes the slot. Before #5303 the module did not
validate at all, so nothing reached this frame. #5303's own issue records the
residual and leaves it open; this is it.

### Why it is NOT the conditional-arm defect (#5320)

#5320 is an **unmaterialized** cell: the `struct.new` never runs on the taken
path, and the repair seeds the cell from the orphaned pre-box slot. Here the cell
exists and holds the live value — the call site simply addressed a different one.
Seeding slot 85 from the pre-box slot would return a **stale** value rather than
the live one in slot 40, which is why that repair correctly declines this case.
The two changes are disjoint: #5320 decides *whether a cell was minted*, this one
decides *which of the frame's cells is the binding's storage*.

### Why `deduplicateLocals` did not absorb it

It merges same-name, same-type `__`-prefixed locals — and both rounds allocate
`{kind:"ref", typeIdx}` under the identical name, so it would. It simply does not
run on lifted closure bodies (`function-body.ts` and `class-bodies.ts` are its
only callers). Merging would also be the wrong repair: it would leave two
`struct.new`s writing one slot, so a closure constructed from the first cell and
a later write through the second would still diverge. The defect is cell
IDENTITY, not slot count.

## Fix

Record the provenance, then honour it.

`FunctionContext.liftedCaptureBoxes` (`name → box slot`) names this frame's
canonical cell for one of its own leading capture params. It is written **only**
where the cell was minted from `liftedCaptureSlots.get(name)` itself — the one
condition under which the cell provably describes the capture rather than a
same-named shadow binding, which is the hazard the frozen slot exists to avoid.
Three sites write it (`emitEagerCaptureBoxes` #2692, `emitEagerNestedCallCaptureBoxes`
#2758, and the call-site mint itself, so later sites converge instead of minting a
third); one site reads it, type-checked against the callee's expected cell type.

Helpers live in `src/codegen/closures/capture-source-slot.ts`, beside
`captureSourceSlot` — the resolver whose answer they qualify.

The record names a LOCAL SLOT, so it rolls back with `snapshotLocals` /
`restoreLocals` like `mapEntries` (#2029), `tdzBoxEntries` (#3032) and
`nestedFnClosureMemoEntries` (#5302). Omitting that is the #5580 shape: a
speculative compile mints the cell, rolls back, and the record points at a
truncated slot that a later alloc re-uses at another type.

## Evidence

**moment@2.30.1 — 4/10 → 10/10**, same runner, one head:

| file | parent | with fix |
| --- | --- | --- |
| `days_in_year.js` | 0/1 | **1/1** |
| `is_date.js` | 2/2 | 2/2 |
| `is_moment.js` | 1/2 | **2/2** |
| `min_max.js` | 0/2 | **2/2** |
| `mutable.js` | 0/2 | **2/2** |
| `normalize_units.js` | 1/1 | 1/1 |

**Regression test** — `tests/issue-5323-lifted-capture-cell-identity-split.test.ts`.
Untyped `.js` fixture behind a two-file project (`mod.js` + `entry.ts`);
annotating the receiver `: any` routes the calls through a different arm and the
test then passes identically either way.

| | parent `46c12b01d6` | with fix |
| --- | --- | --- |
| `tests/issue-5323-…test.ts` | 4 failed \| 2 passed | 6 passed |

The four failures are the four control-flow arms that can hold the forwarding
call — an `if` with a `return`, a fall-through `if`, a `&&`, and a `while`. Each
returns `0` instead of `7` when the arm is skipped. The two passing cases are
guards: the same four shapes with the arm TAKEN, plus an unconditional call site
and the sibling's own read.

**Closure/capture vitest slice** — 117 files (`closure|capture|scope|nested|lifted|hoist`),
841 tests, both arms at one head:

| | base | fix |
| --- | --- | --- |
| tests | 32 failed \| 799 passed \| 10 skipped | 26 failed \| 805 passed \| 10 skipped |

The six-test delta is **four** new `#5323` cases plus **two load-dependent
timeouts** — `issue-3024-tostring-closure-funcref` (120 s) and
`issue-3520-closure-host-bridge-abi`'s census (35 s). Both were re-run alone on
the base arm and **pass** (`2 files, 21 tests passed`), so they are batch flake,
not something this change repairs. Excluding those, the failure set is
**identical** on both arms and no test regresses.

## Corpus A/B

17 upstream npm suites, both arms at ONE head (parent `46c12b01d6` via file-copy
revert vs this branch), one suite at a time, compared per test file
(`grep -oE 'native; [0-9]+/[0-9]+ Wasm'`).

| package | base | fix | per-file lines |
| --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | 3 identical |
| three | 17/18 | 17/18 | 1 identical |
| clsx | 32/32 | 32/32 | 3 identical |
| cookie | 63740/63740 | 63740/63740 | 4 identical |
| lodash | 53/62 | 53/62 | (prints no per-file line) |
| redux | 60/82 | 60/82 | 9 identical |
| axios | 191/231 | 191/231 | 33 identical |
| stylelint | 108/108 | 108/108 | 30 identical |
| tailwindcss | 13/13 | 13/13 | 2 identical |
| jsdom | 6/6 | 6/6 | 1 identical |
| styled-components | 9/9 | 9/9 | 4 identical |
| uuid | (no headline) | (no headline) | 10 identical |
| marked | 2/30 | 2/30 | 1 identical |
| **moment** | **4/10** | **10/10** | **4 of 6 move, all upward** |
| prettier | 51/151 | 51/151 | 16 identical |
| jest | 299/356 | 299/356 | 34 identical |
| hono | (no headline) | (no headline) | 4 identical |

All 17 suites exited 0 in both arms and printed an `admitted` headline except
`uuid` and `hono`, which never do — both were scored per test file instead, and
every line is identical. `lodash` prints its own per-file format; its headline
is identical. **moment is the only package that moves, in either direction:**

```
- src/test/moment/days_in_year.js: 1/1 native; 0/1 Wasm
+ src/test/moment/days_in_year.js: 1/1 native; 1/1 Wasm
- src/test/moment/is_moment.js:    2/2 native; 1/2 Wasm
- src/test/moment/min_max.js:      2/2 native; 0/2 Wasm
- src/test/moment/mutable.js:      2/2 native; 0/2 Wasm
+ src/test/moment/is_moment.js:    2/2 native; 2/2 Wasm
+ src/test/moment/min_max.js:      2/2 native; 2/2 Wasm
+ src/test/moment/mutable.js:      2/2 native; 2/2 Wasm
```
