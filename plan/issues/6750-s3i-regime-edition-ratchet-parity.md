---
id: 6750
title: "S3-i: the native regime must clear the per-edition ratchet floors (ES5 −99, ES2026 −179, ES2016 −9, ES2023 −4 vs the host lane)"
status: ready
created: 2026-09-29
updated: 2026-10-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, testing
language_feature: conformance
goal: architecture
sprint: current
parent: 5385
depends_on: [6710]
related: [3468, 3178, 4394, 6708, 6709]
---

# #6750 — S3-i: edition-ratchet parity for the native regime

Slice S3-i of the #5385 "Implementation Plan v2"; #6708 evidence item 2.
`pnpm run check:edition-ratchet -- --results <regime JSONL>` on nightly
36399520787 (2026-09-28) against the host-lane floors:

| edition              | floor  | regime | delta    |
| -------------------- | ------ | ------ | -------- |
| ES5                  |  9,028 |  8,929 | **−99**  |
| ES2016               |     99 |     90 | **−9**   |
| ES2023               |    172 |    168 | **−4**   |
| ES2026               |    266 |     87 | **−179** |
| Unclassified (legacy)|    273 |    272 | −1       |
| ES2015 / ES2018 / ES2020 / ES2022 / ES2025 | | | +668 / +520 / +187 / +103 / +280 |

The ratchet exists precisely so that +1.6k elsewhere cannot hide a
completed edition going backwards; S6 may not flip the default while any
ratcheted edition is below its floor.

## Where the rows are (host-pass, regime-fail, non-Temporal, by directory)

`language/statements/class` 255 · `language/expressions/class` 239 ·
`built-ins/Array/prototype` 219 · `built-ins/Iterator/prototype` 155 ·
`built-ins/TypedArray/prototype` 86 · `language/statements/for-await-of`
67 · `built-ins/Promise/prototype` 49 · `built-ins/SharedArrayBuffer/prototype`
36 · `built-ins/String/prototype` 32 · `Promise/allSettled` 31 ·
`TypedArrayConstructors/ctors-bigint` 30 · `AsyncDisposableStack/prototype`
29 · `Array/fromAsync` 27 · `language/expressions/dynamic-import` 27.

By signature (same population): policy-rejected generator/async-generator
imports 357 (#3178 carriers — these are ES2015/ES2018 rows but also the
ES2026 `Iterator` helpers, hence the −179), `m should be an own property`
192 (#3468 function-object own-property residual — ES5/ES2015 class rows),
`Expected a TypeError … no exception` 115, native generator "sequential
numeric yields only" 74, `Expected a Test262Error but got undefined` 66,
`Cannot convert undefined or null to object` 59, `Invalid iterator
protocol` 44, `__get_builtin` dynamic-shape refusal 41.

## Method

1. Re-run the ratchet with `--compare <host JSONL>` for the per-TEST diff,
   and attribute every ES5 and ES2026 pass→fail row to one of the buckets
   above (script it; paste the table into this issue).
2. Route: rows owned by #3468 / #3178 / #4394 stay with those owners but
   get their counts refreshed there; rows with no owner become child
   issues of this one (one per root cause, with the repro file list).
3. Land the owned fixes in edition order: ES5 first (it is the largest
   and the oldest completed edition), then ES2026's Iterator-helper rows.
4. Re-run the ratchet on the next nightly's regime JSONL after each
   landing; the exit criterion is `test262-edition-ratchet: OK` on the
   regime lane with the **host-lane floors unchanged** (never lower a floor
   for this).

## Acceptance

- [ ] Per-test attribution table in this issue (ES5 99 rows, ES2026 179,
      ES2016 9, ES2023 4).
- [ ] `check:edition-ratchet` green on a nightly regime JSONL with the
      host floors untouched.
- [ ] Standalone high-water floor moves up or stays; default `gc` output
      byte-identical throughout.

## Attribution (2026-10-06, nightly 37440804249 regime artifact vs host baseline of the same day)

`check:edition-ratchet --results <regime.jsonl> --compare <host.jsonl>`:
ES5 8933 vs 9028 (−95), ES2016 96 vs 99 (−3), ES2023 167 vs 172 (−5),
ES2026 88 vs 266 (−178); every other edition up (ES2015 +1229, ES2018 +529,
ES2025 +339, …). Per-test join on `file` (host pass → regime not-pass:
5,946 rows; regime gains: 3,636), bucketed by error text
(`.tmp/census-6750.ts`, shape in #5385 "census reproducibility"):

| edition | lost | dominant buckets (count — first example) |
| --- | --- | --- |
| ES2026 | 3,492 | **3,383 × "wasm exception during module init"** (Temporal — **#6748**, the whole share); 33 × policy rejected `env::__array_from_async` (legacy-semantic; `Array.fromAsync` needs a native provider or accelerator classification); 13 × `__get_builtin` dynamic-shape codegen error (`Uint8Array.fromBase64/fromHex`); 11 + 9 × Uint8Array base64/hex `setFrom*`/`toBase64` null-deref; 4 × `WeakMap.prototype.set` not implemented (`getOrInsert*`) |
| ES5 | 62 | 9 × `'this' had incorrect value!` (`language/function-code/10.4.3-1-*gs.js`, global-code `this` in non-strict function code); 5 × `called value is not a function` (`S13.2.1_A6_T3`, `harness/deepEqual-object`); 4 × `filter` result length (`15.4.4.20-9-*`); 3 × `10.4.3-1-9*-s.js` strictness; 2 × `z["N.N"]` numeric-string keys on arrays (`S15.4_A1.1_T7/T8`); 2 × `defineProperties` 15.2.3.7-5-b-125/204 |
| ES2023 | 61 | 9 × TypedArray `toReversed`/`with` "argument [null] shouldn't be primitive"; 4+3+3+2 × `Array.prototype.{toSpliced,toSorted,toReversed,with}` "not yet callable as a value" (the #6709 tail — PR-C of #6651); 4 × missing RangeError on length > 2^53−1; 3 × `Object.prototype.toString` not implemented on TypedArray species rows; 2 × property-descriptor rows |
| ES2016 | 21 | **10 × policy rejected `env::__js_array_new` / `__js_array_push`** on `Array.prototype.includes/sparse.js`-family rows — a legacy host-array materialisation still reachable on the regime; the isolated `[, , ,].includes(undefined)` compiles clean in every shape probed (literal, argument, assert-like), so the emission is in the linked-harness context — bisect with the real row; 3 × `Array.prototype.push.call(...)` unsupported; 2 × `pop` not callable as a value; 3 × `splice` beyond 2^53−1 |

So: #6748 alone returns ES2026 to parity; ES2023/ES2016 are mostly the
"callable as a value" tail (#6709 → #6651 PR-C) plus one legacy-import leak
to bisect; ES5's 62 are small independent semantic gaps (list above) — none
is a regime regression of something standalone had, they are rows the host
lane passes through V8.

## Checkpoint (2026-10-07, nightly 37596924980 vs host baseline of the same day)

Regime 41,816 / 48,735 vs host 39,700 (regime 10-06 was 37,286). Per edition:
ES2026 **+4,228** (was −178; #6748 landed), ES5 −90, ES2016 −3, ES2023 −5,
every other edition up. Per-test host-pass → regime-not-pass: **2,459**
(was 5,946). The three remaining ratcheted regressions map to in-flight
slices: ES5 → #6880 (groups), #6894 (merged into PR #6584), #6898 (the
#3418 elision re-key); ES2016/ES2023 → #6912 (callable-as-value tail) and
#6881 (`__js_array_*` leak).

## Checkpoint (2026-10-10, nightly 37910451084 of 10-09 vs host baseline of 10-10)

Regime **42,014** / 48,735 vs host 39,700 (10-07: 41,816). ES2026 +4,309;
**ES5 −41** (10-07: −90), ES2016 −3, ES2023 −5. Per-test host-pass →
regime-not-pass: 2,319 (10-07: 2,459). This artifact predates #6881 (#6607),
#6912 B–D (#6594/#6610/#6611), #6913 (#6612) and #6882 (#6571), all merged
10-09/10-10, and #6898 (#6588, un-drafted 10-10) — the ES2016/ES2023 rows and
most of ES5's remainder. Next nightly is the one to score S6 item 2 on.
