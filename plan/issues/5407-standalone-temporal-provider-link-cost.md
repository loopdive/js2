---
id: 5407
title: "standalone: linking the compiled Temporal provider still costs 1.8× a row's compile time (+214 functions, WAT doubled) — 8 of 360 measured rows time out, and this is the one thing keeping the test262 standalone Temporal artifact opt-in"
status: ready
sprint: current
priority: medium
horizon: l
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-12
---

## Problem

The standalone Temporal provider (#5383) works and is wired into every test262
lane, but the artifact is **opt-in** (`JS2WASM_TEST262_TEMPORAL_STANDALONE=1`,
the `standalone_temporal` workflow input) for exactly one reason: linking it
makes a row's compile too slow to be safe by default.

Measured in #5383 S2p (`.tmp/s2p-cost.mts`, median of 3, one process):

| row | route | S2p |
| --- | --- | --- |
| `PlainDate/prototype/day/basic.js` (10.6 KB assembled harness) | `compile` | 1647 ms |
| | linked | **2894 ms** (1.76×) |
| `intl402/…/PlainDate/from/era-japanese.js` (60 KB) | `compile` | 8244 ms |
| | `compileMulti` | 8729 ms |
| | linked | **15057 ms** (1.83×) |

The 60 KB row lands **exactly on the 15 s in-process compile limit**; the
sharded lane's fork kill is 30 s.

Two earlier suspects are closed and must not be re-investigated: linking itself
costs ~2 % (#5383 S2o), and the multi-source penalty is gone — on the 60 KB row
`compileMulti` is within **6 %** of `compile` after S2o's `typeof globalThis`
struct guard and S2p's outlined `globalThis` seed. **What remains is the
provider**: linked adds **214 functions** and doubles the WAT again (851 k →
1.85 M lines on the 60 KB row).

### The cost is already visible as failures, not just as slowness

#5383 S5 (2026-09-12), 3 × 120 rows, standalone lane, fresh
`JS2WASM_TEMPORAL_CACHE` per side:

| | PlainDate | Duration | ZonedDateTime |
| --- | --- | --- | --- |
| median row ms, unlinked | 1378 | 1372 | 1205 |
| median row ms, linked | 3126 | 3275 | 2886 |
| compile timeouts, unlinked | 0 | 0 | 0 |
| compile timeouts, linked | **2** | **3** | **3** |

8 of 360 rows (2.2 %) convert from an honest failure into a timeout. Across the
full ~4,600-row Temporal bucket that is the per-row timeout storm the pre-warm
doctrine exists to prevent, on a lane whose baseline was never measured linked.

## Implementation Plan (sketch)

The target that flips the artifact default-on is **≤1.3× linked-vs-unlinked**,
i.e. roughly another 2× off the provider's contribution. Ordered by expected
yield, each step measured before the next:

1. **Attribute the 214 functions.** They are not the polyfill's own bodies (the
   provider is a separate module); they are the boundary terminals plus whatever
   the consumer mints to talk to them. Count them by name prefix on the 10.6 KB
   row's WAT and say which mechanism owns each group before changing anything —
   S2o's premise failed precisely because the slice started from an assumed
   cause.
2. **Ask whether the terminals must be per-consumer.** If the same terminal set
   is minted for every consumer module, it belongs in the provider (emitted
   once) with the consumer importing it — the same "one copy, called" move that
   S2p made for the `globalThis` seed, at a different scale.
3. **Ask whether the WAT doubling is terminals at all.** 851 k → 1.85 M lines
   against +214 functions means the growth is per-BODY, not per-function. Find
   which bodies grow and why (S2o's method: compare the WAT line count of the
   same function name on both routes).
4. **Do not widen the #3418 dead-binding elision** as a shortcut. S2p recorded
   that the elision was *hiding* a per-site cost; a fix that depends on which
   entry point erased the evidence is not a fix.

**Acceptance:** linked-vs-unlinked ≤1.3× on both the 10.6 KB and 60 KB rows;
0 compile timeouts on the S5 three-family sample; byte A/B unchanged for
`--target gc` and for standalone modules that link nothing. Then, and only
then, flip `standalone_temporal` on by default in `test262-sharded.yml` and
re-measure the whole Temporal bucket.

## Notes

- Predecessors inside #5383: S2o (the `typeof globalThis` struct — 2,766 → 929
  functions), S2p (the outlined `globalThis` seed — the multi-source penalty,
  −43 %), S3 (the opt-in decision and the fail-soft stamp gate).
- Artifacts: `.tmp/s2p-cost.mts`, `.tmp/{pd,du,zdt}-{base,link}.tsv`.
- This issue is the *only* remaining blocker to the artifact being default-on;
  correctness blockers are tracked separately (#5406, #5408).
