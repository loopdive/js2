---
id: 3628
title: "≤ES3 edition: close the remaining 43 host-lane failures (230/273 → 273/273)"
status: done
completed: 2026-07-31
sprint: 78
created: 2026-07-25
updated: 2026-08-18
assignee: ttraenkler/dev-es3-editions
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen, conformance
language_feature: core-semantics
es_edition: es3
goal: spec-completeness
related: [3486, 2899, 2900]
origin: "2026-07-25 lead measurement: ES3 is the oldest edition and the closest to complete; the remaining gap is 3 issues, not a feature list."
loc-budget-allow:
  - src/codegen/dyn-read.ts
  - src/codegen/expressions/assignment.ts
---

# #3628 — ≤ES3 edition: close the remaining 43 host-lane failures

> **CLOSED BY MEASUREMENT, 2026-07-31 — the bucket is 273/273, 0 fail, 0 CE.**
> No code was written for this issue. All four owning defects landed
> independently (#3486, #2666 via PR #3741, #2899, #2900) and the last of them
> closed the gap on 2026-07-28. Full evidence, controls and provenance in
> [Closing measurement](#closing-measurement-2026-07-31-host-lane) at the
> bottom — including the two claims in this file that did **not** survive
> re-checking.

> **REGRESSION AUDIT, 2026-08-09.** Fresh host and standalone baseline rows
> were joined to the repository's committed 273-file legacy-edition index.
> Host reported 271 pass plus two `compile_timeout` rows; both timeout files
> passed when rerun alone in 0.6–0.7 seconds, so they are long-process baseline
> artifacts rather than compiler failures. Standalone reported 272 pass plus
> one real failure,
> `language/expressions/assignment/S11.13.1_A7_T4.js`. The standalone computed
> assignment path did not canonicalize an object key before receiver-specific
> setter dispatch, and it evaluated the RHS before the key. The regression fix
> performs `ToPropertyKey` once at the Reference boundary before the RHS and
> applies the same canonicalization to IR `dyn.member_set`. The permanent test
> reruns all three apparent residuals in both lanes and includes an executed
> standalone IR-store proof. This is combined fresh-baseline + isolated-rerun
> evidence, not a new full 273-file sweep.

## Why this issue exists

**≤ES3 is the edition closest to done and the cheapest to finish.** The gap is
**not a list of missing features** — every ES3 test compiles. It is four
already-identified defects (#3486 ✅, #2666, #2899, #2900).

> The original wording — "three already-identified defects, one of which
> accounts for 95% of the failures" — was measured wrong. #3486 accounted for
> **11 of 43 (26 %)**, not 41 of 43 (95 %); the 95 % figure counted tests whose
> _message_ matched, not tests the fix would flip. #2666 is the larger cluster
> at ~30. See the correction in the attribution table below.

Finishing ≤ES3 gives the project a **fully-closed edition** to point at, and
#3486 did suppress results well beyond ≤ES3 (28 tests fixed across eight
top-level areas), so the true value still exceeds the ES3 number — that part
held up.

## Measured state (host / `gc` lane, 2026-07-25)

Baseline `test262-current.jsonl` fetched fresh (`--force`; see #3629 — the bare
command is a silent no-op), classified with the exact `classifyEdition` rules
from `scripts/generate-editions.ts`. **Reproduces the published editions figure
exactly: 273 scored / 43 failing** — so these numbers are validated, not
approximated.

|                    |            count |
| ------------------ | ---------------: |
| ≤ES3 scored        |          **273** |
| passing            | **230 (84.2 %)** |
| failing            |           **43** |
| **compile errors** |            **0** |

**Zero compile errors is the headline.** Nothing in ES3 is unimplemented at the
language level; all 43 are runtime-semantics defects.

## The 43, fully attributed

> **CORRECTED 2026-07-25 after #3486 landed.** The table below attributed all 41
> to #3486 and the acceptance criterion said "confirm the 41 flip." **Measured:
> 11 flip, not 41.** The attribution METHOD was sound — it reproduces the
> published editions figure exactly — but it grouped by a shared _error message_,
> and a shared symptom is not a single blocker. Each of these files contains
> **two** `assert.throws` calls; #3486 was the first one's blocker, and the other
> 30 fail on the second with a genuinely different root cause. Corrected split:

|  count | cluster                                                          | owning issue                                       |
| -----: | ---------------------------------------------------------------- | -------------------------------------------------- |
| **11** | custom-exception `.constructor` identity                         | **#3486** ✅ fixed 2026-07-25                      |
| **30** | `RequireObjectCoercible(base)` must precede `ToPropertyKey(key)` | **#2666** (measured attribution added there)       |
|      1 | `language/statements/function/13.2-30-s.js`                      | **#2899** (currently `done` — reopened, see below) |
|      1 | `language/module-code/eval-gtbndng-indirect-update-dflt.js`      | **#2900** (currently `done` — reopened, see below) |

So ≤ES3 goes **230/273 → 241/273** with #3486, and **#2666 is now the dominant
remaining cluster** — worth ~30, taking the bucket to ~271/273.

The 30 residuals all report `Expected a TypeError but got a Test262Error`. The
probe that localised it (host lane, isolated): a plain read `base[prop]` with
`base === null` correctly throws `TypeError` _before_ `ToPropertyKey`, but
`base[prop] &= expr()` and `++base[prop]` both evaluate the key first, so a
throwing `prop.toString()` escapes ahead of the required TypeError. The plain
member-read path has the order right; the read-modify-write member paths do not.

### The 41 — originally read as one defect; measured as two (#3486 + #2666)

33 × `language/expressions/compound-assignment/S11.13.2_A7.*` plus 8 ×
prefix/postfix `++`/`--` (`S11.4.4_A6`, `S11.4.5_A6`, `S11.3.1_A6`,
`S11.3.2_A6`). Every one fails with:

```
Expected a DummyError but got a Array
```

They share one shape — a left-to-right evaluation-order test whose property key
throws a user-defined error:

```js
function DummyError() {}
assert.throws(DummyError, function () {
  var base = null;
  var prop = function () {
    throw new DummyError();
  };
  base[prop()] *= expr();
});
```

**The correct exception IS thrown.** The harness simply cannot identify it: a
user-defined constructor's instance reports `.constructor` as a function named
`Array`.

> **Two corrections from #3486's investigation.**
>
> 1. **The throw/catch boundary is NOT involved.** This paragraph originally
>    said "once thrown and caught on the host side," and #3486's own issue file
>    hypothesised an exception-marshaling defect. Both were **disproven by
>    probe**: a plain `new MyError("x")` that is _never thrown_ reports
>    `.constructor.name === "Array"` identically. It is the ordinary
>    property-read path. (Root cause: a vec discriminator that was vacuously
>    true for every WasmGC struct, because `__vec_len`'s not-a-vec default is
>    `0` and the guard tested `typeof len === "number"`.)
> 2. **"The evaluation-order semantics are very likely already correct" was
>    half right.** For 11 of the 41, yes. For the other 30 the evaluation order
>    is genuinely wrong too — just a different aspect of it than these tests'
>    first assertion probes (`RequireObjectCoercible` ordering, #2666). The
>    identity defect was standing in front of a real second defect, not in front
>    of correct behaviour.

It is still the **host-lane twin of #3614**, where `Test262Error`'s
`.constructor` read `undefined` in the standalone lane (fixed 2026-07-25, up to
854 tests) — same _question_ (an instance's constructor back-pointer), though
the two lanes turned out to need **different mechanisms**, not one shared fix
(host: the `_fnctorInstanceCtor` WeakMap; standalone: WasmGC globals), exactly
as #3617 predicted.

## Acceptance

- [x] #3486 fixed; ≤ES3 bucket re-measured. **11 flipped, not 41** — the
      "confirm the 41 flip" wording was a forecast dressed as a count and is
      corrected above. 230/273 → 241/273.
- [x] #2666 fixed (`RequireObjectCoercible` before `ToPropertyKey` in the
      read-modify-write member paths) — landed 2026-07-28 as PR **#3741**
      _"fix(#2666): guard nullish member bases before key coercion"_.
      **Measured, not assumed: 30 of 30 flipped.** All 44 `S11.13.2_A7.*` and
      all 12 `*_A6_T*` inc/dec files read `pass`.
- [x] #2899 and #2900 re-verified against current main — **both now pass.** The
      "marked `done` while their tests still fail" note was true when written
      (2026-07-25) and is **no longer true**; each was genuinely fixed.
      `13.2-30-s.js` also passes a host-lane re-run on the current tree.
- [x] ≤ES3 reaches **273/273** — zero residual failures, so no residual needs an
      owning issue.
- [x] Re-measured with a **force-fetched** baseline (#3629): all 47,837 records
      dated 2026-07-31.

## Method note (for whoever re-measures)

Classification is `classifyEdition` in `scripts/generate-editions.ts`. Edition 0
(≤ES3) is the **fall-through**: no `es5id`, no `es6id`, no `features:`, **no
`esid:`** (esid ⇒ ES2015), frontmatter present (absent ⇒ ES5), and no
path heuristic match. A first attempt here that omitted the `esid` and
no-frontmatter rules reported **1,545** failures instead of 43 — a 20× error.
**Validate any re-implementation against the published 273/43 before trusting
it.**

**Better: do not re-implement at all.** `classifyEdition` and `parseFrontmatter`
are now `export`ed from `scripts/generate-editions.ts` (this issue's only source
change), so a measurement driver can import the real classifier. The 20× error
above is unreachable that way.

## Closing measurement (2026-07-31, host lane)

**Lane:** host (JS-host / `gc`). **Two independent instruments, both with
controls.**

### Instrument 1 — baseline classification (authoritative)

The real `classifyEdition` / `parseFrontmatter` imported from
`scripts/generate-editions.ts` (no re-implementation), applied to the
force-fetched `test262-current.jsonl`, deduped by file with the same
worst-status precedence the generator uses.

**Provenance — stated, not assumed.** Baseline blob
`loopdive/js2wasm-baselines@6cd657e6` (2026-07-31T06:14Z), produced by
`promote-baseline` from `loopdive/js2` main
`ff6dd1141f958afb3a5fab314ca9fe78653a3678` (2026-07-31 05:51Z). Verified
`git merge-base --is-ancestor ff6dd114 origin/main` → **true**, 21 commits
behind `origin/main` `e2e5ad707cd9446bc1b71fe5279336c1e36793d8`. All 47,837
records carry a single run date (31.7.2026), i.e. one run, not a partial
per-SHA reuse. This post-dates PR #3741 (2026-07-28T16:02Z) by three days.

| bucket                                  |  scored |    pass |  fail |    ce | skip |
| --------------------------------------- | ------: | ------: | ----: | ----: | ---: |
| ≤ES3 — now `UNCLASSIFIED_LEGACY` (`-2`) | **273** | **273** | **0** | **0** |    0 |

- **Denominator gate passed:** 273 scored reproduces the published figure
  exactly, so the classifier is the same one that produced `230/273`.
- **Positive control on the instrument:** the same driver, same run, reports the
  ES5 bucket as 8,931 scored / 6,615 pass / **2,264 fail / 52 ce**. The query
  _can_ return non-zero, so `fail: 0` is a measurement and not a broken filter.
- **Reclassification drift ruled out** (the count alone cannot distinguish
  "fixed" from "the tests moved buckets"): all 44 `S11.13.2_A7.*`, all 12
  `S11.3.1/S11.3.2/S11.4.4/S11.4.5_A6_T*`, `13.2-30-s.js` and
  `eval-gtbndng-indirect-update-dflt.js` are still **in** bucket `-2` and each
  now reads `pass`.

### Permanent repro (#2093)

This issue is closed by **measurement**, so its permanent repro is the
conformance corpus itself, not a new unit test — these are the exact files that
carried the 43 failures and now pass. Re-run any of them host-lane through
`runTest262File` to re-check the claim:

- `test262/test/language/expressions/compound-assignment/S11.13.2_A7.1_T4.js`
  (and `_A7.2`…`_A7.11`, `_T1`…`_T4` — 44 files; the #3486 + #2666 cluster)
- `test262/test/language/expressions/prefix-increment/S11.4.4_A6_T2.js`
- `test262/test/language/expressions/prefix-decrement/S11.4.5_A6_T2.js`
- `test262/test/language/expressions/postfix-increment/S11.3.1_A6_T2.js`
- `test262/test/language/expressions/postfix-decrement/S11.3.2_A6_T2.js`
- `test262/test/language/statements/function/13.2-30-s.js` (#2899)
- `test262/test/language/module-code/eval-gtbndng-indirect-update-dflt.js` (#2900)
- controls: `test262/test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-1.js`
  (in-bucket, must pass) and
  `test262/test/annexB/built-ins/escape/prop-desc.js` (must fail — proves the
  harness discriminates)

### Instrument 2 — `runTest262File` spot-check on the current tree

The baseline is 21 commits behind `origin/main`, so 10 files were re-run
host-lane on the branch tree. Status only — this runner's error _category_ and
_location_ are known artifacts.

- 7 subjects (5 from the defect family, plus each singleton) — **9/10 matched
  expectation**.
- **POS controls** (two in-bucket files unrelated to the defect family) —
  passed.
- **NEG control** (`annexB/built-ins/escape/prop-desc.js`, a baseline `fail`) —
  **failed as required**, so the harness discriminates.
- **The one mismatch, and why it is discarded.**
  `eval-gtbndng-indirect-update-dflt.js` (#2900) reported `compile_error`
  locally against a baseline `pass`. Control: three _other_ fixture-importing
  module tests that the baseline marks `pass` — `instn-iee-bndng-var.js`,
  `eval-gtbndng-indirect-trlng-comma.js` (both `compile_error`) and
  `instn-star-props-nrml.js` (`fail`). **None** reproduces its baseline verdict,
  and the errors are TS-parse artifacts (_"… can only be used in TypeScript
  files"_), so the single-file local path cannot execute the fixture-importing
  module class at all (62 such files exist). The instrument is invalid for that
  class; the baseline stands.

### Attribution — final, and what did not survive

Commit `ad2dd54d544333` is titled _"41 of 43 host failures are one defect"_.
**That headline is wrong and was already corrected inside this file on
2026-07-25**: the 41 shared an error _message_, not a root cause. Anyone
starting from the commit subject rather than the file will size this issue
wrongly.

|  count | cluster                                         | owning issue | landed                    |
| -----: | ----------------------------------------------- | ------------ | ------------------------- |
| **11** | custom-exception `.constructor` identity        | #3486        | 2026-07-25 (PR #3630)     |
| **30** | `RequireObjectCoercible` before `ToPropertyKey` | #2666        | **2026-07-28 (PR #3741)** |
|      1 | `13.2-30-s.js`                                  | #2899        | 2026-07-25                |
|      1 | `eval-gtbndng-indirect-update-dflt.js`          | #2900        | 2026-07-25                |

#2666 — the dominant cluster — was still open when this issue was written and
closed three days later. Nothing here needed new code.

### The stated motivation does not survive either — and that is the useful part

This issue opened with _"finishing ≤ES3 gives the project a fully-closed edition
to point at."_ **#3639 landed in between and removed that claim's basis.** The
bucket is no longer labelled an edition: `classifyEdition` now returns
`UNCLASSIFIED_LEGACY`, because the bucket is a **273-test metadata residue**
(frontmatter present, no edition marker), not a measurement of ES3. ES3's own
hardest surface is scored in _other_ buckets by frontmatter vintage — `eval`
(347 tests), `with` (181), the `Function` constructor (509), ~37 % combined.

So the honest statement of this result is **"a 273-test residue bucket is now
clean"**, not "ES3 is complete." Do not publish the latter.

### Follow-up filed

The committed `website/public/benchmarks/results/test262-editions.json` still
publishes this bucket as `"≤ ES3": 230/273, 84 %` — the pre-fix number _and_ the
pre-#3639 label. It has not moved since 2026-07-25 while
`benchmarks/results/test262-current.json` refreshes every ~4 h. Root-caused and
filed separately rather than hand-edited, because the artifact is CI-owned.
