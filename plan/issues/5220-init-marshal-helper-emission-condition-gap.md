---
id: 5220
title: "#5193 init-marshal helpers are emitted only when the module needs them elsewhere — a module without vec-producing calls still marshals vec args as [object Object] at init"
status: ready
sprint: current
priority: medium
horizon: s
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5220 — init-marshal helper registration has an emission-condition gap

## Problem

The #5193/#5209 start-export channel (`__register_init_export` family) is
emitted only when the module's codegen decides it needs the helpers for
some OTHER reason. A module with no vec-producing call registers none, so
`marshalExports` is still undefined during that module's init and a vec
argument crossing to the host still becomes the generic `[object Object]`
proxy. Adding one unrelated `t.filter(...)` anywhere in the module flips
the same row from wrong to right — proof the residue is an
emission-condition gap in `src/codegen/init-marshal-helpers.ts`, not a
runtime gap.

Found by dev-5211 (PR #5314); pre-existing.

## Direction

Widen the emission condition: register the helper family whenever the
module has a compiler-created module initializer AND any host-crossing
import that can receive a struct (measure the import-list predicate the
#5209 change already introduced — this is likely one more clause there).
Keep byte-identity for modules with no top-level code.

## Acceptance criteria

1. Repro: a module whose ONLY vec-to-host crossing is a struct argument at
   init (no .filter/.map anywhere) gets the array facade; new
   tests/issue-5220-*.test.ts failing on base.
2. Byte-identity check for modules without a module initializer.
3. No regressions in issue-5193/5209/5211 test files. Gates green.

## Notes

- Id reserved with a degraded PR scan; manually checked against open PR
  head branches 2026-08-30.
