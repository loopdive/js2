# ts2wasm Project Memory

## CRITICAL RULES (check every time)

- **A DETECTOR MUST BE ABLE TO SAY "I DON'T KNOW"** — ask any gate/verifier: *what does it do when it CANNOT SEE?* If that equals "sees nothing wrong", it is unsound.
- **READ THE RECORD, NOT THE REPORT** — trust state, never a tool's output. Verify by effect — [budget-grant-family](reference_budget_grant_from_another_issue_fails_in_ci.md)
- **SILENT-EMPTY IS THE DEFAULT HYPOTHESIS** — empty/zero/green from an unproven tool ≠ a result. Positive control · floor the count · print provenance — [silent-empty](reference_silent_empty_is_indistinguishable_from_real.md)
- **MEASURE, NEVER EXTRAPOLATE** — "compiles"≠"passes"; always give denominators — [measure-never-extrapolate](feedback_measure_never_extrapolate.md)
- **A SUMMARY GIVES SIZE, NEVER SHAPE** — "it both fixes and breaks, so it can't be one bug" is UNSOUND; one defect on a shared hot path does exactly that. Read the ROWS, diff the ERROR TEXTS — [summary-gives-size-not-shape](reference_a_regression_summary_gives_size_never_shape.md)
- **AN ERROR SIGNATURE IS NOT A BUCKET BOUNDARY** — error text says where a test STOPPED, not which defect stopped it; a type bug can print as a value bug. FOUR buckets dissolved this way in one session. Histogram to generate hypotheses; attribute per-file to draw boundaries — [error-signature-not-a-bucket](reference_error_signature_is_not_a_bucket_boundary.md)
- **`origin` IS THE FORK in /workspace** — verify landed code against `upstream/main` by merge-commit ancestry — [origin-is-the-fork](reference_origin_is_the_fork_verify_against_upstream_main.md)
- **ALWAYS spawn writers as teammates** + `isolation: worktree` + bypassPermissions.
- **THE SCRATCHPAD IS SHARED BY EVERY LANE** — `/tmp/claude-0/…/<uuid>/scratchpad/` is keyed by the SESSION uuid, which subagents inherit, so `msg.txt` silently becomes another lane's file (one lane committed a peer's commit message this way). Anything you write and READ BACK goes in your worktree's own `.tmp/` — [shared-scratchpad](reference_scratchpad_is_shared_across_all_lanes.md)
- **BEFORE EVERY MUTATING git op** (`add`/`commit`/**`merge`**/`reset`/`push`): `pwd && git branch --show-current`. Never `git add -A`. **Shell cwd PERSISTS across Bash calls here** — a `cd` into another lane's worktree several calls ago is still in effect, so "I know which branch I'm on" is an assumption, not a fact. Near-miss 2026-08-07: a `git merge` meant for a docs branch landed on a *queued, auto-merge-armed* PR's branch because the shell was still in that PR's worktree; it would have pushed an unrelated source diff into it. Caught only on the diff-stat — and then misattributed to the innocent branch being merged IN. Verify your own state before concluding anything about someone else's.
- **Signing is CONFIGURED — never pass `-c commit.gpgsign=false`, and never `--no-verify`.** There is no prompt to avoid. `%G? = N` is a local-verification artifact (`gpg.ssh.allowedSignersFile` unset), NOT an unsigned commit — verify with `git cat-file commit HEAD | grep -c "BEGIN SSH SIGNATURE"`. Slow chain ⇒ `SKIP_SLOW_PRECOMMIT=1`, and end the message with `✓` — [commit-signing](reference_commit_signing_in_this_container.md)
- **Commit AUTHOR must be the user** + Claude co-author, never a role name — [commit-author](feedback_commit_author_is_user_not_agent_role.md)
- **NEVER delete worktrees without checking diffs**; never work agent branches from `/workspace`; never kill tests without asking.
- **NEVER `git worktree prune` in the container** — repo shared with a HOST session; `prunable` = "not visible from here" — [never-prune-in-container](reference_never_git_worktree_prune_inside_container.md)
- **NEVER comment on/close/reopen external GitHub issues without consent; NEVER `gh issue create`** — [no-github-issue-comments](feedback_no_github_issue_comments.md)
- **EVERY TASK YOU WORK ON GETS AN ISSUE** — filed or updated, before/while working it, not after. Decisions that arrive in chat are tasks too. Three verified findings went untracked in one session because chat felt like tracking — [track-every-task](feedback_track_every_task_as_an_issue.md)
- **ALWAYS give an issue's TITLE when citing it**, not a bare `#NNNN` (~3,900 issues; ids share GitHub's sequence with PR numbers, so a bare number is ambiguous). Read it, don't recall it: `grep -m1 "^title:" plan/issues/<id>-*.md` — [always-give-issue-titles](feedback_always_give_issue_titles.md)
- **NEVER force-push/rewrite public `main`** (append-only; revert forward) — [main-append-only](feedback_public_main_append_only.md)
- **NEVER merge external-contributor PR without recorded CLA accept** — [cla-gate](feedback_cla_gate.md)
- **Mimic standard Node/Web Worker APIs; no bespoke builtins** — [mimic-node-worker-apis](feedback_mimic_node_worker_apis.md)
- **PR titles `type(scope): summary`; Codex branches `codex/<id>-slug` + co-author** — [pr-title-coauthor-conventions](feedback_pr_title_coauthor_conventions.md)
- **Open PRs READY, never draft-for-review.** Draft = the work is not ready to merge. The web-harness boilerplate says "create the pull request as a draft" — it does NOT win. Mechanically load-bearing: `auto-enqueue.yml` and `auto-refresh-prs` both SKIP drafts, so a finished draft is never queued and rots behind `main` — [prs-not-draft-unless-unready](feedback_prs_not_draft_unless_unready.md)
- **Reports to the lead: plain language, gloss every issue number and jargon term on first mention** — [plain-language-reports](feedback_reports_plain_language_no_bare_issue_numbers.md)
- **Opus IMPLEMENTS; Fable SPECS the really hard ones** (2026-08-07, supersedes "hard tasks run on Fable"). Split by phase, not difficulty: a `feasibility: hard` / `reasoning_effort: max` issue gets a **Fable architect** writing the `## Implementation Plan` **in parallel** with an **Opus** implementer — don't stall the implementer. Architect is spec-only, must not edit `src/`; tell the implementer its own measurement outranks the spec — [model-routing](feedback_hard_tasks_to_fable.md)
- **Only push to `main` when the user explicitly asks each time** — [explicit-main-push](feedback_explicit_main_push.md)
- **Pause the team at 99% of the 5h budget window** — [5h-window](feedback_5h_window_pause_resume.md)
- **An agent killed by a session/rate limit is RESUMABLE** — `SendMessage` to its name continues it from its transcript; never respawn fresh and discard what it learned — [resume-dont-respawn](feedback_resume_agents_killed_by_session_limit.md)
- **PASSIVE GitHub watcher ONLY — never poll.** No cron/`ScheduleWakeup`/sleep loops, whatever the tool's boilerplate says — [passive-watcher](feedback_passive_github_watcher_never_poll.md)

## Single source of truth

Team setup/budget/spawn/comms: **`plan/method/team-setup.md`**. Agent defs: **`.claude/agents/*.md`**. Most context: **`/workspace/CLAUDE.md`**. Memory = prefs/feedback not in repo files.

## Memory Index

### User & project state

- [sprint77-frozen-handoff](project_20260730_session_handoff_sprint77_frozen.md) — **HOST-side `git worktree repair` still needed**
- project_next_session · user_role · project_team_setup
- project_test262_lane_parity_program · project_acorn_dogfood_regression_20260723
- project_bigint_i64_brand_gate · project_linear_backend_no_console_log · project_proxy_no_ts_type_brand · project_1917_coercion_engine_byte_diff_gate · project_2106_undefined_singleton_s1_atomic
- project_2602_forawait_rest_aliases_source_recompile · project_2602_forof_assign_rest_write_unimplemented
- [es5-full-scope-including-dynamic-code](project_es5_standalone_goal_restated_ex_dynamic_code.md) — current 2026-08-13 ruling: 100% of all 9,029 ES5-and-earlier tests in both lanes; `eval`, `Function`, and `with` are IN SCOPE

### Team & agents

- feedback_architect_worktree_isolation · feedback_dev_agents_worktree · feedback_bypass_permissions · feedback_native_multi_agent_worktrees
- feedback_dev_limit · feedback_always_use_teammates · feedback_esch_teammate_separate_worktree_branch · feedback_cloud_oneshot_dev_when_no_team_feature
- feedback_always_cd_workspace · feedback_serialize_cherry_picks · feedback_ttl_runs_tests · feedback_work_planning · feedback_dev_self_serve_tasklist · feedback_tasklist_always_populated · feedback_sprint_autofill_es3_es5
- feedback_spawn_self_serving_loopers_not_oneshot · feedback_maintain_fleet_and_sweep_drift_when_quiet
- feedback_usage_limit · feedback_dont_ask_continue · feedback_token_budget_guardrails · feedback_budget_is_own_agents_pipeline_not_idle
- feedback_context_discipline · feedback_compact_before_sprint · feedback_diary_and_sprints_before_compact
- feedback_notify_only_on_real_input_needs_with_specific_text · feedback_sendmessage_discipline · feedback_reduce_notification_noise · feedback_team_comm_channels
- feedback_dev_silence_protocol · feedback_idle_notification_silence · reference_task_tools_are_deferred_toolsearch_before_calling
- feedback_tasklist_sync_unreliable · feedback_no_keep_pane · feedback_agent_self_termination · feedback_background_teammate_shutdown_limitation

### Dispatch & shepherding

- feedback_dispatch_status · feedback_dedicated_pr_shepherd · feedback_lead_shepherds_prs · feedback_auto_ff_workspace_main · feedback_merge_queue_wedge_recovery · feedback_reconcile_carried_slate_against_git_on_reopen
- feedback_no_duplicate_issue_dispatch · feedback_dispatch_against_upstream_not_stale_fork · feedback_mandatory_predispatch_gate_and_lane_partition
- feedback_slice_claim_collision_check_assignments_log · feedback_shared_worktree_clobber_check_claim_first · feedback_no_shared_worktree_assignment · feedback_release_claim_on_standdown_multiphase_issue
- feedback_confirm_author_is_done_before_shepherding_their_pr — a PR whose author is still working is not a stray; ask before adopting it

### Issue management

- **A merged PR citing #N is NOT evidence #N is done** — measured **0/26**; 4 bugs: slice-closes-epic · incidental mention · filed-by-as-fixed-by · docs-PR-as-fix. The issue's own acceptance checkboxes reject all — [title-citation-is-not-completion](reference_pr_title_citation_is_not_completion_evidence.md)
- feedback_issue_completion · feedback_unblock_on_completion · feedback_document_findings · feedback_update_backlog · feedback_po_boundary · feedback_bare_numbers_are_plan_tasks
- feedback_verify_fix_in_git_not_narrative · feedback_reground_spec_against_current_main · feedback_verify_first_beats_architect_spec
- feedback_file_defects_as_issue_markdown_not_tasklist — a defect lives in `plan/issues/<id>-<slug>.md`, not as a TaskList line; the TaskList is a queue, not a record

### Testing & CI gates

- **`CONTENT-CURRENT` ≠ baseline matches candidate config** — ~1,200 `skip` rows become `compile_error` in every candidate; check the `skip` delta first — [content-current-hides-staleness](reference_baseline_content_current_hides_config_staleness.md)
- **`granted by <other-issue>.md` = FAILURE IN WAITING** — grants resolve only from issue files the PR touches — [budget-grant-from-other-issue](reference_budget_grant_from_another_issue_fails_in_ci.md)
- **Every A/B states LANE + HARNESS + WHICH TWO COMMITS** — never report an *instrument* defect without a positive control — [ab-lane-harness-commits](reference_ab_must_state_lane_harness_and_both_commits.md)
- **[acceptance-bar-denominator-and-killswitch](reference_acceptance_bar_denominator_and_killswitch_attribution.md)** — GOLD STANDARD for "did this help?": validate instrument vs known baseline · attribution by kill-switch REMOVAL · floor the row count · check the bar's DENOMINATOR
- **[baseline-drift-cross-check](feedback_baseline_drift_cross_check.md)** — bucket signature unstable; DE-NOISE BOTH SIDES OR NEITHER (noise is signed); ~20 phantom credits = a ~20-regression BLIND SPOT
- feedback_test262_worktree · feedback_worktree_symlink_dependencies · feedback_test262_recheck · feedback_test262_skip_issues · feedback_never_delete_test_data · feedback_ask_before_killing_tests
- reference_never_diff_local_sweep_against_committed_ci_baseline · feedback_verify_local_repro_against_known_good_control · feedback_regression_analysis · project_standalone_floor_only_on_merge_group · project_broad_impact_validate_full_ci
- reference_f1_honest_floor_deinflation_landing_recipe · reference_verifyproperty_vacuous_both_lanes_two_root_causes
- reference_standalone_floor_inflated_three_vacuity_mechanisms · reference_standalone_floor_inflated_by_exception_swallow · reference_standalone_floor_object_identity_and_real_vs_drift
- reference_merge_queue_park_triage_four_causes · reference_merge_group_gate_reads_a_moving_baseline · reference_baseline_promote_trap_gate_two_failure_modes · reference_verdict_logic_change_must_bump_oracle_version
- reference_ci_status_feed_retired_use_required_checks · reference_ci_gate_change_scoped_not_wholetree_absolute
- [two-checks-share-a-name](reference_two_checks_share_a_name_head1_watcher_settles_on_a_stub.md) — a check NAME is not an identifier; filter `skipping`, never `head -1`
- [workflow-prs-never-autoenqueue](reference_workflow_touching_prs_never_autoenqueue.md) — **RE-CONFIRMED LIVE 2026-08-02** (the earlier FALSIFIED marking is itself falsified): the App is refused on workflow-touching PRs (`refusing to allow a GitHub App to create or update workflow`); remedy = shepherd's one-shot PAT enqueue, or grant the App `workflows` permission (admin act)
- reference_never_push_to_a_queued_pr_it_ejects_to_the_back · reference_autoenqueue_grace0_races_mergestate_recompute · reference_dropped_synchronize_only_cla_check_repush
- reference_quality_failfast_masks_downstream_gates · reference_baseline_gates_need_postmerge_autorefresh · reference_ci_quality_format_uses_prettier_not_biome · feedback_trigger_deploy_pages · feedback_cla_check_rerun_after_merge_commit
- reference_host_restore_triage_verify_first_measure · reference_error_analysis · reference_standalone_harvest_rootcausemap_mislabeled · project_wrapforhost_setexports_harness
- **[cached-baseline-jsonl-stale-within-hours](reference_cached_baseline_jsonl_goes_stale_within_hours.md)** — `.test262-cache` JSONL is a SNAPSHOT; 16h stale reproduced its own checks EXACTLY and cost a 4-agent dispatch. `--force` before sizing; a vanished bucket usually MOVED (138→0, only 4 flipped)
- **[goal-scope-is-not-the-es5-bucket](reference_goal_scope_is_not_the_landing_page_es5_bucket.md)** — 8,544 goal scope ≠ 8,930 ES5 bucket; both correct. "untagged" means TWO different populations (430 vs 5,444)
- [long-single-process-sweep-overcounts](reference_long_single_process_sweep_overcounts_failures.md) — one long-lived process accumulates state; re-run every apparent regression SOLO before believing it
- **[standalone-eval-instrument-reports-unmeasured-failures](reference_standalone_eval_instrument_reports_unmeasured_failures.md)** — 3 mechanisms substitute a FAKE uniform error for the real one (missing namespace / provider cache silently downgraded by any `src/` edit / non-interpreter tier). Hit 3 lanes in one session; one read a correct `+2` as `−10`. Always pair the lever with a currently-PASSING control
- [shape-matrix-is-not-a-population-estimate](reference_shape_matrix_is_not_a_population_estimate.md) — a matrix of shapes says which shapes exist, never how many files have them

### Development methodology & codegen hazards

- **Shared ctx structures, THREE-sided rule** — before WRITING enumerate its **readers**; before MOVING data OUT its **mutators**; before gating **correctness** on it, check what consumers merely *tolerate* — [shared-structure-rules](reference_shared_structure_readers_and_mutators.md)
- **A bail's COMMENT and its TEST both go stale** — a test pinning a bail cannot fail when the bail becomes unnecessary, so it defends the defect. Re-derive from a fresh matrix; exclude on a CONTROL, never admit on LANE IDENTITY — [stale-bail-comment-and-test](reference_stale_bail_comment_and_its_test_defend_the_defect.md)
- reference_valid_wasm_is_not_correct_verify_by_value · reference_broken_instrument_can_still_give_right_answer · reference_abmts_harness_swap_is_not_self_safe
- feedback_spec_first_fixes · feedback_compile_away · feedback_nothing_impossible · feedback_refactoring_failures · project_type_index_shift_and_deadelim · reference_subview_type_idx_stability
- project_brand_check_swap_savedbodies · reference_no_rebuild_helper_body_at_finalize · reference_shared_instr_object_dce_double_remap
- reference_1927_pipeline_pass_gates_fresh_errors · reference_2873_funcref_wrapper_chain_rtt_order · reference_3343_forlet_loopvar_module_global_alias_recursion
- **[bigger-number-with-a-silent-wrong-answer-is-NEGATIVE](reference_bigger_number_bought_with_a_silent_wrong_answer_is_negative_value.md)** — a conformance gain paid for by turning a loud refusal into a quiet wrong result is worse than not shipping
- **[wire-the-fix-at-the-NARROWEST-site](reference_wire_the_fix_at_the_narrowest_site_not_the_most_general.md)** — blast radius lives at the general point (−684 on #4055 v1). When a regression's mechanism resists isolation, NARROW until it's out of scope rather than chase it
- **[constant-folded-probe-tests-the-STATIC-path](reference_constant_folded_probe_tests_the_static_path.md)** — `new RegExp("a"+".c")` folds; the "dynamic" probe never ran. **A broken instrument announces itself as good news that arrives slightly too easily**
- [static-fast-path-claiming-a-case-it-cannot-handle](reference_static_fast_path_claiming_a_case_it_cannot_handle.md) — a fast path that accepts input it mishandles is worse than one that declines

### Model usage & reporting

- reference_fable5_is_frontier_claude_not_codex · reference_frontier_model_tier · feedback_opus5_is_frontier_tier_claims_fable_tasks
- feedback_devs_default_opus · feedback_sonnet_for_sprint_loop · feedback_po_uses_fable · feedback_sprint_status_format

### General behavior

- **[be-concise](feedback_be_concise.md)** — lead with the answer; status ≤5 sentences. Never cut numbers, denominators or hedges.
- feedback_ask_role · feedback_ask_ralph_loop · feedback_no_adhoc_scripts · feedback_wait_for_answer · feedback_no_nuclear_option · feedback_check_before_cleanup · feedback_external_comments_first_person
- reference_stale_isolation_binding_cross_worktree_write · feedback_sprint_tags · feedback_no_stash_before_merge · feedback_no_git_stash_in_worktree · feedback_no_git_stash_shared_worktree_conflict_markers
- **[git-init-bare-under-inherited-gitdir](reference_git_init_bare_under_inherited_gitdir_breaks_every_worktree.md)** — `git init --bare` with `GIT_DIR` set re-inits `$GIT_DIR`, sets `core.bare=true` SHARED, kills every worktree. Scrub the git env in subprocesses.
- [grep-false-empty-dollar-NUL](reference_grep_dollar_anchor_and_shell_expansion_false_empty.md) — `$`=anchor, `"$var"`=shell-expanded, **NUL byte ⇒ binary (`grep -a`)**
- reference_git_corrupt_loose_object_refetch · reference_gh_remove_label_rest_not_pr_edit · reference_skipped_needs_if_pattern · reference_subissue_filename_dupid_gate · reference_git_show_ref_glob_no_expand_use_ls_tree
- feedback_check_declared_rebaseline_before_crying_corruption · reference_worktree_pnpm_install_corrupts_shared_node_modules · reference_untested_recovery_paths_rot_silently · reference_label_evidence_by_source_before_reasoning
- reference_grep_false_empties_diff_test262 · reference_false_done_audit_nnnn_vs_wasm_funcidx · reference_runtest262file_not_ci_path_status_only · reference_baseline_jsonl_authoritative_over_local_repro_status · reference_surgical_baselines_push_partial_clone
- reference_park_diagnosis_check_runs_on_sha_not_run_jobs · reference_admin_merge_active_queue_conflict_not_orphan · reference_compile_time_guard_1942_flake_skips_promote
- [git-checkout--b-silently-does-not-switch](reference_git_checkout_dash_b_silently_does_not_switch.md) — verify the branch you landed on, never assume the checkout moved
- **[stale-ref-locks-make-fetch-silently-not-update](reference_stale_ref_locks_make_fetch_silently_not_update.md)** — ahead/behind read from a tracking ref `fetch` could not write is confidently WRONG. Use `ls-remote`, or the server-side `compare` API for ancestry
- [precommit-hook-exceeds-tool-timeout](reference_precommit_hook_exceeds_tool_timeout_leaves_stash_debris.md) — leaves `lint-staged automatic backup` entries on the SHARED stash stack; the commit still lands. Clear only your own two

### Merge queue & fork topology

- feedback_branch_from_upstream_main_not_fork · project_fork_origin_behind_upstream_pr_base · reference_fork_origin_behind_upstream
- project_dup_prs_upstream_vs_fork_same_branch_name · feedback_batch_doc_commits_before_pr_push · project_sprint64_parallel_session_dup_prs · feedback_longlived_branch_silent_revert
- reference_pr_creation_500_bisect_before_blaming_local_setup · reference_pr_stuck_mergeable_null_only_cla_runs
- reference_cross_session_issue_id_collision_renumber_loser · reference_hold_label_does_not_dequeue_inflight_merge_queue_pr · reference_issue_id_collides_while_pr_is_open · reference_change_scoped_allowance_wedges_postmerge_promote
- **[queue-snapshots-HEAD-at-enqueue-time](reference_merge_queue_snapshots_head_at_enqueue_time.md)** — a later push is not rejected, it is SILENTLY ABSENT from the merged SHA. `BEHIND` is NOT "not queued". **Verify CONTENT on main; three levels of merge verification**
- [unstable-FAILED-vs-UNFINISHED](reference_unstable_failed_vs_unfinished_before_rerunning.md) — distinguish the two before re-running; `UNSTABLE` is never auto-enqueued either way

### Substrate / value-rep / standalone root-causes

- ACTIVE: [any-string-value-read-substrate (project)](project_standalone_any_string_value_read_substrate.md) · [any-string-value-read-substrate (ref)](reference_standalone_any_string_value_read_substrate.md) · [s64-value-rep-next](project_s64_value_rep_substrate_next.md) · [wasm-linking-core-over-component](project_wasm_linking_core_over_component.md) · [1355-proxy-remaining-traps](project_1355_proxy_remaining_traps_blockers.md)
- Narrow one-issue root-causes: **`ls memory/` and grep** — families: value-rep/dispatch (2151, 2186, 2358, 2040, 2583), late-import funcIdx-shift (1461, 2191, 2193), rep-scale (2379, string_global_sentinel_guard), misc one-offs.
