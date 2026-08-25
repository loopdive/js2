---
id: 4388
title: "Standalone global object omits ES5 value-property descriptors"
status: done
created: 2026-08-12
updated: 2026-08-18
priority: high
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, object-runtime
language_feature: global-object, property-descriptors
goal: es5-test262
sprint: 78
es_edition: ES5
assignee: ttraenkler/codex-es5-descriptor
related: [2984, 2988, 2996, 3365, 4242]
origin: "Fresh standalone <=ES5 Test262 failure clustering on origin/main"
files:
  - scripts/quickjs-eval-provider.mjs
  - src/codegen/array-object-proto.ts
  - tests/issue-4388-global-value-descriptors.test.ts
loc-budget-allow:
  - src/codegen/array-object-proto.ts
---
# #4388 — Standalone global value-property descriptors

## Defect

The native standalone `globalThis` carrier is a real, identity-stable `$Object`,
but it starts empty. The older `Object.getOwnPropertyDescriptor(this, key)`
fold for `NaN`, `Infinity`, and `undefined` assumes sloppy top-level `this`
still lowers to an undefined sentinel. Since #3365 correctly materialized the
realm global object there, the fold takes its dynamic arm and asks the empty
carrier for each property. It returns no descriptor.

The fresh <=ES5 standalone baseline has three direct failures:

- `15.2.3.3-4-178.js` (`NaN`)
- `15.2.3.3-4-179.js` (`Infinity`)
- `15.2.3.3-4-180.js` (`undefined`)

This is a runtime-carrier omission, not a descriptor-read or harness failure.
A minimized sloppy-script probe proves the descriptor fields are absent, while
the same harness method call succeeds with ordinary values.

## Fix

Seed the native global singleton, at lazy materialization time, with the three
ES5 immutable data properties. All use `{ writable:false, enumerable:false,
configurable:false }`; their values are the canonical boxed `NaN`, positive
infinity, and standalone undefined carrier.

The seed uses the existing native `__defineProperty_value` MOP. Consequently
ordinary dynamic reflection and IR-emitted `dyn.member_get` observe the same
carrier state; the fix does not add another AST-only descriptor synthesis.

The QuickJS eval adapter leaves these three intrinsic names owned by each
realm. Mirroring them is redundant, and its pull phase would otherwise assign
back through the caller's newly correct non-writable descriptors and throw.

## Acceptance

- [x] All three exact Test262 files pass in standalone mode.
- [x] A sloppy Script-goal module initializer observes all descriptor values
      and flags.
- [x] An IR-emitted dynamic read observes the seeded native global carrier.
- [x] No JavaScript-host imports are introduced.
- [x] The QuickJS provider pair builds and passes all linked-pair canaries.
- [x] Typecheck and IR fallback gates pass.

## Verification

- Exact standalone Test262: **0/3 → 3/3**, no unchanged failures in the
  three-file target.
- `tests/issue-4388-global-value-descriptors.test.ts`: **2/2**.
- QuickJS provider build plus linked-pair canaries: pass; provider suite:
  **29/29**.
- The `isGlobalNaN(any)` proof is an `emitted` IR outcome with no host imports.
- `pnpm exec tsc --noEmit --pretty false`: pass.
- `pnpm run check:ir-fallbacks`: pass, no gated increase.
