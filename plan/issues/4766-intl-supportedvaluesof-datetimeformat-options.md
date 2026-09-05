---
id: 4766
title: "Intl.supportedValuesOf missing and DateTimeFormat drops hourCycle/timeStyle (found off-lane; intl402 is not in TEST_CATEGORIES)"
status: ready
created: 2026-08-26
updated: 2026-08-26
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime
language_feature: intl
goal: spec-completeness
sprint: Backlog
horizon: xl
---

# #4766 — `Intl.supportedValuesOf` and `DateTimeFormat` option resolution

## Status: NOT counted by any conformance number today

`intl402` is absent from `TEST_CATEGORIES` in `tests/test262-runner.ts`, so the
sharded runner never walks it and these rows appear in no dashboard bucket. They
surfaced only because a one-off ES2016 measurement (2026-08-26) selected files
by `features:` tag and ran them directly through `runTest262File`, bypassing the
category walk.

That is also why this is **not** an ES2016 blocker, despite the tag: these files
carry `features: [Array.prototype.includes]` because their *assertion bodies*
call `.includes()` (`assert(numberingSystems.includes(ns))`), not because they
test an ES2016 feature. Filed so the finding is not lost, at Backlog priority —
turning it into real conformance movement means adding `intl402` to
`TEST_CATEGORIES` first, which is a separate decision with its own cost (it adds
several thousand mostly-failing rows to every shard).

## Problem

Measured with `runTest262File` at the pinned submodule SHA
`b363f29d3c43c626dc852744ad64a0b48a003693`. 21 rows, two gaps.

**1. `Intl.supportedValuesOf` does not exist** (16 rows), all the same shape:

```
intl402/Intl/supportedValuesOf/calendars.js
  TypeError: Cannot read properties of null (reading 'supportedValuesOf')
```

`calendars`, `calendars-accepted-by-DateTimeFormat`,
`calendars-accepted-by-DisplayNames`, `collations`,
`collations-accepted-by-Collator`, `currencies-accepted-by-DisplayNames`,
`numberingSystems-accepted-by-{DateTimeFormat,NumberFormat,RelativeTimeFormat}`,
`numberingSystems-with-simple-digit-mappings`, `units`,
`units-accepted-by-NumberFormat`, plus
`Locale/prototype/{getCollations,getHourCycles}/output-array-values`,
`PluralRules/prototype/resolvedOptions/pluralCategories`,
`Segmenter/constructor/constructor/locales-valid`.

These are **not** satisfiable by returning a plausible list. Each row
cross-checks that every returned value is actually accepted by the constructor
it names — `supportedValuesOf("calendar")` entries must each work as
`new Intl.DateTimeFormat(l, {calendar})` and be echoed back by
`resolvedOptions()`. The list and the constructors have to agree.

**2. `DateTimeFormat` option resolution is incomplete** (5 rows):

```
resolvedOptions/hourCycle.js            Expected SameValue(«undefined», «"h11"»)
resolvedOptions/hourCycle-timeStyle.js  Should support timeStyle=full — «undefined» vs «"full"»
format/related-year-zh.js               TypeError: Cannot read properties of null (reading 'format')
format/timedatestyle-en.js              TypeError: … (reading 'format')
formatToParts/main.js                   TypeError: … (reading 'format')
```

`resolvedOptions()` drops `hourCycle` / `timeStyle`; the `null` `format`
failures suggest some option combinations abort construction outright rather
than merely omitting a property.

## Implementation Plan

1. **Decide whether to run `intl402` at all.** Nothing here changes a published
   number until `TEST_CATEGORIES` includes it. Measure the full intl402 pass
   rate first (the same one-off harness works) so the decision is made against a
   real figure rather than a guess.
2. **`Intl.supportedValuesOf`** (ECMA-402): host-backed in JS-host mode
   (delegate to the host `Intl`, which already has correct lists), with an
   explicit standalone answer. Per the dual-mode rule in CLAUDE.md a host import
   needs a standalone story — here that means a curated frozen list the
   standalone constructors genuinely accept, or a documented `wont-fix` for
   standalone. Do not let it fall through to a host-only import.
3. **`DateTimeFormat` `hourCycle` / `timeStyle`**: thread both through
   construction into `resolvedOptions()`. Read the existing `DateTimeFormat`
   shim in `src/runtime.ts` first — the `null`-`format` rows point at
   construction aborting, which is a different defect from a missing property
   and may be the cheaper half.
4. Re-measure after each step. Do not infer row counts from baseline error
   strings — they go stale and mis-bucket (that mistake cost two wrong
   diagnoses on #4764).

## Acceptance criteria

- [ ] intl402 pass rate measured, and the run-it-or-not decision recorded here
- [ ] `Intl.supportedValuesOf` exists and every value it returns is accepted by
      the constructor the corresponding row names
- [ ] `resolvedOptions()` reports `hourCycle` and `timeStyle`
- [ ] Standalone behaviour explicitly decided and documented
