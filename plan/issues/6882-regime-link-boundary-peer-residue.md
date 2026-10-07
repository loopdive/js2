---
id: 6882
title: "S3-l: finish the regime's provider–consumer link — the remaining `boundary ?? peer` sites and the 20 Temporal/PlainTime rows left by #6748"
status: ready
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: linked-providers
goal: architecture
sprint: current
parent: 5385
related: [6748, 5383, 6750, 6880]
---

# #6882 — the half of #6748 the measured rows did not need

#6748 (PR #6542) made the regime's Temporal provider link: `new`, property
reads, method calls and `getPrototypeOf` now ask the wasm peer first and the
JS boundary second (`constructBoundaryPairs` in `standalone-link-boundary.ts`;
`object-runtime.ts`, `object-runtime-prototype.ts`, `native-construct.ts`,
`runtime/wasmgc/values/object-get-bodies.ts`). Four sites still pick one side
with `boundary ?? peer`, and 20 `PlainTime/` rows still fail on the regime
while standalone passes them.

## Sites

| site | symptom today |
| --- | --- |
| `__extern_has` (object-runtime.ts, the `hasBoundaryOrReverseIdx` arm) | `in` / `hasOwnProperty` on a provider-minted struct answers the boundary only |
| keys / for-in (`__object_keys`, `__object_keys_forin`, `__boundary_object_for_in_keys`) | enumeration of a provider struct from the consumer |
| `__apply_closure` (closures.ts / function-proto-invokers.ts) | `called value is not a function` for a provider closure — also the cause of ES5 group 2 in #6880 (`harness/deepEqual-*.js`) |
| the `typeof` callable-kind check (`__boundary_object_callable_kind` vs the peer's) | one PlainTime row answers `"object"` for a function |

## The 20 PlainTime rows (from #6748's report)

- a `TypeError` for a Symbol-valued `options` argument (the symbol crosses
  the link as a boundary box; needs the peer's symbol identity);
- `Symbol.toStringTag` read across the link (keys/get of a well-known symbol
  on a provider prototype);
- one `typeof` answering `"object"` (the callable-kind site above).

## Plan

Same recipe as #6748: for each site, build the matching boundary/peer pair
and ask the peer first; focused test in `tests/issue-6882-*.test.ts` using a
two-module regime project (consumer + provider) for `in`, `for…in`,
`Object.keys`, calling a provider function value, `typeof` on it; then the
scoped lane `TEST262_PATH_FILTER="built-ins/Temporal/PlainTime/"` before/after
(473/493 → 493). Delete `.test262-cache/temporal` between codegen changes
(the key omits the compiler version — fix that too while here:
`temporalProviderCacheKey` should include the compiler-bundle hash).

## Acceptance

- [ ] PlainTime 493/493 on the regime lane; `Temporal/Now/` unchanged.
- [ ] ES5 group 2 rows of #6880 pass (`harness/deepEqual-*.js`).
- [ ] Default gc / standalone / wasi byte-identical.
