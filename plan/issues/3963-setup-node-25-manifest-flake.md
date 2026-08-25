---
id: 3963
title: "CI: every workflow requested Node 25, which actions/node-versions does not ship — all 27 pins fell back to a direct nodejs.org download, and that fallback parks unrelated PRs when it fails"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-08-01
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: n/a
sprint: 78
horizon: s
es_edition: n/a
related: [2547, 3597, 3986, 3987]
---

# #3963 — Node 25 is absent from the setup-node manifest; every pin was on the fallback path

## Status: done — root cause corrected by measurement; fix deliberately
## narrowed to the workflows that cannot perturb a committed baseline

## Problem as first observed

`actions/setup-node@v6` failed to resolve **Node 25**, and the direct-download
fallback did not save it. The step died in ~1.6 seconds and the job never ran
anything:

```
Attempting to download 25...
Not found in manifest. Falling back to download directly from Node
##[end-action id=__self.__actions_setup-node;outcome=failure;conclusion=failure;duration_ms=1635]
```

Confirmed occurrences, 2026-07-31, both on PRs whose code was fine:

| PR | check | outcome |
| --- | --- | --- |
| #3917 | `cross-backend-parity` | re-run passed with **no code change** |
| #3914 | `test262 js-host shard 10/66` | **auto-parked** with a `hold` label |

## Root cause — the original diagnosis was wrong in a load-bearing way

This issue was first written as "`setup-node` **intermittently** fails to
resolve Node 25 from the manifest." That is not what happens. Reading the
manifest settles it:

```
$ curl -sS https://raw.githubusercontent.com/actions/node-versions/main/versions-manifest.json
majors present: 26, 24, 22, 20, 18, 16, 14, 13, 12, 10, 8, 6
total entries: 363
entries matching 25.x: 0
```

**Node 25 is not in `actions/node-versions` at all** — not one build, at any
patch level. So the manifest lookup did not fail intermittently; it failed
**deterministically, on every single job**, and the "Not found in manifest"
line in the log above is the normal steady state rather than the anomaly.

What that means:

1. **Every** `node-version: 25` job in this repo — 27 pins across 18 files —
   was silently running on the **direct-download fallback**, fetching Node
   from `nodejs.org` on every run instead of taking a cached tool-cache hit.
2. The intermittency lives in **that fallback**, which is an unconditional
   network dependency on a third-party host. The two observed failures are
   that download failing, not the manifest lookup failing.
3. This was invisible because the fallback usually succeeds. The repo had a
   network dependency on every CI job and no signal until the day it flaked.

**The originally-proposed fix would not have worked.** This issue previously
recommended pinning a full `25.x.y` rather than the bare major, on the theory
that manifest coverage of recent versions was inconsistent. `25.7.0` — the
exact version two workflows already pinned — **is also not in the manifest**;
it was on the fallback path too. Pinning harder within an absent major does
not move a job off the fallback.

## Why this is worse than an ordinary flake

**It parks PRs rather than merely failing them.** When it hits a test262 shard
in the `merge_group`, `auto-park` (#2547) correctly labels the PR `hold` and
comments — because from the bot's perspective a required check failed on the
merged state, which is exactly the signal it exists to catch.

Clearing that label is deliberately *not* automatic. Per the auto-park rules a
bot `hold` must never be removed without diagnosing the cited run, since it
normally marks a real merged-baseline regression. So every occurrence costs a
**human-grade diagnosis cycle**, and a wrongly-held PR **strands** until someone
does it — the auto-enqueue backstop skips held PRs.

Two knock-on effects seen at the time:

1. `merge shard reports` also failed, at *"Fail if required test262 shards did
   not succeed"* — downstream of the missing shard, not an independent
   regression. So one flake produces two red checks and looks worse than it is.
2. The shard's artifact upload warned `No files were found … mgchunk10.jsonl`,
   confirming no verdict of any kind was produced.

The auto-park comment's own footnote (#3597) anticipates this: *"If it is a
setup/infra step rather than a verdict step, the verdict never ran and this park
may be spurious — confirm against the run before removing `hold`."* That
footnote is what made each incident resolvable — but it is a manual check.

## Fix applied — narrowed to workflows that cannot perturb a baseline

Seven workflows move from the absent major **25** to **24**, which the manifest
does carry (`24.18.1` stable, plus `24.18.0` / `24.17.0` / `24.16.0`). Those
jobs are back on a tool-cache hit with no per-job `nodejs.org` dependency.

| workflow | from | to |
| --- | --- | --- |
| `cross-backend-parity.yml` | `25` | `"24"` |
| `cla-check.yml` | `25` | `"24"` |
| `diff-test.yml` | `25` | `"24"` |
| `native-messaging-smoke.yml` | `25` | `"24"` |
| `porffor-direct-ab.yml` ×2 | `25` | `"24"` |
| `porffor-source-canary.yml` | `25` | `"24"` |
| `vacuity-canary.yml` | `25` | `"24"` |

`cross-backend-parity` is one of the two workflows that actually parked a PR
(#3917), so the fix covers a real observed incident.

**Bare-major is not the defect.** The failure mode was "this major is absent
from the manifest", not "setup-node cannot resolve a bare major" — `24` resolves
fine, which is why the 9 workflows already on `24` were never implicated.

### What is deliberately NOT changed, and why

**Conformance and benchmark results are Node-version-bound.** This is the
finding that narrowed the fix, and it was learned the hard way: the first
version of this change moved *every* pin, including the test262 shards, and the
`merge_group` re-validation failed with

```
pass           31086 → 31035    -51
compile_error    652 →  1829  +1177
skip            1278 →   108  -1170
```

`skip` −1170 and `compile_error` +1177 are mirror images — ~1170 previously
skipped tests were suddenly compiled, the quarantine list wall-to-wall
`Temporal/…: skip → compile_error`. Alongside it, `compile_timeout` 127 → 171
and aggregate compile time +0.9%.

The attribution took a wrong turn worth recording. The first hypothesis was a
fail-open in `classifyTestScope` (`const relPath = getTest262RelativePath(...)
?? ""`, which disables all three path-based skip rules). That is a real
fail-open, but it was **not** firing: both call sites `readFileSync(filePath)`
immediately, so `filePath` cannot be undefined. What settled it was PR #3964 —
an unrelated PR that passed the same `check for test262 regressions` gate in
`merge_group` during the same window, **on Node 25**, because it merged before
this change. Same gate, same window, one clean and one showing a 1170-test
selection flip.

So these keep Node 25:

| kept on 25 | why |
| --- | --- |
| `.github/actions/setup-node-pnpm` default | used by exactly two workflows, `ci.yml` and `test262-sharded.yml` — both run test262 |
| `test262-sharded.yml` | produces the committed baseline and every PR/merge_group verdict |
| `refresh-baseline.yml`, `test262-canary.yml`, `test262-differential.yml`, `test262-cache-prune.yml` | regenerate, compare, or cache test262 results |
| `baseline-floor-staleness-alert.yml`, `baseline-summary-sync.yml`, `deploy-pages.yml`, `issue-tests.yml` | read or publish baseline-derived data |
| `benchmark-refresh.yml`, `landing-four-lane-backend.yml` | committed **benchmark** baselines — same principle: the JS lane measures V8, so moving the Node major silently moves the numbers |

Moving the test262 shards to 24 is still the right end state, but it requires
**regenerating `test262-current.jsonl` under Node 24 first**; otherwise every
future PR compares Node-24 results against a Node-25 baseline. That sequencing
is deferred, not done — see below.

**Correction to an earlier claim in this issue:** the composite action was
described as "the shared choke point — covers `test262-sharded` and 11 other
workflows". That is wrong. Only **two** files reference it (`ci.yml`,
`test262-sharded.yml`); the "12" was a count of matching *grep lines*, not
files.

### Still open — the test262 shard keeps the flake (now #3987)

The workflow that parked #3914 is **not** fixed by this change. It stays on the
absent-25 pin and therefore on the fallback download, so the same park can recur
there. Closing it needs the baseline regeneration above. This is a deliberate
deferral, recorded so the gap is not mistaken for closed.

Tracked as **#3987**, which carries the sequencing (move the pin and regenerate
`test262-current.jsonl` atomically) and the open question of *why* results move
with the Node major.

The `classifyTestScope` fail-open that this investigation wrongly blamed is
filed separately as **#3986** — ruled out as the cause here, but a real latent
defect worth closing on its own.

### Why 24 is safe here

- `package.json` declares `engines: { node: ">=20" }`.
- Local development and the full local test suite run on **v22.22.2**, below 24
  — so nothing in the repo can require a ≥25 feature.
- 9 workflows (`publish-npm`, `auto-enqueue`, `auto-park-merge-group-failures`,
  `approve-fork-runs`, `passive-stack-retarget`) were **already** on 24.
- `benchmark-refresh.yml` already sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`,
  so its JS actions were running on the Node 24 runtime regardless.

## Acceptance criteria

1. ✅ `setup-node` no longer resolves against an absent major **in the workflows
   this change touches** — verified against the live manifest rather than by
   re-running CI and hoping. Independently corroborated by a runner log:
   `Found in cache @ /opt/hostedtoolcache/node/24.18.0/x64`, i.e. a tool-cache
   hit with no `nodejs.org` download.
2. ⚠️ **NOT met as originally written.** The criterion said "applied to *every*
   workflow that sets up Node". Doing that broke the test262 `merge_group`
   verdict, because conformance results are Node-version-bound. Ten
   baseline-producing or baseline-consuming workflows therefore stay on 25, and
   the criterion is consciously not satisfied rather than quietly restated. The
   remaining exposure is tracked under "Still open" above.
3. ✅ Workflows changed are recorded in the table above; all 34 workflow files
   plus the composite action re-parse as valid YAML after the edit.
4. ✅ Measurement baselines are left alone. `benchmark-refresh.yml` and
   `landing-four-lane-backend.yml` keep `25.7.0`, and their guards are
   unmodified: `tests/issue-3498-…`, `tests/benchmark-lifecycle.test.ts`,
   `docs/ci-policy.md` §6 and `docs/benchmarks/landing-four-lane-backend.md`.

## Worth considering alongside — still open

Since a setup-step failure can never produce a verdict, `auto-park` could
plausibly **decline to park** when the failing step is a known
setup/infrastructure step rather than a verdict step — it already identifies
the failing step by name (#3597), which is the hard part. That would remove the
manual diagnosis cycle for this whole class, not just for Node setup.

Left unfixed here deliberately: the parking behaviour is conservative on
purpose, and narrowing it deserves its own judgement rather than riding along
on a version bump.

## Provenance

Both incidents diagnosed during the #3898–#3908 performance-benchmark batch.
The #3914 park was cleared after confirming against the cited run that the
verdict never ran; the diagnosis is recorded in that PR's thread.

The manifest check that corrected the root cause was run only because the fix
required knowing *which* `25.x` to pin — the intended answer ("whichever is
newest in the manifest") turned out not to exist, which is what exposed the
real shape of the bug. Worth remembering: the original writeup was internally
coherent and cited real logs, and was still wrong about the mechanism.
