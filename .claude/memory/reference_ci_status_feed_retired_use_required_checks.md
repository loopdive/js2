---
name: reference_ci_status_feed_retired_use_required_checks
description: "CLAUDE.md's dev-self-merge protocol tells devs to read .claude/ci-status/pr-<N>.json — that feed is LONG RETIRED (newest file on main is pr-99 era). The operative gate is required-checks-green + the merge_group re-run. Fix CLAUDE.md."
metadata:
  node_type: memory
  type: reference
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
  modified: 2026-07-23T14:21:05.522Z
---

**Found 2026-07-23 by a dev agent, confirmed across several PRs.**

CLAUDE.md's dev-self-merge criteria say to wait until `.claude/ci-status/pr-<N>.json` "has matching
SHA, `net_per_test > 0`, ratio <10%, no bucket >50". **That feed no longer exists** — the newest
file on `main` dates to the pr-99 era. Agents on #3505/#3511 both went looking for it, found
nothing, and correctly fell back.

**What is actually operative today:**
- **PR level:** required checks green — `cheap gate (main-ancestor + lint)`, `quality`,
  `merge shard reports` — plus `mergeStateStatus == CLEAN`, not draft, no `hold` label.
- **PR-level test262 shards are SKIPPED BY DESIGN** (`SHARDS_RAN: false`, "no merged test262
  report to diff") under the #3467/#3468 per-SHA-cache flow. A green "check for test262
  regressions" at PR level is therefore a **designed no-op**, NOT evidence. Do not read it as
  conformance validation.
- **The real regression/trap gate is the `merge_group` re-run** on the merged state — which is
  why `auto-park` exists. See [[project_standalone_floor_only_on_merge_group]].

**Actions:** (1) update CLAUDE.md's self-merge section to drop the dead feed and state the
required-checks + merge_group reality; (2) when instructing devs, tell them to gate on
required-checks-green, never on the ci-status JSON. Also note several guard-test files
(`tests/issue-3471.test.ts`, `tests/call-arg-type-coercion.test.ts`) sit OUTSIDE any required
check — a regression landed through that hole on 2026-07-23 (from #3503) and stayed green in CI.

See [[reference_baseline_promote_trap_gate_two_failure_modes]].
