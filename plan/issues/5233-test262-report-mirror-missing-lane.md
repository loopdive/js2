---
id: 5233
title: "Pages deploy can silently fall back to a checkout Test262 snapshot"
status: ready
sprint: current
created: 2026-08-31
updated: 2026-08-31
priority: medium
horizon: s
feasibility: easy
reasoning_effort: max
task_type: infrastructure
area: ci, website, test262
language_feature: n/a
goal: conformance
related: [1778, 2911]
requested_by: ttraenkler/codex-sol-ultra
---

# #5233 — materialize a coherent pair of Test262 report lanes

## Problem

The Pages workflow tolerates a partially materialized external baseline while
the checkout already contains committed canonical snapshots. In
`.github/workflows/deploy-pages.yml:81-86`, baseline clone/checkout failure is
swallowed. If the external host JSON exists, lines 87-118 enter the refresh
block; the standalone copy at lines 113-115 is independently optional.

When that standalone download is absent, the committed
`benchmarks/results/test262-standalone-current.json` remains present. The
synchronizer sees both of its source paths, emits no missing-lane warning, and
copies the committed standalone snapshot beside the newly downloaded host
snapshot. It does not prove that both inputs came from this deployment's
external baseline materialization.

The synchronizer also warns and continues when a source path is genuinely
absent (`scripts/sync-test262-report-mirrors.mjs:29-45`), but merely requiring
both paths to exist would not fix the Pages path because the pre-existing
checkout file satisfies that predicate.

## Reproduction and controls

The direct synchronizer fixture established the underlying fail-open behavior:
host-only input copied three host targets, left a deliberately stale standalone
target untouched, and exited **0**.

The deployment-shaped reproduction started from a checkout containing an old
standalone canonical snapshot, materialized a fresh host snapshot while leaving
the external standalone snapshot absent, then ran the workflow's copy/sync
sequence. Both canonical paths existed, so all six targets were copied and the
command exited 0; host targets came from the external baseline while standalone
targets retained the checkout copy.

Controls behaved as expected:

- neither source present: non-zero;
- both sources present: zero and all six targets byte-identical to their own
  lane source;
- current upstream checkout: each checked-in lane family is internally
  byte-identical, so this is a latent provenance defect, not a claim that
  today's mirrors are stale.

The existing seven freshness tests compare present files and grep workflow
wiring; none proves that both inputs were materialized from the external
baseline source for the current deployment.

## Impact

An incomplete Pages baseline materialization can refresh one public pass-rate
lane while silently sourcing the other from the repository checkout instead of
the baselines repository's current lane snapshot. The synchronizer reports
success and erases the provenance distinction.

Host and standalone lanes are intentionally allowed to advance independently;
their `baseline_sha` values need not match. The defect is fallback to the wrong
source, not valid cross-lane epoch skew.

## Direction

Stage both externally sourced snapshots away from the checkout, require both to
materialize successfully, and validate each lane's non-empty provenance before
overwriting either canonical source or any mirror. Pass the staged paths or
validated provenance into the synchronizer so committed fallback files cannot
masquerade as this deployment's downloaded inputs. Preserve the workflows'
intentional independent-lane advancement policy.

If a caller intentionally supports one lane, require an explicit mode that
removes or labels the other lane unavailable; never present an older committed
snapshot as current.

## Acceptance criteria

- [ ] Pages stages and validates both external current snapshots before
      replacing either checkout source.
- [ ] Missing host or standalone materialization exits non-zero even when an old
      committed canonical file remains present.
- [ ] Absent or invalid per-lane provenance exits non-zero before copying.
- [ ] Valid external lane snapshots may carry different `baseline_sha` values;
      six targets are produced, each byte-identical to its own lane source.
- [ ] A failure cannot leave a stale target described as synchronized.
- [ ] Focused deployment-shaped tests cover missing-host, missing-standalone,
      invalid provenance, and valid equal/different lane epochs.
