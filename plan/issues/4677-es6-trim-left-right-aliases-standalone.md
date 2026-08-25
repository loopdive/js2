---
id: 4677
title: "ES6 standalone: String.prototype.trimLeft/trimRight aliases"
status: in-progress
sprint: current
created: 2026-08-25
updated: 2026-08-25
assignee: codex/es6-trim-alias-wave3
priority: medium
horizon: s
feasibility: medium
task_type: feature
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [4444, 4445, 3217, 4485]
files:
  - src/checker/inhouse-globals.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/char-at-transfer.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/index.ts
  - src/codegen/numeric-property-analysis.ts
  - src/codegen/string-ops.ts
  - src/codegen/string-proto-tostring.ts
  - tests/issue-4677.test.ts
loc-budget-allow:
  - src/checker/inhouse-globals.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/char-at-transfer.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/index.ts
  - src/codegen/numeric-property-analysis.ts
  - src/codegen/string-ops.ts
  - src/codegen/string-proto-tostring.ts
func-budget-allow:
  - src/codegen/array-object-proto.ts::makeGlue
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
---

# #4677 — ES6 standalone `trimLeft`/`trimRight` aliases

## Problem

The Annex B aliases `String.prototype.trimLeft` and `trimRight` are absent
from the standalone String prototype member table. Direct calls therefore reach
the native-string path with no helper, while prototype value reads are
`undefined`. The aliases must also be the exact initial function objects of
`trimStart` and `trimEnd`, respectively, not merely equivalent wrappers.

This is the documented follow-up from #4444/#4445. The focused upstream
Test262 cohort is eight files:

`annexB/built-ins/String/prototype/{trimLeft,trimRight}/{length,name,prop-desc,reference-*}.js`.

## Scoped baseline (upstream/main `d5b14033d`, 2026-08-25)

- Focused Test262 run through `runTest262File(..., "standalone")`: **0/8
  pass, 8/8 fail**. The four `length.js`/`name.js` files fail while reading
  the absent member, the two `prop-desc.js` files report the missing own
  property, and both `reference-*` files compare `undefined` to the canonical
  method.
- Direct standalone smoke (`("  x  ").trimLeft/trimRight()`): compile and
  Wasm validation succeed with zero imports, but each invocation traps on a
  null native helper; the alias identity probe returns `0` and the two alias
  lengths read as `0`.

All counts use the eight-file denominator above; no broader ES6 bucket claim is
made from this scoped baseline.

## Implementation plan

1. Add both Annex B names to the first-class String method registries and
   arity/type analyses, so direct calls and prototype own-property reads use
   the existing native trim machinery.
2. Map `trimLeft` to `__str_trimStart` and `trimRight` to `__str_trimEnd` in
   both direct and reflective call paths. Add them to the borrowed-method
   transfer set where the existing reflective closure ABI requires explicit
   membership.
3. Use the native-prototype `memberAliasOf` hook (#4485) to canonicalize the
   two aliases to `trimStart`/`trimEnd`; keep the alias names in the member CSV
   so own-property and descriptor checks remain observable.
4. Add focused equivalence tests for direct behavior, prototype descriptor
   metadata, and exact alias identity in standalone mode.

## Budgets and ratchets

- Keep this as a table/dispatch-only fix: no new runtime imports, helper
  families, or prototype representation. Any new source should be limited to
  the existing files listed in `loc-budget-allow`.
- Acceptance ratchet: focused Test262 must improve from **0/8** to **8/8**;
  all existing trim/trimStart/trimEnd controls must remain passing, and the
  standalone import manifest must stay empty.
- Before/after evidence must report the same eight-file denominator and an
  explicit pass→fail loss count; no zero-loss claim may be extrapolated from a
  different runner or baseline artifact.

