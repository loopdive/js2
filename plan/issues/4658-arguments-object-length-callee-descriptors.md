---
id: 4658
loc-budget-allow:
  # `__vec_gopd`'s `length` descriptor synthesis lives here; the §10.4.4 answer
  # has to be decided at that exact site. +19 lines = the brand/tombstone
  # consults plus their rationale; the mechanism itself is a new leaf module
  # (`src/codegen/arguments-length-brand.ts`), 0 lines of it in any god-file.
  - src/codegen/vec-overlay.ts
  # `emitArgumentsVecBody` is the single construction site every arguments
  # object passes through — the brand cannot be minted anywhere else. +11 lines
  # = one gated call plus why the gate is `registerWithHost`.
  - src/codegen/statements/nested-declarations.ts
  # +2 lines: the `$Object.flags` bit table comment, recording 0x40 as taken.
  - src/codegen/object-runtime.ts
func-budget-allow:
  # Same +18 lines as the `vec-overlay.ts` allowance above, seen at function
  # granularity: `__vec_gopd`'s bodies are built inside this one closure (it
  # owns `missExtern`/`integrityBit`/`setKey`), so a consult that has to sit in
  # the `length` arm cannot be hoisted out without duplicating that scope.
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
title: "ES5 standalone: arguments-object `length`/`callee` own-property descriptors — a NUMBER write to arguments.length sticks but a STRING write does not; gOPD reports wrong writable/configurable; typeof argObj.callee answers \"number\""
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: arguments-object
goal: standalone-gap
related: [4491, 4515, 4032]
origin: "Narrowed by dev-4515 against dev-4491's MERGED wave-4 tree (2026-08-23), then handed to dev-4491, which DECLINED it as a distinct slice with its own risk surface rather than fold it into an unrelated parity fix. Filed by the lead so it has an owner. Both lanes' measurements are recorded below; neither is working it."
---

# #4658 — arguments-object `length` / `callee` descriptors

## Why this is its own issue, not #4491's element-freeze work

dev-4515 re-verified these four rows against dev-4491's **merged** wave-4 fix
(`Object.freeze` now visible to array/arguments ELEMENTS) and the residue is
**not** element freeze — it is the `length` and `callee` **own-property
descriptors** on the arguments object. dev-4491 declined to fold it in with the
reason worth preserving: folding a distinct slice into an unrelated fix "would
make both unmeasurable". Take it as its own before/after.

## Affected rows

```
language/arguments-object/10.6-13-a-1.js   typeof argObj.callee → "number", want "function"
language/arguments-object/10.6-6-2.js      length descriptor should be configurable
language/arguments-object/10.6-7-1.js      length descriptor should be configurable
language/arguments-object/S10.6_A5_T4.js   arguments object don't exists
```

## Measured symptoms (dev-4515, on the merged wave-4 tree)

1. **A NUMBER write to `arguments.length` sticks; a STRING write does not.**
   dev-4491 identifies this as the same **kind-incompatible-carrier** defect as
   its own `15.2.3.7-6-a-183` residual — a cross-type write to a slot whose
   carrier was resolved for the other kind.
2. `Object.getOwnPropertyDescriptor(argObj, "length")` reports the wrong
   `writable` / `configurable`.
3. `typeof argObj.callee` answers `"number"`.

## Lead's note on likely shared root (from dev-4491)

The `length` half **likely shares a root with dev-4491's
`heterogeneousWidenedModuleGlobalType` residual** — whoever takes this may get
two fixes for one investigation. Verify that before assuming it; it is a
pointer, not a measurement.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully
   before the first edit. Especially: methodology 1–7, the **contention trap**
   (re-run every apparent flip AND apparent regression SERIALLY before it goes
   in a report — a `compile_error: compilation timeout` is a measurement
   failure, not a status), the **pool-suite false green** (`skipped` is not
   `passed`; read counts, never exit codes), the stale `compiler-bundle.mjs`
   trap, the `test262/` symlink-farm + **GITLINK hazard**.
2. Re-verify all four rows live on current campaign HEAD first — dev-4491's
   wave-4 fixes are merged and may have moved them since the narrowing.
3. Start with symptom 1 (the cross-type write): it is the one with a named
   sibling defect (`-6-a-183`) and a named candidate shared root
   (`heterogeneousWidenedModuleGlobalType`). Establish whether the carrier is
   resolved per-slot or per-kind before designing the fix.
4. `callee` answering `"number"` smells like the same slot-carrier confusion
   one level out — measure whether it shares root 1 before treating it
   separately.
5. Absent-not-wrong: if a descriptor cannot be answered faithfully, decline the
   fold rather than answer wrongly.

## Acceptance

Scoped standalone sweep over `language/arguments-object` before AND after from
your own runs, with apparent flips/regressions re-verified serially; per-file
flip list; **zero regressions**. `tests/issue-4658.test.ts` pinning each fixed
shape — the pin must EXECUTE the write and read it back, and the descriptor
pins must call `gOPD` and assert the specific attributes — verified failing on
base by file-copy revert; `it.fails` pins for measured residuals with owners.
Record `## Root cause` / `## Fix` / `## Test Results` / `## Residuals` here.
