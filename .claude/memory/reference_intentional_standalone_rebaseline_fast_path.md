---
name: reference_intentional_standalone_rebaseline_fast_path
description: "Fast path for an INTENTIONAL standalone floor drop (honest re-baseline, e.g. #3055 de-vacuification): land via the coordinated manifest (one clean PR), NOT admin-bypass; if bypassed, the recovery lever is refresh-baseline.yml EMERGENCY mode (NOT the sharded force-promote, which cascade-skips)."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

When a change INTENTIONALLY drops the standalone host_free_pass floor (a de-vacuification / honest re-baseline like #3055/#2757 — the fix makes previously-vacuous passes honestly fail), landing it fights TWO merge_group gates in `test262-sharded.yml`'s required "merge shard reports" job:
- **#2097 high-water floor** (`scripts/check-standalone-highwater.mjs` vs committed `benchmarks/results/test262-standalone-highwater.json`). SOLVABLE in-PR: lower the committed mark to the honest number (data-only PR self-lands; a next promote --update re-raises).
- **#1897 standalone regression guard** (`diff-test262.ts`, tol −15). The baseline is the EXTERNAL `loopdive/js2wasm-baselines` repo, re-seeded ONLY by the post-merge `promote-baseline` job → chicken/egg: the promote that would fix #1897 has `needs: merge-report`, which fails on #1897, so the promote cascade-SKIPS. No in-PR self-land via the sharded workflow.

Do NOT bump oracle_version for this — a de-vacuification is CODEGEN, not verdict-logic (touches none of `check-verdict-oracle-bump.mjs` ALL_VERDICT_FILES); bumping self-wedges (merged=v2 vs baselines=v1 → diff-test262.ts exit 2 → guards hard-fail in base-YAML).

**FAST PATH (do this, avoids a multi-hour reactive incident):**
1. **Land via the COORDINATED manifest, not admin-bypass.** Build/extend a committed, self-removing re-baseline-excusal in `diff-test262.ts` (generalize the #3004 `isVacuousReclassification` excusal) that excuses the one-time expected drop of N in named buckets → #1897 passes IN-PR → one clean self-landing PR, no wedge. This is banked in #3056/#3055. Admin-merging past the gate is what created the #2097+#1897 wedge that took hours to unwind (2026-07-06).
2. Set N from the SCOPED estimate immediately (opus-3055 measured −25 on a 5-suite sample → extrapolated ~1,978 corpus-wide in minutes) + margin — don't block on a full ~68-min sharded run.

**RECOVERY LEVER (if it was already admin-bypassed and the queue is wedged on #1897):**
- The external baseline re-seed is `refresh-baseline.yml` → **"Baseline Refresh (scheduled + emergency)"**, EMERGENCY mode: `gh workflow run "Baseline Refresh (scheduled + emergency)" -R loopdive/js2wasm --ref main -f force_baseline_refresh=true -f confirm_force=YES`. This does an UNCONDITIONAL promote (ignores regressions) → re-seeds committed baseline + the js2wasm-baselines repo → clears #1897.
- Do NOT use `test262-sharded.yml`'s `force_baseline_refresh` for this — its promote is `needs: merge-report`, which fails on #1897 first, so the promote SKIPS (wasted a ~68-min run 2026-07-06).
- Also lower the committed #2097 highwater (data-only PR) — that gate is separate and not fixed by the emergency refresh's promote until it completes.
- Landing page (js2.loopdive.com) needs a deploy-pages run AFTER the baseline refresh to serve the new number (see [[feedback_trigger_deploy_pages]]).

Timing reality (corrected 2026-07-06): a full test262 run on GitHub Actions is SHARDED (~114 parallel shards) → **~2–5 min per run**, NOT 68 min (68 min is the LOCAL single-container `JS2WASM_LOCAL_CI` figure — do not conflate). The multi-hour wall-clock of this incident was NOT test duration — it was (a) serial reactive gate-by-gate fix-cycles after the admin-bypass, (b) one wrong lever (gated sharded force-promote), and (c) POLLING CADENCE — the loop rescheduled at 20–30 min while CI finished in ~5 min. **When actively driving a CI-gated fix, poll at ~5-min cadence, not 20–30 min.** The coordinated one-PR manifest path avoids stacking serial cycles entirely.
