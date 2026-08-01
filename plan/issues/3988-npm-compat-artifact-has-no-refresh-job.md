---
id: 3988
title: "npm-compat.html silently shows stale data: nothing regenerates `npm-compat.json`, so every generator change needs a hand-run nobody is reminded to do"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
related: [3958, 3977, 3982]
---

# The npm-compat page has no refresh job, so it silently goes stale

## Problem

`website/npm-compat.html` renders `benchmarks/results/npm-compat.json`. That
file is **committed** and **hand-generated**. Nothing regenerates it:

```
$ grep -rn 'generate-npm-compat-report' .github/workflows/
(no matches)
```

Every other artifact on that page family has an owner —
`test262-sharded.yml` promotes the test262 baselines, `benchmark-refresh.yml`
auto-commits the perf sidebar on every push to main (#1216). `npm-compat.json`
has none.

The result is a failure with no signal: change
`scripts/generate-npm-compat-report.mjs`, merge it, and the page keeps serving
the previous JSON. The code is right, the page is wrong, CI is green, and
nothing anywhere says so.

## This is not hypothetical — it has now happened twice in one session

1. **#3958 (React).** The React arm was rewritten to emit `kind:
   "upstream-suite"` with `total: reactSuite.results?.scored`. The committed
   artifact still had the old shape, so the card rendered `39/null`. Caught only
   because someone asked why the numbers were not on the page.
2. **#3977 (lit).** The generator gained a lit arm and `entryIsBarrel`; the
   renderer gained the barrel badge and the invalid-module count. Merged as
   PR #3971. The page continued to show `lit` as
   `{"status":"not-integrated","reason":"not shipped in npm tarball; adapter
   pending"}` from an artifact stamped `2026-08-01T11:06:18Z` — generated before
   the work existed. Caught the same way: someone looked and it was not there.

Twice, by eye, on the same root cause. The second time was by the same author
who had just diagnosed the first — which is the strongest evidence available
that this needs a mechanism rather than more diligence.

## Why the obvious workaround does not work

`--only lit` cannot be used to refresh one package:

```js
const focusedRun = selectedPackages.size !== PACKAGE_NAMES.length;
const writeArtifacts = !cliArgs.includes("--no-write") && !focusedRun;
```

A focused run **never writes** (deliberately — a partial file would drop the
other 21 packages). So the only way to refresh anything is a **full** run, which
now also re-measures the perf lanes for acorn/clsx/cookie and re-runs the React
and lit upstream suites. On a dev container that is tens of minutes, and the
perf numbers it commits are that machine's, not CI's.

That cost is exactly why it gets skipped, which is why it goes stale.

## Options

1. **A refresh workflow, mirroring `benchmark-refresh.yml`.** Runs the generator
   on push to main when `scripts/generate-npm-compat-report.mjs`,
   `tests/dogfood/**` or the catalog changes, and auto-commits the artifact with
   `[skip ci]`. Removes the human step entirely. Cost: a long job, and it must
   run the upstream suites.
2. **A staleness GATE.** Cheap check on every PR: if the diff touches the
   generator, the catalog or `tests/dogfood/**` but not
   `benchmarks/results/npm-compat.json`, fail with "regenerate the artifact".
   Does not fix the work, but makes the omission impossible to merge silently.
   Same shape as the existing baseline-staleness alert.
3. **Split the artifact per package** so `--only <pkg>` can write just its own
   slice and the page merges them. Removes the all-or-nothing cost that makes
   refreshing expensive in the first place — the real fix, and the largest.
4. **Render `tests` from the suite reports directly** rather than through the
   snapshot, so the correctness numbers cannot drift even if perf does.

(2) is the cheapest thing that would have caught both incidents. (1) is the
smallest thing that would have *prevented* them. They compose.

## Acceptance criteria

- [ ] Changing the generator without refreshing the artifact is either
      impossible to merge or automatically corrected — not left to whoever
      remembers.
- [ ] The mechanism covers the `tests` block specifically, since that is what
      drifted both times.
- [ ] `npm-compat.json`'s provenance is documented next to the other baseline
      files in `CLAUDE.md`, which currently lists every other artifact's
      refresher and omits this one.

## Note

The immediate lit staleness is being fixed by a hand-run full regeneration. That
is the workaround, not the fix — filing this so the next generator change does
not repeat it a third time.
