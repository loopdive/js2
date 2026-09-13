---
id: 5408
title: "standalone: through the linked Temporal provider `Temporal.PlainDate.from(\"1976-11-18\")` throws and `PlainDate.from(date, options).year` is not a number, while `new Temporal.PlainDate(…)`, `.calendarId` and `PlainDate.compare` are all correct (124 `assert.sameValue` rows sit behind this class)"
status: in-progress
sprint: current
priority: medium
horizon: m
goal: standalone
reasoning_effort: high
assignee: ttraenkler/sendev-5383-s8
requested_by: ttraenkler/fable-lead
created: 2026-09-12
---

## Problem

With the compiled polyfill provider linked under `--target standalone`
(#5383), the direct constructor path is correct but two of `from`'s spellings
are not. Measured host-free through the shipped path
(`buildTemporalProvider` + `compileWithTemporalGlobal`,
`instantiateLinkedProject(result, {})`, empty import object —
`.tmp/s5-firstfail.mts`, 2026-09-12):

| probe | expected | measured |
| --- | --- | --- |
| `new Temporal.PlainDate(2024,1,1).calendarId === "iso8601"` | 1 | **1** ✓ |
| `typeof new Temporal.PlainDate(2024,1,1).calendarId === "string"` | 1 | **1** ✓ |
| `Temporal.PlainDate.compare(d1, d1)` | 0 | **0** ✓ |
| `String(new Temporal.PlainDate(2024,1,1))` | a string | **a string** ✓ |
| `Temporal.PlainDate.from("1976-11-18").day` | 18 | **throws** (`[object WebAssembly.Exception]`) |
| `Temporal.PlainDate.from(d, { overflow: "constrain" }).year` | 1 | **not a number** |

So the boundary itself is fine for this class — the defects are inside two
specific `from` paths.

In the S5 three-family sample (360 rows), **124 rows fail at an
`assert.sameValue` on a provider value**; `built-ins/Temporal/PlainDate/from/**`
alone is 68 of the 120 PlainDate rows sampled. Those rows currently report the
misleading `Object.prototype.toString is not yet implemented` text (#5406), so
the count attributable to *this* issue cannot be split out until #5406 lands —
but the two reductions above are unambiguous and are fixable now.

## Implementation Plan (sketch)

1. **`from(string)` first** — it throws, so it is the easier of the two to
   bisect. Instrument which polyfill function raises: the parse path
   (`ParseTemporalDateString` / the regexp) is the prime suspect and the
   standalone RegExp backend (#682) is the obvious difference from the host
   lane. Confirm by running the same probe with `--target gc` + the host
   provider, which is known green — if it passes there, the defect is
   standalone-lane, not Temporal.
2. **`from(date, options)`** — the object-argument path returns a
   non-number `.year`. Reduce to the smallest polyfill statement that
   reproduces it, the way every S2 slice of #5383 did (each of those
   root-caused one compiler defect from one reduced statement; none of them was
   a Temporal defect).
3. **Expect a compiler defect, not a polyfill defect.** Every prior stop in
   this stack — #5383 S2b through S2n — was ours: a struct-shape identity test,
   a scope-blind sidecar key, a `final` bit on a rec-group member, a `.pop()`
   that was a no-op in multi-module compiles. Budget accordingly.
4. Each reduction becomes a test in
   `tests/issue-5383-standalone-temporal-provider.test.ts` (or a sibling), and
   the two probes above become assertions in the S2 smoke harness
   (`tests/dogfood/temporal-s2-smoke-harness.mjs`), which already scores probes
   individually.

**Acceptance:** both probes answer correctly host-free; the S5 PlainDate sample
is re-run and the `assert.sameValue` sub-bucket count is reported (it should
drop, and if it does not, that is itself the finding).

## Notes

- Found by #5383 S5. Do not confuse with #5406 (the boundary/identity class,
  which masks this one in the reported error text) or #5407 (compile cost).
- Artifacts: `.tmp/s5-firstfail.out`, `.tmp/pd-link.tsv`.

## S8 update (2026-09-12) — the `from(string)` half is FIXED; the residual is NOT RegExp

Step 1 of the plan above was right about the suspect and right about the lane:
the `from(string)` throw was the standalone RegExp backend refusing the
polyfill's composed ISO parsers. **#5404 fixed it** (the composition fold; see
that issue's "Resolution" for the census and the mechanism).

### What moved, measured

Same probe script the table above was measured with (`.tmp/s8/s8-firstfail.mts`,
a copy of `.tmp/s5-firstfail.mts`), host-free through
`buildTemporalProvider` + `compileWithTemporalGlobal` + `instantiateLinkedProject(result, {})`
with an empty import object:

| probe | S5 | S8 |
| --- | --- | --- |
| `Temporal.PlainDate.from("1976-11-18")` | **throws** (`[object WebAssembly.Exception]`) | **returns, no throw** |
| …`.day` | (unreachable) | still not a number |
| `Temporal.PlainDate.from(d, { overflow })`.`year` | not a number | still not a number |
| `new Temporal.PlainDate(1976,11,18).day` | 18 ✓ | 18 ✓ |

And in the three-family sample (#5383 S8), `built-ins/Temporal/PlainDate/from/**`
went **7 pass → 19 pass** while its `Unsupported dynamic regular expression
pattern` bucket went **4 → 0**. Family-wide the whole PlainDate sample went
17 → 51 and the bucket went 16 → 0. Nothing regressed.

### The residual, attributed

`from("1976-11-18")` now returns an **object that is not a `Temporal.PlainDate`**:
`typeof d === "object"` but `typeof d.constructor !== "function"`, and
`d.toString()` is the 15-character `"[object Object]"` (measured by char code,
`.tmp/s8/s8-from2.mts`) — whereas the direct constructor's `toString()` is a
29-character real ISO string. So the parse succeeds and the *construction* of
the result is what is wrong.

**That is the #5406 class, not this one.** The evidence: `from({year, month,
day})` — which touches no RegExp at all — **also fails** on the same probe (it
throws), and the residual failure texts under `PlainDate/from/**` are now
`calendar must be string in canonicalizeCalendarEra` (20), `Expected a
RangeError but got a undefined` (4), `map callbackfn is not a function` (4) —
i.e. the calendar/identity buckets #5383 S7 already named, with no
RegExp text left.

**What remains for #5408**, therefore, is the SECOND row of the original table
(`from(date, options).year` is not a number) plus the newly-exposed
`from(string)` result-construction defect — and the measurement above says both
are the *same* defect, reached by two entry points, sitting in the object the
provider hands back rather than in `from`'s parsing. The next slice should
attack it as one item and should read #5406 first; splitting it by entry point
would re-measure the same root cause twice.

**Not RegExp-related** (this is the answer to the question the S8 brief asked):
the `from(d, {overflow})` half never went through the regexps, was unaffected by
#5404, and is unchanged.
