---
id: 7012
title: "Regime gap: the #661 Temporal lowering's string/field helpers still import `env::__temporal_*` on native-string builds"
status: done
assignee: ttraenkler/opus-7012-temporal
created: 2026-10-16
updated: 2026-10-19
completed: 2026-10-19
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

The explicit host-assisted lane (`semanticProviders: "host-assisted"`) keeps
the `runtime.ts` implementations: its strings are JS strings, which the
in-module helpers cannot read. Since #6708 (merged while this was in flight) the
default `gc` build is the native-first regime and takes the in-module helpers;
only the explicit opt-in still reaches the host registration, so it is NOT
deleted here. S7 (#6979) deletes `runtime.ts`'s `__temporal_*` block together
with the `ensureLateImport` arm of `ensureTemporalImport` when it deletes that
lane; the S7-b `temporal-strings` regime-gap family then has no exposing
program and its probe asks to be closed.

The linked provider needed no new export: a bound `Temporal` stands the #661
lowering down entirely, so a linked program never reaches these helpers (CI's
standalone baseline of 2026-10-16 already reports all seven S7-b programs
`pass`, through the polyfill).

**Direct-AST freeze** (`plan/method/ir-only-development-freeze.md`): the new
behaviour lives in generated runtime helpers (`src/codegen/temporal/`). The
only edit to the #661 AST lowering is routing — `ensureTemporalImport` picks
the in-module helper instead of the import, and the two string-returning sites
report the module's string type. No new Temporal syntax or semantics is added
to the AST emitters.

## Measurements

- Local standalone lane, unlinked, `TEST262_PATH_FILTER=built-ins/Temporal/{PlainDate,PlainTime,Duration}/`
  (1,685 rows), interpreter eval engine:
  - before (main @ 69d148815f, 2026-10-16): 63 pass, 766 fail, 327
    compile_error (every one an `env::__temporal_*` "#2961 standalone target
    emitted host imports"), 529 compile_timeout (box load average 60-90).
  - after (branch merged with main @ #6708, 2026-10-19): 181 pass, 1,481 fail,
    0 compile_error, 23 compile_timeout. Zero rows carry a `__temporal_*`
    import. Flips: compile_error→pass 106, compile_error→fail 216,
    compile_timeout→pass 12, compile_timeout→fail 505, fail→compile_timeout 6,
    compile_error→compile_timeout 5; **pass→non-pass 0**. The before/after
    bases differ (main moved, and the box was far less loaded on the second
    run), so only the compile_error flips are attributable to this change.
  - The remaining failures are mostly `Temporal is not defined` (the
    unlinked lane has no `Temporal` value outside the three lowered classes)
    and TemporalHelpers rows that need the real polyfill — the linked lanes'
    job, not this lowering's.
- `tests/issue-7012-regime-temporal-string-field.test.ts`: 44 cases × {default
  gc, native-first, standalone, WASI} JS-equal to Node + the pinned polyfill,
  zero `__temporal_*` imports; explicit host-assisted keeps the import; a bound
  `Temporal` takes none. 1,027 extra parser field probes (`.tmp`) vs the
  polyfill: 0 differences.

## Acceptance

- [x] zero `__temporal_*` imports on native-first, standalone and WASI for every
      operation, each result JS-equal to Node + the pinned
      `@js-temporal/polyfill` (`tests/issue-7012-regime-temporal-string-field.test.ts`)
- [x] local standalone test262 subset (PlainDate/PlainTime/Duration) before/after — 63 → 181, 0 pass→non-pass
- [x] equivalence gate: no new regressions
- [x] `check:host-import-policy`, typecheck, Biome, ratchet gates
