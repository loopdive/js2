---
name: feedback_parallel_session_pr_close_conflict
description: "A parallel session may close your dev's PR on a contradicting regression diagnosis — and may be RIGHT; decide flake-vs-real by the merged-report wasm-hash-change signal + deterministic N/N branch-vs-main repro, NOT a \"mechanistic zero-byte-diff\" claim (which can misjudge value-rep)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

Two Claude sessions can run against the same fork (`ttraenkler`) concurrently ([[project_sprint64_parallel_session_dup_prs]]). A parallel session may **close your dev's PR** with the opposite regression diagnosis — **and it may be the one that's correct.** Do NOT assume your own dev's diagnosis wins.

**Case (2026-06-28, instructive — I got this wrong first):** my dev `floor` diagnosed #2222 (hybrid R1, #2760) merge_group park as a FLAKE, arguing the regressing test `built-ins/Object/values/symbols-omitted.js` was an *in-bounds externref* read its change emitted "zero different bytes" for. A parallel session **closed #2222 as a REAL regression**. I trusted floor, removed the hold, and re-enqueued — which would have **re-introduced the regression**; the parallel close had saved it. Dev `r2` later proved floor WRONG: the test is a `symbol[]` = an **i32 array of symbol handles**; R1's gate keyed on the *Wasm kind* (`i32`) so it fired and boxed handles via `__box_number` instead of `__box_symbol` — a real, deterministic corruption. **The parallel session was right; floor's mechanistic claim was wrong.**

**How to apply:**
- **Authoritative flake-vs-real discriminator:** the merged-report delta line — "Regressions with **wasm-hash change**: N" means the PR *did* alter the test's bytes ⇒ **REAL**; "Wasm-identical noise" ⇒ flake. Plus a **deterministic N/N repro**: clean main passes N/N **and** the branch fails N/N ⇒ real (same-commit consistency rules out nondeterminism). See [[feedback_verify_local_repro_against_known_good_control]] and [[feedback_regression_analysis]].
- **A "mechanistic zero-byte-diff" argument is only as good as its value-rep model** — and value-rep is easy to misjudge: `number[]`, `boolean[]`, and `symbol[]`(handles) are ALL `i32` at the Wasm level, so a kind-check can't tell them apart. Check the wasm-hash signal BEFORE concluding flake.
- **Never re-admit a parked PR on a "flake" claim without the wasm-hash + N/N evidence** — you can re-introduce a real regression (I nearly did).
- **Don't close/reopen-war** a parallel session; adopt the safe default + surface to the human — but weigh that the parallel session may be the correct one.
- **Hold-label race:** re-check the `hold` label immediately before any enqueue (a PR can flip collateral-ejected→parked between reads). `dequeuePullRequest`'s input field is `id`, not `pullRequestId`.

Links: [[project_sprint64_parallel_session_dup_prs]], [[feedback_verify_local_repro_against_known_good_control]], [[feedback_regression_analysis]], [[reference_gh_remove_label_rest_not_pr_edit]].
