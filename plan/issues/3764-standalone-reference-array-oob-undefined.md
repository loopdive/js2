---
id: 3764
title: "Standalone reference-array OOB reads expose null instead of undefined"
status: complete
assignee: ttraenkler/codex-es5-array-oob
sprint: current
created: 2026-07-28
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arrays, strings
goal: es5
related: [2106, 2760, 2773, 3761]
# The new SAFE read helper and its two call-site dispatches belong to the
# existing hybrid OOB policy in property-access.ts; moving them would split
# representation selection from the element-access lowering that consumes it.
loc-budget-allow:
  - src/codegen/property-access.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccessBody
---

# #3764 — standalone reference-array OOB reads expose null instead of undefined

## Problem

The hybrid OOB policy widens number, boolean, and symbol array reads to
`externref`, but leaves WasmGC reference carriers such as standalone
`string[]` on their nullable typed result. An out-of-bounds read therefore
produces a null reference, which becomes JavaScript `null` rather than the
standalone `$undefined` singleton.

This is visible in the ES5 split case from #3761: both the actual and expected
arrays are empty, but comparing `actual[0]` with `expected[0]` fails because the
native-string result carrier produces null on OOB.

## Implementation

- Add a call-site-owned SAFE OOB reader for `ref` / `ref_null` array elements.
- Convert a present element to `externref`.
- Return the real undefined value for an OOB index and for a nullable in-bounds
  hole.
- Keep typed arrays, subviews, array-method internals, RegExp match exotics, and
  proven-in-bounds reads on their existing representations.

## Verification

- Direct host and standalone `string[]` probes distinguish OOB from null.
- The authoritative ES5 `split("l", NaN)` test passes in standalone.
- The focused #3761/#3764 suite passes 7/7.
- Same-SHA standalone split-directory A/B improves 68/120 to 72/120:
  four exact failures become passes with no losses or other status changes.
- Same-SHA host split-directory A/B remains 63/120 with no status changes. The
  single concurrent-run ambiguity was rerun in isolated processes and produced
  the same compile error on both revisions.
- The broader selected array/string regression set remains 184/196; the same
  12 known failures reproduce on the baseline parent revision.
- Typecheck, formatting, and LOC/function budget gates pass.
