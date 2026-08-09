---
id: 1907
title: "standalone: built-in static method value reads without __get_builtin (#1888 S6-b)"
status: done
pr: 1292
sprint: 75
created: 2026-06-07
updated: 2026-07-21
completed: 2026-07-21
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
assignee: ttraenkler/senior-dev
claimed_by: ttraenkler/senior-dev
claimed_at: 2026-06-07T10:38:30.028Z
loc-budget-allow:
  - src/codegen/array-object-proto.ts
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

## Harvest refresh — 2026-06-24 (run `426e28e8`) — still the #1 standalone codegen-refusal family

Stable vs 2026-06-19. By the highest-signal metric (embedded `#NNNN` citation,
deduped per record) the #1888/#1907 S6-b family is **1,631 records** — the
single largest standalone *codegen-refusal* family (tied #1888 = #1907; the same
refusal cites both). Top still-unmapped `Builtin.prototype` value-read pairs by
record count (from the `… built-in static property value read is not supported
in --target standalone (#1888 / #1907 S6-b)` signatures): `Int8Array.prototype`
460+52, `ArrayBuffer.prototype` 129, `DataView.prototype` 100, `Atomics.waitAsync`
93, `Iterator.prototype` 48, `TypeError.prototype` 43, `SharedArrayBuffer.prototype`
38, plus the long tail (`Reflect.*` Phase-C, `DisposableStack`/
`AsyncDisposableStack.prototype`, `Symbol.matchAll`, `Uint8Array.prototype`,
`Array.fromAsync`). Separately the generic `'__get_builtin' … not yet supported
… (Phase B)` refusal is 536 records. Mechanism is landed (PR #1292); the residual
is the **incomplete per-builtin whitelist** — still the clearest standalone-mode
lever for the next push.

**Active owner of this residual = #2175** (in-progress, sprint 65 — architect
spec "standalone builtin-prototype object representation + native-method-closure
dispatch"). #1907 landed only the *starter* slice (`Array.isArray`/`Object.keys`/
`getOwnPropertyDescriptor` + the closure mechanism, PR #1292); #2175 generalizes
`ensureStandaloneBuiltinStaticMethodClosure` into a brand-keyed factory covering
the full `Int8Array/%TypedArray%/ArrayBuffer/DataView/RegExp.prototype`
object-read + dynamic-receiver dispatch behind this bucket (constructor-as-value
tier is the #2651 follow-up below). **#1907 stays `done` (starter-slice scope
met, not regressed); do not reopen** — the residual is tracked and scheduled
under #2175, and reopening would split ownership of one bucket across two issues.
Runtime-side coercion counterpart: the ToPrimitive bucket under #1917.

> **Follow-up #2651 (s66, 2026-06-24): the TypedArray *constructor*-as-value
> tier.** Verified (per-process WAT probe, `main` `c2847896d8`) that the bulk of
> standalone `built-ins/TypedArray/prototype/*` rows are gated not on the method
> body (fixed in #2648/#2644) but on reading the **builtin constructor itself as
> a VALUE** — the `testWithTypedArrayConstructors` harness iterates the ctors and
> reads each as a value (`new TA(arg)`, `TA.name`, `TA.prototype`,
> `TA.BYTES_PER_ELEMENT`, `Object.getPrototypeOf(TA)`). Under the host-free
> contract that read resolves to `ref.null.extern` (null ctor); under default
> standalone it leaks `env.global_<Name>` (the #2094 class). #2651 specs the
> demand-driven `$NativeCtor` singleton (D1) + reserved-TypedArray `$NativeProto`
> wiring (D2) + dynamic-`new` brand-dispatch (D3) + `%TypedArray%` intrinsic
> identity (D4, coordinates #2580 M3). This is the constructor-tier extension of
> this issue's case-(c). See `plan/issues/2651-builtin-constructor-prototype-as-value-substrate.md`.

## Reopened 2026-07-20 (stale false-done review)

Marked `done` but live test262 shows: BigUint64Array built-in static property value read still unsupported (standalone). Reopened as `ready`. See #3474 (done-status integrity).

## Fix 2026-07-21 (reopen closed — senior-dev)

**Verify-first (per-process WAT probe, `main` `3e53969618`):** the residual was
narrow and exactly the reopen reason. Of the 11 TypedArray views, all 9
non-bigint `<View>.prototype` VALUE reads already resolved host-free; only
`BigInt64Array.prototype` and `BigUint64Array.prototype` still hard-refused with
`#1907 / #1888 S6-b` (their `.BYTES_PER_ELEMENT` / `.name` / `.length` folds
already worked via #838 / #2861). Root cause: #838 landed the bigint views as
typed arrays but the `<View>.prototype` native-proto glue whitelist
(`WIRED_TYPED_ARRAY_VIEWS` in `array-object-proto.ts`) still excluded them.

**Fix (surgical, bounded):** added a separate `TYPED_ARRAY_VIEW_PROTO_NAMES` set
(the 9 non-bigint views + `BigInt64Array` / `BigUint64Array`) consulted only by
`ensureTypedArrayViewNativeProtoGlue`. The bigint views inherit the same
`%TypedArray%.prototype` member set per §23.2, and the `.prototype` read is a
**pure value object** (member CSV only — `emitLazyNativeProtoGet` never emits a
member body), so no i64-specific codegen is needed. Kept the two bigint views
**out** of `WIRED_TYPED_ARRAY_VIEWS` / `isWiredTypedArrayViewName` so the 5 other
consumers (the `%TypedArray%` intrinsic-ctor identity, `Object.getPrototypeOf`
recognition, dynamic-`new` brand dispatch) are untouched — those, plus the
reflective i64 accessor-getter bodies (`typedArrayViewBrandCandidates` registers
only i8/i16/i32 vec storage), remain a separate unlanded slice **tracked under
#2175** (the umbrella-#1888 standalone builtin-prototype object-representation +
native-method-closure dispatch generalization), NOT this issue.

**Residual ownership (so the next false-done sweep does not re-reopen #1907):**
the reopen fired because the `#1907 / #1888 S6-b` refusal *signature* is shared
across many still-unmapped `Builtin.prop` pairs. The bigint `<View>.prototype`
value-read residual — the specific #1907 scope — is now CLOSED. Any remaining
S6-b signatures (`%TypedArray%`/bigint intrinsic-ctor identity, i64 getter
bodies, dynamic-`new` on a bigint ctor value, the long tail of other builtins)
belong to #2175 / umbrella #1888, not #1907.

**Downstream check:** the reflective i64 getter-closure path
(`BigUint64Array.prototype.byteLength` read-as-value then called) is newly
*reachable* but would throw a catchable TypeError (no i64 vec candidate to
brand-recover) — that path refused entirely before, so it is not a regression.

**Measured (local, verify-first):** both bigint `.prototype` reads now compile,
validate, run, and materialize a truthy proto object with **no** `__get_builtin`
/ `env.global_*` leak — full parity with the `Int8Array.prototype` control
(`.prototype.map.length` folds to `1` for both). These rows are a subset of the
harvest's `Int8Array.prototype`-family standalone-refusal bucket
(`built-ins/TypedArray/prototype/*` BigInt64/BigUint64 corpus).

**Flip-direction pre-check (predicts positive, parallel to #2651):** the
descriptor-metadata reads that test262's `propertyHelper.js verifyProperty` uses
— `BigInt64Array.prototype.at.length` → `1`, `BigInt64Array.prototype.map`
truthy — now work for bigint. #2651 flipped the bulk of the ctor-iteration
harness rows for the 9 non-bigint views on value-read + foldable descriptor
metadata alone (the real i64 getter *bodies* only landed later, #2893), so the
getter-wall likely does NOT gate these rows. The exact CI standalone flip delta
(`net_per_test`) is the sanctioned measurement, reported at self-merge. **If CI
returns net≈0, that is the i64-getter-body wall → a #2175 follow-up, not a fix
for this branch.**

**Collateral (fix-on-touch, #3008):** `tests/issue-1907.test.ts` carried a stale
assertion that `Math.max` value read *fails loud at compile time*. That premise
died with #2933 (Math.max value read implemented) and #2984/#3320 (unsupported
statics now reify as **runtime-refusal closures** — they compile host-free and
throw a catchable error only when *called*). Reframed that case to the current
#2984 contract using `Object.seal` (reifies host-free, throws on call). Verified
independent of this change against pristine `origin/main`.

Files: `src/codegen/array-object-proto.ts` (the whitelist split + comments),
`tests/issue-1907.test.ts` (2 bigint `.parametrized` cases + the #2984 reframe).
