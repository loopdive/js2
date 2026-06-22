# ts2wasm Project Memory

## CRITICAL RULES (check every time)
- **ALWAYS spawn agents as teammates** (TeamCreate + Agent with team_name), NOT bare subagents.
- **Max 3 dev agents + 1 PO.** Each dev ~2GB RSS. Always use bypassPermissions + worktree isolation.
- **BEFORE EVERY git add/commit**: run `pwd && git branch --show-current` to verify you're in `/workspace` on `main`. Agent worktrees change your cwd silently.
- **NEVER use `git add -A`** — it stages everything including worktree artifacts. Use `git add <specific files>` instead.
- **NEVER delete worktrees without checking diffs first.** Run `git -C <wt> diff --stat` for EACH one, show to user, ask before deleting.
- **NEVER work on agent branches/worktrees.** Always verify `pwd` is `/workspace` and branch is `main` before edits/commits.
- **NEVER kill running tests without asking.**
- **NEVER comment on/close/reopen GitHub issues opened by external users without consent, and NEVER `gh issue create`** — track internal work in `plan/issues/<id>-slug.md`. See [feedback_no_github_issue_comments.md](feedback_no_github_issue_comments.md).
- **NEVER force-push or rewrite published history on public `main`** — append-only; fix forward via revert PRs (it already broke guest271314's pull). See [feedback_public_main_append_only.md](feedback_public_main_append_only.md).
- **NEVER merge an external-contributor PR without a recorded affirmative CLA acceptance** — `cla-check.yml` is a placeholder stub; hold guest271314's #589 until a real CLA accept. See [feedback_cla_gate.md](feedback_cla_gate.md).
- **Mimic standard Node.js / Web Worker APIs; never invent bespoke compiler builtins** (no `readStdin`/`writeStdout`). See [feedback_mimic_node_worker_apis.md](feedback_mimic_node_worker_apis.md).
- **PR titles, Codex branches, and Codex commits use repo convention** — PR titles are `type(scope): concise summary` without `[codex]`; Codex issue branches are `codex/<issue-id>-<slug>`; Codex-authored commits include `Co-authored-by: Codex <codex@openai.com>`. See [feedback_pr_title_coauthor_conventions.md](feedback_pr_title_coauthor_conventions.md).

## Single source of truth
- Team setup, memory budget, spawn config, communication protocol: **`plan/method/team-setup.md`**
- Agent definitions: **`.claude/agents/{product-owner,developer,tester}.md`**
- Memory files below store only user prefs/feedback that don't belong in repo files.

## Memory Index

### User & project
- [user_role.md](user_role.md) — Project lead: challenges assumptions, thinks in compilation strategies
- [project_team_setup.md](project_team_setup.md) — All agents as teammates via TeamCreate; details in plan/method/team-setup.md
- [project_next_session.md](project_next_session.md) — Session state: 16,013 pass, honest baseline after exception tag fix
- [project_bigint_i64_brand_gate.md](project_bigint_i64_brand_gate.md) — #1349/#1644 BigInt fixes gated on architect i64-bigint-brand ValType decision; not a dev codegen guard
- [project_linear_backend_no_console_log.md](project_linear_backend_no_console_log.md) — Linear backend (target:"linear", non-WASI) drops console.log; it's return-value-oriented — cross-backend/diff tests must assert return values, not stdout (#1854)
- [project_proxy_no_ts_type_brand.md](project_proxy_no_ts_type_brand.md) — A JS Proxy carries no TS-type brand (types as its target); never static-classify a possibly-proxy receiver — detect syntactically + defer to host (#2501 proxy-revoked regression)
- [project_2602_forawait_rest_aliases_source_recompile.md](project_2602_forawait_rest_aliases_source_recompile.md) — #2602: for-await array-rest `y` aliases the SOURCE array under a fresh compileExpression (recompile→source len 3, not rest slice 2); blocks #2580 M2 slice 1; async-lane local-versioning, not substrate — recompiling an identifier ≠ its live local in the async state machine

### Team & agents (rules not in plan/method/team-setup.md)
- [feedback_architect_worktree_isolation.md](feedback_architect_worktree_isolation.md) — Always spawn architects with isolation:worktree — they stall and request respawn without it
- [feedback_dev_limit.md](feedback_dev_limit.md) — Max 4 devs as teammates, test file naming, merge method
- [feedback_dev_agents_worktree.md](feedback_dev_agents_worktree.md) — ALL writing agents must use worktree isolation
- [feedback_esch_teammate_separate_worktree_branch.md](feedback_esch_teammate_separate_worktree_branch.md) — Keep Esch teammate work in its own dedicated worktree and branch
- [feedback_serialize_cherry_picks.md](feedback_serialize_cherry_picks.md) — Wait for wave to finish, then batch merge (not cherry-pick)
- [feedback_always_cd_workspace.md](feedback_always_cd_workspace.md) — Git safety: cd /workspace, verify main, never work from agent worktrees
- [feedback_usage_limit.md](feedback_usage_limit.md) — Stop dispatching above 90% context usage
- [feedback_dont_ask_continue.md](feedback_dont_ask_continue.md) — Keep dispatching automatically, don't pause to ask
- [feedback_reduce_notification_noise.md](feedback_reduce_notification_noise.md) — Only msg team-lead for merges/blockers/decisions, use TaskUpdate otherwise
- [feedback_always_use_teammates.md](feedback_always_use_teammates.md) — Team: 4 devs + PO on demand, always as teammates via TeamCreate
- [feedback_work_planning.md](feedback_work_planning.md) — Pre-build task queue, any dev on any task, time-box, batch merges
- [feedback_ttl_runs_tests.md](feedback_ttl_runs_tests.md) — TTL runs tests serially in background, no tester teammate
- [feedback_bypass_permissions.md](feedback_bypass_permissions.md) — Always use bypassPermissions mode when spawning agents
- [feedback_dev_self_serve_tasklist.md](feedback_dev_self_serve_tasklist.md) — Devs claim next task from TaskList after merge; no re-dispatch
- [feedback_tasklist_always_populated.md](feedback_tasklist_always_populated.md) — Populate TaskList at sprint start AND whenever a new issue is added mid-sprint; empty queue = agents spin idle
- [feedback_sprint_autofill_es3_es5.md](feedback_sprint_autofill_es3_es5.md) — When sprint queue runs dry, auto-pull ES3/ES5-fixing tasks into the current sprint
- [feedback_compact_before_sprint.md](feedback_compact_before_sprint.md) — Run /compact at sprint boundaries to reset context and control token burn
- [feedback_context_discipline.md](feedback_context_discipline.md) — Don't re-check state; split planning/execution sessions; write handoffs to plan/agent-context/tech-lead.md
- [feedback_team_comm_channels.md](feedback_team_comm_channels.md) — Dev status via TaskUpdate not verbose SendMessage; shutdown handoffs via agent-context files
- [feedback_token_budget_guardrails.md](feedback_token_budget_guardrails.md) — Warn at 25% weekly budget, force break at 40%, hard stop at 50%
- [feedback_diary_and_sprints_before_compact.md](feedback_diary_and_sprints_before_compact.md) — Update plan/diary.md and plan/issues/sprints/N/sprint.md (+ retrospective) BEFORE /compact — never discard learnings with the conversation
- [feedback_tasklist_sync_unreliable.md](feedback_tasklist_sync_unreliable.md) — DISPATCH MODEL (2026-05-23): native TaskList auto-dispatch is canonical; tech lead reconciles (mark merged done immediately), doesn't route manually; SendMessage dispatch is break-glass only
- [feedback_ignore_unreliable_autodispatch.md](feedback_ignore_unreliable_autodispatch.md) — SUPERSEDED 2026-05-23 by native auto-dispatch switch. Devs now trust auto-dispatch; only verify live state (is it merged/owned?) before claiming. Ignoring auto-dispatch wholesale is break-glass only.
- [feedback_sendmessage_discipline.md](feedback_sendmessage_discipline.md) — SendMessage = blockers/decisions/completions only; status/idle/ack → TaskUpdate or silence
- [feedback_dev_silence_protocol.md](feedback_dev_silence_protocol.md) — No idle_notification messages ever; devs silent during CI-wait; TL keeps queue full, devs escalate only
- [feedback_idle_notification_silence.md](feedback_idle_notification_silence.md) — An idle ping is a STATE signal: resolve it (TaskList task w/owner / shutdown / recognize stale), never just stay silent — "silence breaks the loop" is false (pings are timer-driven)
- [feedback_no_ci_wait.md](feedback_no_ci_wait.md) — Dev agents open PR then immediately move on; CI monitoring = tech lead's job via auto-merge monitor
- [feedback_no_keep_pane.md](feedback_no_keep_pane.md) — Never tell agents "do NOT kill your pane" — always terminate after PR; wait for a slot to open instead
- [feedback_agent_self_termination.md](feedback_agent_self_termination.md) — Architects idle after finishing instead of self-terminating; added Termination section to architect.md; always include kill-pane in spawn prompts

### Dispatch
- [feedback_dispatch_status.md](feedback_dispatch_status.md) — Update issue status to in-progress when dispatching an agent
- [feedback_dedicated_pr_shepherd.md](feedback_dedicated_pr_shepherd.md) — Always staff a dedicated PR-queue shepherd as a standing team role; don't hand-shepherd the merge queue ad-hoc (it strands/wedges when the lead is busy)
- [feedback_auto_ff_workspace_main.md](feedback_auto_ff_workspace_main.md) — Auto-ff /workspace main to origin/main whenever origin is ahead (Stop+SessionStart hook in .claude/settings.json); stale /workspace gave a wrong 14/67 sprint count
- [feedback_slice_claim_collision_check_assignments_log.md](feedback_slice_claim_collision_check_assignments_log.md) — Slice-granular (id:slice) claims can double-dispatch; check issue-assignments log for sole ownership + watch for foreign edits in your worktree before committing

### Issue management
- [feedback_issue_completion.md](feedback_issue_completion.md) — Completion procedure: move, frontmatter, summary, log, unblock
- [feedback_unblock_on_completion.md](feedback_unblock_on_completion.md) — After marking done: grep depends_on for completed ID, flip blocked/backlog→ready
- [feedback_document_findings.md](feedback_document_findings.md) — Document agent findings in issue files before closing
- [feedback_update_backlog.md](feedback_update_backlog.md) — Always update backlog.md when creating/completing issues
- [feedback_po_boundary.md](feedback_po_boundary.md) — PO only writes to plan/
- [feedback_bare_numbers_are_plan_tasks.md](feedback_bare_numbers_are_plan_tasks.md) — Bare numbers refer to local plan issues/tasks unless user explicitly says GitHub issue or PR

### Testing
- [project_wrapforhost_setexports_harness.md](project_wrapforhost_setexports_harness.md) — Host-closure / Promise-combinator probes need imports.setExports(instance.exports) after instantiate or __is_closure is undefined (false "not a closure" reading)
- [feedback_trigger_deploy_pages.md](feedback_trigger_deploy_pages.md) — After any [skip ci] baseline refresh, manually trigger deploy-pages.yml so GitHub Pages shows the new pass rate
- [feedback_test262_worktree.md](feedback_test262_worktree.md) — Test262 in worktree, not main wc
- [feedback_worktree_symlink_dependencies.md](feedback_worktree_symlink_dependencies.md) — Symlink `test262` and `node_modules` into new worktrees
- [feedback_test262_recheck.md](feedback_test262_recheck.md) — Default --recheck for test262, npm test for vitest
- [feedback_test262_skip_issues.md](feedback_test262_skip_issues.md) — Every skip filter must have an issue
- [feedback_never_delete_test_data.md](feedback_never_delete_test_data.md) — Never delete test data/cache/runs without asking
- [feedback_ask_before_killing_tests.md](feedback_ask_before_killing_tests.md) — Never kill running tests without asking
- [feedback_baseline_drift_cross_check.md](feedback_baseline_drift_cross_check.md) — Cross-check CI regressions against other open PRs; sample locally — identical clusters across unrelated PRs are drift
- [project_standalone_floor_only_on_merge_group.md](project_standalone_floor_only_on_merge_group.md) — Standalone floor gate (#2097) runs only on merge_group, not PR; standalone regressions pass all PR checks then fail in the queue. Bisect via merged-report jsonl diff or local WebAssembly.validate
- [project_broad_impact_validate_full_ci.md](project_broad_impact_validate_full_ci.md) — Broad-impact changes (value-rep/dispatch/call-path/shared helpers) MUST validate via full local-ci (~68min) or merge_group, NEVER a scoped sweep — scoped "+N/0 regr" hides regressions outside the sample (3 PRs ejected 2026-06-21: #1837/#1838/#1844)
- [project_standalone_hostimport_gate_index_shift.md](project_standalone_hostimport_gate_index_shift.md) — Gating lib-global host-import registration under standalone (collectReferencedGlobalNames, #2520/PR#1787) reorders import/type table → wrong type idx → "throw expected externref, found call of type i64"
- [feedback_cla_check_rerun_after_merge_commit.md](feedback_cla_check_rerun_after_merge_commit.md) — Fork PR enqueue fails "cla-check expected" after a merge-main commit; gh run rerun the cla-check workflow to repost on the new head
- [reference_error_analysis.md](reference_error_analysis.md) — Test262 error analysis procedure

### Development methodology
- [feedback_spec_first_fixes.md](feedback_spec_first_fixes.md) — Always fetch the ECMAScript spec (tc39.es/ecma262) before fixing test failures; implement from fetched spec text, never from memory; cite spec section in commits
- [project_type_index_shift_and_deadelim.md](project_type_index_shift_and_deadelim.md) — Type-index hazards: dead-elimination prunes+remaps unreferenced WasmGC types; never push a struct type mid-class-collection (desyncs class struct typeidx); register shared types late+once
- [project_brand_check_swap_savedbodies.md](project_brand_check_swap_savedbodies.md) — fctx.body swaps that capture a throw/else branch must use pushBody/popBody (register savedBodies) or a late string-constant import shift skips the already-emitted receiver global.get → invalid wasm (#2563)

### Model usage
- [feedback_sonnet_for_sprint_loop.md](feedback_sonnet_for_sprint_loop.md) — Use Sonnet for routine tech-lead loop; Opus only for crisis/architecture
- [feedback_devs_default_opus.md](feedback_devs_default_opus.md) — Devs/sendevs/architects default to opus per agent defs; don't downgrade to sonnet without user OK

### Reporting
- [feedback_sprint_status_format.md](feedback_sprint_status_format.md) — Sprint status format: `s52: 17/82 done`

### General behavior
- [feedback_ask_role.md](feedback_ask_role.md) — Ask at conversation start: Tech Lead or Product Owner
- [feedback_ask_ralph_loop.md](feedback_ask_ralph_loop.md) — Ask if Ralph loop should be started for current goals
- [feedback_no_adhoc_scripts.md](feedback_no_adhoc_scripts.md) — Use existing scripts, never ad-hoc Python
- [feedback_nothing_impossible.md](feedback_nothing_impossible.md) — Don't label features impossible — find the compilation strategy
- [feedback_compile_away.md](feedback_compile_away.md) — Compile away, don't emulate — resolve JS semantics statically, zero runtime overhead
- [feedback_mimic_node_worker_apis.md](feedback_mimic_node_worker_apis.md) — No bespoke builtins (readStdin/writeStdout); expose standard Node.js (process.stdin/stdout) / Web Worker (postMessage) APIs and compile them to WASI
- [feedback_external_comments_first_person.md](feedback_external_comments_first_person.md) — GitHub/external comments in first-person singular ("I"), never "we"
- [feedback_pr_title_coauthor_conventions.md](feedback_pr_title_coauthor_conventions.md) — Follow project PR title conventions and add Codex co-author trailer for Codex-authored commits/PRs
- [feedback_native_multi_agent_worktrees.md](feedback_native_multi_agent_worktrees.md) — Prefer native Codex multi-agents over tmux harnesses; isolate writing agents in explicit git worktrees
- [feedback_no_nuclear_option.md](feedback_no_nuclear_option.md) — Never take destructive shortcuts without consent
- [feedback_wait_for_answer.md](feedback_wait_for_answer.md) — Ask then STOP — never act on assumed "yes" in the same message
- [feedback_check_before_cleanup.md](feedback_check_before_cleanup.md) — Check worktree diffs before removing
- [feedback_refactoring_failures.md](feedback_refactoring_failures.md) — After refactoring: check missing imports first, not circular deps
- [feedback_sprint_tags.md](feedback_sprint_tags.md) — Tag sprint-N/begin at start, sprint/N at end
- [feedback_no_stash_before_merge.md](feedback_no_stash_before_merge.md) — Never stash before merge, commit first
- [feedback_no_git_stash_in_worktree.md](feedback_no_git_stash_in_worktree.md) — NEVER `git stash` in a worktree; stash stack is shared across worktrees, concurrent agents clobber each other
- [feedback_explicit_main_push.md](feedback_explicit_main_push.md) — Only push to main when the user explicitly asks for that exact push each time
- [feedback_regression_analysis.md](feedback_regression_analysis.md) — Regressions may be false-positive exposure, not real regressions; `pass → compile_timeout` is runner-load flake unless baseline compile >5s

Most project context lives in `/workspace/CLAUDE.md`.

### Recovered cross-session notes (preserved 2026-06-21, #389 session)

- [feedback_background_teammate_shutdown_limitation.md](feedback_background_teammate_shutdown_limitation.md) — Background-spawned teammates can't complete the shutdown handshake; they clear on lead-session-end, not via shutdown_request
- [feedback_batch_doc_commits_before_pr_push.md](feedback_batch_doc_commits_before_pr_push.md) — Batch plan/doc commits into the first PR push; a 2nd doc-only commit re-triggers the full CI matrix on the new HEAD
- [feedback_branch_from_upstream_main_not_fork.md](feedback_branch_from_upstream_main_not_fork.md) — Branch ALL work from upstream/main (loopdive/js2), never the fork origin/main — the fork is ~1188 commits behind, causing CONFLICTING PRs, CI that never triggers, and silent duplicate work
- [feedback_budget_is_own_agents_pipeline_not_idle.md](feedback_budget_is_own_agents_pipeline_not_idle.md) — In a multi-session swarm, MY token budget = MY spawned agents + my orchestration only; pipeline agents (next slice during CI-wait) so the budget produces output, not idle-poll
- [feedback_dispatch_against_upstream_not_stale_fork.md](feedback_dispatch_against_upstream_not_stale_fork.md) — Dispatch from upstream/main probes, not stale fork frontmatter; claim handles ≠ agent names
- [feedback_merge_queue_wedge_recovery.md](feedback_merge_queue_wedge_recovery.md) — Recover a wedged GitHub merge queue (entries stuck AWAITING_CHECKS, no merge_group CI, Actions idle) by dequeue+re-enqueue
- [feedback_no_duplicate_issue_dispatch.md](feedback_no_duplicate_issue_dispatch.md) — Before dispatching/coding any sprint issue, verify it isn't already on upstream/main or fixed by an open PR in review
- [feedback_no_git_stash_shared_worktree_conflict_markers.md](feedback_no_git_stash_shared_worktree_conflict_markers.md) — Never git stash/pop in a worktree to A/B-test baselines; pop injects conflict markers into concurrent agents' plan files
- [feedback_no_shared_worktree_assignment.md](feedback_no_shared_worktree_assignment.md) — Never assign two agents to the same issue branch/worktree — uncommitted changes collide; check branch ownership before reassigning a task
- [feedback_reground_spec_against_current_main.md](feedback_reground_spec_against_current_main.md) — Before implementing a hard-issue spec, re-probe the failure against CURRENT main — sibling PRs may have moved the path; a stale 'architect-scale' framing can collapse to a narrow fix
- [feedback_shared_worktree_clobber_check_claim_first.md](feedback_shared_worktree_clobber_check_claim_first.md) — Before editing a continuation/PR-B branch a teammate may own, check the git claim lock by ISSUE id (not task id) — a co-owner's worktree reset silently reverts your edits
- [feedback_verify_fix_in_git_not_narrative.md](feedback_verify_fix_in_git_not_narrative.md) — When two sessions disagree on whether/how an issue is fixed, verify against actual upstream git history (commit ancestry + dedicated test presence), not either session's narrative or a stale worktree repro
- [project_1355_proxy_remaining_traps_blockers.md](project_1355_proxy_remaining_traps_blockers.md) — #1355 standalone Proxy: 5 traps landed; the remaining 4 are each blocked on separate standalone infrastructure
- [project_1910_r3_r4_boxed_wrapper_slots.md](project_1910_r3_r4_boxed_wrapper_slots.md) — project 1910 r3 r4 boxed wrapper slots
- [project_2026_dynnew_spread_newtarget.md](project_2026_dynnew_spread_newtarget.md) — project 2026 dynnew spread newtarget
- [project_2026_pr1_and_28_already_landed.md](project_2026_pr1_and_28_already_landed.md) — project 2026 pr1 and 28 already landed
- [project_2101a_externref_subclass_ownfield.md](project_2101a_externref_subclass_ownfield.md) — project 2101a externref subclass ownfield
- [project_2151_any_receiver_dispatch_slices.md](project_2151_any_receiver_dispatch_slices.md) — project 2151 any receiver dispatch slices
- [project_2186_vec_base_supertype.md](project_2186_vec_base_supertype.md) — #2186 added $__vec_base supertype so boxed arrays expose .length via __extern_length; indexing through externref still TODO
- [project_2203_already_landed_duplicate.md](project_2203_already_landed_duplicate.md) — project 2203 already landed duplicate
- [project_2358_pr3_to_primitive_nonobject_arm.md](project_2358_pr3_to_primitive_nonobject_arm.md) — #2358/#1917/#10 PR-3 handoff — __to_primitive non-$Object arm (class instances + $Vec arrays) — design, root cause, late-funcidx discipline
- [project_2358_toprimitive_nominal_struct_path.md](project_2358_toprimitive_nominal_struct_path.md) — #2358 standalone __to_primitive nominal-struct gap — true root cause, repro re-measure, and the tractable emitAnyAdd-static-reduce fix
- [project_2552_annexb_phase2_narrowed.md](project_2552_annexb_phase2_narrowed.md) — project 2552 annexb phase2 narrowed
- [project_2554_ir_tail_call_drop.md](project_2554_ir_tail_call_drop.md) — project 2554 ir tail call drop
- [project_fork_origin_behind_upstream_pr_base.md](project_fork_origin_behind_upstream_pr_base.md) — js2 fork origin/main lags upstream/main by ~1000+ commits; triage issues against upstream, not origin/main or local frontmatter
- [project_s64_value_rep_substrate_next.md](project_s64_value_rep_substrate_next.md) — s64 dev pool drained; next critical-path = standalone $Object dynamic string-value read bug (senior-dev/value-rep)
- [project_sprint64_parallel_session_dup_prs.md](project_sprint64_parallel_session_dup_prs.md) — Sprint 64 had a second agent team in a parallel session sharing the ttraenkler fork — caused duplicate PRs and shared branches; check open PRs before committing
- [project_standalone_any_string_value_read_substrate.md](project_standalone_any_string_value_read_substrate.md) — Standalone $Object dynamic (any-typed) reader drops native-string VALUES — unified root cause behind many s64 standalone gaps; senior-dev/value-rep
- [project_toprimitive_nominal_struct_gap.md](project_toprimitive_nominal_struct_gap.md) — Standalone ToPrimitive
- [project_wasm_linking_core_over_component.md](project_wasm_linking_core_over_component.md) — Modularizing js2wasm host-API shims / shared runtime — use core-wasm linking (#2527), not the Component Model (#2525); GC cross-module identity is already there via runtime canonicalization
- [reference_1461_reduce_noinit_funcidx_desync.md](reference_1461_reduce_noinit_funcidx_desync.md) — #54/#1461 standalone reduce.call(o,cb) no-init invalid-Wasm root cause: number_toString native-func registration shifts indices after the forward hole-scan baked its __extern_has_idx call; flushLateImportShifts doesn't cover native-func regs
- [reference_1472_dynshape_verified_rootcauses_jun19.md](reference_1472_dynshape_verified_rootcauses_jun19.md) — reference 1472 dynshape verified rootcauses jun19
- [reference_1629b_boxed_primitive_typeof_eq_layers.md](reference_1629b_boxed_primitive_typeof_eq_layers.md) — reference 1629b boxed primitive typeof eq layers
- [reference_2190a_string_subarray_readback_extern_get_idx.md](reference_2190a_string_subarray_readback_extern_get_idx.md) — reference 2190a string subarray readback extern get idx
- [reference_2190c_heterogeneous_tuple_write_layer_drop.md](reference_2190c_heterogeneous_tuple_write_layer_drop.md) — reference 2190c heterogeneous tuple write layer drop
- [reference_2191_ir_string_eq_residual.md](reference_2191_ir_string_eq_residual.md) — #2191 ROOT CAUSE (confirmed): NOT the IR string.eq/flatten — it was a late-import funcIdx-shift in #40's ascii→uni case-convert REPOINT; the === call site resolved to the un-patched ascii toUpperCase body. Fixed by name-based repoint (commit 7ae5c5df4).
- [reference_2193_call_ref_funcref_not_wrapper.md](reference_2193_call_ref_funcref_not_wrapper.md) — #2193 PR-B call_ref `expected (ref funcType) found (ref wrapStruct)` was a missing struct.get-field-0 funcref extraction, NOT a type-renumber off-by-one
- [reference_2372_dynamic_descriptor_struct_widening.md](reference_2372_dynamic_descriptor_struct_widening.md) — reference 2372 dynamic descriptor struct widening
- [reference_2375_typedarray_valueread_postsubstrate_verdict.md](reference_2375_typedarray_valueread_postsubstrate_verdict.md) — reference 2375 typedarray valueread postsubstrate verdict
- [reference_2042_s4_callsite_vs_2515_redefine_throw.md](reference_2042_s4_callsite_vs_2515_redefine_throw.md) — #2042 S4 = TWO disjoint redefine paths (native $Object runtime / typed-struct call-site); #2515 fixed the call-site -1-global emit but left a bare-string throw → S4 call-site net contribution is bare-string→TypeError-instance via emitThrowTypeError body-swap
- [reference_2379_new_array_n_arraymethod_invalid_cast.md](reference_2379_new_array_n_arraymethod_invalid_cast.md) — reference 2379 new array n arraymethod invalid cast
- [reference_2379_new_array_n_boxed_any_elem_rep.md](reference_2379_new_array_n_boxed_any_elem_rep.md) — #2379: standalone `new Array(N)` builds a boxed-any element array (type 1) while `[a,b,c]` builds a typed numeric element array (type 3) — sort/join stringify then ref.casts a boxed-any element to $AnyString = invalid Wasm; representation-scale, NOT a cast-site guard
- [reference_2524_node_io_shim_memory_ownership.md](reference_2524_node_io_shim_memory_ownership.md) — reference 2524 node io shim memory ownership
- [reference_2583_any_strict_eq_tag5_host_only.md](reference_2583_any_strict_eq_tag5_host_only.md) — #2583: standalone __any_strict_eq/__any_eq tag-5 string compare was host-only (wasm:js-string equals → const 0); native __str_flatten+__str_equals fallback. Plus any.indexOf routing intercept by the guarded-string else-arm. Touches same tag-5 field-4 arm as parked #2585.
- [reference_2040_tag5_field4_three_way_classifier.md](reference_2040_tag5_field4_three_way_classifier.md) — #2040/#2585: tag-5 field-4 overloaded (string/$BoxedNumber/object); fix = 3-way classifier INSIDE the both-tags-5 arm of __any_eq/__any_strict_eq, numeric branch gated on nativeBoxNumberTypeIdx>=0 ONLY (not nativeStrings). NOT the rejected cross-tag-arm broadening. Stacks on #1883.
- [reference_baseline_gates_need_postmerge_autorefresh.md](reference_baseline_gates_need_postmerge_autorefresh.md) — Every prescriptive baseline gate must self-refresh post-merge in promote-baseline or it wedges all PRs via drift
- [reference_fork_origin_behind_upstream.md](reference_fork_origin_behind_upstream.md) — The fork origin/main is ~1185+ commits behind upstream/main — branch dev work from upstream/main, not origin/main, or PRs land DIRTY
- [reference_gh_remove_label_rest_not_pr_edit.md](reference_gh_remove_label_rest_not_pr_edit.md) — gh pr edit --remove-label/--add-label silently no-ops (projectCards deprecation aborts the mutation); use the REST API to change PR/issue labels
- [reference_no_rebuild_helper_body_at_finalize.md](reference_no_rebuild_helper_body_at_finalize.md) — Never REBUILD a native-helper body at finalize that bakes funcIdxs — it breaks the late-import shift invariant; splice instead
- [reference_shared_instr_object_dce_double_remap.md](reference_shared_instr_object_dce_double_remap.md) — Never alias one Instr[]/instruction OBJECT into two reachable positions (if then+else, etc.) — DCE's in-place remapTypeIdxInBody walks it twice and double-applies a chained type-idx remap (e.g. 46→40→34) → invalid struct index. Build a fresh arm per branch.
- [reference_skipped_needs_if_pattern.md](reference_skipped_needs_if_pattern.md) — GitHub Actions — let a downstream job run when an event-gated needs: dependency is skipped
- [reference_standalone_any_string_value_read_substrate.md](reference_standalone_any_string_value_read_substrate.md) — Standalone $Object dynamic (any-typed) property read drops native-string values — the single root cause behind a whole cluster of standalone residuals
- [reference_standalone_harvest_rootcausemap_mislabeled.md](reference_standalone_harvest_rootcausemap_mislabeled.md) — Standalone test262 harvest — root_cause_map buckets + their issue links are unreliable; bucket from the standalone-current.jsonl signatures instead
- [reference_string_global_sentinel_guard.md](reference_string_global_sentinel_guard.md) — Standalone -1 string-global sentinel — guard global.get sites with stringConstantExternrefInstrs, not just !== undefined
- [reference_subissue_filename_dupid_gate.md](reference_subissue_filename_dupid_gate.md) — Sub-issue files under a parent
- [reference_subview_type_idx_stability.md](reference_subview_type_idx_stability.md) — New WasmGC struct types whose idx must survive hoist-vs-body passes must be reserved in the up-front type-init phase, not registered on-demand
- [reference_vec_externref_key_not_uniform.md](reference_vec_externref_key_not_uniform.md) — ctx.vecTypeMap \"externref\"-keyed carriers are not uniformly (array externref) — some have a ref/ref_null element override

