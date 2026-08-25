---
id: 4693
title: "ES2015 standalone assignment destructuring: exclude computed object-rest keys"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: s
feasibility: easy
task_type: conformance
area: codegen, destructuring
es_edition: es6
goal: standalone-mode
related: [2032, 2569, 4690, 4691]
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
---

# #4693 — assignment object-rest computed-key residual

## Scope and measured baseline

The supplied snapshot is
`/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`
(oracle version 13; rows timestamped `25.8.2026, 04:31:12`–`04:36:35`,
snapshot mtime `2026-08-25 05:27:06`).  The bounded slice is the **9**
non-passing `language/expressions/assignment/dstr` rows whose object
assignment pattern has a computed property followed by object rest:

| file | snapshot status/signature |
| --- | --- |
| `obj-rest-computed-property.js` | `fail / assertion_fail` — `Expected SameValue(«[object Object]», «undefined») to be true` |
| `obj-rest-computed-property-no-strict.js` | `fail / assertion_fail` — same |
| `obj-rest-non-string-computed-property-1.js` | `fail / assertion_fail` — same |
| `obj-rest-non-string-computed-property-array-1.js` | `fail / assertion_fail` — same |
| `obj-rest-non-string-computed-property-1e0.js` | `fail / assertion_fail` — same |
| `obj-rest-non-string-computed-property-string-1.js` | `fail / assertion_fail` — same |
| `obj-rest-non-string-computed-property-1dot.js` | `fail / assertion_fail` — same |
| `obj-rest-non-string-computed-property-1dot0.js` | `fail / assertion_fail` — same |
| `obj-rest-non-string-computed-property-array-1e0.js` | `fail / assertion_fail` — same |

Count: **9 rows, 9 fail, 0 compile errors, 0 passes** in this slice.  The
artifact has one additional row with the same signature,
`array-rest-nested-array-undefined-hole.js`, but it is an array-rest/nested
hole shape and is deliberately outside this object-rest-only root-cause
boundary.

The current `upstream/main` used for implementation is
`6b53ec2755372976936e43b13f4b42b58c60ee46` (2026-08-25).  Exact pinned
`runTest262File(file, "issue-4693", 60000, "standalone")` probes reproduce
all nine as `fail`; the rendered failure is
`Test262Error: Expected SameValue(«[object Object]», «undefined») to be true`
(the local renderer may attach the first assertion line while the failing
comparison is the computed key's omitted entry in `rest`).

Known-good controls in the same family are the static-key object-rest rows,
which pass on the same tip; they guard ordinary exclusion-key collection and
the assignment result identity.

## Root cause

`compileDestructuringAssignment` in
`src/codegen/expressions/assignment.ts` builds `excludedKeys` for the native
`emitNativeObjectRest` path, but only copies identifier, string-literal, and
numeric-literal property names.  A `ComputedPropertyName` is omitted even
when `resolveComputedKeyExpression` can resolve its runtime expression to the
same property key used by the named assignment.  The named value is read
correctly, but native `CopyDataProperties` receives no exclusion for that key,
so the computed property is incorrectly retained in `rest` and its descriptor
is an object instead of `undefined`.

## Implementation plan

1. Extend the assignment object-rest exclusion scan to include computed names
   that resolve through the existing `resolveComputedKeyExpression` helper.
   Leave truly dynamic keys and all non-assignment destructuring lanes alone.
2. Add exact standalone pins for the 9 artifact rows plus static-key pass
   controls.  Assert strict `status === "pass"` and no error text.
3. Re-run the focused probes, baseline-pass controls, compiler checks, and
   normal pre-push gates after merging the latest upstream main.

## Risks and non-goals

- Scope is only assignment-form object rest with a statically resolvable
  computed key.  Runtime-only key expressions, binding declarations,
  for-of/for-await destructuring, array rest, and class call arguments are
  out of scope.
- Do not change `resolveComputedKeyExpression` or the native rest runtime; the
  fix is limited to passing an already-known exclusion key.
- Keep compiler source growth at or below 150 lines (expected change is a few
  lines in `assignment.ts`).

## Acceptance

- All 9 named rows pass through the exact standalone `runTest262File` seam.
- At least 3 same-family static-key controls remain passing before and after;
  assignment result identity remains intact.
- No source file outside `src/codegen/expressions/assignment.ts` is changed for
  the implementation, and all required typecheck/format/ratchet/pre-push
  checks pass.

## Intended files

- `src/codegen/expressions/assignment.ts`
- `tests/issue-4693.test.ts`
- this issue record

## Test Results

- Baseline controls on `6b53ec275`: `obj-rest-same-name.js`,
  `obj-rest-val-null.js`, and `obj-rest-val-undefined.js` — **3/3 pass**.
- Focused `tests/issue-4693.test.ts` on the implementation branch — **12/12
  pass** (9 exact residual rows + 3 controls), each through
  `runTest262File(..., "standalone")` with strict `status === "pass"` and
  `error === undefined` assertions.
- `pnpm exec prettier --check` on the changed source, test, and issue file —
  **pass**.
- `pnpm run typecheck` (TypeScript 7) — **pass**.
- `pnpm run lint` — **pass** (repository baseline diagnostics remain
  unchanged).
- `pnpm run check:loc-budget` — **pass** (`assignment.ts` intentional net
  growth +7, within the recorded allowance).
- `pnpm run check:func-budget` — **pass**.
- `pnpm run check:oracle-ratchet` and `pnpm run check:coercion-sites` —
  **pass**, with no checker or coercion-site growth.
- Fetched and merged `upstream/main` at `7cb7e0b8053c635639529c1e51d1ae1751872656`
  in merge commit `725c3061a`; the exact focused suite remained **12/12
  pass** after the merge.
- Post-merge `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`,
  both budget gates, both ratchets, and `pnpm run check:issues` — **pass**.
- Post-merge numeric-local pre-push control
  (`tests/issue-3765-numeric-locals.test.ts`) — **18/18 pass**.
