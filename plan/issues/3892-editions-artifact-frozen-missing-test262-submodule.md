---
id: 3892
title: "Landing-page edition buckets frozen since 2026-07-25 — baseline-summary-sync has no test262 submodule, so generate-editions dies and the failure is swallowed"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: s
complexity: S
feasibility: easy
task_type: bugfix
area: ci, website, conformance
language_feature: n/a
es_edition: multi
goal: test-infrastructure
related: [3628, 3639, 3626, 1951]
origin: "2026-07-31, #3628 close-out: the ≤ES3 bucket measured 273/273 but the committed artifact still published 230/273 (84%). Chasing why produced a root cause, not a stale file."
---

# #3892 — edition buckets frozen: `generate-editions` fails silently in `baseline-summary-sync`

## Symptom

`website/public/benchmarks/results/test262-editions.json` on `main` has not
changed since **2026-07-25** (`bbe94d09`, the #3626 PR). Meanwhile
`benchmarks/results/test262-current.json` — staged by the _same_ workflow step —
refreshes every ~4 h (latest `51c8d8a8`, 2026-07-31 08:17Z).

Two user-visible consequences, both live right now:

1. **The published number is wrong.** The artifact says
   `"≤ ES3": pass 230, fail 43, total 273, pct 84`. Measured against the
   2026-07-31 baseline the bucket is **273/273, 0 fail, 0 CE** (see #3628).
2. **The published label is wrong.** It still reads `≤ ES3`, a label #3639
   deliberately retired in favour of `Unclassified (legacy)` precisely because
   the bucket is a metadata residue, not an edition measurement. The artifact
   is republishing the exact claim #3639 landed to stop.

The ES5 bucket is stale by the same mechanism (artifact 2,388 fail / 44 ce;
measured 2,264 fail / 52 ce), so this is not an ≤ES3 quirk.

## Root cause — confirmed from the run log, not inferred

`.github/workflows/baseline-summary-sync.yml` checks out with:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 1 # <- no `submodules:`
```

so `test262/` is empty. `scripts/generate-editions.ts` guards on it explicitly
and throws. The workflow then swallows the throw:

```yaml
node --experimental-strip-types scripts/generate-editions.ts \
  --results /tmp/js2wasm-baselines/test262-current.jsonl || \
  echo "WARN: generate-editions failed (non-fatal) — edition buckets may lag"
```

**Direct evidence** — run `30615774824`, job `sync`, 2026-07-31T08:17:47Z, a
**green** run:

```
Error: Missing test262 checkout at /home/runner/work/js2/js2/test262.
Run 'git submodule update --init --recursive' before generating edition data.
```

The staging guard then hides it completely:

```bash
[ -f website/public/benchmarks/results/test262-editions.json ] && \
  git add -f website/public/benchmarks/results/test262-editions.json || true
```

`[ -f ]` tests **existence, not freshness** — and the stale file exists, checked
out from `main`. So `git add` succeeds, contributes no diff, and the commit goes
out green with every _other_ artifact updated. Nothing anywhere reports a
problem.

`test262-current.json` is immune because it is an unconditional `cp` from the
baselines repo, needing no test262 checkout.

## Why it went unnoticed for six days

The primary refresher **used** to be `test262-sharded.yml`'s `promote-baseline`
job, which _does_ have the submodule and regenerates correctly — its last
editions commit is 2026-07-18. Since then `baseline-summary-sync.yml` has been
the de-facto refresher, and it silently lacks the one input the generator needs.
Every run is green, the commit lands, most artifacts are fresh — the only
signal is a `WARN` line nobody reads.

Textbook silent-empty: a failure indistinguishable from success at every
observation point outside the log.

## Fix

Give the workflow the submodule:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 1
    submodules: recursive
```

(A shallow `submodules: recursive` pulls ~all of test262; if the clone cost is
unwelcome, the alternative is to skip the regeneration explicitly when
`test262/test` is absent — but then the artifact must be left **untouched and
loudly reported**, not silently re-staged.)

## Acceptance criteria

- [ ] `baseline-summary-sync.yml` has the test262 submodule and
      `generate-editions.ts` exits 0 in its run log (grep for the `Missing
    test262 checkout` error returning nothing — with a positive control that
      the grep can match, since this whole issue is about a zero that meant
      failure).
- [ ] The next sync commit moves
      `website/public/benchmarks/results/test262-editions.json`; the
      `Unclassified (legacy)` bucket reads **273/273**, and the label `≤ ES3` no
      longer appears in the artifact.
- [ ] The silent-swallow is closed: either the generator's failure fails the
      step, or the staging stops re-adding a stale artifact as if it were fresh.
      A green run that publishes six-day-old conformance numbers must not be
      possible.

## Notes

- Not fixed inline by #3628's close-out on purpose: the artifact is CI-owned and
  CI/infra is Lane A. #3628's PR touches only issue files plus two `export`
  keywords.
- `scripts/run-pages-build.mjs` and `refresh-baseline.yml` also invoke
  `generate-editions.ts`; check whether either has the same missing-submodule
  shape before closing.
