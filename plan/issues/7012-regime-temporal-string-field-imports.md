---
id: 7012
title: "Regime gap: the #661 Temporal lowering's string/field helpers still import `env::__temporal_*` on native-string builds"
status: in-progress
assignee: ttraenkler/opus-7012-temporal
created: 2026-10-16
updated: 2026-10-16
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: temporal
goal: architecture
sprint: current
parent: 5385
related: [6979, 6748, 6882, 6706, 5353]
---

# #7012 — Temporal string/field helpers on the native regime

## Problem

The S7-b checkpoint of #6979 (branch `issue-6979-s7b-legacy-semantic-removal`)
left one Temporal family as a named `regime-gap`: `temporal-strings` —
`__temporal_*_to_string`, `*_from_string_field`, `*_add_field`, `month_code`,
`duration_sign`. Its seven exposing corpus programs were test262
`PlainDate/prototype/toString/calendarname-undefined.js`,
`PlainDate/from/argument-propertybag-calendar-string.js`, two
`PlainDate/prototype/{add,subtract}` rows,
`PlainTime/prototype/toString/roundingmode-wrong-type.js`,
`Duration/from/argument-string-fractional-units-rounding-mode.js` and
`Duration/prototype/toJSON/balance-subseconds.js`.

## Where the imports come from

All ten are emitted by ONE file, the #661 compile-time lowering
`src/codegen/temporal-native.ts`, through `ensureTemporalImport`. The linked
Temporal provider (#4628/#5353/#6748/#6882) never reaches them: a program whose
`Temporal` is a compiled binding (the provider prelude
`const Temporal = <getter>()`) stands the whole lowering down
(`temporalIsCompiledBinding`). So the gap is exactly the UNLINKED build — any
`compile()` of Temporal code without the provider, and every test262 row a
lane runs without a provider stamp.

| Import | Emitting site (`temporal-native.ts`, main @ 69d148815f) | Reached by |
| --- | --- | --- |
| `__temporal_plain_date_to_string` | `emitTemporalToString` | `PlainDate#toString/toJSON/toLocaleString` |
| `__temporal_plain_time_to_string` | `emitTemporalToString` | `PlainTime#toString/…` |
| `__temporal_duration_to_string` | `emitTemporalToString` | `Duration#toString/…` |
| `__temporal_plain_date_month_code` | `tryCompileTemporalPropertyAccess` | `date.monthCode` |
| `__temporal_duration_sign` | `tryCompileTemporalPropertyAccess` | `duration.sign` / `.blank` |
| `__temporal_plain_date_from_string_field` | `compilePlainDateLikeToLocals` → `compileParsedStringFieldsToLocals` | `PlainDate.from(x)` / `#equals(x)` for a non-literal `x` |
| `__temporal_plain_time_from_string_field` | `compilePlainTimeLikeToLocals` → same | `PlainTime.from(x)` / `#equals(x)` |
| `__temporal_duration_from_string_field` | `compileDurationLikeToLocals` → same | `Duration.from(x)`, `add/subtract(x)` on all three kinds |
| `__temporal_plain_date_add_field` | `emitPlainDateAddSubtract` | `PlainDate#add/subtract` |
| `__temporal_plain_time_add_field` | `emitPlainTimeAddSubtract` | `PlainTime#add/subtract` |

Per profile, before this change (probe `compile()` of
`new Temporal.PlainDate(2000, 5, 2).toString()`, main @ 69d148815f):

| Profile | Result |
| --- | --- |
| default `gc` (host-assisted, `wasm:js-string` strings) | `env::__temporal_*` import, satisfied by `runtime.ts` |
| `semanticProviders: "native-first"` | compile error: "rejected implicit or unclassified host imports: env::__temporal_plain_date_to_string (unknown, owner #4401)" |
| `--target standalone` | compiles WITH the `env::` import — uninstantiable; the test262 runner reports `compile_error … emitted host imports (#2961)` |
| `--target wasi` | no import at all: `ensureLateImport` declines on WASI, so the lowering's fallback silently returned `""` / `0` / a zero struct |

Local standalone lane, unlinked (`JS2WASM_TEST262_TEMPORAL_STANDALONE` unset,
`TEST262_PATH_FILTER=built-ins/Temporal/{PlainDate,PlainTime,Duration}/`):
266 rows compile-errored on one of these imports (counts by name in the
measurement section). In CI the standalone and native-first lanes LINK the
provider, so their published verdicts for the seven rows were already `pass`
(baseline `test262-standalone-current.jsonl`, 2026-10-16) — through the
polyfill, not through these helpers.

## Fix

Route by string representation, not by host availability: every build whose
strings are `$NativeString` (`ctx.nativeStrings` — native-first, standalone,
WASI, any explicit native-strings build) gets the ten helpers DEFINED IN THE
MODULE, registered in `ctx.funcMap` under the import names, so
`ensureLateImport` resolves the in-module function and no import is minted.
Same ABI (f64 fields in; parsers take the externref item and a field index),
except that a string result is the module's own `$NativeString`
(`emitTemporalToString` / `monthCode` now report `ref $AnyString` there).

New files under `src/codegen/temporal/`:

- `wasm-kit.ts` — helper definition (deps resolved before the own handle is
  minted), local frames, decimal output buffer, `days_from_civil` /
  `civil_from_days`, leap-year / days-in-month.
- `native-format.ts` — the three `to_string`s, `month_code`, `duration_sign`.
  Duration output balances seconds and sub-seconds into one `S` component
  (TemporalDurationToString), which `balance-subseconds.js` checks and the host
  helper does not do.
- `native-arith.ts` — the two `add_field` carries, with exact i64 day numbers
  and per-unit reduction instead of a JS `Date` and f64 nanoseconds.
- `native-parse-kit.ts` / `native-parse-iso.ts` / `native-parse-duration.ts` —
  the three string parsers and the bracketed-annotation validator, the grammar
  the host parser encodes as regular expressions, as a full match. Duration
  fields of a negative duration are +0, not -0, when absent.
- `native-helpers.ts` — the dispatch and the routing predicate. An unknown
  helper name throws "#7012: … has no in-module implementation" — a new host
  helper cannot silently become an import on a native-string build.

The host-assisted lane (default `gc` on main until #6708 flips it) keeps the
`runtime.ts` implementations: its strings are JS strings, which the in-module
helpers cannot read. Those registrations therefore stay in this PR — the
default lane's corpus (`tests/issue-661.test.ts`, the equivalence suite) still
reaches them. After #6708 the default build is native-strings, nothing reaches
them, and S7 (#6979) deletes `runtime.ts`'s `__temporal_*` block together with
the `ensureLateImport` arm of `ensureTemporalImport`; the S7-b `temporal-strings`
regime-gap family then has no exposing program and its probe asks to be closed.

## Acceptance

- [ ] zero `__temporal_*` imports on native-first, standalone and WASI for every
      operation, each result JS-equal to Node + the pinned
      `@js-temporal/polyfill` (`tests/issue-7012-regime-temporal-string-field.test.ts`)
- [ ] local standalone test262 subset (PlainDate/PlainTime/Duration) before/after
- [ ] equivalence gate: no new regressions
- [ ] `check:host-import-policy`, typecheck, Biome, ratchet gates
