---
id: 2889
title: "Standalone high-water WRITE side must emit host_free_pass — promote-baseline clobbered the honest mark back to the leaky 26k"
status: in-progress
assignee: ttraenkler/sendev-highwater
created: 2026-06-30
priority: high
task_type: bug
area: tooling
goal: standalone
sprint: current
horizon: m
related: [2879, 2360, 2097, 2366, 2367]
umbrella: 2860
---

# Standalone high-water WRITE side must emit `host_free_pass`

## Problem (CI-FIX — blocks the carrier track)

#2879 §2 switched the standalone-floor **read/gate** to `host_free_pass`
(`scripts/check-standalone-highwater.mjs` `passFromReport` /
`officialFromReport`) and re-baselined
`benchmarks/results/test262-standalone-highwater.json` to the honest host-free
**12,883** (official 12,551). That landed in `5e3d9aca7`.

The **post-merge `promote-baseline` job** (in
`.github/workflows/test262-sharded.yml`, step "Raise standalone pass-count
high-water mark (#2097)", line ~1480) then clobbered it. Commit
`d4bc147d3` overwrote the file back to `pass: 26040, official_pass: 24900` with
**no `host_free_pass` field**. The floor gate then compared current host-free
(~12,883) against high-water 26040 → **breach** on every standalone / carrier
PR's `merge_group`, and `tests/issue-2879-standalone-host-free-floor.test.ts`
went RED on `main` (it asserts `mark.pass ∈ (10000, 20000)`).

## Root cause (verified, not a `--update` leaky-read)

`check-standalone-highwater.mjs --update` already used `passFromReport`
(host-free) for the _raise_ value, so it did not itself write a leaky number
from the report. The clobber was a **stale-checkout + ratchet-up-only +
no-`host_free_pass`-field** interaction:

1. The promote run that produced `d4bc147d3` was triggered by the push of
   `15ef5a1c7` (#2359), whose tree was branched **before** §2 (`5e3d9aca7` is
   **not** an ancestor of `15ef5a1c7`). So its checked-out high-water file was
   the **pre-§2 leaky** `{pass: 26040, official_pass: 24900}` — which had **no
   `host_free_pass` field**.
2. `--update` is ratchet-**up-only**: the report's host-free `12,883` did **not**
   exceed the stale loaded mark `26,040`, so it did **not** rewrite the file.
3. The job committed the baseline refresh onto the _then-current_ `main` HEAD
   (which already had §2's honest `12,883`). The **unchanged stale leaky file**
   from the §2-less checkout landed on top of §2 → silent revert `12,883 →
26,040`, dropping the `host_free_pass` field.

The disambiguator that was missing: a **`host_free_pass` field in the
high-water file**. Without it, a stale leaky `pass: 26040` is indistinguishable
from a genuine host-free 26k, so the ratchet can't reject it.

## Fix (write-side, symmetric with the §2 read)

`scripts/check-standalone-highwater.mjs`:

1. **Strict host-free WRITE reader** — add `hostFreeFromReport` /
   `officialHostFreeFromReport` that read **only** `…host_free_pass` (NO fallback
   to the leaky `pass`). `--update` uses these: a report lacking `host_free_pass`
   (pre-#2879-§1 shape, or one whose rows dropped the leak class) **refuses to
   raise** instead of inflating the mark with a leaky pass. (The gate _read_
   `passFromReport` keeps its leaky fallback — safe there: a leaky number ≥ an
   honest floor never false-breaches.)
2. **Always emit a `host_free_pass` field** — every `--update` write carries both
   `pass` (= host-free, kept for back-compat with `evaluate`/the test) and an
   explicit `host_free_pass` (= same host-free number), plus host-free
   `official_pass`. This makes a stale leaky file structurally impossible going
   forward: no honest write ever puts a leaky number anywhere, and a stale
   checkout can now only ever hold an honest host-free mark.
3. **Ratchet / evaluate key on `host_free_pass`** — `evaluate` and the raise
   decision read `mark.host_free_pass ?? mark.pass` so the field, once present,
   is authoritative.

`benchmarks/results/test262-standalone-highwater.json`: **restored** to the
honest live-main numbers (re-measured on the live baseline jsonl, 48,118
records): `pass`/`host_free_pass` **12,883**, `official_pass` **12,551**,
`official_total` 43,136, tolerance 50. Host-free criterion
(`host_import_leak_class` absent) re-confirmed against current main.

## Verification

- `tests/issue-2879-standalone-host-free-floor.test.ts` green (restored mark in
  band) + new write-side strictness cases.
- Traced the promote path: single writer (line ~1483, staged ~1797); no second
  job (no `benchmark-refresh.yml` etc.) touches the file. Next post-merge refresh
  reads host-free `12,883`, mark `12,883` → no raise, file unchanged → no
  re-clobber. A leak-less report can no longer raise (strict reader → skip).
- Carriers (#2366/#2367) pass the restored honest floor (host-free ≥ 12,883 − 50).
