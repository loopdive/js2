---
id: 4776
title: "ES2015 standalone Symbol.prototype.valueOf borrowed calls"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: Symbol.prototype.valueOf
es_edition: es6
goal: standalone-mode
related: [2163, 2866, 4444]
assignee: "ttraenkler/es6-next-residual"
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/symbol-proto-valueof.ts
  - tests/issue-4776-symbol-prototype-valueof.test.ts
  - plan/issues/4776-es2015-symbol-prototype-valueof-standalone.md
loc-budget-allow:
  - src/codegen/array-object-proto.ts
---

# #4776 — ES2015 standalone `Symbol.prototype.valueOf` borrowed calls

## Problem

The two ES2015 Test262 rows that borrow `Symbol.prototype.valueOf` through
`Function.prototype.call` fail under `--target standalone` with the native
refusal `TypeError: Symbol.prototype.valueOf is not yet implemented in
--target standalone`. The host lane already passes both rows. The direct
`symbol.valueOf()` path is covered by #2163 and is not part of this issue.

## Exact cohort and baseline (2026-08-27)

The cohort is exactly these two maintained ES2015 rows:

- `test/built-ins/Symbol/prototype/valueOf/this-val-symbol.js`
- `test/built-ins/Symbol/prototype/valueOf/this-val-obj-symbol.js`

Both were run solo through `tests/test262-runner.ts` from the pinned
`upstream/main` base `641bb706d676c97332f7cc276382ea0df3189304`, with the
repository's Test262 submodule at `b363f29d3c43c626dc852744ad64a0b48a003693`.
The authoritative baseline is **host 2/2 pass** and **standalone 0/2 pass,
2/2 fail, 0 compile errors, 0 timeouts, 0 skips**. Standalone's identical
failure is the `Symbol.prototype.valueOf` refusal above; no host failure or
compile error belongs in this denominator.

## Implementation plan

1. Extend the existing standalone native-prototype closure for
   `Symbol.prototype.valueOf` in the Symbol carrier subsystem. Accept a boxed
   native `$Symbol` receiver and return its identity-stable carrier; accept a
   standalone `Object(symbol)` wrapper's internal `[[PrimitiveValue]]` slot
   when present; throw a catchable TypeError for all other receivers.
2. Keep the existing `Symbol.prototype` glue, closure identity, metadata, and
   host/GC lowering unchanged. Do not alter `Object(symbol)` construction,
   Symbol key storage, direct `symbol.valueOf()`, or unrelated prototype
   methods.
3. Add a focused regression that runs the exact two Test262 files in both
   host and standalone modes, plus direct wrong-receiver controls proving the
   new body does not turn invalid calls into values.
4. Rerun the exact two-row host and standalone cohort, focused controls, and
   mandatory type/lint/format checks. Record residuals, artifacts, commit, and
   PR handoff here.

## Evidence and handoff before implementation

The failure is localized: `ensureSymbolNativeProtoGlue` advertises
`valueOf`, `resolveStandaloneProtoMemberValueClosure` materializes its
identity-stable closure, and `makeGlue` currently routes the Symbol member to
`emitProtoMemberBodyRefusal`. `Symbol` already has a native `$Symbol` carrier
and `__box_symbol`; the analogous wrapper value-of implementation in
`wrapper-proto-value-of.ts` provides the catchable brand-check pattern. This
is a bounded one-member closure-body fix. The adjacent Symbol rows
`this-val-non-obj.js` and `this-val-obj-non-symbol.js` are already passing and
remain controls; generator, function metadata, and active issues #1691,
#4768, and #4770 are excluded.

## Implementation

`makeGlue` now routes only `Symbol.prototype.valueOf` to a new standalone
body in `src/codegen/symbol-proto-valueof.ts` (with one narrow wiring import in
`src/codegen/array-object-proto.ts`). The body requests the existing
native `$Symbol` carrier even when the prototype member is read before the
first Symbol expression, returns a matching carrier unchanged, and also
recovers a `$Symbol` from an internal `[[PrimitiveValue]]` slot on a native
`$Object` wrapper. A non-matching receiver reaches the shared in-module
catchable TypeError builder. The Symbol glue, closure metadata/identity, host
path, and direct `symbol.valueOf()` lowering remain unchanged.

## Post-fix evidence (2026-08-27)

The exact cohort was rerun through `scripts/harness-flip-probe.ts` with its
structural must-pass/must-fail controls. Both lanes report **2/2 pass, 0 fail,
0 compile errors, 0 compile timeouts, 0 skips**:

- host artifact: `.tmp/issue-4776-after-host.jsonl`
- standalone artifact: `.tmp/issue-4776-after-standalone.jsonl`

The focused Vitest regression
`tests/issue-4776-symbol-prototype-valueof.test.ts` reports **8/8 passed**:
the two exact cohort rows and two incompatible-receiver controls in both host
and standalone lanes. TypeScript 7 typecheck, focused Biome lint, focused
Prettier check, and `git diff --check` pass. The full-repository Biome command
still reports pre-existing diagnostics outside this change; the two changed
files are clean under the same rule set.

The adjacent `Symbol.prototype.valueOf` `length.js`, `name.js`, and
`prop-desc.js` metadata rows remain host failures owned by #4770; they are not
part of this behavior-only cohort. No standalone residual in the selected
two-row cohort remains.

## Acceptance

- Both exact rows pass in host and standalone after the change.
- Standalone has no host imports and no compile errors/timeouts/skips.
- Invalid receiver controls continue to throw their expected TypeError.
- No direct-symbol, Symbol-registry, or host-lane regressions are introduced.
- The final PR remains draft with the hold label until all checks are green and
  `mergeQueueEntry` is verified as `null`.
