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
- [feedback_idle_notification_silence.md](feedback_idle_notification_silence.md) — Don't respond to idle notifications unless CI landed or work to assign; silence breaks the ping loop
- [feedback_no_ci_wait.md](feedback_no_ci_wait.md) — Dev agents open PR then immediately move on; CI monitoring = tech lead's job via auto-merge monitor
- [feedback_no_keep_pane.md](feedback_no_keep_pane.md) — Never tell agents "do NOT kill your pane" — always terminate after PR; wait for a slot to open instead
- [feedback_agent_self_termination.md](feedback_agent_self_termination.md) — Architects idle after finishing instead of self-terminating; added Termination section to architect.md; always include kill-pane in spawn prompts

### Dispatch
- [feedback_dispatch_status.md](feedback_dispatch_status.md) — Update issue status to in-progress when dispatching an agent
- [feedback_dedicated_pr_shepherd.md](feedback_dedicated_pr_shepherd.md) — Always staff a dedicated PR-queue shepherd as a standing team role; don't hand-shepherd the merge queue ad-hoc (it strands/wedges when the lead is busy)
- [feedback_auto_ff_workspace_main.md](feedback_auto_ff_workspace_main.md) — Auto-ff /workspace main to origin/main whenever origin is ahead (Stop+SessionStart hook in .claude/settings.json); stale /workspace gave a wrong 14/67 sprint count

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
