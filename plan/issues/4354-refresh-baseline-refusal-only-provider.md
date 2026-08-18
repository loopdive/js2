---
id: 4354
title: "refresh-baseline promoted standalone baselines measured against the REFUSAL eval provider — 740 tests low (ES5 89.1% published as 82.5%)"
status: done
sprint: 78
created: 2026-08-10
updated: 2026-08-18
completed: 2026-08-10
priority: high
horizon: s
feasibility: easy
task_type: bug
area: ci
language_feature: eval
goal: test-infrastructure
related: [2928, 4013, 2097, 4350, 4351]
---

# refresh-baseline measured the refusal tier, not the interpreter tier

`refresh-baseline.yml` could not produce a correct **standalone** baseline. Two
independent halves are required, and it had neither:

| half | effect | state |
| --- | --- | --- |
| `build-runtime-eval-provider.mjs` without `--refusal-only` | puts the real Acorn+interpreter provider on disk | passed `--refusal-only` |
| `TEST262_FULL_RUNTIME_EVAL=1` | makes the runner **link** it | never set |

`test262-sharded.yml` had both since #4013. This workflow was left behind, so
the two lanes measured different capability tiers and whichever ran last won
the promoted baseline.

## Measured

Diffing the promoted baseline against the previous sharded-produced one
(`loopdive/js2wasm-baselines` `204e81f` vs `070071a`), same corpus both sides:

| status | before | after | Δ |
| --- | ---: | ---: | ---: |
| pass | 29,494 | 28,754 | **−740** |
| fail | 12,787 | 13,529 | +742 |
| compile_error | 6,331 | 6,331 | 0 |

746 files went pass → other; **661 carried**
`TypeError: dynamic code evaluation is not supported in this standalone build
(no js2wasm:runtime-eval interpreter linked)`. `compile_error` unchanged is what
proves this was the missing provider rather than a compile or semantics change.

Concentration matched the mechanism exactly: 431 `test/annexB/language/eval-code`,
39 `eval-code/direct`, 32 `eval-code/indirect`, 16 `annexB/language/global-code`.

ES5 standalone, same edition classifier both sides:

| baseline | ES5 pass / total | rate |
| --- | ---: | ---: |
| `070071a` (sharded, real provider) | 8,045 / 9,029 | **89.1 %** |
| `204e81f` (refresh-baseline, refusal stub) | 7,448 / 9,029 | 82.5 % |

The incorrect 82.5 % reached the published landing and report pages.

## Why it was urgent

The workflow had just been re-enabled (#4350) with an `17 */8 * * *` cron, so it
would have re-promoted a ~740-low standalone baseline every 8 hours, overwriting
whatever the sharded path produced. The failure is quiet in the dangerous
direction: a too-low baseline makes later PRs show ~740 phantom *improvements*
in the eval buckets, which can mask genuine regressions inside that noise.

## The green-no-op trap (worth propagating)

Fixing only the build half (#4355) produced a **byte-identical wrong baseline**:
the next refresh promoted `c93910e` at 28,455 standalone — exactly the corrupted
figure — while the `Prebuild full runtime-eval provider` step reported
**success** in every standalone shard. A green step proves the step ran, not
that the number it exists to move actually moved. Same shape as #4350 and #4351.

## Resolution

- #4355 — drop `--refusal-only`.
- #4356 — set `TEST262_FULL_RUNTIME_EVAL`, the half that actually links it.
  Also extended `tests/issue-2928-e6-provider-cache.test.ts`, which asserted this
  invariant for `test262-sharded.yml` **only** — the gap that let the two
  workflows diverge.
- #4357 — build once in a dedicated job and fan the artifact out rather than
  rebuilding it in all 57 standalone shards (~285 runner-minutes per refresh),
  keeping `--require-full-cache` so a missing or stale artifact fails loudly
  instead of silently dropping back to the refusal tier.

Verified by the number, not the checkmarks: the corrected refresh (`f18f561`)
records standalone **29,439** and ES5 **8,025 / 9,007 = 89.1 %**.

The standalone high-water mark was never damaged — it only ever raises, and
28,754 < 29,494, so `test262-standalone-highwater.json` stayed at 29,494.
