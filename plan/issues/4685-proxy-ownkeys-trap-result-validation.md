---
id: 4685
title: "standalone Proxy ownKeys validates trap result lists"
status: done
completed: 2026-08-25
created: 2026-08-25
updated: 2026-08-25
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen, runtime
es_edition: 2015
language_feature: proxy
goal: test262-conformance
related: [1355]
loc-budget-allow:
  - src/codegen/object-runtime-proxy.ts
func-budget-allow:
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
origin: "2026-08-25 ES2015 standalone residual cluster from .test262-cache/test262-standalone-current.jsonl"
files:
  - src/codegen/object-runtime-proxy.ts
  - tests/issue-4685.test.ts
  - plan/issues/4685-proxy-ownkeys-trap-result-validation.md
coercion-sites-allow:
  - src/codegen/object-runtime-proxy.ts
---

# #4685 — standalone Proxy `ownKeys` validates trap-result lists

## Scope

The ES2015 standalone baseline contains 27 `test/built-ins/Proxy/ownKeys`
rows: 6 pass and 21 fail. This issue selects one coherent runtime gap: the
standalone `Proxy.[[OwnPropertyKeys]]` dispatch checks only that a trap result
is broadly object-like, then forwards it without implementing the
`CreateListFromArrayLike` element validation and duplicate-entry checks.

The implementation is limited to validating the trap result itself. Target
extensibility/key-set invariants, non-callable trap values, nested proxy
forwarding, and symbol enumeration remain separate follow-up slices.

## Exact selected rows

All nine rows below are baseline `fail` in the authoritative artifact
`/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`.
Their expected post-change status is `pass`.

- `test/built-ins/Proxy/ownKeys/return-not-list-object-throws.js`
- `test/built-ins/Proxy/ownKeys/return-type-throws-array.js`
- `test/built-ins/Proxy/ownKeys/return-type-throws-boolean.js`
- `test/built-ins/Proxy/ownKeys/return-type-throws-null.js`
- `test/built-ins/Proxy/ownKeys/return-type-throws-number.js`
- `test/built-ins/Proxy/ownKeys/return-type-throws-object.js`
- `test/built-ins/Proxy/ownKeys/return-type-throws-undefined.js`
- `test/built-ins/Proxy/ownKeys/return-duplicate-entries-throws.js`
- `test/built-ins/Proxy/ownKeys/return-duplicate-symbol-entries-throws.js`

The exact zero-loss controls are the baseline-pass rows
`extensible-return-trap-result.js` and `return-is-abrupt.js`. The broader
`Proxy/ownKeys` population is re-run after the change to ensure no selected
or control behavior is lost.

## Implementation plan

1. Extend the standalone ownKeys dispatch's top-level list-like check to cover
   all non-object trap results, including `undefined` and other primitive
   carriers.
2. Read the trap result through the existing `__extern_length` and
   `__extern_get_idx` helpers. Reject any entry that is neither a string nor a
   symbol, preserving the existing TypeError path.
3. Compare each entry with its preceding entries using the shared extern
   strict-equality helper and reject duplicate strings or symbols.
4. Add focused regression coverage for the selected rows and zero-loss
   controls, then run the exact authoritative `runTest262File(...,
   'standalone')` rows before and after the change.

## Risks and non-goals

- The Wasm validation loop must preserve the existing trap call ABI and result
  forwarding for valid arrays and array-like values.
- Symbol checks must use the native symbol carrier, while string comparison
  must compare string values rather than only externref identity.
- The selected tests do not establish target key-set invariants or callable
  trap validation; changing those would widen this issue beyond one bounded
  root cause.
- Cross-realm proxy forwarding is a separate boundary. In particular,
  `return-not-list-object-throws-realm.js` remains out of scope because it
  constructs the Proxy in another realm and does not exercise this local
  standalone proxy carrier.

## Files

- `src/codegen/object-runtime-proxy.ts`: validate ownKeys trap results in the
  standalone dispatch.
- `tests/issue-4685.test.ts`: focused selected-row and control regressions.
- `plan/issues/4685-proxy-ownkeys-trap-result-validation.md`: measurements,
  plan, and final test evidence.

## Test Results

Baseline evidence from the supplied artifact: the 27-row
`Proxy/ownKeys` population was **6 pass / 21 fail**. Each of the nine selected
rows was reproduced through the authoritative `runTest262File(file,
"built-ins/Proxy", 30000, "standalone")` seam before editing and failed with
the expected missing-TypeError assertion.

After the runtime change, the same exact runner gives:

- Selected-row detail:

  | row | artifact before | exact after |
  | --- | --- | --- |
  | `return-not-list-object-throws.js` | fail | pass |
  | `return-type-throws-array.js` | fail | pass |
  | `return-type-throws-boolean.js` | fail | pass |
  | `return-type-throws-null.js` | fail | pass |
  | `return-type-throws-number.js` | fail | pass |
  | `return-type-throws-object.js` | fail | pass |
  | `return-type-throws-undefined.js` | fail | pass |
  | `return-duplicate-entries-throws.js` | fail | pass |
  | `return-duplicate-symbol-entries-throws.js` | fail | pass |

- **9/9 selected rows pass**: both duplicate rows, the local non-list row, and
  all six invalid-element rows.
- The cross-realm `return-not-list-object-throws-realm.js` row is explicitly
  excluded. CI's interpreter tier proved it remains a semantic failure rather
  than an unavailable-provider result, so it requires a separate cross-realm
  proxy-carrier issue.
- Both zero-loss controls pass: `extensible-return-trap-result.js` and
  `return-is-abrupt.js`.
- The full 27-row population is **15 pass / 12 fail**. The twelve remaining
  failures are the pre-existing target-invariant, nested-forwarding,
  non-callable-trap, and symbol-enumeration rows outside this issue's scope;
  no baseline-pass row regressed.

Focused and static checks:

- `pnpm exec vitest run tests/issue-4685.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot`: **11/11 pass**.
- `pnpm run typecheck:ts5`: pass.
- `pnpm run typecheck`: pass.
- `pnpm exec biome lint src/codegen/object-runtime-proxy.ts tests/issue-4685.test.ts --diagnostic-level=error`: pass.
- `pnpm exec prettier --check src/codegen/object-runtime-proxy.ts tests/issue-4685.test.ts plan/issues/4685-proxy-ownkeys-trap-result-validation.md`: pass.
- `pnpm run check:stack-balance`: pass; no fixup-bucket increases.
- Full-repository `pnpm run lint` reports the repository's existing diagnostic
  population (1672 diagnostics); the changed files pass the scoped lint above.
