---
id: 1907
title: "standalone: built-in static method value reads without __get_builtin (#1888 S6-b)"
status: done
pr: 1292
sprint: 61
created: 2026-06-07
updated: 2026-06-10
completed: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: built-ins, objects
goal: standalone-mode
parent: 1888
related: [1888, 1902, 1472]
test262_bucket: standalone-dynamic-object-property
test262_count: 8163
claimed_by: codex-developer
claimed_at: 2026-06-07T10:38:30.028Z
---

# #1907 — Built-in static method value reads without `__get_builtin`

## Problem

`#1902` fixed the constant-only `Math.PI` / `Number.MAX_SAFE_INTEGER` slice by
letting existing native constant emitters run under standalone. The real
`#1888` Slice 6-b gap remains: reading a built-in static method as a value still
routes through `__get_builtin` and is refused.

Examples:

```ts
const isArray = Array.isArray;
const keys = Object.keys;
const stringify = JSON.stringify;
```

These should lower to native callable values or fail loud for the specific
unsupported built-in/property pair, not to the generic `__get_builtin`
standalone refusal.

## Scope

- Implement the first demand-driven built-in static method value reads needed
  by the standalone bucket.
- Start with `Array.isArray`, `Object.keys`, and `Object.defineProperty` or
  `Object.getOwnPropertyDescriptor` if their native helper signatures are
  already usable as closures.
- Reuse the `#1888` built-ins-as-static-globals design. Keep binary size
  proportional to referenced built-ins.

## Acceptance Criteria

- Focused tests show at least two built-in static method values can be read and
  called under `target: "standalone"` with no `env::__get_builtin` import.
- Unsupported `Builtin.prop` pairs fail loud with `#1907` or `#1888 S6-b`
  cited.
- `Math`/`Number` constant tests from `#1902` remain green.
- Default/gc behavior is unchanged.

## Implementation Notes

- Added standalone built-in static method closure emission for `Array.isArray`,
  `Object.keys`, and `Object.getOwnPropertyDescriptor`.
- `Array.isArray` method values share the direct-call externref predicate:
  WasmGC vec `ref.test` under no-host targets, with the JS host predicate only
  in host mode.
- `Object.keys` method values preserve the standalone object-runtime `$ObjVec`
  `externref` return contract so `__extern_length` / `__extern_get_idx`
  consumers remain host-free.
- Unsupported standalone `Builtin.prop` value reads now fail with a
  `#1907 / #1888 S6-b` diagnostic instead of falling into `__get_builtin`.

## Validation

- `npm test -- tests/issue-1907.test.ts tests/issue-1888-s6c.test.ts`
- `npm run typecheck -- --pretty false`
- `npm test -- tests/issue-1678.test.ts`
- `npm test -- tests/issue-1472.test.ts -t "Reflect.ownKeys routes"`
- `npx prettier --check src/codegen/property-access.ts src/codegen/expressions/calls.ts tests/issue-1907.test.ts tests/issue-1888-s6c.test.ts plan/issues/1907-standalone-builtin-static-method-value-reads.md`

## Final Findings

- Implementation PR #1263 exists, was ready/non-draft, and is now merged into
  `main` at `3827daa96`; follow-up PR #1267 also merged, and PR #1287 tracks
  this redispatch verification update.
- Final codex-developer verification on this branch found no additional
  implementation work outstanding; the scoped validation commands above passed
  again on 2026-06-07 after merging current `origin/main`.
- `origin/main` was fetched at `d6957d5d` and merged into `symphony/1907` with
  merge commit `9f350d0a`. The merge brought in later sprint issue/report
  updates without #1907 conflicts.
- Scoped validation passed again on 2026-06-07T09:13+02:00 after that final
  main merge: the focused #1907/#1888 tests, typecheck, #1678 Array.isArray
  regression tests, the targeted #1472 Reflect.ownKeys standalone route, and
  formatting.
- Codex redispatch verification on 2026-06-07T09:20+02:00 confirmed
  `origin/main` is still an ancestor of `symphony/1907`, reran the same scoped
  validation successfully, and found PR #1287 open, ready/non-draft,
  mergeable, and green on remote head `ab1d8c19d`.
- Publishing the refreshed issue handoff commit was rejected on
  2026-06-07T09:23+02:00 with GitHub GH006 because PR #1287 is already in the
  merge queue and queued branch heads cannot be updated. This local handoff is
  left `in-progress`; the remote PR remains queued at `ab1d8c19d`.
- Redispatch verification on 2026-06-07T08:19+02:00 found the implementation
  already merged, branch synced with `origin/main`, PR #1287 opened
  ready/non-draft, and the same scoped validation still passing.
- Codex verification on 2026-06-07T09:11+02:00 found PR #1287 still open,
  ready/non-draft, green on the remote head, and accepted in the merge queue at
  position 11 before the local main-sync publish. This handoff keeps the issue
  `in-review` with `pr: 1287` for the PR-status poller.
- Codex verification on 2026-06-07T09:34+02:00 reran the same scoped
  validation successfully, confirmed `origin/main` remains an ancestor of local
  `symphony/1907`, and found PR #1287 still open, ready/non-draft, green, and
  queued at position 11 on remote head `ab1d8c19d`. The local handoff remains
  `in-progress` because the queued branch cannot accept the unpublished docs
  commits.
- Publishing the local handoff history was rejected again on
  2026-06-07T09:37+02:00 with GitHub GH006 because PR #1287 is still in the
  merge queue. The remote PR remains queued on `ab1d8c19d`; this local issue
  file intentionally stays `in-progress` until the queue lock is gone or the PR
  merges.
- Codex redispatch verification on 2026-06-07T09:42+02:00 reran the same
  scoped validation successfully, confirmed `origin/main` remains an ancestor of
  both local `symphony/1907` and remote `origin/symphony/1907`, and found PR
  #1287 open, ready/non-draft, mergeable, green, and queued at position 11 on
  remote head `ab1d8c19d`. The local handoff remains `in-progress` because
  prior unpublished issue-file commits are still blocked by the queued branch
  protection.
- Codex redispatch verification on 2026-06-07T09:49+02:00 reran the same
  scoped validation successfully: focused #1907/#1888 tests, typecheck, #1678
  Array.isArray regression tests, targeted #1472 Reflect.ownKeys standalone
  route, and formatting. `origin/main` remains an ancestor of both local
  `symphony/1907` and remote `origin/symphony/1907`; PR #1287 is open,
  ready/non-draft, mergeable, green, and queued at position 10 on remote head
  `ab1d8c19d`.
- Publishing the local handoff history was rejected again on
  2026-06-07T09:51+02:00 with GitHub GH006 because PR #1287 is in the merge
  queue and queued branch heads cannot be updated. The remote PR remains queued
  on `ab1d8c19d`; the local issue file remains `in-progress` until the queue
  lock clears or the PR merges.
- Codex redispatch verification on 2026-06-07T12:29+02:00 found PR #1287
  merged into `main`, with all GitHub checks green on remote head `ab1d8c19d`.
  The same scoped validation passed locally again, and no additional
  implementation changes are needed for #1907.
- Follow-up handoff PR #1292 was opened ready/non-draft against `main` to
  publish the final #1907 redispatch findings after PR #1287 merged.
- Codex redispatch verification on 2026-06-07T12:41+02:00 confirmed
  `origin/main` is still an ancestor of `symphony/1907`, reran the scoped
  validation successfully, and found PR #1292 open, ready/non-draft,
  mergeable, and waiting on queued GitHub checks on remote head `749580d52`.

## Harvest update — 2026-06-19 (run `e9579720`, dated 2026-06-18) — residual, improved

The `#1888`/`#1907` S6-b family ("built-in static property/method value read is
not supported in --target standalone … Add a native built-in method closure for
this pair") **improved from ~8,163 → ~4,575** records (by message match; 5,339
records cite #1888 / 4,724 cite #1907 — many cite both). It is still the
**largest standalone codegen-refusal family** and the **#1 standalone blocker**.
The mechanism landed (PR #1292); the residual is the **incomplete per-builtin
whitelist** — top unmapped pairs by record count: `Symbol.iterator` 805,
`Int8Array.prototype` 394, `String.prototype` 306, `Date.prototype` 260,
`Symbol.species` 185, `Function.prototype` 127, `Number.prototype` 125,
`DataView.prototype` 119, `ArrayBuffer.prototype` 115, plus a long tail
(`Set/Map/Iterator/TypedArray.*.prototype`, `Symbol.toPrimitive`,
`Symbol.toStringTag`, `*.BYTES_PER_ELEMENT`). Not a regression (count fell);
flagged so the residual under umbrella #1888 stays visible for the next
standalone-mode push.
