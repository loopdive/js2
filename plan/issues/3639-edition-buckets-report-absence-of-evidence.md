---
id: 3639
title: "Edition buckets report absence-of-evidence as conformance — 5,436 tests sorted into ES2015 by fall-through, 273 into ≤ES3"
status: done
completed: 2026-07-25
sprint: 78
created: 2026-07-25
updated: 2026-08-18
priority: high
horizon: s
complexity: S
feasibility: easy
task_type: bugfix
area: ci, website, conformance
language_feature: n/a
es_edition: multi
goal: test-infrastructure
related: [3626, 3628, 1880, 1777]
origin: "2026-07-25 — the lead asked 'does ES3 not require dynamic eval?' It does, and the ≤ES3 bucket does not contain it. Measuring which RULE assigns each edition showed the distortion is 20× larger in ES2015."
---

# #3639 — edition buckets report absence-of-evidence as conformance

## Problem

`classifyEdition` (`scripts/generate-editions.ts`) assigns an edition from test
frontmatter. Two of its branches assign a bucket **because no evidence was
found**, and both then render as if they were conformance measurements:

1. **`if (fm.esid) return 2015`** — `esid` is the _modern_ test262 field. Every
   new test file carries one **regardless of which edition specified the
   feature**. So ES2015 became a catch-all.
2. **`return 0` (labelled "≤ ES3")** — the final fall-through: frontmatter
   present, no edition marker at all.

Neither is wrong as a _sorting_ rule. Both are wrong as a _label_, because the
landing page presents them beside genuinely-measured editions.

## Measured — which rule actually assigns each edition

Host lane, force-fetched baseline (`--force`; the bare command is a silent
no-op, #3629), 46,539 scored tests:

| rule                             |     tests |      share | faithful?                                          |
| -------------------------------- | --------: | ---------: | -------------------------------------------------- |
| `features:` tag                  |    28,154 |     60.5 % | **yes** — tags name the feature, hence the edition |
| `es5id:`                         |     8,115 |     17.4 % | **yes** — real ES5 spec-section field              |
| **`esid` FALL-THROUGH → ES2015** | **5,436** | **11.7 %** | **NO**                                             |
| `es6id:`                         |     2,990 |      6.4 % | **yes**                                            |
| path heuristic                   |     1,466 |      3.2 % | crude                                              |
| **default → "≤ ES3"**            |   **273** |  **0.6 %** | **NO**                                             |
| no frontmatter → ES5             |       105 |      0.2 % | crude                                              |

**ES2015 is ~60 % accident**: 5,436 tests arrive by fall-through against only
2,990 by the real `es6id` signal. That is **20× larger than the ES3
distortion**, which is what the investigation started from.

## The concrete consequence

ES3's own language is scored _outside_ the "≤ES3" bucket, purely by frontmatter
vintage. All are **run and scored** (`skip: 0`) — this is real behaviour, not a
skip filter:

| ES3 feature             | sorted into   |     tests |    pass |      rate |
| ----------------------- | ------------- | --------: | ------: | --------: |
| `eval` (§15.1.2.1)      | ES2015 (esid) |       347 |     135 |    38.9 % |
| `with` (§12.10)         | ES5 (es5id)   |       181 |      37 |    20.4 % |
| `Function` ctor (§15.3) | ES5/ES2015    |       509 |     215 |    42.2 % |
| global `eval`           | —             |        10 |       2 |    20.0 % |
| **total**               |               | **1,047** | **389** | **~37 %** |

So **"≤ES3: 84.2 %" was never a claim about ES3 support** — the edition's
hardest surface (dynamic code evaluation) sits at ~37 % in other buckets.

## Fix (this issue)

Report the two fall-throughs as what they are:

- `esid` fall-through → **`Unclassified (untagged)`** (sentinel `-3`)
- final default → **`Unclassified (legacy)`** (sentinel `-2`)

Both are excluded from the landing page's edition timeline automatically: the
chart's `t262IsEditionScope` only recognises `ES1`/`ES2`/`ES3`/`≤ ES3`/`ES5`/
`ES20xx`, so an unrecognised label is handled exactly as `Proposals` already is
— displayed, but off the timeline. **No chart surgery required.**

`editionStringToYear` keeps accepting the old `≤ ES3` / `ES3 / Core` labels so
feature-example rows written before the rename still resolve.

**ES2015 becomes honest**: 2,990 (`es6id`) + 650 (path) instead of ~9,076.

## Explicitly NOT in scope

- **Recovering the 5,436 into real editions.** `esid` names a spec section
  (`esid: sec-evaldeclarationinstantiation`), which _could_ be mapped to an
  edition via a spec-section table. That is the substantive follow-up and is
  worth its own issue — it would move most of the 5,436 out of Unclassified.
- Changing any pass/fail verdict. This is presentation only; no test result moves.

## Review note

This removes the earliest notch from the landing page's edition timeline (the
bucket that fed "ES3 / Core" is now `Unclassified (legacy)`). That is
deliberate — there is no faithful ES3 measurement to display — but it is a
**visible change worth eyeballing on the built page**. Reverting is a one-line
label change if the timeline reads worse without it.

## Caveat on the figures

These counts predate the landing of **#3626**'s frontmatter-window fix
(2,048 → 65,536 bytes), which reclassified ~4,220 previously-truncated files out
of ES5. Re-measure after that fix has promoted; the _shape_ of the finding is
unaffected (the fall-through rules are unchanged by it), but the exact counts
will shift.

## Generalises

Every per-edition percentage carries this artifact to some degree. A test's
bucket reflects **the vintage of its metadata**, not the edition that specified
the feature. Treat per-edition rates as "tests whose metadata sorts here", never
as "share of edition N implemented".

## Permanent repro (#2093)

Landed with PR #3627, which added the regression test alongside the fix:

- `tests/generate-editions-feature-rows.test.ts` — asserts the edition-bucket
  rows distinguish "measured absent" from "not measured", so a bucket can no
  longer report absence-of-evidence as evidence-of-absence.

Fix: `scripts/generate-editions.ts`.
