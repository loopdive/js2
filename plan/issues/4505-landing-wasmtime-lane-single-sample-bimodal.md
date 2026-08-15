---
id: 4505
title: "Landing wasmtime benchmark lane: one sample per refresh, demonstrated bimodality — a 5x phantom regression cost a full investigation"
status: ready
sprint: Backlog
created: 2026-08-16
updated: 2026-08-16
priority: high
horizon: m
feasibility: medium
task_type: infrastructure
area: ci
goal: correctness
related: [1222, 1746, 4239, 4557]
---

# #4505 — the landing wasmtime lane cannot distinguish a regression from a runner episode

## The incident (2026-08-15, full writeup lives in this issue because the
## lane's history is the only place the evidence exists)

The landing-page "String build + hash" warm number jumped **238 → 1,275 µs
(5.4×)** in a single refresh window (10:47 → 17:08). Investigation:

- All ~20 merges in the window checked. The only plausible suspect, **#4557**
  (char-read-loop hoist — exactly this benchmark's machinery), is a WIN, not
  a regression: measured locally, its artifact is **4.6× faster under
  V8/node and ~15 % faster under wasmtime in BOTH the JIT and the AOT
  (`wasmtime compile` → `.cwasm`) paths**, identical checksum result.
- The emitted binary is **byte-identical (sha256) from #4557 through the
  window's end** — nothing after it changed the artifact.
- No window commit touched `scripts/lib/landing-*`, the hot-runtime
  generator, or any workflow.
- The in-run JS control was flat (~1,000 µs) across the same refreshes.

**The tell**: the SAME refresh shows `array-sum cold` at 4,919 µs — but that
metric read **~4,964 µs at 02:38 the same morning, BEFORE any of the day's
code merged**, then 948, then 4,919:

```
refresh 08-15 02:38   sh-warm=259    as-cold=4964
refresh 08-15 10:47   sh-warm=238    as-cold=948
refresh 08-15 17:08   sh-warm=1275   as-cold=4919
```

`array-sum cold` flip-flops between two modes with zero code change. The
lane takes **one sample per metric per refresh** on a shared runner, so a
bad episode is indistinguishable from a real regression — the exact failure
class the 2026-08-14 handoff documented for the npm-compat lane ("a 3×
swing between consecutive runs ... judge perf with a local order-reversed
A/B, not the dashboard").

Note the in-module warm driver is already best-of-40 — and it STILL read
5.4× high, so the episode was sustained for the whole invocation, not a
scheduling blip the min could reject. Per-invocation repetition inside one
runner episode does not help; only **samples separated in time /
interleaved across programs** discriminate.

## Residual risk from the incident (do not lose this)

The CI runner is x64; the local exoneration of #4557 ran on arm64. An
x64-specific Cranelift interaction with the new hoisted loop shape is NOT
excluded. The discriminator is the next clean refresh sample: warm back at
~240 µs ⇒ episode; still ~1,275 µs ⇒ real, x64-specific, and #4557 needs a
targeted x64 look. (A manual refresh was dispatched 2026-08-15 ~23:00; two
refresh runs completed "success" WITHOUT promoting — the queue-gate deferral
— gate verdict read from the 22:46 run: `DEFER (queue=4 artifact-age=5.9h floor=6h)`, six minutes short of the force floor; the next cycle crosses 6h and pushes regardless of queue. Whoever picks this up: read
the newest `wasm-host-wasmtime-hot-runtime.json` history first.)

## Fix shape

1. **Interleave and repeat at the run level**: measure each (program,
   scenario) K times spread across the whole workflow run (A B C A B C, not
   A A B B C C), so a runner episode hits all programs roughly equally
   instead of whichever one it landed on.
2. **Publish variance**: per metric, keep min/median/std across the K
   run-level samples (the JSON already carries per-invocation std — that
   measures the wrong noise, WITHIN one episode).
3. **Noise-floor gating for the landing page**: compute each metric's
   historical inter-refresh spread (the data is already in git history);
   render a delta as a regression ONLY when it exceeds that floor. Both
   `as-cold` modes (~950 / ~4,900) would today define a floor that flags
   nothing — which is the honest state of that metric until (1) fixes it.
4. **Keep a short in-file history** (last N refreshes per metric) so a
   flip-flop is visible in the artifact itself instead of requiring git
   archaeology.

## Acceptance criteria

- [ ] A single hostile runner episode during a refresh can no longer move a
      published landing number by >2× (demonstrated by the as-cold metric
      stabilising or being visibly floored).
- [ ] Every published metric carries an inter-refresh variance figure.
- [ ] The #4557 x64 question above is answered and recorded here.
