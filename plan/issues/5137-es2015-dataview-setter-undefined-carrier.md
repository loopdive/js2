---
id: 5137
title: "ES2015 standalone DataView setter undefined result carrier"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES2015
language_feature: dataview-setter-return-undefined
goal: standalone-mode
assignee: "ttraenkler/codex-5137-es2015-dataview-setter-undefined"
branch: codex/5137-es2015-dataview-setter-undefined
files:
  - src/codegen/dataview-native.ts
  - tests/issue-5137-es2015-dataview-setter-undefined-carrier.test.ts
  - plan/issues/5137-es2015-dataview-setter-undefined-carrier.md
---

# #5137 — ES2015 DataView setter `undefined` result carrier

## Scope and ownership

This repository-local markdown issue owns exactly these seven official ES2015
Test262 rows:

- `test/built-ins/DataView/prototype/setFloat32/set-values-return-undefined.js`
- `test/built-ins/DataView/prototype/setFloat64/set-values-return-undefined.js`
- `test/built-ins/DataView/prototype/setInt16/set-values-return-undefined.js`
- `test/built-ins/DataView/prototype/setInt32/set-values-return-undefined.js`
- `test/built-ins/DataView/prototype/setInt8/set-values-return-undefined.js`
- `test/built-ins/DataView/prototype/setUint16/set-values-return-undefined.js`
- `test/built-ins/DataView/prototype/setUint32/set-values-return-undefined.js`

Issue ID 5137 was atomically reserved with
`node scripts/claim-issue.mjs --allocate` and verified on
`upstream/issue-assignments`. This file is the canonical tracker. Do not create
a GitHub issue; a GitHub issue or pull request with the same number is unrelated
namespace state.

The ES2015 `setUint8` sibling is excluded because it currently fails earlier
with a distinct null-property access signature. The BigInt and Float16 siblings
are ES2020 and ES2025 respectively and are outside the ES2015 goal. This issue
must not broaden into their separate blockers merely because the eventual
producer correction may benefit them.

## Current-main baseline

The dedicated worktree starts from `upstream/main`
`8e41f500d11ed6a039449e6609b1419988fba9ce`. The pinned authoritative
snapshots are:

- standalone: `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`
  (SHA-256
  `260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`);
- host: `/private/tmp/js2-baseline-host-current-20260828.jsonl` (SHA-256
  `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`).

The maintained file-edition map classifies all seven owned rows as ES2015.
Every host snapshot record is `pass`; every standalone record reaches the test
and fails with the same semantic mismatch:

```text
return is undefined, value: 127
Expected SameValue(«null», «undefined») to be true
```

The exact A/B was repeated on the clean current-main worktree through
`runTest262File` with a 120-second per-row timeout. Host passed **7/7**.
Standalone failed **7/7** with the same `null` versus `undefined` assertion and
no compile error, timeout, skip, or host-import leak. The standalone Wasm hashes
were `ba99c9fd17d6`, `035ded08a20d`, `ef23bb849e4e`, `afbe09ab49f4`,
`40282e800118`, `807d53b9ed38`, and `f82699fd8160` in the path order above.

## Duplicate and dependency audit

- #1515 introduced the native DataView setter value path and records the
  direct-form requirement that setters return `undefined`; that direct path now
  passes and does not cover the runtime-receiver helper carrier.
- #3173 completed the shared DataView spec-order core but explicitly left the
  seven owned rows as residual failures. Its note attributed them to dynamic
  array reads; the fresh current-main A/B now reaches the final return-value
  assertion and identifies the remaining producer mismatch directly.
- #3183 completed the dynamic vec read/for-in helpers. It does not change the
  return value emitted by `__dv_m_<member>` and did not flip these rows.
- #2872 corrected the analogous legacy `ref.null.extern` producers in native
  Array higher-order helpers. It is precedent, not overlapping ownership.
- #2864 introduced `canonicalUndefinedExternInstrs(ctx)` specifically for
  semantic `undefined` producers that must remain distinct from `null`
  independently of the older flag-gated singleton regime.
- #5117 and #5129 own DataView byte-offset Symbol coercion and prototype tag
  metadata respectively; neither overlaps this result-carrier slice.

No active issue or open PR found by the repository scans owns this exact
runtime-receiver DataView setter result producer.

## Root cause

The direct native lowering `emitDataViewAccessor` treats a setter as `void`, so
its ordinary call site materializes the compiler's current canonical
`undefined` value. The callback-shaped Test262 rows widen the receiver and
route through `ensureDvAccessorHelper`, which mints
`__dv_m_<member>(...) -> externref` for closed-method and reflective dispatch.

That helper still ends every setter body with legacy `ref.null.extern` and a
comment claiming the null extern represents `undefined`. The repository's
current standalone value model distinguishes the canonical tag-1 `$undefined`
singleton from a null externref. Consequently the helper returns observable JS
`null`, while the write itself and stored bytes are correct. The exact failure
message is the expected signature of this producer mismatch.

`canonicalUndefinedExternInstrs(ctx)` is the existing lane-correct producer. It
reserves and emits the canonical singleton for standalone/native strings and
uses the host undefined path where appropriate. The older
`undefinedExternInstrs(ctx)` is flag-gated and is not sufficient for a semantic
result that is unconditionally `undefined`.

## Implementation plan

1. Replace the setter result in `ensureDvAccessorHelper` with
   `canonicalUndefinedExternInstrs(ctx)`, updating the adjacent invariant
   comment. Do not alter the direct DataView accessor lowering, byte codecs,
   coercion order, error order, bounds checks, or getter boxing.
2. Add a focused regression suite that runs the seven exact rows in host and
   standalone modes through the maintained runner. Add direct controls that
   force the runtime-receiver/helper path and prove the returned value is
   `undefined`, is not `null`, has `typeof "undefined"`, and preserves the
   setter write and zero-import standalone contract.
3. Include sibling guards for the direct typed-receiver setter path, getter
   values, missing-value coercion, and at least one reflective/closed-method
   call. The tests must demonstrate that the change is a producer correction,
   not an assertion-harness special case.
4. Re-run the exact host/standalone A/B, repeat standalone for determinism, and
   execute the nearby #3173/#3183/#2872 controls plus repository typecheck,
   lint, formatting, issue integrity, ratchets, host-import, LOC/function, and
   pre-push gates with at most two workers.
5. Refresh from current `upstream/main` with a normal merge before final
   publication. Push each checkpoint without force. Keep the upstream PR draft
   only while the plan or implementation is not mergeable; mark it ready only
   after all owned rows and required gates pass.

## Acceptance criteria

- The exact owned cohort is host **7/7 pass** and standalone **7/7 pass**, with
  zero failures, compile errors, timeouts, skips, or standalone host imports.
- Every helper-routed ES2015 DataView setter returns the canonical
  `undefined`; `result === undefined` is true, `result === null` is false, and
  `typeof result` is `"undefined"`.
- The setter still stores the expected value, and DataView getters, direct
  typed calls, coercion/error ordering, and sibling runtime helpers regress
  neither host nor standalone behavior.
- The implementation remains bounded to the shared result producer, focused
  tests, and this tracker. Excluded `setUint8`, BigInt, and Float16 blockers are
  reported as collateral only and are not silently claimed.
- The final non-draft PR targets `loopdive/js2:main`, originates from
  `ttraenkler/js2`, follows the repository Description/CLA body template, and
  cites this markdown issue rather than a GitHub issue.

## Handoff

Worktree: `/private/tmp/js2-es2015-dataview-setter-undefined-20260828`.
Branch: `codex/5137-es2015-dataview-setter-undefined`.

The implementation commit, exact post-fix A/B, quality evidence, upstream PR
URL/head, and final queue state will be appended here as the work progresses.
No GitHub issue was created.
