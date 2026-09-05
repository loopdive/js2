---
id: 5250
title: "Compiled Temporal throws the wrong error where node's polyfill matches spec: PlainYearMonth.until missing-args RangeError (spec: TypeError) and non-ISO yearOfWeek RangeError (spec: undefined)"
status: done
completed: 2026-09-05
assignee: ttraenkler/dev-5250
sprint: current
priority: medium
horizon: s
goal: error-model
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
# 2026-09-05 (#5250): +16 lines in src/runtime.ts. `_resolveHostField` lives in
# this file and the guard is 6 lines of code plus the comment that names the
# measurement; extracting a 6-line predicate into src/runtime/ would need
# `_structOwnFieldStatus` threaded out with it, which is a larger change than
# the fix. Comment already trimmed to a pointer at the test file.
loc-budget-allow:
  - src/runtime.ts
---

# #5250 — Temporal error-semantics mismatches vs the same polyfill in node

## Problem

Two small families where the COMPILED `@js-temporal/polyfill@0.5.1` diverges
from the SAME pinned polyfill running natively in node — so the defect is
ours, by measurement (dev-5248b probed both against node during #5248 triage):

1. **`Temporal.PlainYearMonth.prototype.until()` with missing arguments**
   throws **RangeError** compiled; node throws
   `TypeError: Either month or monthCode are required`. Test262
   `…/PlainYearMonth/prototype/until/arguments-missing-throws` asserts
   TypeError.
2. **`yearOfWeek`/week-of-year on non-ISO calendars** throws
   `RangeError: Invalid ISO date` compiled; node returns **`undefined`** for
   every non-ISO calendar (`intl402/…/yearOfWeek/non-iso-week-of-year`).

Both surfaced as "regressions" in PR #5375's 838-row sample — they were
wrong-reason passes before the provider existed (a bogus object's method call
happened to satisfy `assert.throws`), and are now honest failures.

## Direction

Likely one root each: (1) an error-construction path where the compiled
polyfill's argument-shape check falls into a range-check branch — probe which
check misfires (plausibly the same undefined-vs-missing-property distinction
as the #5221/#5243 record-nulling family); (2) a calendar-dispatch path where
the non-ISO branch is not taken compiled, so the ISO validator runs instead.

## Implementation Plan (Fable, 2026-09-05)

1. `PlainYearMonth.prototype.until()` missing args: node throws
   `TypeError: Either month or monthCode are required`; the compiled build
   throws RangeError first. Probe `Temporal.PlainYearMonth.from({year:2000,
   month:1}).until()` compiled vs node; capture the compiled stack. Likely
   root: the polyfill's argument-shape check reads `undefined` vs
   missing-property differently through a bridged record (#5243 lineage —
   `buildRecordFromExternref` may materialise absent fields as present
   `undefined`, so `"month" in obj` answers true). Fix at the record bridge
   (presence must survive), not in the polyfill.
2. Non-ISO `yearOfWeek` returns `undefined` in node; compiled throws
   `RangeError: Invalid ISO date`. Probe which branch runs: the polyfill
   dispatches on calendar id; if the ISO validator runs for a non-ISO
   calendar, an open-receiver call may be statically bound (#5352) — check
   after #5352 lands before fixing anything here.
3. Reductions in `tests/issue-5250-*.test.ts`, base-failing; both named
   test262 rows pass with the provider linked.

## Acceptance criteria

1. Base-failing reductions for both (compiled vs node on the pinned
   polyfill); fixed so compiled matches node.
2. The two named test262 rows pass with the provider linked
   (`JS2WASM_TEST262_TEMPORAL` lane); no provider-family regressions; gates
   green.

## Notes

- Filed from PR #5375's regression-triage table (dev-5248b).
- Id reserved with a degraded open-PR scan; manually checked against open PR
  head branches 2026-08-31.

## Implementation notes (dev-5250, 2026-09-05)

### Part 1 — FIXED. Root cause: a numeric `__sget_<name>` shape-miss reads as `0`, not absent

`src/runtime.ts` `_resolveHostField` (the resolver behind the `_wrapForHost`
host proxy's `get`/`has` traps, reached from the `extern_get` intent).

`__sget_<name>` is a per-shape `ref.test` dispatch ladder that never traps: for
a receiver whose own shape lacks the field it falls through to a
zero-initialized result. For a ref-typed field that is `null`, and this
resolver has consulted the field-name registry before believing a `null` since
#3051. For a NUMERIC field the fall-through is `0`, which is not nullish, so it
was returned as a real value unconditionally.

The getter is module-GLOBAL, so an unrelated shape elsewhere in the same
program triggers it. Measured through the Temporal provider
(`JS2WASM_TEST262_TEMPORAL=1`), one literal changed and nothing else — the
receiver under test is always `{ year: 1994 }`:

| second literal in the module | `jun13.until({ year: 1994 })` throws |
| --- | --- |
| (none) | `TypeError: Either month or monthCode are required` (= node) |
| `{ month: 11 }` | `RangeError: Cannot convert a number less than one to a positive integer` |
| `{ month: 11, day: 2 }` | same RangeError |
| `{ zzz: 11 }` | `TypeError: Either month or monthCode are required` (= node) |
| `{ monthCode: "M11" }` | `TypeError: Either month or monthCode are required` (= node) |

`{ zzz: 11 }` lowers to the SAME WasmGC struct type as `{ month: 11 }` (WasmGC
types are structural; field names are compiler-side only) and does NOT
reproduce — so this is a getter-NAME collision, not structural type confusion,
which is what makes the field-name registry the right gate. A second literal
in an *uncalled* arrow reproduces too, i.e. the trigger is compile-time
emission of `__sget_month`, not execution order.

Confirmed by direct instrumentation (a temporary `__sget_month` spy on the
consumer's exports, reverted): `__sget_month(<{year:1994}>) -> 0`, called from
`_resolveHostField` → `safeGetField` → the host proxy's `has` and `get` traps.
The consumer's own `__struct_field_names` was CORRECT throughout
(`{year:1994}` → `"year"`, `{month:11}` → `"month"`), so this is not a #5225
cross-module decoder miss.

**Fix.** Gate a `0` / `false` hit on `_structOwnFieldStatus` (the #3673
single-key registry probe) and only when it can positively say the field is
absent; every other read, including a receiver whose shape cannot be named,
keeps its previous cost and answer. Cost: one extra `__struct_field_names`
Wasm call (CSV split cached) on reads that yield `0`/`false` on this resolver
— not on `_safeGet`, which was already gated.

The `false` arm is defensive, not measured: a boolean-only collider does not
reproduce. Every observed case was the numeric `0`.

Not fixed, same shape one block down: the symbol-keyed `__sget_@@<name>` hit at
the `_symbolToWasm` fallback in the same function believes a non-nullish value
the same way. Left alone — unmeasured, and out of this issue's bound.

**Result.** `built-ins/Temporal/PlainYearMonth/prototype/until/arguments-missing-throws.js`
**fail → pass**, and its sibling `.../since/arguments-missing-throws.js`
**fail → pass** (same root, not separately targeted).

### Part 2 — NOT this issue's defect. Reported, not fixed; attributed with evidence

The issue's premise ("node returns `undefined` for every non-ISO calendar") is
**wrong on this pin**. `@js-temporal/polyfill@0.5.1` run natively in node,
`new Temporal.PlainDate(2024, 1, 1, cal).yearOfWeek`, all 15 calendars the
test262 row iterates:

| calendar | node |
| --- | --- |
| buddhist, ethioaa, hebrew, indian, islamic-civil, islamic-tbla, islamic-umalqura, japanese, persian, roc | `undefined` |
| chinese, dangi | `RangeError: Unexpected leap month suffix: Mo11` |
| coptic, ethiopic | `RangeError: Era am (…) was not matched by any era` |
| gregory | `2024` |

The row asserts `undefined` for every one of them, so **the pinned polyfill
fails it in node** — it is a polyfill/ICU gap, not a compiled-vs-node
mismatch, and it cannot be made to pass by fixing the compiler.

The compiled side does diverge from node, but not via #5352's static bind. The
route is `Intl.DateTimeFormat`, measured directly in a compiled program with no
Temporal involved:

```
typeof Intl                                    object
typeof Intl.DateTimeFormat                     function
typeof new Intl.DateTimeFormat("en-US").formatToParts   function
new Intl.DateTimeFormat("en-US").resolvedOptions()      undefined  (node: an object)
new Intl.DateTimeFormat("en-US", {timeZone:"UTC"}).format(d)         undefined  (node: "1/1/2024")
new Intl.DateTimeFormat("en-US", {timeZone:"UTC"}).formatToParts(d)  RuntimeError: dereferencing a null pointer
```

The polyfill's non-ISO calendar helper wraps `formatToParts` in
`try { … } catch { throw new RangeError(\`Invalid ISO date: ${e}\`) }` — that
catch is where the reported `RangeError: Invalid ISO date` is minted. The trap
is a Wasm trap, so a compiled `try/catch` around it cannot recover either.

**Bound.** `Intl.DateTimeFormat` is a shell: `format` and `resolvedOptions`
answer `undefined`, `formatToParts` traps. That is the #5206 Intl family, not
#5352 and not #5250. The four `non-iso-week-of-year` rows
(`PlainDate`/`PlainDateTime` × `yearOfWeek`/`weekOfYear`, plus
`ZonedDateTime`'s, which fails earlier still on `unknown time zone UTC`) stay
`fail`, unchanged by this PR.
