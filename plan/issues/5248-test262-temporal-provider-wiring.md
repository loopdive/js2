---
id: 5248
title: "Wire the test262 runner to the compiled Temporal provider (#4628 acceptance criterion 2)"
status: done
completed: 2026-08-31
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: test262, tooling
language_feature: temporal
goal: core-semantics
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/dev-5248b
created: 2026-08-31
depends_on: [4628, 5226]
related: [5221, 5223, 5227, 5245, 5247]
---

# #5248 — wire the test262 runner to the compiled `Temporal` provider

> Id reserved with a degraded PR scan; manually checked against open PR head
> branches 2026-08-31.

## Problem

[#4628](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4628-temporal-runtime-object-spike)
built the compile-once `Temporal` provider — `src/temporal-provider.ts`,
`buildTemporalProvider` + `compileWithTemporalGlobal` — and proved a user
program observes a real `Temporal` object. It explicitly did **not** wire the
test262 runner, and said so in its own "Not done in this PR" list:

> **The test262 runner is NOT wired to the provider.** That is where the 1,589
> `Temporal is not defined` rows live […] the wiring itself is now a small
> change: `referencesTemporal(source)` → `compileWithTemporalGlobal(...)` →
> `instantiateLinkedProject(...)`.

So #4628's acceptance criterion 2 — "the 2,206 `Temporal is not defined` rows no
longer carry that error" (1,589 after #4627 landed) — was left unmet. This issue
is that wiring.

## What was built

| Piece | Where |
| --- | --- |
| Provider resolution + scope gate + compile routing | `tests/test262-runner.ts` |
| Linked-provider instantiation, in the ONE shared finaliser | `scripts/test262-import-object.mjs` |
| Prelude made valid in JavaScript, not just TypeScript | `src/temporal-provider.ts` |

### The gate is the PATH, not `referencesTemporal`

`src/temporal-provider.ts` ships `referencesTemporal(source)`, and #4628's own
note named it as the wiring's trigger. It is the wrong gate **here**, and its
doc comment says why in the other direction: it is deliberately loose — "any
`Temporal` identifier occurrence, including inside a string, opts in" — because
for a user-facing API a false positive is a harmless unused binding and a false
negative silently keeps the broken behaviour.

In this lane the asymmetry inverts. A false positive is not free: it puts a
non-Temporal test on the linked path and makes it pay a ~2 MB provider
instantiation for a binding it never reads. And a stray mention is common —
`assembleOriginalHarness` concatenates the upstream harness into every test, and
several test bodies mention `Temporal` only in a comment or an assertion
message. So the runner gates on what the test *is*, not what its text contains:

```ts
if (/[\\/]Temporal[\\/]/.test(filePath)) return true;
return meta.features?.includes("Temporal") === true;
```

Path OR `features:`, because neither alone is complete. `built-ins/Temporal/**`
(4,603 files) and `intl402/Temporal/**` (2,029) are the bulk; the 8
`built-ins/Date/prototype/toTemporalInstant/**` rows do **not** match the path
pattern (`toTemporalInstant` has no path separator before `Temporal`) and are
reached only through `features:`.

### The prelude was TypeScript-only, and every test262 row is `.js`

`temporalPrelude` emitted `const Temporal: any = <getter>();`. That is a syntax
error in a JavaScript entry file, and test262 rows compile as `.js` under
`allowJs`. **All five probe rows came back
`compile_error: Type annotations can only be used in TypeScript files`** — a
100 % failure that the dogfood harness could not have caught, because its probes
are the only other consumer and it never inspected a diagnostic on this path.

The annotation was never doing work: the stub declares the getter as returning
`any`, so the binding's inferred type is `any` with or without it. Dropped. The
invariant to keep is that the prelude is valid in **both** dialects — this is a
general service and its two consumers disagree about the entry's extension.

### Instantiation goes in the shared finaliser, not the lane

#4162 established the rule that no test262 lane calls `WebAssembly.instantiate`
on a test binary itself — `tests/issue-4162.test.ts` fails the build if one
grows its own — because a namespace supplied to one lane and not another
**overwrites the test's real error signature with an instantiation artifact**.
A linked provider is exactly such a namespace, so the provider lifecycle
(`instantiateLinkedProviders` before, `wireCompiledInstance` after) went into
`scripts/test262-import-object.mjs` behind a new `linkedModules` option rather
than into `runOriginalHarnessVariant`.

That import is **dynamic** and reached only when a lane actually supplies
`linkedModules`. `scripts/test262-worker.mjs` runs against the prebuilt
`scripts/compiler-bundle.mjs` with no TypeScript loader, so a static `src/`
import there would break the sharded lane at load time.

### The baseline VALIDATOR had to opt out, or it reports drift that isn't there

`scripts/validate-test262-baseline.ts` — the per-PR spot-check that re-runs 50
random baseline-**passing** rows — imports `runTest262File`, i.e. the lane this
issue just wired. The baseline it checks them against is written by the lane
that is **not** wired. So without a guard, a Temporal row that passes in the
baseline *for want of a `Temporal` binding* fails in the validator and is
reported as baseline drift.

That is not hypothetical arithmetic on this PR alone: it would fire on **every
future PR**, at roughly a 10 % rate per run (of the sampled bucket's 81 baseline
passes, 10 flip = 12 %; Temporal passes are ~1.8 % of all passes; 50 samples),
and `test262-baseline-validate` is a **non-required** check — a red one drives
`mergeStateStatus` to `UNSTABLE`, which `auto-enqueue` skips **silently and
indefinitely** (#3878/#3904). An intermittent, repo-wide enqueue stall is a much
worse failure than the one this wiring fixes.

The validator therefore defaults `JS2WASM_TEST262_TEMPORAL=0` (overridable with
`=1`, for the run that checks the lanes have converged). Sampling a lane the
baseline was never measured on is a false positive, not a finding. The runner's
opt-out is read **lazily** for this to work at all: ESM imports are hoisted, so
a module-scope `const` would capture the unset value and drop the opt-out
without a word.

## Measured

Sampled bucket: 838 rows (the deterministic Temporal sample in
`.tmp/temporal-sample.txt`), same list both sides, one row per line, run through
`runTest262File` — the same entry point every ad-hoc A/B, the vacuity detector
and the baseline validator use.

| | rows | pass | fail | compile_error |
| --- | --- | --- | --- | --- |
| base (provider off) | 838 | 81 | 757 | 0 |
| after (provider linked) | 838 | 262 | 575 | 1 |

**`Temporal is not defined` rows: 360 → 0.** That is acceptance criterion 2 for
this lane, met exactly.

Net **+181 pass** on the sample (**+191 gains, −10 regressions**, all ten triaged
below as wrong-reason base passes). Extrapolating the sample's rate to the full
~6,640-row Temporal bucket is NOT done here — the sample was drawn to be
diverse, not proportional, and the bucket's un-sampled remainder is dominated by
families this run shows failing (`HelperBase_adjustCalendarDate`, 123 rows in
the sample alone).

**Provider provenance (#5227).** The confirming run built the provider **cold in
this tree** — `cacheHit=false, 52,400 ms`, into an empty cache dir — so nothing
here rests on a binary some other compiler left in `/tmp`. The predecessor run
that produced the identical row counts read a warm cache (`cacheHit=true,
854 ms`); both produce the same 2,025,988-byte artifact
(`js2wasm:npm:@js-temporal/polyfill:69813bed8b9e64dd`), which is what
content-addressing is for. Cold build ~52 s **once per process**, then ~0.9 s.

**Per-row overhead (criterion 3).** Compile dominates and the linked provider
roughly doubles it; instantiation of the 2 MB provider is the small part:

| | per row |
| --- | --- |
| base compile | 1,626 ms |
| base instantiate | 11.2 ms |
| after compile | 3,218 ms — **upper bound**, see caveat |
| after instantiate | 491 ms |

The instantiate figure is the honest one and it is the wiring's real per-row
price: linking a 2 MB provider costs ~480 ms per row, ~44× the bare
instantiation. The compile figure is an **upper bound, not a clean delta** —
the after run shared a 4-core box with two other agents' compiles while the base
run did not, so an unknown part of 1,626 → 3,218 ms is contention rather than
the extra compile unit. Stated rather than quietly averaged away; a clean
compile-cost number needs an uncontended box and is not claimed here.

**Two independent runs agree row-for-row.** The confirming run (cold provider
build in this tree) and the predecessor's (warm cache) produce identical status
for **838/838 rows** — same 262/575/1 split, same 10 regressions, same 191
gains. A conformance delta reproduced across a cold build and a cache read on
two different processes is not a fluke of one artifact.

**The gains were checked for vacuity too**, since this issue's whole regression
story is "a pass can be worthless". `scripts/detect-vacuity.ts --files` on 8 of
the 191 gained rows, provider ON: **0 vacuous, 8/8 probe flips** (the injected
failure bit, i.e. the bodies ran to completion), all three of the detector's
controls holding. Bound: 8 of 191 sampled, so this rules out a *systemic*
vacuous-gain mode, not every individual row.

## Regression triage — all 10 are wrong-reason base passes

The hypothesis was that these rows previously passed *because* `Temporal` was
missing. It is not an inference; the mechanism was probed directly. With no
`Temporal` binding, the compiler does **not** throw on the member access:

```
new Temporal.ZonedDateTime(0n, "UTC")   →  an object (typeof "object"), no throw
  .since(…)                              →  TypeError
Temporal.PlainTime.from("…")             →  an object, no throw
  .toLocaleString("en-US")               →  a string
new Temporal.PlainDateTime(…).yearOfWeek →  undefined
```

(`.tmp/probe/zdt-shape.js`, `.tmp/probe/from-shape.js`, run with
`JS2WASM_TEST262_TEMPORAL=0`.) So every `assert.throws(TypeError, () =>
instance.method(…))` row is satisfied by *calling a method on a bogus object*,
and `assert.sameValue(…yearOfWeek, undefined)` is satisfied by the degenerate
`undefined`. Eight of the ten are the first shape, one is the second.

All ten were re-confirmed passing with the provider disabled, so the flip is the
provider's presence and nothing else in the branch.

| rows | base passed because | after fails on | verdict |
| --- | --- | --- | --- |
| 7 × `ZonedDateTime/prototype/{since,until,with,withCalendar}` | TypeError from a method call on a non-Temporal object satisfied `assert.throws(TypeError)` | `TypeError: Cannot destructure 'null' or 'undefined' in ZonedDateTime_init()` at module init | wrong-reason pass; the after-failure is ONE pre-existing defect (#5221/#5243 family), reproducible in a 3-line probe: `new Temporal.ZonedDateTime(0n, "UTC")` throws it with the provider linked, while the same pinned polyfill in node returns `1970-01-01T00:00:00+00:00[UTC]` |
| `PlainYearMonth/prototype/until/arguments-missing-throws` | same shape | `Expected a TypeError but got a RangeError` | wrong-reason pass; the after-failure is REAL and NEW — node on the same polyfill throws `TypeError: Either month or monthCode are required`, so our RangeError is a js2wasm deviation, not a polyfill/spec mismatch. Needs its own issue |
| `intl402/…/PlainDateTime/prototype/yearOfWeek/non-iso-week-of-year` | `undefined === undefined` on a degenerate value | `RangeError: Invalid ISO date: 2024-01-01T00:00Z` | wrong-reason pass; node returns `undefined` for every non-ISO calendar, so the RangeError is ours (`HelperBase_getCalendarParts`, 5 rows in the sample) |
| `intl402/…/PlainTime/prototype/toLocaleString/ignore-timezone` | `toLocaleString` on a bogus object returned a string, and the test compares two of them | `TypeError: invalid receiver: method called with the wrong type of this-object` | wrong-reason pass; the after-failure is the `invalid receiver` family (51 rows in the sample), #5223-adjacent |

**None is wiring-induced.** The wiring supplies a binding; every after-failure is
the compiled polyfill's own code failing on a js2wasm gap that was unreachable
while the binding did not exist. The distinction that matters for the merge gate
is below; the distinction that matters for the backlog is that these are OUR
bugs, not the polyfill's — checked against node running the same pinned tarball.

**The 1 `compile_error` is NOT a regression**: `intl402/Temporal/ZonedDateTime/
prototype/toString/calendarname-never.js` was already failing in base (`Cannot
read properties of null`) and now refuses to compile with `Dynamic new K(...x)
runtime-argv needs the up-front-reserved $ObjVecArr type (#2026 #53)`. A
fail→compile_error move, i.e. the same row still not passing, with a sharper
reason.

## Merge-gate posture — CI sees none of this

The `#3467` per-SHA regression diff in the `merge_group` compares reports
produced by `scripts/test262-worker.mjs`. That worker imports
`instantiateTest262Module` but never passes `linkedModules`, and never touches
`runTest262File`, so it takes the pre-#5248 path byte-for-byte. **The ten flips
are invisible to CI, as are the 191 gains.** No accepted-regressions mechanism is
needed, and none exists to be gamed: the regression gate has no allowlist, which
is correct.

The >10-regressions escalation rule is therefore not triggered — there are 10 by
the local count and 0 by the gate's. Recorded here rather than routed as an
escalation, and named in the PR body so a reviewer does not have to rediscover
which lane produced which number.

## NOT done — the sharded CI lane is still unwired

**State this before any conformance claim: the number CI publishes will not move
from this PR.** The committed baseline JSONL is produced exclusively by
`scripts/test262-worker.mjs` (the sharded fork worker), and that lane is **not**
wired here. Everything measured in this issue is the in-process
`runTest262File` lane — the one `scripts/validate-test262-baseline.ts`,
`scripts/detect-vacuity.ts`, `scripts/harness-flip-probe.ts` and every ad-hoc
A/B use.

Two concrete blockers, both real, neither hidden:

1. **The worker imports the compiler as a prebuilt bundle.**
   `scripts/compiler-bundle-entry.ts` re-exports `src/index.ts` only, so
   `buildTemporalProvider` / `compileWithTemporalGlobal` are not reachable from
   `./compiler-bundle.mjs`. Two lines of re-export fix that, and the polyfill
   acquisition module (`tests/dogfood/setup-temporal-polyfill.mjs`) is plain
   `.mjs`, so it is importable from the worker as-is.
2. **The cold provider build is ~42 s and the fork pool kills jobs well inside
   that.** `scripts/test262-import-object.mjs` already carries the warning in
   its own comment — "Never compile the provider here: the real one takes
   minutes and the fork pool kills jobs at 30s". The fix is not a longer
   timeout; it is for the SHARD PARENT to pre-warm the content-addressed disk
   cache once (~42 s per shard job, against a ~19-minute job) so each fork's
   `buildTemporalProvider` is the measured 0.75 s cache read.

This is a deliberate scope cut, not an oversight: the wiring, the gate, the
prelude fix and the shared-finaliser seam are all lane-independent, so the
follow-up is the two items above plus a re-measurement, not a redesign.

## Residual failures are somebody else's issues

The rows stop saying `Temporal is not defined` and start failing on substance —
which is the predicted and desired outcome, and is why criterion 3 (net-positive
delta) is measured separately from criterion 2. The new top error patterns are
recorded below as a follow-up worklist. Known owners already filed:
`total`/`round` (#5245), `Temporal.Now.*` (#5221 / #5206),
`Symbol.toStringTag` (#5223 family), uncaught provider throws reaching the host
as a bare `WebAssembly.Exception` (#5247).

Top after-side patterns over the 838-row sample (counts are of that sample, not
of the bucket — the bucket is ~8× larger and NOT proportionally represented):

| rows | pattern | note |
| --- | --- | --- |
| 123 | `RuntimeError: unreachable in HelperBase_adjustCalendarDate()` | the single biggest residual; no issue filed yet |
| 74 | `TypeError: Cannot destructure 'null' or 'undefined' in ZonedDateTime_init()` | #5221 / #5243 family; the 7 regressions above are this |
| 43 | `RangeError: invalid number value` | unfiled |
| 51 | `TypeError: invalid receiver: method called with the wrong type of this-object` (35 in `vt()` + 16 bare) | #5223-adjacent |
| 29 | `RuntimeError: illegal cast in HebrewHelper_minMaxMonthLength()` | unfiled |
| 11 | `Error: Convert JSBI instances to native numbers using \`toNumber\`` | JSBI seam, unfiled |
| 10 | `TypeError: year or eraYear is required in HelperBase_validateCalendarDate()` | unfiled |
| 5 | `RangeError: Invalid ISO date … in HelperBase_getCalendarParts()` | the non-ISO-calendar regression above |
| 4 | `Expected a TypeError but got a RangeError` | error-type deviation; the PlainYearMonth regression above |

Nothing in this list is a *new* defect introduced by the wiring — each is code
in the compiled polyfill that no test could reach while `Temporal` was unbound.
Filing them individually is the follow-up worklist, not this PR's scope.

## Not fixed here, with bounds

* **The sharded lane** (above). Bound: CI's published conformance number does
  not move by a single row from this PR.
* **The three regression families the triage names as ours, not the polyfill's**
  — `ZonedDateTime_init` destructure-null, `PlainYearMonth.until` TypeError→
  RangeError, non-ISO `yearOfWeek` RangeError. Bound: 10 rows of the 838
  sampled; the first family is 74 rows of the sample counting non-regressions.
* **The `$ObjVecArr` compile refusal** on dynamic `new K(...x)` (#2026 #53).
  Bound: 1 row of 838, and it was already failing.
* **The residual worklist above.** Bound: it is a *sample* census; no
  bucket-wide count is claimed, because the sample was not drawn to be
  proportional.

## Acceptance criteria

1. Temporal-bucket rows no longer report `Temporal is not defined` in the
   in-process runner lane. ✅ 360 → 0 on the sampled bucket.
2. Net-positive pass delta on the measured sample, with no previously-passing
   row regressed. ✅ net **+181** (81 → 262). ⚠️ **Ten previously-passing rows
   do flip** — every one of them triaged above as a pass that depended on
   `Temporal` being absent, with the mechanism probed rather than assumed. The
   criterion's literal "no row regressed" is not met and is not claimed; the
   honest reading is that ten vacuous passes were exchanged for ten honest
   failures, which is the same trade the +191 gains sit on.
3. Per-test overhead of the wiring measured and stated. ✅ table above.
4. The lane that is NOT wired is named explicitly, with its blockers. ✅ above.
