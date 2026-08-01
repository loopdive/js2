---
id: 3963
title: "CI: every workflow requested Node 25, which actions/node-versions does not ship — all 27 pins fell back to a direct nodejs.org download, and that fallback parks unrelated PRs when it fails"
status: done
created: 2026-07-31
updated: 2026-08-01
completed: 2026-08-01
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: n/a
sprint: current
horizon: s
es_edition: n/a
related: [2547, 3597]
---

# #3963 — Node 25 is absent from the setup-node manifest; every pin was on the fallback path

## Status: done — root cause corrected by measurement, fix applied repo-wide

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

## Fix applied

Every Node pin moves from the absent major **25** to **24**, which the manifest
does carry (`24.18.1` stable, plus `24.18.0` / `24.17.0` / `24.16.0`). That
puts every job back on a tool-cache hit and removes the per-job `nodejs.org`
dependency entirely.

| what | from | to | why this form |
| --- | --- | --- | --- |
| `.github/actions/setup-node-pnpm` default | `"25"` | `"24"` | the shared choke point — covers `test262-sharded` (the #3914 failure) and 11 other workflows |
| `benchmark-refresh.yml` `NODE_VERSION` | `"25.7.0"` | `"24.18.1"` | **exact** — reproducibility block; the job asserts `node --version \| grep -Fx "v${NODE_VERSION}"` |
| `landing-four-lane-backend.yml` ×2 | `"25.7.0"` | `"24.18.1"` | **exact** — reproducibility block; guarded by `tests/issue-3498-landing-four-lane-backend-benchmark.test.ts` |
| 24 remaining `node-version:` pins in 16 workflows | `25` / `"25"` | `"24"` | bare major resolves *within* the manifest to the newest matching stable, so it stays current without going stale |

**Bare-major is not the defect.** The failure mode was "this major is absent
from the manifest", not "setup-node cannot resolve a bare major" — `24` resolves
fine, which is why the 9 workflows already on `24` were never implicated.

**But bare-major is wrong for the two benchmark workflows**, and a repo gate
caught that. The first pass flattened every pin to `"24"`, including
`landing-four-lane-backend.yml`; `correctness-support-sanitizers` failed on
`tests/issue-3498-…:233`, which asserts the exact Node string. That assertion is
not incidental — it sits in a block that also pins `runs-on: ubuntu-24.04`,
`timeout-minutes: 90`, `RUST_TOOLCHAIN_VERSION: "1.94.1"`, `WASMTIME_VERSION:
"46.0.1"` and `rust-version = "1.94"` in the cold-host `Cargo.toml`. These are
**measurement-reproducibility pins**: a benchmark whose Node version drifts
between runs silently changes its own numbers. Both benchmark workflows
therefore keep an exact pin; only the non-measuring workflows take the bare
major.

The initial sweep grepped `.github/` for version assertions but not `tests/`,
which is why the exact-pin requirement was found by CI rather than before it.

### Benchmark-baseline implication — deliberate, not incidental

Moving the two benchmark workflows from Node 25.7.0 to 24.18.1 **changes the
measured JS baseline**, because the JS lane's numbers are V8's. This is a real
consequence and is accepted rather than overlooked:

- Those workflows were on the fallback-download path too, so they carried the
  same parking risk as everything else — leaving them on 25.7.0 would have left
  the fragility in place precisely where a failure is most expensive.
- Reproducibility is preserved *going forward*: 24.18.1 is exact and
  manifest-resolved, which is strictly more reproducible than an exact version
  fetched over the network from a third-party host on every run.
- Cross-version comparisons against numbers published before this change are
  not valid. The same-run A/B that `benchmark-refresh` uses for its PR verdict
  is unaffected, since both sides of that A/B run on the same runner with the
  same pinned toolchain.

No retry wrapper was added. Retries were option 2 in the original writeup, on
the assumption the flake was irreducible; once the jobs are on the tool cache
there is no per-run network call left to retry. If a manifest-covered version
ever starts flaking, revisit.

### Why 24 is safe here

- `package.json` declares `engines: { node: ">=20" }`.
- Local development and the full local test suite run on **v22.22.2**, below 24
  — so nothing in the repo can require a ≥25 feature.
- 9 workflows (`publish-npm`, `auto-enqueue`, `auto-park-merge-group-failures`,
  `approve-fork-runs`, `passive-stack-retarget`) were **already** on 24.
- `benchmark-refresh.yml` already sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`,
  so its JS actions were running on the Node 24 runtime regardless.

## Acceptance criteria

1. ✅ `setup-node` no longer resolves against an absent major — verified against
   the live manifest rather than by re-running CI and hoping.
2. ✅ Applied to **every** workflow that sets up Node — 27 sites across 18
   files; `grep -rn "node-version.*25\|NODE_VERSION.*25" .github/` returns
   nothing.
3. ✅ Workflows changed are recorded in the table above; all 34 workflow files
   plus the composite action re-parse as valid YAML after the edit.
4. ✅ The two measurement-reproducibility workflows keep **exact** pins, and
   their guards travel with them: `tests/issue-3498-…` updated and re-run
   green, plus `docs/ci-policy.md` §6 and
   `docs/benchmarks/landing-four-lane-backend.md`, which both name the pinned
   Node version in prose.

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
