# ts2wasm Project Memory

## CRITICAL RULES (check every time)

- **SILENT-EMPTY IS THE DEFAULT HYPOTHESIS** — empty/zero/green from an unproven tool is indistinguishable from a real result. Positive control · floor the count · print provenance · verify by reverting — [silent-empty-is-indistinguishable-from-real](reference_silent_empty_is_indistinguishable_from_real.md)
- **MEASURE, NEVER EXTRAPOLATE** — no sizing off cluster labels; "compiles"≠"passes"; "gates N"≠"flips N"; always give denominators — [measure-never-extrapolate](feedback_measure_never_extrapolate.md)
- **`origin` IS THE FORK in /workspace** — verify landed code against `upstream/main` by merge-commit ancestry — [origin-is-the-fork-verify-against-upstream-main](reference_origin_is_the_fork_verify_against_upstream_main.md)
- **ALWAYS spawn writers as teammates** + `isolation: worktree` + bypassPermissions; never bare subagents for writers.
- **BEFORE EVERY git add/commit**: `pwd && git branch --show-current`. Never `git add -A`.
- **Commit AUTHOR must be the user** (`Thomas Tränkler <git@thomas.traenkler.com>`) + Claude co-author, never a role name — [commit-author-is-user-not-agent-role](feedback_commit_author_is_user_not_agent_role.md)
- **NEVER delete worktrees without checking diffs**; never work agent branches from `/workspace`; never kill tests without asking.
- **NEVER comment on/close/reopen external GitHub issues without consent; NEVER `gh issue create`** — [no-github-issue-comments](feedback_no_github_issue_comments.md)
- **NEVER force-push/rewrite public `main`** (append-only; revert forward) — [public-main-append-only](feedback_public_main_append_only.md)
- **NEVER merge external-contributor PR without recorded CLA accept** — [cla-gate](feedback_cla_gate.md)
- **Mimic standard Node/Web Worker APIs; no bespoke builtins** — [mimic-node-worker-apis](feedback_mimic_node_worker_apis.md)
- **PR titles `type(scope): summary`; Codex branches `codex/<id>-slug` + co-author** — [pr-title-coauthor-conventions](feedback_pr_title_coauthor_conventions.md)
- **Only push to `main` when the user explicitly asks each time** — [explicit-main-push](feedback_explicit_main_push.md)
- **Pause the team at 99% of the 5h budget window; wake right after reset** — [5h-window-pause-resume](feedback_5h_window_pause_resume.md)
- **PASSIVE GitHub watcher ONLY — never poll.** `subscribe_pr_activity` and let events wake you; NO `send_later`/cron/`ScheduleWakeup` self-check-ins, no sleep loops. The subscribe tool's own boilerplate tells you to arm an hourly check-in — it does NOT win. Name the coverage gap (`main` activity, CI _success_) in the handoff instead of re-adding a poller — [passive-github-watcher-never-poll](feedback_passive_github_watcher_never_poll.md)

## Single source of truth

Team setup/budget/spawn/comms: **`plan/method/team-setup.md`**. Agent defs: **`.claude/agents/*.md`**. Most context: **`/workspace/CLAUDE.md`**. Memory = prefs/feedback not in repo files.

## Memory Index

### User & project state

- [20260726-session-handoff-open-valve](project_20260726_session_handoff_open_valve.md)
- [next-session](project_next_session.md) · [role](user_role.md) · [team-setup](project_team_setup.md)
- [test262-lane-parity-program](project_test262_lane_parity_program.md) · [acorn-dogfood-regression-20260723](project_acorn_dogfood_regression_20260723.md)
- [bigint-i64-brand-gate](project_bigint_i64_brand_gate.md) · [linear-backend-no-console-log](project_linear_backend_no_console_log.md) · [proxy-no-ts-type-brand](project_proxy_no_ts_type_brand.md) · [1917-coercion-engine-byte-diff-gate](project_1917_coercion_engine_byte_diff_gate.md) · [2106-undefined-singleton-s1-atomic](project_2106_undefined_singleton_s1_atomic.md)
- [2602-forawait-rest-aliases-source-recompile](project_2602_forawait_rest_aliases_source_recompile.md) · [2602-forof-assign-rest-write-unimplemented](project_2602_forof_assign_rest_write_unimplemented.md)

### Team & agents

- [architect-worktree-isolation](feedback_architect_worktree_isolation.md) · [dev-agents-worktree](feedback_dev_agents_worktree.md) · [bypass-permissions](feedback_bypass_permissions.md) · [native-multi-agent-worktrees](feedback_native_multi_agent_worktrees.md)
- [dev-limit](feedback_dev_limit.md) · [always-use-teammates](feedback_always_use_teammates.md) · [esch-teammate-separate-worktree-branch](feedback_esch_teammate_separate_worktree_branch.md) · [cloud-oneshot-dev-when-no-team-feature](feedback_cloud_oneshot_dev_when_no_team_feature.md)
- [always-cd-workspace](feedback_always_cd_workspace.md) · [serialize-cherry-picks](feedback_serialize_cherry_picks.md) · [ttl-runs-tests](feedback_ttl_runs_tests.md) · [work-planning](feedback_work_planning.md) · [dev-self-serve-tasklist](feedback_dev_self_serve_tasklist.md) · [tasklist-always-populated](feedback_tasklist_always_populated.md) · [sprint-autofill-es3-es5](feedback_sprint_autofill_es3_es5.md)
- [spawn-self-serving-loopers-not-oneshot](feedback_spawn_self_serving_loopers_not_oneshot.md) · [maintain-fleet-and-sweep-drift-when-quiet](feedback_maintain_fleet_and_sweep_drift_when_quiet.md)
- [usage-limit](feedback_usage_limit.md) · [dont-ask-continue](feedback_dont_ask_continue.md) · [token-budget-guardrails](feedback_token_budget_guardrails.md) · [budget-is-own-agents-pipeline-not-idle](feedback_budget_is_own_agents_pipeline_not_idle.md)
- [context-discipline](feedback_context_discipline.md) · [compact-before-sprint](feedback_compact_before_sprint.md) · [diary-and-sprints-before-compact](feedback_diary_and_sprints_before_compact.md)
- [notify-only-on-real-input-needs-with-specific-text](feedback_notify_only_on_real_input_needs_with_specific_text.md)
- [sendmessage-discipline](feedback_sendmessage_discipline.md) · [reduce-notification-noise](feedback_reduce_notification_noise.md) · [team-comm-channels](feedback_team_comm_channels.md)
- [dev-silence-protocol](feedback_dev_silence_protocol.md) · [idle-notification-silence](feedback_idle_notification_silence.md) · [passive-github-watcher-never-poll](feedback_passive_github_watcher_never_poll.md)
- [task-tools-are-deferred-toolsearch-before-calling](reference_task_tools_are_deferred_toolsearch_before_calling.md)
- [tasklist-sync-unreliable](feedback_tasklist_sync_unreliable.md) · [no-keep-pane](feedback_no_keep_pane.md) · [agent-self-termination](feedback_agent_self_termination.md) · [background-teammate-shutdown-limitation](feedback_background_teammate_shutdown_limitation.md)

### Dispatch & shepherding

- [dispatch-status](feedback_dispatch_status.md) · [dedicated-pr-shepherd](feedback_dedicated_pr_shepherd.md) · [lead-shepherds-prs](feedback_lead_shepherds_prs.md) · [auto-ff-workspace-main](feedback_auto_ff_workspace_main.md) · [merge-queue-wedge-recovery](feedback_merge_queue_wedge_recovery.md) · [reconcile-carried-slate-against-git-on-reopen](feedback_reconcile_carried_slate_against_git_on_reopen.md)
- [no-duplicate-issue-dispatch](feedback_no_duplicate_issue_dispatch.md) · [dispatch-against-upstream-not-stale-fork](feedback_dispatch_against_upstream_not_stale_fork.md) · [mandatory-predispatch-gate-and-lane-partition](feedback_mandatory_predispatch_gate_and_lane_partition.md)
- [slice-claim-collision-check-assignments-log](feedback_slice_claim_collision_check_assignments_log.md) · [shared-worktree-clobber-check-claim-first](feedback_shared_worktree_clobber_check_claim_first.md) · [no-shared-worktree-assignment](feedback_no_shared_worktree_assignment.md) · [release-claim-on-standdown-multiphase-issue](feedback_release_claim_on_standdown_multiphase_issue.md)

### Issue management

- [issue-completion](feedback_issue_completion.md) · [unblock-on-completion](feedback_unblock_on_completion.md) · [document-findings](feedback_document_findings.md) · [update-backlog](feedback_update_backlog.md) · [po-boundary](feedback_po_boundary.md) · [bare-numbers-are-plan-tasks](feedback_bare_numbers_are_plan_tasks.md)
- [verify-fix-in-git-not-narrative](feedback_verify_fix_in_git_not_narrative.md) · [reground-spec-against-current-main](feedback_reground_spec_against_current_main.md) · [verify-first-beats-architect-spec](feedback_verify_first_beats_architect_spec.md)

### Testing & CI gates

- [test262-worktree](feedback_test262_worktree.md) · [worktree-symlink-dependencies](feedback_worktree_symlink_dependencies.md) · [test262-recheck](feedback_test262_recheck.md) · [test262-skip-issues](feedback_test262_skip_issues.md) · [never-delete-test-data](feedback_never_delete_test_data.md) · [ask-before-killing-tests](feedback_ask_before_killing_tests.md)
- [never-diff-local-sweep-against-committed-ci-baseline](reference_never_diff_local_sweep_against_committed_ci_baseline.md)
- [baseline-drift-cross-check](feedback_baseline_drift_cross_check.md) · [verify-local-repro-against-known-good-control](feedback_verify_local_repro_against_known_good_control.md) · [regression-analysis](feedback_regression_analysis.md) · [standalone-floor-only-on-merge-group](project_standalone_floor_only_on_merge_group.md) · [broad-impact-validate-full-ci](project_broad_impact_validate_full_ci.md)
- **[acceptance-bar-denominator-and-killswitch-attribution](reference_acceptance_bar_denominator_and_killswitch_attribution.md) — GOLD STANDARD for "did this help?": validate instrument vs known baseline · prove attribution by kill-switch REMOVAL · floor the row count · check the bar's DENOMINATOR before calling it a shortfall**
- [f1-honest-floor-deinflation-landing-recipe](reference_f1_honest_floor_deinflation_landing_recipe.md)
- [verifyproperty-vacuous-both-lanes-two-root-causes](reference_verifyproperty_vacuous_both_lanes_two_root_causes.md)
- [standalone-floor-inflated-three-vacuity-mechanisms](reference_standalone_floor_inflated_three_vacuity_mechanisms.md) · [standalone-floor-inflated-by-exception-swallow](reference_standalone_floor_inflated_by_exception_swallow.md) · [standalone-floor-object-identity-and-real-vs-drift](reference_standalone_floor_object_identity_and_real_vs_drift.md)
- [merge-queue-park-triage-four-causes](reference_merge_queue_park_triage_four_causes.md)
- [merge-group-gate-reads-a-moving-baseline](reference_merge_group_gate_reads_a_moving_baseline.md)
- [baseline-promote-trap-gate-two-failure-modes](reference_baseline_promote_trap_gate_two_failure_modes.md) · [verdict-logic-change-must-bump-oracle-version](reference_verdict_logic_change_must_bump_oracle_version.md)
- [ci-status-feed-retired-use-required-checks](reference_ci_status_feed_retired_use_required_checks.md) · [ci-gate-change-scoped-not-wholetree-absolute](reference_ci_gate_change_scoped_not_wholetree_absolute.md)
- [two-checks-share-a-name-head1-watcher-settles-on-a-stub](reference_two_checks_share_a_name_head1_watcher_settles_on_a_stub.md) — a check NAME is not an identifier; filter `skipping`, never `head -1`
- [workflow-touching-prs-never-autoenqueue](reference_workflow_touching_prs_never_autoenqueue.md) — **FALSIFIED as stated** (fork-head was the real correlate); ALWAYS check the queue before enqueuing
- [never-push-to-a-queued-pr-it-ejects-to-the-back](reference_never_push_to_a_queued_pr_it_ejects_to_the_back.md) · [autoenqueue-grace0-races-mergestate-recompute](reference_autoenqueue_grace0_races_mergestate_recompute.md)
- [dropped-synchronize-only-cla-check-repush](reference_dropped_synchronize_only_cla_check_repush.md)
- [quality-failfast-masks-downstream-gates](reference_quality_failfast_masks_downstream_gates.md)
- [baseline-gates-need-postmerge-autorefresh](reference_baseline_gates_need_postmerge_autorefresh.md) · [ci-quality-format-uses-prettier-not-biome](reference_ci_quality_format_uses_prettier_not_biome.md) · [trigger-deploy-pages](feedback_trigger_deploy_pages.md) · [cla-check-rerun-after-merge-commit](feedback_cla_check_rerun_after_merge_commit.md)
- [host-restore-triage-verify-first-measure](reference_host_restore_triage_verify_first_measure.md) · [error-analysis](reference_error_analysis.md) · [standalone-harvest-rootcausemap-mislabeled](reference_standalone_harvest_rootcausemap_mislabeled.md) · [wrapforhost-setexports-harness](project_wrapforhost_setexports_harness.md)

### Development methodology & codegen hazards

- [valid-wasm-is-not-correct-verify-by-value](reference_valid_wasm_is_not_correct_verify_by_value.md)
- [broken-instrument-can-still-give-right-answer](reference_broken_instrument_can_still_give_right_answer.md)
- [abmts-harness-swap-is-not-self-safe](reference_abmts_harness_swap_is_not_self_safe.md)
- [spec-first-fixes](feedback_spec_first_fixes.md) · [compile-away](feedback_compile_away.md) · [nothing-impossible](feedback_nothing_impossible.md) · [refactoring-failures](feedback_refactoring_failures.md) · [type-index-shift-and-deadelim](project_type_index_shift_and_deadelim.md) · [subview-type-idx-stability](reference_subview_type_idx_stability.md)
- [brand-check-swap-savedbodies](project_brand_check_swap_savedbodies.md) · [no-rebuild-helper-body-at-finalize](reference_no_rebuild_helper_body_at_finalize.md) · [shared-instr-object-dce-double-remap](reference_shared_instr_object_dce_double_remap.md)
- [1927-pipeline-pass-gates-fresh-errors](reference_1927_pipeline_pass_gates_fresh_errors.md) · [2873-funcref-wrapper-chain-rtt-order](reference_2873_funcref_wrapper_chain_rtt_order.md) · [3343-forlet-loopvar-module-global-alias-recursion](reference_3343_forlet_loopvar_module_global_alias_recursion.md)

### Model usage & reporting

- [fable5-is-frontier-claude-not-codex](reference_fable5_is_frontier_claude_not_codex.md) · [frontier-model-tier](reference_frontier_model_tier.md)
- [opus5-is-frontier-tier-claims-fable-tasks](feedback_opus5_is_frontier_tier_claims_fable_tasks.md)
- [devs-default-opus](feedback_devs_default_opus.md) · [sonnet-for-sprint-loop](feedback_sonnet_for_sprint_loop.md) · [po-uses-fable](feedback_po_uses_fable.md) · [sprint-status-format](feedback_sprint_status_format.md)

### General behavior

- [ask-role](feedback_ask_role.md) · [ask-ralph-loop](feedback_ask_ralph_loop.md) · [no-adhoc-scripts](feedback_no_adhoc_scripts.md) · [wait-for-answer](feedback_wait_for_answer.md) · [no-nuclear-option](feedback_no_nuclear_option.md) · [check-before-cleanup](feedback_check_before_cleanup.md) · [external-comments-first-person](feedback_external_comments_first_person.md)
- [stale-isolation-binding-cross-worktree-write](reference_stale_isolation_binding_cross_worktree_write.md) · [sprint-tags](feedback_sprint_tags.md) · [no-stash-before-merge](feedback_no_stash_before_merge.md) · [no-git-stash-in-worktree](feedback_no_git_stash_in_worktree.md) · [no-git-stash-shared-worktree-conflict-markers](feedback_no_git_stash_shared_worktree_conflict_markers.md)
- [git-corrupt-loose-object-refetch](reference_git_corrupt_loose_object_refetch.md) · [gh-remove-label-rest-not-pr-edit](reference_gh_remove_label_rest_not_pr_edit.md) · [skipped-needs-if-pattern](reference_skipped_needs_if_pattern.md) · [subissue-filename-dupid-gate](reference_subissue_filename_dupid_gate.md) · [git-show-ref-glob-no-expand-use-ls-tree](reference_git_show_ref_glob_no_expand_use_ls_tree.md)
- [check-declared-rebaseline-before-crying-corruption](feedback_check_declared_rebaseline_before_crying_corruption.md) · [worktree-pnpm-install-corrupts-shared-node-modules](reference_worktree_pnpm_install_corrupts_shared_node_modules.md) · [untested-recovery-paths-rot-silently](reference_untested_recovery_paths_rot_silently.md) · [label-evidence-by-source-before-reasoning](reference_label_evidence_by_source_before_reasoning.md)
- [grep-dollar-anchor-and-shell-expansion-false-empty](reference_grep_dollar_anchor_and_shell_expansion_false_empty.md) — grepping CI/shell text containing `$` silently returns 0 (`$`=anchor, `"$var"`=expanded). NOT a ugrep bug — `\|` works
- [grep-false-empties-diff-test262](reference_grep_false_empties_diff_test262.md) · [false-done-audit-nnnn-vs-wasm-funcidx](reference_false_done_audit_nnnn_vs_wasm_funcidx.md) · [runtest262file-not-ci-path-status-only](reference_runtest262file_not_ci_path_status_only.md) · [baseline-jsonl-authoritative-over-local-repro-status](reference_baseline_jsonl_authoritative_over_local_repro_status.md) · [surgical-baselines-push-partial-clone](reference_surgical_baselines_push_partial_clone.md)
- [park-diagnosis-check-runs-on-sha-not-run-jobs](reference_park_diagnosis_check_runs_on_sha_not_run_jobs.md) · [admin-merge-active-queue-conflict-not-orphan](reference_admin_merge_active_queue_conflict_not_orphan.md) · [compile-time-guard-1942-flake-skips-promote](reference_compile_time_guard_1942_flake_skips_promote.md)

### Merge queue & fork topology

- [branch-from-upstream-main-not-fork](feedback_branch_from_upstream_main_not_fork.md) · [fork-origin-behind-upstream-pr-base](project_fork_origin_behind_upstream_pr_base.md) · [fork-origin-behind-upstream](reference_fork_origin_behind_upstream.md)
- [dup-prs-upstream-vs-fork-same-branch-name](project_dup_prs_upstream_vs_fork_same_branch_name.md) · [batch-doc-commits-before-pr-push](feedback_batch_doc_commits_before_pr_push.md) · [sprint64-parallel-session-dup-prs](project_sprint64_parallel_session_dup_prs.md) · [longlived-branch-silent-revert](feedback_longlived_branch_silent_revert.md)
- [pr-creation-500-bisect-before-blaming-local-setup](reference_pr_creation_500_bisect_before_blaming_local_setup.md)
- [pr-stuck-mergeable-null-only-cla-runs](reference_pr_stuck_mergeable_null_only_cla_runs.md)
- [cross-session-issue-id-collision-renumber-loser](reference_cross_session_issue_id_collision_renumber_loser.md) · [hold-label-does-not-dequeue-inflight-merge-queue-pr](reference_hold_label_does_not_dequeue_inflight_merge_queue_pr.md)
- [change-scoped-allowance-wedges-postmerge-promote](reference_change_scoped_allowance_wedges_postmerge_promote.md)
- [issue-id-collides-while-pr-is-open](reference_issue_id_collides_while_pr_is_open.md)

### Substrate / value-rep / standalone root-causes

- ACTIVE: [standalone-any-string-value-read-substrate](project_standalone_any_string_value_read_substrate.md) · [standalone-any-string-value-read-substrate](reference_standalone_any_string_value_read_substrate.md) · [s64-value-rep-substrate-next](project_s64_value_rep_substrate_next.md) · [wasm-linking-core-over-component](project_wasm_linking_core_over_component.md) · [1355-proxy-remaining-traps-blockers](project_1355_proxy_remaining_traps_blockers.md)
- Narrow one-issue root-causes: **`ls memory/` and grep** — families: value-rep/dispatch (2151, 2186, 2358, 2040, 2583), late-import funcIdx-shift (1461, 2191, 2193), rep-scale (2379, string_global_sentinel_guard), misc one-offs.
