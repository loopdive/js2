---
id: 2859
title: "IR: drive param-type-not-resolvable fallback bucket to zero (TypeMap propagation)"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-06-30
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [1376]
---

# #2859 — IR: `param-type-not-resolvable` → 0

Child of the IR front-end migration epic **#2855**. Smallest unintended bucket —
a good tail-filler slice.

## Problem

`param-type-not-resolvable` is raised when the IR selector cannot resolve a
parameter's Wasm type from the source annotation + TypeMap propagation
(`src/ir/select.ts:81`), so the function demotes to legacy. Per
`plan/log/ir-adoption.md`, the row promotes when "TypeMap propagation reaches the
param."

## Live snapshot (verified `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose` → **`param-type-not-resolvable: 1`**,
in `website/playground/examples/benchmarks/helpers.ts` (the same file also shows
`body-shape-rejected: 1` and `call-graph-closure: 1` — but those are distinct
functions/causes; this issue scopes only the single param-type rejection).

## Approach

1. Identify the one function in `benchmarks/helpers.ts` whose parameter type the
   selector cannot resolve (extend the diagnostic from #2856 to print the
   function name + unresolved param, or add a temporary trace in
   `whyNotIrClaimable`).
2. Determine whether the fix is (a) better TypeMap propagation reaching that
   param, or (b) a missing annotation-resolution case in the selector's type
   resolver. Implement the minimal fix.
3. Re-run the gate; `pnpm run check:ir-fallbacks -- --update-on-decrease`.
4. At `param-type-not-resolvable: 0`, add `"param-type-not-resolvable"` to
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1013`). Consider bundling the
   strict-promotion of the related `return-type-not-resolvable` and
   `type-resolution-failure` reasons (already at zero) in the same PR, since they
   share the TypeMap-propagation root cause.

## Acceptance criteria

1. `param-type-not-resolvable` count in `scripts/ir-fallback-baseline.json` is `0`.
2. The previously-rejected `helpers.ts` function is IR-claimed (verify via the
   gate / `irReport`).
3. `"param-type-not-resolvable"` added to `STRICT_IR_REASONS` once the bucket is
   zero.
4. No regression in `tests/ir-*.test.ts` or test262 conformance.

## Files

- `src/ir/select.ts` — param type resolution in `whyNotIrClaimable`.
- (possibly) the TypeMap propagation source feeding the selector.
- `scripts/ir-fallback-baseline.json` — ratchet down.
- `src/codegen/index.ts:1013` — `STRICT_IR_REASONS` once at zero.
